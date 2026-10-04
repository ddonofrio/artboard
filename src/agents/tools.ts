import Ajv from 'ajv';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { COLOR_NAMES, generators, materials, number, objectSchema, pointSchema, sceneObjectSchema, toolSchemas, type SceneTools, type ToolResult } from '../core/index.js';
import { normalizeGeometry } from './geometry.js';
import { namedCatalog, namedColors, namedColorSchema } from './colors.js';

export interface Handoff { done: string[]; not_done: { item: string; reason: string }[] }
export interface DraftSubmission { revision: number; done?: Handoff['done']; not_done?: Handoff['not_done'] }
export interface Review { revision: number; approved: boolean; issues: { object_id: string; instruction: string }[] }
const shortText = { type: 'string', minLength: 1, maxLength: 1000 };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const draftSubmissionSchema = objectSchema({ revision }, ['revision']);
export const stageSubmissionSchema = objectSchema({ revision, done: { type: 'array', maxItems: 100, items: shortText }, not_done: { type: 'array', maxItems: 100, items: objectSchema({ item: shortText, reason: shortText }, ['item', 'reason']) } }, ['revision', 'done', 'not_done']);
export const reviewSchema = objectSchema({ revision, approved: { type: 'boolean' }, issues: { type: 'array', maxItems: 3, items: objectSchema({ object_id: { type: 'string', minLength: 1, maxLength: 80 }, instruction: shortText }, ['object_id', 'instruction']) } }, ['revision', 'approved', 'issues']);
const ajv = new Ajv({ strict: false, allErrors: true });
const validateDraft = ajv.compile(draftSubmissionSchema), validateReview = ajv.compile(reviewSchema);
const validateStage = ajv.compile(stageSubmissionSchema);
const error = (message: string): ToolResult => ({ ok: false, error: { code: 'AGENT_VALIDATION', message } });

// Describe nesting and geometry without repeating every generator/material
// parameter schema in every operation. The host validates their exact contracts.
const objectVariants = sceneObjectSchema.oneOf as { properties: Record<string, Record<string, unknown>> }[];
const drawingProperties = {
  ...objectVariants[0].properties,
  color: { ...namedColorSchema, description: 'Interior fill color for shapes; stroke color for lines.' },
  outline: { ...namedColorSchema, description: 'Draw a continuous border around the entire rectangle, polygon or ellipse in this color, in addition to its interior fill.' },
  stroke_width: { ...objectVariants[0].properties.stroke_width, description: 'Line or outline thickness in pixels; defaults to 1.' },
  kind: { type: 'string', enum: ['circle', 'rect', 'rectangle', 'polygon', 'ellipse', 'line', 'procedural', 'sprite'] },
  points: { anyOf: [objectVariants[1].properties.points, objectVariants[2].properties.bounds], description: 'Polygon/line vertices. For ellipse, procedural or sprite, also accepts bounding corners or [x,y,width,height].' },
  bounds: { ...objectVariants[2].properties.bounds, description: '[x,y,width,height], measured from the top-left of the canvas.' },
  center: { ...pointSchema, description: 'Circle/ellipse center [x,y], in canvas pixels.' },
  radius: { ...number(0.5, 2048), description: 'Circle radius in pixels.' },
  rect: { ...objectVariants[2].properties.bounds, description: 'Rectangle/ellipse [x,y,width,height]. Width and height are dimensions in pixels.' },
  xy: { anyOf: [objectVariants[1].properties.points, { type: 'array', items: number(-4096, 4096), minItems: 4, maxItems: 4 }], description: 'Pillow-style corners for ellipse/rectangle (inclusive endpoints), or polygon/line vertices.' },
  bbox: { anyOf: [objectVariants[1].properties.points, { type: 'array', items: number(-4096, 4096), minItems: 4, maxItems: 4 }], description: 'Bounding corners [x0,y0,x1,y1] or [[x0,y0],[x1,y1]], with exclusive far edges.' },
  x: number(-4096, 4096), y: number(-4096, 4096), width: number(0, 4096), height: number(0.5, 4096),
  cx: number(-4096, 4096), cy: number(-4096, 4096), r: number(0.5, 2048), rx: number(0.5, 2048), ry: number(0.5, 2048),
  start: pointSchema, end: pointSchema,
  fill: { ...namedColorSchema, description: 'Fill color name; alias for color.' },
  generator: { type: 'string', enum: Object.keys(generators) },
  asset: objectVariants[3].properties.asset,
  params: { type: 'object', additionalProperties: true, description: 'Generator parameters from scene_catalog category=objects and id=generator.' },
  material: objectSchema({ id: { type: 'string', enum: Object.keys(materials) }, params: { type: 'object', additionalProperties: true } }, ['id']),
};
const drawingSchema = objectSchema(drawingProperties, ['id', 'kind']);
drawingSchema.description = 'Circle: center and radius. Rectangle: rect or x,y,width,height. Ellipse: bounds or xy. Polygon/line: points. For a frame, use the full shape dimensions with outline and stroke_width. Example: {"id":"frame","kind":"rect","rect":[100,100,440,290],"fill":"light gray","outline":"dark gray","stroke_width":2}. Coordinates start at the top-left; colors use the fixed English names; layer defaults to 0, higher layers paint on top.';
const operationsSchema = structuredClone((toolSchemas.scene_apply.inputSchema.properties as Record<string, Record<string, unknown>>).operations);
const operationVariants = (operationsSchema.items as { oneOf: { properties: Record<string, unknown> }[] }).oneOf;
operationVariants[0].properties.object = drawingSchema;
const changesProperties = { ...drawingProperties } as Record<string, Record<string, unknown>>;
for (const field of ['id', 'kind', 'generator', 'asset']) delete changesProperties[field];
operationVariants[1].properties.changes = { ...objectSchema(changesProperties), minProperties: 1 };

export function toolUsage(name: string): string {
  const usage: Record<string, string> = {
    scene_catalog: 'Use category=palettes/materials/objects/assets and optionally id for one entry.',
    scene_inspect: 'Use the supplied scene_id; omit ids for a summary or pass existing object IDs in ids.',
    scene_apply: `Use operations=[{op:"add",object:{id,kind,...}},{op:"update",id,changes:{...}}]. Circle: center:[x,y],radius; ellipse: bounds:[x,y,width,height] or points with bounding corners; rectangle: kind:"rect",rect:[x,y,width,height]; polygon: points with at least 3 [x,y] vertices; line: at least 2. Frames use the full shape dimensions with fill, outline and stroke_width in pixels. Coordinates start at the top-left. Colors: ${COLOR_NAMES.join(', ')}. The failed batch was not applied.`,
    scene_render: 'Call alone with the supplied scene_id; optional crop=[x,y,width,height] must fit the canvas and scale is an integer 1-4.',
    scene_history: 'Use action="undo" or "redo" and steps=1..64, no more than the available history.',
    scene_io: 'The 16 colors are fixed. Choose an English color name in scene_apply.',
    finish_draft: 'Call alone with the current revision; workflow submissions also need done:[...] and not_done:[{item,reason}]. Complete drawing before submitting.',
    submit_review: 'Call alone with the submitted revision, approved:boolean and issues:[{object_id,instruction}]. Approval requires no issues; rejection needs 1-3 concrete corrections using existing IDs or "scene".',
  };
  return usage[name] ?? 'Use an advertised function name and its JSON argument schema; the canvas already exists.';
}

function misplacedObjectField(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.operations)) return;
  for (const [index, operation] of args.operations.entries()) {
    if (!operation || operation.op !== 'add') continue;
    const misplaced = Object.keys(operation).filter(key => key !== 'object' && key in drawingProperties);
    if (misplaced.length) {
      const corrected = structuredClone(operation);
      if (corrected.object && typeof corrected.object === 'object' && !Array.isArray(corrected.object)) {
        for (const field of misplaced) {
          if (!(field in corrected.object)) corrected.object[field] = corrected[field];
          delete corrected[field];
        }
      }
      return `${misplaced.map(field => `operations/${index}/${field} belongs inside operations/${index}/object/${field}`).join('; ')}. An add operation has only op and object. Corrected operation: ${JSON.stringify(corrected)}. Retry with every drawing field inside object; the batch has not been applied and the corrected operation still needs validation.`;
    }
  }
}

/** Thin SDK adapters around the existing tool dispatcher, not a second tool runtime. */
export function agentTools(host: SceneTools, sceneId: string, role: 'editor' | 'reviewer', signal: AbortSignal | undefined, onTool: (name: string, result: ToolResult, input: Record<string, unknown>, appliedInput?: Record<string, unknown>) => void | Promise<void>, onDraft: (draft: DraftSubmission) => void, onReview: (review: Review) => void, submissionError: (revision: number) => string | undefined = () => undefined, requireHandoff = false, onStart: (name: string) => void | Promise<void> = () => {}, vision = true, reviewEnabled = true): ToolSet {
  const result: ToolSet = {};
  // Local models can return several calls despite parallel_tool_calls=false.
  // Serialize adapter executions, including presentation of each preview.
  let pending: Promise<unknown> = Promise.resolve();
  const sequential = <T>(execute: () => Promise<T>): Promise<T> => {
    const next = pending.then(execute);
    pending = next.catch(() => {});
    return next;
  };
  const names = (role === 'editor' ? ['scene_catalog', 'scene_inspect', 'scene_apply', 'scene_render', 'scene_history'] : ['scene_catalog', 'scene_inspect', 'scene_render']).filter(name => vision || name !== 'scene_render');
  for (const name of names) {
    const original = toolSchemas[name];
    // The full polymorphic object schema is large. Discovery supplies precise
    // object contracts; the existing dispatcher still validates the full schema.
    const schema = structuredClone(original.inputSchema);
    if ('scene_id' in (schema.properties as Record<string, unknown>)) (schema.properties as Record<string, unknown>).scene_id = { type: 'string', const: sceneId };
    if (name === 'scene_catalog') (schema.properties as Record<string, unknown>).category = { type: 'string', enum: ['palettes', 'materials', 'objects', 'assets', 'tools'] };
    if (name === 'scene_apply') (schema.properties as Record<string, unknown>).operations = structuredClone(operationsSchema);
    result[name] = tool({
      description: name === 'scene_render' ? 'Request an image for the next model response. Call alone. Supports crop and scale.' : original.description,
      inputSchema: jsonSchema<Record<string, unknown>>(schema),
      execute: args => sequential(async () => {
        signal?.throwIfAborted();
        await onStart(name);
        signal?.throwIfAborted();
        let output: ToolResult;
        let appliedInput: Record<string, unknown> | undefined;
        if (typeof args.scene_id === 'string' && /<\/?(?:parameter|function|tool_call)\b/.test(args.scene_id)) output = error(`Malformed tool arguments: XML tool tags are embedded in scene_id. Use one API function call with valid JSON arguments; scene_id must be exactly "${sceneId}". Do not place tool markup or another call inside a string.`);
        else if (args.scene_id !== undefined && args.scene_id !== sceneId) output = error(`Only scene_id ${sceneId} is available in this run. Retry ${name} with scene_id exactly "${sceneId}"; do not create or reference another scene ID.`);
        else if (name === 'scene_catalog' && args.category === 'recipes') output = error('Prebuilt scenes are unavailable to agents. Compose objects with scene_apply instead.');
        else if (name === 'scene_catalog' && args.category === 'palettes') output = args.id && args.id !== 'basic'
          ? error('There is only one fixed set of 16 colors. Use category=palettes without an ID, or id=basic.')
          : { ok: true, result: { colors: [...COLOR_NAMES] } };
        else if (name === 'scene_catalog' && (!args.category || args.category === 'tools')) output = { ok: true, result: { message: 'The 16 English color names are fixed. Query category=materials, objects, or assets and a single ID for details. Primitive kinds: polygon, ellipse, line; procedural kinds use the objects catalog.', categories: ['palettes', 'materials', 'objects', 'assets'] } };
        else if (name === 'scene_apply' && misplacedObjectField(args)) output = error(misplacedObjectField(args)!);
        else {
          appliedInput = name === 'scene_apply' ? normalizeGeometry(args, host) : args;
          output = await host.dispatch({ tool: name, arguments: appliedInput });
        }
        if (!output.ok) {
          const diagnostic = output.error.field && /\/(?:color|outline|foreground|background|darkness|metal_color|highlight_color)$/.test(output.error.field)
            ? `${name}: ${output.error.field}: choose one of the fixed English color names.`
            : output.error.message.split(' Usage:')[0];
          output.error.message = `${diagnostic} Usage: ${toolUsage(name)}`;
        }
        await onTool(name, output, args, output.ok ? appliedInput : undefined);
        // Only an explicit render requests vision. Keep bytes out of prose;
        // orchestration attaches this exact render once as a real image part.
        if (name === 'scene_render' && output.ok) output = { ok: true, result: { ...output.result, image_ref: 'Requested image supplied once in the next model request. Call scene_render again for another look.' } };
        return (name === 'scene_catalog' ? namedCatalog(output) : namedColors(output)) as ToolResult;
      }),
    });
  }
  const name = role === 'editor' ? 'finish_draft' : 'submit_review';
  result[name] = tool({
    description: role === 'editor' ? (reviewEnabled ? 'Submit the completed revision for review. Call alone.' : 'Deliver the completed revision. Call alone.') : 'Approve the submitted revision or return corrections. Call alone.',
    inputSchema: jsonSchema<Record<string, unknown>>(role === 'editor' ? (requireHandoff ? stageSubmissionSchema : draftSubmissionSchema) : reviewSchema),
    execute: value => sequential(async () => {
      signal?.throwIfAborted();
      await onStart(name);
      signal?.throwIfAborted();
      const validator = role === 'editor' ? (requireHandoff ? validateStage : validateDraft) : validateReview;
      let output: ToolResult;
      if (!validator(value)) output = error(`Invalid ${name}: ${ajv.errorsText(validator.errors)}`);
      else {
        const scene = host.store.get(sceneId);
        if (value.revision !== scene.revision) output = error(`Current revision is ${scene.revision}, not ${String(value.revision)}. Inspect and submit again.`);
        else if (role === 'editor') {
          const draft = value as unknown as DraftSubmission;
          const message = submissionError(scene.revision);
          if (!scene.objects.length) output = error('A draft needs scene objects; create or edit the scenery first.');
          else if (message) output = error(message);
          else { onDraft(structuredClone(draft)); output = { ok: true, result: { revision: scene.revision, submitted: true } }; }
        } else {
          const review = value as unknown as Review;
          const unknown = review.issues.find(issue => issue.object_id !== 'scene' && !scene.objects.some(o => o.id === issue.object_id));
          const message = review.approved ? submissionError(scene.revision) : undefined;
          if (unknown) output = error(`Unknown object ID ${unknown.object_id}. Use an existing object ID or scene.`);
          else if (message) output = error(message);
          else if (review.approved && review.issues.length) output = error('An approved review must have no unresolved issues.');
          else if (!review.approved && !review.issues.length) output = error('A rejected review needs at least one actionable issue.');
          else { onReview(structuredClone(review)); output = { ok: true, result: { revision: scene.revision, submitted: true } }; }
        }
      }
      if (!output.ok) output.error.message = `${name}: ${output.error.message} Usage: ${toolUsage(name)}`;
      await onTool(name, output, value);
      return output;
    }),
  });
  return result;
}
