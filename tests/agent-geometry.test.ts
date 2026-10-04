import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentTools } from '../src/agents/tools';
import { normalizeGeometry } from '../src/agents/geometry';
import { PixelRenderer, SceneStore, SceneTools, type ToolResult } from '../src/core/index';

function setup() {
  const host = new SceneTools(new SceneStore(), new PixelRenderer(), {
    preview: async () => 'memory', exportPNG: async () => 'memory', saveJSON: async () => 'memory', loadJSON: async () => undefined,
  });
  host.store.create({ scene_id: 'drawing' });
  const tools = agentTools(host, 'drawing', 'editor', undefined, () => {}, () => {}, () => {});
  const apply = async (operations: unknown[]) => await tools.scene_apply.execute!({ scene_id: 'drawing', operations }, { toolCallId: 'call', messages: [] }) as ToolResult;
  return { host, apply };
}

const ellipses = [
  { kind: 'ellipse', points: [[30,40],[10,20]] },
  { kind: 'ellipse', points: [[10,20],[30,20],[30,40],[10,40]] },
  { kind: 'ellipse', points: [10,20,20,20] },
  { kind: 'circle', center: [20,30], radius: 10 },
  { kind: 'circle', cx: 20, cy: 30, r: 10 },
  { kind: 'ellipse', center: [20,30], rx: 10, ry: 10 },
  { kind: 'ellipse', rect: [10,20,20,20] },
  { kind: 'ellipse', xy: [10,20,29,39] },
  { kind: 'ellipse', bbox: [10,20,30,40] },
];
for (const geometry of ellipses) test(`natural ellipse geometry: ${JSON.stringify(geometry)}`, async () => {
  const { host, apply } = setup();
  const input = { op: 'add', object: { id: 'sun', fill: 14, ...geometry } };
  const original = structuredClone(input);
  assert.equal((await apply([input])).ok, true);
  const object = host.store.get('drawing').objects[0];
  assert.equal(object.kind, 'ellipse');
  if (object.kind === 'ellipse') assert.deepEqual(object.bounds, [10,20,20,20]);
  assert.equal(object.color, 14); assert.equal(object.layer, 0);
  assert.equal('points' in object, false);
  assert.deepEqual(input, original, 'Normalization preserves the original model arguments');
  const image = new PixelRenderer().render(host.store.get('drawing')), offset = (30 * image.width + 20) * 4;
  assert.deepEqual([...image.data.slice(offset, offset + 3)], [200,217,182]);
});

test('rectangles, Pillow corner boxes and ordinary polygons coexist in one atomic batch', async () => {
  const { host, apply } = setup();
  const result = await apply([
    { op: 'add', object: { id: 'rect', kind: 'rect', rect: [1,2,8,6], color: 1 } },
    { op: 'add', object: { id: 'rectangle', kind: 'rectangle', x: 1, y: 2, width: 8, height: 6, fill: 2 } },
    { op: 'add', object: { id: 'pillow', kind: 'rectangle', xy: [[1,2],[8,7]], fill: 3 } },
    { op: 'add', object: { id: 'polygon', kind: 'polygon', layer: 2, points: [[1,2],[9,2],[9,8],[1,8]], color: 4 } },
    { op: 'add', object: { id: 'line', kind: 'line', start: [0,0], end: [30,30], width: 2, fill: 5 } },
  ]);
  assert.equal(result.ok, true);
  const scene = host.store.get('drawing'); assert.equal(scene.revision, 1);
  for (const object of scene.objects.slice(0,4)) {
    assert.equal(object.kind, 'polygon');
    if (object.kind === 'polygon') assert.deepEqual(object.points, [[1,2],[9,2],[9,8],[1,8]]);
  }
  assert.equal(scene.objects[4].stroke_width, 2);
  await host.scene_history({ scene_id: 'drawing', action: 'undo' });
  assert.equal(host.store.get('drawing').objects.length, 0, 'All figures share one undo entry');
});

test('canonical bounds win, and updates use the latest object geometry within the batch', async () => {
  const { host, apply } = setup();
  assert.equal((await apply([
    { op: 'add', object: { id: 'sun', kind: 'ellipse', bounds: [10,20,20,20], points: [[0,0],[100,100]], color: 1 } },
    { op: 'update', id: 'sun', changes: { center: [50,60], radius: 5 } },
    { op: 'update', id: 'sun', changes: { radius: 10 } },
  ])).ok, true);
  const object = host.store.get('drawing').objects[0];
  if (object.kind === 'ellipse') assert.deepEqual(object.bounds, [40,50,20,20]);
  assert.equal((await apply([{ op: 'update', id: 'sun', changes: { points: [[1,2],[5,8]] } }])).ok, true);
  const updated = host.store.get('drawing').objects[0];
  if (updated.kind === 'ellipse') assert.deepEqual(updated.bounds, [1,2,4,6]);
});

test('invalid geometry rejects the complete batch and explains tool usage', async () => {
  const { host, apply } = setup();
  const before = host.store.get('drawing');
  const result = await apply([
    { op: 'add', object: { id: 'valid', kind: 'circle', center: [20,20], radius: 5, fill: 1 } },
    { op: 'add', object: { id: 'invalid', kind: 'ellipse', points: [[10,10],[10,10]] } },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error.message, /scene_apply.*Usage:/); assert.match(result.error.message, /bounds/); }
  assert.deepEqual(host.store.get('drawing'), before);
  const normalized = normalizeGeometry({ scene_id: 'drawing', operations: [{ op: 'add', object: { kind: 'polygon', points: [[0,0],[5,0],[5,5]] } }] }, host);
  assert.deepEqual((normalized.operations as { object: { points: number[][] } }[])[0].object.points, [[0,0],[5,0],[5,5]]);
});

test('the core reports errors from the actual figure rather than an unrelated union alternative', async () => {
  const { host } = setup();
  const result = await host.scene_apply({ scene_id: 'drawing', operations: [{ op: 'add', object: { id: 'sun', kind: 'ellipse', layer: 0, points: [[0,0],[10,10]] } }] });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error.field!, /bounds/); assert.doesNotMatch(result.error.message, /fewer than 3/); }
});
