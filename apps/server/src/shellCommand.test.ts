import assert from "node:assert/strict";
import test from "node:test";
import { shellArgsForCommand } from "./shellCommand.js";

test("runs the command through a login shell so ~/.zprofile still applies", () => {
  assert.deepEqual(shellArgsForCommand("my-cli --flag", "darwin"), [
    "-l",
    "-c",
    "my-cli --flag",
  ]);
});

test("stays non-interactive so ~/.zshrc aliases cannot rewrite the command", () => {
  // `-c` is what makes it non-interactive, and that is the whole point: an
  // interactive shell would source ~/.zshrc and a same-named alias or function
  // would silently run something other than what the caller asked for.
  const args = shellArgsForCommand("codex --some-flag", "linux");
  assert.ok(args.includes("-c"), "must pass -c");
  assert.ok(!args.includes("-i"), "must never be interactive");
});

test("does not mangle quotes or spaces in the command", () => {
  const command = `sh -c 'echo "hello world"'`;
  assert.equal(shellArgsForCommand(command, "darwin").at(-1), command);
});

test("windows runs the command after the prompt hook", () => {
  const args = shellArgsForCommand("my-cli", "win32", "function prompt { }");
  assert.deepEqual(args.slice(0, 3), ["-NoLogo", "-NoProfile", "-Command"]);
  assert.equal(args.at(-1), "function prompt { }\nmy-cli");
});

test("windows omits -NoExit so the pane closes when the command finishes", () => {
  // The interactive path uses -NoExit to keep the prompt alive; a pane created
  // to run one command should end with it rather than linger as a dead shell.
  assert.ok(!shellArgsForCommand("my-cli", "win32").includes("-NoExit"));
});

test("windows without a prompt hook runs the bare command", () => {
  assert.equal(shellArgsForCommand("my-cli", "win32").at(-1), "my-cli");
});
