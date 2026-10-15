import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { SkillRepository, SkillError } from "./skills.js";
import { handleSkillRequest } from "./skillsHttp.js";
const entry = "---\nname: advisor\ndescription: Example advisor\n---\n# Instructions\nRead references/detail.md.\n";
async function fixture(t: any, fetcher?: typeof fetch) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "termany-skills-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = new Map<string, string>();
  const storage = { getMeta: (key: string) => data.get(key) ?? null, setMeta: (key: string, value: string) => { data.set(key, value); } };
  const options = { root: path.join(directory, "snapshots"), storage, fetch: fetcher, home: directory };
  const repo = new SkillRepository(options);
  const source = path.join(directory, "source"); await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), entry); await fs.writeFile(path.join(source, "references/detail.md"), "Details");
  return { repo, source, directory, data, options };
}
async function finish(repo: SkillRepository, id: string) {
  for (let count = 0; count < 400; count++) { const job = repo.getImport(id); if (job.status !== "running") return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Import did not finish");
}
function archive(files: Record<string,string>) {
  const chunks: Buffer[]=[];
  for(const [name,value] of Object.entries(files)) {
    const bytes=Buffer.from(value);const h=Buffer.alloc(512); h.write(`repo-main/${name}`);h.write("0000644\0",100);h.write("0000000\0",108);h.write("0000000\0",116);h.write(bytes.length.toString(8).padStart(11,"0")+"\0",124);h.write("00000000000\0",136);h.fill(32,148,156);h[156]=48;h.write("ustar\0",257);h.write("00",263);const sum=[...h].reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,"0")+"\0 ",148);chunks.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));
  } chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks));
}
test("local imports register live directories without copying; repeat imports keep stable ID",async t=>{
  const {repo,source}=await fixture(t);const catalog=await repo.getCatalog();
  const first=await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id);assert.equal(first.status,"complete");assert.equal(first.binding!.revision,undefined);
  const id=first.binding!.skillId;assert.equal((await catalog.readSkill(id)).root,source);
  const duplicate=await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id);assert.deepEqual(duplicate.binding,first.binding);
  await fs.writeFile(path.join(source,"SKILL.md"),entry+"New behavior");assert.match((await catalog.readSkill(id)).body,/New behavior/);assert.equal((await catalog.list()).skills.length,1);
});
test("multi-entry selection reuses download once; stable source updates affect current item only",async t=>{
  let count=0;let body=entry;
  const mock=(async()=>{count++;return new Response(archive({"one/SKILL.md":body,"two/SKILL.md":entry}));}) as typeof fetch;
  const {repo}=await fixture(t,mock);const source={kind:"github" as const,url:"https://github.com/example/advisor"};
  let job=await finish(repo,repo.startImport({source}).id);assert.equal(job.status,"select-entry");assert.deepEqual(job.candidates,["one","two"]);
  job=await finish(repo,repo.selectImport(job.id,"one").id);assert.equal(job.status,"complete",job.error);assert.equal(count,1);
  const catalog=await repo.getCatalog();const initial=await catalog.readSkill(job.binding!.skillId);
  body=entry+"Updated";const updated=await finish(repo,repo.startImport({source,entry:"one"}).id);assert.equal(updated.status,"complete",updated.error);assert.deepEqual(updated.binding,job.binding);assert.match((await catalog.readSkill(job.binding!.skillId)).body,/Updated/);
  assert.equal(await fs.readFile(initial.entryPath,"utf8"),entry);
  assert.equal((await catalog.list()).skills.length,1);
});
test("selection cancellation and restart invalidate cached downloads",async t=>{
  const {repo,source,options,data}=await fixture(t);await fs.mkdir(path.join(source,"other"));await fs.writeFile(path.join(source,"other/SKILL.md"),entry);
  const selection=await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id);assert.equal(selection.status,"select-entry");
  repo.cancelImport(selection.id);assert.throws(()=>repo.selectImport(selection.id,"other"),{code:"IMPORT_NOT_SELECTABLE"});
  const jobs=JSON.parse(data.get("botSkillImports.v1")!);jobs.push({id:"crashed",status:"select-entry",request:{source:{kind:"local",path:source}}});data.set("botSkillImports.v1",JSON.stringify(jobs));
  assert.equal(new SkillRepository(options).getImport("crashed").code,"INTERRUPTED");
});
test("HTTP catalog search, details, files, root settings, cached selection and errors",async t=>{
  const {repo,source}=await fixture(t);const server=createServer((req,res)=>void handleSkillRequest(req,res,new URL(req.url!,"http://localhost"),repo));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(base+"/api/skills/import",{method:"POST",body:JSON.stringify({source:{kind:"local",path:source}})});assert.equal(response.status,202);
  const job=await finish(repo,(await response.json()).id);assert.equal(job.status,"complete");const id=job.binding!.skillId;
  assert.equal((await (await fetch(base+"/api/skill-catalog")).json()).skills.length,1);
  assert.match((await (await fetch(base+`/api/skill-catalog/${id}`)).json()).body,/Instructions/);
  const files=await (await fetch(base+`/api/skill-catalog/${id}/files?limit=1`)).json();assert.equal(files.files.length,1);assert.equal(files.nextOffset,1);
  const chunk=await (await fetch(base+`/api/skill-catalog/${id}/file?path=references%2Fdetail.md&limit=3`)).json();assert.equal(chunk.text,"Det");assert.equal(chunk.nextOffset,3);
  assert.equal((await fetch(base+`/api/skill-catalog/${id}/files?limit=-1`)).status,400);
  assert.equal((await fetch(base+"/api/skill-roots",{method:"PUT",body:JSON.stringify({roots:[]})})).status,200);
  assert.equal((await (await fetch(base+"/api/skills/import",{method:"POST",body:"bad"})).json()).code,"INVALID_JSON");
});
test("local import rejects invalid entry, escaping symlinks and oversized packages without publication",async t=>{
  const {repo,source,directory}=await fixture(t);
  await fs.writeFile(path.join(directory,"outside"),"secret");await fs.symlink(path.join(directory,"outside"),path.join(source,"escape"));
  assert.equal((await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id)).code,"INVALID_PATH");await fs.unlink(path.join(source,"escape"));
  await fs.writeFile(path.join(source,"SKILL.md"),"bad");assert.equal((await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id)).code,"INVALID_SKILL");
  await fs.writeFile(path.join(source,"SKILL.md"),entry);const file=await fs.open(path.join(source,"large"),"w");await file.truncate(20*1024*1024+1);await file.close();assert.equal((await finish(repo,repo.startImport({source:{kind:"local",path:source}}).id)).code,"PACKAGE_TOO_LARGE");
});
test("concurrent local imports publish one identity and invalid GitHub URLs fail before fetching",async t=>{
  const {repo,source}=await fixture(t);const request={source:{kind:"local" as const,path:source}};const jobs=[repo.startImport(request),repo.startImport(request)];const results=await Promise.all(jobs.map(job=>finish(repo,job.id)));assert.deepEqual(results[0].binding,results[1].binding);assert.equal((await (await repo.getCatalog()).list()).skills.length,1);
  for(const url of ["http://github.com/example/a","https://github.com.evil/example/a","https://user:password@github.com/example/a"])assert.throws(()=>repo.startImport({source:{kind:"github",url}}),SkillError);
});
test("import polling preserves categorized HTTP status and retry time",async t=>{
  const mock=(async()=>new Response("rate limited",{status:403,headers:{"x-ratelimit-remaining":"0","x-ratelimit-reset":"2000000000"}})) as typeof fetch;
  const {repo,options}=await fixture(t,mock);const job=await finish(repo,repo.startImport({source:{kind:"github",url:"https://github.com/example/advisor"}}).id);
  assert.equal(job.status,"failed");assert.equal(job.httpStatus,403);assert.equal(job.retryAt,2000000000000);assert.match(job.code!,/LIMIT/);assert.equal(new SkillRepository(options).getImport(job.id).retryAt,job.retryAt);
});
test("precise directory link selects its root even when it contains nested Skills",async t=>{
 const mock=(async(url:any)=>String(url).endsWith('/main')?new Response(archive({'advisor/SKILL.md':entry,'advisor/examples/nested/SKILL.md':entry.replace('advisor','nested')})):new Response('not ref',{status:404})) as typeof fetch;
 const {repo}=await fixture(t,mock);
 const job=await finish(repo,repo.startImport({source:{kind:'github',url:'https://github.com/o/r/tree/main/advisor'}}).id);
 assert.equal(job.status,'complete',job.error);
 assert.equal((await (await repo.getCatalog()).readSkill(job.binding!.skillId)).name,'advisor');
 const same=await finish(repo,repo.startImport({source:{kind:'github',url:'https://github.com/o/r/blob/main/advisor/SKILL.md'}}).id);
 assert.deepEqual(same.binding,job.binding);
});
