import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { BOT_SKILL_LIMITS, type SkillSource } from "@termany/core";

const inflate = promisify(gunzip);
const MAX_ARCHIVE = BOT_SKILL_LIMITS.packageBytes;
const MAX_EXPANDED = MAX_ARCHIVE + BOT_SKILL_LIMITS.packageFiles * 2048;
export class GithubSkillError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryAt?: number) { super(message); }
}
const fail = (code: string, message: string): never => { throw new GithubSkillError(code, message); };
function safePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^[a-z]:/i.test(value) || value.split("/").some(p => p === ".." || p === "." || !p)) fail("INVALID_ARCHIVE", "Unsafe path in GitHub archive");
  return value;
}
type GithubSource = Extract<SkillSource, {kind:"github"}>;
interface GithubLocation { url: string; canonical: string; ref: string; subdirectory?: string; precise: boolean; }
/** Resolve longest ref first: a branch/tag may itself contain slashes. A failed
 * ref returns 404 from codeload; only the first successful archive is consumed. */
export function githubArchiveCandidates(source: GithubSource): GithubLocation[] {
  if (typeof source.url !== "string") fail("INVALID_SOURCE", "Expected a GitHub link");
  let url: URL;
  try { url = new URL(source.url.trim()); } catch { return fail("INVALID_SOURCE", "Expected a public HTTPS GitHub link"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) fail("INVALID_SOURCE", "Expected a public HTTPS github.com repository, directory or SKILL.md link");
  // Reject traversal before URL normalizes literal or percent-encoded dot segments.
  const link = source.url.trim();
  const rawPath = link.slice(link.indexOf("://") + 3).replace(/^[^/]+/, "");
  let parts: string[];
  try { parts = rawPath.replace(/\/$/, "").split("/").slice(1).map(p => decodeURIComponent(p)); }
  catch { return fail("INVALID_SOURCE", "Invalid GitHub URL encoding"); }
  if (parts.length < 2 || parts.some(p => !p || /[\\\x00-\x1f\x7f]/.test(p) || p.split("/").some(c => c === "." || c === ".." || !c))) fail("INVALID_SOURCE", "Invalid GitHub path");
  const [owner, rawRepo, view, ...tail] = parts;
  const repo = rawRepo.replace(/\.git$/, "");
  if (![owner, repo].every(p => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) fail("INVALID_SOURCE", "Invalid GitHub repository");
  const canonical = `https://github.com/${owner}/${repo}`;
  const make = (ref: string, subdirectory: string | undefined, precise: boolean): GithubLocation => {
    if (typeof ref !== "string" || !ref.trim() || ref.length > 256 || /[\x00-\x20\x7f]/.test(ref) || ref.split("/").some(p => !p || p === "." || p === "..")) fail("INVALID_SOURCE", "Invalid GitHub branch or reference");
    if (subdirectory) safePath(subdirectory);
    return { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`, canonical, ref, subdirectory, precise };
  };
  if (!view) return [make(source.ref ?? "HEAD", source.subdirectory, false)];
  if (!["tree", "blob"].includes(view) || !tail.length) fail("INVALID_SOURCE", "Use a repository, directory or SKILL.md link");
  if (source.ref !== undefined || source.subdirectory !== undefined) fail("INVALID_SOURCE", "Directory links already specify the reference and path");
  if (view === "blob") {
    if (tail.length < 2 || tail.at(-1) !== "SKILL.md") fail("INVALID_SOURCE", "File links must point to SKILL.md");
    tail.pop();
  }
  if (tail.length > 16) fail("INVALID_SOURCE", "GitHub link has too many path segments");
  const candidates: GithubLocation[] = [];
  // An encoded slash in the first segment explicitly identifies a compound ref.
  const longest = tail[0].includes("/") ? 1 : tail.length;
  for (let split = longest; split >= 1; split--) {
    const ref = tail.slice(0, split).join("/");
    if (/[\x00-\x20\x7f]/.test(ref) || ref.length > 256) continue;
    candidates.push(make(ref, tail.slice(split).join("/") || undefined, true));
  }
  if (!candidates.length) fail("INVALID_SOURCE", "Invalid GitHub branch or reference");
  return candidates;
}
/** Kept synchronous for import-request validation and legacy callers. */
export function githubArchiveLocation(source: GithubSource): GithubLocation { return githubArchiveCandidates(source)[0]; }
function field(block: Buffer, start: number, length: number): string { return block.subarray(start,start+length).toString("utf8").replace(/\0.*$/s, ""); }
function octal(block: Buffer, start: number, length: number): number {
  const value = field(block,start,length).trim();
  if (value && !/^[0-7]+$/.test(value)) return fail("INVALID_ARCHIVE", "Invalid tar numeric field");
  const number = value ? parseInt(value,8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) return fail("INVALID_ARCHIVE", "Invalid tar size");
  return number;
}
function pax(data: Buffer): Record<string,string> {
  const result: Record<string,string> = {};
  for(let offset=0;offset<data.length;) {
    const space = data.indexOf(32,offset);
    if(space < 0 || space-offset>12) fail("INVALID_ARCHIVE","Invalid PAX record");
    const digits=data.subarray(offset,space).toString();
    if(!/^[0-9]+$/.test(digits)) fail("INVALID_ARCHIVE","Invalid PAX length");
    const length=Number(digits),end=offset+length;
    if(length<=space-offset+1 || end>data.length || data[end-1]!==10) fail("INVALID_ARCHIVE","Invalid PAX length");
    const record=data.subarray(space+1,end-1).toString("utf8"),eq=record.indexOf("=");
    if(eq<1) fail("INVALID_ARCHIVE","Invalid PAX field");
    result[record.slice(0,eq)]=record.slice(eq+1);offset=end;
  }
  return result;
}
/** Parse into memory first; no archive path is ever passed to a filesystem extractor. */
export function readGithubTar(tar: Buffer, subdirectory = ""): Map<string,Buffer> {
  if(tar.length>MAX_EXPANDED) fail("PACKAGE_TOO_LARGE","Expanded archive exceeds limit");
  const files=new Map<string,Buffer>(),seen=new Set<string>();
  let root:string|undefined, next:Record<string,string>={}, total=0, entries=0, ended=false;
  for(let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);offset+=512;
    if(header.every(b=>b===0)) { if(tar.subarray(offset).some(b=>b!==0)) fail("INVALID_ARCHIVE","Trailing data after tar terminator");ended=true;break; }
    if(++entries>BOT_SKILL_LIMITS.packageFiles*4) fail("PACKAGE_TOO_LARGE","Too many archive entries");
    let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];
    if(checksum!==octal(header,148,8)) fail("INVALID_ARCHIVE","Invalid tar checksum");
    const size=octal(header,124,12),type=field(header,156,1)||"0";
    if(offset+Math.ceil(size/512)*512>tar.length) fail("INVALID_ARCHIVE","Truncated archive");
    const data=tar.subarray(offset,offset+size);offset+=Math.ceil(size/512)*512;
    if(type==="x"||type==="g") {
      const metadata=pax(data);
      if(type==="x") next=metadata;
      else if(metadata.path || metadata.linkpath || metadata.size) fail("INVALID_ARCHIVE","Unsupported global PAX path override");
      continue;
    }
    if(!["0","5"].includes(type)) fail("INVALID_ARCHIVE","Archive links and special files are not supported");
    if(next.linkpath) fail("INVALID_ARCHIVE","Archive links are not supported");
    if(next.size!==undefined && Number(next.size)!==size) fail("INVALID_ARCHIVE","PAX size mismatch");
    const prefix=field(header,345,155);
    const filename=(next.path ?? `${prefix?prefix+"/":""}${field(header,0,100)}`).replace(/\/$/,"");next={};
    safePath(filename);
    const parts=filename.split("/");root??=parts[0];
    if(parts[0]!==root) fail("INVALID_ARCHIVE","Archive must contain one repository root");
    if(seen.has(filename)) fail("INVALID_ARCHIVE","Duplicate archive path");seen.add(filename);
    if(type==="5") {if(size)fail("INVALID_ARCHIVE","Directory contains data");continue;}
    if(parts.length<2) fail("INVALID_ARCHIVE","File outside repository root");
    total+=size;
    if(total>BOT_SKILL_LIMITS.packageBytes) fail("PACKAGE_TOO_LARGE","Repository exceeds 20 MiB");
    const relative=parts.slice(1).join("/");
    if(subdirectory && !relative.startsWith(subdirectory+"/")) continue;
    const selected=subdirectory?relative.slice(subdirectory.length+1):relative;
    if(selected.split("/").some(p=>[".git","node_modules",".DS_Store"].includes(p))) continue;
    if(files.size>=BOT_SKILL_LIMITS.packageFiles) fail("PACKAGE_TOO_LARGE","Repository contains too many files");
    files.set(selected,Buffer.from(data));
  }
  if(!ended || Object.keys(next).length) fail("INVALID_ARCHIVE","Incomplete tar archive");
  return files;
}
async function limitedBody(response: Response, signal: AbortSignal, limit: number): Promise<Buffer> {
  const reader=response.body?.getReader();if(!reader) return Buffer.alloc(0);
  const chunks:Buffer[]=[];let total=0;
  try {while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>limit) fail("PACKAGE_TOO_LARGE","GitHub response exceeds size limit");chunks.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  return Buffer.concat(chunks);
}
async function checkGithubResponse(response:Response,signal:AbortSignal) {
  if(!response.ok) {
    let body="";try {body=(await limitedBody(response,signal,2048)).toString("utf8");}catch{signal.throwIfAborted();body="(error response unavailable)";}
    const remaining=response.headers.get("x-ratelimit-remaining"), retry=response.headers.get("retry-after"),reset=response.headers.get("x-ratelimit-reset");
    const limited=response.status===429||(response.status===403&&(remaining==="0"||!!retry||/rate limit|secondary rate/i.test(body)));
    let retryAt:number|undefined;
    if(retry) { const seconds=Number(retry);retryAt=Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(retry); }
    else if(reset&&/^\d+$/.test(reset)) retryAt=Number(reset)*1000;
    if(!Number.isFinite(retryAt)) retryAt=undefined;
    const code=limited?"GITHUB_RATE_LIMITED":response.status===403?"GITHUB_FORBIDDEN":response.status===404?"GITHUB_NOT_FOUND":"GITHUB_ERROR";
    console.warn("[termany:github]",JSON.stringify({status:response.status,code,requestId:response.headers.get("x-github-request-id"),remaining,retryAt,message:body.replace(/[\r\n]+/g," ").slice(0,512)}));
    throw new GithubSkillError(code,limited?`GitHub download rate limited.${retryAt?` Retry after ${new Date(retryAt).toISOString()}.`:" Please retry later."}`:response.status===403?"GitHub denied access to this repository.":response.status===404?"GitHub repository or reference not found.":`GitHub returned HTTP ${response.status}.`,response.status,retryAt);
  }
}
export async function downloadGithubSkill(source: Extract<SkillSource,{kind:"github"}>, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{files:Map<string,Buffer>;source:SkillSource;entry?:string}> {
  const candidates=githubArchiveCandidates(source);
  let location=candidates[0];
  let response!:Response;
  for (let i=0;i<candidates.length;i++) {
    location=candidates[i]; signal.throwIfAborted();
    try {response=await fetcher(location.url,{signal,redirect:"error",headers:{"User-Agent":"Termany-Skills","Accept":"application/gzip"}});}
    catch(e) {signal.throwIfAborted();throw new GithubSkillError("GITHUB_NETWORK_ERROR",`GitHub download failed: ${e instanceof Error?e.message:"Network error"}`);}
    if (response.status !== 404 || i === candidates.length-1) break;
    await response.body?.cancel();
  }
  await checkGithubResponse(response,signal);
  let files:Map<string,Buffer>;
  try {
    let compressed:Buffer;
    try { compressed=await limitedBody(response,signal,MAX_ARCHIVE); }
    catch(error) {
      signal.throwIfAborted();
      if(error instanceof GithubSkillError) throw error;
      throw new GithubSkillError("GITHUB_NETWORK_ERROR",`GitHub download interrupted: ${error instanceof Error?error.message:"Network error"}`);
    }
    signal.throwIfAborted();
    let tar:Buffer;
    try {tar=await inflate(compressed,{maxOutputLength:MAX_EXPANDED});}
    catch(error:any) {
      signal.throwIfAborted();
      if(error.code === "ERR_BUFFER_TOO_LARGE") fail("PACKAGE_TOO_LARGE","Repository archive exceeds expanded size limit");
      return fail("INVALID_ARCHIVE","GitHub archive is invalid");
    }
    signal.throwIfAborted();
    files=readGithubTar(tar,location.subdirectory);
  } catch(error:any) {
    signal.throwIfAborted();
    // A small Skill should not be blocked by unrelated assets in a large repository.
    // Keep all package/read limits; fetch only the explicitly requested subtree.
    if(error.code !== "PACKAGE_TOO_LARGE" || !location.precise || !location.subdirectory) throw error;
    files=await downloadGithubDirectory(location,signal,fetcher);
  }
  if (location.precise && !files.has("SKILL.md")) fail("SKILL_PATH_NOT_FOUND", "The linked directory must contain SKILL.md. Paste the link to the Skill directory or its SKILL.md file.");
  return {files,source:{kind:"github",url:location.canonical,...(location.ref !== "HEAD" ? {ref:location.ref}:{}),...(location.subdirectory ? {subdirectory:location.subdirectory}:{})},...(location.precise?{entry:""}:{})};
}

/** Bounded fallback for an explicitly linked directory in an oversized repository.
 * Resolve the commit once and use its immutable tree and raw-file URLs throughout. */
async function downloadGithubDirectory(location:GithubLocation,signal:AbortSignal,fetcher:typeof fetch):Promise<Map<string,Buffer>> {
  const repo=location.canonical.slice("https://github.com/".length);
  const request=async(url:string,limit:number)=>{
    signal.throwIfAborted();
    let response:Response;
    try { response=await fetcher(url,{signal,redirect:"error",headers:{"User-Agent":"Termany-Skills","Accept":"application/vnd.github+json"}}); }
    catch(error:any){signal.throwIfAborted();throw new GithubSkillError("GITHUB_NETWORK_ERROR",`GitHub request failed: ${error.message}`);}
    await checkGithubResponse(response,signal);
    try { const bytes=await limitedBody(response,signal,limit);signal.throwIfAborted();return bytes; }
    catch(error:any){signal.throwIfAborted();if(error instanceof GithubSkillError)throw error;throw new GithubSkillError("GITHUB_NETWORK_ERROR",`GitHub download interrupted: ${error.message}`);}
  };
  const json=async(route:string)=>{
    const bytes=await request(`https://api.github.com/repos/${repo}/${route}`,4*1024*1024);
    try {return JSON.parse(bytes.toString("utf8"));} catch {return fail("GITHUB_ERROR","Invalid GitHub metadata response");}
  };
  const isSha=(value:unknown):value is string=>typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
  const commit=await json(`commits/${encodeURIComponent(location.ref)}`);
  if(!isSha(commit.sha)) fail("GITHUB_ERROR","Invalid GitHub commit response");
  let treeSha=commit.sha;
  const readTree=async(sha:string,recursive=false)=>{
    const tree=await json(`git/trees/${sha}${recursive?"?recursive=1":""}`);
    if(tree.truncated || !Array.isArray(tree.tree)) fail("PACKAGE_TOO_LARGE","GitHub directory listing is incomplete or too large");
    return tree.tree as Array<{path:string;type:string;mode:string;sha:string;size:number}>;
  };
  for(const component of location.subdirectory!.split("/")) {
    const entries=await readTree(treeSha);
    const directory=entries.find(e=>e.path===component && e.type==="tree" && e.mode==="040000");
    if(!directory || !isSha(directory.sha)) fail("SKILL_PATH_NOT_FOUND","The linked Skill directory was not found");
    treeSha=directory!.sha;
  }
  const manifest=await readTree(treeSha,true);
  const selected:Array<{path:string;size:number}>=[];const seen=new Set<string>();let total=0;
  for(const item of manifest) {
    if(typeof item.path!=="string") fail("INVALID_ARCHIVE","Invalid GitHub resource path");
    safePath(item.path);
    if(seen.has(item.path)) fail("INVALID_ARCHIVE","Duplicate GitHub resource path");seen.add(item.path);
    if(item.type==="tree" && item.mode==="040000") continue;
    if(item.type!=="blob" || !["100644","100755"].includes(item.mode)) fail("INVALID_ARCHIVE","Skill links and submodules are not supported");
    if(item.path.split("/").some(p=>[".git","node_modules",".DS_Store"].includes(p))) continue;
    if(!Number.isSafeInteger(item.size) || item.size<0) fail("GITHUB_ERROR","Invalid GitHub resource size");
    total+=item.size;
    if(total>BOT_SKILL_LIMITS.packageBytes || selected.length>=BOT_SKILL_LIMITS.packageFiles) fail("PACKAGE_TOO_LARGE","Skill exceeds file count or 20 MiB size limit");
    selected.push(item);
  }
  if(!selected.some(item=>item.path==="SKILL.md")) fail("SKILL_PATH_NOT_FOUND","The linked directory must contain SKILL.md");
  const files=new Map<string,Buffer>();total=0;
  for(const item of selected) {
    const encoded=[...location.subdirectory!.split("/"),...item.path.split("/")].map(encodeURIComponent).join("/");
    const bytes=await request(`https://raw.githubusercontent.com/${repo}/${commit.sha}/${encoded}`,BOT_SKILL_LIMITS.packageBytes-total);
    if(bytes.length!==item.size) fail("GITHUB_ERROR","GitHub resource size changed unexpectedly");
    total+=bytes.length;files.set(item.path,bytes);
  }
  return files;
}
