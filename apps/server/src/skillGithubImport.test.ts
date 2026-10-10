import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { downloadGithubSkill, githubArchiveLocation, readGithubTar } from "./skillGithubImport.js";
export function tarFixture(entries:Array<{path:string;body?:string;type?:string}>):Buffer {
 const blocks:Buffer[]=[];
 for(const entry of entries){const b=Buffer.alloc(512),data=Buffer.from(entry.body??"");b.write(entry.path,0,100);b.write(data.length.toString(8).padStart(11,"0")+"\0",124,12);b.write(entry.type??"0",156,1);b.fill(32,148,156);b.write("ustar\0",257);const sum=b.reduce((a,v)=>a+v,0);b.write(sum.toString(8).padStart(6,"0")+"\0 ",148,8);blocks.push(b,data,Buffer.alloc((512-data.length%512)%512));}
 return Buffer.concat([...blocks,Buffer.alloc(1024)]);
}
const source={kind:"github" as const,url:"https://github.com/alchaincyf/elon-musk-skill"};
test("GitHub import uses one bounded archive instead of per-file REST calls",async()=>{
 const requests:string[]=[];const fetcher=(async(url:any)=>{requests.push(String(url));return new Response(gzipSync(tarFixture([{path:"repo/SKILL.md",body:"entry"},{path:"repo/references/a.md",body:"reference"}])));}) as typeof fetch;
 const loaded=await downloadGithubSkill(source,new AbortController().signal,fetcher);
 assert.equal(requests.length,1);assert.equal(requests[0],"https://codeload.github.com/alchaincyf/elon-musk-skill/tar.gz/HEAD");assert.equal(loaded.files.get("references/a.md")?.toString(),"reference");
});
test("archive paths, links, truncation, checksum corruption and duplicate files are rejected",()=>{
 for(const entries of [[{path:"repo/../escape"}],[{path:"/repo/SKILL.md"}],[{path:"repo/link",type:"2"}],[{path:"repo/a",type:"1"}],[{path:"repo/a"},{path:"repo/a"}],[{path:"repo/a"},{path:"other/b"}]]) assert.throws(()=>readGithubTar(tarFixture(entries)),{code:"INVALID_ARCHIVE"});
 const damaged=tarFixture([{path:"repo/SKILL.md",body:"entry"}]);damaged[0]=65;assert.throws(()=>readGithubTar(damaged),{code:"INVALID_ARCHIVE"});
 assert.throws(()=>readGithubTar(tarFixture([{path:"repo/a",body:"x"}]).subarray(0,550)),{code:"INVALID_ARCHIVE"});
});
test("subdirectory selection keeps relative paths and URL normalization is strict",()=>{
 const files=readGithubTar(tarFixture([{path:"repo/skills/a/SKILL.md",body:"a"},{path:"repo/skills/b/SKILL.md",body:"b"}]),"skills/a");assert.deepEqual([...files.keys()],["SKILL.md"]);
 assert.equal(githubArchiveLocation({...source,url:source.url+".git",ref:"feature/foo"}).url.endsWith("feature%2Ffoo"),true);
 for(const url of ["http://github.com/o/r","https://evil.com/o/r","https://x@github.com/o/r","https://github.com/o/r?token=x"]) assert.throws(()=>githubArchiveLocation({...source,url}),{code:"INVALID_SOURCE"});
});
test("403 is classified using evidence and preserves retry time",async()=>{
 const get=(status:number,body:string,headers:Record<string,string>={})=>downloadGithubSkill(source,new AbortController().signal,(async()=>new Response(body,{status,headers})) as typeof fetch);
 await assert.rejects(get(403,'{"message":"API rate limit exceeded"}',{"x-ratelimit-remaining":"0","x-ratelimit-reset":"2000000000"}),(e:any)=>e.code==="GITHUB_RATE_LIMITED"&&e.retryAt===2000000000000);
 await assert.rejects(get(403,"Access blocked"),{code:"GITHUB_FORBIDDEN"});await assert.rejects(get(404,"Not Found"),{code:"GITHUB_NOT_FOUND"});await assert.rejects(get(502,"<html>bad gateway</html>"),{code:"GITHUB_ERROR"});await assert.rejects(get(429,"slow down",{"retry-after":"60"}),{code:"GITHUB_RATE_LIMITED"});
});
test("invalid compression and cancelled requests do not return partial packages",async()=>{
 await assert.rejects(downloadGithubSkill(source,new AbortController().signal,(async()=>new Response("not gzip")) as typeof fetch),{code:"INVALID_ARCHIVE"});
 const c=new AbortController();c.abort();await assert.rejects(downloadGithubSkill(source,c.signal,(async()=>{throw new Error("aborted");}) as typeof fetch),{name:"AbortError"});
});
test("a response stream network failure is classified and cancellation is preserved",async()=>{
 const fetcher=(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError("connection reset"));}}))) as typeof fetch;
 await assert.rejects(downloadGithubSkill(source,new AbortController().signal,fetcher),{code:"GITHUB_NETWORK_ERROR"});
 const c=new AbortController();
 const cancelled=(async()=>{c.abort();return new Response("denied",{status:403});}) as typeof fetch;
 await assert.rejects(downloadGithubSkill(source,c.signal,cancelled),{name:"AbortError"});
});
test("tree and blob links import only the precise Skill directory with its references",async()=>{
 for(const view of ['tree/main/skills/advisor','blob/main/skills/advisor/SKILL.md']) {
  const calls:string[]=[];
  const fetcher=(async(url:any)=>{
   calls.push(String(url));
   if(!String(url).endsWith('/main')) return new Response('not a ref',{status:404});
   return new Response(gzipSync(tarFixture([{path:'repo/skills/advisor/SKILL.md',body:'advisor'},{path:'repo/skills/advisor/references/a.md',body:'ref'},{path:'repo/skills/other/SKILL.md',body:'other'}])));
  }) as typeof fetch;
  const loaded=await downloadGithubSkill({kind:'github',url:'https://github.com/owner/repo/'+view},new AbortController().signal,fetcher);
  assert.deepEqual([...loaded.files.keys()],['SKILL.md','references/a.md']);
  assert.deepEqual(loaded.source,{kind:'github',url:'https://github.com/owner/repo',ref:'main',subdirectory:'skills/advisor'});
  assert.equal(calls.filter(u=>u.endsWith('/main')).length,1);
 }
});
test("slash references resolve longest valid ref and encoded slash refs are explicit",async()=>{
 for(const refPath of ['feature/topic/skills/advisor','feature%2Ftopic/skills/advisor']) {
  const calls:string[]=[];
  const fetcher=(async(url:any)=>{
   calls.push(String(url));
   if(!String(url).endsWith('/feature%2Ftopic')) return new Response('not a ref',{status:404});
   return new Response(gzipSync(tarFixture([{path:'repo/skills/advisor/SKILL.md',body:'right branch'}])));
  }) as typeof fetch;
  const loaded=await downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/'+refPath},new AbortController().signal,fetcher);
  assert.equal((loaded.source as any).ref,'feature/topic');assert.equal(loaded.files.get('SKILL.md')?.toString(),'right branch');
  if(refPath.includes('%')) assert.equal(calls.length,1);
 }
});
test("precise link does not silently import unrelated Skills or try other branches",async()=>{
 let count=0;
 const fetcher=(async()=>{count++;return new Response(gzipSync(tarFixture([{path:'repo/other/SKILL.md',body:'unrelated'}])));}) as typeof fetch;
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/missing'},new AbortController().signal,fetcher),{code:'SKILL_PATH_NOT_FOUND'});
 assert.equal(count,1);
 for(const url of ['https://github.com/o/r/blob/main/README.md','https://github.com/o/r/tree/main/../secret','https://github.com/o/r/tree/main/%2e%2e/secret','https://github.com/o/r/tree/main/%ZZ','https://github.com/o/r/tree/main/a%5Cb']) assert.throws(()=>githubArchiveLocation({kind:'github',url}),{code:'INVALID_SOURCE'});
});
test("ref probing respects cancellation and never retries forbidden responses",async()=>{
 let count=0;
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/a'},new AbortController().signal,(async()=>{count++;return new Response('denied',{status:403});}) as typeof fetch),{code:'GITHUB_FORBIDDEN'});assert.equal(count,1);
 const c=new AbortController();count=0;
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/a'},c.signal,(async()=>{count++;c.abort();return new Response('none',{status:404});}) as typeof fetch),{name:'AbortError'});assert.equal(count,1);
});
test("large repository fallback reads only the exact subtree using one pinned commit",async()=>{
 const sha='a'.repeat(40), root='b'.repeat(40),sub='c'.repeat(40),calls:string[]=[];
 const oversized=gzipSync(tarFixture([{path:'repo/unrelated.bin',body:'x'.repeat(23*1024*1024)}]));
 const payloads:Record<string,unknown>={
  ['commits/main']:{sha},
  ['git/trees/'+sha]:{tree:[{path:'skills',type:'tree',mode:'040000',sha:root}]},
  ['git/trees/'+root]:{tree:[{path:'advisor',type:'tree',mode:'040000',sha:sub}]},
  ['git/trees/'+sub+'?recursive=1']:{tree:[{path:'SKILL.md',type:'blob',mode:'100644',size:5},{path:'references',type:'tree',mode:'040000'},{path:'references/a.md',type:'blob',mode:'100644',size:3}]},
 };
 const fetcher=(async(url:any)=>{
  const u=String(url);calls.push(u);
  if(u.startsWith('https://codeload.github.com/'))return u.endsWith('/main')?new Response(oversized):new Response('404',{status:404});
  if(u.startsWith('https://api.github.com/repos/o/r/'))return Response.json(payloads[u.slice('https://api.github.com/repos/o/r/'.length)]);
  assert.ok(u.startsWith(`https://raw.githubusercontent.com/o/r/${sha}/skills/advisor/`));
  return new Response(u.endsWith('SKILL.md')?'entry':'ref');
 }) as typeof fetch;
 const loaded=await downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/skills/advisor'},new AbortController().signal,fetcher);
 assert.deepEqual([...loaded.files.keys()],['SKILL.md','references/a.md']);assert.equal(loaded.entry,'');
 assert.equal(calls.filter(u=>u.includes('/commits/')).length,1);assert.equal(calls.some(u=>u.includes('/git/blobs/')),false);
 const controller=new AbortController();
 const aborted=(async(...args:Parameters<typeof fetch>)=>{if(String(args[0]).includes('api.github.com'))controller.abort();return fetcher(...args);}) as typeof fetch;
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/skills/advisor'},controller.signal,aborted),{name:'AbortError'});
 const previous=calls.length;
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r',ref:'main'},new AbortController().signal,fetcher),{code:'PACKAGE_TOO_LARGE'});
 assert.equal(calls.slice(previous).some(u=>u.includes('api.github.com')),false);
 // An incomplete tree must never publish a partial package.
 payloads['git/trees/'+sub+'?recursive=1']={truncated:true,tree:[]};
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/skills/advisor'},new AbortController().signal,fetcher),{code:'PACKAGE_TOO_LARGE'});
 payloads['git/trees/'+sub+'?recursive=1']={tree:[{path:'SKILL.md',type:'blob',mode:'120000',size:5}]};
 await assert.rejects(downloadGithubSkill({kind:'github',url:'https://github.com/o/r/tree/main/skills/advisor'},new AbortController().signal,fetcher),{code:'INVALID_ARCHIVE'});
});
