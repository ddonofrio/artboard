import { generators, materials, palettes, recipes } from './catalog.js';
import { SceneStore } from './engine.js';
import { PixelRenderer } from './renderer.js';
import { fail, SceneError, sceneSchema, toolSchemas, validateTool } from './schema.js';
import type { Bounds, Operation, Palette, Params, RecipeId, Scene, ToolAdapter, ToolRequest, ToolResult } from './types.js';

const usage: Record<string, string> = {
  scene_catalog: 'Query category=palettes/materials/objects/recipes/assets/tools, optionally with an id from that category.',
  scene_create: 'Pass scene_id and optional width,height,palette,seed; use an unused scene_id.',
  scene_inspect: 'Pass scene_id and optionally ids:[existingObjectId,...]; omit ids for a summary.',
  scene_apply: 'Pass scene_id and operations:[{op:"add",object:{id,kind,layer,...}},{op:"update",id,changes:{...}}]. Ellipse uses bounds:[x,y,width,height]; star uses center:[x,y],radius with optional tips, inner_radius smaller than radius, and clockwise rotation in degrees; polygon uses at least 3 [x,y] points; line uses at least 2. Use existing IDs for update/remove/reorder and valid palette indices. Failed batches are not applied.',
  scene_render: 'Pass scene_id; crop:[x,y,width,height] must fit the canvas and scale must be an integer 1-4.',
  scene_history: 'Pass scene_id, action:"undo"/"redo", and steps=1..64 within available history.',
  scene_io: 'Pass scene_id and action:"palette" with palette, or action:"save"/"load"/"export" with an adapter-scoped filename. Load can also receive scene JSON.',
};

export class SceneTools {
  constructor(public readonly store: SceneStore, public readonly renderer: PixelRenderer, private readonly adapter: ToolAdapter) {}
  private async run(tool: string, args: Record<string, unknown>, execute: () => unknown | Promise<unknown>): Promise<ToolResult> {
    try {
      validateTool(tool, args);
      return { ok: true, result: structuredClone(await execute()) as Record<string, unknown> };
    } catch (error) {
      if (error instanceof SceneError) {
        const detail = { ...error.detail };
        const match = detail.field?.match(/operations\/(\d+)/);
        if (match && detail.operation === undefined) detail.operation = Number(match[1]);
        detail.message = `${tool}: ${detail.message} Usage: ${usage[tool] ?? 'Use an advertised tool and its argument schema.'}`;
        return { ok: false, error: detail };
      }
      return { ok: false, error: { code: 'ADAPTER_ERROR', message: `${tool}: ${error instanceof Error ? error.message : 'The adapter failed without a diagnostic.'} Check the configured image/file adapter before retrying. Usage: ${usage[tool] ?? 'Use an advertised tool and its argument schema.'}` } };
    }
  }
  scene_catalog(args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.run('scene_catalog', args, () => {
      const catalog: Record<string, unknown> = { palettes, materials, objects: generators, recipes, assets: this.renderer.assetCatalog(), tools: toolSchemas };
      if (!args.category) return catalog;
      const category = catalog[args.category as string];
      if (!args.id) return { [args.category as string]: category };
      const item = Array.isArray(category) ? category.find(a => a.id === args.id) : (category as Record<string, unknown>)[args.id as string];
      if (!item) fail('CATALOG_NOT_FOUND', `No ${String(args.id)} in ${String(args.category)}`, 'id');
      return { id: args.id, item };
    });
  }
  scene_create(args: Record<string, unknown>): Promise<ToolResult> {
    return this.run('scene_create', args, () => {
      const scene = this.store.create(args as unknown as { scene_id: string; width?: number; height?: number; palette?: string | Palette; seed?: number; recipe?: RecipeId; recipe_params?: Params });
      return { scene_id: scene.id, revision: scene.revision, affected_ids: scene.objects.map(o => o.id) };
    });
  }
  scene_inspect(args: Record<string, unknown>): Promise<ToolResult> { return this.run('scene_inspect', args, () => this.store.inspect(args.scene_id as string, args.ids as string[] | undefined)); }
  scene_apply(args: Record<string, unknown>): Promise<ToolResult> { return this.run('scene_apply', args, () => this.store.apply(args.scene_id as string, args.operations as Operation[], args.expected_revision as number | undefined)); }
  scene_render(args: Record<string, unknown>): Promise<ToolResult> {
    return this.run('scene_render', args, async () => {
      const scene = this.store.get(args.scene_id as string), image = this.renderer.render(scene, { crop: args.crop as Bounds | undefined, scale: args.scale as number | undefined });
      const imageRef = await this.adapter.preview(image, `${scene.id}-r${scene.revision}.png`);
      return { scene_id: scene.id, revision: scene.revision, image_ref: imageRef, width: image.width, height: image.height };
    });
  }
  scene_history(args: Record<string, unknown>): Promise<ToolResult> {
    return this.run('scene_history', args, () => {
      const scene = this.store.history(args.scene_id as string, args.action as 'undo' | 'redo', args.steps as number | undefined);
      return { scene_id: scene.id, revision: scene.revision, history: this.store.historyInfo(scene.id) };
    });
  }
  scene_io(args: Record<string, unknown>): Promise<ToolResult> {
    return this.run('scene_io', args, async () => {
      const id = args.scene_id as string;
      if (args.action === 'load') {
        if (!args.scene && !args.filename) fail('VALIDATION', 'Load requires scene data or a filename', 'scene');
        const scene = this.store.load(id, args.scene ?? await this.adapter.loadJSON(args.filename as string));
        return { scene_id: id, revision: scene.revision, affected_ids: scene.objects.map(o => o.id) };
      }
      if (args.action === 'palette') {
        if (!args.palette) fail('VALIDATION', 'Palette action requires palette', 'palette');
        const scene = this.store.palette(id, args.palette as string | Palette);
        return { scene_id: id, revision: scene.revision };
      }
      const scene = this.store.get(id);
      const reference = args.action === 'save'
        ? await this.adapter.saveJSON(scene, args.filename as string ?? `${id}.json`)
        : await this.adapter.exportPNG(this.renderer.render(scene, { scale: args.scale as number | undefined }), args.filename as string ?? `${id}.png`);
      return { scene_id: id, revision: scene.revision, file_ref: reference };
    });
  }
  async dispatch(request: ToolRequest): Promise<ToolResult> {
    if (!request || typeof request !== 'object' || typeof request.tool !== 'string') return { ok: false, error: { code: 'VALIDATION', message: 'dispatch: Request requires tool and arguments. Usage: {tool:"scene_apply",arguments:{scene_id,operations:[...]}}; use a tool name from scene_catalog category="tools".', field: 'tool' } };
    const args = request.arguments;
    switch (request.tool) {
      case 'scene_catalog': return this.scene_catalog(args ?? {});
      case 'scene_create': return this.scene_create(args);
      case 'scene_inspect': return this.scene_inspect(args);
      case 'scene_apply': return this.scene_apply(args);
      case 'scene_render': return this.scene_render(args);
      case 'scene_history': return this.scene_history(args);
      case 'scene_io': return this.scene_io(args);
      default: return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `dispatch: Unknown tool: ${request.tool}. Usage: choose a tool from scene_catalog category="tools" and pass {tool,arguments}.`, field: 'tool' } };
    }
  }
}
export function requireResult<T = Record<string, unknown>>(result: ToolResult): T {
  if (!result.ok) throw new SceneError(result.error);
  return result.result as T;
}
export { sceneSchema, toolSchemas };
export type { Scene };
