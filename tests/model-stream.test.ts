import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelStream, type StreamProgress } from '../src/agents/stream';
import { encodeVisionJPEG } from '../src/adapters/node/index';
import jpeg from 'jpeg-js';

test('SSE observation preserves byte fragments, Unicode, inline reasoning and multiple calls', async () => {
  const wire = [
    { choices: [{ delta: { content: '<think>Pinta ' } }] },
    { choices: [{ delta: { content: 'el árbol.</think>' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'first', function: { name: 'scene_apply', arguments: '{"operations":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[]}' } }, { index: 1, id: 'second', function: { name: 'scene_render', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 27 } } },
  ].map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire), events: StreamProgress[] = [];
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
    controller.close();
  } });
  const response = await modelStream(new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }), item => { events.push(item); });
  assert.equal(await response.text(), wire);
  const thoughts = events.filter(item => item.type === 'thinking');
  assert.equal(thoughts.at(-1)?.text, 'Pinta el árbol.');
  assert.equal(thoughts.at(-1)?.tokens, 27); assert.equal(thoughts.at(-1)?.tokens_estimated, false);
  assert.deepEqual(events.filter(item => item.type === 'tool_input').map(item => [item.call_id, item.name, item.input]), [
    ['first', 'scene_apply', '{"operations":'], ['first', 'scene_apply', '{"operations":[]}'], ['second', 'scene_render', '{}'],
  ]);
  const responses = events.filter(item => item.type === 'response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].tool_calls.length, 2);
  assert.equal(responses[0].text, '[reasoning omitted]');
});

test('vision reduction averages details, keeps dimensions at least one pixel and leaves the original untouched', () => {
  const data = new Uint8ClampedArray([255,255,255,255, 0,0,0,255, 0,0,0,255, 255,255,255,255]);
  const original = data.slice();
  const reduced = jpeg.decode(encodeVisionJPEG({ width: 2, height: 2, data }, 4));
  assert.equal(reduced.width, 1); assert.equal(reduced.height, 1);
  assert.ok(reduced.data[0] >= 125 && reduced.data[0] <= 130);
  assert.deepEqual(data, original);
  for (const divisor of [0, 1.5, 65]) assert.throws(() => encodeVisionJPEG({ width: 2, height: 2, data }, divisor), /divisor/);
});
