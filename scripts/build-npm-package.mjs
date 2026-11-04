#!/usr/bin/env node
// Assembles the publishable `loomctl` npm package into ./dist-npm and (by default) runs `npm pack` to
// produce loomctl-<version>.tgz at the repo root. See docs/releasing.md › "Building the npm package".
//
// Why a staging dir instead of packing the repo root:
//   - The published shape differs from the dev root (clean deps, no workspace: specs, a generated
//     package.json) — assembling it separately keeps the dev root + dev workflow untouched.
//   - @loom/shared is private (not on npm), so it CANNOT be a registry dependency; it ships VENDORED
//     outside node_modules (vendor/loom-shared/, resolved via the package.json `imports` map, never
//     bundledDependencies — see the decision note further down). npm pack from a controlled staging
//     dir is the reliable way to assemble it (pnpm's workspace symlinks make in-place assembly flaky).
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
//     vendor/loom-shared/dist/    vendored workspace package, resolved via the `imports` map
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { curateSkillDirs, DEV_ONLY_SKILLS } from "./curate-release-skills.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The exact set of build-output directories this script copies into the published npm tarball —
// the single source of truth for "what does a `loomctl` install actually ship". A consumer that needs
// to know what ships (e.g. the codescape-privacy-guard's dist scan, packages/daemon/test/
// codescape-privacy-guard.mjs) imports THIS, rather than hand-maintaining a second copy of these paths
// that can silently drift the next time the package layout changes.
export const PACKAGED_ROOTS = {
  daemonDist: path.join(repoRoot, "packages/daemon/dist"),
  webDist: path.join(repoRoot, "packages/web/dist"),
  sharedDist: path.join(repoRoot, "packages/shared/dist"),
  daemonAssets: path.join(repoRoot, "packages/daemon/assets"),
};

// Card 01d30507: `packages/daemon/test/graceful-teardown-hard-exit-backstop.mjs` used to write its
// RED/GREEN dist-patch proofs as a uniquely-named SIBLING of dist/graceful-teardown.js, directly inside
// `PACKAGED_ROOTS.daemonDist` — a gate-timeout SIGKILL could skip that sibling's own cleanup and leave it
// behind. That test now copies its own patch target into a dir OUTSIDE dist/ instead (never writes here
// at all), so this should never fire — kept as a belt-and-braces check since step 4 below copies
// `daemonDist` WHOLESALE with no filtering (`fs.cpSync`, no include/exclude list), so any stray file
// sitting there ships verbatim in the published tarball regardless of how it got there. Exported (like
// `PACKAGED_ROOTS`) so a test can exercise this pure check against a throwaway fixture dir without
// needing to run the whole packaging script.
export function findStrayDistShims(daemonDistDir) {
  let names;
  try {
    names = fs.readdirSync(daemonDistDir);
  } catch {
    return [];
  }
  return names.filter((name) => /^graceful-teardown\.(clockshim|winrace)-/.test(name));
}

// @decision 1ebbf523 — never hardcode this set; derive it from bundledCapabilities()/
// npmPinnedLockAssetPath(), and verify it against npm's own packed file list, never source presence alone.
export async function requiredNpmPinnedLockPackedPaths(daemonDistDir) {
  const { bundledCapabilities } = await import(pathToFileURL(path.join(daemonDistDir, "capabilities", "seed.js")).href);
  const { npmPinnedLockAssetPath } = await import(pathToFileURL(path.join(daemonDistDir, "capabilities", "npm-pinned.js")).href);
  const assetsRoot = path.join(daemonDistDir, "..", "assets");
  return bundledCapabilities()
    .filter((c) => c.kind === "npm-pinned")
    .map((c) => JSON.parse(c.provisionJson))
    .map((p) => {
      const absLockPath = npmPinnedLockAssetPath(p.package, p.version);
      const relLockPath = path.relative(assetsRoot, absLockPath).split(path.sep).join("/");
      return path.posix.join("assets", relLockPath);
    });
}

// Pure diff against npm's OWN `npm pack --dry-run --json` file list (`files[].path`, paths relative to
// the package root) — the actual packed contents, not an assumption about what "should" be there.
export function missingPackedPaths(requiredPaths, packedPaths) {
  const packedSet = new Set(packedPaths);
  return requiredPaths.filter((p) => !packedSet.has(p));
}

// @decision 884c8d56 — never ship @loom/shared via bundledDependencies again: npm global installs
// (npm/cli#7355) fail to skip a transitive OS-restricted optional dep (e.g. fsevents) whenever
// bundledDependencies is present at all. Vendor dist/ outside node_modules; resolve via `imports` instead.
export const SHARED_IMPORT_SPECIFIER = 'from "@loom/shared"';
export const SHARED_IMPORT_REWRITE = 'from "#loom-shared"';

// The REWRITE stays narrow (only the exact `from "@loom/shared"` form tsc ever emits for a value
// import/re-export) — deliberately NOT a bare substring match on `@loom/shared` anywhere, which would
// also catch unrelated quoted data (e.g. deploy-packages.js's own `{ name: "@loom/shared", ... }`
// restart-mapping entry) and prose mentions inside comments, neither of which is a module specifier to
// rewrite. The post-rewrite SURVIVOR CHECK below is deliberately WIDER than the rewrite: it must catch
// every specifier FORM a surviving reference could take (not just the one tsc happens to emit today),
// so a future TS output shape, a hand-written dynamic `import(...)`, or a `require(...)` doesn't silently
// slip past as an unresolvable runtime reference to a package that no longer exists in the tarball.
function jsFilesContaining(distDir, needle) {
  const hits = [];
  for (const rel of fs.readdirSync(distDir, { recursive: true })) {
    if (!rel.endsWith(".js")) continue;
    const abs = path.join(distDir, rel);
    const text = fs.readFileSync(abs, "utf8");
    if (text.includes(needle)) hits.push(rel.split(path.sep).join("/"));
  }
  return hits.sort();
}

// Same corpus walk as jsFilesContaining(), but matched against a REGEX rather than a literal substring —
// used by the widened survivor check below. Restricted to `.js` files only (same as jsFilesContaining):
// the shipped `.d.ts` files also carry the `from "@loom/shared"` form (tsc never rewrites type-only
// imports, and this build doesn't either), but they are type-only declarations with no runtime import
// resolution — a surviving reference there is harmless and deliberately NOT scanned for.
function jsFilesMatching(distDir, re) {
  const hits = [];
  for (const rel of fs.readdirSync(distDir, { recursive: true })) {
    if (!rel.endsWith(".js")) continue;
    const abs = path.join(distDir, rel);
    const text = fs.readFileSync(abs, "utf8");
    if (re.test(text)) hits.push(rel.split(path.sep).join("/"));
  }
  return hits.sort();
}

// Rewrites every `from "@loom/shared"` import specifier in the staged `distDir` to `from "#loom-shared"`
// (the package.json `imports` map entry pointing at the vendored copy) and returns the list of files it
// changed. Pure except for the file writes it's explicitly meant to perform — safe to call once, on a
// fully-copied staging dist.
export function rewriteSharedSpecifiers(distDir) {
  const files = jsFilesContaining(distDir, SHARED_IMPORT_SPECIFIER);
  for (const rel of files) {
    const abs = path.join(distDir, rel);
    const text = fs.readFileSync(abs, "utf8");
    fs.writeFileSync(abs, text.split(SHARED_IMPORT_SPECIFIER).join(SHARED_IMPORT_REWRITE));
  }
  return files;
}

// Post-rewrite assertion, WIDENED (Code Review round, card 884c8d56) to catch a surviving reference to
// the un-vendored `@loom/shared` specifier in any of the forms actually listed below — NOT "regardless of
// its syntactic form" (a prior version of this comment overclaimed that): a `from "..."` import/
// re-export, a bare `import "..."` side-effect import, a dynamic `import("...")`, or a `require("...")`
// — either quote style, and a subpath (`@loom/shared/foo`). Known misses, not covered: a template-literal
// (backtick) specifier (`` import(`@loom/shared`) ``), `require (` with whitespace before the paren, and
// a `.resolve(...)` form (`require.resolve("@loom/shared")`, `import.meta.resolve("@loom/shared")`). It
// must NOT match deploy-packages.js's own `{ name: "@loom/shared", ... }` data string (no
// `from`/`import`/`require(` precedes the quoted name) or a bare prose mention inside a comment (no
// surrounding quotes at all) — both are asserted against in
// packages/daemon/test/build-npm-package-shared-vendor.mjs. Used to FAIL the build loudly if the
// (narrow) rewrite above missed a form it doesn't cover, rather than silently shipping a tarball that
// still needs the registry/node_modules to resolve `@loom/shared` at runtime.
export const SHARED_SPECIFIER_SURVIVOR_RE =
  /(?:from|import)\s*\(?\s*["']@loom\/shared(?:\/[^"']*)?["']|require\(\s*["']@loom\/shared/;

export function survivingSharedImportSpecifiers(distDir) {
  return jsFilesMatching(distDir, SHARED_SPECIFIER_SURVIVOR_RE);
}

// Pure check (Code Review round 2, card 884c8d56) — which of npm's two recognized spellings,
// `bundledDependencies` and its alias `bundleDependencies`, are present on a package.json object,
// regardless of array length (an empty array still counts: the upstream trigger, npm/cli#7355, is the
// field's mere PRESENCE, not how many packages it names or whether the array is empty). Extracted as its
// own exported function so packages/daemon/test/build-npm-package-shared-vendor.mjs can assert it
// directly against fixture objects, rather than only indirectly through the isMain block's on-disk
// re-read below.
export function forbiddenBundledKeys(pkgJson) {
  return ["bundledDependencies", "bundleDependencies"].filter((k) => k in pkgJson);
}

// Everything below is the actual packaging side effects (build/verify/stage/pack) — guarded so this
// module can be IMPORTED (for PACKAGED_ROOTS above) without running any of it. Only fires when this
// file is executed directly (`node scripts/build-npm-package.mjs`), never on import.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {

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

// Same contract as run() but CAPTURES stdout instead of inheriting it — needed for `npm pack --dry-run
// --json`, whose stdout IS the result this script parses (stderr still surfaces to the real console).
function runCapture(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { shell: process.platform === "win32", cwd: repoRoot, encoding: "utf8", ...opts });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`[pack:npm] command failed (exit ${r.status}): ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

// 1. Build the workspace (shared → daemon → web) unless told to skip.
if (!noBuild) { log("building workspace (pnpm build) …"); run("pnpm", ["build"]); }

// card 66ab2bc0 n3: the first committed npm-pinned lock asset found (two levels under
// assets/npm-pinned-locks/<package>/<version>/package-lock.json) — a representative sentinel for the
// required-files check below, so a packaging drop under that tree is caught here rather than only once an
// end user's daemon tries to provision a pinned npm capability and fails closed. Scans rather than
// hardcoding one package/version pair, which would duplicate (and drift against) seed.ts's own
// MCP_IMAGENATE_VERSION/SHADCN_VERSION constants. Returns a path that deliberately never exists when none
// is found, so the existsSync check below fails exactly like any other missing required file.
function firstNpmPinnedLockAsset(locksRoot) {
  try {
    for (const pkg of fs.readdirSync(locksRoot)) {
      const pkgDir = path.join(locksRoot, pkg);
      if (!fs.statSync(pkgDir).isDirectory()) continue;
      for (const version of fs.readdirSync(pkgDir)) {
        const lockPath = path.join(pkgDir, version, "package-lock.json");
        if (fs.existsSync(lockPath)) return lockPath;
      }
    }
  } catch { /* fall through to the never-exists sentinel below */ }
  return path.join(locksRoot, "<none-found>", "package-lock.json");
}

// 2. Verify the built inputs exist.
const { daemonDist, webDist, sharedDist, daemonAssets } = PACKAGED_ROOTS;
for (const [label, p] of [
  ["daemon dist", path.join(daemonDist, "index.js")],
  ["web dist", path.join(webDist, "index.html")],
  ["shared dist", path.join(sharedDist, "index.js")],
  ["daemon assets", path.join(daemonAssets, "hook-relay.mjs")],
  ["daemon assets (npm-pinned lock)", firstNpmPinnedLockAsset(path.join(daemonAssets, "npm-pinned-locks"))],
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

// 2c. Refuse to ship a stray dist-patch TEST SHIM (card 01d30507) — same loud-refusal posture as the
// orphaned-web-bundle guard above (2b), not a silent exclude: a stray test-patch file reaching a
// published tarball is a real, if rare, defect worth stopping the release for rather than quietly
// stripping and risking nobody ever noticing the underlying cleanup failure that produced it.
{
  const strays = findStrayDistShims(daemonDist);
  if (strays.length > 0) {
    console.error(
      `[pack:npm] refusing to package ${daemonDist} — found stray dist-patch test shim file(s): ` +
        `${strays.join(", ")}. These come from a graceful-teardown-hard-exit-backstop.mjs run that did ` +
        "not clean up after itself (see card 01d30507) — delete them, confirm the test still passes " +
        "cleanly, then rebuild (`pnpm --filter @loom/daemon build`) before packaging again.",
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

log("vendor @loom/shared → vendor/loom-shared/dist/ (never node_modules, per the decision above)");
const vendorSharedDist = path.join(stage, "vendor", "loom-shared", "dist");
fs.mkdirSync(vendorSharedDist, { recursive: true });
fs.cpSync(sharedDist, vendorSharedDist, { recursive: true });

log("rewrite \"@loom/shared\" import specifiers → \"#loom-shared\" in the staged dist/");
const rewrittenFiles = rewriteSharedSpecifiers(path.join(stage, "dist"));
log(`rewrote ${rewrittenFiles.length} file(s)`);

log("copy bin/ + README.md + LICENSE");
fs.cpSync(path.join(repoRoot, "bin"), path.join(stage, "bin"), { recursive: true });
if (fs.existsSync(path.join(repoRoot, "README.md"))) {
  fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(stage, "README.md"));
}
if (fs.existsSync(path.join(repoRoot, "LICENSE"))) {
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(stage, "LICENSE"));
}

// 5. Generate the published package.json. @loom/shared is VENDORED (step above) and resolved via the
//    `imports` map below — it is NOT a dependency of any kind (no entry in `dependencies`, and
//    `bundledDependencies` is never set — see the decision note near rewriteSharedSpecifiers above).
//    Every other daemon dependency stays a real registry dep so `npm i` fetches it (incl. the native
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
  files: ["bin", "dist", "assets", "vendor", "README.md", "LICENSE"],
  dependencies: deps,
  imports: { "#loom-shared": "./vendor/loom-shared/dist/index.js" },
};
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
log(`wrote staging package.json (loomctl@${pkg.version})`);

// 5a. Refuse to ship if the rewrite above missed a specifier, or if bundledDependencies crept back in
// (card 884c8d56 — this is the mechanical backstop for the @decision note above, not advisory: a
// surviving "@loom/shared" specifier would try to resolve against the registry/node_modules at runtime
// and crash, and a reintroduced bundledDependencies reopens the exact npm/cli#7355 install failure).
{
  const surviving = survivingSharedImportSpecifiers(path.join(stage, "dist"));
  if (surviving.length > 0) {
    console.error(
      `[pack:npm] refusing to package — ${surviving.length} staged file(s) still import "@loom/shared" ` +
        `after the rewrite: ${surviving.join(", ")}. Fix rewriteSharedSpecifiers() rather than shipping a ` +
        "tarball that needs a registry/node_modules copy of @loom/shared at runtime.",
    );
    process.exit(1);
  }
  // Re-read the package.json ACTUALLY WRITTEN to disk (Code Review round, card 884c8d56) — the
  // in-memory `pkg` literal above never sets either key anywhere, so checking it directly (as a prior
  // round of this fix did) could never fire even if a future edit reintroduced the field. forbiddenBundledKeys()
  // (defined above) checks BOTH spellings npm recognizes — `bundledDependencies` and its alias
  // `bundleDependencies` — and flags mere PRESENCE of either key, regardless of array length: the
  // upstream trigger (npm/cli#7355) is the field's presence, not how many packages it names or whether
  // the array is empty.
  const writtenPkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
  const bundledKeys = forbiddenBundledKeys(writtenPkg);
  if (bundledKeys.length > 0) {
    console.error(
      `[pack:npm] refusing to package — the generated package.json (re-read from disk) carries ` +
        `${bundledKeys.join(" / ")} (${JSON.stringify(bundledKeys.map((k) => writtenPkg[k]))}). This is ` +
        "forbidden (card 884c8d56, npm/cli#7355) — vendor the dependency outside node_modules and resolve " +
        "it via the `imports` map instead.",
    );
    process.exit(1);
  }
  log(`verified no "@loom/shared" specifiers survive and bundledDependencies is unset`);
}

// 5b. Verify every seeded npm-pinned row's committed lock asset survives npm's OWN pack logic against
// the ACTUAL packed contents (card 1ebbf523 — see docs/decisions/1ebbf523-npm-pinned-lock-pack-assertion.md),
// not just the source assets dir step 2's firstNpmPinnedLockAsset() already checked. `npm pack --dry-run
// --json` never touches the network and never writes a tarball — safe to run on every invocation,
// including --no-pack.
{
  const dryRunOut = runCapture("npm", ["pack", "--dry-run", "--json"], { cwd: stage });
  let packResult;
  try {
    packResult = JSON.parse(dryRunOut)[0];
  } catch (e) {
    console.error(`[pack:npm] could not parse \`npm pack --dry-run --json\` output: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const packedPaths = (packResult?.files ?? []).map((f) => f.path);
  const required = await requiredNpmPinnedLockPackedPaths(daemonDist);
  if (required.length === 0) {
    console.error("[pack:npm] derived ZERO required npm-pinned lock paths from bundledCapabilities() — this " +
      "likely means the seed import failed silently; refusing rather than passing a vacuous check.");
    process.exit(1);
  }
  const missing = missingPackedPaths(required, packedPaths);
  if (missing.length > 0) {
    console.error(
      `[pack:npm] refusing to package — npm's own packed file list is MISSING the committed npm-pinned ` +
        `lock asset(s) for: ${missing.join(", ")}. These exist in the staged assets dir but npm's own \`npm ` +
        `pack\` file-inclusion logic dropped them — a fresh install of the affected row(s) would fail closed ` +
        `(lock-missing) on every real end-user host. Required set derived from bundledCapabilities() ` +
        `(dist/capabilities/seed.js) + npmPinnedLockAssetPath() (dist/capabilities/npm-pinned.js).`,
    );
    process.exit(1);
  }
  log(`verified ${required.length} npm-pinned lock asset(s) survive npm pack: ${required.join(", ")}`);
}

// 6. npm pack → tarball at the repo root (unless --no-pack).
if (noPack) {
  log(`staged at ${stage} (skipped npm pack)`);
} else {
  log("npm pack …");
  run("npm", ["pack", "--pack-destination", repoRoot], { cwd: stage });
  log(`done → ${path.join(repoRoot, `loomctl-${pkg.version}.tgz`)}`);
}

} // isMain
