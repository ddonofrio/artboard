import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PixelRenderer, validateScene, type Scene } from '../../core/index.js';
import { encodeJPEG } from './encoding.js';

export interface BatchOutput { id: string; index: number }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateBatchOutput(value: unknown): asserts value is BatchOutput {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !uuid.test(value.id) || !('index' in value) || !Number.isSafeInteger(value.index) || Number(value.index) < 1) throw new Error('Batch output requires a UUID and a positive line index.');
}
export function drawingDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('');
}
export function drawingName(prompt: string): string {
  const cleaned = Array.from(prompt.trim()).map(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character).join('');
  let name = '';
  for (const character of cleaned) { if (Buffer.byteLength(name + character, 'utf8') > 180) break; name += character; }
  name = name.replace(/[. ]+$/, '') || 'drawing';
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}
function journalJSON(value: unknown): string {
  return JSON.stringify(value, (key, item) => /^(api_key|authorization|password)$/i.test(key) ? '[redacted]' : typeof item === 'string' && item.startsWith('data:image/') ? '[image bytes omitted]' : item);
}
async function exclusive(path: string, bytes: string | Buffer): Promise<void> {
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** Aventure's dated drawings, numbered batches and append-only journal under one outputs root. */
export class OutputStore {
  readonly root: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(directory = 'outputs', private renderer = new PixelRenderer()) { this.root = resolve(directory); }
  runFolder(id: string): string {
    if (!uuid.test(id)) throw new Error('A run UUID is required.');
    return resolve(this.root, 'workflow', id);
  }
  record(id: string, event: object): Promise<void> {
    this.runFolder(id);
    const line = journalJSON({ timestamp: new Date().toISOString(), run_id: id, ...event }) + '\n';
    const next = this.pending.then(async () => {
      const folder = resolve(this.root, 'logs'); await mkdir(folder, { recursive: true });
      await appendFile(resolve(folder, 'agent.jsonl'), line, 'utf8');
    });
    this.pending = next.catch(() => {});
    return next;
  }
  async flush(): Promise<void> { await this.pending; }
  async snapshot(id: string, name: string, scene: Scene): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(name)) throw new Error('Use a plain snapshot name.');
    validateScene(scene);
    const folder = this.runFolder(id); await mkdir(folder, { recursive: true });
    await exclusive(resolve(folder, `${name}.json`), JSON.stringify(scene, null, 2) + '\n');
    await exclusive(resolve(folder, `${name}.jpg`), encodeJPEG(this.renderer.render(scene)));
  }
  async metadata(id: string, value: unknown): Promise<void> {
    const folder = this.runFolder(id); await mkdir(folder, { recursive: true });
    await writeFile(resolve(folder, 'workflow.json'), journalJSON(value) + '\n');
  }
  async drawing(scene: Scene, prompt: string, batch?: BatchOutput, now = new Date()): Promise<string> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('A prompt of 1 to 4000 characters is required.');
    validateScene(scene);
    const bytes = encodeJPEG(this.renderer.render(scene));
    if (batch) {
      validateBatchOutput(batch);
      const folder = resolve(this.root, 'batch', batch.id); await mkdir(folder, { recursive: true });
      const path = resolve(folder, `${String(batch.index).padStart(3, '0')}.jpg`);
      // Batch line indices are fixed; duplicates must fail instead of replacing a drawing.
      await writeFile(path, bytes, { flag: 'wx' }); return path;
    }
    const folder = resolve(this.root, drawingDate(now)); await mkdir(folder, { recursive: true });
    const name = drawingName(prompt);
    for (let suffix = 0; ; suffix++) {
      const path = resolve(folder, `${name}${suffix ? `(${suffix})` : ''}.jpg`);
      try { await writeFile(path, bytes, { flag: 'wx' }); return path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
}
