import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentLoop, type AgentEvent } from '../src/agents/loop';
import { runWorkflow } from '../src/workflows/run';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { requestContext, sceneFromModel, type ChatRequest } from './fixtures/model';
import { namedColors } from '../src/agents/colors';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const createTools = () => new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());

function drawingBlocks(batchSize: number) {
  const steps = new Map<string, number>(), calls = new Map<string, string[]>();
  let requestNumber = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const context = requestContext(request);
    const scene = context.current_scene ?? context.draft?.scene;
    const reviewer = request.tools.some(tool => tool.function.name === 'submit_review');
    const key = `${context.workflow?.role ?? 'artist'}_${context.round}`;
    const step = steps.get(key) ?? 0;
    const images = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    assert.equal(images.length, reviewer || step === 3 || step === 6 ? 1 : 0, 'Only completed blocks reach visual inspection');
    if (images.length) assert.equal(images[0].image_url!.url, `data:image/jpeg;base64,${encodeJPEG(new PixelRenderer().render(sceneFromModel(scene!))).toString('base64')}`);
    let name: string, args: Record<string, unknown>;
    if (reviewer) {
      name = 'submit_review'; args = { revision: scene!.revision, approved: context.round === 2,
        issues: context.round === 2 ? [] : [{ object_id: 'scene', instruction: 'Add the missing requested foreground block.' }],
      };
    } else if (!scene) {
      name = 'scene_create'; args = { scene_id: context.scene_id, width: 64, height: 48 };
    } else {
      steps.set(key, step + 1);
      const baseId = `${key}_base`, subjectId = `${key}_subject`;
      if (step === 0 || step === 1) {
        name = 'scene_apply'; args = { scene_id: context.scene_id, operations: [{ op: 'add', object: {
          id: step === 0 ? baseId : subjectId, kind: 'polygon', layer: step === 0 ? -100 : 10,
          color: step === 0 ? 1 : 2,
          points: step === 0 ? [[0, 0], [64, 0], [64, 48], [0, 48]] : [[8, 8], [24, 8], [24, 24], [8, 24]],
        } }] };
        if (step === 0) (args.operations as unknown[]).push(...Array.from({ length: batchSize - 1 }, (_, index) => ({
          op: 'add', object: { id: `${key}_detail_${index}`, kind: 'ellipse', layer: 5, color: 6,
            bounds: [index % 48, 8 + index % 24, 4, 4],
          },
        })));
      } else if (step === 2 || step === 5) {
        name = 'scene_render'; args = { scene_id: context.scene_id };
      } else if (step === 3 || step === 4) {
        name = 'scene_apply'; args = { scene_id: context.scene_id, operations: [{ op: 'update', id: step === 3 ? baseId : subjectId,
          changes: { color: step === 3 ? 3 : 4 },
        }] };
      } else {
        assert.equal(step, 6);
        name = 'finish_draft'; args = { revision: scene.revision, ...(context.workflow ? {
          done: ['Completed the drawing and checked both the initial and corrected blocks'], not_done: [],
        } : {}) };
      }
      calls.set(key, [...calls.get(key) ?? [], name]);
    }
    assert.ok(request.tools.some(tool => tool.function.name === name), `${name} must be available`);
    requestNumber++;
    return Response.json({ id: `block-${requestNumber}`, object: 'chat.completion', created: 1, model: request.model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: `block-call-${requestNumber}`, type: 'function', function: { name, arguments: JSON.stringify(namedColors(args)) } }],
      } }],
    });
  };
  return { fetcher, calls };
}

for (const [layers, batchSize] of [[0, 128], [2, 9], [4, 16], [7, 32]]) test(`${layers || 'standalone'} drawing agents execute ${batchSize}-operation blocks before looking and handing off`, async () => {
  const fake = drawingBlocks(batchSize), events: AgentEvent[] = [];
  const onEvent = (event: AgentEvent) => { events.push(event); };
  const result = layers ? (await runWorkflow({ prompt: 'A complete scene', layers, createTools,
    config: { connection: { editor_model: 'test-model' } }, fetch: fake.fetcher,
    onEvent: item => { if (item.type === 'agent') onEvent(item.event); },
  })).result : await runAgentLoop({ prompt: 'A complete scene', tools: createTools(), config: { editor_model: 'test-model' }, fetch: fake.fetcher, onEvent });
  assert.equal(result.approved, true, result.error);
  assert.equal(result.reviews.length, 2);
  assert.equal(fake.calls.size, (layers ? layers - 1 : 1) + 1, 'Only the final artist repeats after rejection');
  for (const calls of fake.calls.values()) assert.deepEqual(calls, [
    'scene_apply', 'scene_apply', 'scene_render', 'scene_apply', 'scene_apply', 'scene_render', 'finish_draft',
  ]);
  const completeBlocks = events.filter(event => event.type === 'tool' && event.name === 'scene_apply' && Array.isArray(event.input.operations) && event.input.operations.length === batchSize);
  assert.equal(completeBlocks.length, (layers ? layers - 1 : 1) + 1, 'Every creation and correction pass commits its large block atomically');
  assert.ok(events.filter(event => event.type === 'tool').every(event => event.ok), 'No forced inspection or submission rejection interrupts a completed block');
});
