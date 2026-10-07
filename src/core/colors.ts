/** Fixed color order shared by drawing tools and persisted palette indices. */
export const COLOR_NAMES = [
  'black', 'dark blue', 'dark green', 'dark cyan', 'dark red', 'dark magenta', 'brown', 'light gray',
  'dark gray', 'blue', 'green', 'cyan', 'red', 'magenta', 'yellow', 'white',
] as const;

export const BASIC_PALETTE = {
  id: 'basic', name: 'Basic',
  colors: ['#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA',
    '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF'],
};

export const COLOR_FIELDS = new Set(['color', 'fill', 'stroke', 'outline', 'foreground', 'background', 'darkness', 'metal_color', 'highlight_color']);

export function colorIndex(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const index = COLOR_NAMES.indexOf(value as typeof COLOR_NAMES[number]);
  return index < 0 ? value : index;
}
