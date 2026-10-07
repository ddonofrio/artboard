import { COLOR_FIELDS, COLOR_NAMES, colorIndex, type Scene, type SceneObject } from '../core/index.js';

export const namedColorSchema = { type: 'string', enum: [...COLOR_NAMES], description: 'Choose one of the 16 fixed English color names.' };

function rectangle(points: [number,number][]): [number,number,number,number] | undefined {
  if (points.length !== 4) return;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs)-x, height = Math.max(...ys)-y;
  if (!width || !height) return;
  const corners = new Set(points.map(point => `${point[0]},${point[1]}`));
  if (corners.size !== 4 || ![[x,y],[x+width,y],[x+width,y+height],[x,y+height]].every(point => corners.has(`${point[0]},${point[1]}`))) return;
  return [x,y,width,height];
}

/** Compact drawing state: standard geometry and named colors, without storage fields. */
export function drawingScene(scene: Scene): Record<string, unknown> {
  const objects = scene.objects.map((object: SceneObject): Record<string, unknown> => {
    const style = {
      ...('color' in object && object.color !== undefined ? { fill: object.color } : {}),
      ...('fill' in object && object.fill !== undefined ? { fill: object.fill } : {}),
      ...(object.kind !== 'line' && object.outline !== undefined ? { stroke: object.outline } : {}),
      ...(object.kind === 'line' && object.color !== undefined ? { stroke: object.color } : {}),
      ...(object.stroke_width !== undefined ? { stroke_width: object.stroke_width } : {}),
      ...('rotation' in object && object.rotation ? { rotation: object.rotation } : {}),
    };
    if (object.kind === 'polygon') {
      const bounds = rectangle(object.points);
      return bounds ? { id: object.id, kind: 'rect', x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3], ...style }
        : { id: object.id, kind: 'polygon', points: object.points, ...style };
    }
    if (object.kind === 'ellipse') {
      const [x,y,width,height]=object.bounds, cx=x+width/2, cy=y+height/2;
      return width===height ? { id:object.id,kind:'circle',cx,cy,radius:width/2,...style } : { id:object.id,kind:'ellipse',cx,cy,rx:width/2,ry:height/2,...style };
    }
    if (object.kind === 'line') return { id:object.id,kind:'line',points:object.points,...style };
    if (object.kind === 'star') return { id:object.id,kind:'saved object' };
    return { id:object.id,kind:'saved object' };
  });
  return { width:scene.width,height:scene.height,revision:scene.revision,objects:namedColors(objects) };
}

/** Model-facing data uses names; stored scenes and the renderer use indices. */
export function namedColors(value: unknown, key = ''): unknown {
  if (COLOR_FIELDS.has(key) && Number.isInteger(value) && Number(value) >= 0 && Number(value) < COLOR_NAMES.length) return COLOR_NAMES[Number(value)];
  if (Array.isArray(value)) {
    if (key === 'colors') return value.map(color => typeof color === 'number' ? COLOR_NAMES[color] : color);
    return value.map(item => namedColors(item));
  }
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (key === 'palette' && Array.isArray(object.colors)) return { id: 'basic', name: 'Basic', colors: [...COLOR_NAMES] };
  return Object.fromEntries(Object.entries(object).map(([field, item]) => [field, namedColors(item, field)]));
}

/** Convert named drawing arguments, including material and generator colors. */
export function indexedColors(value: unknown, key = ''): unknown {
  if (key === 'colors' && Array.isArray(value)) return value.map(colorIndex);
  if (key === 'fill' && value && typeof value === 'object' && !Array.isArray(value)) return indexedColors(value);
  if (COLOR_FIELDS.has(key)) return colorIndex(value);
  if (Array.isArray(value)) return value.map(item => indexedColors(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, indexedColors(item, field)]));
}

/** Catalog parameter schemas describe the same names as drawing arguments. */
export function namedCatalog(value: unknown, key = ''): unknown {
  if (COLOR_FIELDS.has(key) && value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
    const schema = value as Record<string, unknown>;
    return { ...namedColorSchema, ...(schema.default === undefined ? {} : { default: namedColors(schema.default, key) }) };
  }
  if (Array.isArray(value)) return namedColors(value, key);
  if (!value || typeof value !== 'object') return namedColors(value, key);
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, namedCatalog(item, field)]));
}
