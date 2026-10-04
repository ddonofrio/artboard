import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { runWorkflow, type WorkflowEvent } from '../src/workflows/run';
import { mockModel } from './fixtures/model';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
test('agent states describe an outstanding model request and tool execution before scene mutations', { timeout: 10000 }, async () => {
  const fake = mockModel(), events: WorkflowEvent[] = [];
  const host = new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  let first = true;
  const beforeTools: { name: string; objects: number | undefined }[] = [];
  const running = runWorkflow({ prompt: 'Scene', layers: 2, createTools: () => host, config: { connection: { editor_model: 'test-model' } },
    fetch: async (input, init) => { if (first) { first = false; requested(); await gate; } return fake.fetcher(input, init); },
    onEvent: item => {
      events.push(item);
      if (item.type === 'agent' && item.event.type === 'state' && item.event.state === 'executing_tool') {
        let objects: number | undefined;
        try { objects = host.store.get('artboard').objects.length; } catch { /* Creation has not executed yet. */ }
        beforeTools.push({ name: item.event.tool!, objects });
      }
    },
  });
  await started;
  const states = () => events.flatMap(item => item.type === 'agent' && item.event.type === 'state' ? [item.event] : []);
  try {
    assert.equal(states().at(-1)?.state, 'processing_prompt');
    assert.equal(states()[0].state, 'processing_prompt');
    assert.ok(!states().some(event => event.state === 'writing_tool_args' || event.state === 'executing_tool'));
  } finally { release(); }
  const result = await running;
  assert.equal(result.result.approved, true);
  assert.equal(states().at(-1)?.state, 'idle');
  assert.ok(states().some(event => event.state === 'writing_tool_args'));
  assert.deepEqual(beforeTools.slice(0, 1), [{ name: 'scene_apply', objects: 0 }]);
  assert.ok(states().some(event => event.role === 'reviewer' && event.state === 'executing_tool' && event.tool === 'submit_review'));
});
