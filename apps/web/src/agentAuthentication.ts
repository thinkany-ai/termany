const INTERACTIVE_AUTHENTICATION_ERROR =
  /(?:authentication required|failed to authenticate|oauth[^\n]*(?:expired|refresh)|authentication[^\n]*(?:expired|failed)|auth readiness probe failed|no provider configured|complete onboarding via \/login|login required|not logged in|\bunauthorized\b)/i;

/** Authentication is an interactive CLI concern, not a generic ACP failure.
 * Match explicit authentication signals across runtimes, while keeping this
 * narrow enough that rate limits and ordinary provider errors do not acquire
 * a misleading login action. */
export function needsInteractiveAgentLogin(agentId: string, error: string | undefined): boolean {
  return Boolean(agentId.trim() && error && INTERACTIVE_AUTHENTICATION_ERROR.test(error));
}

export function authenticationErrorSummary(error: string): string {
  const summary = error.replace(/^internal error:\s*/i, "").trim();
  const jsonStart = summary.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const detail = JSON.parse(summary.slice(jsonStart)) as { error?: unknown };
      if (typeof detail.error === "string" && detail.error.trim()) {
        const reason = detail.error.trim();
        return reason.slice(0, 1).toUpperCase() + reason.slice(1);
      }
    } catch {
      // Keep the readable outer message when an adapter appends malformed JSON.
    }
  }
  return summary;
}
