export type Point = [number, number];
export type Bounds = [number, number, number, number];
export type Params = Record<string, string | number | boolean | Point | Bounds>;
export type MaterialId = 'stone' | 'masonry' | 'wood' | 'plaster' | 'tiles' | 'earth' | 'vegetation' | 'water' | 'sky' | 'metal';
export type GeneratorId = 'rock_wall' | 'opening' | 'gate' | 'tree' | 'building' | 'path' | 'room_shell' | 'furniture';
export type RecipeId = 'cave_entrance' | 'forest_path' | 'village_exterior' | 'stone_corridor' | 'wooden_room' | 'utility_room';
export interface Palette { id: string; name: string; colors: string[] }
export interface Material { id: MaterialId; params?: Params }
export interface ObjectBase {
  id: string;
  layer: number;
  seed?: number;
  tags?: string[];
  material?: Material;
  color?: number;
  outline?: number;
  stroke_width?: number;
}
export interface PolygonObject extends ObjectBase { kind: 'polygon'; points: Point[]; mapping?: { quad: Point[]; size: Point } }
export interface LineObject extends ObjectBase { kind: 'line'; points: Point[] }
export interface EllipseObject extends ObjectBase { kind: 'ellipse'; bounds: Bounds }
export interface ProceduralObject extends ObjectBase { kind: 'procedural'; generator: GeneratorId; bounds: Bounds; params?: Params }
export interface SpriteObject extends ObjectBase { kind: 'sprite'; asset: string; bounds: Bounds }
export type SceneObject = PolygonObject | LineObject | EllipseObject | ProceduralObject | SpriteObject;
export interface Scene {
  version: 1;
  renderer_version: string;
  id: string;
  width: number;
  height: number;
  palette: Palette;
  seed: number;
  revision: number;
  objects: SceneObject[];
}
export type Operation =
  | { op: 'add'; object: SceneObject }
  | { op: 'update'; id: string; changes: Record<string, unknown> }
  | { op: 'remove'; id: string }
  | { op: 'reorder'; id: string; layer?: number; position?: number };
export interface PixelImage { width: number; height: number; data: Uint8ClampedArray }
export interface AssetManifest { id: string; description: string; width: number; height: number; anchor: Point; tags: string[] }
export interface SpriteAsset { manifest: AssetManifest; image: PixelImage }
export interface RenderOptions { crop?: Bounds; scale?: number }
export interface ToolError { code: string; message: string; operation?: number; field?: string }
export type ToolResult<T = Record<string, unknown>> = { ok: true; result: T } | { ok: false; error: ToolError };
export interface ToolRequest { tool: string; arguments: Record<string, unknown> }
export interface ToolAdapter {
  preview(image: PixelImage, name: string): Promise<string>;
  exportPNG(image: PixelImage, name: string): Promise<string>;
  saveJSON(scene: Scene, name: string): Promise<string>;
  loadJSON(name: string): Promise<unknown>;
}
export const RENDERER_VERSION = '1.0.0';
