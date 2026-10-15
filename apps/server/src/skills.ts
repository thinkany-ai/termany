import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { githubArchiveLocation } from "./skillGithubImport.js";
import { BOT_SKILL_LIMITS as LIMITS, type SkillRecord, type SkillDetail, type SkillImportRequest, type SkillImportJob, type SkillFile, type SkillSource } from "../../../packages/core/src/bot.js";

export class SkillError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const fail = (code: string, message: string, status = 400): never => { throw new SkillError(code, message, status); };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ignored = new Set([".git", "node_modules", ".DS_Store"]);
export function safeSkillPath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === "..") || /^[A-Za-z]:/.test(value)) fail("INVALID_PATH", "Expected a package-relative path");
  return value;
}
export function textContent(bytes: Buffer): string {
  try { const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (value.includes("\0")) throw new Error(); return value; }
  catch { return fail("NOT_TEXT", "Resource is not UTF-8 text"); }
}
export function parseEntry(bytes: Buffer) {
  if (bytes.length > LIMITS.entryBytes) fail("ENTRY_TOO_LARGE", "SKILL.md exceeds 64 KiB");
  const source = textContent(bytes).replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) fail("INVALID_SKILL", "SKILL.md requires YAML frontmatter with name and description");
  const document = parseDocument(match![1]);
  if (document.errors.length) fail("INVALID_SKILL", "Invalid YAML frontmatter");
  let meta: any;
  try { meta = document.toJS({ maxAliasCount: 20 }); } catch { fail("INVALID_SKILL", "Invalid YAML metadata"); }
  if (!meta || typeof meta.name !== "string" || !meta.name.trim() || typeof meta.description !== "string" || !meta.description.trim()) fail("INVALID_SKILL", "Skill name and description are required");
  const body = source.slice(match![0].length);
  if (!body.trim()) fail("INVALID_SKILL", "Skill body is empty");
  return { name: meta.name.trim(), description: meta.description.trim(), body };
}
export interface SkillStorage { getMeta(key: string): string | null; setMeta(key: string, value: string): void; }
interface Options { root: string; storage: SkillStorage; fetch?: typeof fetch; catalog?: import("./skillCatalog.js").SkillCatalog; home?: string; }
const REGISTRY = "botSkills.v1";
const JOBS = "botSkillImports.v1";
export class SkillRepository {
  private records: SkillRecord[];
  private jobs: SkillImportJob[];
  private controllers = new Map<string, AbortController>();
  private fetching: typeof fetch;
  private downloads = new Map<string, { files: Map<string, Buffer>; source: SkillSource; entry?: string }>();
  private selectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private catalogPromise?: Promise<import("./skillCatalog.js").SkillCatalog>;
  getCatalog() { return this.catalogPromise ??= this.options.catalog ? Promise.resolve(this.options.catalog) : import("./skillCatalog.js").then(({ SkillCatalog }) => new SkillCatalog({ root: this.options.root, storage: this.options.storage, home: this.options.home })); }
  private importQueue: Promise<void> = Promise.resolve();
  constructor(private options: Options) {
    this.records = JSON.parse(options.storage.getMeta(REGISTRY) ?? "[]");
    this.jobs = JSON.parse(options.storage.getMeta(JOBS) ?? "[]");
    for (const job of this.jobs) if (job.status === "running" || job.status === "select-entry") Object.assign(job, { status: "failed", code: "INTERRUPTED", error: "Import interrupted by server restart; retry the import" });
    this.saveJobs();
    this.fetching = options.fetch ?? fetch;
  }
  private saveJobs() { this.options.storage.setMeta(JOBS, JSON.stringify(this.jobs)); }
  async listSkills(): Promise<SkillRecord[]> { return structuredClone(this.records); }
  private resolve(id: string, revision: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(revision)) fail("SKILL_NOT_FOUND", "Unknown Skill version", 404);
    const item = this.records.find(r => r.id === id)?.revisions.find(r => r.revision === revision);
    if (!item) fail("SKILL_NOT_FOUND", "Unknown Skill version", 404);
    return { item: item!, root: path.join(this.options.root, id, revision) };
  }
  private async bytes(id: string, revision: string, relativePath: string) {
    safeSkillPath(relativePath);
    const { item, root } = this.resolve(id, revision);
    const registered = item.files.find(f => f.path === relativePath);
    if (!registered) fail("RESOURCE_NOT_FOUND", "Resource is not in the Skill manifest", 404);
    try {
      const realRoot = await fs.realpath(root);
      const filename = await fs.realpath(path.join(root, relativePath));
      if (!filename.startsWith(realRoot + path.sep)) fail("INVALID_PATH", "Resource escapes package");
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size !== registered!.bytes || stat.size > LIMITS.packageBytes) fail("SKILL_CORRUPT", "Skill resource has changed");
      const bytes = await fs.readFile(filename);
      if (hash(bytes) !== registered!.sha256) fail("SKILL_CORRUPT", "Skill resource has changed");
      return bytes;
    } catch (error) { if (error instanceof SkillError) throw error; return fail("SKILL_CORRUPT", "Skill resource is missing or unreadable"); }
  }
  async readSkill(id: string, revision: string): Promise<SkillDetail> {
    const { item, root } = this.resolve(id, revision);
    const { body } = parseEntry(await this.bytes(id, revision, "SKILL.md"));
    return { ...structuredClone(item), skillId: id, root, body };
  }
  async readSkillResource(id: string, revision: string, relativePath: string): Promise<string> {
    return textContent(await this.bytes(id, revision, relativePath));
  }
  getImport(id: string): SkillImportJob {
    const job = this.jobs.find(j => j.id === id);
    if (!job) fail("IMPORT_NOT_FOUND", "Unknown import job", 404);
    return structuredClone(job!);
  }
  cancelImport(id: string): SkillImportJob {
    const job = this.jobs.find(j => j.id === id);
    if (!job) fail("IMPORT_NOT_FOUND", "Unknown import job", 404);
    if (job!.status === "running" || job!.status === "select-entry") { this.controllers.get(id)?.abort(); this.downloads.delete(id); clearTimeout(this.selectionTimers.get(id)); this.selectionTimers.delete(id); job!.status = "cancelled"; this.saveJobs(); }
    return structuredClone(job!);
  }
  startImport(request: SkillImportRequest): SkillImportJob {
    if (!request || typeof request !== "object" || !request.source || !["local", "github"].includes(request.source.kind)) fail("INVALID_REQUEST", "Expected a local or GitHub source");
    if (request.entry !== undefined && request.entry !== "") safeSkillPath(request.entry);
    // Source identity, rather than a client-selected ID, determines the current managed item.
    if (request.source.kind === "local" && (typeof request.source.path !== "string" || !request.source.path.trim())) fail("INVALID_REQUEST", "Local source path is required");
    if (request.source.kind === "github") this.githubLocation(request.source);
    const job: SkillImportJob = { id: randomUUID(), status: "running", request: structuredClone(request) };
    this.jobs.push(job); this.saveJobs();
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    // Serialize imports so two requests cannot publish duplicate IDs for the same source/version.
    this.importQueue = this.importQueue.then(() => this.runImport(job, controller)).catch(() => { /* Job errors are persisted by runImport. */ }).finally(() => this.controllers.delete(job.id));
    return structuredClone(job);
  }
  private githubLocation(source: Extract<SkillSource, { kind: "github" }>) {
    try { return githubArchiveLocation(source); }
    catch (error: any) { throw new SkillError(error.code ?? "INVALID_SOURCE", error.message, error.status ?? 400); }
  }
  private async githubFiles(source: Extract<SkillSource, { kind: "github" }>, signal: AbortSignal) {
    const { downloadGithubSkill } = await import("./skillGithubImport.js");
    return downloadGithubSkill(source, signal, this.fetching);
  }
  selectImport(id: string, entry: string): SkillImportJob {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== "select-entry" || !this.downloads.has(id)) fail("IMPORT_NOT_SELECTABLE", "Import is not waiting for an entry", 409);
    if (typeof entry !== "string" || !job!.candidates?.includes(entry)) fail("INVALID_SKILL", "Invalid selected Skill entry");
    job!.request.entry = entry; job!.status = "running"; this.saveJobs();
    const controller = new AbortController(); this.controllers.set(id, controller);
    this.importQueue = this.importQueue.then(() => this.runImport(job!, controller)).finally(() => this.controllers.delete(id));
    return structuredClone(job!);
  }
  private async localFiles(directory: string, signal: AbortSignal) {
    const root = await fs.realpath(directory.startsWith("~/") ? path.join(os.homedir(), directory.slice(2)) : directory);
    const files = new Map<string, Buffer>(); let total = 0; let visited = 0;
    const walk = async (target: string, relative: string, ancestors: Set<string>) => {
      signal.throwIfAborted();
      if (++visited > LIMITS.packageFiles * 4) fail("PACKAGE_TOO_LARGE", "Too many package entries");
      const real = await fs.realpath(target);
      if (real !== root && !real.startsWith(root + path.sep)) fail("INVALID_PATH", "Symlink escapes Skill directory");
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        if (ancestors.has(real)) fail("INVALID_PATH", "Cyclic directory symlink");
        const next = new Set(ancestors).add(real);
        for (const item of (await fs.readdir(real)).sort()) if (!ignored.has(item)) await walk(path.join(real, item), relative ? `${relative}/${item}` : item, next);
      } else {
        if (!stat.isFile()) fail("INVALID_SOURCE", "Only regular files are supported");
        safeSkillPath(relative);
        if (files.size >= LIMITS.packageFiles || stat.size + total > LIMITS.packageBytes) fail("PACKAGE_TOO_LARGE", "Skill exceeds file count or 20 MiB size limit");
        const bytes = await fs.readFile(real); total += bytes.length;
        if (total > LIMITS.packageBytes) fail("PACKAGE_TOO_LARGE", "Skill exceeds 20 MiB");
        files.set(relative, bytes);
      }
    };
    await walk(root, "", new Set());
    return { files, source: { kind: "local", path: root } as SkillSource };
  }
  private async runImport(job: SkillImportJob, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new Error("Import timed out")), 120_000); timer.unref();
    let staging: string | undefined;
    try {
      const signal = controller.signal;
      signal.throwIfAborted();
      const loaded = this.downloads.get(job.id) ?? (job.request.source.kind === "local" ? await this.localFiles(job.request.source.path, signal) : await this.githubFiles(job.request.source, signal));
      signal.throwIfAborted();
      const candidates = [...loaded.files.keys()].filter(p => p === "SKILL.md" || p.endsWith("/SKILL.md")).map(p => p === "SKILL.md" ? "" : p.slice(0, -9)).sort();
      if (!candidates.length) fail("INVALID_SKILL", "No SKILL.md found");
      let entry = "entry" in loaded && typeof loaded.entry === "string" ? loaded.entry : job.request.entry;
      if (entry === undefined && candidates.length > 1) { if (this.downloads.size >= 8) fail("IMPORT_QUEUE_FULL", "Finish or cancel pending entry selections first", 429); this.downloads.set(job.id, loaded); job.candidates = candidates; job.status = "select-entry";
        const expires = setTimeout(() => {
          if (job.status !== "select-entry") return;
          this.downloads.delete(job.id); this.selectionTimers.delete(job.id);
          job.status = "failed"; job.code = "IMPORT_EXPIRED"; job.error = "Entry selection expired after 10 minutes; import again"; this.saveJobs();
        }, 10 * 60_000); expires.unref(); this.selectionTimers.set(job.id, expires);
        return; }
      entry ??= candidates[0];
      if (!candidates.includes(entry)) fail("INVALID_SKILL", "Selected entry does not contain SKILL.md");
      const prefix = entry ? entry + "/" : "";
      const files = new Map([...loaded.files].filter(([p]) => p.startsWith(prefix)).map(([p, bytes]) => [p.slice(prefix.length), bytes]));
      parseEntry(files.get("SKILL.md")!);
      const catalog = await this.getCatalog();
      if (loaded.source.kind === "local") {
        const item = await catalog.registerLocal(path.join(loaded.source.path, entry), signal);
        job.binding = { skillId: item.id }; job.status = "complete";
      } else {
        const normalizedUrl = loaded.source.url.replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase();
        const sourceKey = `github:${normalizedUrl}:${loaded.source.ref ?? "HEAD"}:${loaded.source.subdirectory ?? ""}:${entry}`;
        const managedRoot = path.join(this.options.root, ".managed", hash(sourceKey).slice(0, 32));
        await fs.mkdir(managedRoot, { recursive: true });
        staging = await fs.mkdtemp(path.join(managedRoot, ".import-"));
        for (const [relative, bytes] of files) { signal.throwIfAborted(); const destination = path.join(staging, safeSkillPath(relative)); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes); }
        signal.throwIfAborted();
        const target = path.join(managedRoot, randomUUID());
        await fs.rename(staging, target); staging = undefined;
        signal.throwIfAborted();
        // Only the registry pointer changes; old complete generations remain readable for
        // in-flight users and rollback, and are excluded from discovery.
        const item = await catalog.registerManaged(target, sourceKey, "github", signal);
        job.binding = { skillId: item.id }; job.status = "complete";
      }

    } catch (error: any) {
      if (job.status !== "cancelled") { job.status = "failed"; job.code = controller.signal.aborted ? "IMPORT_TIMEOUT" : error.code ?? "IMPORT_FAILED"; job.error = error.message ?? String(error); if (Number.isFinite(error.retryAt)) job.retryAt = error.retryAt; if (Number.isInteger(error.status)) job.httpStatus = error.status; }
    } finally { if (job.status !== "select-entry") { this.downloads.delete(job.id); clearTimeout(this.selectionTimers.get(job.id)); this.selectionTimers.delete(job.id); } clearTimeout(timer); if (staging) await fs.rm(staging, { recursive: true, force: true }); this.saveJobs(); }
  }
  async deleteSkillRevision(id: string, revision: string) {
    this.resolve(id, revision);
    const conversations = JSON.parse(this.options.storage.getMeta("agentConversations") ?? "[]");
    if (!Array.isArray(conversations)) fail("STATE_INVALID", "Unable to verify Skill references", 409);
    if (conversations.some((c: any) => c?.agentSkills?.some((b: any) => b.skillId === id && b.revision === revision))) fail("SKILL_IN_USE", "Unbind this Skill version from all Bots before deleting", 409);
    const records = this.records.map(r => r.id === id ? { ...r, revisions: r.revisions.filter(v => v.revision !== revision) } : r).filter(r => r.revisions.length);
    this.options.storage.setMeta(REGISTRY, JSON.stringify(records));
    this.records = records;
    // Keep immutable files until a future garbage collector: running requests may still use them.
  }
}
let singleton: Promise<SkillRepository> | undefined;
export function getSkillRepository(): Promise<SkillRepository> {
  return singleton ??= import("./db.js").then(storage => import("./skillCatalog.js").then(async ({ getSkillCatalog }) => new SkillRepository({ root: path.join(os.homedir(), ".termany", "skills"), storage, catalog: await getSkillCatalog() })));
}
export async function listSkills() { return (await getSkillRepository()).listSkills(); }
export async function readSkill(id: string, revision: string) { return (await getSkillRepository()).readSkill(id, revision); }
export async function readSkillResource(id: string, revision: string, relativePath: string) { return (await getSkillRepository()).readSkillResource(id, revision, relativePath); }
