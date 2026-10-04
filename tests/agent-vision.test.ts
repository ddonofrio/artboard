import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { runWorkflow, type WorkflowEvent } from '../src/workflows/run';
import { mockModel, requestContext, type ChatRequest } from './fixtures/model';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const createTools = () => new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());

for (const layers of [2, 4]) {
  test(`reviewers receive each draft automatically and later looks remain on demand across ${layers} creation layers`, async () => {
    const fake = mockModel(), events: WorkflowEvent[] = [];
    const looks = new Map<string, number>();
    let requests = 0, imagesSeen = 0;
    const result = await runWorkflow({ layers, prompt: 'A scene [reject]', createTools,
      config: { connection: { editor_model: 'test-model' } }, onEvent: event => { events.push(event); },
      fetch: async (input, init) => {
        requests++;
        const request = JSON.parse(String(init?.body)) as ChatRequest;
        const context = requestContext(request);
        const reviewer = request.tools.some(tool => tool.function.name === 'submit_review');
        const scene = context.current_scene ?? context.draft?.scene;
        const key = `${reviewer ? 'reviewer' : context.workflow!.stage_index}:${context.round}`;
        const look = looks.get(key) ?? 0;
        const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
        assert.equal(images.length, look === 2 || (reviewer && look === 0) ? 1 : 0, `request ${requests}: reviewers get their draft initially and other images require a successful render`);
        if (images.length) {
          imagesSeen++;
          const expected = new PixelRenderer().render(scene!, look === 2 ? { crop: [0, 0, 8, 6], scale: 2 } : {});
          assert.equal(images[0].image_url!.url, `data:image/jpeg;base64,${encodeJPEG(expected).toString('base64')}`);
          if (look === 2) {
            const lastTool = request.messages.filter(message => message.role === 'tool').at(-1)!;
            const toolText = lastTool.content;
            assert.ok(typeof toolText === 'string');
            assert.ok(!toolText.includes('data:image/'), 'Image bytes never enter tool-result prose');
            assert.match(toolText, /Requested image supplied once/);
          }
        }
        const role = context.workflow?.role ?? 'artist';
        const completed = reviewer || scene?.objects.some(object => object.id === `${role}_${context.round}`);
        if (!completed || look >= 3) return fake.fetcher(input, init);
        looks.set(key, look + 1);
        // A failed render must not attach a fallback full-scene image.
        const name = look < 2 ? 'scene_render' : 'scene_inspect';
        const args = look < 2 ? { scene_id: context.scene_id, crop: [0, 0, 8, 6], scale: look === 0 ? 0 : 2 } : { scene_id: context.scene_id };
        return Response.json({ id: `look-${requests}`, object: 'chat.completion', created: 1, model: request.model,
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: `look-call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          } }], usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        });
      },
    });
    assert.equal(result.result.approved, true);
    assert.equal(result.result.reviews.length, 2);
    assert.equal(imagesSeen, layers + 4, 'Two automatic review drafts plus the explicit looks from each phase');
    assert.ok(events.some(item => item.type === 'agent' && item.event.type === 'tool' && item.event.name === 'scene_render' && !item.event.ok));
    const prompts = events.flatMap(item => item.type === 'agent' && item.event.type === 'prompt' ? [item.event.content] : []);
    assert.ok(prompts.some(prompt => prompt.includes('binary omitted')));
    assert.ok(prompts.every(prompt => !prompt.includes('data:image/')));
  });
}

test('editing an existing scene starts without an image and JSON-only agents have no vision tool', async () => {
  const base = createTools();
  base.store.create({ scene_id: 'base', width: 64, height: 48 });
  base.store.apply('base', [{ op: 'add', object: { id: 'base_background', kind: 'polygon', layer: -100, color: 1, points: [[0, 0], [64, 0], [64, 48], [0, 48]] } }]);
  for (const vision of [true, false]) {
    const fake = mockModel();
    const result = await runWorkflow({ layers: 2, prompt: 'Edit the scene', initial_scene: base.store.get('base'), createTools,
      config: { connection: { editor_model: 'test-model', vision } }, fetch: fake.fetcher,
    });
    assert.equal(result.result.approved, true);
    for (const request of fake.requests) {
      const reviewer = request.tools.some(tool => tool.function.name === 'submit_review');
      assert.equal(JSON.stringify(request.messages).includes('data:image/'), vision && reviewer);
      assert.equal(request.tools.some(tool => tool.function.name === 'scene_render'), vision);
    }
  }
});

test('an upstream rejection of the automatic reviewer image preserves the draft without retrying or disabling vision', async () => {
  const fake = mockModel();
  let reviewerRequests = 0;
  const result = await runWorkflow({ layers: 2, prompt: 'A scene', createTools,
    config: { connection: { editor_model: 'test-model' } }, fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body)) as ChatRequest;
      if (!request.tools.some(tool => tool.function.name === 'submit_review')) return fake.fetcher(input, init);
      reviewerRequests++;
      assert.ok(JSON.stringify(request.messages).includes('data:image/jpeg;base64,'));
      return Response.json({ error: { message: 'Model does not support image inputs' } }, { status: 400 });
    },
  });
  assert.equal(reviewerRequests, 1);
  assert.equal(result.result.stop_reason, 'incomplete');
  assert.equal(result.result.approved, false);
  assert.match(result.result.error!, /image inputs/);
  assert.equal(result.result.draft.scene.objects.length, 1);
  assert.equal(result.result.draft.scene.revision, 1);
});
