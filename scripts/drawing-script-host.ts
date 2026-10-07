import { SceneTools, SceneError, toolSchemas, type ToolResult } from '../src/core/index.js';
import { normalizeGeometry } from '../src/agents/geometry.js';
import { namedCatalog, namedColors } from '../src/agents/colors.js';

export interface ScriptCall { tool: string; arguments: Record<string, unknown>; result: ToolResult }
export interface DrawingScriptTools {
  call(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_catalog(args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_inspect(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_apply(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_render(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_history(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  scene_io(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export type DrawingScript = (tools: DrawingScriptTools, args: readonly string[]) => unknown | Promise<unknown>;

/** Explicitly launched local scripts use the agent's drawing arguments and core validation. */
export async function runDrawingScript(script: DrawingScript, host: SceneTools, args: readonly string[] = [], onCall: (call: ScriptCall) => void | Promise<void> = () => {}): Promise<unknown> {
  let pending: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  const call: DrawingScriptTools['call'] = (tool, input = {}) => {
    const next = pending.then(async () => {
      if (failure !== undefined) throw failure;
      try {
        const applied = tool === 'scene_apply' ? normalizeGeometry(input, host) : input;
        const result = await host.dispatch({ tool, arguments: applied });
        await onCall({ tool, arguments: structuredClone(input), result });
        if (!result.ok) throw new SceneError(result.error);
        return (tool === 'scene_catalog' ? namedCatalog(result.result) : namedColors(result.result)) as Record<string, unknown>;
      } catch (error) { failure = error; throw error; }
    });
    // Observe failures even when a script forgets to await a call. The host drains
    // all scheduled calls before returning and rejects after the first failure.
    pending = next.catch(() => {});
    return next;
  };
  const tools = Object.freeze({ call, ...Object.fromEntries(Object.keys(toolSchemas).map(tool => [tool, (input?: Record<string, unknown>) => call(tool, input)])) }) as DrawingScriptTools;
  let value: unknown;
  try { value = await script(tools, Object.freeze([...args])); }
  finally { await pending; }
  if (failure !== undefined) throw failure;
  return value;
}
