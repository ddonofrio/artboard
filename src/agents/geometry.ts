import type { Bounds, SceneObject, SceneTools } from '../core/index.js';
import { indexedColors } from './colors.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(finite);
const vertices = (value: unknown): value is number[][] => Array.isArray(value) && value.length >= 2 && value.every(point => vector(point, 2));

function cornerBounds(value: unknown, inclusive = false): Bounds | undefined {
  const points = vector(value, 4) ? [[value[0], value[1]], [value[2], value[3]]] : vertices(value) ? value : undefined;
  if (!points) return;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys), extra = inclusive ? 1 : 0;
  return [x, y, Math.max(...xs) - x + extra, Math.max(...ys) - y + extra];
}

function normalizeObject(object: Record<string, unknown>, existing?: SceneObject): void {
  const kind = object.kind ?? existing?.kind;
  if (object.stroke !== undefined) {
    if (kind === 'line') object.color ??= object.stroke;
    else object.outline ??= object.stroke;
    delete object.stroke;
  }
  if (object.fill !== undefined) {
    // Core objects store an ordinary solid fill as `color`; `fill` is reserved
    // for the renderer's extra modes (transparent and dithered fills).
    if (object.fill === 'none' || (object.fill && typeof object.fill === 'object')) {
      // Keep the richer fill value in the core schema.
    } else {
      object.color ??= object.fill;
      delete object.fill;
    }
  }
  const rectangle = kind === 'rect' || kind === 'rectangle' || (kind === 'polygon' && object.points === undefined && (object.rect !== undefined || object.bounds !== undefined || object.height !== undefined));
  const bounded = rectangle || ['circle', 'ellipse', 'procedural', 'sprite'].includes(String(kind));
  if (bounded) {
    let bounds = object.bounds;
    if (bounds === undefined && object.rect !== undefined) bounds = object.rect;
    if (bounds === undefined && [object.x, object.y, object.width, object.height].every(finite)) bounds = [object.x, object.y, object.width, object.height];
    if (bounds === undefined && object.xy !== undefined) bounds = cornerBounds(object.xy, true);
    if (bounds === undefined && object.bbox !== undefined) bounds = cornerBounds(object.bbox);
    if (bounds === undefined && object.points !== undefined) bounds = vector(object.points, 4) ? object.points : cornerBounds(object.points);
    if (bounds === undefined && ['circle', 'ellipse'].includes(String(kind))) {
      const previous = existing?.kind === 'ellipse' ? existing.bounds : undefined;
      const center = object.center ?? (finite(object.cx) && finite(object.cy) ? [object.cx, object.cy] : previous ? [previous[0] + previous[2] / 2, previous[1] + previous[3] / 2] : undefined);
      const radius = object.radius ?? object.r;
      const rx = radius ?? object.rx ?? (previous ? previous[2] / 2 : undefined);
      const ry = radius ?? object.ry ?? (previous ? previous[3] / 2 : undefined);
      if (vector(center, 2) && finite(rx) && finite(ry)) bounds = [center[0] - rx, center[1] - ry, rx * 2, ry * 2];
    }
    if (bounds !== undefined) {
      if (rectangle && vector(bounds, 4)) {
        const [x, y, width, height] = bounds;
        // Keep invalid sizes for validation rather than turning them into a valid polygon.
        if (width <= 0 || height <= 0) { object.bounds = bounds; return; }
        if (object.kind !== undefined) object.kind = 'polygon';
        object.points = [[x,y], [x + width,y], [x + width,y + height], [x,y + height]];
        delete object.bounds;
      } else {
        object.bounds = bounds;
        delete object.points;
        if (kind === 'circle') object.kind = 'ellipse';
      }
      for (const field of ['rect', 'xy', 'bbox', 'x', 'y', 'width', 'height', 'center', 'radius', 'cx', 'cy', 'r', 'rx', 'ry']) delete object[field];
    }
  } else if (kind === 'line' || kind === 'polygon') {
    if (object.points === undefined && object.xy !== undefined) object.points = object.xy;
    if (object.points === undefined && kind === 'line' && object.start !== undefined && object.end !== undefined) object.points = [object.start, object.end];
    if (object.points !== undefined) { delete object.xy; delete object.start; delete object.end; }
    if (kind === 'line' && object.width !== undefined) {
      object.stroke_width ??= object.width;
      delete object.width;
    }
  }
}

/** Translate familiar drawing arguments before the canonical, atomic core edit. */
export function normalizeGeometry(args: Record<string, unknown>, host: SceneTools): Record<string, unknown> {
  const normalized = indexedColors(args) as Record<string, unknown>;
  if (!Array.isArray(normalized.operations)) return normalized;
  const objects = new Map<string, SceneObject>();
  if (normalized.operations.some(operation => operation?.op === 'update')) {
    try { for (const object of host.store.get(String(args.scene_id)).objects) objects.set(object.id, structuredClone(object)); }
    catch (error) { if (!(error instanceof Error && error.message.startsWith('Scene not found:'))) throw error; }
  }
  for (const operation of normalized.operations) {
    if (!operation || typeof operation !== 'object') continue;
    if (operation.op === 'remove') { objects.delete(operation.id); continue; }
    const object = operation.op === 'add' ? operation.object : operation.op === 'update' ? operation.changes : undefined;
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    normalizeObject(object, objects.get(operation.id));
    if (operation.op === 'add') {
      object.layer ??= 0;
      objects.set(object.id, object);
    } else if (operation.op === 'update') {
      const previous = objects.get(operation.id);
      if (previous) objects.set(operation.id, { ...previous, ...object });
    }
  }
  return normalized;
}
