// @decision 0d87afda — never drop the build scripts' tsbuildinfo clearing: without it a hand-mutated dist
// is captured by turbo's cache and replayed into fresh worktrees and gates.
// A hand-mutated `dist/` must never reach another checkout through turbo's shared build cache.
//
// MECHANISM (the incident this pins): turbo keys a package's `build` on its git-tracked inputs only. `dist/`
// and `tsconfig.tsbuildinfo` are gitignored, so neither is in the key, and only `dist/**` is stored as output.
// If `dist/` holds a hand-edited file while `tsconfig.tsbuildinfo` is current and ANY src file then changes
// (a new key => cache MISS), an incremental `tsc` re-emits only the changed file, SKIPS the mutated one, and
// turbo stores the mutant `dist/**` under that key. Any fresh worktree on the same tree computes the same
// key and replays the mutant on its first `build`.
//
// WHAT THIS RUNS: the REAL `scripts.build` of `@loom/daemon` and `@loom/shared` (read from their own
// package.json, so a regression of those exact scripts goes red), transplanted into a throwaway npm-workspace
// repo, driven by REAL turbo with its OWN cache dir (TURBO_CACHE_DIR under a temp dir — the real shared
// `.turbo/cache` is never read or written). Derivation of the fixture script from the real one: `tsc` is
// pointed at the installed typescript's absolute path and the `sync-claude-skills` segment is dropped; the
// tsbuildinfo-clearing segment is kept verbatim, which is the thing under test.
//
// COVERS: the clean-emit property of the build script under a real turbo cache round trip.
// DOES NOT COVER: turbo's behaviour on the real repo's pnpm lockfile / the real task graph, or any entry
// that was ALREADY poisoned in a real cache (those become unreachable only because the package.json edit
// changes the package's hash — the 0d87afda decision record).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, "..");
const repoRoot = path.resolve(daemonDir, "..", "..");
const req = createRequire(path.join(repoRoot, "package.json"));
const tscBin = req.resolve("typescript/bin/tsc");
const turboBin = req.resolve("turbo/bin/turbo");
const fwd = (p) => p.replace(/\\/g, "/");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const GUARD = 'return "guard";';

function fixtureBuildScript(realScript) {
  // Keep every segment before `tsc` verbatim; swap the tsc call for an absolute one; drop the skills sync.
  const segs = realScript.split("&&").map((s) => s.trim());
  const tscIdx = segs.findIndex((s) => /^tsc\s/.test(s));
  if (tscIdx < 0) throw new Error(`no 'tsc ...' segment in build script: ${realScript}`);
  const out = segs.filter((s) => !s.includes("sync-claude-skills"));
  const i = out.findIndex((s) => /^tsc\s/.test(s));
  out[i] = out[i].replace(/^tsc\s/, `node "${fwd(tscBin)}" `);
  return out.join(" && ");
}

function run(cmd, args, cwd, env) {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

function scenario(label, realScript) {
  const root = mkdtempManaged(`bsp-${label}-`);
  const cacheDir = mkdtempManaged(`bsp-cache-${label}-`);
  const main = path.join(root, "main");
  const pkgDir = path.join(main, "packages", "a");
  fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
  const w = (p, s) => fs.writeFileSync(p, s);
  w(path.join(main, "package.json"), JSON.stringify({ name: "fx", private: true, packageManager: "npm@10.9.0", workspaces: ["packages/*"] }));
  w(path.join(main, "package-lock.json"), JSON.stringify({ name: "fx", lockfileVersion: 3, requires: true, packages: { "": { name: "fx", workspaces: ["packages/*"] }, "packages/a": { name: "a", version: "1.0.0" } } }));
  w(path.join(main, "turbo.json"), JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }));
  w(path.join(main, ".gitignore"), "dist/\n*.tsbuildinfo\nnode_modules/\n.turbo/\n");
  w(path.join(pkgDir, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", scripts: { build: fixtureBuildScript(realScript) } }));
  w(path.join(pkgDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, composite: true, outDir: "dist", rootDir: "src" }, include: ["src"] }));
  w(path.join(pkgDir, "src", "server.ts"), 'export const server = (n: number) => { if (n > 5) return "guard"; return "ok"; };\n');
  w(path.join(pkgDir, "src", "other.ts"), "export const other = 1;\n");
  run("git", ["init", "-q"], main);
  run("git", ["config", "user.email", "t@t"], main);
  run("git", ["config", "user.name", "t"], main);
  commitAll(main, ["base"]);

  const env = { TURBO_CACHE_DIR: cacheDir, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1", CI: "1" };
  const turbo = (cwd) => run(process.execPath, [turboBin, "build"], cwd, env);
  const dist = (cwd) => path.join(cwd, "packages", "a", "dist", "server.js");
  const hasGuard = (cwd) => fs.readFileSync(dist(cwd), "utf8").includes(GUARD);

  turbo(main); // base build: populates a good dist + a CURRENT tsbuildinfo
  check(`${label}: base turbo build emits the guard`, hasGuard(main));
  check(`${label}: turbo used the temp TURBO_CACHE_DIR, not a default location`, fs.readdirSync(cacheDir).length > 0, `cacheDir empty: ${cacheDir}`);

  // Hand-mutate dist (what the incident's worker did), then change src => new key => cache MISS.
  fs.writeFileSync(dist(main), fs.readFileSync(dist(main), "utf8").replace(GUARD, ""));
  check(`${label}: [control] the dist mutation actually removed the guard`, !hasGuard(main));
  fs.writeFileSync(path.join(pkgDir, "src", "other.ts"), "export const other = 2;\n");
  commitAll(main, ["src change"]);
  turbo(main);
  check(`${label}: a turbo build that misses on a new key leaves no hand-mutated dist behind`, hasGuard(main));

  // A fresh worktree on the SAME tree computes the same key; it must not replay a mutant.
  const review = path.join(root, "review");
  run("git", ["worktree", "add", "-q", review, "HEAD"], main);
  turbo(review);
  check(`${label}: a fresh worktree's first turbo build does not replay a mutant`, hasGuard(review));
}

try {
  for (const [label, pkg] of [["daemon", "daemon"], ["shared", "shared"]]) {
    const pj = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", pkg, "package.json"), "utf8"));
    scenario(label, pj.scripts.build);
  }
} catch (e) {
  failures++;
  console.log(`FAIL scenario threw: ${e && e.stack ? e.stack : e}`);
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
await finishAndExit(failures === 0 ? 0 : 1);
