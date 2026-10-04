import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedScanlines, DrawingAnimation, type RasterFrame, type AnimationClock } from '../src/ui/scanline-animation';

const frame = (width = 4, height = 192, color = 0): RasterFrame => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(color) });
function clock() {
  let time = 0;
  const pending: { callback: () => void; cancelled: boolean }[] = [];
  const scheduler: AnimationClock = {
    now: () => time,
    request: callback => { const item = { callback, cancelled: false }; pending.push(item); return () => { item.cancelled = true; }; },
  };
  const advance = (ms: number) => { time += ms; const callbacks = pending.splice(0); for (const item of callbacks) if (!item.cancelled) item.callback(); };
  return { scheduler, advance };
}
test('scanline spans respect holes, edges and unchanged pixels', () => {
  const before = frame(5, 3), after = frame(5, 3);
  for (const pixel of [0, 1, 3, 4, 6, 12]) after.data[pixel * 4] = 7;
  assert.deepEqual(changedScanlines(before, after), [
    { y: 0, x: 0, length: 2 }, { y: 0, x: 3, length: 2 }, { y: 1, x: 1, length: 1 }, { y: 2, x: 2, length: 1 },
  ]);
  assert.throws(() => changedScanlines(before, frame(6, 3)), /matching dimensions/);
});
test('solid fills and recolors advance at 96 CSS pixels per second', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  animation.animate(frame(4, 192, 9));
  assert.equal(draws.length, 0);
  timer.advance(1000);
  assert.ok(draws[0].data.subarray(0, 4 * 96 * 4).every(value => value === 9));
  assert.ok(draws[0].data.subarray(4 * 96 * 4).every(value => value === 0));
  timer.advance(1000); assert.deepEqual(draws.at(-1), frame(4, 192, 9));
  animation.animate(frame(4, 192, 5));
  timer.advance(1000); assert.equal(draws.at(-1)!.data[0], 5); assert.equal(draws.at(-1)!.data[4 * 100 * 4], 9);
});
test('display scale determines inches and duplicated previews do not restart the fill', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  const target = frame(4, 192, 8);
  animation.animate(target, 2);
  timer.advance(1000); assert.equal(draws.at(-1)!.data[4 * 47 * 4], 8); assert.equal(draws.at(-1)!.data[4 * 48 * 4], 0);
  animation.animate(target, 2);
  timer.advance(1000); assert.equal(draws.at(-1)!.data[4 * 95 * 4], 8); assert.equal(draws.at(-1)!.data[4 * 96 * 4], 0);
});
test('new responses paint in parallel without completing the preceding fill', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  const first = frame(), second = frame();
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 2; x++) first.data.fill(3, (y * 4 + x) * 4, (y * 4 + x + 1) * 4);
  }
  second.data.set(first.data);
  for (let y = 0; y < 192; y++) for (let x = 2; x < 4; x++) second.data.fill(7, (y * 4 + x) * 4, (y * 4 + x + 1) * 4);
  animation.animate(first); timer.advance(500);
  const count = draws.length; animation.animate(second); assert.equal(draws.length, count);
  timer.advance(500);
  assert.equal(draws.at(-1)!.data[4 * 4 * 60], 3);
  assert.equal(draws.at(-1)!.data[(4 * 60 + 2) * 4], 0);
  assert.equal(draws.at(-1)!.data[(4 * 20 + 2) * 4], 7);
  timer.advance(1500); assert.deepEqual(draws.at(-1), second);
});
test('nested figures in a single response are queued and delivery does not skip their animation', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  const outer = frame(4, 192, 3), inner = structuredClone(outer);
  for (let y = 48; y < 144; y++) inner.data.fill(7, (y * 4 + 1) * 4, (y * 4 + 3) * 4);
  animation.animate(outer, 1, { group: 'response-1' });
  animation.animate(inner, 1, { group: 'response-1' });
  animation.animate(inner); // Identical inspection/final delivery must preserve the queue.
  timer.advance(1000); assert.equal(draws.at(-1)!.data[(60 * 4 + 1) * 4], 3);
  timer.advance(1000); assert.deepEqual(draws.at(-1), outer);
  timer.advance(500); assert.equal(draws.at(-1)!.data[(60 * 4 + 1) * 4], 7); assert.equal(draws.at(-1)!.data[(120 * 4 + 1) * 4], 3);
  timer.advance(500); assert.deepEqual(draws.at(-1), inner);
});
test('older parallel or queued figures cannot overwrite pixels already painted by a newer response', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  animation.animate(frame(4, 192, 3), 1, { group: 'old' });
  animation.animate(frame(4, 192, 5), 1, { group: 'old' });
  timer.advance(500); animation.animate(frame(4, 192, 7), 1, { group: 'new' });
  timer.advance(1500); timer.advance(500); assert.deepEqual(draws.at(-1), frame(4, 192, 7));
  timer.advance(1500); assert.deepEqual(draws.at(-1), frame(4, 192, 7));
});
test('circle fills trace rays from the center and leave pixels outside the circle untouched', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const initial = frame(32, 32), target = structuredClone(initial);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (Math.hypot(x + 0.5 - 16, y + 0.5 - 16) <= 12) target.data.fill(9, (y * 32 + x) * 4, (y * 32 + x + 1) * 4);
  const animation = new DrawingAnimation(initial, result => draws.push(structuredClone(result)), timer.scheduler);
  animation.animate(target, 1, { style: { kind: 'rays', center: [0.5, 0.5], radius: [0.375, 0.375] } });
  timer.advance(40);
  const at = (x: number, y: number) => draws.at(-1)!.data[(y * 32 + x) * 4];
  assert.equal(at(16, 16), 9); assert.equal(at(27, 16), 9);
  assert.equal(at(4, 16), 0); assert.equal(at(16, 4), 0); assert.equal(at(0, 0), 0);
  timer.advance(210); assert.deepEqual(draws.at(-1), target);
});
test('leaving the page cancels scheduled frames without revealing queued figures', () => {
  const timer = clock(), draws: RasterFrame[] = [];
  const animation = new DrawingAnimation(frame(), result => draws.push(structuredClone(result)), timer.scheduler);
  animation.animate(frame(4, 192, 3)); timer.advance(100);
  const count = draws.length; animation.dispose(); timer.advance(10000); assert.equal(draws.length, count);
});
