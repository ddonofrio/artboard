import { mkdir, writeFile } from 'node:fs/promises';
import { PixelRenderer, requireResult, SceneStore, SceneTools, type ToolRequest } from '../src/core/index';
import { NodeAdapter } from '../src/adapters/node/index.js';

const tools = new SceneTools(new SceneStore(), new PixelRenderer(), new NodeAdapter('outputs/workflow'));
const requests: ToolRequest[] = [
  { tool: 'scene_catalog', arguments: { category: 'recipes', id: 'cave_entrance' } },
  { tool: 'scene_create', arguments: { scene_id: 'demo', seed: 42, recipe: 'cave_entrance' } },
  { tool: 'scene_render', arguments: { scene_id: 'demo' } },
  { tool: 'scene_inspect', arguments: { scene_id: 'demo', ids: ['entrance_gate'] } },
  { tool: 'scene_apply', arguments: { scene_id: 'demo', expected_revision: 0, operations: [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: 4, highlight_color: 15 } } }] } },
  { tool: 'scene_render', arguments: { scene_id: 'demo', crop: [250, 145, 140, 225], scale: 2 } },
  { tool: 'scene_history', arguments: { scene_id: 'demo', action: 'undo' } },
  { tool: 'scene_render', arguments: { scene_id: 'demo' } },
  { tool: 'scene_history', arguments: { scene_id: 'demo', action: 'redo' } },
  { tool: 'scene_io', arguments: { scene_id: 'demo', action: 'save', filename: 'accepted.json' } },
  { tool: 'scene_io', arguments: { scene_id: 'demo', action: 'export', filename: 'accepted.png' } },
];
const responses = [];
for (const request of requests) { const response = await tools.dispatch(request); requireResult(response); responses.push({ request, response }); console.log(`${request.tool}: ok`); }
await mkdir('examples', { recursive: true });
await writeFile('examples/workflow.jsonl', requests.map(request => JSON.stringify(request)).join('\n') + '\n');
await writeFile('outputs/workflow/transcript.json', JSON.stringify(responses, null, 2) + '\n');
