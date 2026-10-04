/** Preserve every reported numeric usage/timing field, excluding arbitrary server text. */
export function numericStatistics(value: unknown, prefix = ''): Record<string, number> {
  const result: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[name] = item;
    else if (item && typeof item === 'object') Object.assign(result, numericStatistics(item, name));
  }
  return result;
}
