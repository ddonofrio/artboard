/** Prefer model-reported reasoning usage; never count tool arguments as thinking. */
export function thinkingTokens(text: string, usage: unknown): { tokens: number; tokens_estimated: boolean } | undefined {
  const record = usage && typeof usage === 'object' ? usage as Record<string, unknown> : undefined;
  const details = record?.completion_tokens_details;
  const reported = details && typeof details === 'object' ? (details as Record<string, unknown>).reasoning_tokens : undefined;
  for (const count of [reported, record?.reasoning_tokens]) {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return { tokens: count, tokens_estimated: false };
  }
  if (!text.trim()) return;
  // A text-length estimate is explicitly marked; exact tokenization is model-specific.
  return { tokens: Math.ceil(text.trim().length / 4), tokens_estimated: true };
}
