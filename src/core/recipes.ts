import { recipes, withDefaults } from './catalog.js';
import { expandGenerator } from './generators.js';
import { idSeed } from './materials.js';
import type { Bounds, MaterialId, Params, Point, ProceduralObject, RecipeId, SceneObject } from './types.js';

/** Recipes expand to ordinary individually editable objects in 640 x 480 design coordinates. */
export function expandRecipe(id: RecipeId, seed: number, values: Params = {}, width = 640, height = 480): SceneObject[] {
  const p = withDefaults(recipes[id].parameters, values);
  const objects: SceneObject[] = [];
  const poly = (name: string, points: Point[], layer: number, material?: MaterialId, color?: number, params?: Params) => objects.push({ id: name, kind: 'polygon', points, layer, seed: idSeed(seed, name), ...(material ? { material: { id: material, params } } : {}), ...(color === undefined ? {} : { color }) });
  const rect = (name: string, bounds: Bounds, layer: number, material?: MaterialId, color?: number, params?: Params) => { const [x, y, w, h] = bounds; poly(name, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer, material, color, params); };
  const proc = (name: string, generator: ProceduralObject['generator'], bounds: Bounds, layer: number, params: Params = {}, material?: MaterialId) => objects.push({ id: name, kind: 'procedural', generator, bounds, layer, seed: idSeed(seed, name), params, ...(material ? { material: { id: material } } : {}) });
  const ellipse = (name: string, bounds: Bounds, layer: number, material?: MaterialId, color?: number, params?: Params) => objects.push({ id: name, kind: 'ellipse', bounds, layer, seed: idSeed(seed, name), ...(material ? { material: { id: material, params } } : {}), ...(color === undefined ? {} : { color }) });
  const focal = Number(p.focal_x ?? 320);
  const outdoor = ['cave_entrance', 'forest_path', 'village_exterior'].includes(id);
  if (outdoor) {
    rect('sky', [0, 0, 640, 480], 0, 'sky');
    ellipse('cloud_left', [80, 38, 150, 24], 1, undefined, 14);
    ellipse('cloud_right', [395, 73, 170, 18], 1, undefined, 14);
    poly('distant_hills', [[0, 205], [85, 165], [170, 189], [282, 123], [393, 165], [493, 144], [640, 207], [640, 370], [0, 370]], 2, 'vegetation', undefined, { variant: 'leaves', foreground: 10, background: 11, density: 0.16 });
    rect('ground', [0, 288, 640, 192], 5, id === 'forest_path' ? 'vegetation' : 'earth');
  }
  switch (id) {
    case 'cave_entrance':
      proc('path', 'path', [0, 330, 640, 150], 10, { destination: [focal, 330], foreground_width: 250, curvature: -18 });
      proc('cave_face', 'rock_wall', [focal - 202, 115, 404, 246], 20, { edge_profile: 'top', crack_density: p.crack_density as number });
      proc('opening', 'opening', [focal - 68, 156, 136, 205], 30, { shape: 'arched', frame_thickness: 11 });
      proc('entrance_gate', 'gate', [focal - 54, 168, 108, 191], 31, { shape: 'arched', bar_count: p.gate_bars as number });
      proc('left_cliff', 'rock_wall', [-20, 48, 208, 432], 40, { edge_profile: 'left', crack_density: p.crack_density as number });
      proc('right_cliff', 'rock_wall', [464, 89, 196, 391], 40, { edge_profile: 'right', crack_density: p.crack_density as number });
      ellipse('left_moss', [2, 410, 159, 96], 45, 'vegetation', undefined, { variant: 'leaves', foreground: 10, background: 11 });
      ellipse('right_moss', [500, 437, 178, 81], 45, 'vegetation', undefined, { variant: 'leaves', foreground: 10, background: 11 });
      break;
    case 'forest_path':
      for (let i = 0; i < 8; i++) proc(`distant_tree_${i}`, 'tree', [i * 88 - 25, 160 + (i % 2) * 10, 94, 174], 8, { variant: 'pine', trunk_width: 7 });
      proc('path', 'path', [0, 270, 640, 210], 10, { destination: [focal, 272], foreground_width: 300, curvature: p.path_curve as number });
      proc('tree_left', 'tree', [12, 68, 190, Number(p.tree_height)], 20, { variant: 'round', trunk_width: 24 });
      proc('tree_right', 'tree', [432, 54, 210, Number(p.tree_height) + 15], 20, { variant: 'round', trunk_width: 27 });
      proc('foreground_tree', 'tree', [-84, -23, 220, 495], 40, { variant: 'pine', trunk_width: 38 }, 'vegetation');
      ellipse('foreground_left', [-40, 416, 200, 110], 50, 'vegetation', undefined, { variant: 'leaves', foreground: 10, background: 0 });
      ellipse('foreground_right', [510, 408, 185, 122], 50, 'vegetation', undefined, { variant: 'leaves', foreground: 10, background: 0 });
      break;
    case 'village_exterior':
      rect('courtyard', [0, 315, 640, 165], 6, (p.ground ?? 'earth') as MaterialId);
      proc('path', 'path', [0, 278, 640, 202], 10, { destination: [focal, 278], foreground_width: 240, curvature: 20 });
      proc('house_left', 'building', [70, 137, 221, 226], 20, { window_count: p.window_count as number, door_placement: 0.63 });
      proc('house_right', 'building', [369, 166, 218, 211], 21, { window_count: p.window_count as number, roof_shape: 'gable', door_placement: 0.3 });
      proc('village_tree', 'tree', [-37, 81, 138, 326], 30, { variant: 'round', trunk_width: 18 });
      proc('foreground_rock', 'rock_wall', [495, 426, 155, 65], 40, { edge_profile: 'top', crack_density: 0.25 });
      ellipse('grass', [-35, 421, 172, 83], 40, 'vegetation');
      break;
    default: {
      const corridor = id === 'stone_corridor', utility = id === 'utility_room';
      const v = (p.vanishing_point ?? [320, 170]) as Point;
      const room: ProceduralObject = { id: 'room', kind: 'procedural', generator: 'room_shell', layer: 0, seed: idSeed(seed, 'room'), bounds: [0, 0, 640, 480], params: { vanishing_point: v, wall_material: corridor ? 'masonry' : 'plaster', floor_material: (p.floor_variant ?? (utility ? 'tiles' : corridor ? 'tiles' : 'wood')) as string } };
      objects.push(...expandGenerator(room));
      if (corridor) {
        proc('doorway', 'opening', [v[0] - 48, v[1] - 25, 96, 150], 10, { shape: p.doorway_shape as string, frame_thickness: 7 });
        poly('floor_shadow', [[v[0] - 38, v[1] + 125], [v[0] + 38, v[1] + 125], [420, 480], [220, 480]], 9, 'stone', undefined, { foreground: 2, background: 1, density: 0.1 });
        rect('left_lamp', [75, 145, 12, 24], 15, undefined, 15);
        rect('right_lamp', [553, 145, 12, 24], 15, undefined, 15);
      } else if (utility) {
        proc('doorway', 'opening', [v[0] - 54, 113, 106, 182], 10, { shape: 'rectangular', frame_thickness: 6 });
        rect('metal_door', [v[0] - 46, 121, 90, 173], 11, 'metal');
        rect('door_handle', [v[0] + 24, 215, 13, 4], 12, undefined, 15);
        proc('storage', 'furniture', [Number(p.shelf_x), 160, 115, 235], 20, { variant: 'shelf', facing: 'front' });
        proc('chair', 'furniture', [125, 303, 84, 126], 25, { variant: 'chair', facing: 'right' });
        rect('vent', [v[0] - 25, 66, 48, 28], 15, 'metal');
      } else {
        rect('window_frame', [v[0] - 128, 114, 102, 91], 10, 'wood');
        rect('window_sky', [v[0] - 121, 121, 88, 77], 11, 'sky');
        poly('window_hills', [[v[0] - 121, 165], [v[0] - 84, 145], [v[0] - 33, 173], [v[0] - 33, 198], [v[0] - 121, 198]], 12, 'vegetation');
        rect('window_cross_v', [v[0] - 81, 118, 5, 84], 13, undefined, 6);
        rect('window_cross_h', [v[0] - 124, 155, 95, 4], 13, undefined, 6);
        proc('shelf', 'furniture', [419, 154, 109, 215], 20, { variant: 'shelf', facing: 'front' });
        proc('table', 'furniture', [Number(p.table_x), 326, 227, 125], 30, { variant: 'table', facing: 'right' });
        ellipse('table_bowl', [Number(p.table_x) + 75, 337, 43, 15], 31, 'earth', undefined, { foreground: 15, background: 8 });
      }
    }
  }
  const sx = width / 640, sy = height / 480;
  if (sx !== 1 || sy !== 1) for (const object of objects) {
    if ('points' in object) object.points = object.points.map(([x, y]) => [x * sx, y * sy]);
    if ('bounds' in object) object.bounds = [object.bounds[0] * sx, object.bounds[1] * sy, object.bounds[2] * sx, object.bounds[3] * sy];
    if (object.kind === 'polygon' && object.mapping) object.mapping.quad = object.mapping.quad.map(([x, y]) => [x * sx, y * sy]);
    if (object.kind === 'procedural' && object.params) {
      if (Array.isArray(object.params.destination)) object.params.destination = [object.params.destination[0] * sx, object.params.destination[1] * sy];
      if (typeof object.params.foreground_width === 'number') object.params.foreground_width *= sx;
      if (typeof object.params.curvature === 'number') object.params.curvature *= sx;
    }
  }
  return objects;
}
