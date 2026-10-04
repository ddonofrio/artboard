import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve, basename, relative } from 'node:path';
import { SceneStore } from '../src/core/index';
import { OutputStore, drawingDate, drawingName } from '../src/adapters/node/outputs';

const id = '01234567-89ab-4cde-8fab-0123456789ab';
async function output() {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'outputs-test-'));
  const scenes = new SceneStore(); scenes.create({ scene_id: 'drawing', width: 32, height: 32 });
  scenes.apply('drawing', [{ op: 'add', object: { id: 'background', kind: 'polygon', points: [[0,0],[32,0],[32,32],[0,32]], color: 9, layer: -100 } }]);
  return { root, store: new OutputStore(root), scene: scenes.get('drawing') };
}
test('dated JPGs use Madrid dates, preserve prompts and allocate names without overwriting', async () => {
  const { root, store, scene } = await output(), now = new Date('2026-10-04T22:30:00Z');
  assert.equal(drawingDate(now), '20261005');
  const paths = await Promise.all([store.drawing(scene, "England's flag", undefined, now), store.drawing(scene, "England's flag", undefined, now)]);
  assert.deepEqual(paths.map(path => basename(path)).sort(), ["England's flag(1).jpg", "England's flag.jpg"].sort());
  assert.ok(paths.every(path => relative(root, path).startsWith('20261005')));
  assert.ok((await readFile(paths[0])).subarray(0, 2).equals(Buffer.from([255, 216])));
  assert.equal(drawingName('../CON: house?'), '.._CON_ house_');
  assert.equal(drawingName('CON'), '_CON');
  assert.ok(Buffer.byteLength(drawingName('🌞'.repeat(100)), 'utf8') <= 180);
});
test('batch JPGs follow batch UUID and numbered line paths, with exclusive writes', async () => {
  const { root, store, scene } = await output();
  const path = await store.drawing(scene, 'Batch drawing', { id, index: 2 });
  assert.equal(path, resolve(root, 'batch', id, '002.jpg'));
  await assert.rejects(store.drawing(scene, 'Duplicate', { id, index: 2 }), /EEXIST/);
  await assert.rejects(store.drawing(scene, 'Escape', { id: '../escape', index: 1 }), /UUID/);
});
test('every revision has JPEG/JSON snapshots and journals serialize events while omitting credentials and image bytes', async () => {
  const { root, store, scene } = await output();
  await store.snapshot(id, 'preview-r1', scene); await store.snapshot(id, 'preview-r1', scene);
  assert.deepEqual((await readdir(resolve(root, 'workflow', id))).sort(), ['preview-r1.jpg', 'preview-r1.json']);
  const events = [{ type: 'start', api_key: 'secret' }, { type: 'preview', image: 'data:image/jpeg;base64,secret', scene }, { type: 'cancelled' }];
  await Promise.all(events.map(event => store.record(id, event))); await store.flush();
  const text = await readFile(resolve(root, 'logs', 'agent.jsonl'), 'utf8');
  assert.ok(!text.includes('secret'));
  const journal = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(journal.map(event => event.type), ['start', 'preview', 'cancelled']);
  assert.ok(journal.every(event => event.run_id === id && event.timestamp));
  assert.deepEqual(journal[1].scene, scene);
});
