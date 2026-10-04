import { generators, withDefaults } from './catalog.js';
import { hash, idSeed } from './materials.js';
import type { Bounds, Material, MaterialId, Point, ProceduralObject, SceneObject } from './types.js';

export function expandGenerator(object: ProceduralObject): SceneObject[] {
  const p = withDefaults(generators[object.generator].parameters, object.params);
  const [x, y, w, h] = object.bounds;
  const seed = object.seed ?? 1;
  const mat = object.material ?? { id: generators[object.generator].default_material };
  const parts: SceneObject[] = [];
  const common = (name: string) => ({ id: `${object.id}_${name}`, layer: object.layer, seed: idSeed(seed, name), outline: object.outline ?? 0, stroke_width: object.stroke_width ?? 2 });
  const polygon = (name: string, points: Point[], material: Material | undefined = mat, color?: number) => {
    parts.push({ ...common(name), kind: 'polygon', points, ...(material ? { material } : {}), ...(color === undefined ? {} : { color }) });
  };
  const rect = (name: string, bounds: Bounds, material: Material | undefined = mat, color?: number) => {
    const [a, b, c, d] = bounds;
    polygon(name, [[a, b], [a + c, b], [a + c, b + d], [a, b + d]], material, color);
  };
  const ellipse = (name: string, bounds: Bounds, material: Material | undefined = mat, color?: number) => parts.push({ ...common(name), kind: 'ellipse', bounds, ...(material ? { material } : {}), ...(color === undefined ? {} : { color }) });
  const line = (name: string, points: Point[], color = 0, width = 2) => parts.push({ ...common(name), kind: 'line', points, color, stroke_width: width });
  const arch = (bx: number, by: number, bw: number, bh: number): Point[] => {
    if (p.shape !== 'arched') return [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]];
    const points: Point[] = [];
    const radiusY = Math.min(bw / 2, bh * 0.4);
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI + i * Math.PI / 16;
      points.push([bx + bw / 2 + Math.cos(t) * bw / 2, by + radiusY + Math.sin(t) * radiusY]);
    }
    return [...points, [bx + bw, by + bh], [bx, by + bh]];
  };
  switch (object.generator) {
    case 'rock_wall': {
      const pts: Point[] = [];
      const profile = String(p.edge_profile);
      if (profile === 'left') {
        pts.push([x, y], [x + w, y]);
        for (let i = 1; i <= 12; i++) pts.push([x + w - (8 + hash(seed, i) % Math.max(9, Math.floor(w * 0.2))), y + h * i / 12]);
        pts.push([x, y + h]);
      } else if (profile === 'right') {
        pts.push([x + w, y], [x + w, y + h], [x, y + h]);
        for (let i = 11; i >= 0; i--) pts.push([x + hash(seed, i) % Math.max(9, Math.floor(w * 0.2)), y + h * i / 12]);
      } else {
        pts.push([x, y + h], [x + w, y + h], [x + w, y]);
        for (let i = 11; i >= 0; i--) pts.push([x + w * i / 12, y + hash(seed, i) % Math.max(8, Math.floor(h * (profile === 'top' ? 0.25 : 0.07)))]);
      }
      polygon('rock', pts, { ...mat, params: { ...mat.params, density: p.crack_density as number } });
      break;
    }
    case 'opening': {
      const t = Number(p.frame_thickness);
      polygon('frame', arch(x, y, w, h));
      polygon('darkness', arch(x + t, y + t, Math.max(1, w - 2 * t), Math.max(1, h - t)), undefined, Number(p.darkness));
      break;
    }
    case 'gate': {
      polygon('frame', arch(x, y, w, h), undefined, Number(p.metal_color));
      // The frame polygon is used only as an outline; bars preserve the dark opening behind it.
      parts.pop();
      const radiusY = Math.min(w / 2, h * 0.4);
      line('outline', [...arch(x, y, w, h), [x, p.shape === 'arched' ? y + radiusY : y]], Number(p.metal_color), 5);
      for (let i = 1; i <= Number(p.bar_count); i++) {
        const bx = x + i * w / (Number(p.bar_count) + 1);
        const top = p.shape === 'arched' ? y + radiusY - Math.sqrt(Math.max(0, (w / 2) ** 2 - (bx - x - w / 2) ** 2)) * radiusY / (w / 2) : y;
        line(`bar_${i}`, [[bx, top], [bx, y + h]], Number(p.metal_color), 5);
        line(`shine_${i}`, [[bx - 1, top + 3], [bx - 1, y + h - 3]], Number(p.highlight_color), 1);
      }
      for (const fraction of [0.45, 0.8]) line(`cross_${fraction}`, [[x, y + h * fraction], [x + w, y + h * fraction]], Number(p.metal_color), 5);
      rect('lock', [x + w * 0.52, y + h * 0.6, 12, 14], undefined, 15);
      break;
    }
    case 'tree': {
      const height = Number(p.height ?? h), canopy = Number(p.canopy_size ?? w), trunk = Number(p.trunk_width);
      const bottom = y + h, cx = x + w / 2, top = bottom - height;
      polygon('trunk', [[cx - trunk / 2, bottom], [cx - trunk * 0.35, top + height * 0.28], [cx + trunk * 0.35, top + height * 0.28], [cx + trunk / 2, bottom]], { id: 'wood', params: { scale: 0.7 } });
      line('branch_left', [[cx, top + height * 0.62], [cx - canopy * 0.26, top + height * 0.4]], 6, 7);
      line('branch_right', [[cx, top + height * 0.5], [cx + canopy * 0.24, top + height * 0.29]], 6, 6);
      if (p.variant === 'pine') {
        for (let i = 2; i >= 0; i--) polygon(`canopy_${i}`, [[cx, top + i * height * 0.16], [cx + canopy * (0.35 + i * 0.06), top + height * (0.4 + i * 0.16)], [cx - canopy * (0.35 + i * 0.06), top + height * (0.4 + i * 0.16)]], { ...mat, params: { variant: 'leaves', ...mat.params } });
      } else {
        for (let i = 0; i < 5; i++) {
          const dx = (i === 0 ? 0 : ((i & 1) ? -1 : 1)) * canopy * (0.12 + hash(seed, i) % 10 / 100);
          const dy = i === 0 ? height * 0.16 : hash(seed, i, 2) % Math.max(1, Math.floor(height * 0.18));
          ellipse(`canopy_${i}`, [cx - canopy * 0.38 + dx, top + dy, canopy * 0.76, height * 0.35], { ...mat, params: { variant: 'leaves', ...mat.params, seed: idSeed(seed, `leaf${i}`) } });
        }
      }
      break;
    }
    case 'building': {
      const roofH = h * 0.25;
      const walls: Material = object.material ?? { id: (p.wall_material ?? 'masonry') as MaterialId };
      rect('wall', [x, y + roofH, w, h - roofH], walls);
      polygon('side', [[x + w * 0.82, y + roofH], [x + w, y + roofH], [x + w, y + h], [x + w * 0.82, y + h]], { id: 'masonry', params: { foreground: 3, background: 2 } });
      if (p.roof_shape === 'flat') rect('roof', [x - 6, y + roofH - 16, w + 12, 18], { id: 'wood', params: { direction: 'horizontal' } });
      else polygon('roof', [[x - 12, y + roofH], [x + w * 0.43, y], [x + w + 12, y + roofH]], { id: 'wood', params: { direction: 'horizontal', foreground: 6, background: 7 } });
      const doorW = w * 0.17, doorH = h * 0.34;
      rect('door', [x + w * Number(p.door_placement) - doorW / 2, y + h - doorH, doorW, doorH], { id: 'wood' });
      ellipse('knob', [x + w * Number(p.door_placement) + doorW * 0.2, y + h - doorH * 0.4, 4, 4], undefined, 15);
      for (let i = 0; i < Number(p.window_count); i++) {
        const wx = x + w * (0.12 + i * 0.65 / Math.max(1, Number(p.window_count) - 1));
        rect(`window_${i}`, [wx, y + roofH + 18, w * 0.12, h * 0.16], undefined, 1);
        line(`window_cross_${i}`, [[wx + w * 0.06, y + roofH + 18], [wx + w * 0.06, y + roofH + 18 + h * 0.16]], 8, 2);
        rect(`sill_${i}`, [wx - 3, y + roofH + 18 + h * 0.16, w * 0.12 + 6, 5], undefined, 8);
      }
      break;
    }
    case 'path': {
      const dest = (p.destination ?? [x + w / 2, y]) as Point, fw = Number(p.foreground_width), curve = Number(p.curvature), midY = (dest[1] + y + h) / 2;
      polygon('trail', [[dest[0] - 12, dest[1]], [dest[0] + 12, dest[1]], [x + w / 2 + fw * 0.28 + curve, midY], [x + w / 2 + fw / 2, y + h], [x + w / 2 - fw / 2, y + h], [x + w / 2 - fw * 0.28 + curve, midY]]);
      break;
    }
    case 'room_shell': {
      const v = (p.vanishing_point ?? [x + w / 2, y + h * 0.36]) as Point;
      const back = (p.back_wall ?? [v[0] - w * 0.22, v[1] - h * 0.22, w * 0.44, h * 0.48]) as Bounds;
      const [bx, by, bw, bh] = back;
      const walls: Material = object.material ?? { id: (p.wall_material ?? 'plaster') as MaterialId };
      rect('back_wall', back, walls);
      if (p.ceiling) polygon('ceiling', [[x, y], [x + w, y], [bx + bw, by], [bx, by]], { id: 'plaster', params: { foreground: 4, background: 3, density: 0.08 } });
      if (p.side_walls) {
        polygon('left_wall', [[x, y], [bx, by], [bx, by + bh], [x, y + h]], { ...walls, params: { ...walls.params, foreground: 4, background: 3 } });
        polygon('right_wall', [[bx + bw, by], [x + w, y], [x + w, y + h], [bx + bw, by + bh]], { ...walls, params: { ...walls.params, foreground: 3, background: 2 } });
      }
      const quad: Point[] = [[bx, by + bh], [bx + bw, by + bh], [x + w, y + h], [x, y + h]];
      polygon('floor', quad, { id: (p.floor_material ?? 'wood') as MaterialId });
      const floor = parts.at(-1);
      if (floor?.kind === 'polygon') floor.mapping = { quad, size: [640, 640] };
      line('skirting', [[x, y + h], [bx, by + bh], [bx + bw, by + bh], [x + w, y + h]], 6, 5);
      break;
    }
    case 'furniture': {
      const depth = p.facing === 'right' ? w * 0.15 : w * 0.08;
      if (p.variant === 'shelf') {
        rect('body', [x, y, w, h]);
        rect('inside', [x + 8, y + 8, w - 16, h - 16], undefined, 6);
        for (let i = 1; i <= 3; i++) {
          const sy = y + h * i / 4;
          for (let j = 0; j < 4; j++) rect(`item_${i}_${j}`, [x + 13 + j * (w - 22) / 4, sy - h * 0.15, Math.max(4, (w - 35) / 5), h * 0.15], undefined, [7, 3, 11, 15][j]);
          rect(`shelf_${i}`, [x + 4, sy, w - 8, 6]);
        }
      } else if (p.variant === 'chair') {
        rect('back', [x + w * 0.1, y, w * 0.7, h * 0.5]);
        rect('leg_l', [x + w * 0.15, y + h * 0.5, 7, h * 0.5]);
        rect('leg_r', [x + w * 0.75, y + h * 0.5, 7, h * 0.5]);
        polygon('seat', [[x, y + h * 0.48], [x + w - depth, y + h * 0.48], [x + w, y + h * 0.65], [x + depth, y + h * 0.65]]);
      } else {
        rect('leg_back', [x + w * 0.7, y + h * 0.15, 12, h * 0.73], { id: 'wood', params: { foreground: 6, background: 7 } });
        rect('leg_left', [x + depth, y + h * 0.25, 13, h * 0.75]);
        rect('leg_right', [x + w - 22, y + h * 0.25, 13, h * 0.75]);
        polygon('top', [[x, y + h * 0.2], [x + w - depth, y], [x + w, y + h * 0.3], [x + depth, y + h * 0.48]], { ...mat, params: { ...mat.params, direction: 'horizontal' } });
        line('front_edge', [[x + depth, y + h * 0.48], [x + w, y + h * 0.3]], 6, 6);
      }
      break;
    }
  }
  return parts;
}
