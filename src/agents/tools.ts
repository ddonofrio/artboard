import Ajv from 'ajv';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { COLOR_NAMES, number, objectSchema, pointSchema, toolSchemas, type Schema, type SceneTools, type ToolResult } from '../core/index.js';
import { normalizeGeometry } from './geometry.js';
import { namedColors, namedColorSchema } from './colors.js';

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

const stroke = { ...namedColorSchema, description: 'Border or line color.' };
const fill = { anyOf: [namedColorSchema, { const: 'none' }, objectSchema({ colors: { type: 'array', items: namedColorSchema, minItems: 2, maxItems: 2 }, ratio: number(0, 1) }, ['colors', 'ratio'])], description: 'A color, none, or {colors:[color1,color2],ratio:0.25} to blend two colors.' };
const pointList = { type: 'array', items: pointSchema, minItems: 2, maxItems: 256, description: 'Points are [x,y] canvas coordinates.' };
const common = { id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }, fill, stroke, stroke_width: number(1, 24), rotation: number(-360, 360) };
const drawingVariants = [
  objectSchema({ ...common, kind: { const: 'rect' }, x: number(-4096,4096), y: number(-4096,4096), width: number(1,4096), height: number(1,4096) }, ['id','kind','x','y','width','height']),
  objectSchema({ ...common, kind: { const: 'circle' }, cx: number(-4096,4096), cy: number(-4096,4096), radius: number(0.5,2048) }, ['id','kind','cx','cy','radius']),
  objectSchema({ ...common, kind: { const: 'ellipse' }, cx: number(-4096,4096), cy: number(-4096,4096), rx: number(0.5,2048), ry: number(0.5,2048) }, ['id','kind','cx','cy','rx','ry']),
  objectSchema({ ...common, kind: { const: 'polygon' }, points: { ...pointList, minItems: 3 } }, ['id','kind','points']),
  objectSchema({ id: common.id, kind: { const: 'line' }, stroke, stroke_width: common.stroke_width, rotation: common.rotation, points: pointList }, ['id','kind','points']),
];
const drawingSchema = { oneOf: drawingVariants, description: 'Shapes: rect uses x,y,width,height; circle uses cx,cy,radius; ellipse uses cx,cy,rx,ry; polygon and line use points:[[x,y],...]. New shapes paint over earlier shapes. Colors are English names. Use fill for the inside, stroke for the border, and rotation in degrees.' };
const drawingProperties = Object.assign({}, ...drawingVariants.map(variant => variant.properties as Record<string, unknown>));
const changesProperties = { ...drawingProperties } as Record<string, Schema>;
for (const field of ['id', 'kind']) delete changesProperties[field];
const operation = { oneOf: [
  objectSchema({ op: { const: 'add' }, object: drawingSchema }, ['op','object']),
  objectSchema({ op: { const: 'update' }, id: common.id, changes: objectSchema(changesProperties) }, ['op','id','changes']),
  objectSchema({ op: { const: 'remove' }, id: common.id }, ['op','id']),
] };
const operationsSchema = { type: 'array', minItems: 1, maxItems: 128, items: operation };

export function toolUsage(name: string): string {
  const usage: Record<string, string> = {
    scene_catalog: 'Use category=palettes/materials/objects/assets and optionally id for one entry.',
    scene_inspect: 'Use the supplied scene_id; omit ids for a summary or pass existing object IDs in ids.',
    scene_apply: `Use {operations:[{op:"add",object:{id,kind,...}}]}. rect={x,y,width,height}; circle={cx,cy,radius}; ellipse={cx,cy,rx,ry}; polygon/line={points:[[x,y],...]}. Use fill for the inside and stroke for the border. Colors: ${COLOR_NAMES.join(', ')}. The failed batch was not applied.`,
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
export function agentTools(host: SceneTools, sceneId: string, role: 'editor' | 'reviewer', signal: AbortSignal | undefined, onTool: (name: string, result: ToolResult, input: Record<string, unknown>, appliedInput?: Record<string, unknown>) => void | Promise<void>, onDraft: (draft: DraftSubmission) => void, onReview: (review: Review) => void, submissionError: (revision: number) => string | undefined = () => undefined, requireHandoff = false, onStart: (name: string) => void | Promise<void> = () => {}, vision = true, reviewEnabled = true, beforeTool: (name: string) => string | undefined = () => undefined): ToolSet {
  const result: ToolSet = {};
  // Local models can return several calls despite parallel_tool_calls=false.
  // Serialize adapter executions, including presentation of each preview.
  let pending: Promise<unknown> = Promise.resolve();
  const sequential = <T>(execute: () => Promise<T>): Promise<T> => {
    const next = pending.then(execute);
    pending = next.catch(() => {});
    return next;
  };
  const names = [...(role === 'editor' ? ['scene_apply'] : []), ...(vision ? ['scene_render'] : [])];
  for (const name of names) {
    const original = toolSchemas[name];
    // The full polymorphic object schema is large. Discovery supplies precise
    // object contracts; the existing dispatcher still validates the full schema.
    const schema = structuredClone(original.inputSchema);
    if ('scene_id' in (schema.properties as Record<string, unknown>)) (schema.properties as Record<string, unknown>).scene_id = { type: 'string', const: sceneId };
    schema.additionalProperties = false;
    for (const key of Object.keys((schema.properties as Record<string, unknown>))) if (key !== 'scene_id') delete (schema.properties as Record<string, unknown>)[key];
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
        const blocked = beforeTool(name);
        if (blocked) output = error(`${blocked} Usage: ${toolUsage(name)}`);
        else if (typeof args.scene_id === 'string' && /<\/?(?:parameter|function|tool_call)\b/.test(args.scene_id)) output = error(`Malformed tool arguments: XML tool tags are embedded in scene_id. Use one API function call with valid JSON arguments; scene_id must be exactly "${sceneId}". Do not place tool markup or another call inside a string.`);
        else if (args.scene_id !== undefined && args.scene_id !== sceneId) output = error(`Only scene_id ${sceneId} is available in this run. Retry ${name} with scene_id exactly "${sceneId}"; do not create or reference another scene ID.`);
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
        return namedColors(output) as ToolResult;
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
