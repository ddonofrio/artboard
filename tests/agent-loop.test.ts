import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentConfig, apiBaseURL, DEFAULT_AGENT_CONFIG, listModels, runAgentLoop, type AgentEvent } from '../src/agents/index';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage, type Scene } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { drawingFeedback } from '../src/agents/feedback';
import { EDITOR_INSTRUCTIONS, REVIEWER_INSTRUCTIONS } from '../src/agents/prompts';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const host = () => new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());
interface ChatRequest {
  model: string;
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools: { function: { name: string } }[];
  parallel_tool_calls?: boolean;
  tool_choice?: unknown;
}
interface MockOptions { staleReview?: boolean; invalidEdit?: boolean; failReview?: boolean; approveAll?: boolean; approveAt?: number; rejectFinal?: boolean; neverFinish?: boolean; malformedCreate?: boolean }
function simulatedServer(options: MockOptions = {}) {
  const requests: ChatRequest[] = [], urls: string[] = [];
  const calls = new Map<string, number>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    init?.signal?.throwIfAborted();
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'text-embedding-test' }, { id: 'local-vision' }] });
    assert.ok(url.endsWith('/chat/completions'));
    const request = JSON.parse(String(init?.body)) as ChatRequest; requests.push(request);
    const system = request.messages.find(message => message.role === 'system')!.content as string;
    const role = system.includes('scene EDITOR') ? 'editor' : 'reviewer';
    const user = request.messages.filter(message => message.role === 'user').at(-1)!;
    const content = typeof user.content === 'string' ? user.content : user.content!.find(part => part.type === 'text')!.text!;
    const context = JSON.parse(content) as { round: number; draft?: { scene: Scene } | null; current_scene?: Scene };
    const key = `${role}:${context.round}`, rawStep = calls.get(key) ?? 0;
    const step = rawStep - (options.malformedCreate && role === 'editor' && context.round === 1 && rawStep > 0 ? 1 : 0);
    calls.set(key, rawStep + 1);
    assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.tool_choice, 'required');
    if (role === 'reviewer') {
      const names = request.tools.map(tool => tool.function.name).sort();
      assert.deepEqual(names, names.includes('scene_render') ? ['scene_catalog', 'scene_inspect', 'scene_render', 'submit_review'] : ['scene_catalog', 'scene_inspect', 'submit_review']);
      if (options.failReview) return Response.json({ error: { message: 'Model does not support image inputs', type: 'invalid_request_error' } }, { status: 400 });
    }
    let name: string, args: Record<string, unknown>;
    const prior = request.messages.filter(message => message.role === 'tool').at(-1);
    let priorResult: { ok: boolean; result?: { revision?: number } } | undefined;
    try { priorResult = prior ? JSON.parse(prior.content as string) : undefined; }
    catch { /* SDK tool errors use a plain-text tool message. */ }
    const previousRevision = priorResult?.result?.revision ?? context.current_scene?.revision ?? context.draft?.scene.revision ?? 0;
    if (role === 'editor' && options.neverFinish && step > 1) { name = 'scene_catalog'; args = { category: 'materials', id: 'stone' }; }
    else if (role === 'editor' && step === 0 && !context.draft) { name = 'scene_create'; args = { scene_id: 'artboard', seed: 42 }; }
    else if (role === 'editor' && step === 1 && !context.draft) {
      name = 'scene_apply'; args = { scene_id: 'artboard', operations: [
        { op: 'add', object: { id: 'background', kind: 'polygon', points: [[0,0],[640,0],[640,480],[0,480]], layer: -100, color: 12 } },
        { op: 'add', object: { id: 'entrance_gate', kind: 'procedural', generator: 'gate', bounds: [266,168,108,191], layer: 10, params: { shape: 'arched', bar_count: 6 } } },
      ] };
    }
    else if (role === 'editor' && ((context.round > 1 && step === 0) || (options.invalidEdit && context.round === 2 && step === 1))) {
      name = 'scene_apply'; args = { scene_id: 'artboard', operations: [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: options.invalidEdit && step === 0 && context.round === 2 ? 99 : context.round % 2 === 0 ? 4 : 3 } } }] };
    } else if (role === 'editor') {
      name = 'finish_draft'; args = { revision: previousRevision };
    } else {
      name = 'submit_review';
      const approved = options.approveAll || (context.round === (options.approveAt ?? 3) && !options.rejectFinal);
      args = { revision: context.draft!.scene.revision + (options.staleReview && context.round === 1 && step === 0 ? 99 : 0), approved, issues: approved ? [] : [{ object_id: 'entrance_gate', instruction: 'Reduce the number of bars to make the entrance clearer.' }] };
    }
    return Response.json({ id: `chat-${requests.length}`, object: 'chat.completion', created: 1, model: request.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name, arguments: options.malformedCreate && requests.length === 1 ? '{' : JSON.stringify(args) } }] } }], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } });
  };
  return { fetcher, requests, urls };
}
test('API config normalizes root/v1/custom paths and bounds loop settings', () => {
  assert.equal(apiBaseURL(DEFAULT_AGENT_CONFIG.base_url), 'http://127.0.0.1:1234/v1');
  assert.equal(apiBaseURL('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(apiBaseURL('http://localhost:1234/custom/api/'), 'http://localhost:1234/custom/api');
  assert.throws(() => apiBaseURL('file:///C:/secret'), /HTTP/);
  assert.throws(() => apiBaseURL('http://user:password@localhost'), /credentials/);
  assert.equal(agentConfig().max_reviews, 10);
  assert.equal(agentConfig({ max_reviews: 10 }).max_reviews, 10);
  assert.throws(() => agentConfig({ max_reviews: 11 }), /max_reviews.*1 to 10/);
  assert.equal('max_steps' in agentConfig(), false);
});
test('AI SDK feeds rejected reviews back to the editor without unsolicited images and with targeted edits', async () => {
  const tools = host(), fake = simulatedServer(), events: AgentEvent[] = [];
  const result = await runAgentLoop({ tools, prompt: 'A cave with a gate', config: { base_url: 'http://example.test:1234', editor_model: 'editor-vl', reviewer_model: 'reviewer-vl', max_reviews: 3 }, fetch: fake.fetcher, onEvent: event => events.push(event) });
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.type === 'phase' ? `${e.role}:${e.round}` : ''), ['editor:1','reviewer:1','editor:2','reviewer:2','editor:3','reviewer:3']);
  assert.equal(result.reviews.length, 3); assert.equal(result.drafts.length, 3); assert.equal(result.approved, true);
  assert.deepEqual(result.reviews.map(review => review.revision), [1,2,3]);
  assert.equal(result.draft.scene.revision, result.draft.preview.revision);
  const gate = result.draft.scene.objects.find(o => o.id === 'entrance_gate')!;
  assert.ok(gate.kind === 'procedural' && gate.params?.bar_count === 3);
  assert.deepEqual(result.drafts[0].scene.objects.filter(o => o.id !== gate.id), result.draft.scene.objects.filter(o => o.id !== gate.id));
  const reviewerCalls = fake.requests.filter(request => request.model === 'reviewer-vl');
  assert.equal(reviewerCalls.length, 3);
  const editRequest = fake.requests.filter(request => request.model === 'editor-vl')[3];
  const editContent = editRequest.messages.find(message => message.role === 'user')!.content;
  assert.equal(typeof editContent, 'string');
  const editContext = JSON.parse(editContent as string);
  assert.deepEqual(editContext.review, result.reviews[0]);
  assert.equal(editContext.task, 'Edit the drawing to address the independent review.');
  assert.equal(editContext.max_reviews, 3);
  assert.ok(fake.requests.filter(request => request.model === 'editor-vl').every(request => !JSON.stringify(request.messages).includes('data:image/')));
  for (const [index, request] of reviewerCalls.entries()) {
    const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    assert.deepEqual(images.map(part => part.image_url!.url), [result.drafts[index].preview.image_ref]);
  }
  for (const url of fake.urls) assert.ok(url.startsWith('http://example.test:1234/v1/chat/completions'));
  assert.deepEqual(events.filter(e => e.type === 'connection').map(e => e.type === 'connection' ? e.models : undefined), [undefined, { editor: 'editor-vl', reviewer: 'reviewer-vl' }]);
  const modelEvents = events.filter(e => e.type === 'model');
  assert.equal(modelEvents.filter(e => e.state === 'request').length, fake.requests.length);
  assert.equal(modelEvents.filter(e => e.state === 'response').length, fake.requests.length);
  assert.deepEqual(modelEvents.map(e => `${e.role}:${e.round}:${e.step}:${e.state}`), [
    'editor:1:1:request', 'editor:1:1:response', 'editor:1:2:request', 'editor:1:2:response',
    'editor:1:3:request', 'editor:1:3:response',
    'reviewer:1:1:request', 'reviewer:1:1:response',
    'editor:2:1:request', 'editor:2:1:response', 'editor:2:2:request', 'editor:2:2:response',
    'reviewer:2:1:request', 'reviewer:2:1:response',
    'editor:3:1:request', 'editor:3:1:response', 'editor:3:2:request', 'editor:3:2:response',
    'reviewer:3:1:request', 'reviewer:3:1:response',
  ]);
  assert.ok(modelEvents.every(e => e.model === (e.role === 'editor' ? 'editor-vl' : 'reviewer-vl')));
  assert.ok(modelEvents.filter(e => e.state === 'response').every(e => e.output_tokens === 40));
  const previews = events.filter(e => e.type === 'preview');
  assert.deepEqual(previews.filter(e => ['scene_create', 'scene_apply'].includes(e.source)).map(e => [e.source,e.scene.revision]), [['scene_create',0],['scene_apply',1],['scene_apply',2],['scene_apply',3]]);
  assert.equal(previews[0].scene.objects.length, 0);
  assert.equal(previews[0].changed_pixels, 0);
  assert.ok(previews.filter(e => e.source === 'scene_apply').every(e => e.changed_pixels > 0));
  assert.deepEqual(fake.requests[0].tools.map(tool => tool.function.name), ['scene_create']);
  assert.deepEqual(fake.requests[1].tools.map(tool => tool.function.name), ['scene_apply']);
  const toolEvents = events.filter(e => e.type === 'tool');
  assert.deepEqual(previews.map(e => [e.role,e.source]), toolEvents.map(e => [e.role,e.name]));
  assert.ok(events.indexOf(previews[0]) < events.findIndex(e => e.type === 'draft'));
  assert.ok(previews.every(e => e.scene.revision === e.preview.revision && e.preview.image_ref.startsWith('data:image/jpeg;base64,')));
  const prompts = events.filter(e => e.type === 'prompt');
  assert.equal(prompts.length,fake.requests.length);
  assert.ok(prompts.filter(e => e.role === 'editor').every(e => !e.content.includes('attached; binary omitted')));
  assert.ok(prompts.some(e => e.role === 'reviewer' && e.content.includes('attached; binary omitted')));
  assert.ok(prompts.every(e => !e.content.includes('data:image/jpeg;base64,')));
  const edit = events.find(e => e.type === 'tool' && e.name === 'scene_apply');
  assert.ok(edit?.type === 'tool' && Array.isArray(edit.input.operations) && edit.output.ok);
});
test('prebuilt recipe calls are rejected visibly and the SDK retries with an empty canvas', async () => {
  const tools = host(), fake = simulatedServer({ approveAll: true }), events: AgentEvent[] = [];
  let first = true;
  const result = await runAgentLoop({ tools, prompt: 'An original forest', config: { editor_model: 'vl' }, onEvent: event => events.push(event),
    fetch: async (input, init) => {
      if (!first) return fake.fetcher(input, init);
      first = false;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools[0].function.parameters.properties.recipe, undefined);
      return Response.json({ id: 'bad-recipe', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'recipe-call', type: 'function', function: { name: 'scene_create', arguments: JSON.stringify({ scene_id: 'artboard', recipe: 'forest_path' }) } }],
      } }] });
    },
  });
  assert.equal(result.approved, true);
  const failed = events.find(event => event.type === 'tool' && event.name === 'scene_create' && !event.ok);
  assert.ok(failed?.type === 'tool' && !failed.output.ok && failed.output.error.code === 'AGENT_VALIDATION');
  assert.match(failed.message!, /empty scenes only/);
  assert.equal(events.filter(event => event.type === 'preview')[0].scene.objects.length, 0);
  assert.deepEqual(result.draft.scene.objects.map(object => object.id), ['background', 'entrance_gate']);
});

test('SDK errors before dispatch appear in the log and leave the canvas empty until corrected', async () => {
  const fake = simulatedServer({ approveAll: true, malformedCreate: true }), events: AgentEvent[] = [];
  const result = await runAgentLoop({ tools: host(), prompt: 'Scene', config: { editor_model: 'vl' }, fetch: fake.fetcher, onEvent: event => events.push(event) });
  assert.equal(result.approved, true);
  const failed = events.find(event => event.type === 'tool' && !event.ok);
  assert.ok(failed?.type === 'tool' && !failed.output.ok && failed.output.error.code === 'SDK_TOOL_ERROR');
  assert.equal(events.filter(event => event.type === 'preview')[0].scene.objects.length, 0);
});

test('multiple calls in one response wait for each preview before changing the scene again', async () => {
  const tools = host(), fake = simulatedServer({ approveAll: true });
  const base = new SceneStore().create({ scene_id: 'base' });
  base.objects = [{ id: 'background', kind: 'polygon', points: [[0,0],[640,0],[640,480],[0,480]], layer: -100, color: 4 }];
  let release!: () => void, ready!: () => void;
  const presented = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const previews: { source: string; revision: number; objects: number }[] = [];
  let first = true;
  const running = runAgentLoop({ tools, initial_scene: base, prompt: 'Draw in stages', config: { editor_model: 'vl' },
    fetch: async (input, init) => {
      if (!first) return fake.fetcher(input, init);
      first = false;
      const calls = [
        { name: 'scene_apply', args: { scene_id: 'artboard', operations: [{ op: 'update', id: 'background', changes: { color: 6 } }] } },
        { name: 'scene_apply', args: { scene_id: 'artboard', operations: [{ op: 'update', id: 'background', changes: { color: 12 } }] } },
        { name: 'finish_draft', args: { revision: 2 } },
      ];
      return Response.json({ id: 'multi', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: calls.map((call, i) => ({ id: `multi-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
      } }] });
    },
    onEvent: async event => {
      if (event.type !== 'preview') return;
      previews.push({ source: event.source, revision: event.scene.revision, objects: event.scene.objects.length });
      if (previews.length === 1) { ready(); await resume; }
      assert.equal(tools.store.get('artboard').revision, event.scene.revision);
    },
  });
  await presented;
  try { assert.equal(tools.store.get('artboard').revision, 1); assert.equal(tools.store.get('artboard').objects.length, 1); assert.equal(tools.store.get('artboard').objects[0].color, 6); }
  finally { release(); }
  const result = await running;
  assert.equal(result.approved, true);
  assert.deepEqual(previews, [
    { source: 'scene_apply', revision: 1, objects: 1 },
    { source: 'scene_apply', revision: 2, objects: 1 },
    { source: 'finish_draft', revision: 2, objects: 1 },
    { source: 'finish_draft', revision: 2, objects: 1 },
    { source: 'submit_review', revision: 2, objects: 1 },
  ]);
});

test('editor receives fresh snapshots and the reviewer retains its prior conversation across corrections', async () => {
  const fake = simulatedServer(), tools = host();
  const result = await runAgentLoop({ tools, prompt: 'A cave with a gate', config: { editor_model: 'editor-vl', reviewer_model: 'reviewer-vl' }, fetch: fake.fetcher });
  const requests = fake.requests.filter(request => request.model === 'editor-vl');
  const revisions: number[] = [];
  for (const request of requests.slice(1)) {
    const content = request.messages.filter(message => message.role === 'user').at(-1)!.content;
    assert.equal(typeof content, 'string');
    const context = JSON.parse(content as string);
    const scene = context.current_scene as Scene;
    revisions.push(scene.revision);
    const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    assert.equal(images.length, 0, 'Scene JSON refreshes without automatic image input');
    assert.equal(context.image_attached, false);
  }
  const reviewerCalls = fake.requests.filter(request => request.model === 'reviewer-vl');
  for (const [index, request] of reviewerCalls.entries()) {
    const users = request.messages.filter(message => message.role === 'user');
    assert.equal(users.length, index + 1);
    const content = users.at(-1)!.content;
    assert.ok(Array.isArray(content));
    const context = JSON.parse(content.find(part => part.type === 'text')!.text!);
    assert.equal(context.image_attached, true);
    assert.deepEqual(content.filter(part => part.type === 'image_url').map(part => part.image_url!.url), [result.drafts[index].preview.image_ref]);
    assert.ok(users.slice(0, -1).every(message => typeof message.content === 'string'), 'Earlier review images are removed');
    assert.equal(context.draft.scene.revision, result.drafts[index].scene.revision);
    assert.deepEqual(context.previous_review, result.reviews[index - 1] ?? null);
    const submissions = request.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === 'submit_review');
    assert.deepEqual(submissions.map(call => JSON.parse(call.function.arguments)), result.reviews.slice(0, index));
    for (const call of submissions) assert.ok(request.messages.some(message => message.role === 'tool' && message.tool_call_id === call.id));
    if (index > 0) assert.match(context.task, /verify each correction/);
  }
  assert.deepEqual(revisions, [0,1,1,2,2,3]);
});

test('an unchanged or invisible correction cannot bypass the rejected review; targeted edits recover', async () => {
  const fake = simulatedServer({ approveAt: 2 }), tools = host(), events: AgentEvent[] = [];
  let correctionRequests = 0;
  const result = await runAgentLoop({ tools, prompt: 'Cave', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const user = request.messages.filter(message => message.role === 'user').at(-1)!.content;
    const context = JSON.parse(typeof user === 'string' ? user : user!.find(part => part.type === 'text')!.text!);
    if (typeof request.messages[0].content === 'string' && request.messages[0].content.includes('scene EDITOR') && context.round === 2) {
      correctionRequests++;
      assert.deepEqual(context.review.issues, [{ object_id: 'entrance_gate', instruction: 'Reduce the number of bars to make the entrance clearer.' }]);
      assert.match(request.messages[0].content as string, /Correction checklist.*entrance_gate/);
      if (correctionRequests <= 3) {
        const name = correctionRequests === 2 ? 'scene_apply' : 'finish_draft';
        const args = name === 'finish_draft' ? { revision: context.current_scene.revision } : { scene_id: 'artboard', operations: [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: 6 } } }] };
        return Response.json({ id: `skip-${correctionRequests}`, object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `skip-call-${correctionRequests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
      }
      if (correctionRequests === 4) assert.match(request.messages.filter(message => message.role === 'tool').at(-1)!.content as string, /Apply visible corrections/);
    }
    return fake.fetcher(input, init);
  } });
  assert.equal(result.approved, true);
  assert.equal(result.reviews.length, 2);
  const rejections = events.filter(event => event.type === 'tool' && event.name === 'finish_draft' && !event.ok);
  assert.equal(rejections.length, 2);
  assert.deepEqual(result.reviews.map(review => review.revision), [1, 3]);
  assert.ok(events.some(event => event.type === 'preview' && event.round === 2 && event.source === 'scene_apply' && event.changed_pixels > 0));
  const gate = result.draft.scene.objects.find(object => object.id === 'entrance_gate')!;
  assert.ok(gate.kind === 'procedural' && gate.params?.bar_count === 4);
});

test('a model that ends before submission still delivers the latest canvas, including an empty created canvas', async () => {
  for (const stopAfter of [1, 2, 3, 5]) {
    const fake = simulatedServer(), tools = host(), events: AgentEvent[] = [];
    let calls = 0;
    const result = await runAgentLoop({ tools, prompt: 'Cave', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
      if (++calls <= stopAfter) return fake.fetcher(input, init);
      return Response.json({ id: 'stopped', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'No more turns.' } }] });
    } });
    assert.equal(result.stop_reason, 'incomplete');
    assert.equal(result.approved, false);
    assert.ok(result.error);
    assert.deepEqual(result.draft.scene, tools.store.get('artboard'));
    assert.equal(result.draft.scene.revision, stopAfter === 1 ? 0 : stopAfter === 5 ? 2 : 1);
    assert.equal(result.draft.preview.revision, result.draft.scene.revision);
    assert.deepEqual(result.drafts.at(-1), result.draft);
    assert.equal(events.filter(event => event.type === 'final').length, 1);
    assert.equal(events.at(-1)!.type, 'final');
  }
});

test('model transport errors after drawing deliver the current canvas without claiming approval', async () => {
  for (const stopAfter of [1, 2, 5]) {
    const fake = simulatedServer(), tools = host();
    let calls = 0;
    const result = await runAgentLoop({ tools, prompt: 'Cave', config: { editor_model: 'vl' }, fetch: async (input, init) => {
      if (++calls <= stopAfter) return fake.fetcher(input, init);
      throw new Error('Disconnected after drawing');
    } });
    assert.equal(result.stop_reason, 'incomplete');
    assert.equal(result.approved, false);
    assert.match(result.error!, /Disconnected after drawing/);
    assert.deepEqual(result.draft.scene, tools.store.get('artboard'));
    assert.equal(result.draft.scene.revision, stopAfter === 1 ? 0 : stopAfter === 5 ? 2 : 1);
  }
});

test('ending without ever creating a canvas produces no final image', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(() => runAgentLoop({ tools: host(), prompt: 'Cave', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async () => Response.json({ id: 'empty', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] }) }));
  assert.equal(events.filter(event => event.type === 'final').length, 0);
});

test('XML embedded in function arguments is rejected with protocol guidance, then native calls recover', async () => {
  const fake = simulatedServer({ approveAll: true }), events: AgentEvent[] = [];
  let first = true;
  const result = await runAgentLoop({ tools: host(), prompt: 'Draw a cave', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
    if (!first) return fake.fetcher(input, init);
    first = false;
    return Response.json({ id: 'xml', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'xml-call', type: 'function', function: { name: 'scene_create', arguments: JSON.stringify({ scene_id: 'artboard</parameter>\\n<parameter=width>640' }) } }] } }] });
  } });
  assert.equal(result.approved, true);
  const rejected = events.find(event => event.type === 'tool' && !event.ok);
  assert.ok(rejected?.type === 'tool');
  assert.match(rejected.message!, /Malformed tool arguments.*XML.*valid JSON/);
  assert.equal(events.filter(event => event.type === 'preview')[0].scene.objects.length, 0);
});

test('loop detector reinjects context after four repeated adapter or SDK failures before canvas creation', async () => {
  for (const sdkError of [false, true]) {
    const fake = simulatedServer({ approveAll: true }), events: AgentEvent[] = [];
    let calls = 0;
    const result = await runAgentLoop({ tools: host(), prompt: "England's flag", config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body)) as ChatRequest;
      if (++calls <= 4) return Response.json({ id: `stuck-${calls}`, object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `stuck-call-${calls}`, type: 'function', function: { name: 'scene_create', arguments: sdkError ? '{' : JSON.stringify({ scene_id: 'artboard</parameter>' }) } }] } }] });
      if (calls === 5) {
        assert.ok((request.messages[0].content as string).startsWith(EDITOR_INSTRUCTIONS));
        assert.equal(request.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0);
        const users = request.messages.filter(message => message.role === 'user');
        assert.equal(users.length, 2);
        const recovery = JSON.parse(users[0].content as string);
        assert.equal(recovery.plugin, 'loop detector');
        assert.equal(recovery.tool_calls.length, 4);
        assert.ok(recovery.tool_calls.every((call: { tool: string; ok: boolean }) => call.tool === 'scene_create' && !call.ok));
        assert.equal(JSON.parse(users[1].content as string).prompt, "England's flag");
      }
      return fake.fetcher(input, init);
    } });
    assert.equal(result.approved, true);
    assert.equal(events.filter(event => event.type === 'loop_detected').length, 1);
    assert.equal(events.filter(event => event.type === 'phase' && event.role === 'editor').length, 1);
    assert.equal(result.reviews.length, 1);
    assert.equal(result.draft.scene.revision, 1);
  }
});

test('recovery preserves successful calls and supplies current scene JSON without injecting images', async () => {
  const fake = simulatedServer({ approveAll: true }), tools = host();
  let calls = 0;
  const result = await runAgentLoop({ tools, prompt: 'Cave', config: { editor_model: 'vl' }, fetch: async (input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    calls++;
    if (calls >= 3 && calls <= 6) return Response.json({ id: `bad-edit-${calls}`, object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `bad-edit-call-${calls}`, type: 'function', function: { name: 'scene_apply', arguments: JSON.stringify({ scene_id: 'artboard', operations: [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: 99 } } }] }) } }] } }] });
    if (calls === 7) {
      const users = request.messages.filter(message => message.role === 'user');
      const recovery = JSON.parse(users[0].content as string);
      assert.deepEqual(recovery.tool_calls.map((call: { ok: boolean }) => call.ok), [true, true, false, false, false, false]);
      const content = users.at(-1)!.content;
      assert.equal(typeof content, 'string');
      const context = JSON.parse(content as string);
      assert.deepEqual(context.current_scene, tools.store.get('artboard'));
      assert.equal(context.current_scene.revision, 1);
      assert.ok(!JSON.stringify(request.messages).includes('data:image/'));
      assert.equal(request.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0);
    }
    return fake.fetcher(input, init);
  } });
  assert.equal(result.approved, true);
  assert.equal(result.draft.scene.revision, 1);
});

test('four failed calls in one model response trigger recovery before its next request', async () => {
  const fake = simulatedServer({ approveAll: true }), events: AgentEvent[] = [];
  let requests = 0;
  const result = await runAgentLoop({ tools: host(), prompt: 'A flag', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
    if (++requests === 1) return Response.json({ id: 'batched-failures', object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: Array.from({ length: 4 }, (_, index) => ({ id: `batched-failure-${index}`, type: 'function', function: { name: 'scene_create', arguments: JSON.stringify({ scene_id: 'artboard</parameter>' }) } })),
    } }] });
    if (requests === 2) {
      const request = JSON.parse(String(init?.body)) as ChatRequest;
      const memory = JSON.parse(request.messages.filter(message => message.role === 'user')[0].content as string);
      assert.equal(memory.tool_calls.length, 4);
      assert.equal(request.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0);
    }
    return fake.fetcher(input, init);
  } });
  assert.equal(result.approved, true);
  const recovery = events.find(event => event.type === 'loop_detected');
  assert.ok(recovery?.type === 'loop_detected' && recovery.detection.calls === 4);
});

test('reviewer recovery preserves preceding verdicts and does not restore failed native calls on a later round', async () => {
  const fake = simulatedServer(), events: AgentEvent[] = [];
  let failures = 0;
  const result = await runAgentLoop({ tools: host(), prompt: 'Cave', config: { editor_model: 'editor-vl', reviewer_model: 'reviewer-vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const content = request.messages.filter(message => message.role === 'user').at(-1)!.content;
    const context = JSON.parse(typeof content === 'string' ? content : content!.find(part => part.type === 'text')!.text!);
    if (request.model === 'reviewer-vl' && context.round === 2 && failures++ < 4) return Response.json({ id: `bad-review-${failures}`, object: 'chat.completion', created: 1, model: 'vl', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `bad-review-call-${failures}`, type: 'function', function: { name: 'submit_review', arguments: JSON.stringify({ revision: 99, approved: true, issues: [] }) } }] } }] });
    if (request.model === 'reviewer-vl' && (context.round === 3 || (context.round === 2 && failures === 5))) {
      assert.equal(request.messages[0].content, REVIEWER_INSTRUCTIONS);
      const previousReviews = request.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === 'submit_review').map(call => JSON.parse(call.function.arguments));
      assert.deepEqual(previousReviews.map(review => review.revision), context.round === 2 ? [1] : [1, 2]);
      assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.includes('"plugin":"loop detector"')));
    }
    return fake.fetcher(input, init);
  } });
  assert.equal(result.approved, true);
  assert.deepEqual(result.reviews.map(review => review.revision), [1, 2, 3]);
  const recovery = events.find(event => event.type === 'loop_detected');
  assert.ok(recovery?.type === 'loop_detected' && recovery.role === 'reviewer' && recovery.round === 2);
});

test('bad edit and stale review become SDK tool feedback and can be corrected', async () => {
  const fake = simulatedServer({ staleReview:true, invalidEdit:true }), events: AgentEvent[] = [];
  const result = await runAgentLoop({ tools:host(), prompt:'Cave', config:{editor_model:'vl'}, fetch:fake.fetcher, onEvent:event=>events.push(event) });
  assert.equal(result.approved,true);
  assert.ok(events.some(e=>e.type==='tool' && e.name==='scene_apply' && !e.ok));
  assert.ok(events.some(e=>e.type==='tool' && e.name==='submit_review' && !e.ok));
  for (const event of events.filter(e => e.type === 'tool')) {
    if (event.ok) continue;
    const next = events[events.indexOf(event) + 1];
    assert.ok(next.type === 'preview' && next.source === event.name);
  }
  assert.equal(result.draft.scene.revision,3);
});
test('review approval stops immediately without extra model calls, including the tenth draft', async () => {
  for (const approveAt of [1, 2, 3, 10]) {
    const fake = simulatedServer({approveAt}), events: AgentEvent[] = [];
    const result = await runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'vl',max_reviews:10},fetch:fake.fetcher,onEvent:event=>events.push(event)});
    assert.equal(result.approved,true); assert.equal(result.stop_reason,'approved');
    assert.equal(result.reviews.length,approveAt); assert.equal(result.drafts.length,approveAt);
    assert.equal(fake.requests.length,approveAt * 3 + 1);
    assert.deepEqual(events.filter(e=>e.type==='phase').map(e=>e.round), Array.from({length:approveAt}, (_,i)=>[i+1,i+1]).flat());
    assert.equal(events.filter(e=>e.type==='final').length,1);
    assert.equal(events.at(-1)!.type,'final');
    assert.ok(result.reviews.slice(0,-1).every(review=>!review.approved));
  }
});

test('the review ceiling delivers the latest drawing with unresolved feedback and no extra review', async () => {
  for (const max_reviews of [1, 3, 10]) {
    const fake = simulatedServer({rejectFinal:true}), events:AgentEvent[]=[];
    const result = await runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'vl',max_reviews},fetch:fake.fetcher,onEvent:event=>events.push(event)});
    assert.equal(result.approved,false); assert.equal(result.stop_reason,'review_limit');
    assert.equal(result.reviews.length,max_reviews); assert.equal(result.reviews.at(-1)!.issues.length,1);
    assert.equal(fake.requests.length,max_reviews * 3 + 1);
    assert.equal(events.filter(e=>e.type==='final').length,1); assert.equal(events.at(-1)!.type,'final');
    const final = events.at(-1)!;
    assert.ok(final.type === 'final');
    assert.deepEqual(final.result.draft, result.drafts.at(-1));
  }
});
test('auto model discovery uses only configured API and optional key, never a cloud default', async () => {
  const fake = simulatedServer();
  const models = await listModels({base_url:'http://models.test:1234',api_key:'test-key'},async(input,init)=>{assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-key');return fake.fetcher(input,init);});
  assert.deepEqual(models,['local-vision']);
  const result = await runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:''},fetch:fake.fetcher});
  assert.equal(result.models.editor,'local-vision'); assert.equal(result.models.reviewer,'local-vision');
  assert.equal(fake.urls.filter(url=>url.endsWith('/models')).length,2);
  assert.equal(await listModels({base_url:'http://models.test/v1'},async()=>Response.json({data:[{id:'embeddings'}]})).catch(e=>e.message), 'No chat models available. Load a tool-calling, vision-capable model in your server.');
});
test('vision incompatibility preserves the generated drawing and reports the failure without a text-only retry', async () => {
  const fake=simulatedServer({failReview:true}),events:AgentEvent[]=[];
  const result = await runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'vl'},fetch:fake.fetcher,onEvent:event=>events.push(event)});
  assert.equal(result.stop_reason, 'incomplete');
  assert.equal(result.approved, false);
  assert.match(result.error!, /image inputs/);
  assert.equal(result.draft.scene.revision, 1);
  assert.equal(events.filter(e=>e.type==='final').length,1);
  assert.equal(fake.requests.filter(r=>r.tools.some(t=>t.function.name==='submit_review')).length,1);
});

test('HTTP failures expose server details for string, object, and plain-text error bodies', async () => {
  const message = "Invalid tool_choice type: 'object'. Supported string values: none, auto, required";
  for (const response of [
    Response.json({ error: message }, { status: 400, statusText: 'Bad Request' }),
    Response.json({ error: { message } }, { status: 400, statusText: 'Bad Request' }),
    new Response(message, { status: 400, statusText: 'Bad Request' }),
  ]) {
    const events: AgentEvent[] = []; let calls = 0;
    await assert.rejects(() => runAgentLoop({ tools: host(), prompt: 'Draw a background', config: { editor_model: 'vl' },
      fetch: async (_input, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).tool_choice, 'required'); return response; },
      onEvent: event => events.push(event),
    }), /HTTP 400.*Editor.*Invalid tool_choice/);
    assert.equal(calls, 1);
    const failure = events.find(event => event.type === 'response');
    assert.ok(failure?.type === 'response' && failure.status === 400 && failure.error === message);
    assert.equal(events.filter(event => event.type === 'final').length, 0);
  }
});
test('explicit JSON-only mode omits image inputs', async () => {
  const fake=simulatedServer();
  const result=await runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'text',vision:false},fetch:fake.fetcher});
  assert.ok(result.approved);
  assert.ok(fake.requests.every(r=>r.messages.every(m=>!Array.isArray(m.content) || !m.content.some(p=>p.type==='image_url'))));
  assert.ok(fake.requests.every(request => !request.tools.some(tool => tool.function.name === 'scene_render')));
});
test('cancellation prevents final delivery, including agents that keep calling tools; occupied draft hosts are rejected', async () => {
  const controller=new AbortController(),fake=simulatedServer(),events:AgentEvent[]=[];
  await assert.rejects(()=>runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'vl'},fetch:fake.fetcher,signal:controller.signal,onEvent:event=>{events.push(event);if(event.type==='draft')controller.abort();}}),/abort/i);
  assert.equal(events.filter(e=>e.type==='final').length,0);
  const endless=simulatedServer({neverFinish:true});
  const cancel = new AbortController();
  await assert.rejects(()=>runAgentLoop({tools:host(),prompt:'Cave',config:{editor_model:'vl'},fetch:endless.fetcher,signal:cancel.signal,onEvent:event=>{if(event.type==='model' && event.state==='response' && event.step===4) cancel.abort();}}),/abort/i);
  assert.equal(endless.requests.length,4);
  const occupied=host();occupied.store.create({scene_id:'artboard'});
  await assert.rejects(()=>runAgentLoop({tools:occupied,prompt:'Cave'}),/fresh draft/);
});

test('misplaced object colors return actionable feedback and recover before draft submission', async () => {
  const fake = simulatedServer({ approveAll: true }), tools = host(), events: AgentEvent[] = [];
  let calls = 0, correct: unknown;
  const result = await runAgentLoop({ tools, prompt: 'Paint the background', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async (input, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 3) {
      assert.match(request.messages.filter((message: { role: string }) => message.role === 'tool').at(-1).content, /belongs inside operations\/0\/object\/color/);
      assert.equal(tools.store.get('artboard').objects.length, 0);
      return Response.json(correct);
    }
    const response = await fake.fetcher(input, init);
    if (calls !== 2) return response;
    const operations = request.tools[0].function.parameters.properties.operations;
    assert.equal(operations.items.oneOf[0].properties.object.properties.color.type, 'integer');
    assert.equal(operations.items.oneOf[0].additionalProperties, false);
    correct = await response.json();
    const damaged = structuredClone(correct) as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] };
    const tool = damaged.choices[0].message.tool_calls[0].function;
    const args = JSON.parse(tool.arguments);
    args.operations[0].color = args.operations[0].object.color;
    delete args.operations[0].object.color;
    tool.arguments = JSON.stringify(args);
    return Response.json(damaged);
  } });
  assert.ok(result.approved);
  const rejected = events.find(event => event.type === 'tool' && !event.ok);
  assert.ok(rejected?.type === 'tool' && rejected.message?.includes('object/color'));
  assert.ok(events.some(event => event.type === 'preview' && event.source === 'scene_apply' && event.changed_pixels > 0));
});

test('connection failures emit a transport error instead of disappearing from the run log', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(() => runAgentLoop({ tools: host(), prompt: 'Background', config: { editor_model: 'vl' }, onEvent: event => events.push(event), fetch: async () => { throw new Error('Failed to fetch'); } }), /Failed to fetch/);
  assert.ok(events.some(event => event.type === 'transport_error' && event.message === 'Failed to fetch' && event.role === 'editor'));
});

test('successful model requests reset the timeout instead of exhausting a shared phase budget', async () => {
  const fake = simulatedServer({ approveAll: true });
  const started = Date.now();
  const result = await runAgentLoop({ tools: host(), prompt: 'Background', config: { editor_model: 'vl', timeout_ms: 1000 }, fetch: async (input, init) => {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    init?.signal?.throwIfAborted();
    return fake.fetcher(input, init);
  } });
  assert.ok(result.approved);
  assert.ok(Date.now() - started > 1000);
});

test('a model request that exceeds its own budget reports the request and duration', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(() => runAgentLoop({ tools: host(), prompt: 'Background', config: { editor_model: 'vl', timeout_ms: 1000 }, onEvent: event => events.push(event), fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }) }), /Editor.*request 1.*timed out after 1 seconds/);
  assert.ok(events.some(event => event.type === 'transport_error' && event.message.includes('request 1')));
});

test('editor receives missing-background advice in actual tool messages; dark painted backgrounds count as covered', async () => {
  const fake = simulatedServer({ approveAll: true });
  await runAgentLoop({ tools: host(), prompt: 'Background and gate', config: { editor_model: 'vl' }, fetch: fake.fetcher });
  const creation = JSON.parse(fake.requests[1].messages.filter(message => message.role === 'tool').at(-1)!.content as string);
  assert.equal(creation.result.feedback.unpainted_pixels, 640 * 480);
  assert.match(creation.result.feedback.instructions.join(' '), /Fill the missing background/);
  const painted = JSON.parse(fake.requests[2].messages.filter(message => message.role === 'tool').at(-1)!.content as string);
  assert.equal(painted.result.feedback.unpainted_pixels, 0);
  const tools = host();
  tools.store.create({ scene_id: 'dark' });
  tools.store.apply('dark', [{ op: 'add', object: { id: 'black_background', kind: 'polygon', points: [[0,0],[640,0],[640,480],[0,480]], layer: -100, color: 0 } }]);
  assert.equal(drawingFeedback(tools, tools.store.get('dark'), 0, ['black_background']).unpainted_pixels, 0);
});

test('hidden edits advise inspection and layer/geometry/color corrections without approving the scene', () => {
  const tools = host();
  tools.store.create({ scene_id: 'covered' });
  tools.store.apply('covered', [
    { op: 'add', object: { id: 'background', kind: 'polygon', points: [[0,0],[640,0],[640,480],[0,480]], layer: 0, color: 12 } },
    { op: 'add', object: { id: 'hidden', kind: 'ellipse', bounds: [50,50,100,100], layer: -1, color: 10 } },
  ]);
  const feedback = drawingFeedback(tools, tools.store.get('covered'), 0, ['hidden']);
  assert.equal(feedback.unpainted_pixels, 0);
  assert.match(feedback.instructions.join(' '), /changed no visible pixels/);
  assert.ok(feedback.suggested_actions.some(action => action.tool === 'scene_inspect'));
  assert.ok(feedback.suggested_actions.some(action => /reorder/.test(action.purpose)));
  assert.ok(feedback.suggested_actions.some(action => /palette color/.test(action.purpose)));
});
