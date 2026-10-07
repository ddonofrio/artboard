import { expandGenerator } from './generators.js';
import { idSeed, materialSampler, orderedDither } from './materials.js';
import { fail, validateScene } from './schema.js';
import { RENDERER_VERSION, type Bounds, type PixelImage, type Point, type RenderOptions, type Scene, type SceneObject, type SpriteAsset } from './types.js';

/** Solve inverse projective mapping from a convex quad to a flat texture. */
export function quadMapping(quad: Point[], size: Point): (x: number, y: number) => Point {
  // Construct square -> quad and invert its homogeneous 3x3 matrix. Unlike an
  // eight-unknown solve with a fixed constant, this also supports inverse h33=0.
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1[0]-p2[0], dx2 = p3[0]-p2[0], dx3 = p0[0]-p1[0]+p2[0]-p3[0];
  const dy1 = p1[1]-p2[1], dy2 = p3[1]-p2[1], dy3 = p0[1]-p1[1]+p2[1]-p3[1];
  const divisor = dx1*dy2-dx2*dy1;
  if (Math.abs(divisor) < 1e-10) fail('INVALID_QUAD', 'Quadrilateral mapping is singular', 'mapping/quad');
  const g = (dx3*dy2-dx2*dy3)/divisor, h = (dx1*dy3-dx3*dy1)/divisor;
  const a = p1[0]-p0[0]+g*p1[0], b = p3[0]-p0[0]+h*p3[0], c = p0[0];
  const d = p1[1]-p0[1]+g*p1[1], e = p3[1]-p0[1]+h*p3[1], f = p0[1];
  const inverse = [e-f*h, c*h-b, b*f-c*e, f*g-d, a-c*g, c*d-a*f, d*h-e*g, b*g-a*h, a*e-b*d];
  return (x, y) => {
    const denominator = inverse[6]*x+inverse[7]*y+inverse[8];
    return [(inverse[0]*x+inverse[1]*y+inverse[2])/denominator*size[0], (inverse[3]*x+inverse[4]*y+inverse[5])/denominator*size[1]];
  };
}

export class PixelRenderer {
  private assets = new Map<string, SpriteAsset>();
  registerAsset(asset: SpriteAsset): void {
    if (asset.image.width !== asset.manifest.width || asset.image.height !== asset.manifest.height || asset.image.data.length !== asset.image.width * asset.image.height * 4) fail('INVALID_ASSET', 'Asset dimensions do not match decoded RGBA data', 'asset');
    this.assets.set(asset.manifest.id, structuredClone(asset));
  }
  assetCatalog() { return [...this.assets.values()].map(asset => structuredClone(asset.manifest)); }
  hasAsset(id: string): boolean { return this.assets.has(id); }
  render(scene: Scene, options: RenderOptions = {}): PixelImage {
    validateScene(scene);
    if (scene.renderer_version !== RENDERER_VERSION) fail('RENDERER_VERSION', `Expected renderer ${RENDERER_VERSION}, received ${scene.renderer_version}`, 'renderer_version');
    const width = scene.width, height = scene.height;
    // Empty pixels use white so a blank canvas already has the common paper/flag field.
    const pixels = new Uint8Array(width * height).fill(scene.palette.colors.length - 1);
    const plot = (x: number, y: number, color: number) => { if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = Math.min(color, scene.palette.colors.length - 1); };
    const line = (a: Point, b: Point, color: number, thickness: number) => {
      let x = Math.round(a[0]), y = Math.round(a[1]);
      const bx = Math.round(b[0]), by = Math.round(b[1]), dx = Math.abs(bx - x), dy = -Math.abs(by - y), sx = x < bx ? 1 : -1, sy = y < by ? 1 : -1;
      let error = dx + dy;
      const low = -Math.floor(thickness / 2), high = Math.ceil(thickness / 2);
      for (;;) {
        for (let oy = low; oy < high; oy++) for (let ox = low; ox < high; ox++) plot(x + ox, y + oy, color);
        if (x === bx && y === by) break;
        const e = error * 2;
        if (e >= dy) { error += dy; x += sx; }
        if (e <= dx) { error += dx; y += sy; }
      }
    };
    const draw = (obj: SceneObject) => {
      if (obj.kind === 'procedural') { for (const part of expandGenerator({ ...obj, seed: obj.seed ?? idSeed(scene.seed, obj.id) })) draw(part); return; }
      if ((obj.kind === 'polygon' || obj.kind === 'line') && obj.rotation && obj.rotation % 360 !== 0) {
        const xs = obj.points.map(point => point[0]), ys = obj.points.map(point => point[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const angle = obj.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
        const rotate = (point: Point): Point => [cx + (point[0] - cx) * cos - (point[1] - cy) * sin, cy + (point[0] - cx) * sin + (point[1] - cy) * cos];
        const points = obj.points.map(rotate);
        const mapping = obj.kind === 'polygon' && obj.mapping ? { ...obj.mapping, quad: obj.mapping.quad.map(rotate) } : undefined;
        draw({ ...obj, rotation: 0, points, ...(obj.kind === 'polygon' && mapping ? { mapping } : {}) });
        return;
      }
      if (obj.kind === 'star') {
        const tips = obj.tips ?? 5, inner = obj.inner_radius ?? obj.radius * (3 - Math.sqrt(5)) / 2;
        const start = ((obj.rotation ?? 0) - 90) * Math.PI / 180;
        const points: Point[] = Array.from({ length: tips * 2 }, (_, i) => {
          const angle = start + i * Math.PI / tips, radius = i % 2 ? inner : obj.radius;
          return [obj.center[0] + Math.cos(angle) * radius, obj.center[1] + Math.sin(angle) * radius];
        });
        draw({ ...obj, kind: 'polygon', rotation: 0, points });
        return;
      }
      if (obj.kind === 'sprite') {
        const asset = this.assets.get(obj.asset);
        if (!asset) fail('MISSING_ASSET', `Register sprite asset ${obj.asset} before rendering`, `objects/${obj.id}/asset`);
        const [x, y, w, h] = obj.bounds, anchor = asset.manifest.anchor;
        const colors = scene.palette.colors.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
        const left = Math.round(x - anchor[0] * w / asset.image.width), top = Math.round(y - anchor[1] * h / asset.image.height);
        for (let py = 0; py < Math.ceil(h); py++) for (let px = 0; px < Math.ceil(w); px++) {
          const at = (Math.min(asset.image.height - 1, Math.floor(py * asset.image.height / h)) * asset.image.width + Math.min(asset.image.width - 1, Math.floor(px * asset.image.width / w))) * 4;
          if (asset.image.data[at + 3] < 128) continue;
          let best = 0, distance = Infinity;
          for (let c = 0; c < colors.length; c++) {
            const d = colors[c].reduce((sum, value, i) => sum + (value - asset.image.data[at + i]) ** 2, 0);
            if (d < distance) { best = c; distance = d; }
          }
          plot(left + px, top + py, best);
        }
        return;
      }
      if (obj.kind === 'line') { for (let i = 1; i < obj.points.length; i++) line(obj.points[i - 1], obj.points[i], obj.color ?? 0, obj.stroke_width ?? 1); return; }
      const bounds: Bounds = obj.kind === 'ellipse' ? obj.bounds : [Math.min(...obj.points.map(p => p[0])), Math.min(...obj.points.map(p => p[1])), Math.max(...obj.points.map(p => p[0])) - Math.min(...obj.points.map(p => p[0])), Math.max(...obj.points.map(p => p[1])) - Math.min(...obj.points.map(p => p[1]))];
      const [left, top, w, h] = bounds;
      const sampler = materialSampler(obj.color === undefined ? obj.material : undefined, obj.seed ?? idSeed(scene.seed, obj.id), obj.kind === 'polygon' && obj.mapping ? obj.mapping.size[1] : h, obj.color ?? 3);
      const transform = obj.kind === 'polygon' && obj.mapping ? quadMapping(obj.mapping.quad, obj.mapping.size) : (x: number, y: number): Point => [x - left, y - top];
      const paint = (x: number, y: number, patternX = x + 0.5 - left, patternY = y + 0.5 - top) => {
        if (obj.fill === 'none') return;
        if (typeof obj.fill === 'number') { plot(x, y, obj.fill); return; }
        if (obj.fill && typeof obj.fill === 'object') {
          plot(x, y, orderedDither(x, y, obj.fill.ratio) ? obj.fill.colors[1] : obj.fill.colors[0]);
          return;
        }
        const [u, v] = transform(x + 0.5, y + 0.5);
        plot(x, y, sampler(obj.kind === 'ellipse' ? patternX : u, obj.kind === 'ellipse' ? patternY : v));
      };
      if (obj.kind === 'ellipse') {
        const rx = w / 2, ry = h / 2, stroke = obj.stroke_width ?? 1, cx = left + rx, cy = top + ry;
        const angle = (obj.rotation ?? 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
        const extentX = Math.sqrt((rx * cos) ** 2 + (ry * sin) ** 2), extentY = Math.sqrt((rx * sin) ** 2 + (ry * cos) ** 2);
        for (let y = Math.max(0, Math.floor(cy - extentY)); y < Math.min(height, Math.ceil(cy + extentY)); y++) for (let x = Math.max(0, Math.floor(cx - extentX)); x < Math.min(width, Math.ceil(cx + extentX)); x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          const a = dx * cos + dy * sin, b = -dx * sin + dy * cos;
          if ((a / rx) ** 2 + (b / ry) ** 2 > 1) continue;
          paint(x, y, a + rx, b + ry);
          if (obj.outline !== undefined && (rx <= stroke || ry <= stroke || (a / (rx - stroke)) ** 2 + (b / (ry - stroke)) ** 2 >= 1)) plot(x, y, obj.outline);
        }
      } else {
        for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(top + h)); y++) {
          const crossings: number[] = [];
          for (let i = 0; i < obj.points.length; i++) {
            const a = obj.points[i], b = obj.points[(i + 1) % obj.points.length], py = y + 0.5;
            if ((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) crossings.push(a[0] + (py - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
          }
          crossings.sort((a, b) => a - b);
          for (let i = 0; i + 1 < crossings.length; i += 2) for (let x = Math.max(0, Math.ceil(crossings[i] - 0.5)); x < Math.min(width, Math.ceil(crossings[i + 1] - 0.5)); x++) paint(x, y);
        }
        if (obj.outline !== undefined) for (let i = 0; i < obj.points.length; i++) line(obj.points[i], obj.points[(i + 1) % obj.points.length], obj.outline, obj.stroke_width ?? 1);
      }
    };
    for (const obj of scene.objects.map((o, i) => ({ o, i })).sort((a, b) => a.o.layer - b.o.layer || a.i - b.i)) draw(obj.o);
    const crop = options.crop ?? [0, 0, width, height], scale = options.scale ?? 1;
    if (crop.some(n => !Number.isInteger(n)) || crop[0] < 0 || crop[1] < 0 || crop[2] < 1 || crop[3] < 1 || crop[0] + crop[2] > width || crop[1] + crop[3] > height) fail('INVALID_CROP', 'Crop must use integer bounds inside the canvas', 'crop');
    if (!Number.isInteger(scale) || scale < 1 || scale > 4) fail('INVALID_SCALE', 'Scale must be an integer from 1 to 4', 'scale');
    const outWidth = crop[2] * scale, outHeight = crop[3] * scale, data = new Uint8ClampedArray(outWidth * outHeight * 4);
    const colors = scene.palette.colors.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]);
    for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) data.set(colors[pixels[(crop[1] + Math.floor(y / scale)) * width + crop[0] + Math.floor(x / scale)]], (y * outWidth + x) * 4);
    return { width: outWidth, height: outHeight, data };
  }
}
