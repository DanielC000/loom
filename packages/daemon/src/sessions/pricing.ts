// Agent Runs #2 — the per-run COST MODEL: a small, OVERRIDABLE per-model price table (USD per 1M tokens)
// with sane CURRENT Anthropic defaults, and a cost function over a run's cumulative usage snapshot.
//
// ⚠️ PRICES ARE APPROXIMATE + DATED. They are Anthropic public list pricing as of PRICES_AS_OF below —
// verify against https://platform.claude.com/docs/en/pricing before relying on a cost for billing. They
// are deliberately kept in ONE place so a human can correct them, and `computeRunCostUsd` accepts an
// `overrides` map for per-call adjustment without editing this file.
//
// HARD INVARIANT: an unknown model → cost 0 + a single logged warning. computeRunCostUsd NEVER throws —
// it runs on the run-teardown path, which must not be disturbed by a missing/garbage price.

/** A model's list price, USD per 1,000,000 tokens, split input/output. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** The date the default prices below were last checked (cached from the claude-api skill, 2026-05-26). */
export const PRICES_AS_OF = "2026-05-26";

/**
 * Default per-model list prices (USD / 1M tokens). Keyed by the engine model id as it appears in the
 * transcript (e.g. "claude-opus-4-8"). Cache pricing is NOT a separate table entry — it is derived from
 * the input rate via Anthropic's standard multipliers (see CACHE_WRITE_MULT / CACHE_READ_MULT below).
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

// Anthropic cache pricing relative to the base INPUT rate: a 5-minute cache WRITE costs ~1.25× input;
// a cache READ costs ~0.1× input. Output is never cached. These multipliers let the table stay tiny.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/** The cumulative-usage shape `computeRunCostUsd` prices (a subset of the run's stored usage snapshot). */
export interface CostableUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  model?: string | null;
}

/**
 * Resolve a model's price: an exact table hit first, else the longest known-prefix match so a
 * date-suffixed engine id (e.g. "claude-haiku-4-5-20251001") still resolves to its family price.
 * Returns null when nothing matches (the caller treats that as cost 0). `overrides` win over defaults.
 */
export function priceForModel(
  model: string | null | undefined,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | null {
  if (!model) return null;
  const table = { ...MODEL_PRICES, ...(overrides ?? {}) };
  if (table[model]) return table[model];
  let best: { id: string; price: ModelPrice } | null = null;
  for (const [id, price] of Object.entries(table)) {
    if (model.startsWith(id) && (!best || id.length > best.id.length)) best = { id, price };
  }
  return best?.price ?? null;
}

const num = (x: number | null | undefined): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * Cumulative USD cost for a run, from its summed usage × the model price. Input tokens and cache
 * read/write are priced off the input rate (cache via the multipliers above); output off the output
 * rate. Unknown model → 0 + ONE logged warning (never throws). Rounded to 6dp (sub-cent precision).
 */
export function computeRunCostUsd(usage: CostableUsage, overrides?: Record<string, ModelPrice>): number {
  const price = priceForModel(usage.model, overrides);
  if (!price) {
    // eslint-disable-next-line no-console
    console.warn(`[run-cost] no price for model ${usage.model ?? "(none)"} — recording cost 0`);
    return 0;
  }
  const inputCost = (num(usage.inputTokens) * price.inputPerMillion) / 1_000_000;
  const outputCost = (num(usage.outputTokens) * price.outputPerMillion) / 1_000_000;
  const cacheWriteCost = (num(usage.cacheCreationTokens) * price.inputPerMillion * CACHE_WRITE_MULT) / 1_000_000;
  const cacheReadCost = (num(usage.cacheReadTokens) * price.inputPerMillion * CACHE_READ_MULT) / 1_000_000;
  return Math.round((inputCost + outputCost + cacheWriteCost + cacheReadCost) * 1e6) / 1e6;
}
