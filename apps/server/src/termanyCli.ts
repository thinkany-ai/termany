/**
 * `termany`: a tiny command available inside every local pane.
 *
 *   termany handoff codex     # hand this pane's work to Codex
 *   termany handoff gemini    # …or to any agent in Termany's registry
 *
 * It works from the pane's shell and from inside an agent too — `! termany
 * handoff codex` in Claude Code or Codex runs it as a shell command, and the
 * server then stops that agent and starts the other one.
 *
 * The script only knows which pane it is in (`TERMANY_PANE_ID`) and where the
 * server is (`TERMANY_API`); both are set on the pane's environment. It asks
 * for a *deferred* handoff, because while it runs it is itself the pane's
 * foreground job: the server answers at once, waits for the script to exit
 * (or for the agent that ran it), and only then switches agents.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function termanyCliDir(home = os.homedir()): string {
  return path.join(home, ".termany", "bin");
}

export const TERMANY_CLI_SCRIPT = `#!/bin/sh
# Termany pane helper. Written by the Termany server; local edits are overwritten.
usage() {
  echo "usage: termany handoff <agent>" >&2
  echo "  Hand this pane's agent work to another agent (claude, codex, gemini, …), keeping the context." >&2
  exit 2
}
[ "$1" = "handoff" ] || usage
case "$2" in ""|*[!A-Za-z0-9._-]*) usage ;; esac
if [ -z "$TERMANY_PANE_ID" ] || [ -z "$TERMANY_API" ]; then
  echo "termany: run this inside a Termany terminal pane" >&2
  exit 1
fi
body=$(printf '{"session":"%s","to":"%s","deferred":true}' "$TERMANY_PANE_ID" "$2")
if ! out=$(curl -sS --noproxy '*' --max-time 10 -X POST -H 'Content-Type: application/json' --data "$body" "$TERMANY_API/api/agent-handoff" 2>&1); then
  echo "termany: cannot reach Termany: $out" >&2
  exit 1
fi
case "$out" in
  *'"error"'*)
    msg=$(printf '%s' "$out" | sed -n 's/.*"error":"\\([^"]*\\)".*/\\1/p')
    echo "termany: \${msg:-$out}" >&2
    exit 1
    ;;
esac
echo "termany: handing off to $2…"
`;

/** Write (or refresh) the script. Best-effort: panes work fine without it. */
export function installTermanyCli(home = os.homedir()): string | null {
  if (process.platform === "win32") return null;
  const dir = termanyCliDir(home);
  const file = path.join(dir, "termany");
  try {
    fs.mkdirSync(dir, { recursive: true });
    let current: string | null = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      /* not installed yet */
    }
    if (current !== TERMANY_CLI_SCRIPT) fs.writeFileSync(file, TERMANY_CLI_SCRIPT, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return dir;
  } catch (error) {
    console.warn("[termany] could not install the termany pane command:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Expose the command and the server's address to a local pane's shell. */
export function withTermanyCli(env: NodeJS.ProcessEnv, cliDir: string | null, port: number): NodeJS.ProcessEnv {
  if (!cliDir) return env;
  const out: NodeJS.ProcessEnv = { ...env, TERMANY_API: `http://127.0.0.1:${port}` };
  const parts = (out.PATH ?? "").split(path.delimiter).filter(Boolean);
  // Appended, not prepended: it must never shadow anything the user has.
  if (!parts.includes(cliDir)) out.PATH = [...parts, cliDir].join(path.delimiter);
  return out;
}
