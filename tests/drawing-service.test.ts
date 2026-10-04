import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createDrawingService } from '../src/adapters/server/index';
import type { DrawingEvent } from '../src/contracts/service';
import { mockModel } from './fixtures/model';

async function startService() {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'service-test-'));
  await copyFile(resolve('agents.example.json'), resolve(root, 'agents.example.json'));
  const model = mockModel();
  const middleware = await createDrawingService({ root, fetch: model.fetcher, environment: { AGENT_EDITOR_MODEL: 'test-model', AGENT_API_KEY: 'server-only-key', AGENT_MAX_REVIEWS: '2' } });
  const server = createServer((request, response) => { void middleware(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const url = `http://127.0.0.1:${address.port}`;
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const draw = (body: unknown) => fetch(`${url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { root, url, close, draw, model };
}
const events = (text: string): DrawingEvent[] => text.trim().split('\n').map(line => JSON.parse(line));
test('separate tool calls from one model response share a queue; the next response uses a new queue', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [paired-calls]', layers: 1 })).text());
    const indices = items.flatMap((item, index) => item.type === 'tool' && item.name === 'scene_apply' ? [index] : []);
    assert.equal(indices.length, 2);
    const first = items[indices[0] + 1], second = items[indices[1] + 1];
    assert.ok(first.type === 'preview' && second.type === 'preview');
    if (first.type !== 'preview' || second.type !== 'preview') return;
    assert.ok(first.group); assert.equal(first.group, second.group);
    const submitted = items.findIndex(item => item.type === 'tool' && item.name === 'finish_draft');
    const next = items[submitted + 1];
    assert.ok(next.type === 'preview' && next.group !== first.group);
    assert.ok(items.at(-1)?.type === 'final');
  } finally { await service.close(); }
});
test('service sends nested figures separately in one response queue with radial circle geometry', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [nested]', layers: 1 })).text());
    const start = items.findIndex(item => item.type === 'tool' && item.name === 'scene_apply');
    const frames = items.slice(start + 1, start + 4);
    assert.ok(frames.every(item => item.type === 'preview'));
    if (!frames.every(item => item.type === 'preview')) return;
    assert.ok(frames[0].group && frames.every(frame => frame.group === frames[0].group));
    assert.deepEqual(frames.map(frame => frame.style?.kind), ['scanline', 'scanline', 'rays']);
    assert.deepEqual(frames[2].style, { kind: 'rays', center: [0.5, 0.5], radius: [0.125, 1 / 6] });
    const pixels = frames.map(frame => PNG.sync.read(Buffer.from(frame.image.split(',')[1], 'base64')));
    const center = (24 * 64 + 32) * 4;
    assert.notDeepEqual(pixels[0].data.slice(center, center + 4), pixels[1].data.slice(center, center + 4));
    assert.notDeepEqual(pixels[1].data.slice(center, center + 4), pixels[2].data.slice(center, center + 4));
    const final = items.at(-1)!;
    assert.ok(final.type === 'final' && final.approved);
    if (final.type === 'final') for (const index of [1,2,3]) assert.ok((await readdir(resolve(service.root, 'outputs', 'workflow', final.scene_id))).includes(`paint-r1-${index}.json`));
    assert.ok(!items.some(item => item.type === 'preview' && 'animate' in item));
  } finally { await service.close(); }
});
test('service streams stages, tools, images and reviews; saves and edits the returned scene', async () => {
  const service = await startService();
  try {
    const first = await service.draw({ prompt: 'Scene [reject]', layers: 3 });
    assert.equal(first.status, 200);
    const text = await first.text(), items = events(text);
    assert.ok(!text.includes('server-only-key'));
    assert.equal(items.filter(item => item.type === 'stage').length, 3);
    assert.equal(items.filter(item => item.type === 'review').length, 2);
    assert.ok(items.some(item => item.type === 'tool' && item.name === 'scene_apply' && Array.isArray(item.input.operations)));
    const final = items.at(-1)!;
    assert.equal(final.type, 'final');
    if (final.type !== 'final') return;
    assert.equal(final.approved, true);
    const saved = JSON.parse(await readFile(resolve(service.root, 'outputs', 'workflow', final.scene_id, 'final.json'), 'utf8'));
    assert.match(final.output_path!, /^outputs\/\d{8}\/Scene \[reject\]\.jpg$/);
    assert.ok((await readFile(resolve(service.root, final.output_path!))).subarray(0, 2).equals(Buffer.from([255, 216])));
    const previews = items.filter(item => item.type === 'preview');
    assert.ok(previews.every(item => item.type === 'preview' && item.image.startsWith('data:image/png;')));
    const edited = events(await (await service.draw({ prompt: 'Edit this scene', layers: 1, scene_id: final.scene_id })).text());
    const result = edited.at(-1)!;
    assert.ok(result.type === 'final' && result.approved && result.scene_id !== final.scene_id);
    if (result.type === 'final') {
      const scene = JSON.parse(await readFile(resolve(service.root, 'outputs', 'workflow', result.scene_id, 'final.json'), 'utf8'));
      assert.ok(saved.objects.every((object: { id: string }) => scene.objects.some((item: { id: string }) => item.id === object.id)));
    }
    const journal = await readFile(resolve(service.root, 'outputs', 'logs', 'agent.jsonl'), 'utf8');
    assert.ok(!journal.includes('server-only-key') && !journal.includes('data:image/'));
    for (const type of ['start', 'prompt', 'response', 'tool', 'preview', 'draft', 'review', 'final', 'saved']) assert.ok(journal.includes(`"type":"${type}"`), type);
  } finally { await service.close(); }
});
test('service rejects malformed requests, undefined flows, missing bases and cross-origin calls before inference', async () => {
  const service = await startService();
  try {
    for (const value of [null, {}, { prompt: ' ', layers: 1 }, { prompt: 'Scene', layers: 7 }, { prompt: 'x'.repeat(4001), layers: 1 }, { prompt: 'Scene', layers: 1, batch: { id: '../escape', index: 1 } }]) assert.equal((await service.draw(value)).status, 400);
    assert.equal((await service.draw({ prompt: 'Scene', layers: 1, scene_id: 'unknown' })).status, 404);
    assert.equal((await fetch(`${service.url}/api/runs`)).status, 405);
    assert.equal((await fetch(`${service.url}/api/runs`, { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' })).status, 403);
    assert.equal(service.model.requests.length, 0);
  } finally { await service.close(); }
});
test('model failures remain visible in the stream and incomplete drawings retain their partial result', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [fail-after-background]', layers: 3 })).text());
    assert.ok(items.some(item => item.type === 'execution_error' && /Simulated model failure/.test(item.message)));
    const final = items.at(-1)!;
    assert.ok(final.type === 'final' && final.stop_reason === 'incomplete' && !final.approved);
    if (final.type === 'final') assert.ok((await readdir(resolve(service.root, 'outputs', 'workflow', final.scene_id))).includes('background-draft-1.json'));
    const failure = events(await (await service.draw({ prompt: '[fail]', layers: 1 })).text());
    assert.equal(failure.at(-1)!.type, 'error');
    assert.match(await readFile(resolve(service.root, 'outputs', 'logs', 'agent.jsonl'), 'utf8'), /"type":"error"/);
  } finally { await service.close(); }
});

test('service batch deliveries use the shared batch UUID and numbered JPG paths', async () => {
  const service = await startService();
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  try {
    for (const index of [1, 2]) {
      const items = events(await (await service.draw({ prompt: `Scene ${index}`, layers: 1, batch: { id, index } })).text());
      const final = items.at(-1)!;
      assert.ok(final.type === 'final' && final.approved);
      if (final.type === 'final') assert.equal(final.output_path, `outputs/batch/${id}/${String(index).padStart(3, '0')}.jpg`);
    }
    assert.deepEqual((await readdir(resolve(service.root, 'outputs', 'batch', id))).sort(), ['001.jpg', '002.jpg']);
  } finally { await service.close(); }
});
