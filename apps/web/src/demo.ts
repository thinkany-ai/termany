import type { ITerminalBackend } from "@termany/core";
import type { HTab, Pane, TreeNode, Workspace } from "./state/store";

/**
 * Demo mode — a browser-only build of the web app for the marketing site
 * (termany.sh embeds it in an iframe). No PTY server, no persistence, no
 * network: DemoBackend below fakes a tiny scripted shell behind the same
 * ITerminalBackend seam the real backends implement, which is exactly the
 * point the landing page is making.
 *
 * Build with:  VITE_DEMO=1 vite build --base=/demo/
 */
export const isDemo = import.meta.env.VITE_DEMO === "1";

// The demo lives in an iframe on the landing page — grabbing focus on load
// would hijack the visitor's keyboard/scroll. Gate auto-focus on a first click.
let interacted = false;
if (isDemo && typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (interacted = true), true);
}

/** True once the visitor has clicked inside the demo iframe. */
export const demoInteracted = () => interacted;

// --- fake shell --------------------------------------------------------------

const CYAN = "\x1b[38;2;92;207;230m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

const PROMPT = `${CYAN}❯${RESET} `;
const AGENT_PROMPT = `${CYAN}>${RESET} `;

type AgentKind = "claude" | "codex";

/**
 * Session ids that boot straight into a simulated agent instead of the demo
 * shell — registered by demoState() for the panes titled "claude"/"codex".
 */
const AGENT_BOOT = new Map<string, AgentKind>();

/** Rounded welcome box; content is plain text so the padding stays exact. */
function box(lines: string[], width = 48): string {
  const top = `${DIM}╭${"─".repeat(width)}╮${RESET}`;
  const bottom = `${DIM}╰${"─".repeat(width)}╯${RESET}`;
  const body = lines.map(
    (l) => `${DIM}│${RESET} ${l.padEnd(width - 2)} ${DIM}│${RESET}`
  );
  return [top, ...body, bottom].join("\r\n");
}

const AGENT_WELCOME: Record<AgentKind, string> = {
  claude:
    box([
      "✻ Welcome to Claude Code!",
      "",
      "  model  claude-sonnet-5 (BYOK)",
      "  cwd    ~/code/termany",
    ]) +
    `\r\n\r\n  ${DIM}Try “explain the failing build” · /exit to quit${RESET}\r\n` +
    `  ${DIM}(demo — replies are scripted)${RESET}\r\n`,
  codex:
    box([
      ">_ OpenAI Codex CLI",
      "",
      "  model  gpt-5-codex (BYOK)",
      "  cwd    ~/code/termany",
    ]) +
    `\r\n\r\n  ${DIM}Ask anything about this repo · /exit to quit${RESET}\r\n` +
    `  ${DIM}(demo — replies are scripted)${RESET}\r\n`,
};

const FASTFETCH = [
  `${CYAN}you${RESET}${DIM}@${RESET}${CYAN}termany${RESET}`,
  `${DIM}─────────────────────────${RESET}`,
  `${CYAN}Terminal${RESET}${DIM}:${RESET} Termany (web demo)`,
  `${CYAN}Backend${RESET}${DIM}:${RESET} DemoBackend (in-browser, no server)`,
  `${CYAN}UI${RESET}${DIM}:${RESET} React 19 · xterm.js`,
  `${CYAN}Layout${RESET}${DIM}:${RESET} workspace ▸ vertical tab ▸ horizontal tab`,
  `${CYAN}AI${RESET}${DIM}:${RESET} Claude · BYOK · ~/.termany`,
];

const FILES = [
  `${BLUE}node_modules${RESET}`,
  `${BLUE}src${RESET}`,
  "README.md",
  "package.json",
  "vite.config.ts",
];

const README = [
  `${BOLD}# Termany${RESET}`,
  "",
  "An agent-native terminal — local-first, cloud-ready. The same UI runs on the web,",
  "on the desktop, and (soon) in the cloud, by swapping one backend seam.",
  "",
  `${DIM}This pane is running DemoBackend — the real app runs your actual shell.${RESET}`,
];

const HELP: [string, string][] = [
  ["help", "this list"],
  ["fastfetch", "system info card"],
  ["ls / cat README.md", "poke around a fake repo"],
  ["pnpm dev:web", "start a (simulated) dev server"],
  ["claude / codex", "launch an agent (simulated)"],
  ["ai <question>", "what the AI layer feels like"],
  ["clear", "wipe the screen (or ⌃L)"],
];

export class DemoBackend implements ITerminalBackend {
  private dataCb: ((data: string) => void) | null = null;
  private queued: string[] = [];
  private line = "";
  private history: string[] = [];
  private histIdx = -1;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** True while a fake long-running command owns the pane (⌃C to stop). */
  private busy = false;
  /** "shell", or the simulated agent REPL this pane is inside. */
  private mode: "shell" | AgentKind = "shell";

  constructor(sessionId?: string) {
    // Panes pre-registered by demoState() boot straight into their agent —
    // the landing page's "one agent per pane" pitch, visible on load.
    const agent = sessionId ? AGENT_BOOT.get(sessionId) : undefined;
    if (agent) {
      this.out(`${PROMPT}${agent}\r\n`);
      this.enterAgent(agent);
      this.out(this.prompt());
    } else {
      this.out(`${FASTFETCH.join("\r\n")}\r\n`);
      this.out(`\r\n${DIM}demo shell — type ${RESET}help${DIM} to see what it can do.${RESET}\r\n\r\n`);
      this.out(PROMPT);
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
    for (const chunk of this.queued.splice(0)) cb(chunk);
  }

  onExit(_cb: () => void): void {
    /* the demo session never ends */
  }

  uploadFiles(_paths: string[]): void {
    /* the demo shell has no remote side to upload to */
  }

  resize(_cols: number, _rows: number): void {
    /* nothing to tell — there is no PTY */
  }

  dispose(): void {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    this.dataCb = null;
  }

  /** User keystrokes (or pasted text) from xterm. */
  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Swallow escape sequences; only history arrows do anything.
      if (ch === "\x1b") {
        const seq = data.slice(i, i + 3);
        if (seq === "\x1b[A") this.recall(-1);
        else if (seq === "\x1b[B") this.recall(1);
        i += seq.startsWith("\x1b[") ? 2 : 0;
        continue;
      }

      if (ch === "\x03") {
        // ^C — stop a fake job / leave the agent / abandon the current line
        this.stopJob();
        if (this.mode !== "shell") {
          this.mode = "shell";
          this.out(`^C\r\n${DIM}(agent closed — back to the shell)${RESET}\r\n${PROMPT}`);
        } else {
          this.out(`^C\r\n${PROMPT}`);
        }
        this.line = "";
        this.histIdx = -1;
        continue;
      }

      if (this.busy) continue; // a fake job owns the pane — only ^C above works

      if (ch === "\r") {
        this.out("\r\n");
        const cmd = this.line.trim();
        this.line = "";
        this.histIdx = -1;
        if (cmd) {
          this.history.push(cmd);
          if (this.mode === "shell") this.exec(cmd);
          else this.agentInput(cmd);
        }
        if (!this.busy) this.out(this.prompt());
        continue;
      }

      if (ch === "\x7f") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.out("\b \b");
        }
        continue;
      }

      if (ch === "\x0c") {
        this.out(`\x1b[2J\x1b[H${this.prompt()}${this.line}`);
        continue;
      }

      if (ch >= " ") {
        this.line += ch;
        this.out(ch);
      }
    }
  }

  // --- internals -------------------------------------------------------------

  private out(data: string): void {
    if (this.dataCb) this.dataCb(data);
    else this.queued.push(data);
  }

  /** The prompt for the pane's current mode. */
  private prompt(): string {
    return this.mode === "shell" ? PROMPT : AGENT_PROMPT;
  }

  private recall(step: number): void {
    if (!this.history.length) return;
    if (this.histIdx === -1 && step > 0) return;
    const idx =
      this.histIdx === -1
        ? this.history.length - 1
        : Math.min(Math.max(this.histIdx + step, 0), this.history.length);
    this.out(`\r\x1b[K${this.prompt()}`);
    if (idx >= this.history.length) {
      this.histIdx = -1;
      this.line = "";
      return;
    }
    this.histIdx = idx;
    this.line = this.history[idx];
    this.out(this.line);
  }

  private stopJob(): void {
    this.busy = false;
    for (const t of this.timers.splice(0)) clearTimeout(t);
  }

  /** Show an agent's welcome screen and switch the pane into its REPL. */
  private enterAgent(kind: AgentKind): void {
    this.mode = kind;
    this.out(`\r\n${AGENT_WELCOME[kind]}\r\n`);
  }

  /** One scripted round-trip inside the simulated agent REPL. */
  private agentInput(input: string): void {
    if (input === "/exit" || input === "exit" || input === "quit") {
      this.mode = "shell";
      this.out(`${DIM}(agent closed — back to the shell)${RESET}\r\n`);
      return;
    }
    const kind = this.mode as AgentKind;
    this.busy = true;
    this.later(400, () => this.out(`${DIM}✻ Thinking…${RESET}\r\n`));
    this.later(1100, () => {
      this.out(
        `\r\n  In the real Termany, ${BOLD}${kind}${RESET} works on your\r\n` +
          `  repo right here — this demo only plays\r\n` +
          `  the intro. ${DIM}Download the app for the real thing.${RESET}\r\n\r\n`
      );
      this.busy = false;
      this.out(this.prompt());
    });
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private exec(input: string): void {
    const [cmd, ...args] = input.split(/\s+/);
    const arg = args.join(" ");

    switch (cmd) {
      case "help":
        for (const [c, desc] of HELP) {
          this.out(`  ${CYAN}${c.padEnd(20)}${RESET}${DIM}${desc}${RESET}\r\n`);
        }
        return;

      case "fastfetch":
      case "neofetch":
        this.out(`${FASTFETCH.join("\r\n")}\r\n`);
        return;

      case "ls":
        this.out(`${FILES.join("  ")}\r\n`);
        return;

      case "cat":
        if (arg === "README.md") this.out(`${README.join("\r\n")}\r\n`);
        else this.out(`cat: ${arg || "?"}: no such file ${DIM}(demo fs is tiny)${RESET}\r\n`);
        return;

      case "pwd":
        this.out("~/code/app\r\n");
        return;

      case "whoami":
        this.out("guest\r\n");
        return;

      case "echo":
        this.out(`${arg}\r\n`);
        return;

      case "clear":
        this.out("\x1b[2J\x1b[H");
        return;

      case "claude":
      case "codex":
        this.enterAgent(cmd);
        return;

      case "pnpm":
      case "npm":
        if (args[0] === "dev" || (args[0] === "run" && args[1] === "dev")) {
          this.fakeDevServer();
          return;
        }
        break;

      case "ai":
        this.out(
          `\r\n${CYAN}▸ AI${RESET} ${DIM}claude-sonnet-5 · BYOK${RESET}\r\n` +
            (arg
              ? `  ${DIM}“${arg}” — in the real Termany I'd read this pane's output and answer inline.${RESET}\r\n`
              : `  ${DIM}Pipe terminal output to Claude for inline suggestions and error diagnosis.${RESET}\r\n`) +
            `  ${DIM}Your key stays local in ~/.termany — nothing leaves your machine.${RESET}\r\n\r\n`
        );
        return;

      case "exit":
      case "logout":
        this.out(`${DIM}nice try — this demo pane stays open. Get the real thing at termany.sh${RESET}\r\n`);
        return;

      case "sudo":
        this.out(`${RED}guest is not in the sudoers file. This incident will be reported.${RESET} ${DIM}(kidding — it's a demo)${RESET}\r\n`);
        return;
    }

    this.out(
      `zsh: command not found: ${cmd}\r\n${DIM}(demo shell — the real Termany runs your actual shell. try ${RESET}help${DIM})${RESET}\r\n`
    );
  }

  private fakeDevServer(): void {
    this.busy = true;
    this.out(`\r\n${DIM}> app@0.1.2 dev${RESET}\r\n${DIM}> vite${RESET}\r\n\r\n`);
    this.later(500, () => {
      this.out(`  ${GREEN}VITE v6.0.3${RESET}  ready in ${BOLD}312 ms${RESET}\r\n\r\n`);
      this.out(`  ${GREEN}➜${RESET}  Local:   ${CYAN}http://localhost:3000/${RESET}\r\n`);
      this.out(`  ${GREEN}➜${RESET}  Network: ${DIM}use --host to expose${RESET}\r\n\r\n`);
      this.out(`  ${DIM}watching for changes… press ${RESET}⌃C${DIM} to stop${RESET}\r\n`);
    });
    this.later(2600, () => {
      this.out(`  ${YELLOW}hmr${RESET} ${DIM}update /src/App.tsx${RESET}\r\n`);
    });
  }
}

// --- curated demo layout -----------------------------------------------------

const uid = () => crypto.randomUUID();

function leaf(title: string): Extract<Pane, { kind: "leaf" }> {
  const l: Extract<Pane, { kind: "leaf" }> = { kind: "leaf", id: uid(), title };
  // Panes named after an agent boot straight into that agent's welcome screen.
  if (title === "claude" || title === "codex") AGENT_BOOT.set(l.id, title);
  return l;
}

function htab(title: string): HTab {
  const l = leaf(title);
  return { id: uid(), title, layout: l, focused: l.id };
}

/** A tab that boots as two side-by-side panes (the "agent per pane" pitch). */
function htabSplit(title: string, left: string, right: string): HTab {
  const a = leaf(left);
  const b = leaf(right);
  return {
    id: uid(),
    title,
    layout: { kind: "split", dir: "row", children: [a, b] },
    focused: a.id,
  };
}

function node(title: string, htabs: HTab[], children: TreeNode[] = []): TreeNode {
  return { id: uid(), title, expanded: true, children, htabs, activeHTab: htabs[0].id };
}

/**
 * The layout the demo boots with — a project-organized three-level file tree
 * (termany ▸ web ▸ api/landing), with the active page's tab already split
 * into two panes (one agent each).
 */
export function demoState(): {
  workspaces: Workspace[];
  activeWorkspace: string;
  activeNodes: Record<string, string>;
} {
  const api = node("api", [htabSplit("agents", "claude", "codex"), htab("server")]);
  const landing = node("landing", [htab("dev")]);
  const web = node("web", [htab("shell")], [api, landing]);
  const desktop = node("app", [htab("shell")]);
  const termany = node("termany", [htab("shell")], [desktop, web]);
  const shipany = node(
    "shipany",
    [htab("shell")],
    [
      {
        // starts collapsed — expand to reveal the third level
        ...node(
          "shipany-tanstack",
          [htab("shell")],
          [node("admin", [htab("shell")]), node("landing", [htab("shell")])]
        ),
        expanded: false,
      },
      node("shipany-next", [htab("shell")]),
      node("shipany-vinext", [htab("shell")]),
    ]
  );
  const cconline = node("cconline", [htab("shell")]);
  const app: Workspace = {
    id: uid(),
    title: "code",
    icon: "📦",
    roots: [termany, shipany, cconline],
  };

  const scratch = node("scratch", [htab("shell")]);
  const play: Workspace = {
    id: uid(),
    title: "play",
    icon: "🧪",
    roots: [scratch],
  };

  return {
    workspaces: [app, play],
    activeWorkspace: app.id,
    activeNodes: { [app.id]: api.id, [play.id]: scratch.id },
  };
}
