import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SceneStore } from '../src/core/index';
import { getWorkflow } from '../src/contracts/workflows';
import { OutputStore } from '../src/adapters/node/outputs';
import { runPersistence } from '../src/adapters/server/persistence';

const id = '01234567-89ab-4cde-8fab-0123456789ab';
async function fixture() {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'persistence-test-'));
  const scenes = new SceneStore(); scenes.create({ scene_id: 'drawing', width: 32, height: 32 });
  return { root, scene: scenes.get('drawing'), stage: getWorkflow(1).stages[0] };
}
test('cancellation flushes queued previews and drafts even when the event producer did not await capture', async () => {
  const { root, scene, stage } = await fixture();
  const store = new OutputStore(root), persistence = runPersistence(store, id);
  void persistence.capture({ type: 'agent', stage, event: { type: 'preview', role: 'editor', round: 1,
    scene, preview: { image_ref: 'data:image/jpeg;base64,omitted', revision: scene.revision }, source: 'scene_create', changed_pixels: 0, affected_ids: [],
  } });
  void persistence.capture({ type: 'agent', stage, event: { type: 'draft', round: 1,
    draft: { scene, preview: { image_ref: 'data:image/jpeg;base64,omitted', revision: scene.revision } },
  } });
  await persistence.flush();
  await store.record(id, { type: 'cancelled' });
  const names = await readdir(store.runFolder(id));
  assert.ok(names.includes(`preview-r${scene.revision}.json`) && names.includes('artist-draft-1.jpg'));
  assert.ok(!names.includes('final.json'));
  assert.deepEqual(JSON.parse(await readFile(resolve(store.runFolder(id), `preview-r${scene.revision}.json`), 'utf8')), scene);
  const journal = (await readFile(resolve(root, 'logs', 'agent.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(journal.map(event => event.type), ['preview', 'draft', 'cancelled']);
});
test('persistence errors are surfaced and cannot silently become a successful final delivery', async () => {
  const { root, stage } = await fixture();
  const blocked = resolve(root, 'blocked'); await writeFile(blocked, 'not a directory');
  const errors: string[] = [];
  const persistence = runPersistence(new OutputStore(blocked), id, message => errors.push(message));
  await persistence.capture({ type: 'stage', stage, index: 1, total: 1 });
  assert.equal(errors.length, 1);
  await assert.rejects(persistence.flush());
});
