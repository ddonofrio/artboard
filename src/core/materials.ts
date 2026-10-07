import { materials, withDefaults } from './catalog.js';
import type { Material } from './types.js';
export function hash(seed: number, x: number, y = 0): number {
  let n = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}
export function idSeed(seed: number, id: string): number {
  let result = seed >>> 0;
  for (const char of id) result = Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0;
  return result;
}
export function stipple(x: number, y: number, seed: number, density: number): boolean { return hash(seed, x, y) / 4294967296 < density; }
export function hatch(x: number, y: number, spacing = 8): boolean { return ((x + y) % spacing + spacing) % spacing === 0; }
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function orderedDither(x: number, y: number, coverage: number): boolean { return bayer[((y & 3) << 2) + (x & 3)] / 16 < coverage; }
const mod = (x: number, n: number) => ((x % n) + n) % n;

export function materialSampler(material: Material | undefined, seed: number, height: number, fallback = 3): (x: number, y: number) => number {
  if (!material) return () => fallback;
  const entry = materials[material.id];
  const p = withDefaults(entry.parameters, material.params);
  const scale = Number(p.scale), density = Number(p.density);
  const foreground = Number(p.foreground ?? entry.colors[0]), background = Number(p.background ?? entry.colors[1]);
  const patternSeed = Number(p.seed ?? seed);
  const irregularity = Number(p.irregularity ?? 0.4);
  return (localX, localY) => {
    let x = Math.floor(localX / scale), y = Math.floor(localY / scale);
    if (p.direction === 'horizontal') [x, y] = [y, x];
    const noise = hash(patternSeed, x, y) / 4294967296;
    let mark = false;
    switch (material.id) {
      case 'stone': {
        const band = Math.floor(y / 36);
        const bend = Math.round(Math.sin(y * 0.18 + patternSeed % 31) * (2 + irregularity * 7));
        mark = mod(x + bend + band * 23, 69) < 1 + density || (mod(y + Math.floor(x / 69) * 9, 39) === 0 && mod(x, 69) < 22) || noise < density * 0.05;
        if (p.dark_edges && (localX < 2 || localY < 2)) mark = true;
        break;
      }
      case 'masonry': {
        const row = Math.floor(y / 22), offset = (row & 1) * 25;
        const jitter = Math.floor(hash(patternSeed, row) % 5 * irregularity);
        mark = mod(y, 22) < Number(p.mortar) || mod(x + offset + jitter, 51) < Number(p.mortar) || noise < density * 0.018;
        if (!mark && hash(patternSeed, Math.floor((x + offset) / 51), row) % 7 === 0 && hatch(x, y, 12)) mark = true;
        break;
      }
      case 'wood': {
        const plank = Math.floor(x / 23), grain = Math.round(Math.sin(y * 0.06 + plank * 2) * (1 + irregularity * 3));
        const knotX = plank * 23 + 11, knotY = Math.floor(y / 110) * 110 + 35 + hash(patternSeed, plank) % 45;
        const knot = ((x - knotX) / 4) ** 2 + ((y - knotY) / 9) ** 2;
        mark = mod(x, 23) < 1 || (mod(x + grain, 9) === 0 && noise < 0.22 + density * 0.4) || (knot > 0.6 && knot < 1.4 && density > 0.1);
        break;
      }
      case 'plaster': mark = noise < density * 0.025 || (p.cracks === true && mod(x + Math.round(Math.sin(y / 9) * 3), 143) === 0 && y < 90); break;
      case 'tiles': mark = mod(x, p.variant === 'rectangular' ? 42 : 28) < Number(p.grout) || mod(y, 28) < Number(p.grout) || noise < density * 0.009; break;
      case 'earth': mark = noise < density * 0.045 || (mod(y, 13) === 0 && mod(x + hash(patternSeed, Math.floor(y / 13)) % 23, 29) < 3 && density > 0.1); break;
      case 'vegetation':
        if (p.variant === 'leaves') mark = hash(patternSeed, Math.floor(x / 5), Math.floor(y / 4)) / 4294967296 < density && mod(x + y, 5) < 3;
        else mark = mod(x + Math.floor(y / 11) * 7, 13) < 2 && mod(y, 11) < 5 && hash(patternSeed, Math.floor(x / 13), Math.floor(y / 11)) / 4294967296 < 0.2 + density;
        break;
      case 'water': mark = mod(y, 10) < 1 && mod(x + hash(patternSeed, Math.floor(y / 10)) % 30, 49) < 12 + density * 20; break;
      case 'sky': mark = p.variant === 'dither' && orderedDither(x, y, Math.max(0, Math.min(0.8, localY / Math.max(1, height) * 0.65))); break;
      case 'metal': mark = mod(x, 45) === 1 || (p.wear === true && noise < density * 0.025); break;
    }
    return mark ? background : foreground;
  };
}
