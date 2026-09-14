import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ClientConnection,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { findAgentConfig, type AgentConfig } from "./agentConfig.js";
import { overriddenCredentials, subscriptionEnvironment } from "./agentCredentials.js";
import { getMeta, setMeta } from "./db.js";
import { resolveExecutable, spawnEnvironment } from "./shellPath.js";
import { agentEnvironment } from "./agentEnvironment.js";
import { botAcpPrompt } from "./botIdentity.js";
import { splitAgentRuntimeNotices } from "@termany/core";
import { AcpConfigCompatibility } from "./acpConfigCompatibility.js";
import { checkNativeAcpSupport } from "./nativeAcp.js";
import { checkGeminiAuthSupport } from "./geminiAuth.js";
import { prepareManagedAcpLaunch } from "./managedAcp.js";
import { stopAgentProcess } from "./agentProcess.js";
import { loadAgentImages, saveAgentOutputImages, type LoadedAgentImage, type StoredAgentImage } from "./agentImages.js";
import { FastClawRuntime } from "./fastClawRuntime.js";

export type AcpRuntimeEvent =
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "thought"; text: string }
  | ({ type: "image" } & StoredAgentImage)
  | { type: "activity"; title: string; status?: string; phase?: "starting" | "processing" }
  | { type: "tool"; id: string; title?: string; status?: string; input?: string; output?: string }
  | { type: "permission"; requestId: string; title: string; options: PermissionOption[] }
  | { type: "done"; sessionId: string };

type Emit = (event: AcpRuntimeEvent) => void;

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in runtime arguments");
  if (current) args.push(current);
  return args;
}

async function executablePath(command: string): Promise<string> {
  const found = await resolveExecutable(command);
  if (found) return found;
  throw new Error(`Agent runtime command not found: ${command}`);
}

/** Flatten a select's values; ACP allows either a plain list or grouped lists. */
function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry ? entry.options.map((child) => child.value) : [entry.value]
  );
}

function textFromUpdate(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
  const content = update.content;
  return content.type === "text" ? content.text : undefined;
}

function replacementCount(text: string): number {
  return text.split("\uFFFD").length - 1;
}

/** Keep tool detail blobs bounded — they persist with the conversation. */
const TOOL_DETAIL_LIMIT = 10_000;
// A few adapters can ignore session/cancel and leave nextUpdate() blocked.
// Without a fallback, that pane rejects every later turn as already busy.
const CANCEL_GRACE_MS = 3_000;

function clipDetail(text: string): string | undefined {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.trim()) return undefined;
  return trimmed.length > TOOL_DETAIL_LIMIT ? `${trimmed.slice(0, TOOL_DETAIL_LIMIT)}…` : trimmed;
}

/** Shell-style tools show their command as `$ …`; anything else pretty JSON. */
function formatToolInput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const command = (raw as { command?: unknown }).command;
  if (typeof command === "string" && command.trim()) return clipDetail(`$ ${command}`);
  try {
    return clipDetail(JSON.stringify(raw, null, 2));
  } catch {
    return undefined;
  }
}

function formatToolOutput(content: unknown, rawOutput: unknown): string | undefined {
  const items = Array.isArray(content) ? content : [];
  const chunks = items
    .map((item: { type?: string; content?: { type?: string; text?: string } }) =>
      item?.type === "content" && item.content?.type === "text" ? item.content.text ?? "" : ""
    )
    .filter(Boolean);
  if (chunks.length) return clipDetail(chunks.join("\n"));
  if (rawOutput == null) return undefined;
  if (typeof rawOutput === "string") return clipDetail(rawOutput);
  try {
    return clipDetail(JSON.stringify(rawOutput, null, 2));
  } catch {
    return undefined;
  }
}

class Runtime {
  private emit: Emit | null = null;
  private prompting = false;
  private hasPrompted = false;
  private promptSignal: AbortSignal | null = null;
  private stderr = "";
  private replayCapture: { sessionId: string; finalText: string; lastUpdateAt: number } | null = null;
  /** Model/mode/effort selectors the agent offers for this session, with their
   *  current values. Refreshed from every reply the agent sends about them —
   *  it can change them on its own (a slash command, a fallback), and a stale
   *  copy would show the user a model that is not the one answering. */
  private configOptions: SessionConfigOption[];
  private pendingPermissions = new Map<
    string,
    { resolve: (response: RequestPermissionResponse) => void; options: PermissionOption[] }
  >();

  private constructor(
    readonly paneId: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private session: ActiveSession,
    private readonly compatibility: AcpConfigCompatibility,
    private readonly supportsImagePrompts: boolean,
    private readonly supportsSessionLoad: boolean
  ) {
    this.configOptions = session.newSessionResponse.configOptions ?? [];
    rememberConfig(agent.id, this.configOptions);
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000);
    });
    child.once("exit", (code, signal) => {
      stopAgentProcess(child);
      const detail = this.stderr.trim();
      this.connection.close(new Error(`Agent runtime exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      this.cancelPermissions();
      if (runtimes.get(paneId) === this) runtimes.delete(paneId);
    });
  }

  static async create(paneId: string, agent: AgentConfig, cwd: string, saved?: SuspendedRuntime): Promise<Runtime> {
    const spec = agent.runtime;
    if (!spec || spec.protocol !== "acp") throw new Error(`${agent.name} has no ACP runtime configured`);
    if (spec.modelSource === "termany") {
      throw new Error("Termany model routing for ACP runtimes is not available yet; choose Agent-managed models");
    }

    // Reuse user-installed CLIs and their dependencies, with Termany's Node
    // first on PATH for both native ACP CLIs and managed bridges.
    let env = subscriptionEnvironment(agentEnvironment(await spawnEnvironment()), agent);
    let command: string;
    let args: string[];
    if (spec.distribution === "managed") {
      const launch = await prepareManagedAcpLaunch(agent, env, splitArgs(spec.args));
      command = launch.command;
      args = launch.args;
      env = launch.env;
    } else {
      command = await executablePath(spec.command);
      args = splitArgs(spec.args);
    }
    await checkGeminiAuthSupport(agent, env);
    await checkNativeAcpSupport(agent, command, env);
    const dropped = overriddenCredentials(agent).filter((name) => name in process.env);
    if (dropped.length) {
      console.log(`[termany] ${agent.name}: using its own login, ignoring ${dropped.join(", ")}`);
    }
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let runtime: Runtime | undefined;
    let stderr = "";
    // Capture failures from startup too (bad interpreter, unsupported ACP, etc.).
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8_000); });
    const app = client({ name: "Termany" }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) => runtime?.requestPermission(params) ?? { outcome: { outcome: "cancelled" as const } }
    ).onNotification(methods.client.session.update, ({ params }) => runtime?.captureReplayUpdate(params));
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const compatibility = new AcpConfigCompatibility();
    const connection = app.connect({
      writable: stream.writable,
      readable: stream.readable.pipeThrough(new TransformStream({
        transform(message, controller) { controller.enqueue(compatibility.normalize(message)); },
      })),
    });
    child.once("error", (error) => connection.close(error));
    child.once("exit", (code, signal) => {
      if (!runtime) connection.close(new Error(`Agent runtime exited (${signal ?? code ?? "unknown"})`));
    });
    const startupTimeout = setTimeout(() => connection.close(new Error(
      `${agent.name} did not start ACP within 60 seconds. Check its CLI version and login.`
    )), 60_000);
    try {
      const initialization = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Termany", version: "0.1.21" },
      });
      let session: ActiveSession;
      if (saved?.sessionId) {
        if (!initialization.agentCapabilities?.loadSession) {
          throw new Error("Agent no longer supports restoring this conversation");
        }
        // Attach after load: transcript replay must not leak into the next reply.
        const response = await connection.agent.request(methods.agent.session.load, {
          sessionId: saved.sessionId, cwd, mcpServers: [],
        });
        session = connection.agent.attachSession({ ...response, sessionId: saved.sessionId });
      } else {
        session = await connection.agent.buildSession(cwd).start();
      }
      runtime = new Runtime(paneId, agent, cwd, child, connection, session, compatibility,
        initialization.agentCapabilities?.promptCapabilities?.image === true,
        initialization.agentCapabilities?.loadSession === true);
      runtime.hasPrompted = Boolean(saved?.sessionId);
      return runtime;
    } catch (error) {
      connection.close(error);
      stopAgentProcess(child);
      const detail = stderr.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`);
    } finally {
      clearTimeout(startupTimeout);
    }
  }

  async prompt(text: string, emit: Emit, signal: AbortSignal, botIdentity?: unknown,
    images: LoadedAgentImage[] = []): Promise<void> {
    signal.throwIfAborted();
    if (this.prompting) throw new Error("This agent is already responding");
    this.prompting = true;
    this.hasPrompted = true;
    this.promptSignal = signal;
    this.emit = emit;
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      this.cancelPermissions();
      void this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.session.sessionId }).catch(() => undefined);
      forceClose = setTimeout(() => {
        if (this.prompting && this.promptSignal === signal) this.close();
      }, CANCEL_GRACE_MS);
      forceClose.unref?.();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const base = botAcpPrompt(text, botIdentity);
      let prompt: string | ContentBlock[] = base;
      if (images.length) {
        const blocks: ContentBlock[] = typeof base === "string" ? [{ type: "text", text: base }] : base;
        prompt = this.supportsImagePrompts
          ? [...blocks, ...images.map((image): ContentBlock => ({
              type: "image", data: image.data, mimeType: image.mimeType,
            }))]
          : [...blocks, { type: "text", text: `Attached local image files:\n${images.map((image) => image.path).join("\n")}` }];
      }
      void this.session.prompt(prompt).catch(() => undefined);
      const emittedImageIds = new Set<string>();
      const unfinishedToolIds = new Set<string>();
      let streamedText = "";
      let sawTool = false;
      const emitImages = async (content: unknown) => {
        for (const image of await saveAgentOutputImages(content)) {
          if (emittedImageIds.has(image.id)) continue;
          emittedImageIds.add(image.id);
          emit({ type: "image", ...image });
        }
      };
      while (true) {
        const message = await this.session.nextUpdate();
        if (message.kind === "stop") break;
        const update = message.update;
        const textChunk = textFromUpdate(update);
        if (textChunk) {
          if (update.sessionUpdate === "agent_thought_chunk") {
            emit({ type: "thought", text: textChunk });
          } else {
            const { content, notices } = splitAgentRuntimeNotices(textChunk);
            for (const notice of notices) console.warn(`[termany] ${this.agent.name}: ${notice}`);
            if (content) {
              streamedText += content;
              emit({ type: "delta", text: content });
            }
          }
        } else if (update.sessionUpdate === "config_option_update") {
          this.configOptions = update.configOptions;
          rememberConfig(this.agent.id, this.configOptions);
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          sawTool = true;
          // tool_call_update carries only changed fields; the client merges by id.
          if (update.status === "pending" || update.status === "in_progress") {
            unfinishedToolIds.add(update.toolCallId);
          } else if (update.status) {
            unfinishedToolIds.delete(update.toolCallId);
          }
          emit({
            type: "tool",
            id: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
            input: formatToolInput(update.rawInput),
            output: formatToolOutput(update.content, update.rawOutput),
          });
          await emitImages(update.content);
        } else if (update.sessionUpdate === "agent_message_chunk") {
          await emitImages(update.content);
        }
      }
      if (!sawTool && streamedText.includes("\uFFFD")) {
        const recovered = await this.recoverFinalText();
        if (recovered && replacementCount(recovered) < replacementCount(streamedText)) {
          emit({ type: "replace", text: recovered });
        }
      }
      // Some ACP adapters finish the turn without sending a terminal update
      // for their final tool call. The turn's stop event is authoritative: at
      // this point the tool is no longer running, so clear any stale spinner
      // before telling the web client that the reply is done.
      for (const id of unfinishedToolIds) emit({ type: "tool", id, status: "completed" });
      emit({ type: "done", sessionId: this.session.sessionId });
    } finally {
      if (forceClose) clearTimeout(forceClose);
      signal.removeEventListener("abort", cancel);
      this.emit = null;
      this.promptSignal = null;
      this.prompting = false;
      if (signal.aborted) this.cancelPermissions();
    }
  }

  private captureReplayUpdate(notification: SessionNotification): void {
    const capture = this.replayCapture;
    if (!capture || notification.sessionId !== capture.sessionId) return;
    const update = notification.update;
    capture.lastUpdateAt = Date.now();
    if (update.sessionUpdate === "user_message_chunk") {
      capture.finalText = "";
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      capture.finalText += update.content.text;
    }
  }

  /** ACP streams are best-effort UI output. If one contained invalid UTF-8 replacement
   * characters, replay the agent's persisted transcript and use its authoritative final
   * assistant message. This is intentionally lazy so ordinary turns pay no extra request. */
  private async recoverFinalText(): Promise<string | undefined> {
    if (!this.supportsSessionLoad) return;
    const response = this.session.newSessionResponse;
    const capture = { sessionId: this.session.sessionId, finalText: "", lastUpdateAt: 0 };
    this.session.dispose();
    this.replayCapture = capture;
    try {
      await this.connection.agent.request(methods.agent.session.load, {
        sessionId: capture.sessionId, cwd: this.cwd, mcpServers: [],
      });
      // Incoming responses can resolve just before queued notification handlers finish.
      // Wait for a short quiet period, bounded so a broken agent cannot stall the reply.
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const lastUpdateAt = capture.lastUpdateAt;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (lastUpdateAt > 0 && capture.lastUpdateAt === lastUpdateAt) break;
      }
      return capture.finalText || undefined;
    } catch (error) {
      console.warn(`[termany] ${this.agent.name}: could not recover corrupted ACP text: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return undefined;
    } finally {
      this.replayCapture = null;
      this.session = this.connection.agent.attachSession(response);
    }
  }

  checkpoint(): SuspendedRuntime | undefined {
    if (this.prompting || (this.hasPrompted && !this.supportsSessionLoad)) return;
    return {
      agent: this.agent, cwd: this.cwd, config: this.configOptions,
      sessionId: this.hasPrompted ? this.session.sessionId : undefined,
    };
  }

  get config(): SessionConfigOption[] {
    return this.configOptions;
  }

  /** Set one selector, returning the agent's own view of every option after. */
  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    const option = this.configOptions.find((entry) => entry.id === configId);
    if (!option) throw new Error(`${this.agent.name} has no "${configId}" option in this session`);
    if (option.type === "select" && !selectValues(option).includes(value)) {
      throw new Error(`Invalid value for ${this.agent.name}'s ${configId} option`);
    }
    const legacy = this.compatibility.legacyKind(configId);
    if (legacy) {
      await this.connection.agent.request(
        legacy === "model" ? "session/set_model" : methods.agent.session.setMode,
        { sessionId: this.session.sessionId, ...(legacy === "model" ? { modelId: value } : { modeId: value }) }
      );
      this.compatibility.setCurrent(legacy, value);
      this.configOptions = this.compatibility.options;
      rememberConfig(this.agent.id, this.configOptions);
      return this.configOptions;
    }
    const response = await this.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: this.session.sessionId,
      configId,
      ...(option.type === "boolean" ? { type: "boolean" as const, value: value === "true" } : { value }),
    });
    this.compatibility.replaceOptions(response.configOptions);
    this.configOptions = this.compatibility.options;
    rememberConfig(this.agent.id, this.configOptions);
    return this.configOptions;
  }

  /**
   * Re-apply the picks a pane remembers. Sessions are per-process and start on
   * the agent's own defaults, so without this a restart — switching folders,
   * relaunching the app, a crashed adapter — would silently drop back to the
   * default model mid-conversation.
   *
   * Values the agent no longer offers are skipped rather than failing the whole
   * turn: model line-ups change under us between releases.
   */
  async applyConfig(picks: Record<string, string>): Promise<void> {
    for (const [configId, value] of Object.entries(picks)) {
      const option = this.configOptions.find((entry) => entry.id === configId);
      if (!option || option.currentValue === value) continue;
      if (option.type === "select" && !selectValues(option).includes(value)) continue;
      try {
        await this.setConfigOption(configId, value);
      } catch (error) {
        console.log(
          `[termany] ${this.agent.name}: could not restore ${configId}=${value}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || !pending.options.some((option) => option.optionId === optionId)) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  close(): void {
    if (runtimes.get(this.paneId) === this) runtimes.delete(this.paneId);
    this.cancelPermissions();
    this.session.dispose();
    this.connection.close();
    stopAgentProcess(this.child);
  }

  private requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.emit || this.promptSignal?.aborted) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, options: params.options });
      this.emit?.({
        type: "permission",
        requestId,
        title: params.toolCall.title || "Allow this action?",
        options: params.options,
      });
    });
  }

  private cancelPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }
}

type RuntimeHandle = Runtime | FastClawRuntime;

const runtimes = new Map<string, RuntimeHandle>();
interface SuspendedRuntime {
  agent: AgentConfig;
  cwd: string;
  config: SessionConfigOption[];
  sessionId?: string;
}
const suspended = new Map<string, SuspendedRuntime>();
const starting = new Map<string, Promise<RuntimeHandle>>();
const usage = new WeakMap<RuntimeHandle, { active: number; lastUsed: number }>();
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Only idle, resumable conversations (or unused config probes) can be reaped. */
export function reapIdleAcpRuntimes(now = Date.now()): void {
  for (const [paneId, runtime] of runtimes) {
    const state = usage.get(runtime);
    if (!(runtime instanceof Runtime) || !state || state.active || now - state.lastUsed < IDLE_TIMEOUT_MS) continue;
    const checkpoint = runtime.checkpoint();
    if (!checkpoint) continue;
    suspended.set(paneId, checkpoint);
    runtime.close();
  }
}
setInterval(reapIdleAcpRuntimes, 30_000).unref();

async function useRuntime<T>(input: AcpRuntimeTarget, action: (runtime: RuntimeHandle) => Promise<T>): Promise<T> {
  const runtime = await acquire(input);
  const state = usage.get(runtime)!;
  state.active++;
  try { return await action(runtime); }
  finally { state.active--; state.lastUsed = Date.now(); }
}

/**
 * Last selector list each agent reported, kept in SQLite so it also survives a
 * relaunch — the first dropdown of the day is the one most worth being quick.
 * Only ever a display shortcut: nothing is *applied* from here, and a live
 * session always answers for itself.
 */
const CONFIG_CACHE_KEY = "acpConfigOptions";

function configCache(): Record<string, SessionConfigOption[]> {
  try {
    const parsed = JSON.parse(getMeta(CONFIG_CACHE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cachedConfig(agentId: string): SessionConfigOption[] | null {
  const options = configCache()[agentId];
  return Array.isArray(options) && options.length ? options : null;
}

function rememberConfig(agentId: string, options: SessionConfigOption[]): void {
  if (!options.length) return;
  try {
    setMeta(CONFIG_CACHE_KEY, JSON.stringify({ ...configCache(), [agentId]: options }));
  } catch {
    // A cache that can't be written just means the next menu waits again.
  }
}

export interface AcpRuntimeTarget {
  paneId: string;
  agentId: string;
  cwd: string;
  /** True when the user picked the folder explicitly. Only then does a cwd
   *  mismatch restart the session — the inherited terminal cwd drifts as the
   *  user `cd`s around, and that must never kill a live conversation. */
  cwdExplicit?: boolean;
  /** The pane's remembered selector picks, keyed by config id. Re-applied to
   *  every session this pane starts. */
  config?: Record<string, string>;
}

/**
 * The pane's live session, started if it has none.
 *
 * Both the chat stream and the selector menu come through here so they can
 * never disagree about which session a pane owns: resolve the cwd differently
 * in one of them and the menu would configure a session the next prompt then
 * throws away.
 */
async function acquire(input: AcpRuntimeTarget): Promise<RuntimeHandle> {
  // Share a cold start between config requests and prompts, including startup
  // config application. A closed pane invalidates the pending promise.
  const pending = starting.get(input.paneId);
  if (pending) {
    await pending;
    return acquire(input);
  }
  const agent = findAgentConfig(input.agentId);
  if (!agent?.runtime) throw new Error("Agent conversation runtime is missing or disabled");
  const previous = runtimes.get(input.paneId) ?? suspended.get(input.paneId);
  const changed = previous && (previous.agent.id !== input.agentId ||
    JSON.stringify(previous.agent.runtime) !== JSON.stringify(agent.runtime) ||
    (input.cwdExplicit && previous.cwd !== input.cwd));
  if (changed) {
    const live = runtimes.get(input.paneId);
    if (live && usage.get(live)?.active) throw new Error("This agent is already responding");
    closeAcpRuntimes([input.paneId]);
  }
  const live = runtimes.get(input.paneId);
  if (live) return live;
  const saved = suspended.get(input.paneId);
  const cwd = saved?.cwd ?? (input.cwd || os.homedir());
  const promise: Promise<RuntimeHandle> = (async () => {
    const runtime = agent.runtime?.protocol === "acp-http"
      ? await FastClawRuntime.create(input.paneId, agent, cwd)
      : await Runtime.create(input.paneId, agent, cwd, saved);
    try {
      if (starting.get(input.paneId) !== promise) throw new Error("Agent conversation was closed during startup");
      const picks = saved ? Object.fromEntries(saved.config.map((option) => [option.id, String(option.currentValue)])) : {};
      await runtime.applyConfig({ ...picks, ...input.config });
      if (starting.get(input.paneId) !== promise) throw new Error("Agent conversation was closed during startup");
      runtimes.set(input.paneId, runtime);
      usage.set(runtime, { active: 0, lastUsed: Date.now() });
      suspended.delete(input.paneId);
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  })();
  starting.set(input.paneId, promise);
  try { return await promise; }
  finally { if (starting.get(input.paneId) === promise) starting.delete(input.paneId); }
}

/**
 * Report the selectors an agent offers, preferring not to start it.
 *
 * Starting an adapter to ask what models it has costs 2–3s (npx resolves the
 * package, the agent CLI boots, then `session/new`), and a dropdown that takes
 * three seconds to fill is a dropdown people stop opening. What it would answer
 * barely changes between runs, so the last answer is remembered and served
 * immediately; the agent starts for real when there is something to say to it.
 *
 * The pane's own picks are layered on top, because a remembered list carries
 * whichever values were current in *some* past session, not this pane's.
 */
export function acpRuntimeConfig(input: AcpRuntimeTarget): SessionConfigOption[] | null {
  const live = runtimes.get(input.paneId);
  if (live && live.agent.id === input.agentId) return live.config;
  const saved = suspended.get(input.paneId);
  if (saved && saved.agent.id === input.agentId) return withPicks(saved.config, input.config ?? {});
  if (findAgentConfig(input.agentId)?.runtime?.protocol === "acp-http") return null;
  const cached = cachedConfig(input.agentId);
  return cached && withPicks(cached, input.config ?? {});
}

/** Start the agent and ask it directly — for when the cache has no answer. */
export async function loadAcpRuntimeConfig(input: AcpRuntimeTarget): Promise<SessionConfigOption[]> {
  return useRuntime(input, async (runtime) => runtime.config);
}

/**
 * Change one selector.
 *
 * With no session yet there is nothing to change: the pick is the caller's to
 * remember, and acquire() replays it the moment a session does start. Starting
 * an agent here would make choosing a model — the one thing a user does *before*
 * talking to it — the slowest step in the pane.
 */
export async function setAcpConfigOption(
  input: AcpRuntimeTarget & { configId: string; value: string }
): Promise<SessionConfigOption[]> {
  const live = runtimes.get(input.paneId);
  if (live && live.agent.id === input.agentId) return useRuntime(input, (runtime) => runtime.setConfigOption(input.configId, input.value));
  if (findAgentConfig(input.agentId)?.runtime?.protocol === "acp-http") {
    return useRuntime(input, (runtime) => runtime.setConfigOption(input.configId, input.value));
  }
  const saved = suspended.get(input.paneId);
  if (saved && saved.agent.id === input.agentId) {
    saved.config = withPicks(saved.config, { ...input.config, [input.configId]: input.value });
    return saved.config;
  }
  const cached = cachedConfig(input.agentId);
  if (!cached) return useRuntime(input, (runtime) => runtime.setConfigOption(input.configId, input.value));
  return withPicks(cached, { ...input.config, [input.configId]: input.value });
}

/** Overlay remembered picks onto a cached list's current values. */
function withPicks(options: SessionConfigOption[], picks: Record<string, string>): SessionConfigOption[] {
  return options.map((option) => {
    const pick = picks[option.id];
    if (pick === undefined || option.type !== "select" || !selectValues(option).includes(pick)) return option;
    return { ...option, currentValue: pick };
  });
}

export async function promptAcpRuntime(
  input: AcpRuntimeTarget & { prompt: string; images?: unknown; botIdentity?: unknown; applySavedConfig?: boolean; signal: AbortSignal; emit: Emit }
): Promise<void> {
  input.signal.throwIfAborted();
  input.emit({ type: "activity", title: "Starting agent", status: input.agentId, phase: "starting" });
  await useRuntime(input, async (runtime) => {
    // Stopping during a cold start must not begin a model request afterwards.
    input.signal.throwIfAborted();
    // A group has its own session for each Bot. Reconcile the Bot's saved model
    // on later turns too, since it may have changed through its private settings.
    if (input.applySavedConfig && input.config) await runtime.applyConfig(input.config);
    input.signal.throwIfAborted();
    input.emit({ type: "activity", title: runtime.agent.name, status: "Thinking", phase: "processing" });
    await runtime.prompt(input.prompt, input.emit, input.signal, input.botIdentity, await loadAgentImages(input.images));
  });
}

/** The folder a pane's live ACP session is actually bound to, if one exists. */
export function acpRuntimeCwd(paneId: string): string | undefined {
  return runtimes.get(paneId)?.cwd ?? suspended.get(paneId)?.cwd;
}

export function respondAcpPermission(paneId: string, requestId: string, optionId: string): boolean {
  return runtimes.get(paneId)?.respondPermission(requestId, optionId) ?? false;
}

export function closeAcpRuntimes(paneIds: string[]): void {
  for (const paneId of paneIds) {
    starting.delete(paneId);
    suspended.delete(paneId);
    runtimes.get(paneId)?.close();
    runtimes.delete(paneId);
  }
}

export function closeAllAcpRuntimes(): void {
  closeAcpRuntimes([...new Set([...runtimes.keys(), ...suspended.keys(), ...starting.keys()])]);
}
