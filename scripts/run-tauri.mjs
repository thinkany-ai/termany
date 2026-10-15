#!/usr/bin/env node
// Run the Tauri CLI with a macOS developer toolchain that can actually link
// against its own SDK. Apple occasionally ships/updates the standalone
// Command Line Tools out of sync: xcrun then finds a newer SDK whose .tbd
// architecture names are unknown to the bundled linker. Rust compilation gets
// all the way to the final link before failing with an opaque "malformed file"
// error.
//
// Probe the effective toolchain with a tiny AppKit link. If it is broken, use
// an installed Xcode toolchain for this process only. We deliberately do not
// call `sudo xcode-select`, so running Termany never changes global machine
// state. On Linux and Windows this file is a transparent Tauri launcher.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.platform === "darwin" ? macosBuildEnvironment() : { ...process.env };
// The Tauri CLI is a devDependency of apps/desktop, not of this scripts/ dir.
// Under pnpm's strict node_modules layout it is not hoisted to the repo root,
// so resolving from here alone fails ("Cannot find module @tauri-apps/cli").
// Resolve from the desktop workspace first, then fall back to this file's own
// location so a hoisted (npm) layout keeps working.
const tauri = (() => {
  const bases = [
    new URL("../apps/desktop/package.json", import.meta.url),
    import.meta.url,
  ];
  for (const base of bases) {
    try {
      return createRequire(base).resolve("@tauri-apps/cli/tauri.js");
    } catch {
      // try the next resolution base
    }
  }
  throw new Error(
    "Tauri CLI not found. Run `pnpm install` (it is a devDependency of apps/desktop).",
  );
})();
const child = spawn(process.execPath, [tauri, ...args], { env, stdio: "inherit" });

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("[termany] Tauri CLI not found. Run `pnpm install` first.");
  } else {
    console.error(`[termany] failed to start Tauri: ${error.message}`);
  }
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

/** Return an environment whose selected macOS SDK passes a real framework link. */
function macosBuildEnvironment() {
  const original = { ...process.env };
  const selected = developerDirectory(original);
  const current = probeToolchain(original);
  if (current.ok) return original;

  for (const developerDir of xcodeDeveloperDirectories()) {
    if (developerDir === selected) continue;
    const candidate = { ...original, DEVELOPER_DIR: developerDir };
    const probe = probeToolchain(candidate);
    if (!probe.ok) continue;

    console.warn(
      `[termany] macOS developer tools at ${selected || "the current xcode-select path"} ` +
        "cannot link against their SDK."
    );
    console.warn(`[termany] using compatible Xcode toolchain for this run: ${developerDir}`);
    return candidate;
  }

  const detail = current.error ? `\n\nLinker output:\n${current.error}` : "";
  console.error(
    "[termany] No usable macOS developer toolchain was found. Install or update Xcode, " +
      "open it once to finish setup, then run `sudo xcode-select --switch " +
      "/Applications/Xcode.app/Contents/Developer`." +
      detail
  );
  process.exit(1);
}

/** Locate conventional Xcode installs, preferring the stable app. */
function xcodeDeveloperDirectories() {
  const roots = ["/Applications", path.join(homedir(), "Applications")];
  const found = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    entries
      .filter((name) => /^Xcode.*\.app$/i.test(name))
      .sort((a, b) => {
        if (a === "Xcode.app") return -1;
        if (b === "Xcode.app") return 1;
        return a.localeCompare(b);
      })
      .forEach((name) => {
        const developerDir = path.join(root, name, "Contents", "Developer");
        if (existsSync(developerDir) && !found.includes(developerDir)) found.push(developerDir);
      });
  }

  return found;
}

/** Resolve the developer directory currently effective for an environment. */
function developerDirectory(env) {
  if (env.DEVELOPER_DIR?.trim()) return env.DEVELOPER_DIR.trim();
  const result = spawnSync("/usr/bin/xcode-select", ["--print-path"], {
    encoding: "utf8",
    env,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Compile and link a minimal AppKit program using the given developer directory. */
function probeToolchain(env) {
  const sdkResult = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    encoding: "utf8",
    env,
  });
  if (sdkResult.status !== 0) return { ok: false, error: conciseError(sdkResult) };

  const clangResult = spawnSync("/usr/bin/xcrun", ["--find", "clang"], {
    encoding: "utf8",
    env,
  });
  if (clangResult.status !== 0) return { ok: false, error: conciseError(clangResult) };

  const scratch = mkdtempSync(path.join(tmpdir(), "termany-toolchain-"));
  const output = path.join(scratch, "probe");
  try {
    const link = spawnSync(
      clangResult.stdout.trim(),
      [
        "-x",
        "c",
        "-",
        "-isysroot",
        sdkResult.stdout.trim(),
        "-framework",
        "AppKit",
        "-o",
        output,
      ],
      {
        encoding: "utf8",
        env,
        input: "int main(void) { return 0; }\n",
      }
    );
    return link.status === 0
      ? { ok: true }
      : { ok: false, error: conciseError(link) };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

/** Keep setup errors readable while retaining the lines that identify the SDK failure. */
function conciseError(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return output.split("\n").slice(-12).join("\n");
}
