import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { generators, materials, PixelRenderer, RENDERER_VERSION, recipes, sceneSchema, SceneStore, toolSchemas, type PixelImage, type RecipeId, type Scene } from '../src/core/index';
import { NodeAdapter } from '../src/adapters/node/index.js';

const store = new SceneStore(), renderer = new PixelRenderer(), adapter = new NodeAdapter('examples');
await mkdir('examples', { recursive: true }); await mkdir('schemas', { recursive: true });
const timings = [];
for (const recipe of Object.keys(recipes) as RecipeId[]) {
  const scene = store.create({ scene_id: recipe, recipe, seed: 42 });
  await adapter.saveJSON(scene, `${recipe}.json`);
  // Render the serialized artifact, rather than only the in-memory recipe.
  const loaded = JSON.parse(await readFile(`examples/${recipe}.json`, 'utf8')) as Scene;
  const image = renderer.render(loaded);
  await adapter.exportPNG(image, `${recipe}.png`);
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) { const start = performance.now(); renderer.render(loaded); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  timings.push({ recipe, objects: scene.objects.length, samples: samples.length, median_ms: +samples[5].toFixed(2), p90_ms: +samples[8].toFixed(2), min_ms: +samples[0].toFixed(2) });
  console.log(`${recipe}: ${samples[5].toFixed(1)} ms`);
}

// A tiny bitmap font is only used to label exported contact sheets.
const glyphs: Record<string, string> = {
  A:'0e11111f111111',B:'1e11111e11111e',C:'0f10101010100f',D:'1e11111111111e',E:'1f10101e10101f',F:'1f10101e101010',G:'0f10101711110f',H:'1111111f111111',I:'1f04040404041f',J:'0702020212120c',K:'11121418141211',L:'1010101010101f',M:'111b1515111111',N:'11191513111111',O:'0e11111111110e',P:'1e11111e101010',Q:'0e11111115120d',R:'1e11111e141211',S:'0f10100e01011e',T:'1f040404040404',U:'1111111111110e',V:'11111111110a04',W:'11111115151b11',X:'11110a040a1111',Y:'11110a04040404',Z:'1f01020408101f',_:'0000000000001f',' ':'00000000000000',0:'0e11131519110e',1:'040c040404040e',2:'0e11010204081f',3:'1e01010601011e',4:'02060a121f0202',5:'1f10101e01011e',6:'0e10101e11110e',7:'1f010204080808',8:'0e11110e11110e',9:'0e11110f01010e', '/':'01010204081010', '-':'0000001f000000',
};
function label(image: PixelImage, text: string, x: number, y: number) {
  for (const char of text.toUpperCase()) {
    const glyph = glyphs[char] ?? glyphs[' '];
    for (let row = 0; row < 7; row++) { const bits = parseInt(glyph.slice(row * 2, row * 2 + 2), 16); for (let col = 0; col < 5; col++) if (bits & (1 << (4 - col))) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = x + col * 2 + dx, py = y + row * 2 + dy;
      if (px < image.width && py < image.height) image.data.set([221,182,111,255], (py * image.width + px) * 4);
    } }
    x += 12;
  }
}
const patternScene = store.create({ scene_id: 'material_sheet', width: 1280, height: 480 });
for (const [i, id] of Object.keys(materials).entries()) {
  const x = 16 + (i % 5) * 254, y = 42 + Math.floor(i / 5) * 235;
  patternScene.objects.push({ id, kind: 'polygon', layer: 0, seed: 42, points: [[x,y], [x+235,y], [x+235,y+180], [x+26,y+180], [x,y+150]], material: { id: id as keyof typeof materials }, outline: 4 });
}
const patternImage = renderer.render(patternScene);
Object.keys(materials).forEach((id, i) => label(patternImage, id, 16 + i % 5 * 254, 16 + Math.floor(i / 5) * 235));
await adapter.exportPNG(patternImage, 'materials.png');
const variants = [
  ['rock_wall','full'], ['rock_wall','left'], ['opening','rectangular'], ['opening','arched'],
  ['gate','rectangular'], ['gate','arched'], ['tree','round'], ['tree','pine'],
  ['building','gable'], ['building','flat'], ['path','curved'], ['room_shell','wood'],
  ['furniture','table'], ['furniture','chair'], ['furniture','shelf'], ['room_shell','tiles'],
] as const;
const objectScene = store.create({ scene_id: 'object_sheet', width: 1280, height: 960 });
variants.forEach(([generator, variant], i) => {
  const x = i % 4 * 320 + 20, y = Math.floor(i / 4) * 240 + 50;
  objectScene.objects.push({ id: `sample_${i}`, kind: 'procedural', layer: i, seed: 42, generator, bounds: [x,y,280,170], params:
    generator === 'rock_wall' ? { edge_profile: variant as string } :
    generator === 'opening' || generator === 'gate' ? { shape: variant as string } :
    generator === 'tree' || generator === 'furniture' ? { variant: variant as string } :
    generator === 'building' ? { roof_shape: variant as string } :
    generator === 'path' ? { foreground_width: 200, destination: [x+140,y], curvature: 35 } :
    { floor_material: variant as string, vanishing_point: [x+140,y+55] },
  });
});
const objectImage = renderer.render(objectScene);
variants.forEach(([id, variant], i) => label(objectImage, `${id}/${variant}`, i % 4 * 320 + 20, Math.floor(i / 4) * 240 + 20));
await adapter.exportPNG(objectImage, 'objects.png');
await writeFile('examples/assets.json', JSON.stringify({ assets: [], description: 'Register decoded PNG assets with PixelRenderer.registerAsset. Bundled scenes use procedural objects only.', manifest_schema: { id: 'unique_asset_id', description: 'Human-readable description', width: 32, height: 32, anchor: [16,32], tags: ['prop'] } }, null, 2) + '\n');
await writeFile('schemas/scene.schema.json', JSON.stringify(sceneSchema, null, 2) + '\n');
await writeFile('schemas/tools.schema.json', JSON.stringify(toolSchemas, null, 2) + '\n');
await writeFile('examples/performance.json', JSON.stringify({ renderer_version: RENDERER_VERSION, runtime: process.version, machine: { os: `${platform()} ${release()}`, architecture: arch(), cpu: cpus()[0]?.model, logical_processors: cpus().length, memory_gib: +(totalmem()/1024**3).toFixed(1) }, measurement: 'Warm CPU scene rendering including validation and RGBA conversion; excludes inference, PNG encoding and disk IO.', timings, representative_tool_calls: { recipe_create_preview: 3, complete_edit_undo_export_workflow: 11 }, generator_count: Object.keys(generators).length }, null, 2) + '\n');
