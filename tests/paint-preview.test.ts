import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelRenderer, SceneStore, type Operation } from '../src/core/index';
import { paintPreviews } from '../src/adapters/server/paint-preview';

test('an atomic batch provides separate nested-square previews in operation order', () => {
  const store = new SceneStore();
  const before = store.create({ scene_id: 'drawing', width: 64, height: 48 });
  const operations: Operation[] = [
    { op: 'add', object: { id: 'outer', kind: 'polygon', points: [[0,0],[64,0],[64,48],[0,48]], color: 9, layer: 1 } },
    { op: 'add', object: { id: 'inner', kind: 'polygon', points: [[16,12],[48,12],[48,36],[16,36]], color: 7, layer: 2 } },
  ];
  store.apply('drawing', operations); const after = store.get('drawing');
  const frames = paintPreviews(before, after, operations), renderer = new PixelRenderer();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].scene.objects.map(object => object.id), ['outer']);
  assert.deepEqual(frames[1].scene, after);
  const index = (24 * 64 + 32) * 4;
  assert.notDeepEqual(renderer.render(frames[0].scene).data.slice(index, index + 4), renderer.render(frames[1].scene).data.slice(index, index + 4));
  assert.deepEqual(store.get('drawing'), after); assert.equal(after.revision, before.revision + 1);
});
test('circle creation and recoloring use normalized radial geometry from their own center', () => {
  const store = new SceneStore();
  const before = store.create({ scene_id: 'drawing', width: 64, height: 48 });
  const operations: Operation[] = [{ op: 'add', object: { id: 'circle', kind: 'ellipse', bounds: [16,12,32,24], color: 9, layer: 1 } }, { op: 'update', id: 'circle', changes: { color: 7 } }];
  store.apply('drawing', operations);
  const frames = paintPreviews(before, store.get('drawing'), operations);
  assert.deepEqual(frames.map(frame => frame.style), [
    { kind: 'rays', center: [0.5, 0.5], radius: [0.25, 0.25] },
    { kind: 'rays', center: [0.5, 0.5], radius: [0.25, 0.25] },
  ]);
  assert.equal(frames[0].scene.objects[0].color, 9); assert.equal(frames[1].scene.objects[0].color, 7);
});
