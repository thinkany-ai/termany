export const AGENT_RESPONSE_INACTIVITY_TIMEOUT_MS = 60_000;

/** Transport heartbeats only keep the HTTP stream open. They do not prove
 * the agent is making progress and must never postpone the user-facing timeout. */
export function isAgentResponseActivity(eventType: string | undefined): boolean {
  return eventType !== "heartbeat";
}
