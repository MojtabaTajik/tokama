// List prices per million tokens, used only to estimate the cost of a call the CLI did not price
// itself. Dated: an estimate always says which table it used. Cache writes are the 5-minute rate;
// Haiku 5.5 is its rate for prompts up to 100K tokens.
import type { AgentCallUsage, TokenUsage } from "../../kernel/schemas/index.js";

/** The date the prices below were taken from the vendor's price list. */
export const PRICES_AS_OF = "2026-11-25";

interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

const price = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheWrite: input * 1.25, cacheRead });

/** US dollars per million tokens, by the model id the CLI reports. */
const PRICES: Readonly<Record<string, Price>> = {
  "claude-fable-5-2": price(8, 40, 0.2),
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50, 1),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-4-7": price(5, 25, 0.5),
  "claude-opus-4-6": price(5, 25, 0.5),
  "claude-opus-4-5": price(5, 25, 0.5),
  "claude-sonnet-5-5": price(2, 10, 0.1),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-sonnet-4-6": price(3, 15, 0.3),
  "claude-sonnet-4-5": price(3, 15, 0.3),
  "claude-haiku-5-5": price(0.1, 0.5, 0.01),
  "claude-haiku-4-5": price(1, 5, 0.1),
};

/**
 * The price of a model, matched exactly after dropping what does not change the price: a provider
 * prefix (`us.anthropic.`), a context tag (`[1m]`) and a date suffix (`-20251001`, `@20251001`).
 * Undefined for anything else: an alias such as `opus` or an unknown model is never guessed.
 */
export function priceOf(model: string): Price | undefined {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z]+\.)?anthropic\./, "")
    .replace(/[-@]\d{8}$/, "");
  return Object.hasOwn(PRICES, id) ? PRICES[id] : undefined;
}

/** The list-price cost of these tokens on this model; undefined when the model has no price. */
export function tokenCost(model: string, tokens: TokenUsage): number | undefined {
  const p = priceOf(model);
  if (p === undefined) return undefined;
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheWrite * p.cacheWrite + tokens.cacheRead * p.cacheRead) / 1_000_000;
}

/**
 * A call's estimated cost in US dollars: 0 on a local model, else the CLI's own figure, else the
 * price table over the tokens per model. Null when any model of the call has no price. A CLI
 * figure of 0 for a call that used tokens (a crash result's zeroed totals) is not believed.
 */
export function callCost(call: Pick<AgentCallUsage, "cliId" | "model" | "tokens" | "models" | "reportedCostUsd">): number | null {
  if (call.cliId === "ollama") return 0;
  const used = call.tokens.input + call.tokens.output + call.tokens.cacheRead + call.tokens.cacheWrite > 0;
  if (call.reportedCostUsd !== undefined && (call.reportedCostUsd > 0 || !used)) return call.reportedCostUsd;
  const models = Object.entries(call.models ?? { [call.model]: call.tokens });
  let total = 0;
  for (const [model, tokens] of models) {
    const cost = tokenCost(model, tokens);
    if (cost === undefined) return null;
    total += cost;
  }
  return total;
}
