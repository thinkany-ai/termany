// Assemble the Node PTY/API server into the Tauri app's resources so a packaged
// build can launch it (see apps/desktop/src-tauri/src/lib.rs). Produces:
//
//   apps/desktop/src-tauri/resources/server/
//     ├─ node (or node.exe)        (bundled Node runtime for the host platform)
//     ├─ server.cjs                (the server, bundled; node-pty left external)
//     └─ node_modules/node-pty/…   (native addon + prebuilds for the host)
//
// Platform-aware: bundles for whatever platform/arch this script runs on, so
// the macOS CI produces a darwin-arm64 bundle and the Windows CI a win32-x64
// one. On macOS, CI signs `node` (with entitlements) and the native binaries
// after this runs. Run from the repo root: `node scripts/bundle-server.mjs`.
//
// Set TERMANY_TARGET_ARCH=x64|arm64 to bundle for an arch other than the host's
// — needed when cross-building the Intel macOS app from an Apple Silicon
// machine, where the bundled runtime must match the app, not the builder.
//
// The Node runtime archive is cached at node_modules/.cache/termany/ so repeat
// runs don't re-download ~30MB. To pre-seed the cache on a slow network, drop
// the archive there yourself (e.g. from https://registry.npmmirror.com/-/binary/node/),
// named exactly `node-v<VERSION>-<os>-<arch>.zip` (win) or `.tar.gz` (unix).
// TERMANY_NODE_DIST_URL overrides the download base URL (e.g. a mirror).

import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node 24: matches the dev runtime and supports node:sqlite without a flag
// (v22 doesn't ship node:sqlite at all). Keep in sync with the dev Node major.
const NODE_VERSION = "24.0.0";

const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'
const ARCH = process.env.TERMANY_TARGET_ARCH?.trim() || process.arch; // 'arm64' | 'x64'
if (!["arm64", "x64"].includes(ARCH)) {
  throw new Error(`unsupported TERMANY_TARGET_ARCH: ${ARCH} (expected arm64 or x64)`);
}
const IS_WIN = PLATFORM === "win32";

// node-pty stores prebuilds under `prebuilds/<platform>-<arch>` (matching
// process.platform + '-' + process.arch), e.g. darwin-arm64 / win32-x64.
const PTY_TRIPLE = `${PLATFORM}-${ARCH}`;
// nodejs.org dist naming: win-x64 / darwin-arm64 / linux-x64.
const NODE_OS = IS_WIN ? "win" : PLATFORM;
const NODE_DIST = `node-v${NODE_VERSION}-${NODE_OS}-${ARCH}`;
const NODE_BIN = IS_WIN ? "node.exe" : "node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/desktop/src-tauri/resources/server");
// Force bash on unix (the curl|tar pipe needs it); on Windows let execSync use
// the default ComSpec (cmd.exe) — curl and tar ship with Windows 10+.
const run = (cmd) =>
  execSync(cmd, { cwd: root, stdio: "inherit", ...(IS_WIN ? {} : { shell: "/bin/bash" }) });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "node_modules"), { recursive: true });

// 1. Bundle the server to a single CJS file. node-pty is native, so it stays
//    external and is shipped separately; everything else (ws, the Anthropic
//    SDK, @termany/core) is inlined.
//    The app version is baked in so the server can answer /api/version: the
//    desktop app refuses to reuse a server from a different build, which is how
//    an upgrade avoids leaving the new UI talking to the previous release's
//    server (see existing_server_matches in src-tauri/src/lib.rs).
const VERSION = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
run(
  `npx --no-install esbuild apps/server/src/index.ts --bundle --platform=node ` +
    `--format=cjs --target=node22 --external:node-pty ` +
    `--define:__TERMANY_VERSION__='${JSON.stringify(VERSION)}' ` +
    `--outfile="${path.join(out, "server.cjs")}"`
);

// 2. Ship node-pty next to the bundle. Keep only the host's prebuild (other
//    arches' native files just add bloat and, on macOS, break codesign), and
//    drop the .pdb debug symbols the Windows prebuilds carry (~40MB).
//    Resolve node-pty from apps/server (the package that depends on it): with
//    pnpm's isolated node_modules it is not hoisted to the repo root, and the
//    realpath escapes pnpm's symlink so cpSync copies real files.
const ptySrc = realpathSync(
  path.dirname(
    createRequire(path.join(root, "apps/server/package.json")).resolve("node-pty/package.json")
  )
);
const ptyDst = path.join(out, "node_modules/node-pty");
cpSync(ptySrc, ptyDst, { recursive: true });
const prebuilds = path.join(ptyDst, "prebuilds");
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    if (platform !== PTY_TRIPLE) {
      rmSync(path.join(prebuilds, platform), { recursive: true, force: true });
      continue;
    }
    const dir = path.join(prebuilds, platform);
    stripPdbs(dir);
    // Restore the unix spawn-helper exec bit (cpSync preserves mode, but be
    // defensive); it doesn't exist on Windows.
    const helper = path.join(dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// 3. Bundled Node runtime for the host platform. The archive is cached outside
//    `out` (which is wiped on every run) so repeat builds skip the download;
//    download to a .tmp file first so a Ctrl+C can't leave a corrupt cache.
const NODE_DIST_URL = process.env.TERMANY_NODE_DIST_URL?.trim() || "https://nodejs.org/dist";
const cacheDir = path.join(root, "node_modules/.cache/termany");
mkdirSync(cacheDir, { recursive: true });

/** Return the cached archive path, downloading it on first use. */
function fetchNodeArchive(ext) {
  const archive = path.join(cacheDir, `${NODE_DIST}.${ext}`);
  if (existsSync(archive)) return archive;
  const tmp = `${archive}.tmp`;
  rmSync(tmp, { force: true });
  run(`curl -fsSL -o "${tmp}" ${NODE_DIST_URL}/v${NODE_VERSION}/${NODE_DIST}.${ext}`);
  renameSync(tmp, archive);
  return archive;
}

if (IS_WIN) {
  const zip = fetchNodeArchive("zip");
  // bsdtar (shipped with Windows 10+) extracts .zip and honours --strip-components.
  run(`tar -xf "${zip}" --strip-components=1 -C "${out}" "${NODE_DIST}/node.exe"`);
} else {
  const tgz = fetchNodeArchive("tar.gz");
  run(`tar xzf "${tgz}" --strip-components=2 -C "${out}" "${NODE_DIST}/bin/node"`);
  chmodSync(path.join(out, NODE_BIN), 0o755);
}

console.log(`[termany] server bundle assembled at ${out} (${PTY_TRIPLE}, ${NODE_BIN})`);

/** Remove *.pdb debug symbols recursively (only present in Windows prebuilds). */
function stripPdbs(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) stripPdbs(p);
    else if (name.name.endsWith(".pdb")) rmSync(p, { force: true });
  }
}
