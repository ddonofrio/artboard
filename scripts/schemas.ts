import { mkdir, writeFile } from 'node:fs/promises';
import { sceneSchema, toolSchemas } from '../src/core/index.js';

await mkdir('schemas', { recursive: true });
await writeFile('schemas/scene.schema.json', JSON.stringify(sceneSchema, null, 2) + '\n');
await writeFile('schemas/tools.schema.json', JSON.stringify(toolSchemas, null, 2) + '\n');
