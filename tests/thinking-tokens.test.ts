import assert from 'node:assert/strict';
import { test } from 'node:test';
import { thinkingTokens } from '../src/agents/thinking';
import { runWorkflow } from '../src/workflows/run';
import type { AgentEvent } from '../src/agents/loop';
import { PixelRenderer, SceneStore, SceneTools, type PixelImage } from '../src/core/index';
import { NodeAdapter, encodeJPEG } from '../src/adapters/node/index';
import { mockModel } from './fixtures/model';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage) { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
const createTools = () => new SceneTools(new SceneStore(), new PixelRenderer(), new InlineAdapter());

test('invalid or missing usage never substitutes total output tokens for thinking tokens', () => {
  for (const reported of [undefined, null, '17', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(thinkingTokens('abcdefghijkl', { completion_tokens: 999, completion_tokens_details: { reasoning_tokens: reported } }), { tokens: 3, tokens_estimated: true });
    assert.equal(thinkingTokens('', { completion_tokens: 999, completion_tokens_details: { reasoning_tokens: reported } }), undefined);
  }
});

for (const variant of ['details', 'top-level', 'zero', 'hidden', 'estimated']) test(`model thinking usage is ${variant} and scoped to each response`, async () => {
  const fake = mockModel(), thoughts: Extract<AgentEvent, { type: 'thinking' }>[] = [];
  const text = variant === 'hidden' ? '' : 'Plan the complete drawing block. '.repeat(400);
  const result = await runWorkflow({ layers: 3, prompt: 'Scene', createTools, config: { connection: { editor_model: 'test-model' } },
    fetch: async (input, init) => {
      const response = await fake.fetcher(input, init), body = await response.json();
      body.choices[0].message.reasoning_content = text;
      body.usage = { prompt_tokens: 50, completion_tokens: 10000, total_tokens: 10050,
        ...(variant === 'top-level' ? { reasoning_tokens: 123 } : {}),
        ...(['details', 'zero', 'hidden'].includes(variant) ? { completion_tokens_details: { reasoning_tokens: variant === 'zero' ? 0 : 123 } } : {}),
      };
      return Response.json(body);
    },
    onEvent: item => { if (item.type === 'agent' && item.event.type === 'thinking' && item.event.final) thoughts.push(item.event); },
  });
  assert.equal(result.result.approved, true);
  assert.equal(thoughts.length, fake.requests.length);
  const expected = variant === 'estimated' ? Math.ceil(text.trim().length / 4) : variant === 'zero' ? 0 : 123;
  assert.ok(thoughts.every(event => event.tokens === expected && event.tokens_estimated === (variant === 'estimated')));
  assert.ok(thoughts.every(event => event.text.length <= 8000));
  if (variant === 'estimated') assert.ok(expected > Math.ceil(thoughts[0].text.length / 4), 'Estimate uses the full reasoning before log clipping');
  if (variant === 'hidden') assert.ok(thoughts.every(event => event.text === ''), 'Hidden reasoning is counted without inventing text');
});
