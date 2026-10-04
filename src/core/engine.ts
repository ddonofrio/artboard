import { palettes, recipes } from './catalog.js';
import { idSeed } from './materials.js';
import { expandRecipe } from './recipes.js';
import { fail, SceneError, validateObject, validateScene } from './schema.js';
import { RENDERER_VERSION, type Operation, type Palette, type Params, type RecipeId, type Scene } from './types.js';

interface RecordEntry { scene: Scene; undo: Scene[]; redo: Scene[] }
const copy = <T>(value: T): T => structuredClone(value);
function merge(target: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const output = { ...target };
  for (const [key, value] of Object.entries(changes)) output[key] = value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key]) ? merge(output[key] as Record<string, unknown>, value as Record<string, unknown>) : copy(value);
  return output;
}
export function resolvePalette(palette: string | Palette): Palette {
  if (typeof palette !== 'string') return copy(palette);
  if (!palettes[palette]) fail('UNKNOWN_PALETTE', `Unknown palette: ${palette}`, 'palette');
  return copy(palettes[palette]);
}

export class SceneStore {
  private entries = new Map<string, RecordEntry>();
  create(args: { scene_id: string; width?: number; height?: number; palette?: string | Palette; seed?: number; recipe?: RecipeId; recipe_params?: Params }): Scene {
    if (this.entries.has(args.scene_id)) fail('SCENE_EXISTS', `Scene already exists: ${args.scene_id}`, 'scene_id');
    const width = args.width ?? 640, height = args.height ?? 480, seed = args.seed ?? 1;
    const scene: Scene = { version: 1, renderer_version: RENDERER_VERSION, id: args.scene_id, width, height, palette: resolvePalette(args.palette ?? (args.recipe ? recipes[args.recipe].palette : 'basic')), seed, revision: 0, objects: args.recipe ? expandRecipe(args.recipe, seed, args.recipe_params, width, height) : [] };
    validateScene(scene);
    this.entries.set(scene.id, { scene: copy(scene), undo: [], redo: [] });
    return copy(scene);
  }
  private entry(id: string): RecordEntry {
    const entry = this.entries.get(id);
    if (!entry) fail('SCENE_NOT_FOUND', `Scene not found: ${id}`, 'scene_id');
    return entry;
  }
  get(id: string): Scene { return copy(this.entry(id).scene); }
  private commit(entry: RecordEntry, scene: Scene): Scene {
    validateScene(scene);
    entry.undo.push(copy(entry.scene));
    if (entry.undo.length > 64) entry.undo.shift();
    entry.redo = [];
    scene.revision = entry.scene.revision + 1;
    entry.scene = copy(scene);
    return copy(scene);
  }
  apply(id: string, operations: Operation[], expectedRevision?: number): { revision: number; affected_ids: string[] } {
    const entry = this.entry(id);
    if (expectedRevision !== undefined && expectedRevision !== entry.scene.revision) fail('STALE_REVISION', `Expected revision ${expectedRevision}, current revision is ${entry.scene.revision}`, 'expected_revision');
    if (operations.length < 1 || operations.length > 128) fail('VALIDATION', 'A batch requires 1 to 128 operations', 'operations');
    const draft = copy(entry.scene), affected = new Set<string>();
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        if (op.op === 'add') {
          validateObject(op.object);
          if (draft.objects.some(o => o.id === op.object.id)) fail('DUPLICATE_ID', `Object already exists: ${op.object.id}`, 'object/id');
          const obj = copy(op.object);
          obj.seed ??= idSeed(draft.seed, obj.id);
          draft.objects.push(obj);
          affected.add(obj.id);
        } else {
          const at = draft.objects.findIndex(o => o.id === op.id);
          if (at < 0) fail('OBJECT_NOT_FOUND', `Object not found: ${op.id}`, 'id');
          const obj = draft.objects[at];
          if (op.op === 'remove') draft.objects.splice(at, 1);
          else if (op.op === 'update') {
            if ('id' in op.changes || 'kind' in op.changes || 'generator' in op.changes || 'asset' in op.changes) fail('IMMUTABLE_FIELD', 'Identity and kind are immutable; remove and add instead', 'changes');
            const updated = merge(obj as unknown as Record<string, unknown>, op.changes);
            validateObject(updated);
            draft.objects[at] = updated;
          } else if (op.op === 'reorder') {
            if (op.layer === undefined && op.position === undefined) fail('VALIDATION', 'Reorder requires layer or position', 'position');
            if (op.layer !== undefined) obj.layer = op.layer;
            if (op.position !== undefined) {
              draft.objects.splice(at, 1);
              const peers = draft.objects.map((o, index) => ({ o, index })).filter(({ o }) => o.layer === obj.layer);
              if (op.position < 0 || op.position > peers.length || !Number.isInteger(op.position)) fail('INVALID_POSITION', `Layer ${obj.layer} accepts positions 0 to ${peers.length}`, 'position');
              const insert = op.position === peers.length ? (peers.at(-1)?.index ?? draft.objects.length - 1) + 1 : peers[op.position].index;
              draft.objects.splice(insert, 0, obj);
            }
          } else fail('UNKNOWN_OPERATION', 'Unknown edit operation', 'op');
          affected.add(op.id);
        }
        validateScene(draft);
      } catch (error) {
        if (error instanceof SceneError) throw new SceneError({ ...error.detail, operation: i });
        throw error;
      }
    }
    const scene = this.commit(entry, draft);
    return { revision: scene.revision, affected_ids: [...affected] };
  }
  palette(id: string, palette: string | Palette): Scene {
    const entry = this.entry(id), draft = copy(entry.scene);
    draft.palette = resolvePalette(palette);
    return this.commit(entry, draft);
  }
  load(id: string, data: unknown): Scene {
    validateScene(data);
    if (data.renderer_version !== RENDERER_VERSION) fail('RENDERER_VERSION', `Scene needs renderer ${data.renderer_version}; this renderer is ${RENDERER_VERSION}`, 'renderer_version');
    const scene = copy(data);
    scene.id = id;
    validateScene(scene);
    if (this.entries.has(id)) return this.commit(this.entry(id), scene);
    this.entries.set(id, { scene: copy(scene), undo: [], redo: [] });
    return copy(scene);
  }
  history(id: string, action: 'undo' | 'redo', steps = 1): Scene {
    const entry = this.entry(id), from = action === 'undo' ? entry.undo : entry.redo, to = action === 'undo' ? entry.redo : entry.undo;
    if (!Number.isInteger(steps) || steps < 1 || steps > 64) fail('VALIDATION', 'History steps must be 1 to 64', 'steps');
    if (from.length < steps) fail('HISTORY_EMPTY', `Only ${from.length} ${action} steps available`, 'steps');
    for (let i = 0; i < steps; i++) {
      const revision = entry.scene.revision + 1;
      to.push(copy(entry.scene));
      entry.scene = from.pop()!;
      entry.scene.revision = revision;
    }
    return copy(entry.scene);
  }
  historyInfo(id: string) { const entry = this.entry(id); return { undo: entry.undo.length, redo: entry.redo.length }; }
  checkpoint(id: string): unknown { return copy(this.entry(id)); }
  restoreCheckpoint(id: string, checkpoint: unknown): void { this.entries.set(id, copy(checkpoint as RecordEntry)); }
  inspect(id: string, ids?: string[]) {
    const scene = this.get(id);
    if (ids) return { scene_id: id, revision: scene.revision, objects: ids.map(objectId => {
      const object = scene.objects.find(o => o.id === objectId);
      if (!object) fail('OBJECT_NOT_FOUND', `Object not found: ${objectId}`, 'ids');
      return object;
    }) };
    return { scene_id: id, revision: scene.revision, width: scene.width, height: scene.height, palette: scene.palette.id, seed: scene.seed, history: this.historyInfo(id), objects: scene.objects.map(o => ({ id: o.id, kind: o.kind, layer: o.layer, ...('generator' in o ? { generator: o.generator } : {}), tags: o.tags ?? [] })) };
  }
}
