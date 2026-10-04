import { thinkingTokens } from './thinking.js';
import { numericStatistics } from './usage.js';

export type StreamProgress =
  | { type: 'thinking'; text: string; tokens: number; tokens_estimated: boolean; final: boolean; active: boolean }
  | { type: 'tool_input'; call_id: string; name: string; input: string }
  | { type: 'response'; finish_reason?: string; output_tokens?: number; text?: string; tool_calls: unknown[]; usage: Record<string, number>; timings: Record<string, number> };

/** Observe SSE as it is consumed, without buffering the response ahead of the SDK. */
export async function modelStream(response: Response, report: (event: StreamProgress) => void | Promise<void>): Promise<Response> {
  if (!response.body) throw new Error('Model returned no response body.');
  if (/application\/json/i.test(response.headers.get('content-type') || '')) {
    // Some compatible servers ignore stream=true. Preserve their complete response.
    const body = await response.json();
    const choices = (body.choices ?? []).map((choice: { index?: number; finish_reason?: string; message: { tool_calls?: Record<string, unknown>[] } }) => ({
      index: choice.index ?? 0, finish_reason: choice.finish_reason,
      delta: { ...choice.message, tool_calls: choice.message.tool_calls?.map((call, index) => ({ ...call, index })) },
    }));
    response = new Response(`data: ${JSON.stringify({ ...body, choices })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const decoder = new TextDecoder();
  let buffer = '', reasoning = '', content = '', usage: unknown, finishReason: string | undefined, completed = false;
  let statistics: Record<string, number> = {}, timings: Record<string, number> = {};
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  const thought = async (final: boolean, active = false) => {
    const text = reasoning || [...content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(match => match[1]).join('\n');
    const count = thinkingTokens(text, usage);
    if (count && (text.trim() || count.tokens > 0)) await report({ type: 'thinking', text: text.trim().slice(-8000), ...count, final, active });
  };
  const finish = async () => {
    if (completed) return;
    completed = true;
    await thought(true);
    const tokenUsage = usage as { completion_tokens?: number } | undefined;
    await report({ type: 'response', finish_reason: finishReason, output_tokens: tokenUsage?.completion_tokens,
      text: content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '[reasoning omitted]') || undefined, tool_calls: [...calls.values()], usage: statistics, timings });
  };
  const consume = async (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { await finish(); return; }
    let body;
    try { body = JSON.parse(data); } catch { return; } // The SDK reports malformed chunks.
    const previousUsage = usage;
    usage = body.usage ?? usage;
    statistics = { ...statistics, ...numericStatistics(body.usage) };
    timings = { ...timings, ...numericStatistics(body.timings), ...numericStatistics(body.stats, 'stats') };
    const choice = body.choices?.[0], delta = choice?.delta;
    finishReason = choice?.finish_reason ?? finishReason;
    if (delta) {
      const before = reasoning + content;
      reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
      if (typeof delta.content === 'string') content += delta.content;
      if (before !== reasoning + content || usage !== previousUsage) await thought(false, before !== reasoning + content);
      for (const item of delta.tool_calls ?? []) {
        const index = item.index ?? 0;
        const call = calls.get(index) ?? { id: item.id || `call-${index}`, type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id = item.id;
        call.function.name += item.function?.name ?? '';
        call.function.arguments += item.function?.arguments ?? '';
        calls.set(index, call);
        await report({ type: 'tool_input', call_id: call.id, name: call.function.name, input: call.function.arguments });
      }
    } else if (usage !== previousUsage) await thought(false);
  };
  const drain = async () => {
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await consume(frame);
    }
  };
  const stream = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      await drain();
      controller.enqueue(chunk);
    },
    async flush() {
      buffer += decoder.decode(); await drain();
      if (buffer.trim()) await consume(buffer);
      await finish();
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
