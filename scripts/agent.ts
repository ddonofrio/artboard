import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runWorkflow } from '../src/workflows/run';
import { loadWorkflowConfig } from '../src/adapters/server/config';
import { runPersistence } from '../src/adapters/server/persistence';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { encodeJPEG, NodeAdapter, OutputStore } from '../src/adapters/node/index.js';

if (existsSync('.env.local')) loadEnvFile('.env.local');
else if (existsSync('.env')) loadEnvFile('.env');

const args = process.argv.slice(2);
const layerFlag = args.indexOf('--layers');
const layers = Number(layerFlag >= 0 ? args.splice(layerFlag, 2)[1] : process.env.AGENT_LAYERS || 1);
const prompt = args.join(' ') || 'Draw a cave entrance with a rusty gate, a curved path, and vegetation at sunset.';
class AgentAdapter extends NodeAdapter {
  async preview(image: PixelImage): Promise<string> { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const renderer = new PixelRenderer();
const outputs = new OutputStore(process.env.AGENT_OUTPUT_DIR || 'outputs', renderer);
const id = randomUUID(), directory = outputs.runFolder(id);
const persistence = runPersistence(outputs, id, message => console.error(`Output persistence failed: ${message}`));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  await outputs.record(id, { type: 'start', request: { prompt, layers } });
  const config = await loadWorkflowConfig(process.cwd());
  const workflow = await runWorkflow({ layers, createTools: () => new SceneTools(new SceneStore(), renderer, new AgentAdapter(directory)), prompt, config, signal: controller.signal, initial_scene: process.env.AGENT_SCENE ? JSON.parse(await readFile(process.env.AGENT_SCENE, 'utf8')) : undefined, async onEvent(item) {
    await persistence.capture(item);
    if (item.type === 'stage') { console.log(`Stage ${item.index}/${item.total}: ${item.stage.name}`); return; }
    const event = item.event;
    if (event.type === 'phase') console.log(`${event.role} ${event.round} (review limit ${config.connection!.max_reviews})`);
    if (event.type === 'tool') console.log(`  ${event.name}: ${event.ok ? 'ok' : event.message}`);
    if (event.type === 'review') console.log(`  review r${event.review.revision}: ${event.review.approved ? 'approved' : event.review.issues.map(issue => issue.instruction).join('; ')}`);
  } });
  const result = workflow.result;
  await persistence.finish(workflow);
  const path = await outputs.drawing(result.draft.scene, prompt);
  await writeFile(resolve(directory, 'review.json'), JSON.stringify({ approved: result.approved, stop_reason: result.stop_reason, error: result.error, models: result.models, reviews: result.reviews }, null, 2) + '\n');
  await outputs.record(id, { type: 'saved', output_path: path, approved: result.approved, stop_reason: result.stop_reason });
  if (result.error) console.error(`Latest drawing saved: ${result.error}`);
  console.log(result.approved ? `Approved final: ${path}` : `Final after ${result.reviews.length} reviews: ${path}`);
} catch (error) {
  try {
    await persistence.flush();
    await outputs.record(id, { type: controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) });
  } catch (saveError) { console.error(`Output persistence failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`); }
  console.error(error instanceof Error ? error.message : 'Agent run failed'); process.exitCode = 1;
}
