import { expandGenerator, type Scene, type SceneObject, type SceneTools } from '../core/index.js';

/** Measure object coverage independently of the scene's chosen background color. */
function uncoveredPixels(host: SceneTools, scene: Scene): number | undefined {
  if (scene.objects.some(object => object.kind === 'sprite')) return undefined;
  const geometry: SceneObject[] = [];
  const add = (object: SceneObject) => {
    if (object.kind === 'procedural') { expandGenerator(object).forEach(add); return; }
    geometry.push({ ...object, id: `coverage_${geometry.length}`, color: 1, outline: object.outline === undefined ? undefined : 1, material: undefined });
  };
  scene.objects.forEach(add);
  // A procedural scene can expand beyond the stored-object limit. Coverage is
  // advisory and is skipped rather than changing the composition contract.
  if (geometry.length > 512) return undefined;
  const mask: Scene = { ...scene, palette: { id: 'coverage', name: 'Coverage', colors: ['#000000', '#FFFFFF'] }, objects: geometry };
  const image = host.renderer.render(mask);
  let uncovered = 0;
  for (let index = 0; index < image.data.length; index += 4) if (image.data[index] === 0) uncovered++;
  return uncovered;
}

export function drawingFeedback(host: SceneTools, scene: Scene, changedPixels: number, affectedIds: string[]) {
  const uncovered = uncoveredPixels(host, scene);
  const instructions: string[] = [];
  if (changedPixels === 0 && affectedIds.length) instructions.push('The edit changed no visible pixels. Check the affected objects\' layers, geometry and colors.');
  if (uncovered !== undefined && uncovered > 0) instructions.push(`Fill the missing background if required by the request; ${uncovered} pixels have no painted object.`);
  return {
    changed_pixels: changedPixels,
    ...(uncovered === undefined ? {} : { unpainted_pixels: uncovered }),
    instructions,
    suggested_actions: instructions.length ? [
      ...(changedPixels === 0 && affectedIds.length ? [{ tool: 'scene_inspect', arguments: { scene_id: scene.id, ids: affectedIds }, purpose: 'Check the invisible edit.' }] : []),
      ...(uncovered ? [{ tool: 'scene_apply', purpose: 'Paint any requested background behind the existing objects.' }] : []),
      ...(changedPixels === 0 && affectedIds.length ? [
        { tool: 'scene_apply', purpose: 'Use reorder to correct occlusion, or update geometry or palette color.' },
      ] : []),
    ] : [],
  };
}
