#!/usr/bin/env node
// Assembles the publishable `loom` npm package into ./dist-npm and (by default) runs `npm pack` to
// produce loom-<version>.tgz at the repo root. See docs/releasing.md › "Building the npm package".
//
// Why a staging dir instead of packing the repo root:
//   - The published shape differs from the dev root (clean deps, no workspace: specs, a generated
//     package.json) — assembling it separately keeps the dev root + dev workflow untouched.
//   - @loom/shared is private (not on npm), so it CANNOT be a registry dependency; it ships bundled
//     (a real node_modules/@loom/shared + bundledDependencies). npm pack from a controlled staging
//     dir is the reliable way to bundle it (pnpm's workspace symlinks make in-place bundling flaky).
//   - The compiled daemon dist is copied byte-for-byte (NOT esbuild-bundled): bundling would collapse
//     every module's import.meta.url into one location and break the daemon's relative asset lookups
//     (paths.ts uses ../assets while skills/seed.ts uses ../../assets — different depths).
//
// Resulting layout (matches Part 1's resolveWebDistDir() and Part 3's loomVersion() walk-up with NO
// env overrides):
//   dist-npm/
//     package.json            name "loom", version = root version (single source of truth)
//     bin/loom.mjs            the CLI bin
//     dist/                   = packages/daemon/dist  (daemon entry at dist/index.js)
//     dist/web/               = packages/web/dist     (resolveWebDistDir → <daemon-dist>/web)
//     assets/                 = packages/daemon/assets (hook-relay, vault-lint, bundled skills)
//     node_modules/@loom/shared/  bundled workspace package (real dir → bundledDependencies)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const noPack = args.includes("--no-pack");
const log = (m) => console.log(`[pack:npm] ${m}`);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32", cwd: repoRoot, ...opts });
  if (r.status !== 0) {
    console.error(`[pack:npm] command failed (exit ${r.status}): ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Build the workspace (shared → daemon → web) unless told to skip.
if (!noBuild) { log("building workspace (pnpm build) …"); run("pnpm", ["build"]); }

// 2. Verify the built inputs exist.
const daemonDist = path.join(repoRoot, "packages/daemon/dist");
const webDist = path.join(repoRoot, "packages/web/dist");
const sharedDist = path.join(repoRoot, "packages/shared/dist");
const daemonAssets = path.join(repoRoot, "packages/daemon/assets");
for (const [label, p] of [
  ["daemon dist", path.join(daemonDist, "index.js")],
  ["web dist", path.join(webDist, "index.html")],
  ["shared dist", path.join(sharedDist, "index.js")],
  ["daemon assets", path.join(daemonAssets, "hook-relay.mjs")],
]) {
  if (!fs.existsSync(p)) {
    console.error(`[pack:npm] missing ${label} (${p}). Run \`pnpm build\` first (or drop --no-build).`);
    process.exit(1);
  }
}

// 3. Canonical version/name/description = the root package.json (the single source of truth that the
//    daemon's loomVersion() resolves at runtime). Runtime deps come from the daemon's package.json.
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const daemonPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/daemon/package.json"), "utf8"));

// 4. Clean + assemble the staging dir.
const stage = path.join(repoRoot, "dist-npm");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

log("copy daemon dist → dist/");
fs.cpSync(daemonDist, path.join(stage, "dist"), { recursive: true });
log("copy web dist → dist/web/  (resolveWebDistDir → <daemon-dist>/web)");
fs.cpSync(webDist, path.join(stage, "dist", "web"), { recursive: true });
log("copy daemon assets → assets/  (hook-relay, vault-lint, bundled skills)");
fs.cpSync(daemonAssets, path.join(stage, "assets"), { recursive: true });

log("bundle @loom/shared → node_modules/@loom/shared/");
const sharedPkgDir = path.join(stage, "node_modules", "@loom", "shared");
fs.mkdirSync(sharedPkgDir, { recursive: true });
fs.cpSync(sharedDist, path.join(sharedPkgDir, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(sharedPkgDir, "package.json"),
  JSON.stringify(
    {
      name: "@loom/shared",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    },
    null,
    2,
  ) + "\n",
);

log("copy bin/ + README.md");
fs.cpSync(path.join(repoRoot, "bin"), path.join(stage, "bin"), { recursive: true });
if (fs.existsSync(path.join(repoRoot, "README.md"))) {
  fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(stage, "README.md"));
}

// 5. Generate the published package.json. @loom/shared is bundled (concrete "0.0.0" matching the
//    bundled package's own version, so npm uses the bundled copy and never hits the registry); every
//    other daemon dependency stays a real registry dep so `npm i` fetches it (incl. the native
//    better-sqlite3 / node-pty prebuilt binaries and the runtime-resolved @playwright/mcp).
const deps = { ...daemonPkg.dependencies };
delete deps["@loom/shared"];
const pkg = {
  name: "loom",
  version: rootPkg.version,
  description: rootPkg.description,
  type: "module",
  bin: { loom: "bin/loom.mjs" },
  engines: { node: ">=22" },
  files: ["bin", "dist", "assets", "README.md"],
  dependencies: { ...deps, "@loom/shared": "0.0.0" },
  bundledDependencies: ["@loom/shared"],
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
log(`wrote staging package.json (loom@${pkg.version})`);

// 6. npm pack → tarball at the repo root (unless --no-pack).
if (noPack) {
  log(`staged at ${stage} (skipped npm pack)`);
} else {
  log("npm pack …");
  run("npm", ["pack", "--pack-destination", repoRoot], { cwd: stage });
  log(`done → ${path.join(repoRoot, `loom-${pkg.version}.tgz`)}`);
}
