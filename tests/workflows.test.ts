import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { runWorkflow, type WorkflowEvent } from '../src/workflows/run';
import { AGENT_ROLES, getWorkflow, describeLayerAlgorithm } from '../src/contracts/workflows';
import { mockModel, requestContext } from './fixtures/model';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const createTools = () => new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());
const profiles = Object.fromEntries(AGENT_ROLES.map(role => [role, { model: `${role}-model` }]));

for (let layers = 1; layers <= 6; layers++) test(`${layers} layers preserve handoffs and review only with the final artist`, async () => {
  const fake = mockModel(), events: WorkflowEvent[] = [];
  const result = await runWorkflow({ layers, prompt: 'Scene [reject]', createTools, fetch: fake.fetcher,
    config: { agents: profiles }, onEvent: event => { events.push(event); },
  });
  const workflow = getWorkflow(layers);
  assert.equal(result.result.approved, true);
  assert.equal(result.stages.length, layers);
  assert.equal(result.result.reviews.length, 2);
  assert.ok(result.stages.slice(0, -1).every(item => item.result.stop_reason === 'completed' && !item.result.reviews.length));
  assert.equal(result.result.draft.scene.objects.length, layers + 1);
  const finalRole = workflow.stages.at(-1)!.role;
  const correctionRequests = fake.requests.filter(item => requestContext(item).round === 2 && item.model !== 'reviewer-model');
  assert.ok(correctionRequests.length > 0);
  assert.ok(correctionRequests.every(item => item.model === `${finalRole}-model`));
  for (let index = 0; index < layers; index++) {
    const first = fake.requests.find(item => item.model === `${workflow.stages[index].role}-model`)!;
    const context = requestContext(first);
    assert.equal(context.prompt, 'Scene [reject]');
    assert.equal(context.workflow!.history.length, index);
    if (index) {
      assert.ok(context.current_scene!.objects.length >= index);
      assert.ok(Array.isArray(first.messages.find(item => item.role === 'user')!.content));
      assert.deepEqual(context.workflow!.previous, context.workflow!.history.at(-1));
    }
  }
  assert.equal(events.filter(item => item.type === 'stage').length, layers);
});

test('undefined counts and invalid prompts make no model requests', async () => {
  const fake = mockModel();
  for (const layers of [0, 7, 8, 9, 1.5, NaN]) {
    assert.match(describeLayerAlgorithm(layers), /Not defined/);
    await assert.rejects(runWorkflow({ layers, prompt: 'Scene', createTools, fetch: fake.fetcher }), /1 to 6/);
  }
  await assert.rejects(runWorkflow({ layers: 1, prompt: ' ', createTools, fetch: fake.fetcher }), /prompt/);
  assert.equal(fake.requests.length, 0);
});

test('missing handoff fields are tool errors and recover without advancing the stage', async () => {
  const fake = mockModel(), events: WorkflowEvent[] = [];
  const result = await runWorkflow({ layers: 2, prompt: 'Scene [invalid-handoff]', createTools, fetch: fake.fetcher,
    config: { agents: profiles }, onEvent: event => { events.push(event); },
  });
  assert.equal(result.result.approved, true);
  assert.equal(events.filter(item => item.type === 'agent' && item.event.type === 'tool' && !item.event.ok).length, 2);
  assert.ok(result.stages.every(item => item.result.handoff));
});

test('optional stages can hand off unchanged scenes; review limits preserve the latest drawing', async () => {
  const fake = mockModel();
  const result = await runWorkflow({ layers: 6, prompt: 'Scene [noop] [limit]', createTools, fetch: fake.fetcher,
    config: { agents: profiles, connection: { max_reviews: 2, vision: false } },
  });
  assert.equal(result.result.stop_reason, 'review_limit');
  assert.equal(result.result.approved, false);
  assert.equal(result.result.reviews.length, 2);
  assert.equal(result.stages[3].result.draft.scene.revision, result.stages[2].result.draft.scene.revision);
  assert.equal(result.stages[4].result.draft.scene.revision, result.stages[3].result.draft.scene.revision);
  assert.equal(result.result.draft.scene.objects.length, 5);
});

test('failure preserves the preceding drawing and stops all later stages', async () => {
  const fake = mockModel();
  const result = await runWorkflow({ layers: 4, prompt: 'Scene [fail-after-background]', createTools, fetch: fake.fetcher, config: { agents: profiles } });
  assert.equal(result.stages.length, 2);
  assert.equal(result.result.stop_reason, 'incomplete');
  assert.equal(result.result.draft.scene.objects.length, 1);
  assert.match(result.result.error!, /Simulated model failure/);
});

test('cancelling after a stage prevents later agents and final delivery', async () => {
  const controller = new AbortController(), fake = mockModel();
  await assert.rejects(runWorkflow({ layers: 3, prompt: 'Scene', createTools, fetch: fake.fetcher, config: { agents: profiles }, signal: controller.signal,
    onEvent: event => { if (event.type === 'agent' && event.event.type === 'final') controller.abort(); },
  }), /abort/i);
  assert.ok(fake.requests.every(item => item.model === 'background-model'));
});

test('a reviewer cannot approve requirements still reported as pending by the final artist', async () => {
  const fake = mockModel(), events: WorkflowEvent[] = [];
  const result = await runWorkflow({ layers: 2, prompt: 'Scene [pending]', createTools, fetch: fake.fetcher,
    config: { agents: profiles }, onEvent: event => { events.push(event); },
  });
  assert.equal(result.result.approved, true);
  assert.equal(result.result.reviews.length, 2);
  assert.equal(result.result.reviews[0].approved, false);
  assert.deepEqual(result.result.handoff!.not_done, []);
  assert.ok(events.some(item => item.type === 'agent' && item.event.type === 'tool' && item.event.name === 'submit_review' && !item.event.ok));
});

test('model thinking is forwarded from reasoning fields and inline think tags', async () => {
  for (const format of ['reasoning_content', 'reasoning', 'tags']) {
    const fake = mockModel(), thoughts: string[] = [];
    const result = await runWorkflow({ layers: 1, prompt: 'Scene', createTools, config: { agents: profiles },
      fetch: async (input, init) => {
        const response = await fake.fetcher(input, init);
        const body = await response.json();
        const message = body.choices[0].message;
        if (format === 'tags') message.content = '<think>Draw the assigned scene.</think>';
        else message[format] = 'Draw the assigned scene.';
        return Response.json(body);
      },
      onEvent: item => { if (item.type === 'agent' && item.event.type === 'thinking') thoughts.push(item.event.text); },
    });
    assert.equal(result.result.approved, true);
    assert.ok(thoughts.length > 0);
    assert.ok(thoughts.every(text => text === 'Draw the assigned scene.'));
  }
});
