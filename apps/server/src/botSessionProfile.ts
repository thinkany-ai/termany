import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileBotContext } from "./botContext.js";
import { botAcpPrompt, isBotRuntimeCommand } from "./botIdentity.js";

export class BotSessionProfile {
  private delivered = "";
  private pending = "";
  private readonly file = path.join(os.homedir(), ".termany", "runtime-profiles", `${randomUUID()}.md`);
  invalidate() { this.delivered = ""; }
  async prepare(text: string, raw: unknown) {
    if (isBotRuntimeCommand(text)) {
      if (/^\s*\/(compact|clear|reset|new)(?:\s|$)/i.test(text)) this.invalidate();
      return text;
    }
    if (!raw) { this.invalidate(); return text; }
    const context = await compileBotContext(raw);
    this.pending = context.fingerprint;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(`${this.file}.tmp`, context.text, { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
    const recovery = `Read current Bot configuration at ${JSON.stringify(this.file)} using your file tools.`;
    const short = `[Termany configuration reminder]\nBot: ${JSON.stringify((raw as any)?.name ?? "")}\nConfiguration: ${context.fingerprint}. ${recovery}\nIf role or Skill guidance is missing from your context, read it again. The next content block is the user's current request.`;
    return botAcpPrompt(text, raw, this.delivered === this.pending ? short : `${context.text}\n\n${recovery}`);
  }
  commit(text: string) { if (!isBotRuntimeCommand(text)) this.delivered = this.pending; }
  async close() { await rm(this.file, { force: true }); await rm(`${this.file}.tmp`, { force: true }); }
}
