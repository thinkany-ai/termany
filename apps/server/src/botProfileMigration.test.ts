import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateBotDescription } from "@termany/core";
import { migrateBotProfiles, migrateBotProfilesDatabase } from "./botProfileMigration.js";

test("description migration preserves rules, large text, exact old bindings and is idempotent",()=>{
 const original=[{id:"bot",agentDescription:"Role",agentInstructions:"Do this",agentSkills:[{skillId:"one",revision:"old",contextFiles:["a.md"]}]}];
 const migrated=migrateBotProfiles(original) as any[];
 assert.equal(migrated[0].agentInstructions,undefined);
 assert.equal(migrated[0].agentDescription,"Role\n\n优先约束（原补充指令）：\nDo this");
 assert.deepEqual(migrated[0].agentSkills,original[0].agentSkills);
 assert.deepEqual(migrateBotProfiles(migrated),migrated);
 assert.equal(migrateBotDescription("","x".repeat(20000)).length,20000);
 assert.equal(migrateBotDescription(" Same ","Same")," Same ");
 assert.equal(original[0].agentInstructions,"Do this");
});
test("SQLite migration backs up WAL contents and runs only once", t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),"bot-migration-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const db=new DatabaseSync(path.join(root,"state.db"));t.after(()=>db.close());
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 db.prepare("INSERT INTO app_meta VALUES(?,?)").run("agentConversations",JSON.stringify([{agentInstructions:"Retain me"}]));
 migrateBotProfilesDatabase(db,path.join(root,"backups"));
 const files=readdirSync(path.join(root,"backups"));assert.equal(files.length,1);
 const backup=new DatabaseSync(path.join(root,"backups",files[0]),{readOnly:true});
 const old=backup.prepare("SELECT value FROM app_meta WHERE key='agentConversations'").get() as any;
 assert.equal(JSON.parse(old.value)[0].agentInstructions,"Retain me");backup.close();
 const current=db.prepare("SELECT value FROM app_meta WHERE key='agentConversations'").get() as any;
 assert.deepEqual(JSON.parse(current.value),[{agentDescription:"Retain me"}]);
 migrateBotProfilesDatabase(db,path.join(root,"backups"));assert.equal(readdirSync(path.join(root,"backups")).length,1);
});
test("malformed saved conversations do not get replaced by empty defaults",()=>{
 const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 db.prepare("INSERT INTO app_meta VALUES(?,?)").run("agentConversations","invalid-json");
 assert.throws(()=>migrateBotProfilesDatabase(db,"unused"));
 assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='botProfileMigration.v2'").get(),undefined);db.close();
});
test("migration rereads Bot edits committed before acquiring its write lock",t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),"bot-migration-race-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const db=new DatabaseSync(path.join(root,"state.db"));t.after(()=>db.close());
 db.exec("CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 db.prepare("INSERT INTO app_meta VALUES(?,?)").run("agentConversations",JSON.stringify([{agentInstructions:"Old"}]));
 const wrapped={prepare:db.prepare.bind(db),exec(sql:string){
   if(sql==="BEGIN IMMEDIATE") db.prepare("UPDATE app_meta SET value=? WHERE key='agentConversations'").run(JSON.stringify([{agentInstructions:"New",agentSkills:[{skillId:"updated"}]}]));
   return db.exec(sql);
 }} as DatabaseSync;
 migrateBotProfilesDatabase(wrapped,path.join(root,"backups"));
 const current=db.prepare("SELECT value FROM app_meta WHERE key='agentConversations'").get() as any;
 assert.deepEqual(JSON.parse(current.value),[{agentDescription:"New",agentSkills:[{skillId:"updated"}]}]);
});
