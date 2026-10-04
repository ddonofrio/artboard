export interface AgentConfig {
  base_url: string;
  editor_model: string;
  reviewer_model: string;
  api_key?: string;
  max_reviews: number;
  max_output_tokens: number;
  timeout_ms: number;
  vision: boolean;
}
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  base_url: 'http://127.0.0.1:1234', editor_model: '', reviewer_model: '',
  max_reviews: 10, max_output_tokens: 8192, timeout_ms: 300000, vision: true,
};
export function apiBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) API URL without credentials, query, or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.toString().replace(/\/$/, '');
}
export function agentConfig(input: Partial<AgentConfig> = {}): AgentConfig {
  const config = { ...DEFAULT_AGENT_CONFIG, ...input };
  config.base_url = apiBaseURL(config.base_url);
  for (const [key, minimum, maximum] of [['max_reviews', 1, 10], ['max_output_tokens', 512, 32768], ['timeout_ms', 1000, 600000]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  if (typeof config.vision !== 'boolean') throw new Error('vision must be boolean.');
  for (const key of ['editor_model', 'reviewer_model'] as const) {
    if (typeof config[key] !== 'string' || config[key].length > 256) throw new Error(`${key} must be a model ID.`);
    config[key] = config[key].trim();
  }
  if (config.api_key !== undefined && (typeof config.api_key !== 'string' || config.api_key.length > 4096)) throw new Error('api_key must be a string.');
  return config;
}
export async function listModels(config: Pick<AgentConfig, 'base_url' | 'api_key'>, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<string[]> {
  const response = await fetcher(`${apiBaseURL(config.base_url)}/models`, {
    headers: config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {},
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}. Check endpoint and optional API key.`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) throw new Error('Expected OpenAI-compatible /models response.');
  const models = data.data.filter((item): item is { id: string } => !!item && typeof item === 'object' && typeof item.id === 'string').map(item => item.id).filter(id => !/embed|^bge|nomic-embed/i.test(id));
  if (!models.length) throw new Error('No chat models available. Load a tool-calling, vision-capable model in your server.');
  return [...new Set(models)];
}
