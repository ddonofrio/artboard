import type { ModelMessage, StepResult, ToolSet } from 'ai';

export interface LoopDetectorCall {
  tool: string;
  parameters: unknown;
  ok: boolean;
  error?: string;
}
export interface LoopDetection {
  tool: string;
  parameters: unknown;
  repetitions: 4;
  calls: number;
}
export interface LoopDetectorRecovery {
  instructions: string;
  messages: ModelMessage[];
  detection: LoopDetection;
}

/** Compare JSON arguments structurally; object key order is not a parameter change. */
function signature(tool: string, parameters: unknown): string {
  return JSON.stringify([tool, parameters], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
}

/** Agent plugin: observe completed tools, then rebuild context when retries repeat. */
export class LoopDetector {
  readonly name = 'loop detector';
  private readonly calls: LoopDetectorCall[] = [];
  private previous?: string;
  private failures = 0;
  private pending?: Omit<LoopDetection, 'calls'>;

  observe(call: LoopDetectorCall): void {
    this.calls.push(structuredClone(call));
    const current = signature(call.tool, call.parameters);
    this.failures = call.ok ? 0 : current === this.previous ? this.failures + 1 : 1;
    this.previous = call.ok ? undefined : current;
    if (this.failures === 4) this.pending = { tool: call.tool, parameters: structuredClone(call.parameters), repetitions: 4 };
  }

  /** SDK errors and adapter rejections count once, in model tool-call order. */
  onStepFinish(step: Pick<StepResult<ToolSet>, 'content'>): void {
    for (const call of step.content) {
      if (call.type !== 'tool-call') continue;
      const result = step.content.find(part => (part.type === 'tool-result' || part.type === 'tool-error') && part.toolCallId === call.toolCallId);
      if (!result || (result.type !== 'tool-result' && result.type !== 'tool-error')) continue;
      if (result.type === 'tool-error') {
        this.observe({ tool: call.toolName, parameters: call.input, ok: false, error: result.error instanceof Error ? result.error.message : String(result.error) });
      } else {
        const output = result.output as { ok?: boolean; error?: { message?: string } } | undefined;
        this.observe({ tool: call.toolName, parameters: call.input, ok: output?.ok !== false, ...(output?.ok === false ? { error: output.error?.message } : {}) });
      }
    }
  }

  prepareStep(context: { initialInstructions: string; initialMessages: ModelMessage[] }): LoopDetectorRecovery | undefined {
    if (!this.pending) return;
    const detection = { ...this.pending, calls: this.calls.length };
    this.pending = undefined; this.previous = undefined; this.failures = 0;
    const recovery: ModelMessage = { role: 'user', content: JSON.stringify({
      plugin: this.name,
      task: 'Restart from the original instructions and user request below. Use the completed calls as context. Correct the rejected parameters before retrying.',
      repeated_call: detection,
      tool_calls: this.calls,
    }) };
    // Keep the initial user request and prior completed phase history, while
    // replacing the current phase's failed native call/response chain with data.
    return { instructions: context.initialInstructions, messages: [recovery, ...context.initialMessages], detection };
  }
}
