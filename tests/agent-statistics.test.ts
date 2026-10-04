import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentStatisticsLog } from '../src/ui/agent-statistics';
import { numericStatistics } from '../src/agents/usage';
import type { AgentStatistics } from '../src/contracts/service';

const response = (id: string, usage: Record<string, number>): AgentStatistics => ({ type: 'statistics', id, model: 'local-model', role: 'editor', state: 'response', duration_ms: 1500, usage, timings: { predicted_per_second: 12.5 } });

test('statistics preserve numeric server fields, distinguish unavailable cache values, and avoid double counting', () => {
  const log = new AgentStatisticsLog();
  assert.match(log.text(), /Sent: —.*Cache read: —.*Cache write: —/);
  const first = response('1', numericStatistics({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 5, audio_tokens: 0 }, credential: 'secret', invalid: -1 }));
  log.update({ ...first, state: 'request', usage: {} });
  log.update(first); log.update(first);
  log.update({ ...first, state: 'request', usage: {} });
  assert.match(log.text(), /Requests: 1.*Sent: 100.*Received: 20.*Cache read: 80.*Cache write: —.*Reasoning: 5/);
  assert.match(log.text(), /audio_tokens: 0.*predicted_per_second: 12.5/);
  assert.doesNotMatch(log.text(), /secret|credential|invalid/);
  log.update(response('2', { input_tokens: 200, output_tokens: 30, total_tokens: 230, cache_read_input_tokens: 0, cache_creation_input_tokens: 120 }));
  assert.match(log.text(), /Requests: 2.*Sent: 300.*Received: 50.*Cache read: 80.*Cache write: ≥120/);
  log.reset(); assert.match(log.text(), /Requests: 0.*Sent: —/);
});
