import type { AgentStatistics } from '../contracts/service';

const fields: Record<string, string[]> = {
  Sent: ['prompt_tokens', 'input_tokens'],
  Received: ['completion_tokens', 'output_tokens'],
  Total: ['total_tokens'],
  'Cache read': ['prompt_tokens_details.cached_tokens', 'input_tokens_details.cached_tokens', 'input_tokens_details.cache_read', 'cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens', 'prompt_cache_hit_tokens'],
  'Cache write': ['prompt_tokens_details.cache_write_tokens', 'prompt_tokens_details.cache_creation_tokens', 'input_tokens_details.cache_write', 'cache_creation_input_tokens', 'cache_write_tokens'],
  Reasoning: ['completion_tokens_details.reasoning_tokens', 'output_tokens_details.reasoning_tokens', 'reasoning_tokens'],
};
const known = new Set(Object.values(fields).flat());

/** Counts come from server usage, never from character-count estimates. */
export class AgentStatisticsLog {
  private requests = new Map<string, AgentStatistics>();
  reset(): void { this.requests.clear(); }
  update(event: AgentStatistics): void {
    // A repeated request notification cannot overwrite an already completed response.
    if (event.state === 'request' && this.requests.get(event.id)?.state === 'response') return;
    this.requests.set(event.id, event);
  }
  text(): string {
    const completed = [...this.requests.values()].filter(event => event.state === 'response');
    const latest = [...this.requests.values()].at(-1);
    const parts = [latest ? `${latest.role}: ${latest.model}` : 'Agent', `Requests: ${this.requests.size}`];
    for (const [label, keys] of Object.entries(fields)) {
      const values = completed.flatMap(event => {
        const key = keys.find(key => event.usage[key] !== undefined);
        return key ? [event.usage[key]] : [];
      });
      const count = values.reduce((sum, value) => sum + value, 0);
      parts.push(`${label}: ${values.length ? `${values.length < completed.length ? '≥' : ''}${count}` : '—'}`);
    }
    parts.push(`Time: ${(completed.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0) / 1000).toFixed(1)}s`);
    const extras = new Map<string, number>();
    for (const event of completed) for (const [key, value] of Object.entries(event.usage)) {
      if (!known.has(key)) extras.set(key, (extras.get(key) ?? 0) + value);
    }
    for (const [key, value] of extras) parts.push(`${key}: ${value}`);
    // Server rates and timings describe the latest response; they are not additive.
    const last = completed.at(-1);
    if (last) for (const [key, value] of Object.entries(last.timings)) parts.push(`${key}: ${value}`);
    return parts.join(' | ');
  }
}
