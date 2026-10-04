import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASIC_PALETTE, COLOR_NAMES, PixelRenderer, SceneStore, SceneTools, palettes } from '../src/core/index';
import { runAgentLoop } from '../src/agents/loop';
import { agentTools } from '../src/agents/tools';

const host = () => new SceneTools(new SceneStore(), new PixelRenderer(), {
  preview: async () => 'memory', exportPNG: async () => 'memory', saveJSON: async () => 'memory', loadJSON: async () => undefined,
});

test('one fixed palette supplies white and red; alternate and custom palettes are rejected', () => {
  assert.deepEqual(Object.keys(palettes), ['basic']);
  const store = new SceneStore();
  assert.deepEqual(store.create({ scene_id: 'drawing' }).palette, BASIC_PALETTE);
  assert.throws(() => store.create({ scene_id: 'alternative', palette: 'daylight' }), /Unknown palette/);
  assert.throws(() => store.palette('drawing', { id: 'custom', name: 'Custom', colors: ['#123456'] }));
  assert.deepEqual(store.get('drawing').palette, BASIC_PALETTE);
});

test('actual SDK requests and tool replies use English color names through drawing, inspection and review', async () => {
  const tools = host();
  let step = 0, reviewed = false;
  const commands = [
    ['scene_catalog', { category: 'palettes' }],
    ['scene_catalog', { category: 'materials', id: 'wood' }],
    ['scene_catalog', { category: 'objects', id: 'gate' }],
    ['scene_catalog', { category: 'tools' }],
    ['scene_apply', { scene_id: 'artboard', operations: [
      { op: 'add', object: { id: 'flag', kind: 'rect', rect: [0, 0, 640, 480], color: 'white' } },
      { op: 'add', object: { id: 'disc', kind: 'circle', center: [320, 240], radius: 100, color: 'dark red', outline: 'dark red', layer: 1 } },
      { op: 'add', object: { id: 'gate', kind: 'procedural', generator: 'gate', bounds: [0, 0, 20, 20], layer: 2, params: { metal_color: 'dark gray', highlight_color: 'light gray' }, material: { id: 'metal', params: { foreground: 'light gray', background: 'dark gray' } } } },
    ] }],
    ['scene_inspect', { scene_id: 'artboard', ids: ['disc', 'gate'] }],
    ['scene_apply', { scene_id: 'artboard', operations: [{ op: 'update', id: 'disc', changes: { color: 'red', outline: 'red' } }] }],
    ['finish_draft', { revision: 2 }],
  ] as const;
  const result = await runAgentLoop({ tools, prompt: "Japan's flag", config: { editor_model: 'test-model', vision: false }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.doesNotMatch(String(init?.body), /#[0-9a-f]{3,8}\b|daylight|warm_interior|#RRGGBB/i);
    assert.ok(!request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'scene_io'));
    const reviewer = request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'submit_review');
    if (!reviewer) {
      const drawing = request.tools.find((tool: { function: { name: string } }) => tool.function.name === 'scene_apply').function.parameters.properties.operations.items.oneOf[0].properties.object;
      assert.deepEqual(drawing.properties.color.enum, COLOR_NAMES);
      const users = request.messages.filter((message: { role: string }) => message.role === 'user');
      assert.deepEqual(JSON.parse(users.at(-1).content).current_scene.palette.colors, COLOR_NAMES);
      if (step === 1) assert.deepEqual(JSON.parse(request.messages.filter((message: { role: string }) => message.role === 'tool').at(-1).content).result.colors, COLOR_NAMES);
      if (step === 6) {
        const objects = JSON.parse(request.messages.filter((message: { role: string }) => message.role === 'tool').at(-1).content).result.objects;
        assert.equal(objects[0].color, 'dark red');
        assert.equal(objects[1].params.metal_color, 'dark gray');
        assert.equal(objects[1].material.params.foreground, 'light gray');
      }
    } else reviewed = true;
    const [name, args] = reviewer ? ['submit_review', { revision: 2, approved: true, issues: [] }] : commands[step++];
    return Response.json({ id: `named-${step}`, object: 'chat.completion', created: 1, model: request.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `named-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  } });
  assert.equal(result.approved, true, result.error);
  assert.equal(reviewed, true);
  assert.equal(result.draft.scene.objects[0].color, 15);
  assert.equal(result.draft.scene.objects[1].color, 12);
  const pixels = tools.renderer.render(result.draft.scene);
  const rgb = (x: number, y: number) => [...pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 3)];
  assert.deepEqual(rgb(50, 50), [255, 255, 255]);
  assert.deepEqual(rgb(320, 240), [255, 85, 85]);
});

test('unknown names and hex colors reject the entire drawing batch with color guidance', async () => {
  const tools = host(); tools.store.create({ scene_id: 'drawing' });
  const apply = agentTools(tools, 'drawing', 'editor', undefined, () => {}, () => {}, () => {}).scene_apply;
  for (const color of ['orange', '#FF0000']) {
    const result = await apply.execute!({ scene_id: 'drawing', operations: [
      { op: 'add', object: { id: 'valid', kind: 'circle', center: [20, 20], radius: 10, color: 'red' } },
      { op: 'add', object: { id: 'invalid', kind: 'circle', center: [40, 40], radius: 10, color } },
    ] }, { toolCallId: 'invalid', messages: [], context: undefined }) as { ok: boolean; error: { message: string } };
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Colors: black.*red.*white/);
    assert.equal(tools.store.get('drawing').revision, 0);
    assert.equal(tools.store.get('drawing').objects.length, 0);
  }
});
