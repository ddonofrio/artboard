import { COLOR_FIELDS, COLOR_NAMES, colorIndex } from '../core/index.js';

export const namedColorSchema = { type: 'string', enum: [...COLOR_NAMES], description: 'Choose one of the 16 fixed English color names.' };

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
