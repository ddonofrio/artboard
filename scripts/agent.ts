import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runWorkflow } from '../src/workflows/run';
import { loadWorkflowConfig } from '../src/adapters/server/config';
import { runPersistence } from '../src/adapters/server/persistence';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { encodeVisionJPEG, NodeAdapter, OutputStore } from '../src/adapters/node/index.js';

if (existsSync('.env.local')) loadEnvFile('.env.local');
else if (existsSync('.env')) loadEnvFile('.env');

interface Options { layers: number; model?: string; imageDivisor?: number; reasoningEffort?: 'none' | 'low' | 'medium' | 'high'; prompt: string }
function parseArguments(values: string[]): Options {
  let layers = Number(process.env.AGENT_LAYERS || 1), model: string | undefined, imageDivisor: number | undefined;
  let reasoningEffort: Options['reasoningEffort'];
  const prompt: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === '--help' || option === '-h') {
      console.log('Usage: npm run agent -- [--layers 1-7] [--model ID] [--image-divisor 1-64] [--reasoning-effort none|low|medium|high] <prompt>');
      process.exit(0);
    }
    if (!['--layers', '--model', '--image-divisor', '--reasoning-effort'].includes(option)) { prompt.push(option); continue; }
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    if (option === '--layers') layers = Number(value);
    else if (option === '--model') model = value.trim();
    else if (option === '--image-divisor') imageDivisor = Number(value);
    else reasoningEffort = value as Options['reasoningEffort'];
  }
  if (!Number.isInteger(layers) || layers < 1 || layers > 7) throw new Error('--layers must be an integer from 1 to 7.');
  if (model !== undefined && (!model || model.length > 256)) throw new Error('--model must be a model ID of 1 to 256 characters.');
  if (imageDivisor !== undefined && (!Number.isInteger(imageDivisor) || imageDivisor < 1 || imageDivisor > 64)) throw new Error('--image-divisor must be an integer from 1 to 64.');
  if (reasoningEffort !== undefined && !['none', 'low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('--reasoning-effort must be none, low, medium or high.');
  const request = prompt.join(' ').trim();
  if (!request || request.length > 4000) throw new Error('Provide a prompt of 1 to 4000 characters.');
  return { layers, model, imageDivisor, reasoningEffort, prompt: request };
}

let options: Options;
try { options = parseArguments(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
const { layers, prompt } = options;
class AgentAdapter extends NodeAdapter {
  constructor(directory: string, private divisor: number) { super(directory); }
  async preview(image: PixelImage): Promise<string> { return `data:image/jpeg;base64,${encodeVisionJPEG(image, this.divisor).toString('base64')}`; }
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
  if (options.model || options.imageDivisor || options.reasoningEffort) {
    config.connection = {
      ...config.connection,
      ...(options.model ? { editor_model: options.model, reviewer_model: options.model } : {}),
      ...(options.imageDivisor ? { vision_image_divisor: options.imageDivisor } : {}),
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };
    if (options.model) config.agents = Object.fromEntries(Object.entries(config.agents ?? {}).map(([role, profile]) => [role, { ...profile, model: options.model }])) as typeof config.agents;
  }
  const workflow = await runWorkflow({ layers, createTools: () => new SceneTools(new SceneStore(), renderer, new AgentAdapter(directory, config.connection!.vision_image_divisor!)), prompt, config, signal: controller.signal, initial_scene: process.env.AGENT_SCENE ? JSON.parse(await readFile(process.env.AGENT_SCENE, 'utf8')) : undefined, async onEvent(item) {
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
  console.log(result.approved ? `Approved final: ${path}` : result.stop_reason === 'unreviewed' ? `Completed without review: ${path}` : `Final after ${result.reviews.length} reviews: ${path}`);
} catch (error) {
  try {
    await persistence.flush();
    await outputs.record(id, { type: controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) });
  } catch (saveError) { console.error(`Output persistence failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`); }
  console.error(error instanceof Error ? error.message : 'Agent run failed'); process.exitCode = 1;
}
