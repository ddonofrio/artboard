import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneStore, PixelRenderer, SceneTools, type ToolAdapter } from '../src/core/index.js';
import { runDrawingScript } from '../scripts/drawing-script-host.js';

function createHost() {
  const adapter: ToolAdapter = {
    preview: async () => 'preview.png', exportPNG: async () => 'drawing.png',
    saveJSON: async () => 'drawing.json', loadJSON: async () => { throw new Error('Not available'); },
  };
  return new SceneTools(new SceneStore(), new PixelRenderer(), adapter);
}

test('scripts compose named agent primitives, inspect, undo and export through existing tools', async () => {
  const host = createHost();
  const calls: string[] = [];
  const result = await runDrawingScript(async tools => {
    await tools.scene_create({ scene_id: 'drawing', width: 64, height: 64 });
    const operations = Array.from({ length: 3 }, (_, i) => ({ op: 'add', object: { id: `bar${i}`, kind: 'rect', rect: [i * 10, 0, 8, 64], color: 'dark cyan' } }));
    await tools.scene_apply({ scene_id: 'drawing', operations });
    const inspected = await tools.scene_inspect({ scene_id: 'drawing', ids: ['bar0'] });
    assert.equal((inspected.objects as { color: string }[])[0].color, 'dark cyan');
    await tools.scene_history({ scene_id: 'drawing', action: 'undo' });
    assert.equal(host.store.get('drawing').objects.length, 0);
    await tools.scene_history({ scene_id: 'drawing', action: 'redo' });
    return tools.scene_io({ scene_id: 'drawing', action: 'export', filename: 'drawing.png' });
  }, host, [], call => { calls.push(call.tool); });
  assert.equal((result as { file_ref: string }).file_ref, 'drawing.png');
  assert.equal(calls.length, 6);
  const image = host.renderer.render(host.store.get('drawing'));
  assert.deepEqual([...image.data.slice(0, 4)], [0, 170, 170, 255]);
});

test('queued script calls stop after failure and preserve the last successful scene', async () => {
  const host = createHost();
  await assert.rejects(runDrawingScript(tools => {
    void tools.scene_create({ scene_id: 'drawing' });
    void tools.scene_apply({ scene_id: 'drawing', operations: [{ op: 'add', object: { id: 'bad', kind: 'rect', rect: [0, 0, 10, 10], color: 'orange' } }] });
    void tools.scene_apply({ scene_id: 'drawing', operations: [{ op: 'add', object: { id: 'later', kind: 'circle', center: [20, 20], radius: 5, color: 'red' } }] });
  }, host), /scene_apply.*color/);
  assert.equal(host.store.get('drawing').revision, 0);
  assert.equal(host.store.get('drawing').objects.length, 0);
});
