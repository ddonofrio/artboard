import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandGenerator, PixelRenderer, quadMapping, recipes, RENDERER_VERSION, SceneStore, SceneTools, type Operation, type PixelImage, type Scene, type ToolAdapter } from '../src/core/index';

class MemoryAdapter implements ToolAdapter {
  files = new Map<string, Scene>();
  async preview(image: PixelImage, name: string) { return `${name}:${image.width}x${image.height}`; }
  async exportPNG(image: PixelImage, name: string) { return this.preview(image, name); }
  async saveJSON(scene: Scene, name: string) { this.files.set(name, structuredClone(scene)); return name; }
  async loadJSON(name: string) { return this.files.get(name); }
}
const setup = () => {
  const store = new SceneStore(), renderer = new PixelRenderer(), tools = new SceneTools(store, renderer, new MemoryAdapter());
  store.create({ scene_id: 'demo', recipe: 'cave_entrance', seed: 42 });
  return { store, renderer, tools };
};
const gateEdit: Operation[] = [{ op: 'update', id: 'entrance_gate', changes: { bounds: [260,175,120,184], params: { bar_count: 4 } } }];

test('every recipe renders deterministically from saved JSON to 640 x 480', () => {
  for (const recipe of Object.keys(recipes) as (keyof typeof recipes)[]) {
    const store = new SceneStore(), renderer = new PixelRenderer();
    const scene = store.create({ scene_id: recipe, recipe, seed: 42 });
    const before = renderer.render(scene), loaded = store.load('loaded', JSON.parse(JSON.stringify(scene)));
    assert.equal(before.width, 640); assert.equal(before.height, 480);
    assert.deepEqual(before.data, renderer.render(loaded).data);
    const colors = new Set<string>();
    for (let i = 0; i < before.data.length; i += 4) colors.add(before.data.slice(i,i+3).join(','));
    assert.ok(colors.size <= 16);
  }
});
test('invalid batch leaves pixels, revision, history and objects unchanged with operation/field', async () => {
  const { store, renderer, tools } = setup(), before = store.get('demo'), pixels = renderer.render(before).data;
  const result = await tools.scene_apply({ scene_id: 'demo', operations: [...gateEdit, { op: 'remove', id: 'missing' }] });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.operation, 1); assert.equal(result.error.field, 'id'); }
  assert.deepEqual(store.get('demo'), before); assert.deepEqual(store.historyInfo('demo'), { undo: 0, redo: 0 });
  assert.deepEqual(renderer.render(store.get('demo')).data, pixels);
});
test('schema rejects out-of-range generator params without a commit', async () => {
  const { tools, store } = setup();
  const result = await tools.scene_apply({ scene_id: 'demo', operations: [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: 99 } } }] });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.operation, 0); assert.match(result.error.field ?? '', /bar_count/); }
  assert.equal(store.get('demo').revision, 0);
});
test('one batch is one history entry; undo/redo restore exact renders and seeds', () => {
  const { store, renderer } = setup(), initial = store.get('demo'), original = renderer.render(initial).data;
  store.apply('demo', gateEdit); const edited = renderer.render(store.get('demo')).data;
  assert.notDeepEqual(edited, original); assert.deepEqual(store.historyInfo('demo'), { undo: 1, redo: 0 });
  const undone = store.history('demo', 'undo'); assert.equal(undone.revision, 2); assert.deepEqual(undone.objects, initial.objects); assert.deepEqual(renderer.render(undone).data, original);
  assert.deepEqual(renderer.render(store.history('demo', 'redo')).data, edited);
  store.history('demo','undo'); store.apply('demo', [{ op: 'update', id: 'entrance_gate', changes: { params: { bar_count: 3 } } }]);
  assert.throws(() => store.history('demo','redo'), /Only 0/);
});
test('an edit preserves unrelated objects and their local material pixels', () => {
  const { store, renderer } = setup(), before = store.get('demo');
  const preview = renderer.render(before, { crop: [0,80,100,300] });
  store.apply('demo', gateEdit); const after = store.get('demo');
  assert.deepEqual(before.objects.filter(o => o.id !== 'entrance_gate'), after.objects.filter(o => o.id !== 'entrance_gate'));
  assert.deepEqual(preview.data, renderer.render(after, { crop: [0,80,100,300] }).data);
  assert.equal((after.objects.find(o => o.id === 'entrance_gate') as {params: Record<string, unknown>}).params.shape, 'arched');
});
test('material fills are clipped to a polygon and scaled without interpolation', () => {
  const store = new SceneStore(), renderer = new PixelRenderer();
  store.create({ scene_id: 'mask', width: 32, height: 32 });
  store.apply('mask', [{ op: 'add', object: { id:'triangle', kind:'polygon', layer:0, points:[[5,5],[25,5],[5,25]], material:{ id:'stone' }, seed:42 } }]);
  const image = renderer.render(store.get('mask')), zoom = renderer.render(store.get('mask'), { scale: 2 });
  const pixel = (i: PixelImage,x:number,y:number) => [...i.data.slice((y*i.width+x)*4,(y*i.width+x)*4+4)];
  assert.deepEqual(pixel(image,20,20), [23,33,38,255]);
  assert.notDeepEqual(pixel(image,8,8), [23,33,38,255]);
  for (let y=0;y<64;y++) for(let x=0;x<64;x++) assert.deepEqual(pixel(zoom,x,y),pixel(image,Math.floor(x/2),Math.floor(y/2)));
});
test('projective map maps corners and compresses texture depth nonlinearly', () => {
  const map = quadMapping([[100,100],[200,100],[300,300],[0,300]], [300,300]);
  const a = map(100,100), b = map(300,300), middle = map(150,200);
  assert.ok(Math.abs(a[0]) < 1e-8 && Math.abs(a[1]) < 1e-8);
  assert.ok(Math.abs(b[0]-300) < 1e-8 && Math.abs(b[1]-300) < 1e-8);
  assert.ok(Math.abs(middle[1]-150) > 25);
});
test('wide short arches use the full bounds and keep gate crossbars below the arch', () => {
  const parts = expandGenerator({ id:'opening',kind:'procedural',generator:'opening',bounds:[10,20,280,170],layer:0,params:{shape:'arched'} });
  const frame = parts[0]; assert.equal(frame.kind,'polygon');
  if (frame.kind==='polygon') { assert.equal(Math.min(...frame.points.map(p=>p[1])),20); assert.equal(Math.max(...frame.points.map(p=>p[1])),190); }
  const gate = expandGenerator({ id:'gate',kind:'procedural',generator:'gate',bounds:[10,20,280,170],layer:0,params:{shape:'arched'} });
  for (const part of gate.filter(p=>p.id.includes('cross_'))) if (part.kind==='line') assert.ok(part.points.every(p=>p[1]>=20+170*0.4));
});
test('same-layer reordering persists; new IDs have stable independent seeds', () => {
  const store = new SceneStore(); store.create({ scene_id:'order' });
  store.apply('order', ['first','second','third'].map(id => ({ op:'add', object:{ id,kind:'ellipse',bounds:[0,0,20,20],layer:1,color:3 } })));
  const seed = store.get('order').objects.find(o => o.id==='second')!.seed;
  store.apply('order', [{ op:'reorder',id:'third',position:0 }]);
  assert.deepEqual(store.get('order').objects.map(o=>o.id),['third','first','second']);
  assert.equal(store.load('loaded',JSON.parse(JSON.stringify(store.get('order')))).objects[2].seed,seed);
  assert.throws(()=>store.apply('order',[{op:'reorder',id:'first',position:4}]),/positions/);
});
test('stale revisions, unknown tools, unknown params and invalid crop return structured errors', async () => {
  const { tools } = setup();
  assert.equal((await tools.scene_apply({ scene_id:'demo', expected_revision:99,operations:gateEdit })).ok,false);
  assert.equal((await tools.dispatch({tool:'bad',arguments:{}})).ok,false);
  assert.equal((await tools.scene_create({scene_id:'bad',recipe:'cave_entrance',recipe_params:{unsupported:1}})).ok,false);
  assert.equal((await tools.scene_render({scene_id:'demo',crop:[600,0,100,100]})).ok,false);
});
test('tool persistence restores the exact render; mismatched renderer versions are rejected', async () => {
  const { tools, store, renderer } = setup();
  const before = renderer.render(store.get('demo')).data;
  assert.ok((await tools.scene_io({scene_id:'demo',action:'save',filename:'scene.json'})).ok);
  store.apply('demo',gateEdit);
  assert.ok((await tools.scene_io({scene_id:'demo',action:'load',filename:'scene.json'})).ok);
  assert.deepEqual(renderer.render(store.get('demo')).data,before);
  assert.equal((await tools.scene_io({scene_id:'bad',action:'load',scene:{...store.get('demo'),renderer_version:RENDERER_VERSION+'bad'}})).ok,false);
});
test('sprites respect anchor, transparency and nearest palette colors', () => {
  const store = new SceneStore(), renderer = new PixelRenderer(); store.create({scene_id:'sprite',width:32,height:32});
  renderer.registerAsset({manifest:{id:'test',description:'test',width:2,height:1,anchor:[1,0],tags:[]},image:{width:2,height:1,data:new Uint8ClampedArray([255,255,255,255,255,0,0,0])}});
  store.apply('sprite',[{op:'add',object:{id:'sprite_obj',kind:'sprite',asset:'test',bounds:[8,8,4,2],layer:1}}]);
  const image = renderer.render(store.get('sprite'));
  assert.notDeepEqual([...image.data.slice((8*32+6)*4,(8*32+6)*4+3)],[23,33,38]);
  assert.deepEqual([...image.data.slice((8*32+8)*4,(8*32+8)*4+3)],[23,33,38]);
});
