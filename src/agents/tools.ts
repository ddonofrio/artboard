import Ajv from 'ajv';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { generators, materials, objectSchema, sceneObjectSchema, toolSchemas, type SceneTools, type ToolResult } from '../core/index.js';

export interface DraftSubmission { revision: number }
export interface Review { revision: number; approved: boolean; issues: { object_id: string; instruction: string }[] }
const shortText = { type: 'string', minLength: 1, maxLength: 1000 };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const draftSubmissionSchema = objectSchema({ revision }, ['revision']);
export const reviewSchema = objectSchema({ revision, approved: { type: 'boolean' }, issues: { type: 'array', maxItems: 3, items: objectSchema({ object_id: { type: 'string', minLength: 1, maxLength: 80 }, instruction: shortText }, ['object_id', 'instruction']) } }, ['revision', 'approved', 'issues']);
const ajv = new Ajv({ strict: false, allErrors: true });
const validateDraft = ajv.compile(draftSubmissionSchema), validateReview = ajv.compile(reviewSchema);
const error = (message: string): ToolResult => ({ ok: false, error: { code: 'AGENT_VALIDATION', message } });

// Describe nesting and geometry without repeating every generator/material
// parameter schema in every operation. The host validates their exact contracts.
const objectVariants = sceneObjectSchema.oneOf as { properties: Record<string, Record<string, unknown>> }[];
const drawingProperties = {
  ...objectVariants[0].properties,
  kind: { type: 'string', enum: ['polygon', 'ellipse', 'line', 'procedural', 'sprite'] },
  points: objectVariants[1].properties.points,
  bounds: objectVariants[2].properties.bounds,
  generator: { type: 'string', enum: Object.keys(generators) },
  asset: objectVariants[3].properties.asset,
  params: { type: 'object', additionalProperties: true, description: 'Generator parameters from scene_catalog category=objects and id=generator.' },
  material: objectSchema({ id: { type: 'string', enum: Object.keys(materials) }, params: { type: 'object', additionalProperties: true } }, ['id']),
};
const drawingSchema = objectSchema(drawingProperties, ['id', 'kind', 'layer']);
drawingSchema.description = 'All drawing fields live in this object, including optional outline and material. Never place drawing fields beside object in the add operation.';
const operationsSchema = structuredClone((toolSchemas.scene_apply.inputSchema.properties as Record<string, Record<string, unknown>>).operations);
operationsSchema.maxItems = 8;
const operationVariants = (operationsSchema.items as { oneOf: { properties: Record<string, unknown> }[] }).oneOf;
operationVariants[0].properties.object = drawingSchema;

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
export function agentTools(host: SceneTools, sceneId: string, role: 'editor' | 'reviewer', signal: AbortSignal | undefined, onTool: (name: string, result: ToolResult, input: Record<string, unknown>) => void | Promise<void>, onDraft: (draft: DraftSubmission) => void, onReview: (review: Review) => void, submissionError: (revision: number) => string | undefined = () => undefined): ToolSet {
  const result: ToolSet = {};
  // Local models can return several calls despite parallel_tool_calls=false.
  // Serialize adapter executions, including presentation of each preview.
  let pending: Promise<unknown> = Promise.resolve();
  const sequential = <T>(execute: () => Promise<T>): Promise<T> => {
    const next = pending.then(execute);
    pending = next.catch(() => {});
    return next;
  };
  const names = role === 'editor' ? ['scene_catalog', 'scene_create', 'scene_inspect', 'scene_apply', 'scene_render', 'scene_history', 'scene_io'] : ['scene_catalog', 'scene_inspect'];
  for (const name of names) {
    const original = toolSchemas[name];
    // The full polymorphic object schema is large. Discovery supplies precise
    // object contracts; the existing dispatcher still validates the full schema.
    const schema = structuredClone(original.inputSchema);
    if ('scene_id' in (schema.properties as Record<string, unknown>)) (schema.properties as Record<string, unknown>).scene_id = { type: 'string', const: sceneId };
    if (name === 'scene_catalog') (schema.properties as Record<string, unknown>).category = { type: 'string', enum: ['palettes', 'materials', 'objects', 'assets', 'tools'] };
    if (name === 'scene_create') {
      const properties = schema.properties as Record<string, unknown>;
      delete properties.recipe; delete properties.recipe_params;
      delete schema.allOf; delete schema.dependencies;
    }
    if (name === 'scene_apply') (schema.properties as Record<string, unknown>).operations = structuredClone(operationsSchema);
    if (name === 'scene_io') {
      const properties = schema.properties as Record<string, unknown>;
      schema.properties = { scene_id: properties.scene_id, action: { const: 'palette' }, palette: properties.palette };
      schema.required = ['scene_id', 'action', 'palette'];
    }
    result[name] = tool({
      description: name === 'scene_create' ? 'Create an EMPTY drawing surface. Build scenery progressively with scene_apply. No recipes or prebuilt scenes.' : name === 'scene_io' ? 'Set an editable palette with action=palette. Other file operations are unavailable to agents.' : original.description,
      inputSchema: jsonSchema<Record<string, unknown>>(schema),
      execute: args => sequential(async () => {
        signal?.throwIfAborted();
        let output: ToolResult;
        if (typeof args.scene_id === 'string' && /<\/?(?:parameter|function|tool_call)\b/.test(args.scene_id)) output = error(`Malformed tool arguments: XML tool tags are embedded in scene_id. Use one API function call with valid JSON arguments; scene_id must be exactly "${sceneId}". Do not place tool markup or another call inside a string.`);
        else if (args.scene_id !== undefined && args.scene_id !== sceneId) output = error(`Only scene_id ${sceneId} is available in this run. Retry ${name} with scene_id exactly "${sceneId}"; do not create or reference another scene ID.`);
        else if (name === 'scene_create' && ('recipe' in args || 'recipe_params' in args)) output = error('Agents create empty scenes only. Build the requested scenery with scene_apply in small batches.');
        else if (name === 'scene_apply' && Array.isArray(args.operations) && args.operations.length > 8) output = error('Use at most 8 operations per call so each part of the composition is visible.');
        else if (name === 'scene_io' && args.action !== 'palette') output = error('Agents can only use scene_io to change the palette.');
        else if (name === 'scene_catalog' && args.category === 'recipes') output = error('Prebuilt scenes are unavailable to agents. Compose objects with scene_apply instead.');
        else if (name === 'scene_catalog' && (!args.category || args.category === 'tools')) output = { ok: true, result: { message: 'Choose category palettes, materials, objects, or assets. Query a single ID for details. Primitive kinds: polygon, ellipse, line; procedural kinds use the objects catalog.', categories: ['palettes', 'materials', 'objects', 'assets'] } };
        else if (name === 'scene_apply' && misplacedObjectField(args)) output = error(misplacedObjectField(args)!);
        else output = await host.dispatch({ tool: name, arguments: args });
        if (!output.ok && name === 'scene_apply') {
          output.error.message += ' Correct the rejected field and retry a small batch; no operations from this batch were applied. Polygon/line geometry uses points; circles use kind=ellipse with bounds. Color belongs inside object and must be a valid palette index. For generator/material parameters, consult scene_catalog with the relevant category and ID instead of repeating the same invalid call.';
        }
        // Do not inject base64 as prose in tool messages. The host supplies the
        // preview as a real image part in the editor's next model request.
        if (name === 'scene_render' && output.ok) output = { ok: true, result: { ...output.result, image_ref: 'Current preview is attached to the next model request when vision is enabled.' } };
        await onTool(name, output, args);
        return output;
      }),
    });
  }
  const name = role === 'editor' ? 'finish_draft' : 'submit_review';
  result[name] = tool({
    description: role === 'editor' ? 'Submit only the completed drawing revision to the independent reviewer. No narrative or choices. Call alone, after edits.' : 'Approve this exact drawing revision or return minimal drawing corrections. Read-only; call alone.',
    inputSchema: jsonSchema<Record<string, unknown>>(role === 'editor' ? draftSubmissionSchema : reviewSchema),
    execute: value => sequential(async () => {
      signal?.throwIfAborted();
      const validator = role === 'editor' ? validateDraft : validateReview;
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
          if (unknown) output = error(`Unknown object ID ${unknown.object_id}. Use an existing object ID or scene.`);
          else if (review.approved && review.issues.length) output = error('An approved review must have no unresolved issues.');
          else if (!review.approved && !review.issues.length) output = error('A rejected review needs at least one actionable issue.');
          else { onReview(structuredClone(review)); output = { ok: true, result: { revision: scene.revision, submitted: true } }; }
        }
      }
      await onTool(name, output, value);
      return output;
    }),
  });
  return result;
}
