import type { DrawingEvent, DrawingRequest, ModelsResponse } from '../contracts/service';

export async function fetchModels(signal: AbortSignal): Promise<ModelsResponse> {
  const response = await fetch('/api/models', { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Model discovery returned HTTP ${response.status}.`);
  if (!Array.isArray(body.models) || !body.models.length || !body.models.every((model: unknown) => typeof model === 'string' && model.trim() && model.length <= 256) || typeof body.selected_model !== 'string' || !body.models.includes(body.selected_model)) throw new Error('Invalid model list from the drawing service.');
  return body as ModelsResponse;
}

export async function streamDrawing(request: DrawingRequest, signal: AbortSignal, onEvent: (event: DrawingEvent) => void | Promise<void>): Promise<void> {
  const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `Drawing service returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('Drawing service returned no event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finished = false;
  const consume = async (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as DrawingEvent;
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'final') finished = true;
    signal.throwIfAborted();
    await onEvent(event);
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        await consume(line);
      }
      if (chunk.done) break;
    }
    await consume(buffer);
    if (!finished) throw new Error('Drawing connection ended before a final result.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
