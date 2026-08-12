// USD per 1M tokens. Approximate OpenAI public pricing as of this writing —
// good enough for usage dashboards and spend caps, not for invoicing
// reconciliation. Revisit when OpenAI changes pricing or new models are
// added to a tenant's allowed model list.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
};

const FALLBACK_PRICING = PRICING_PER_MILLION_TOKENS["gpt-4o-mini"];

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_PER_MILLION_TOKENS[model] ?? FALLBACK_PRICING;
  const cost =
    (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
