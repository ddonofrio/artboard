import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SceneStore, PixelRenderer, SceneTools } from '../src/core/index.js';
import { NodeAdapter } from '../src/adapters/node/index.js';
import { runDrawingScript, type DrawingScript } from './drawing-script-host.js';

const [filename, directory = 'outputs/scripts', ...args] = process.argv.slice(2);
try {
  if (!filename) throw new Error('Usage: npm run draw-script -- <drawing.mjs> [output-directory] [script arguments...]. The file must export default async function (tools, args).');
  const module = await import(pathToFileURL(resolve(filename)).href) as { default?: DrawingScript };
  if (typeof module.default !== 'function') throw new Error(`${filename}: export default async function (tools, args) to run a drawing script.`);
  const host = new SceneTools(new SceneStore(), new PixelRenderer(), new NodeAdapter(directory));
  let calls = 0;
  const result = await runDrawingScript(module.default, host, args, () => { calls++; });
  process.stdout.write(JSON.stringify({ ok: true, calls, result: result ?? null }) + '\n');
} catch (error) {
  process.stderr.write(`draw-script: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
