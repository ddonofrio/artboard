import type { PaintStyle } from '../contracts/service';

export interface RasterFrame { width: number; height: number; data: Uint8ClampedArray }
export interface PixelRun { y: number; x: number; length: number }
export interface AnimationClock { now(): number; request(callback: () => void): () => void }
export const FILL_SPEED_CSS_PIXELS = 96;
const browserClock: AnimationClock = {
  now: () => performance.now(),
  request: callback => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); },
};
function validate(frame: RasterFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.data.length !== frame.width * frame.height * 4) throw new Error('Invalid animation frame dimensions.');
}
/** Classical scanline spans, restricted to pixels that actually change. */
export function changedScanlines(before: RasterFrame, after: RasterFrame): PixelRun[] {
  validate(before); validate(after);
  if (before.width !== after.width || before.height !== after.height) throw new Error('Animation frames must have matching dimensions.');
  const runs: PixelRun[] = [];
  const changed = (pixel: number) => {
    const offset = pixel * 4;
    return before.data[offset] !== after.data[offset] || before.data[offset + 1] !== after.data[offset + 1]
      || before.data[offset + 2] !== after.data[offset + 2] || before.data[offset + 3] !== after.data[offset + 3];
  };
  for (let y = 0; y < after.height; y++) {
    let x = 0;
    while (x < after.width) {
      if (!changed(y * after.width + x)) { x++; continue; }
      const start = x++;
      while (x < after.width && changed(y * after.width + x)) x++;
      runs.push({ y, x: start, length: x - start });
    }
  }
  return runs;
}

/** Clockwise rays, each ordered from the ellipse center toward its edge. */
export function rayPixels(runs: PixelRun[], width: number, center: [number, number], radius: [number, number]): number[] {
  const count = Math.max(1, Math.ceil(2 * Math.PI * Math.max(...radius)));
  const points: { pixel: number; ray: number; distance: number }[] = [];
  for (const run of runs) for (let x = run.x; x < run.x + run.length; x++) {
    const dx = x + 0.5 - center[0], dy = run.y + 0.5 - center[1];
    const distance = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy / radius[1], dx / radius[0]) + 2 * Math.PI) % (2 * Math.PI);
    points.push({ pixel: run.y * width + x, ray: distance <= Math.SQRT1_2 ? -1 : Math.floor(angle / (2 * Math.PI) * count), distance });
  }
  return points.sort((a, b) => a.ray - b.ray || a.distance - b.distance).map(point => point.pixel);
}
interface PaintTask {
  target: RasterFrame; runs: PixelRun[]; rays?: number[]; duration: number;
  sequence: number; started?: number; cursor: number; speed: number;
}
/** Response queues paint concurrently; figures within each response paint one at a time. */
export class DrawingAnimation {
  private frame: RasterFrame;
  private logical: RasterFrame;
  private owners: Float64Array;
  private groups = new Map<string, PaintTask[]>();
  private sequence = 0;
  private cancel?: () => void;
  private generation = 0;
  constructor(initial: RasterFrame, private draw: (frame: RasterFrame) => void, private clock: AnimationClock = browserClock) {
    validate(initial); this.frame = structuredClone(initial); this.logical = structuredClone(initial);
    this.owners = new Float64Array(initial.width * initial.height);
  }
  animate(next: RasterFrame, cssPixelsPerPixel = 1, options: { group?: string; style?: PaintStyle } = {}): void {
    if (!Number.isFinite(cssPixelsPerPixel) || cssPixelsPerPixel <= 0) throw new Error('Canvas display scale must be positive.');
    const runs = changedScanlines(this.logical, next);
    if (!runs.length) return;
    const style = options.style;
    if (style?.kind === 'rays' && (!style.center.every(Number.isFinite) || !style.radius.every(value => Number.isFinite(value) && value > 0))) throw new Error('Invalid radial fill geometry.');
    this.logical = structuredClone(next);
    const speed = FILL_SPEED_CSS_PIXELS / cssPixelsPerPixel;
    const radius: [number, number] = style?.kind === 'rays' ? [style.radius[0] * next.width, style.radius[1] * next.height] : [0, 0];
    const task: PaintTask = {
      target: this.logical, runs, sequence: ++this.sequence, cursor: 0, speed,
      duration: style?.kind === 'rays' ? 2 * Math.max(...radius) / speed : (runs.at(-1)!.y - runs[0].y + 1) / speed,
      rays: style?.kind === 'rays' ? rayPixels(runs, next.width, [style.center[0] * next.width, style.center[1] * next.height], radius) : undefined,
    };
    const group = options.group ?? `paint-${task.sequence}`;
    const queue = this.groups.get(group) ?? [];
    if (!queue.length) task.started = this.clock.now();
    queue.push(task); this.groups.set(group, queue);
    this.schedule();
  }
  private paint(task: PaintTask, pixel: number): boolean {
    // Once a newer edit paints a pixel, an older concurrent fill cannot cover it again.
    if (this.owners[pixel] > task.sequence) return false;
    this.owners[pixel] = task.sequence;
    const offset = pixel * 4;
    this.frame.data.set(task.target.data.subarray(offset, offset + 4), offset);
    return true;
  }
  private schedule(): void {
    if (this.cancel || !this.groups.size) return;
    const generation = this.generation;
    this.cancel = this.clock.request(() => {
      if (generation !== this.generation) return;
      this.cancel = undefined;
      const now = this.clock.now();
      let changed = false;
      for (const [group, queue] of this.groups) {
        const task = queue[0], elapsed = Math.max(0, now - task.started!) / 1000;
        if (task.rays) {
          const limit = Math.min(task.rays.length, Math.floor(elapsed / task.duration * task.rays.length));
          while (task.cursor < limit) changed = this.paint(task, task.rays[task.cursor++]) || changed;
        } else {
          const frontier = task.runs[0].y + Math.floor(elapsed * task.speed);
          while (task.cursor < task.runs.length && task.runs[task.cursor].y < frontier) {
            const run = task.runs[task.cursor++];
            for (let x = run.x; x < run.x + run.length; x++) changed = this.paint(task, run.y * this.frame.width + x) || changed;
          }
        }
        if (task.cursor === (task.rays?.length ?? task.runs.length)) {
          queue.shift();
          if (queue.length) queue[0].started = now;
          else this.groups.delete(group);
        }
      }
      if (changed) this.draw(this.frame);
      this.schedule();
    });
  }
  /** Release presentation work when leaving the page, without painting queued figures at once. */
  dispose(): void { this.generation++; this.cancel?.(); this.cancel = undefined; this.groups.clear(); }
}
