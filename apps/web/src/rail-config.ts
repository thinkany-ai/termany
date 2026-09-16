/** Quick-action entries whose visibility can be customized in Settings. */
export const RAIL_ITEM_IDS = [
  "terminal",
  "files",
  "git",
  "agent",
  "web",
  "monitor",
  "agents",
  "providers",
  "history",
  "usage",
] as const;

export type RailItemId = (typeof RAIL_ITEM_IDS)[number];
export type RailVisibility = Record<RailItemId, boolean>;

const STORAGE_KEY = "termany.rail-items";

export const DEFAULT_RAIL_VISIBILITY: RailVisibility = {
  terminal: true,
  files: true,
  git: true,
  agent: true,
  web: true,
  monitor: true,
  agents: true,
  providers: true,
  history: true,
  usage: true,
};

/** Keep only known boolean values; missing/new entries remain visible. */
export function normalizeRailVisibility(value: unknown): RailVisibility {
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    RAIL_ITEM_IDS.map((id) => [id, typeof saved[id] === "boolean" ? saved[id] : true]),
  ) as RailVisibility;
}

export function loadRailVisibility(): RailVisibility {
  try {
    return normalizeRailVisibility(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_RAIL_VISIBILITY };
  }
}

export function saveRailVisibility(value: RailVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeRailVisibility(value)));
  } catch {
    /* localStorage may be blocked; the in-memory setting still applies. */
  }
}
