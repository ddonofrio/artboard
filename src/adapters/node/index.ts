import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fail, type PixelImage, type Scene, type ToolAdapter } from '../../core/index.js';
import { encodePNG } from './encoding.js';

export { encodePNG, encodeJPEG } from './encoding.js';
export { OutputStore, drawingDate, drawingName, validateBatchOutput, type BatchOutput } from './outputs.js';
export class NodeAdapter implements ToolAdapter {
  private root: string;
  constructor(directory = 'outputs') { this.root = resolve(directory); }
  private path(name: string, extension: '.png' | '.json'): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name) || !name.endsWith(extension)) fail('INVALID_FILENAME', `Use a plain ${extension} filename`, 'filename');
    const path = resolve(this.root, name);
    if (!path.startsWith(this.root + sep)) fail('INVALID_FILENAME', 'File must remain inside output directory', 'filename');
    return path;
  }
  async preview(image: PixelImage, name: string) { return this.exportPNG(image, name); }
  async exportPNG(image: PixelImage, name: string): Promise<string> { const path = this.path(name, '.png'); await mkdir(this.root, { recursive: true }); await writeFile(path, encodePNG(image)); return path; }
  async saveJSON(scene: Scene, name: string): Promise<string> { const path = this.path(name, '.json'); await mkdir(this.root, { recursive: true }); await writeFile(path, JSON.stringify(scene, null, 2) + '\n', 'utf8'); return path; }
  async loadJSON(name: string): Promise<unknown> { return JSON.parse(await readFile(this.path(name, '.json'), 'utf8')); }
}
