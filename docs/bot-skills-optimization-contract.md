# Implementation contract (T0)

The approved execution plan governs scope. New core types appended to packages/core/src/bot.ts. BotSkillBinding.revision is optional compatibility-only; new UI writes {skillId}. instructions is compatibility-only and merged into description by migrateBotDescription(description,instructions), exported from core; old inputs remain readable, new UI clears legacy instructions on save.

## Catalog backend
GET /api/skill-catalog -> SkillCatalogResponse. POST /api/skill-catalog/refresh -> same after refresh.
GET /api/skill-catalog/:id -> SkillReadResult. IDs URI-encoded.
GET /api/skill-catalog/:id/files -> {files:[{path,bytes}],nextOffset?:number}, offset/limit pagination.
GET /api/skill-catalog/:id/file?path=...&offset=0&limit=... -> {text,nextOffset?:number,total:number}; character offsets documented.
PUT /api/skill-roots body {roots:SkillSearchRoot[]} -> SkillCatalogResponse; default roots can toggle, custom roots can add/remove. No external file deletion.
Existing /api/skills/import job APIs retained. Completed job.binding uses live catalog ID, no revision. New POST /api/skills/imports/:id/select {entry} chooses an entry using cached download. Legacy API read retained for migration only.

Backend exports getSkillCatalog() singleton, catalog.list():Promise<SkillCatalogResponse>, refresh(), readSkill(id, legacyRevision?):Promise<SkillReadResult>, listFiles(id), readFile(id,path,offset?,limit?), updateRoots(roots), registerManaged(root,sourceKey,sourceKind='github'):Promise<SkillCatalogEntry>. Legacy id+revision read resolves old exact snapshot, does not jump to latest. Catalog methods reader must enforce root containment and text size. Implement migration identity lazy deterministic mapping (id+revision) without touching user source files.

## GitHub helper (root owned)
apps/server/src/skillGithubImport.ts exports downloadGithubSkill(source,signal,fetcher=fetch): Promise<{files:Map<string,Buffer>,source:SkillSource}>. No new npm dependencies needed unless explicitly coordinated. Helper validates URL, downloads bounded gzip tar archive, rejects unsafe entries, reports categorized errors via error.code/status/retryAt. Repository owns caching job downloads and committing selected package.

## Runtime
Runtime owner implements metadata-only botContext and a local profile file. Every
bound Skill metadata item contains its absolute `SKILL.md` entry path; the selected
agent reads it through its own file tools. Use getSkillCatalog dynamic import for
readSkill(id,revision?). Fingerprint contains entry hashes, normalized profile and
paths. The preview API has no runtime mode argument. Do not add Skill MCP servers,
function tools, engine whitelists, or capability branches.

## Ownership
catalog agent: apps/server/src/skillCatalog*, skills.ts, skillsHttp.ts and corresponding tests.
UI agent: apps/web/src/** relevant components/store/profile/forms/i18n and tests; do not modify backend/core.
runtime agent: apps/server/src/botContext*,botIdentity*,acpRuntime*,agentChat*,fastClawRuntime*, profile module/tests; no catalog,index,db,core edits.
root: core, GitHub helper, db/index integration, scripts, docs and final validation. Independent review after development slots free; request review via root rather than competing for full slots.
