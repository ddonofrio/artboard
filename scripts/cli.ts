import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { PixelRenderer, SceneStore, SceneTools, type ToolRequest } from '../src/core/index';
import { NodeAdapter } from '../src/adapters/node/index.js';

const tools = new SceneTools(new SceneStore(), new PixelRenderer(), new NodeAdapter(process.argv[2] ?? 'outputs'));
for await (const line of createInterface({ input: stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  try { stdout.write(JSON.stringify(await tools.dispatch(JSON.parse(line) as ToolRequest)) + '\n'); }
  catch (error) { stdout.write(JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: error instanceof Error ? error.message : 'Invalid JSON' } }) + '\n'); }
}
