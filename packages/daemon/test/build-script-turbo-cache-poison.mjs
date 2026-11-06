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
import { execFileSync, execSync } from "node:child_process";
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
  w(path.join(main, "turbo.json"), JSON.stringify({ tasks: { build: { outputs: ["dist/**", "!dist/build-info.json"] } } }));
  // The real build scripts call ../../scripts/prune-orphan-dist.mjs relative to the package dir: ship the REAL one.
  fs.mkdirSync(path.join(main, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "prune-orphan-dist.mjs"), path.join(main, "scripts", "prune-orphan-dist.mjs"));
  w(path.join(main, ".gitignore"), "dist/\n*.tsbuildinfo\nnode_modules/\n.turbo/\n");
  w(path.join(pkgDir, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", scripts: { build: fixtureBuildScript(realScript) } }));
  w(path.join(pkgDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, composite: true, declaration: true, declarationMap: true, sourceMap: true, outDir: "dist", rootDir: "src" }, include: ["src"] }));
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

  // ORPHANS (card 2b6d469c): a RENAMED source's old output and a hand-ADDED file must not survive a build nor be
  // replayed. build-info.json (written by the uncached `stamp`, not by tsc) must survive direct + turbo builds.
  const dd = (cwd) => path.join(cwd, "packages", "a", "dist");
  const ex = (cwd, rel) => fs.existsSync(path.join(dd(cwd), rel));
  const STAMP = '{"sha":"seeded"}';
  const stamp = (cwd) => fs.writeFileSync(path.join(dd(cwd), "build-info.json"), STAMP);
  const stampKept = (cwd) => ex(cwd, "build-info.json") && fs.readFileSync(path.join(dd(cwd), "build-info.json"), "utf8") === STAMP;
  const direct = (cwd) => execSync(JSON.parse(fs.readFileSync(path.join(cwd, "packages", "a", "package.json"), "utf8")).scripts.build, { cwd: path.join(cwd, "packages", "a"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  const OTHER = ["other.js", "other.d.ts", "other.js.map", "other.d.ts.map"];
  stamp(main);
  direct(main);
  check(`${label}: build-info.json survives a DIRECT build`, stampKept(main));
  check(`${label}: [control] other.* emitted before the rename`, OTHER.every((f) => ex(main, f)));
  fs.mkdirSync(path.join(dd(main), "gone"), { recursive: true });
  fs.writeFileSync(path.join(dd(main), "handadded.js"), "export {};\n");
  fs.writeFileSync(path.join(dd(main), "gone", "nested.d.ts"), "export {};\n");
  fs.writeFileSync(path.join(dd(main), "notes.txt"), "not tsc output\n");
  run("git", ["mv", "packages/a/src/other.ts", "packages/a/src/renamed.ts"], main);
  commitAll(main, ["rename other -> renamed"]);
  turbo(main);
  check(`${label}: the renamed source's old outputs (.js/.d.ts/.maps) are gone`, OTHER.every((f) => !ex(main, f)), OTHER.filter((f) => ex(main, f)).join(","));
  check(`${label}: a hand-added dist file (and an orphaned nested dir) is gone`, !ex(main, "handadded.js") && !ex(main, path.join("gone", "nested.d.ts")) && !ex(main, "gone"));
  check(`${label}: a non-tsc file (notes.txt) is never touched`, ex(main, "notes.txt"));
  check(`${label}: the renamed source IS emitted`, ex(main, "renamed.js"));
  check(`${label}: build-info.json survives a TURBO build`, stampKept(main));
  const review2 = path.join(root, "review2");
  run("git", ["worktree", "add", "-q", review2, "HEAD"], main);
  turbo(review2); // a cache HIT on main's stored entry: it must not carry an orphan
  check(`${label}: a fresh worktree's turbo build does not replay the orphans`, OTHER.every((f) => !ex(review2, f)) && !ex(review2, "handadded.js"), OTHER.filter((f) => ex(review2, f)).join(","));
  check(`${label}: [control] the fresh worktree really got dist from the cache`, ex(review2, "renamed.js"));
}

// The prune script itself: never follows/deletes through a symlink or junction, never leaves <pkg>/dist, and
// deletes nothing when src/ is missing.
function pruneSafety() {
  const pruneScript = path.join(repoRoot, "scripts", "prune-orphan-dist.mjs");
  const root = mkdtempManaged("bsp-prune-");
  const pkg = path.join(root, "pkg");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(pkg, "src", "keep.ts"), "export {};\n");
  fs.writeFileSync(path.join(pkg, "dist", "keep.js"), "");
  fs.writeFileSync(path.join(pkg, "dist", "orphan.js"), "");
  fs.writeFileSync(path.join(pkg, "dist", "build-info.json"), "{}");
  fs.writeFileSync(path.join(outside, "victim.js"), "outside the dist");
  fs.symlinkSync(outside, path.join(pkg, "dist", "link"), "junction");
  // .mjs/.cjs outputs: each needs its OWN src kind (.mts / .cts), not just any same-named .ts. Files are
  // pre-placed (no tsc emit needed), so the fixture tsconfig is unchanged.
  const put = (rel, s = "") => { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), s); };
  put("src/bar.mts", "export {};\n"); put("src/car.cts", "export {};\n"); put("src/baz.ts", "export {};\n"); put("src/qux.mts", "export {};\n");
  const MJS_KEEP = ["dist/bar.mjs", "dist/bar.mjs.map", "dist/bar.d.mts", "dist/bar.d.mts.map", "dist/car.cjs", "dist/car.cjs.map", "dist/car.d.cts", "dist/car.d.cts.map"];
  const MJS_GONE = ["dist/foo.mjs", "dist/foo.mjs.map", "dist/foo.d.mts", "dist/foo.d.mts.map", "dist/foo.cjs", "dist/foo.d.cts", "dist/baz.mjs", "dist/qux.js", "dist/data.json", "dist/note.txt"];
  for (const f of [...MJS_KEEP, ...MJS_GONE]) put(f);
  const out = run(process.execPath, [pruneScript, pkg], root, {});
  check("prune: .mjs/.cjs/.d.mts/.d.cts outputs WITH their own .mts/.cts source survive", MJS_KEEP.every((f) => fs.existsSync(path.join(pkg, f))));
  check("prune: source-less .mjs/.cjs outputs, and ones whose only same-named source is the WRONG kind (baz.mjs vs baz.ts, qux.js vs qux.mts), are pruned",
    ["dist/foo.mjs", "dist/foo.mjs.map", "dist/foo.d.mts", "dist/foo.d.mts.map", "dist/foo.cjs", "dist/foo.d.cts", "dist/baz.mjs", "dist/qux.js"].every((f) => !fs.existsSync(path.join(pkg, f))));
  check("prune: .json and .txt files are never touched", fs.existsSync(path.join(pkg, "dist/data.json")) && fs.existsSync(path.join(pkg, "dist/note.txt")));
  check("prune: deletes the orphan, keeps a sourced file and build-info.json", !fs.existsSync(path.join(pkg, "dist", "orphan.js")) && fs.existsSync(path.join(pkg, "dist", "keep.js")) && fs.existsSync(path.join(pkg, "dist", "build-info.json")));
  check("prune: never deletes through a junction/symlink pointing outside dist", fs.existsSync(path.join(outside, "victim.js")));
  check("prune: the junction itself is left in place", fs.lstatSync(path.join(pkg, "dist", "link")).isSymbolicLink());
  check("prune: prints one summary line plus the pruned path", /\d+ files pruned/.test(out) && /- dist\/orphan\.js/.test(out), out);
  const noSrc = path.join(root, "nosrc");
  fs.mkdirSync(path.join(noSrc, "dist"), { recursive: true });
  fs.writeFileSync(path.join(noSrc, "dist", "a.js"), "");
  run(process.execPath, [pruneScript, noSrc], root, {});
  check("prune: fail-safe — a missing src/ deletes nothing", fs.existsSync(path.join(noSrc, "dist", "a.js")));
}

try {
  for (const [label, pkg] of [["daemon", "daemon"], ["shared", "shared"]]) {
    const pj = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", pkg, "package.json"), "utf8"));
    scenario(label, pj.scripts.build);
  }
  pruneSafety();
} catch (e) {
  failures++;
  console.log(`FAIL scenario threw: ${e && e.stack ? e.stack : e}`);
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
await finishAndExit(failures === 0 ? 0 : 1);
