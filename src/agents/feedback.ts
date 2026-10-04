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
  if (changedPixels === 0 && affectedIds.length) instructions.push('The edit committed but changed no visible pixels. Do not claim that it painted anything. Inspect the affected objects: they may be hidden by a higher layer, outside the canvas, use the same color as what is behind them, or repeat their existing values.');
  if (uncovered !== undefined && uncovered > 0) instructions.push(`${uncovered} canvas pixels have no painted object. Fill the missing background before submitting: add a full-canvas polygon behind all existing objects, or extend the intended background planes to cover the gaps. Preserve the requested scene and its foreground objects.`);
  return {
    changed_pixels: changedPixels,
    ...(uncovered === undefined ? {} : { unpainted_pixels: uncovered }),
    instructions,
    suggested_actions: instructions.length ? [
      { tool: 'scene_inspect', arguments: { scene_id: scene.id, ...(affectedIds.length ? { ids: affectedIds } : {}) }, purpose: 'Inspect affected geometry and layers before choosing a correction.' },
      ...(uncovered ? [{ tool: 'scene_apply', purpose: `Fill uncovered background with polygon points [[0,0],[${scene.width},0],[${scene.width},${scene.height}],[0,${scene.height}]], a palette color, and a layer below all existing objects.` }] : []),
      ...(changedPixels === 0 && affectedIds.length ? [
        { tool: 'scene_apply', purpose: 'Use reorder to correct an occluded object layer, respecting which objects should be in front.' },
        { tool: 'scene_apply', purpose: 'Use update to correct points/bounds or choose a distinct valid palette color. Avoid repeating unchanged values.' },
        { tool: 'scene_history', purpose: 'Undo an unintended edit instead of adding more objects on top.' },
      ] : []),
    ] : [],
  };
}
