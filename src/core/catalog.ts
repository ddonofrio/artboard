import type { AssetManifest, GeneratorId, MaterialId, Palette, RecipeId } from './types.js';
import { BASIC_PALETTE } from './colors.js';

export type Schema = Record<string, unknown>;
export const number = (minimum: number, maximum: number, defaultValue?: number): Schema => ({ type: 'number', minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
export const integer = (minimum: number, maximum: number, defaultValue?: number): Schema => ({ ...number(minimum, maximum, defaultValue), type: 'integer' });
export const choice = (values: string[], defaultValue = values[0]): Schema => ({ type: 'string', enum: values, default: defaultValue });
export const pointSchema: Schema = { type: 'array', items: number(-4096, 4096), minItems: 2, maxItems: 2 };
export const boundsSchema: Schema = { type: 'array', items: [number(-4096, 4096), number(-4096, 4096), number(1, 4096), number(1, 4096)], minItems: 4, maxItems: 4, additionalItems: false };
export const objectSchema = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

export const palettes: Record<string, Palette> = {
  basic: BASIC_PALETTE,
};

interface Entry { description: string; parameters: Record<string, Schema>; example: Record<string, unknown> }
const shared = { scale: number(0.5, 8, 1), density: number(0, 1, 0.35), foreground: integer(0, 15), background: integer(0, 15), seed: integer(0, 4294967295) };
export const materials: Record<MaterialId, Entry & { colors: [number, number] }> = {
  stone: { description: 'Irregular cracks and sparse stipple.', colors: [7, 8], parameters: { ...shared, irregularity: number(0, 1, 0.7), dark_edges: { type: 'boolean', default: true } }, example: { id: 'stone', params: { density: 0.4 } } },
  masonry: { description: 'Staggered blocks, mortar and block variation.', colors: [7, 8], parameters: { ...shared, irregularity: number(0, 1, 0.35), mortar: integer(1, 4, 1) }, example: { id: 'masonry', params: { scale: 1.5 } } },
  wood: { description: 'Planks, grain and occasional knots.', colors: [6, 4], parameters: { ...shared, direction: choice(['vertical', 'horizontal']), irregularity: number(0, 1, 0.4) }, example: { id: 'wood', params: { direction: 'horizontal' } } },
  plaster: { description: 'Restrained grain and optional cracks.', colors: [15, 7], parameters: { ...shared, cracks: { type: 'boolean', default: false } }, example: { id: 'plaster', params: { density: 0.12 } } },
  tiles: { description: 'Rectangular tiles with grout.', colors: [7, 8], parameters: { ...shared, grout: integer(1, 4, 1), variant: choice(['square', 'rectangular']) }, example: { id: 'tiles', params: { variant: 'square' } } },
  earth: { description: 'Pebbles, stipple and short marks.', colors: [6, 4], parameters: shared, example: { id: 'earth', params: { density: 0.25 } } },
  vegetation: { description: 'Grass strokes or clustered leaves.', colors: [10, 2], parameters: { ...shared, variant: choice(['grass', 'leaves']) }, example: { id: 'vegetation', params: { variant: 'leaves' } } },
  water: { description: 'Broken horizontal ripples and highlights.', colors: [9, 15], parameters: shared, example: { id: 'water', params: { scale: 1.5 } } },
  sky: { description: 'Flat sky or two-tone ordered dither.', colors: [9, 15], parameters: { ...shared, variant: choice(['flat', 'dither'], 'dither') }, example: { id: 'sky', params: { variant: 'dither' } } },
  metal: { description: 'Dark metal with narrow highlights and wear.', colors: [7, 8], parameters: { ...shared, wear: { type: 'boolean', default: true } }, example: { id: 'metal', params: { density: 0.15 } } },
};
export const generators: Record<GeneratorId, Entry & { default_material: MaterialId }> = {
  rock_wall: { description: 'Rock silhouette with jagged edge profile.', default_material: 'stone', parameters: { edge_profile: choice(['full', 'left', 'right', 'top']), crack_density: number(0, 1, 0.4) }, example: { generator: 'rock_wall', bounds: [0, 100, 180, 380], params: { edge_profile: 'left' } } },
  opening: { description: 'Dark rectangular or arched opening with a frame.', default_material: 'masonry', parameters: { shape: choice(['rectangular', 'arched']), frame_thickness: integer(1, 24, 8), darkness: integer(0, 15, 0) }, example: { generator: 'opening', bounds: [240, 150, 140, 200], params: { shape: 'arched' } } },
  gate: { description: 'Rectangular or arched metal gate.', default_material: 'metal', parameters: { shape: choice(['rectangular', 'arched']), bar_count: integer(2, 20, 6), metal_color: integer(0, 15, 8), highlight_color: integer(0, 15, 7) }, example: { generator: 'gate', bounds: [260, 180, 100, 170], params: { shape: 'arched', bar_count: 5 } } },
  tree: { description: 'Seeded layered canopy and outlined trunk. Bounds set the silhouette; height and canopy_size override its size.', default_material: 'vegetation', parameters: { height: number(30, 700), trunk_width: number(4, 80, 18), canopy_size: number(25, 500), variant: choice(['round', 'pine']) }, example: { generator: 'tree', bounds: [30, 120, 170, 340], params: { variant: 'pine', trunk_width: 20 } } },
  building: { description: 'Facade with roof, windows and wooden door.', default_material: 'masonry', parameters: { roof_shape: choice(['gable', 'flat']), wall_material: choice(Object.keys(materials), 'masonry'), window_count: integer(0, 6, 2), door_placement: number(0.15, 0.85, 0.5) }, example: { generator: 'building', bounds: [90, 130, 240, 230], params: { roof_shape: 'gable', window_count: 2 } } },
  path: { description: 'Narrowing path from foreground to destination.', default_material: 'earth', parameters: { foreground_width: number(20, 1000, 260), destination: pointSchema, curvature: number(-150, 150, 0) }, example: { generator: 'path', bounds: [0, 250, 640, 230], params: { destination: [320, 260], foreground_width: 260 } } },
  room_shell: { description: 'Back, side and ceiling planes plus a projectively mapped floor.', default_material: 'plaster', parameters: { vanishing_point: pointSchema, back_wall: boundsSchema, wall_material: choice(Object.keys(materials), 'plaster'), floor_material: choice(Object.keys(materials), 'wood'), side_walls: { type: 'boolean', default: true }, ceiling: { type: 'boolean', default: true } }, example: { generator: 'room_shell', bounds: [0, 0, 640, 480], params: { vanishing_point: [320, 170], floor_material: 'wood' } } },
  furniture: { description: 'Outlined table, chair or shelf. Front and right-facing projections only.', default_material: 'wood', parameters: { variant: choice(['table', 'chair', 'shelf']), facing: choice(['front', 'right']) }, example: { generator: 'furniture', bounds: [160, 300, 230, 130], params: { variant: 'table', facing: 'right' } } },
};
export const recipes: Record<RecipeId, Entry & { palette: string }> = {
  cave_entrance: { description: 'Rock entrance, gate, winding path and sky.', palette: 'basic', parameters: { focal_x: number(220, 420, 320), gate_bars: integer(2, 12, 6), crack_density: number(0, 1, 0.4) }, example: { recipe: 'cave_entrance', recipe_params: { gate_bars: 5 } } },
  forest_path: { description: 'Layered woodland and a narrowing trail.', palette: 'basic', parameters: { focal_x: number(220, 420, 320), tree_height: number(200, 440, 340), path_curve: number(-100, 100, 30) }, example: { recipe: 'forest_path', recipe_params: { path_curve: -40 } } },
  village_exterior: { description: 'Masonry houses, wooden details and courtyard.', palette: 'basic', parameters: { focal_x: number(220, 420, 320), window_count: integer(0, 4, 2), ground: choice(['earth', 'tiles']) }, example: { recipe: 'village_exterior', recipe_params: { ground: 'tiles' } } },
  stone_corridor: { description: 'Converging masonry walls and floor towards a doorway.', palette: 'basic', parameters: { vanishing_point: pointSchema, floor_variant: choice(['tiles', 'stone']), doorway_shape: choice(['rectangular', 'arched'], 'arched') }, example: { recipe: 'stone_corridor', recipe_params: { vanishing_point: [320, 170] } } },
  wooden_room: { description: 'Plaster room, plank floor, window, table and shelf.', palette: 'basic', parameters: { vanishing_point: pointSchema, floor_variant: choice(['wood', 'tiles']), table_x: number(100, 350, 180) }, example: { recipe: 'wooden_room', recipe_params: { table_x: 240 } } },
  utility_room: { description: 'Tiled room, metal door and storage furniture.', palette: 'basic', parameters: { vanishing_point: pointSchema, floor_variant: choice(['tiles', 'wood']), shelf_x: number(340, 450, 390) }, example: { recipe: 'utility_room', recipe_params: { floor_variant: 'tiles' } } },
};
export const assetManifest: AssetManifest[] = [];
export function withDefaults(parameters: Record<string, Schema>, values: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(parameters).filter(([, v]) => 'default' in v).map(([k, v]) => [k, v.default])), ...values };
}
