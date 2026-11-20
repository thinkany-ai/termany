/**
 * Build the environment inherited by an interactive PTY.
 *
 * Packaged macOS apps launched from Finder commonly have no LANG/LC_CTYPE.
 * zsh then falls back to a single-byte locale and renders UTF-8 input from an
 * IME as replacement/control characters (for example `�<0086>`) even though
 * the browser-side composition itself completed correctly.
 *
 * Only the character classification locale is repaired. Other locale
 * categories keep the user's values, and an existing UTF-8 locale is left
 * untouched.
 *
 * `paneId` publishes the pane's session id as `TERMANY_PANE_ID`, so a program
 * running inside the pane can tell which pane it is in. Terminals commonly
 * expose such an identifier (`ITERM_SESSION_ID`, `WEZTERM_PANE`, `TMUX_PANE`),
 * and tools that automate a specific pane need it: without one they have to
 * guess from the working directory or scrape the scrollback, both of which
 * pick the wrong pane when several sessions share a directory.
 */
export function ptyEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  paneId?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, TERM: "xterm-256color" };
  removePackageManagerLifecycleEnvironment(env);
  removeAgentSessionEnvironment(env);
  if (paneId) env.TERMANY_PANE_ID = paneId;
  if (platform === "win32") return env;

  const effectiveCharacterLocale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (/utf-?8/i.test(effectiveCharacterLocale)) return env;

  // LC_ALL overrides LC_CTYPE. Remove it only when it would force a
  // non-Unicode character set, then repair LC_CTYPE without changing the
  // user's language or the other locale categories.
  delete env.LC_ALL;
  env.LC_CTYPE = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) env.LANG = env.LC_CTYPE;
  return env;
}

/**
 * npm and pnpm publish their config and package metadata as environment
 * variables while running a package script. The Termany server is itself
 * commonly started with `npm run dev` or `pnpm dev`; passing those variables
 * to an interactive shell makes every later npm command believe the launcher's
 * pnpm-only settings are its own config (and print "Unknown env config").
 *
 * Only clean the environment when a package-manager lifecycle marker is
 * present. A packaged app, or a user who deliberately launches Termany with an
 * npm config variable, keeps that variable unchanged.
 */
function removePackageManagerLifecycleEnvironment(env: NodeJS.ProcessEnv): void {
  if (!Object.keys(env).some((name) => name.toLowerCase() === "npm_lifecycle_event")) return;

  for (const name of Object.keys(env)) {
    const normalized = name.toLowerCase();
    if (
      normalized.startsWith("npm_config_") ||
      normalized.startsWith("npm_package_") ||
      normalized.startsWith("npm_lifecycle_") ||
      normalized === "npm_command" ||
      normalized === "npm_execpath" ||
      normalized === "npm_node_execpath"
    ) {
      delete env[name];
    }
  }
}

/**
 * Variables an agent CLI sets for the commands *it* runs. When Termany itself
 * was started from inside an agent (`npm run dev` run by Claude Code, say), a
 * pane inherits them, and an agent started in that pane believes it is a
 * child of the outer one: Claude Code, for instance, then stops saving its
 * transcript and session file — so nothing could resume it or hand it off.
 * A pane is a fresh terminal; it is nobody's child session.
 */
const AGENT_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
];

function removeAgentSessionEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of AGENT_SESSION_VARIABLES) delete env[name];
}
