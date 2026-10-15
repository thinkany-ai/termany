/**
 * OpenAI's Chat Completions API has two spellings for the output-token limit.
 * The o-series and gpt-5-and-newer families are reasoning models that answer
 * the legacy `max_tokens` spelling with HTTP 400 "Unsupported parameter" and
 * only accept `max_completion_tokens`. Older OpenAI models and most other
 * providers on the same wire format (DeepSeek, OpenRouter, local servers)
 * still expect `max_tokens` — and a single provider can host both kinds of
 * model at once, so the choice is made per model, never per provider.
 */
const COMPLETION_ONLY = /^(o\d|gpt-(?:[5-9]|\d{2,}))/;

/** Which token-limit parameter a chat-completions request should carry for this model. */
export function chatTokenLimitParam(model: string): "max_tokens" | "max_completion_tokens" {
  return COMPLETION_ONLY.test(model.trim().toLowerCase()) ? "max_completion_tokens" : "max_tokens";
}

/**
 * Move a legacy `max_tokens` limit onto `max_completion_tokens` when the model
 * requires it, in place. Bodies for other models are left untouched, as are
 * Anthropic-style requests where `max_tokens` is the only spelling.
 */
export function moveLegacyTokenLimit(body: Record<string, any>, model: string): void {
  if (chatTokenLimitParam(model) !== "max_completion_tokens" || body.max_tokens === undefined) return;
  if (body.max_completion_tokens === undefined) body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
}
