import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { createDrawingService } from '../src/adapters/server/index';
import type { DrawingEvent } from '../src/contracts/service';
import { mockModel } from './fixtures/model';
import { deferred, gatedCompletion } from './fixtures/stream';

async function startService(options: { discovery?: typeof fetch; inference?: typeof fetch; environment?: NodeJS.ProcessEnv } = {}) {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'service-test-'));
  await copyFile(resolve('agents.example.json'), resolve(root, 'agents.example.json'));
  const model = mockModel();
  const fetcher: typeof fetch = (input, init) => options.discovery && String(input).endsWith('/models') ? options.discovery(input, init) : (options.inference ?? model.fetcher)(input, init);
  const middleware = await createDrawingService({ root, fetch: fetcher, environment: { AGENT_EDITOR_MODEL: 'test-model', AGENT_API_KEY: 'server-only-key', AGENT_MAX_REVIEWS: '2', ...options.environment } });
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

test('HTTP reasoning and tool arguments arrive while the model response is still open', { timeout: 15000 }, async () => {
  const fake = mockModel(), prefillGate = deferred(), argumentsGate = deferred(), finishGate = deferred();
  const service = await startService({ inference: async (input, init) => {
    const response = await fake.fetcher(input, init);
    return fake.requests.length === 1 ? gatedCompletion(await response.json(), argumentsGate.promise, finishGate.promise, prefillGate.promise) : response;
  } });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = setTimeout(() => { prefillGate.resolve(); argumentsGate.resolve(); finishGate.resolve(); }, 10000);
  try {
    const response = await service.draw({ prompt: 'Scene', layers: 2 });
    reader = response.body!.getReader();
    const decoder = new TextDecoder(), items: DrawingEvent[] = [];
    let buffer = '';
    const until = async (predicate: (item: DrawingEvent) => boolean) => {
      while (!items.some(predicate)) {
        const chunk = await reader!.read(); assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) { items.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
      }
    };
    await until(item => item.type === 'state' && item.state === 'processing_prompt');
    assert.ok(!items.some(item => item.type === 'state' && item.state === 'thinking'), 'Prefill is not labeled as thinking');
    prefillGate.resolve();
    await until(item => item.type === 'tool_input');
    assert.equal(fake.requests[0].stream, true);
    assert.deepEqual(fake.requests[0].stream_options, { include_usage: true });
    assert.ok(items.some(item => item.type === 'thinking' && item.text === 'Plan the scene: draw the whole block.' && item.tokens_estimated));
    assert.ok(items.some(item => item.type === 'state' && item.state === 'writing_tool_args'));
    assert.ok(!items.some(item => item.type === 'tool'));
    argumentsGate.resolve();
    await until(item => item.type === 'tool_input' && item.input.endsWith('}'));
    assert.ok(!items.some(item => item.type === 'final'));
    assert.equal(fake.requests.length, 1, 'No next request until the current stream closes');
    const partial = items.find(item => item.type === 'tool_input');
    finishGate.resolve();
    await until(item => item.type === 'final');
    const executed = items.find(item => item.type === 'tool');
    assert.equal(partial?.id, executed?.id, 'The log updates one tool entry through generation and execution');
    assert.ok(items.some(item => item.type === 'thinking' && item.final && item.tokens === 17 && !item.tokens_estimated));
    assert.ok(items.some(item => item.type === 'final' && item.approved));
  } finally { clearTimeout(deadline); prefillGate.resolve(); argumentsGate.resolve(); finishGate.resolve(); await reader?.cancel(); await service.close(); }
});

test('workflow 1 saves and returns a complete drawing without reviewer requests or approval', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [reject]', layers: 1 })).text());
    const final = items.at(-1);
    assert.ok(final?.type === 'final' && final.stop_reason === 'unreviewed' && !final.approved);
    assert.ok(!items.some(item => item.type === 'review'));
    assert.ok(service.model.requests.every(request => !request.tools.some(tool => tool.function.name === 'submit_review')));
    if (final?.type === 'final') assert.ok((await readFile(resolve(service.root, final.output_path!))).length > 0);
  } finally { await service.close(); }
});

test('reasoning selection applies to every stage and reviewer for one request without changing private defaults', async () => {
  const service = await startService();
  try {
    const path = resolve(service.root, 'agents.local.json');
    const original = JSON.stringify({ connection: { reasoning_effort: 'high' }, agents: {} });
    await writeFile(path, original);
    for (const effort of ['none', 'low', 'medium', 'high']) {
      const start = service.model.requests.length;
      const items = events(await (await service.draw({ prompt: 'Scene', layers: 3, reasoning_effort: effort })).text());
      assert.ok(items.at(-1)?.type === 'final');
      assert.ok(service.model.requests.slice(start).every(request => request.reasoning_effort === effort));
    }
    const start = service.model.requests.length;
    await (await service.draw({ prompt: 'Default', layers: 2 })).text();
    assert.ok(service.model.requests.slice(start).every(request => request.reasoning_effort === 'high'));
    assert.equal(await readFile(path, 'utf8'), original);
    for (const invalid of ['off', 'auto', '', null, 0]) assert.equal((await service.draw({ prompt: 'Scene', layers: 2, reasoning_effort: invalid })).status, 400);
  } finally { await service.close(); }
});

test('vision JPGs reduce both dimensions per request while canvas previews and saved outputs stay full size', async () => {
  const service = await startService();
  try {
    for (const divisor of [4, 2, 1]) {
      const start = service.model.requests.length;
      const items = events(await (await service.draw({ prompt: 'Scene', layers: 2, ...(divisor === 4 ? {} : { vision_image_divisor: divisor }) })).text());
      const images = service.model.requests.slice(start).flatMap(request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []));
      assert.ok(images.length > 0);
      for (const image of images) {
        const decoded = jpeg.decode(Buffer.from(image.image_url!.url.split(',')[1], 'base64'));
        assert.equal(decoded.width, 640 / divisor); assert.equal(decoded.height, 480 / divisor);
      }
      const preview = items.find(item => item.type === 'preview');
      assert.ok(preview?.type === 'preview');
      if (preview?.type === 'preview') assert.equal(PNG.sync.read(Buffer.from(preview.image.split(',')[1], 'base64')).width, 640);
      const final = items.at(-1);
      if (final?.type === 'final') {
        const saved = jpeg.decode(await readFile(resolve(service.root, final.output_path!)));
        assert.equal(saved.width, 640); assert.equal(saved.height, 480);
      }
    }
    const start = service.model.requests.length;
    for (const invalid of [0, -1, 1.5, 65, '4', null]) assert.equal((await service.draw({ prompt: 'Scene', layers: 2, vision_image_divisor: invalid })).status, 400);
    assert.equal(service.model.requests.length, start);
  } finally { await service.close(); }
});
test('model listing uses the configured v1 endpoint and private key without starting inference or exposing settings', async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const service = await startService({ environment: { AGENT_BASE_URL: 'http://models.test:9123/v1/', AGENT_EDITOR_MODEL: 'second-model' }, discovery: async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
    return Response.json({ data: [{ id: 'embedding-test' }, { id: 'test-model' }, { id: 'second-model' }, { id: 'test-model' }] });
  } });
  try {
    const response = await fetch(`${service.url}/api/models`), text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { models: ['embedding-test', 'test-model', 'second-model'], selected_model: 'second-model' });
    assert.deepEqual(calls, [{ url: 'http://models.test:9123/v1/models', authorization: 'Bearer server-only-key' }]);
    assert.ok(!text.includes('server-only-key') && !text.includes('models.test'));
    assert.equal((await fetch(`${service.url}/api/models`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${service.url}/api/models`, { headers: { Origin: 'https://other.test' } })).status, 403);
    assert.equal(calls.length, 1); assert.equal(service.model.requests.length, 0);
  } finally { await service.close(); }
});
test('discovery failure is visible and a later refresh can recover', async () => {
  let calls = 0;
  const service = await startService({ discovery: async () => ++calls === 1 ? Response.json({ error: 'not ready' }, { status: 503 }) : Response.json({ data: [{ id: 'ready-model' }] }) });
  try {
    const failed = await fetch(`${service.url}/api/models`);
    assert.equal(failed.status, 500); assert.match((await failed.json()).error, /HTTP 503/);
    const recovered = await fetch(`${service.url}/api/models`);
    assert.deepEqual(await recovered.json(), { models: ['ready-model'], selected_model: 'ready-model' });
    assert.equal(service.model.requests.length, 0);
  } finally { await service.close(); }
});
test('a selected model overrides every artist and reviewer only for its request and preserves local profiles', async () => {
  const service = await startService();
  try {
    const path = resolve(service.root, 'agents.local.json');
    const original = JSON.stringify({ connection: { reviewer_model: 'default-reviewer' }, agents: { background: { model: 'background-local', instructions: 'Keep request-specific selection separate.' }, main_content: { model: 'subject-local' }, reviewer: { model: 'reviewer-local' } } });
    await writeFile(path, original);
    const selected = events(await (await service.draw({ prompt: 'Selected run', layers: 3, model: 'second-model' })).text());
    assert.ok(selected.at(-1)?.type === 'final');
    assert.ok(service.model.requests.length > 0 && service.model.requests.every(request => request.model === 'second-model'));
    assert.ok(service.model.requests.some(request => request.messages.some(message => typeof message.content === 'string' && message.content.includes('Keep request-specific selection separate.'))));
    const count = service.model.requests.length;
    await (await service.draw({ prompt: 'Default run', layers: 3 })).text();
    assert.deepEqual(new Set(service.model.requests.slice(count).map(request => request.model)), new Set(['background-local', 'subject-local', 'reviewer-local']));
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await service.close(); }
});
test('separate tool calls from one model response share a queue; the next response uses a new queue', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [paired-calls]', layers: 2 })).text());
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
    const items = events(await (await service.draw({ prompt: 'Scene [nested]', layers: 2 })).text());
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
    const first = await service.draw({ prompt: 'Scene [reject] [thinking]', layers: 4 });
    assert.equal(first.status, 200);
    const text = await first.text(), items = events(text);
    assert.ok(!text.includes('server-only-key'));
    assert.equal(items.filter(item => item.type === 'stage').length, 3);
    assert.equal(items.filter(item => item.type === 'review').length, 2);
    assert.ok(items.some(item => item.type === 'tool' && item.name === 'scene_apply' && Array.isArray(item.input.operations)));
    const states = items.filter(item => item.type === 'state');
    for (const state of ['processing_prompt', 'thinking', 'writing_tool_args', 'executing_tool', 'idle']) assert.ok(states.some(item => item.state === state), state);
    assert.equal(states.at(-1)?.state, 'idle');
    for (const [index, item] of items.entries()) if (item.type === 'tool') {
      const previous = items.slice(0, index).filter(event => event.type === 'state').at(-1);
      assert.ok(previous?.type === 'state' && previous.state === 'executing_tool' && previous.tool === item.name);
    }
    const final = items.at(-1)!;
    assert.equal(final.type, 'final');
    if (final.type !== 'final') return;
    assert.equal(final.approved, true);
    const saved = JSON.parse(await readFile(resolve(service.root, 'outputs', 'workflow', final.scene_id, 'final.json'), 'utf8'));
    assert.match(final.output_path!, /^outputs\/\d{8}\/Scene \[reject\] \[thinking\]\.jpg$/);
    assert.ok((await readFile(resolve(service.root, final.output_path!))).subarray(0, 2).equals(Buffer.from([255, 216])));
    const previews = items.filter(item => item.type === 'preview');
    assert.ok(previews.every(item => item.type === 'preview' && item.image.startsWith('data:image/png;')));
    const edited = events(await (await service.draw({ prompt: 'Edit this scene', layers: 2, scene_id: final.scene_id })).text());
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
test('service forwards reasoning token usage separately from tool output tokens', async () => {
  const service = await startService();
  try {
    const response = await service.draw({ prompt: 'Scene [thinking]', layers: 2 });
    const thoughts = events(await response.text()).filter(item => item.type === 'thinking');
    assert.ok(thoughts.length > 0);
    assert.ok(thoughts.every(item => item.tokens === 512 && item.tokens_estimated === false));
    assert.ok(thoughts.every(item => item.text.includes('Inspect the requested scene')));
  } finally { await service.close(); }
});

test('service rejects malformed requests, undefined flows, missing bases and cross-origin calls before inference', async () => {
  const service = await startService();
  try {
    for (const value of [null, {}, { prompt: ' ', layers: 2 }, { prompt: 'Scene', layers: 8 }, { prompt: 'x'.repeat(4001), layers: 2 }, { prompt: 'Scene', layers: 2, batch: { id: '../escape', index: 1 } }]) assert.equal((await service.draw(value)).status, 400);
    for (const model of ['', ' ', 42, null, 'x'.repeat(257)]) assert.equal((await service.draw({ prompt: 'Scene', layers: 2, model })).status, 400);
    assert.equal((await service.draw({ prompt: 'Scene', layers: 2, scene_id: 'unknown' })).status, 404);
    assert.equal((await fetch(`${service.url}/api/runs`)).status, 405);
    assert.equal((await fetch(`${service.url}/api/runs`, { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' })).status, 403);
    assert.equal(service.model.requests.length, 0);
  } finally { await service.close(); }
});
test('model failures remain visible in the stream and incomplete drawings retain their partial result', async () => {
  const service = await startService();
  try {
    const items = events(await (await service.draw({ prompt: 'Scene [fail-after-background]', layers: 4 })).text());
    assert.ok(items.some(item => item.type === 'execution_error' && /Simulated model failure/.test(item.message)));
    const final = items.at(-1)!;
    assert.ok(final.type === 'final' && final.stop_reason === 'incomplete' && !final.approved);
    if (final.type === 'final') assert.ok((await readdir(resolve(service.root, 'outputs', 'workflow', final.scene_id))).includes('background-draft-1.json'));
    const failure = events(await (await service.draw({ prompt: '[fail]', layers: 2 })).text());
    assert.equal(failure.at(-1)!.type, 'error');
    assert.match(await readFile(resolve(service.root, 'outputs', 'logs', 'agent.jsonl'), 'utf8'), /"type":"error"/);
  } finally { await service.close(); }
});

test('service batch deliveries use the shared batch UUID and numbered JPG paths', async () => {
  const service = await startService();
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  try {
    for (const index of [1, 2]) {
      const items = events(await (await service.draw({ prompt: `Scene ${index}`, layers: 2, batch: { id, index } })).text());
      const final = items.at(-1)!;
      assert.ok(final.type === 'final' && final.approved);
      if (final.type === 'final') assert.equal(final.output_path, `outputs/batch/${id}/${String(index).padStart(3, '0')}.jpg`);
    }
    assert.deepEqual((await readdir(resolve(service.root, 'outputs', 'batch', id))).sort(), ['001.jpg', '002.jpg']);
  } finally { await service.close(); }
});
