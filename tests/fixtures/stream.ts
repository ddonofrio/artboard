export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** A real SSE response with explicit gates, rather than a buffered JSON mock. */
export function gatedCompletion(body: { id: string; model: string; choices: { message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[] }, argumentsGate: Promise<void>, finishGate: Promise<void>, prefillGate: Promise<void> = Promise.resolve()) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: body.id, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
      const call = body.choices[0].message.tool_calls[0];
      await prefillGate;
      send(chunk({ role: 'assistant', reasoning_content: 'Plan the scene: ' }));
      send(chunk({ reasoning_content: 'draw the whole block.' }));
      send(chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments.slice(0, -1) } }] }));
      await argumentsGate;
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }));
      await finishGate;
      send(chunk({}, 'tool_calls'));
      send({ id: body.id, model: body.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: 80, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 17 } } });
      if (!cancelled) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
