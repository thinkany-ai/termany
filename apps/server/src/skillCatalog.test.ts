import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillCatalog } from "./skillCatalog.js";
const entry = "---\nname: advisor\ndescription: Useful advice\n---\n# Full instructions\nUnique marker\n";
async function fixture(t: any) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-catalog-"))); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const meta = new Map<string,string>(); const storage = { getMeta: (k:string)=>meta.get(k)??null, setMeta:(k:string,v:string)=>{meta.set(k,v);} };
  const options = { home, root: path.join(home,".termany/skills"), storage, codexHome: path.join(home,".codex") };
  const catalog = new SkillCatalog(options);
  const write = async (relative: string, body = entry, detail = "Reference") => { const root = path.join(home,relative); await fs.mkdir(path.join(root,"references"),{recursive:true}); await fs.writeFile(path.join(root,"SKILL.md"),body); await fs.writeFile(path.join(root,"references/detail.md"),detail); return root; };
  return { home, meta, options, catalog, write };
}
test("discovers nested defaults and aliases, groups complete duplicates but preserves location identity on divergence", async t => {
  const { catalog, write, home } = await fixture(t);
  const first = await write(".agents/skills/deep/advisor"); const second = await write(".claude/skills/copy");
  await fs.mkdir(path.join(home,".codex/skills"),{recursive:true}); await fs.symlink(first,path.join(home,".codex/skills/link")); await fs.symlink(path.join(home,".agents/skills"),path.join(home,".agents/skills/cycle"));
  let result = await catalog.list(); assert.equal(result.skills.length,1); assert.equal(result.skills[0].aliases?.length,1);
  const stable = result.skills[0].aliases![0].id; const initialRoot = (await catalog.readSkill(stable)).root;
  await fs.writeFile(path.join(second,"references/detail.md"),"different supporting material");
  result = await catalog.refresh(); assert.equal(result.skills.length,2); assert.equal((await catalog.readSkill(stable)).root,initialRoot);
  const id = result.skills.find(s=>s.root===first)!.id;
  await fs.writeFile(path.join(first,"SKILL.md"),entry+"Updated"); assert.match((await catalog.readSkill(id)).body,/Updated/); assert.equal((await catalog.refresh()).skills.find(s=>s.root===first)!.id,id);
});
test("custom roots persist, disabled roots stop discovery without deleting bound locations", async t => {
  const { catalog, write, options } = await fixture(t); const root=await write("custom/a");
  const result=await catalog.updateRoots([{id:"custom",path:path.dirname(root),builtIn:false,enabled:true}]); assert.equal(result.skills.length,1);
  const id=result.skills[0].id; const custom=result.roots.find(r=>!r.builtIn)!;
  const reloaded=new SkillCatalog(options); assert.equal((await reloaded.list()).skills[0].id,id);
  const disabled=await reloaded.updateRoots([{...custom,enabled:false}]); assert.equal(disabled.skills.length,0); assert.equal((await reloaded.readSkill(id)).root,root);
  assert.equal(await fs.readFile(path.join(root,"SKILL.md"),"utf8"),entry);
});
test("reader rejects traversal, external symlinks, binary and oversized entry; supports text chunks",async t=>{
  const {catalog,write,home}=await fixture(t);const root=await write(".agents/skills/a");const id=(await catalog.list()).skills[0].id;
  assert.equal((await catalog.readSkill(id)).body,entry);
  assert.deepEqual(await catalog.readFile(id,"references/detail.md",0,3),{text:"Ref",total:9,nextOffset:3});
  for(const relative of ["../secret","/etc/passwd","a\\b"]) await assert.rejects(catalog.readFile(id,relative),{code:"INVALID_PATH"});
  await fs.writeFile(path.join(home,"secret"),"secret");await fs.symlink(path.join(home,"secret"),path.join(root,"escape"));
  await assert.rejects(catalog.readFile(id,"escape"),{code:"INVALID_PATH"}); await assert.rejects(catalog.listFiles(id),{code:"INVALID_PATH"});
  await fs.writeFile(path.join(root,"binary"),Buffer.from([255,0])); await assert.rejects(catalog.readFile(id,"binary"),{code:"NOT_TEXT"});
  await fs.writeFile(path.join(root,"SKILL.md"),entry+"x".repeat(65536)); await assert.rejects(catalog.readSkill(id),{code:"RESOURCE_TOO_LARGE"});
});
test("legacy exact snapshots migrate deterministically without selecting newest content or mutating files",async t=>{
  const {catalog,write,meta,options}=await fixture(t); const old="a".repeat(64),next="b".repeat(64);
  const oldRoot=await write(`.termany/skills/old/${old}`);await write(`.termany/skills/old/${next}`,entry+"Newer");
  const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
  meta.set("botSkills.v1",JSON.stringify([{id:"old",revisions:[{revision:old,files:[{path:"SKILL.md",sha256:hash(entry),bytes:Buffer.byteLength(entry)}]},{revision:next,files:[{path:"SKILL.md",sha256:hash(entry+"Newer"),bytes:Buffer.byteLength(entry+"Newer")}]}]}]));
  meta.set("agentConversations",JSON.stringify([{agentSkills:[{skillId:"old",revision:old},{skillId:"old",revision:next}]}]));
  const first=await catalog.readSkill("old",old);assert.equal(first.body,entry);assert.equal(first.root,oldRoot);
  const result=await catalog.list();assert.equal(result.skills.length,2);assert.equal((await new SkillCatalog(options).readSkill("old",old)).id,first.id);
  assert.equal(await fs.readFile(path.join(oldRoot,"SKILL.md"),"utf8"),entry);
  await fs.writeFile(path.join(oldRoot,"SKILL.md"),entry+"tampered");await assert.rejects(catalog.readSkill("old",old),{code:"SKILL_CORRUPT"});
});
test("managed source updates retain ID and current pointer while keeping earlier reader root usable",async t=>{
  const {catalog,write}=await fixture(t);const first=await write(".termany/skills/.managed/one");const second=await write(".termany/skills/.managed/two",entry+"Updated");
  const a=await catalog.registerManaged(first,"github:repo:entry");const b=await catalog.registerManaged(second,"github:repo:entry");assert.equal(a.id,b.id);
  assert.equal((await catalog.list()).skills.length,1);assert.match((await catalog.readSkill(a.id)).body,/Updated/);assert.equal(await fs.readFile(path.join(a.root,"SKILL.md"),"utf8"),entry);
});
test("removal protects live bindings and grouped aliases, hides downloads without deleting bytes",async t=>{
  const {catalog,write,meta}=await fixture(t);const root=await write(".termany/skills/.managed/a");const managed=await catalog.registerManaged(root,"repo:a");
  meta.set("agentConversations",JSON.stringify([{agentSkills:[{skillId:managed.id}]}]));await assert.rejects(catalog.remove(managed.id),{code:"SKILL_IN_USE"});
  meta.set("agentConversations","[]");await catalog.remove(managed.id);assert.equal((await catalog.list()).skills.length,0);assert.equal(await fs.readFile(path.join(root,"SKILL.md"),"utf8"),entry);
  await catalog.registerManaged(root,"repo:a");assert.equal((await catalog.list()).skills.length,1);
  const external=await write(".agents/skills/external",entry+"External");const local=(await catalog.refresh()).skills.find(s=>s.root===external)!;await assert.rejects(catalog.remove(local.id),{code:"EXTERNAL_SKILL"});
});
test("unbound old library survives migration and invalid roots do not partially mutate defaults",async t=>{
  const {catalog,write,meta}=await fixture(t);const revision="c".repeat(64);await write(`.termany/skills/old/${revision}`);
  meta.set("botSkills.v1",JSON.stringify([{id:"old",revisions:[{revision,files:[{path:"SKILL.md",sha256:createHash("sha256").update(entry).digest("hex"),bytes:entry.length}]}]}]));
  assert.equal((await catalog.list()).skills.length,1);
  await assert.rejects(catalog.updateRoots([{id:"agents",path:"x",enabled:false,builtIn:true},{path:""} as any]),{code:"INVALID_ROOTS"});
  assert.equal((await catalog.refresh()).roots.find(r=>r.id==="agents")!.enabled,true);
});
test("failed publication and cancellation retain previous managed pointer",async t=>{
  const {catalog,write,options}=await fixture(t);const first=await write(".termany/skills/.managed/first");const next=await write(".termany/skills/.managed/next",entry+"Different");
  const initial=await catalog.registerManaged(first,"repo");const original=options.storage.setMeta;
  options.storage.setMeta=()=>{throw new Error("disk full");};
  await assert.rejects(catalog.registerManaged(next,"repo"),/disk full/);assert.equal((await catalog.readSkill(initial.id)).root,first);
  options.storage.setMeta=original;const controller=new AbortController();controller.abort();await assert.rejects(catalog.registerManaged(next,"repo","github",controller.signal));assert.equal((await catalog.readSkill(initial.id)).root,first);
});
test("one source exceeding traversal budget does not suppress subsequent healthy roots",async t=>{
  const {write,options,home}=await fixture(t);await fs.mkdir(path.join(home,".agents/skills/a/b/c/d/e"),{recursive:true});await write(".claude/skills/healthy");
  const catalog=new SkillCatalog({...options,scanLimits:{directories:3}});const result=await catalog.list();
  assert.equal(result.roots.find(r=>r.id==="agents")!.status,"error");assert.equal(result.roots.find(r=>r.id==="claude")!.status,"ready");assert.equal(result.skills.length,1);
});
