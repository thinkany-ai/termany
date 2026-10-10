/**
 * Connectivity test for a model provider — "does this key + base URL actually
 * work", answered before the config is saved.
 *
 * Runs server-side for the same reason theme.ts does: an API key must never
 * reach the browser. When the caller is editing an existing provider it may
 * omit the key entirely (or send the mask back); the stored key is looked up
 * here by provider id, so the secret never round-trips.
 */
import { loadConfig, type ProviderKind } from "./config.js";
import { chatTokenLimitParam } from "./chatTokens.js";

export interface TestInput {
  kind: ProviderKind;
  apiBase: string;
  apiKey: string;
  model: string;
  /** Set when editing a saved provider — lets a blank/masked key mean "use the stored one". */
  providerId?: string;
}

export interface TestResult {
  ok: boolean;
  /** Upstream/validation failure, verbatim enough to be actionable. */
  error?: string;
  /** The endpoint that was actually called, echoed for the UI. */
  endpoint: string;
  /** Model name the upstream reported back, when it sends one. */
  model?: string;
}

const TIMEOUT_MS = 20_000;
const DEFAULT_BASE: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/**
 * Join base + endpoint without doubling a version segment: users paste both
 * "https://api.deepseek.com" and "https://api.deepseek.com/v1", and either
 * must end up at exactly one /v1/chat/completions.
 */
function joinUrl(base: string, endpoint: string): string {
  const b = base.replace(/\/+$/, "");
  const e = "/" + endpoint.replace(/^\/+/, "");
  if (b.endsWith(e)) return b;
  if (e.startsWith("/v1/") && b.endsWith("/v1")) return b + e.slice("/v1".length);
  return b + e;
}

/** The URL a test would call — also rendered in the dialog as a hint. */
export function testEndpoint(apiBase: string, kind: ProviderKind): string {
  const base = apiBase.trim() || DEFAULT_BASE[kind];
  return joinUrl(base, kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
}

/** Trim an upstream error body to something that fits in a dialog. */
function short(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

export async function testProvider(input: TestInput): Promise<TestResult> {
  const kind: ProviderKind = input.kind === "anthropic" ? "anthropic" : "openai";
  const model = input.model.trim();
  const endpoint = testEndpoint(input.apiBase, kind);

  if (!model) return { ok: false, endpoint, error: "Enter a model to test" };

  // A blank or still-masked key means "keep what's stored" (same convention as
  // saveConfig), so resolve it from the saved provider instead of failing.
  let apiKey = input.apiKey.trim();
  if ((!apiKey || /[•*]/.test(apiKey)) && input.providerId) {
    apiKey = loadConfig().providers.find((p) => p.id === input.providerId)?.apiKey ?? "";
  }
  if (!apiKey) return { ok: false, endpoint, error: "API key is required to test" };

  // Legacy OpenAI models and Anthropic answer fine inside a 1-token cap.
  // Reasoning-era OpenAI models (o-series, gpt-5+) reject the legacy
  // max_tokens spelling and spend the budget on hidden reasoning before the
  // first visible token, so a 1-token probe can never finish — give them
  // room to answer cheaply instead.
  const probe = kind === "anthropic" || chatTokenLimitParam(model) === "max_tokens"
    ? { max_tokens: 1 }
    : { max_completion_tokens: 512, reasoning_effort: "low" };
  const body = JSON.stringify({
    model,
    ...probe,
    messages: [{ role: "user", content: "hi" }],
  });
  const headers: Record<string, string> =
    kind === "anthropic"
      ? {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { method: "POST", headers, body, signal: abort.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, endpoint, error: `HTTP ${res.status}: ${short(text)}` };

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, endpoint, error: `upstream returned non-JSON: ${short(text)}` };
    }
    // A 200 with an empty completion means the endpoint answered but the model
    // name (or the wire format) is wrong — worth failing loudly.
    const answered =
      kind === "anthropic" ? Array.isArray(data?.content) : Array.isArray(data?.choices) && data.choices.length > 0;
    if (!answered) {
      return { ok: false, endpoint, error: `unexpected response shape: ${short(text)}` };
    }
    return { ok: true, endpoint, model: typeof data?.model === "string" ? data.model : undefined };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      endpoint,
      error: abort.signal.aborted ? `timed out after ${TIMEOUT_MS / 1000}s` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}
