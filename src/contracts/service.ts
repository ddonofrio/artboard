export interface ModelsResponse { models: string[]; selected_model: string }
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export interface DrawingRequest { prompt: string; layers: number; model?: string; reasoning_effort?: ReasoningEffort; vision_image_divisor?: number; scene_id?: string; batch?: { id: string; index: number } }
export type PaintStyle = { kind: 'scanline' } | { kind: 'rays'; center: [number, number]; radius: [number, number] };
export interface AgentStatistics { type: 'statistics'; id: string; model: string; role: 'editor' | 'reviewer'; state: 'request' | 'response'; duration_ms?: number; usage: Record<string, number>; timings: Record<string, number> }
export type DrawingEvent =
  | AgentStatistics
  | { type: 'state'; state: 'idle' | 'processing_prompt' | 'thinking' | 'writing_tool_args' | 'executing_tool'; tool?: string }
  | { type: 'stage'; name: string; index: number; total: number }
  | { type: 'phase'; role: 'editor' | 'reviewer'; round: number }
  | { type: 'tool_input'; id: string; name: string; input: string }
  | { type: 'tool'; id?: string; name: string; input: Record<string, unknown>; ok: boolean; message?: string }
  | { type: 'thinking'; id?: string; final?: boolean; text: string; tokens: number; tokens_estimated: boolean }
  | { type: 'execution_error'; message: string }
  | { type: 'preview'; image: string; group?: string; style?: PaintStyle }
  | { type: 'review'; approved: boolean; issues: string[] }
  | { type: 'retry'; message: string }
  | { type: 'final'; scene_id: string; approved: boolean; stop_reason: 'approved' | 'review_limit' | 'incomplete' | 'unreviewed'; error?: string; duration_ms: number; output_path?: string }
  | { type: 'error'; message: string };
