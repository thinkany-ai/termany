import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrateBotDescription } from "@termany/core";

export function migrateBotProfiles(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    if (typeof item.agentInstructions !== "string") return item;
    const {agentInstructions,...rest}=item;
    return {...rest,agentDescription:migrateBotDescription(item.agentDescription,agentInstructions)};
  });
}
/** VACUUM INTO produces a consistent SQLite backup including committed WAL pages. */
export function migrateBotProfilesDatabase(db: DatabaseSync, backupDirectory: string): void {
  const get=(key:string)=>(db.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as {value:string}|undefined)?.value;
  const marker="botProfileMigration.v2";
  if(get(marker)) return;
  const raw=get("agentConversations");
  let parsed:unknown=[];
  if(raw) { parsed=JSON.parse(raw); if(!Array.isArray(parsed)) throw new Error("Cannot migrate malformed Bot conversations"); }
  let backup:string|undefined;
  {
    mkdirSync(backupDirectory,{recursive:true});
    backup=path.join(backupDirectory,`before-bot-skills-v2-${Date.now()}-${randomUUID()}.db`);
    db.prepare("VACUUM INTO ?").run(backup);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // A second server may have saved or migrated Bots while VACUUM acquired its lock.
    if(get(marker)) { db.exec("COMMIT"); return; }
    const current=get("agentConversations");
    if(current) { parsed=JSON.parse(current); if(!Array.isArray(parsed)) throw new Error("Cannot migrate malformed Bot conversations"); }
    const write=db.prepare("INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    if(current)write.run("agentConversations",JSON.stringify(migrateBotProfiles(parsed)));
    write.run(marker,JSON.stringify({completedAt:Date.now(),backup:backup??null}));
    db.exec("COMMIT");
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}
