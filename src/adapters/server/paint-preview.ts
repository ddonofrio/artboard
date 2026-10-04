import { SceneStore, type Operation, type Scene } from '../../core/index.js';
import type { PaintStyle } from '../../contracts/service.js';

export interface PaintPreview { scene: Scene; style: PaintStyle }
/** Replay validated edits on an isolated store for presentation; the real batch stays atomic. */
export function paintPreviews(before: Scene | undefined, after: Scene, operations?: Operation[]): PaintPreview[] {
  if (!operations?.length) return [{ scene: after, style: { kind: 'scanline' } }];
  const store = new SceneStore(); store.load(after.id, before ?? { ...after, objects: [], revision: 0 });
  return operations.map(operation => {
    const id = operation.op === 'add' ? operation.object.id : operation.id;
    const previous = store.get(after.id).objects.find(object => object.id === id);
    store.apply(after.id, [operation]);
    const scene = store.get(after.id); scene.revision = after.revision;
    const object = scene.objects.find(object => object.id === id) ?? previous;
    if (object?.kind !== 'ellipse') return { scene, style: { kind: 'scanline' } };
    const [x, y, width, height] = object.bounds;
    return { scene, style: { kind: 'rays', center: [(x + width / 2) / scene.width, (y + height / 2) / scene.height], radius: [width / 2 / scene.width, height / 2 / scene.height] } };
  });
}
