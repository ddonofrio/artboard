export interface DrawingRequest { prompt: string; layers: number; scene_id?: string; batch?: { id: string; index: number } }
export type PaintStyle = { kind: 'scanline' } | { kind: 'rays'; center: [number, number]; radius: [number, number] };
export type DrawingEvent =
  | { type: 'stage'; name: string; index: number; total: number }
  | { type: 'phase'; role: 'editor' | 'reviewer'; round: number }
  | { type: 'tool'; name: string; input: Record<string, unknown>; ok: boolean; message?: string }
  | { type: 'thinking'; text: string }
  | { type: 'execution_error'; message: string }
  | { type: 'preview'; image: string; group?: string; style?: PaintStyle }
  | { type: 'review'; approved: boolean; issues: string[] }
  | { type: 'retry'; message: string }
  | { type: 'final'; scene_id: string; approved: boolean; stop_reason: 'approved' | 'review_limit' | 'incomplete'; error?: string; duration_ms: number; output_path?: string }
  | { type: 'error'; message: string };
