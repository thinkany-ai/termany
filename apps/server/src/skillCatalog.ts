import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BOT_SKILL_LIMITS as LIMITS, type SkillCatalogEntry, type SkillCatalogResponse, type SkillReadResult, type SkillSearchRoot, type SkillRecord } from "../../../packages/core/src/bot.js";
import { parseEntry, safeSkillPath, SkillError, textContent, type SkillStorage } from "./skills.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const KEY = "skillCatalog.v2";
const ignored = new Set([".git", "node_modules", ".DS_Store", ".cache"]);
const within = (root: string, filename: string) => filename === root || filename.startsWith(root + path.sep);
interface Location { id: string; root: string; source: SkillCatalogEntry["source"]; sourceKey?: string; legacy?: { id: string; revision: string }; }
interface State { roots: SkillSearchRoot[]; locations: Location[]; hidden?: string[]; }
export interface CatalogOptions { root: string; storage: SkillStorage; home?: string; codexHome?: string; scanLimits?: { directories?: number; milliseconds?: number }; }
/** Root identity is stable across edits. Content equality only groups the search results. */
export class SkillCatalog {
  private state: State;
  private cache?: SkillCatalogResponse;
  private scannedAt = 0;
  private refreshing?: Promise<SkillCatalogResponse>;
  private home: string;
  constructor(private options: CatalogOptions) {
    this.home = options.home ?? os.homedir();
    const defaults = [
      ["agents", path.join(this.home, ".agents", "skills")],
      ["claude", path.join(this.home, ".claude", "skills")],
      ["codex", path.join(options.codexHome ?? (options.home ? path.join(this.home, ".codex") : process.env.CODEX_HOME ?? path.join(this.home, ".codex")), "skills")],
      ["termany", options.root],
    ].map(([id, directory]) => ({ id, path: directory, enabled: true, builtIn: true }));
    const saved = options.storage.getMeta(KEY);
    this.state = saved ? JSON.parse(saved) : { roots: defaults, locations: [] };
    // Built-in paths follow the effective home, while user toggle choices survive upgrades.
    this.state.roots = [...defaults.map(root => ({ ...root, enabled: this.state.roots.find(r => r.id === root.id)?.enabled ?? true })), ...this.state.roots.filter(r => !r.builtIn)];
  }
  private save() { this.options.storage.setMeta(KEY, JSON.stringify(this.state)); }
  private normalize(value: string) { return path.resolve(value === "~" ? this.home : value.startsWith("~/") ? path.join(this.home, value.slice(2)) : value); }
  private locate(root: string, source: Location["source"] = "local", sourceKey?: string) {
    let found = sourceKey ? this.state.locations.find(l => l.sourceKey === sourceKey || (source === "local" && l.root === root && !l.legacy)) : this.state.locations.find(l => l.root === root && !l.legacy);
    if (!found) { found = { id: `skill-${digest(sourceKey ?? root).slice(0, 32)}`, root, source, sourceKey }; this.state.locations.push(found); }
    else if (sourceKey) { found.root = root; found.source = source; }
    return found;
  }
  async updateRoots(roots: SkillSearchRoot[]) {
    if (this.refreshing) await this.refreshing;
    if (!Array.isArray(roots) || roots.length > 64) throw new SkillError("INVALID_ROOTS", "Expected at most 64 search directories");
    const defaults = structuredClone(this.state.roots.filter(r => r.builtIn));
    const custom: SkillSearchRoot[] = [];
    const canonical = async (directory: string) => fs.realpath(directory).catch(() => directory);
    const seen = new Set(await Promise.all(defaults.map(r => canonical(this.normalize(r.path)))));
    for (const root of roots) {
      if (!root || typeof root.path !== "string" || !root.path.trim() || typeof root.enabled !== "boolean") throw new SkillError("INVALID_ROOTS", "Invalid search directory");
      const builtin = defaults.find(r => r.id === root.id);
      if (builtin) { builtin.enabled = root.enabled; continue; }
      const directory = this.normalize(root.path.trim());
      const real = await canonical(directory);
      if (seen.has(real)) continue;
      seen.add(real);
      custom.push({ id: `root-${digest(directory).slice(0, 24)}`, path: directory, enabled: root.enabled, builtIn: false });
    }
    const previous = this.state; this.state = { ...this.state, roots: [...defaults, ...custom] };
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.refresh();
  }
  async list() {
    if (!this.cache) return this.refresh();
    if (Date.now() - this.scannedAt > 30_000 && !this.refreshing) void this.refresh().catch(() => { /* Explicit refresh reports errors; retain last successful results. */ });
    return structuredClone({ ...this.cache, scanning: !!this.refreshing });
  }
  async refresh(): Promise<SkillCatalogResponse> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async scan(): Promise<SkillCatalogResponse> {
    const warnings: string[] = []; const discovered = new Set<string>(); const visited = new Set<string>();
    const totalBudget = this.options.scanLimits?.milliseconds ?? 15_000;
    const rootBudget = Math.max(100, Math.floor(totalBudget / Math.max(1, this.state.roots.filter(r => r.enabled).length)));
    let deadline = Date.now() + rootBudget; let count = 0;
    const walk = async (directory: string, depth: number) => {
      if (depth > 12 || ++count > (this.options.scanLimits?.directories ?? 20_000) || Date.now() > deadline) throw new SkillError("SCAN_LIMIT", "Search exceeded directory depth, count or time limit");
      const real = await fs.realpath(directory);
      if (visited.has(real)) return;
      visited.add(real);
      const entries = await fs.readdir(real, { withFileTypes: true });
      if (entries.some(e => e.name === "SKILL.md")) discovered.add(this.locate(real).id);
      for (const entry of entries) {
        if (ignored.has(entry.name) || entry.name.startsWith(".import-") || entry.name.startsWith(".backup-")) continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try { if ((await fs.stat(path.join(real, entry.name))).isDirectory()) await walk(path.join(real, entry.name), depth + 1); }
          catch (error: any) { if (error.code === "SCAN_LIMIT") throw error; warnings.push(`${path.join(real, entry.name)}: ${error.message}`); }
        }
      }
    };
    for (const root of this.state.roots) {
      delete root.error; delete root.status;
      if (!root.enabled) continue;
      // A pathological source must not consume the traversal budget of later roots.
      deadline = Date.now() + rootBudget; count = 0;
      try {
        if (root.id === "termany") {
          // Managed current locations and exact legacy snapshots are registered separately;
          // never discover preserved backup generations as new public entries.
          await fs.mkdir(this.options.root, { recursive: true });
          for (const location of this.state.locations) if (location.source !== "local") discovered.add(location.id);
        } else await walk(root.path, 0);
        root.status = "ready";
      } catch (error: any) { root.status = error.code === "ENOENT" ? "missing" : "error"; root.error = error.message; }
    }
    // Preserve the existing library as well as every exact historical binding. Latest
    // unbound imports remain discoverable, without exposing a version selector.
    const showManaged = this.state.roots.find(root => root.id === "termany")?.enabled;
    const records: SkillRecord[] = JSON.parse(this.options.storage.getMeta("botSkills.v1") ?? "[]");
    for (const record of records) {
      const latest = record.revisions.at(-1);
      if (latest) { const location = await this.legacyLocation(record.id, latest.revision); if (showManaged) discovered.add(location.id); }
    }
    const conversations = JSON.parse(this.options.storage.getMeta("agentConversations") ?? "[]");
    for (const conversation of Array.isArray(conversations) ? conversations : []) for (const binding of conversation?.agentSkills ?? []) {
      if (typeof binding?.revision === "string") {
        try { const location = await this.legacyLocation(binding.skillId, binding.revision); if (showManaged) discovered.add(location.id); }
        catch (error: any) { warnings.push(error.message); }
      }
    }
    deadline = Date.now() + totalBudget;
    const skills: SkillCatalogEntry[] = []; const candidates = new Map<string, SkillCatalogEntry[]>(); const packageHashes = new Map<string, string>();
    for (const location of this.state.locations.filter(l => discovered.has(l.id) && !this.state.hidden?.includes(l.id))) {
      let entry: SkillCatalogEntry;
      try {
        const read = await this.readLocation(location);
        entry = { ...read, source: location.source, available: true };
        delete (entry as any).body;
        // Full package comparisons are only needed for entries with identical SKILL.md.
        // This avoids reading every reference file during ordinary discovery.
        const possible = candidates.get(read.fingerprint) ?? [];
        let duplicate = false;
        if (possible.length) {
          try {
            if (Date.now() > deadline) throw new SkillError("SCAN_LIMIT", "Content comparison time budget exceeded");
            const fingerprint = await this.packageFingerprint(location.root);
            for (const other of possible) {
              let otherHash = packageHashes.get(other.id);
              if (!otherHash) { otherHash = await this.packageFingerprint(other.root); packageHashes.set(other.id, otherHash); }
              if (fingerprint === otherHash) { (other.aliases ??= []).push({ id: location.id, root: location.root, source: location.source }); duplicate = true; break; }
            }
            packageHashes.set(location.id, fingerprint);
          } catch (error: any) { warnings.push(`${location.root}: content grouping skipped (${error.message})`); }
        }
        if (duplicate) continue;
        possible.push(entry); candidates.set(read.fingerprint, possible);
      } catch (error: any) { entry = { id: location.id, name: path.basename(location.root), description: "", root: location.root, entryPath: path.join(location.root, "SKILL.md"), fingerprint: "", source: location.source, available: false, error: error.message }; }
      skills.push(entry);
    }
    this.save(); this.scannedAt = Date.now(); this.cache = { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), roots: structuredClone(this.state.roots), warnings: warnings.slice(0, 100), scanning: false };
    return structuredClone(this.cache);
  }
  private async file(root: string, relative: string, maxBytes = LIMITS.packageBytes): Promise<Buffer> {
    safeSkillPath(relative);
    try {
      const realRoot = await fs.realpath(root); const filename = await fs.realpath(path.join(root, relative));
      if (!within(realRoot, filename)) throw new SkillError("INVALID_PATH", "Resource escapes Skill directory");
      const handle = await fs.open(filename, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new SkillError("NOT_TEXT", "Resource is not a regular file");
        if (stat.size > maxBytes) throw new SkillError("RESOURCE_TOO_LARGE", "Resource exceeds read limit", 413);
        // A bounded read also protects against a file growing between stat and read.
        const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1)); let bytesRead = 0;
        while (bytesRead < buffer.length) { const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead); if (!next.bytesRead) break; bytesRead += next.bytesRead; }
        if (bytesRead > maxBytes) throw new SkillError("RESOURCE_TOO_LARGE", "Resource exceeds read limit", 413);
        if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new SkillError("RESOURCE_CHANGED", "Resource changed while reading; retry", 409);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    } catch (error: any) { if (error instanceof SkillError) throw error; throw new SkillError("RESOURCE_NOT_FOUND", `Skill resource is missing or unreadable: ${relative}`, 404); }
  }
  private async manifest(root: string) {
    const result: Array<{ path: string; bytes: number }> = []; const realRoot = await fs.realpath(root); let total = 0; let directories = 0;
    const walk = async (directory: string, relative: string, ancestors: Set<string>) => {
      if (++directories > 4000) throw new SkillError("PACKAGE_TOO_LARGE", "Too many resource directories");
      const real = await fs.realpath(directory);
      if (!within(realRoot, real) || ancestors.has(real)) throw new SkillError("INVALID_PATH", "Resource link escapes or cycles within Skill");
      const next = new Set(ancestors).add(real);
      for (const entry of await fs.readdir(real, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const file = path.join(real, entry.name); const rel = relative ? `${relative}/${entry.name}` : entry.name;
        const target = await fs.realpath(file);
        if (!within(realRoot, target)) throw new SkillError("INVALID_PATH", "Resource escapes Skill directory");
        const stat = await fs.stat(target);
        if (stat.isDirectory()) { if (next.size > 32) throw new SkillError("PACKAGE_TOO_LARGE", "Resource tree is too deep"); await walk(target, rel, next); }
        else if (stat.isFile()) { total += stat.size; if (result.length >= LIMITS.packageFiles || total > LIMITS.packageBytes) throw new SkillError("PACKAGE_TOO_LARGE", "Skill exceeds package limits"); result.push({ path: rel, bytes: stat.size }); }
        else throw new SkillError("INVALID_SOURCE", "Unsupported resource type");
      }
    };
    await walk(realRoot, "", new Set()); return result.sort((a,b) => a.path.localeCompare(b.path));
  }
  private async packageFingerprint(root: string) {
    const manifest = await this.manifest(root);
    const hashes = [];
    for (const file of manifest) hashes.push([file.path, digest(await this.file(root, file.path))]);
    return digest(JSON.stringify(hashes));
  }
  private async legacyLocation(id: string, revision: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(revision)) throw new SkillError("SKILL_NOT_FOUND", "Unknown legacy Skill", 404);
    const records: SkillRecord[] = JSON.parse(this.options.storage.getMeta("botSkills.v1") ?? "[]");
    if (!records.find(r => r.id === id)?.revisions.some(r => r.revision === revision)) throw new SkillError("SKILL_NOT_FOUND", "Unknown legacy Skill", 404);
    const stable = `legacy-${digest(`${id}:${revision}`).slice(0,32)}`;
    let found = this.state.locations.find(l => l.id === stable);
    if (!found) { found = { id: stable, root: path.join(this.options.root, id, revision), source: "legacy", legacy: { id, revision } }; this.state.locations.push(found); this.save(); }
    return found;
  }
  private async location(id: string, revision?: string) {
    if (revision) return this.legacyLocation(id, revision);
    if (!this.state.locations.some(l => l.id === id)) await this.list();
    const found = this.state.locations.find(l => l.id === id);
    if (!found) throw new SkillError("SKILL_NOT_FOUND", "Unknown Skill", 404);
    return { ...found };
  }
  private async readLocation(location: Location): Promise<SkillReadResult> {
    const bytes = await this.file(location.root, "SKILL.md", LIMITS.entryBytes);
    if (location.legacy) {
      const records: SkillRecord[] = JSON.parse(this.options.storage.getMeta("botSkills.v1") ?? "[]");
      const expected = records.find(r=>r.id===location.legacy!.id)?.revisions.find(r=>r.revision===location.legacy!.revision)?.files.find(f=>f.path==="SKILL.md");
      if (!expected || digest(bytes) !== expected.sha256) throw new SkillError("SKILL_CORRUPT", "Legacy Skill snapshot has changed");
    }
    const metadata = parseEntry(bytes);
    return { id: location.id, name: metadata.name, description: metadata.description, root: location.root, entryPath: path.join(location.root, "SKILL.md"), body: textContent(bytes), fingerprint: digest(bytes) };
  }
  async readSkill(id: string, legacyRevision?: string) { return this.readLocation(await this.location(id, legacyRevision)); }
  async listFiles(id: string) { return this.manifest((await this.location(id)).root); }
  /** Text resource offsets and limits count JavaScript UTF-16 code units. */
  async readFile(id: string, relative: string, offset = 0, limit = 32_768) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65_536) throw new SkillError("INVALID_RANGE", "Invalid text range");
    const location = await this.location(id);
    const bytes = await this.file(location.root, relative);
    if (location.legacy) {
      const records: SkillRecord[] = JSON.parse(this.options.storage.getMeta("botSkills.v1") ?? "[]");
      const expected = records.find(r => r.id === location.legacy!.id)?.revisions.find(r => r.revision === location.legacy!.revision)?.files.find(f => f.path === relative);
      if (!expected || expected.sha256 !== digest(bytes)) throw new SkillError("SKILL_CORRUPT", "Legacy Skill resource has changed");
    }
    const text = textContent(bytes);
    const end = Math.min(text.length, offset + limit);
    return { text: text.slice(offset, end), total: text.length, ...(end < text.length ? { nextOffset: end } : {}) };
  }
  async remove(id: string) {
    if (this.refreshing) await this.refreshing;
    const location = await this.location(id);
    if (location.source === "local") throw new SkillError("EXTERNAL_SKILL", "External Skills cannot be removed; manage their search directory instead", 409);
    const result = await this.list();
    const group = result.skills.find(s => s.id === id || s.aliases?.some(a => a.id === id));
    const identities = new Set([id, ...(group ? [group.id, ...(group.aliases ?? []).map(a => a.id)] : [])]);
    const conversations = JSON.parse(this.options.storage.getMeta("agentConversations") ?? "[]");
    if (!Array.isArray(conversations)) throw new SkillError("STATE_INVALID", "Unable to verify Skill references", 409);
    for (const conversation of conversations) for (const binding of conversation?.agentSkills ?? []) {
      const boundId = binding.revision ? `legacy-${digest(`${binding.skillId}:${binding.revision}`).slice(0,32)}` : binding.skillId;
      if (identities.has(boundId)) throw new SkillError("SKILL_IN_USE", "Unbind this Skill from all Bots before removing it", 409);
    }
    const previous = this.state;
    this.state = { ...this.state, hidden: [...new Set([...(this.state.hidden ?? []), id])] };
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    this.cache = undefined;
  }
  async registerManaged(root: string, sourceKey: string, sourceKind: Location["source"] = "github", signal?: AbortSignal): Promise<SkillCatalogEntry> {
    if (this.refreshing) await this.refreshing;
    const real = await fs.realpath(root); const value = await this.readLocation({ id: "validate", root: real, source: sourceKind });
    signal?.throwIfAborted();
    // The pointer publication is synchronous after validation, so cancellation cannot
    // report failure after silently changing the current item.
    const previous = this.state; this.state = structuredClone(this.state);
    const location = this.locate(real, sourceKind, sourceKey); this.state.hidden = this.state.hidden?.filter(id => id !== location.id);
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    this.cache = undefined;
    const { body: _body, ...metadata } = value;
    return { ...metadata, id: location.id, source: sourceKind, available: true };
  }
  async registerLocal(root: string, signal?: AbortSignal) {
    if (this.refreshing) await this.refreshing;
    const real = await fs.realpath(root);
    const value = await this.readLocation({ id: "validate", root: real, source: "local" });
    signal?.throwIfAborted();
    const previous = this.state; this.state = structuredClone(this.state);
    if (!this.state.roots.some(r => this.normalize(r.path) === real)) this.state.roots.push({ id: `root-${digest(real).slice(0,24)}`, path: real, enabled: true, builtIn: false });
    const location = this.locate(real, "local", `local:${real}`);
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    this.cache = undefined;
    const {body: _body, ...metadata} = value;
    return {...metadata,id:location.id,source:"local" as const,available:true};
  }
}
let singleton: Promise<SkillCatalog> | undefined;
export function getSkillCatalog() { return singleton ??= import("./db.js").then(storage => new SkillCatalog({ root: path.join(os.homedir(), ".termany", "skills"), storage })); }
