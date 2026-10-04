import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_AGENT_CONFIG, runAgentLoop } from '../src/agents/index';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { encodeJPEG, NodeAdapter } from '../src/adapters/node/index.js';

if (existsSync('.env.local')) loadEnvFile('.env.local');
else if (existsSync('.env')) loadEnvFile('.env');

const prompt = process.argv.slice(2).join(' ') || 'Draw a cave entrance with a rusty gate, a curved path, and vegetation at sunset.';
const directory = 'outputs/agent';
class AgentAdapter extends NodeAdapter {
  async preview(image: PixelImage): Promise<string> { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const tools = new SceneTools(new SceneStore(), new PixelRenderer(), new AgentAdapter(directory));
const config = { ...DEFAULT_AGENT_CONFIG, base_url: process.env.AGENT_BASE_URL || DEFAULT_AGENT_CONFIG.base_url, editor_model: process.env.AGENT_EDITOR_MODEL || DEFAULT_AGENT_CONFIG.editor_model, reviewer_model: process.env.AGENT_REVIEWER_MODEL || '', api_key: process.env.AGENT_API_KEY, vision: process.env.AGENT_VISION !== 'false', max_reviews: Number(process.env.AGENT_MAX_REVIEWS || DEFAULT_AGENT_CONFIG.max_reviews) };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const result = await runAgentLoop({ tools, prompt, config, signal: controller.signal, initial_scene: process.env.AGENT_SCENE ? JSON.parse(await readFile(process.env.AGENT_SCENE, 'utf8')) : undefined, onEvent(event) {
    if (event.type === 'phase') console.log(`${event.role} ${event.round} (review limit ${config.max_reviews})`);
    if (event.type === 'tool') console.log(`  ${event.name}: ${event.ok ? 'ok' : event.message}`);
    if (event.type === 'review') console.log(`  review r${event.review.revision}: ${event.review.approved ? 'approved' : event.review.issues.map(issue => issue.instruction).join('; ')}`);
  } });
  await mkdir(directory, { recursive: true });
  const adapter = new NodeAdapter(directory);
  for (const [i, draft] of result.drafts.entries()) {
    await adapter.saveJSON(draft.scene, `draft-${i+1}.json`);
    await adapter.exportPNG(tools.renderer.render(draft.scene), `draft-${i+1}.png`);
  }
  await adapter.saveJSON(result.draft.scene, 'final.json');
  await adapter.exportPNG(tools.renderer.render(result.draft.scene), 'final.png');
  await writeFile(`${directory}/review.json`, JSON.stringify({ approved: result.approved, stop_reason: result.stop_reason, error: result.error, models: result.models, reviews: result.reviews }, null, 2) + '\n');
  if (result.error) console.error(`Latest drawing saved: ${result.error}`);
  console.log(result.approved ? `Approved final: ${directory}/final.png` : `Final after ${result.reviews.length} reviews: ${directory}/final.png`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Agent run failed'); process.exitCode = 1; }
