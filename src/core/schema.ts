import Ajv from 'ajv';
import { boundsSchema, choice, generators, integer, materials, number, objectSchema, palettes, pointSchema, recipes, type Schema } from './catalog.js';
import type { Scene, SceneObject, ToolError } from './types.js';
import { BASIC_PALETTE } from './colors.js';

const id = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' };
const points = { type: 'array', items: pointSchema, minItems: 2, maxItems: 256 };
export const paletteSchema = objectSchema({ id: { const: BASIC_PALETTE.id }, name: { const: BASIC_PALETTE.name }, colors: { const: BASIC_PALETTE.colors } }, ['id', 'name', 'colors']);
const materialSchema = { oneOf: Object.entries(materials).map(([key, entry]) => objectSchema({ id: { const: key }, params: objectSchema(entry.parameters) }, ['id'])) };
const base = { id, layer: integer(-1000, 1000), seed: integer(0, 4294967295), tags: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', maxLength: 80 } }, material: materialSchema, color: integer(0, 15), outline: integer(0, 15), stroke_width: integer(1, 24) };
export const sceneObjectSchema: Schema = { oneOf: [
  objectSchema({ ...base, kind: { const: 'polygon' }, points: { ...points, minItems: 3 }, rotation: number(-360, 360), fill: { anyOf: [integer(0, 15), { const: 'none' }, objectSchema({ colors: { type: 'array', items: integer(0, 15), minItems: 2, maxItems: 2 }, ratio: number(0, 1) }, ['colors', 'ratio'])] }, mapping: objectSchema({ quad: { ...points, minItems: 4, maxItems: 4 }, size: { type: 'array', items: number(1, 2048), minItems: 2, maxItems: 2 } }, ['quad', 'size']) }, ['id', 'kind', 'layer', 'points']),
  objectSchema({ ...base, kind: { const: 'line' }, points, rotation: number(-360, 360) }, ['id', 'kind', 'layer', 'points']),
  objectSchema({ ...base, kind: { const: 'ellipse' }, bounds: boundsSchema, rotation: number(-360, 360), fill: { anyOf: [integer(0, 15), { const: 'none' }, objectSchema({ colors: { type: 'array', items: integer(0, 15), minItems: 2, maxItems: 2 }, ratio: number(0, 1) }, ['colors', 'ratio'])] } }, ['id', 'kind', 'layer', 'bounds']),
  objectSchema({ ...base, kind: { const: 'sprite' }, bounds: boundsSchema, asset: id }, ['id', 'kind', 'layer', 'bounds', 'asset']),
  objectSchema({ ...base, kind: { const: 'star' }, center: pointSchema, radius: number(0.5, 2048), tips: integer(3, 32, 5), inner_radius: number(0.01, 2048), rotation: number(-360, 360, 0) }, ['id', 'kind', 'layer', 'center', 'radius']),
  ...Object.entries(generators).map(([key, entry]) => objectSchema({ ...base, kind: { const: 'procedural' }, bounds: boundsSchema, generator: { const: key }, params: objectSchema(entry.parameters) }, ['id', 'kind', 'layer', 'bounds', 'generator'])),
] };
export const sceneSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://artboard.local/schema/scene.json',
  ...objectSchema({ version: { const: 1 }, renderer_version: { type: 'string', minLength: 1, maxLength: 32 }, id, width: integer(32, 1280, 640), height: integer(32, 960, 480), palette: paletteSchema, seed: integer(0, 4294967295, 1), revision: integer(0, Number.MAX_SAFE_INTEGER), objects: { type: 'array', maxItems: 512, items: sceneObjectSchema } }, ['version', 'renderer_version', 'id', 'width', 'height', 'palette', 'seed', 'revision', 'objects']),
};
const operationSchema = { oneOf: [
  objectSchema({ op: { const: 'add' }, object: sceneObjectSchema }, ['op', 'object']),
  objectSchema({ op: { const: 'update' }, id, changes: { type: 'object', minProperties: 1, maxProperties: 16, propertyNames: { enum: ['layer', 'seed', 'tags', 'material', 'color', 'outline', 'stroke_width', 'points', 'bounds', 'mapping', 'params', 'center', 'radius', 'tips', 'inner_radius', 'rotation', 'fill'] } } }, ['op', 'id', 'changes']),
  objectSchema({ op: { const: 'remove' }, id }, ['op', 'id']),
  { ...objectSchema({ op: { const: 'reorder' }, id, layer: integer(-1000, 1000), position: integer(0, 511) }, ['op', 'id']), anyOf: [{ required: ['layer'] }, { required: ['position'] }] },
] };
const sceneId = { scene_id: id };
const filename = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$' };
export const toolSchemas: Record<string, { description: string; inputSchema: Schema }> = {
  scene_catalog: { description: 'Discover bounded parameters, defaults and examples. Optional category and ID filter.', inputSchema: objectSchema({ category: choice(['palettes', 'materials', 'objects', 'recipes', 'assets', 'tools']), id }) },
  scene_create: { description: 'Create an empty scene or expand a recipe into editable objects. Existing IDs are rejected.', inputSchema: {
    ...objectSchema({ ...sceneId, width: integer(32, 1280, 640), height: integer(32, 960, 480), palette: { anyOf: [choice(Object.keys(palettes)), paletteSchema] }, seed: integer(0, 4294967295, 1), recipe: choice(Object.keys(recipes)), recipe_params: { type: 'object' } }, ['scene_id']),
    allOf: Object.entries(recipes).map(([key, entry]) => ({ if: { properties: { recipe: { const: key } }, required: ['recipe'] }, then: { properties: { recipe_params: objectSchema(entry.parameters) } } })),
    dependencies: { recipe_params: ['recipe'] },
  } },
  scene_inspect: { description: 'Return a compact summary or full properties for selected IDs.', inputSchema: objectSchema({ ...sceneId, ids: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: id } }, ['scene_id']) },
  scene_apply: { description: 'Atomically commit add/update/remove/reorder. Nested changes merge. Position is zero-based within a layer. Optional revision prevents stale edits.', inputSchema: objectSchema({ ...sceneId, expected_revision: integer(0, Number.MAX_SAFE_INTEGER), operations: { type: 'array', minItems: 1, maxItems: 128, items: operationSchema } }, ['scene_id', 'operations']) },
  scene_render: { description: 'Return preview image reference and revision. Crops stay inside the canvas; scaling uses nearest neighbor.', inputSchema: objectSchema({ ...sceneId, crop: boundsSchema, scale: integer(1, 4, 1) }, ['scene_id']) },
  scene_history: { description: 'Undo or redo committed batches atomically. Revision increases; pixels and seeds restore.', inputSchema: objectSchema({ ...sceneId, action: choice(['undo', 'redo']), steps: integer(1, 64, 1) }, ['scene_id', 'action']) },
  scene_io: { description: 'Save/load scene JSON or export PNG. Paths are adapter-scoped filenames. Load replaces content with one history entry. Optional palette update is an undoable transaction.', inputSchema: objectSchema({ ...sceneId, action: choice(['save', 'load', 'export', 'palette']), filename, scene: sceneSchema, palette: { anyOf: [choice(Object.keys(palettes)), paletteSchema] }, scale: integer(1, 4, 1) }, ['scene_id', 'action']) },
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSceneJSON = ajv.compile(sceneSchema);
const validateObjectJSON = ajv.compile(sceneObjectSchema);
const toolValidators = Object.fromEntries(Object.entries(toolSchemas).map(([key, value]) => [key, ajv.compile(value.inputSchema)]));

export class SceneError extends Error {
  constructor(public readonly detail: ToolError) { super(detail.message); this.name = 'SceneError'; }
}
export function fail(code: string, message: string, field?: string, operation?: number): never { throw new SceneError({ code, message, ...(field === undefined ? {} : { field }), ...(operation === undefined ? {} : { operation }) }); }
function schemaCheck(validator: ReturnType<typeof ajv.compile>, value: unknown, field: string): void {
  if (validator(value)) return;
  const all = validator.errors ?? [];
  // A mismatched discriminator excludes that union branch and its nested errors.
  const rejected = all.filter(e => e.keyword === 'const').map(e => e.schemaPath.match(/^(.*\/(?:oneOf|anyOf)\/\d+)\/.*\/const$/)?.[1]).filter((path): path is string => !!path);
  const errors = all.filter(e => !rejected.some(path => e.schemaPath.startsWith(path + '/')));
  const candidates = errors.filter(e => !['const', 'oneOf', 'anyOf', 'required', 'additionalProperties'].includes(e.keyword));
  const err = candidates.sort((a, b) => b.instancePath.length - a.instancePath.length)[0] ?? errors.find(e => e.keyword === 'required') ?? errors.find(e => e.keyword === 'additionalProperties') ?? errors[0] ?? all[0];
  const suffix = err?.keyword === 'additionalProperties' ? `/${String(err.params.additionalProperty)}` : err?.keyword === 'required' ? `/${String(err.params.missingProperty)}` : '';
  fail('VALIDATION', `${field}${err?.instancePath ?? ''}${suffix}: ${err?.message ?? 'invalid value'}`, `${field}${err?.instancePath ?? ''}${suffix}`);
}
export function validateTool(tool: string, args: unknown): void {
  const validator = toolValidators[tool];
  if (!validator) fail('UNKNOWN_TOOL', `Unknown tool: ${tool}`, 'tool');
  schemaCheck(validator, args, 'arguments');
}
function validateGeometry(object: SceneObject, field: string): void {
  if (object.kind === 'star' && object.inner_radius !== undefined && object.inner_radius >= object.radius) fail('INVALID_STAR', 'Star inner_radius must be smaller than radius', `${field}/inner_radius`);
}
export function validateObject(value: unknown): asserts value is SceneObject {
  schemaCheck(validateObjectJSON, value, 'object');
  validateGeometry(value as SceneObject, 'object');
}
export function validateScene(value: unknown): asserts value is Scene {
  schemaCheck(validateSceneJSON, value, 'scene');
  const scene = value as Scene;
  const ids = new Set<string>();
  for (const obj of scene.objects) {
    validateGeometry(obj, `objects/${obj.id}`);
    if (ids.has(obj.id)) fail('DUPLICATE_ID', `Duplicate object ID: ${obj.id}`, `objects/${obj.id}/id`);
    ids.add(obj.id);
    for (const [key, color] of Object.entries({ color: obj.color, outline: obj.outline, foreground: obj.material?.params?.foreground, background: obj.material?.params?.background, darkness: obj.kind === 'procedural' ? obj.params?.darkness : undefined, metal_color: obj.kind === 'procedural' ? obj.params?.metal_color : undefined, highlight_color: obj.kind === 'procedural' ? obj.params?.highlight_color : undefined })) {
      if (typeof color === 'number' && color >= scene.palette.colors.length) fail('COLOR_RANGE', `Palette has no color ${color}`, `objects/${obj.id}/${key}`);
    }
    if (obj.kind === 'polygon' && obj.mapping) {
      const q = obj.mapping.quad;
      const cross = q.map((p, i) => { const a = q[(i + 1) % 4], b = q[(i + 2) % 4]; return (a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0]); });
      if (!cross.every(c => c > 0) && !cross.every(c => c < 0)) fail('INVALID_QUAD', 'Mapping requires a convex non-degenerate quadrilateral in perimeter order', `objects/${obj.id}/mapping/quad`);
    }
  }
}
