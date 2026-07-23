#!/usr/bin/env node
// Assembles the publishable `loomctl` npm package into ./dist-npm and (by default) runs `npm pack` to
// produce loomctl-<version>.tgz at the repo root. See docs/releasing.md › "Building the npm package".
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
//     package.json            name "loomctl", version = root version (single source of truth)
//     bin/loom.mjs            the CLI bin
//     dist/                   = packages/daemon/dist  (daemon entry at dist/index.js)
//     dist/web/               = packages/web/dist     (resolveWebDistDir → <daemon-dist>/web)
//     assets/                 = packages/daemon/assets (hook-relay, vault-lint, bundled skills)
//     node_modules/@loom/shared/  bundled workspace package (real dir → bundledDependencies)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { curateSkillDirs, DEV_ONLY_SKILLS } from "./curate-release-skills.mjs";

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

// 2b. Refuse to ship an ORPHANED web bundle (card 61fa0950): this is the ONE step whose output goes to
// real end users, with `--no-build` (the release workflow's own invocation — see release.yml) trusting
// WHATEVER `packages/web/dist` already contains, produced by some earlier command. A turbo cache-hit
// restore skipping vite's own `emptyOutDir` (now fixed at the turbo.json level, but this guard doesn't
// rely on that staying true forever) is one way a stale content-hashed bundle can survive alongside the
// current one; this check catches ANY such orphan regardless of cause, right at the point the bundle is
// about to be copied into the published package.
//
// Ground truth is Vite's own build manifest (`build.manifest: true` in vite.config.ts →
// dist/.vite/manifest.json), NOT a regex scrape of index.html: index.html only names the entry chunk +
// its CSS, so scraping it would misfire the moment code-splitting introduces a chunk reached only via a
// dynamic import() (a lazy route, a vendor split) and never named in index.html itself. The manifest
// instead lists every entry AND every reachable chunk (walked here via each entry's `imports` +
// `dynamicImports`), each with its own `file`/`css`/`assets` — the complete, authoritative set of what
// this build actually intended to emit, regardless of how many import hops away a chunk is.
{
  const manifestPath = path.join(webDist, ".vite", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(
      `[pack:npm] missing ${manifestPath} — packages/web/vite.config.ts sets build.manifest:true so this ` +
        `orphan guard has ground truth for what a build legitimately emits; rebuild via \`pnpm build\`.`,
    );
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const referenced = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) return;
    if (entry.file) referenced.add(entry.file);
    for (const f of entry.css ?? []) referenced.add(f);
    for (const f of entry.assets ?? []) referenced.add(f);
    for (const dep of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) visit(dep);
  };
  for (const key of Object.keys(manifest)) visit(key);

  const assetsDir = path.join(webDist, "assets");
  const actual = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const orphans = actual.filter((f) => !referenced.has(path.posix.join("assets", f)));
  if (orphans.length > 0) {
    console.error(
      `[pack:npm] refusing to package an orphaned web bundle — packages/web/dist/assets contains file(s) ` +
        `not present in dist/.vite/manifest.json's emitted-file set: ${orphans.join(", ")}. This dist was ` +
        `not cleanly built (rm -rf packages/web/dist and rebuild via \`pnpm build\`, then re-run without ` +
        `--no-build). If this fires on a build you believe is CORRECT — e.g. a new asset type the manifest ` +
        `doesn't track — check what actually changed in packages/web's build output before assuming it's ` +
        `this guard that's wrong.`,
    );
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
// Curate the staged skills: the dev-only Platform-layer skills (platform-lead / platform-audit, gated
// behind LOOM_DEV) and the install-specific `research` skill must NOT ship to regular `loomctl` users;
// the core orchestration skills always ship. Prune the omitted dirs from the staged copy (curation
// decided by the shared pure helper in curate-release-skills.mjs, so the build + the daemon dev-flag
// test stay in lockstep).
const stagedSkills = path.join(stage, "assets", "skills");
if (fs.existsSync(stagedSkills)) {
  const all = fs.readdirSync(stagedSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const kept = new Set(curateSkillDirs(all));
  const omitted = all.filter((n) => !kept.has(n));
  for (const name of omitted) fs.rmSync(path.join(stagedSkills, name), { recursive: true, force: true });
  log(omitted.length ? `curate skills → omitted: ${omitted.join(", ")}` : `curate skills → no omitted skills present (omit set: ${DEV_ONLY_SKILLS.join(", ")})`);
}

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

log("copy bin/ + README.md + LICENSE");
fs.cpSync(path.join(repoRoot, "bin"), path.join(stage, "bin"), { recursive: true });
if (fs.existsSync(path.join(repoRoot, "README.md"))) {
  fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(stage, "README.md"));
}
if (fs.existsSync(path.join(repoRoot, "LICENSE"))) {
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(stage, "LICENSE"));
}

// 5. Generate the published package.json. @loom/shared is bundled (concrete "0.0.0" matching the
//    bundled package's own version, so npm uses the bundled copy and never hits the registry); every
//    other daemon dependency stays a real registry dep so `npm i` fetches it (incl. the native
//    better-sqlite3 / node-pty prebuilt binaries and the runtime-resolved @playwright/mcp).
const deps = { ...daemonPkg.dependencies };
delete deps["@loom/shared"];
const pkg = {
  name: "loomctl",
  version: rootPkg.version,
  description: rootPkg.description,
  license: rootPkg.license ?? "MIT",
  // REQUIRED for npm provenance (trusted publishing): the registry verifies the published
  // package.json's repository.url matches the source repo in the OIDC provenance bundle, else the
  // publish fails E422. Must resolve to github.com/DanielC000/loom.
  repository: { type: "git", url: "git+https://github.com/DanielC000/loom.git" },
  homepage: "https://github.com/DanielC000/loom#readme",
  bugs: { url: "https://github.com/DanielC000/loom/issues" },
  type: "module",
  bin: { loom: "bin/loom.mjs" },
  engines: { node: ">=22" },
  files: ["bin", "dist", "assets", "README.md", "LICENSE"],
  dependencies: { ...deps, "@loom/shared": "0.0.0" },
  bundledDependencies: ["@loom/shared"],
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
log(`wrote staging package.json (loomctl@${pkg.version})`);

// 6. npm pack → tarball at the repo root (unless --no-pack).
if (noPack) {
  log(`staged at ${stage} (skipped npm pack)`);
} else {
  log("npm pack …");
  run("npm", ["pack", "--pack-destination", repoRoot], { cwd: stage });
  log(`done → ${path.join(repoRoot, `loomctl-${pkg.version}.tgz`)}`);
}
