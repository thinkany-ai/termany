/** Display helpers for the pane header's folder — pure, so testable alone. */

/** "/Users/me/code/x" → "~/code/x" when it sits under `home`. */
export function tildePath(path: string, home: string): string {
  if (!home) return path;
  const base = home.replace(/[\\/]+$/, "");
  if (path === base) return "~";
  if (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) return `~${path.slice(base.length)}`;
  return path;
}

/**
 * Shorten for a narrow header: keep the start ("~" or root) and the last
 * `keep` folders, e.g. "~/code/termany/apps/web" → "~/…/apps/web".
 */
export function shortPath(path: string, keep = 2): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(sep);
  // ["~", a, b, c] or ["", a, b, c] (absolute) — the head is parts[0].
  if (parts.length <= keep + 2) return path;
  return [parts[0], "…", ...parts.slice(-keep)].join(sep);
}
