import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COLOR_REPLY_MASK,
  defaultColorQueryMask,
  filterDefaultColorReplies,
  isCodexStartupDefaultColorProbe,
} from "./defaultColorProbe";

const codexProbe =
  "\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c";

test("recognizes Codex's paired startup color probe", () => {
  assert.equal(isCodexStartupDefaultColorProbe(codexProbe), true);
  assert.equal(defaultColorQueryMask(codexProbe), DEFAULT_COLOR_REPLY_MASK);
  assert.equal(
    isCodexStartupDefaultColorProbe("\x1b]10;?\x1b\\\x1b]11;?\x1b\\"),
    false,
  );
});

test("withholds default colors while preserving other terminal replies", () => {
  const replies =
    "\x1b[1;1R" +
    "\x1b]10;rgb:ffff/eeee/dddd\x1b\\" +
    "\x1b[?1;2c" +
    "\x1b]11;rgb:1111/2222/3333\x1b\\";
  assert.deepEqual(filterDefaultColorReplies(replies, DEFAULT_COLOR_REPLY_MASK), {
    data: "\x1b[1;1R\x1b[?1;2c",
    pendingMask: 0,
  });
});

test("consumes split foreground and background replies independently", () => {
  const foreground = filterDefaultColorReplies(
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    DEFAULT_COLOR_REPLY_MASK,
  );
  assert.deepEqual(foreground, { data: "", pendingMask: 2 });
  assert.deepEqual(
    filterDefaultColorReplies("\x1b]11;rgb:0000/0000/0000\x07", foreground.pendingMask),
    { data: "", pendingMask: 0 },
  );
});

test("leaves color replies alone when no probe is pending", () => {
  const reply = "\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
  assert.deepEqual(filterDefaultColorReplies(reply, 0), { data: reply, pendingMask: 0 });
});
