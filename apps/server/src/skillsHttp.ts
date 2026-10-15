import type { IncomingMessage, ServerResponse } from "node:http";
import { getSkillRepository, SkillError, type SkillRepository } from "./skills.js";

export async function handleSkillRequest(req: IncomingMessage, res: ServerResponse, url: URL, repository?: SkillRepository): Promise<void> {
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const body = async () => {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new SkillError("REQUEST_TOO_LARGE", "Request exceeds 64 KiB", 413); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SkillError("INVALID_JSON", "Invalid JSON request"); }
  };
  try {
    const repo = repository ?? await getSkillRepository();
    const catalog = await repo.getCatalog();
    if (url.pathname === "/api/skill-catalog" && req.method === "GET") { send(200, await catalog.list()); return; }
    if (url.pathname === "/api/skill-catalog/refresh" && req.method === "POST") { send(200, await catalog.refresh()); return; }
    if (url.pathname === "/api/skill-roots" && req.method === "PUT") { send(200, await catalog.updateRoots((await body()).roots)); return; }
    const resource = /^\/api\/skill-catalog\/([^/]+)(?:\/(files|file))?$/.exec(url.pathname);
    if (resource && !resource[2] && req.method === "DELETE") { await catalog.remove(decodeURIComponent(resource[1])); send(200, { deleted: true }); return; }
    if (resource && req.method === "GET") {
      const id = decodeURIComponent(resource[1]);
      if (!resource[2]) { send(200, await catalog.readSkill(id, url.searchParams.get("revision") ?? undefined)); return; }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? (resource[2] === "files" ? 100 : 32768));
      if (resource[2] === "file") { send(200, await catalog.readFile(id, url.searchParams.get("path") ?? "", offset, limit)); return; }
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SkillError("INVALID_RANGE", "Invalid file list range");
      const files = await catalog.listFiles(id); const end = Math.min(files.length, offset + limit);
      send(200, { files: files.slice(offset, end), ...(end < files.length ? { nextOffset: end } : {}) }); return;
    }
    if (url.pathname === "/api/skills" && req.method === "GET") { send(200, { skills: await repo.listSkills() }); return; }
    if (url.pathname === "/api/skills/import" && req.method === "POST") { send(202, repo.startImport(await body())); return; }
    const select = /^\/api\/skills\/imports\/([^/]+)\/select$/.exec(url.pathname);
    if (select && req.method === "POST") { send(202, repo.selectImport(decodeURIComponent(select[1]), (await body()).entry)); return; }
    const job = /^\/api\/skills\/imports\/([^/]+)$/.exec(url.pathname);
    if (job && req.method === "GET") { send(200, repo.getImport(decodeURIComponent(job[1]))); return; }
    if (job && req.method === "DELETE") { send(200, repo.cancelImport(decodeURIComponent(job[1]))); return; }
    const version = /^\/api\/skills\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
    if (version && req.method === "GET") { send(200, await repo.readSkill(decodeURIComponent(version[1]), decodeURIComponent(version[2]))); return; }
    send(404, { error: "Unknown Skill endpoint", code: "NOT_FOUND" });
  } catch (error: any) { send(error instanceof SkillError ? error.status : 500, { error: error.message ?? "Skill request failed", code: error instanceof SkillError ? error.code : "SKILL_ERROR" }); }
}
