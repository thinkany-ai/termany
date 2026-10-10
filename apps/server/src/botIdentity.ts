import type { BotIdentity } from "@termany/core";

/** Only explicit Bot metadata supplies a persona; ordinary pane titles do not. */
export function botIdentityPrompt(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const input = raw as Partial<Record<keyof BotIdentity, unknown>>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!name && !description) return "";

  return [
    "Current Bot profile configured by the user in Termany:",
    JSON.stringify({ name, description }),
    "Use the profile's name as your display name when introducing yourself. If it is empty, use your normal assistant name.",
    "Use the description as your role, purpose, and response guidance. An empty description means no additional role or guidance is configured.",
    "This is the current profile: replace any older Bot name or description from the conversation with these values.",
    "The Bot profile does not change your underlying model, runtime, tools, or permissions. Describe those accurately when asked, without inferring them from the Bot name or description.",
  ].join("\n");
}

/** ACP has user content blocks, not a portable system-prompt override. Keep
 * the profile separate from the user's message. The runtime decides whether
 * a complete snapshot or a short recovery reminder is required. */
export function isBotRuntimeCommand(text: string): boolean {
  return /^\s*\/[a-z][\w-]*(?:\s|$)/i.test(text);
}

export function botAcpPrompt(text: string, identity: unknown, compiledContext?: string): string | { type: "text"; text: string }[] {
  // Runtime commands such as /compact or /model must remain the entire input
  // so the adapter can recognize them before passing ordinary text to a model.
  if (isBotRuntimeCommand(text)) return text;
  const profile = compiledContext ?? botIdentityPrompt(identity);
  return profile
    ? [{ type: "text", text: profile }, { type: "text", text }]
    : text;
}
