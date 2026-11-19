import assert from "node:assert/strict";
import test from "node:test";
import { shortPath, tildePath } from "./paneCwdPath";

test("tildePath abbreviates the home folder only at a path boundary", () => {
  assert.equal(tildePath("/Users/me", "/Users/me"), "~");
  assert.equal(tildePath("/Users/me/code/x", "/Users/me/"), "~/code/x");
  assert.equal(tildePath("/Users/mex/code", "/Users/me"), "/Users/mex/code");
  assert.equal(tildePath("/tmp", ""), "/tmp");
});

test("shortPath keeps the root and the last two folders", () => {
  assert.equal(shortPath("~/code/termany"), "~/code/termany");
  assert.equal(shortPath("~/code/termany/apps"), "~/code/termany/apps");
  assert.equal(shortPath("~/code/termany/apps/web"), "~/…/apps/web");
  assert.equal(shortPath("/opt/a/b/c/d"), "/…/c/d");
  assert.equal(shortPath("C:\\Users\\me\\code\\x"), "C:\\…\\code\\x");
});
