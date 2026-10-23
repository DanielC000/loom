import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7ebb4acf — `info/grafts` and `.git/shallow` are worker-writable (shared `.git`, 356538ef's own
// threat model) and can skew the daemon's own canonical-path parent/ancestry reads, the same class of
// defect 356538ef already closed for replace refs. Verified in a real scratch repo (git 2.47.0.windows.2):
//   - a graft can SUBSTITUTE a commit's reported parent list (card's own "F P" example);
//   - a `.git/shallow` boundary can HIDE a commit's parents entirely (reports zero).
// Both are neutralized by GIT_GRAFT_FILE/GIT_SHALLOW_FILE pointed at a fresh, nonexistent, absolute path
// (`freshGitSentinelPath`, git/bounded.ts) applied unconditionally in `prepareCanonicalEnv`, so every
// canonical-path reader built on `canonicalGit` picks it up automatically.
//   (G1) readFirstParent (git/mainline-watch.ts) under a graft that substitutes a FAKE first parent.
//   (G2) isAncestorCommit (git/mainline-watch.ts, merge-base) under the SAME graft.
//   (G3) verifyReviewedTipChain (git/worktrees.ts, rev-list --parents) under the SAME graft.
//   (S1)-(S3) the same three, under `.git/shallow` instead (hides ALL parents, not just one).
//   (C1r)/(C2r)/(C1)/(C2)/(C3) a hand-forged commit-graph (re-review 11cd4e3e / SF2): querying the forged
//       commit F DIRECTLY is immune (C1r/C2r); WALKING PAST it from a descendant G is NOT (C1 is the raw
//       negative control proving the skew is real; C2/C3 prove canonicalGit's `-c core.commitGraph=false`
//       closes it). See docs/decisions/356538ef-*.md item 9.
//   (N3) ambient GIT_TEST_COMMIT_GRAPH overrides `-c core.commitGraph=false` unless stripped — see item 10.
//   (P) the two sentinel env vars are a) absolute, b) differ between two separate `canonicalGit(...)`
//       constructions, c) never the literal "NUL".
// RED/GREEN proof (not run automatically by this file): revert git/bounded.ts's `prepareCanonicalEnv`
// (see docs/decisions/356538ef-canonical-git-isolation.md), rebuild, re-run — (G1)-(G3)/(S1)-(S3) go RED;
// restore, rebuild, re-run — GREEN again. `pnpm --filter @loom/daemon negative-control --help` scripts
// this exact revert/build/test/restore/rebuild/retest cycle in one call.
// Run: 1) build daemon (pnpm build), 2) node test/canonical-git-graft-shallow-neutralization.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-graft-shallow-home-");

/**
 * Minimal commit-graph v1 CDAT-chunk reader/writer (card 7ebb4acf, Code Review B1) — enough to locate one
 * commit's `parent2` field and flip it to `GRAPH_PARENT_NONE` (0x70000000 — MEASURED against this real,
 * installed git 2.47.0.windows.2 by comparing a genuine single-parent commit's own CDAT entry; this is
 * NOT 0xffffffff/0x7fffffff as commit-graph docs recalled from memory might suggest).
 */
function readChunkTable(buf) {
  const numChunks = buf[6];
  const chunks = [];
  let off = 8;
  for (let i = 0; i <= numChunks; i++) {
    chunks.push({ id: buf.subarray(off, off + 4).toString("ascii"), off: Number(buf.readBigUInt64BE(off + 4)) });
    off += 12;
  }
  return chunks;
}
function findCommitEntryOffset(buf, targetHexLower) {
  const chunks = readChunkTable(buf);
  const oidf = chunks.find((c) => c.id === "OIDF");
  const oidl = chunks.find((c) => c.id === "OIDL");
  const cdat = chunks.find((c) => c.id === "CDAT");
  const hashLen = 20;
  const numCommits = buf.readUInt32BE(oidf.off + 255 * 4);
  for (let i = 0; i < numCommits; i++) {
    const hex = buf.subarray(oidl.off + i * hashLen, oidl.off + i * hashLen + hashLen).toString("hex");
    if (hex === targetHexLower) return cdat.off + i * (hashLen + 16);
  }
  return -1;
}
const GRAPH_PARENT_NONE = 0x70000000;
/** Forges `sha`'s SECOND parent to GRAPH_PARENT_NONE in the on-disk commit-graph at `repo`, in place. */
function forgeCommitGraphHideSecondParent(repo, sha) {
  const graphPath = path.join(repo, ".git", "objects", "info", "commit-graph");
  fs.chmodSync(graphPath, 0o644);
  const buf = fs.readFileSync(graphPath);
  const entryOff = findCommitEntryOffset(buf, sha.toLowerCase());
  if (entryOff < 0) throw new Error(`forgeCommitGraphHideSecondParent: ${sha} not found in commit-graph`);
  const p2Off = entryOff + 20 + 4;
  buf.writeUInt32BE(GRAPH_PARENT_NONE, p2Off);
  fs.writeFileSync(graphPath, buf);
}

const MW = await import("../dist/git/mainline-watch.js");
const WT = await import("../dist/git/worktrees.js");
const BOUNDED = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const IDENT = { GIT_AUTHOR_NAME: "gsn", GIT_AUTHOR_EMAIL: "gsn@loom", GIT_COMMITTER_NAME: "gsn", GIT_COMMITTER_EMAIL: "gsn@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const TIMEOUT_MS = 15_000;

const repo = path.join(os.tmpdir(), `loom-gsn-${sfx}`);
fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
fs.writeFileSync(path.join(repo, "README.md"), "# gsn\n");
git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "gsn@loom"); git(repo, "config", "user.name", "gsn");
commitAll(repo, "init", "");
const ROOT = git(repo, "rev-parse", "HEAD");

// Two genuinely divergent lines off ROOT, so `M` is NOT an ancestor of `P` and vice versa. Each line is
// now TWO commits deep (ROOT→M0→M, ROOT→P0→P, re-review 11cd4e3e / SF2) — the extra hop (`M0`) is what
// lets the rebuilt (C) block below ask about an ancestor FURTHER BACK than F's own forged parent.
fs.writeFileSync(path.join(repo, "m0.txt"), "m0\n"); commitAll(repo, "chore(x): main-line base commit", "");
const M0 = git(repo, "rev-parse", "HEAD");
fs.writeFileSync(path.join(repo, "m.txt"), "m\n"); commitAll(repo, "chore(x): main-line commit", "");
const M = git(repo, "rev-parse", "HEAD"); // "main" tip
git(repo, "checkout", "-q", ROOT);
fs.writeFileSync(path.join(repo, "p0.txt"), "p0\n"); commitAll(repo, "chore(x): side-line base commit", "");
const P0 = git(repo, "rev-parse", "HEAD");
fs.writeFileSync(path.join(repo, "p.txt"), "p\n"); commitAll(repo, "chore(x): side-line commit", "");
const P = git(repo, "rev-parse", "HEAD"); // the branch's own "reviewed" tip
git(repo, "checkout", "-q", M); // leave HEAD somewhere real so later ops aren't on a detached oddity

// A REAL two-parent merge commit F = merge(P as first parent, M as second parent) — an actual clean
// union, so (G3)/(S3)'s own merge-tree/tree-equality check passes once the parent count is read correctly.
const unionTree = git(repo, "merge-tree", "--write-tree", P, M).split(/\r?\n/)[0];
check("(setup) merge-tree of P and M produced a single clean tree oid (no conflict)", /^[0-9a-f]{40,64}$/.test(unionTree));
const F = git(repo, "commit-tree", unionTree, "-p", P, "-p", M, "-m", "forged two-parent commit F");
check("(setup) F's real first parent is P, second is M (git cat-file -p)", (() => {
  const body = git(repo, "cat-file", "-p", F);
  return body.includes(`parent ${P}`) && body.includes(`parent ${M}`);
})());

// ── baseline (no graft/shallow planted yet) — sanity that the real history reads correctly at all ──
check("(baseline) readFirstParent(F) === P", await MW.readFirstParent(repo, F, TIMEOUT_MS) === P);
check("(baseline) isAncestorCommit(M, F) === true (M is F's real 2nd parent)", await MW.isAncestorCommit(repo, M, F, TIMEOUT_MS) === true);
const baselineChain = await WT.verifyReviewedTipChain(repo, P, F);
check(`(baseline) verifyReviewedTipChain(reviewed=P, live=F) === ok (got ${JSON.stringify(baselineChain)})`, baselineChain.ok === true);

// ── (G) info/grafts: substitute F's parent list with a SINGLE fake parent (ROOT) ──
const graftsPath = path.join(repo, ".git", "info", "grafts");
fs.writeFileSync(graftsPath, `${F} ${ROOT}\n`);
try {
  check("(G1) readFirstParent(F) reads the REAL parent P, not the graft's fake ROOT", await MW.readFirstParent(repo, F, TIMEOUT_MS) === P);
  check("(G2) isAncestorCommit(M, F) is still TRUE (not defeated by the graft hiding M)", await MW.isAncestorCommit(repo, M, F, TIMEOUT_MS) === true);
  const g3 = await WT.verifyReviewedTipChain(repo, P, F);
  check(`(G3) verifyReviewedTipChain still resolves ok under the graft (got ${JSON.stringify(g3)})`, g3.ok === true);
} finally {
  fs.rmSync(graftsPath, { force: true });
}

// ── (S) .git/shallow: mark F as a shallow boundary — hides ALL of F's parents (zero, not one) ──
const shallowPath = path.join(repo, ".git", "shallow");
fs.writeFileSync(shallowPath, `${F}\n`);
try {
  check("(S1) readFirstParent(F) reads the REAL parent P, not null (shallow hides it)", await MW.readFirstParent(repo, F, TIMEOUT_MS) === P);
  let s2;
  try { s2 = await MW.isAncestorCommit(repo, M, F, TIMEOUT_MS); } catch (e) { s2 = `<threw: ${e.message}>`; }
  check(`(S2) isAncestorCommit(M, F) is still TRUE (not defeated by the shallow boundary) (got ${JSON.stringify(s2)})`, s2 === true);
  const s3 = await WT.verifyReviewedTipChain(repo, P, F);
  check(`(S3) verifyReviewedTipChain still resolves ok under the shallow boundary (got ${JSON.stringify(s3)})`, s3.ok === true);
} finally {
  fs.rmSync(shallowPath, { force: true });
}

// ── (C) a HAND-FORGED commit-graph, reached by WALKING FROM A DESCENDANT (REBUILT, Re-review 11cd4e3e /
// SF2 — the pre-review (C1)/(C2) below queried F DIRECTLY and their messages baked in a FALSE claim:
// "merge-base/isAncestorCommit did not consult the graph's cached parent array, so this was already
// correct even without the fix". That is true ONLY when F is one of the call's own two named endpoints —
// MEASURED (this file's own forged-graph fixture, git 2.47.0.windows.2) that WALKING PAST F while
// resolving something else (e.g. `merge-base M0 G` where `G` is a plain child of `F`) DOES consult the
// forged parent array: `merge-base M0 G` returns the fixture's ROOT instead of the true `M0`,
// `merge-base --is-ancestor M0 G` exits non-zero (should be 0), and `rev-list --count G` under-counts
// (5 instead of the true 7: ROOT, M0, M, P0, P, F, G). See docs/decisions/356538ef-*.md item 9 for the
// full writeup. `G` costs nothing extra to build (same tree as F, single parent). ──
const G = git(repo, "commit-tree", unionTree, "-p", F, "-m", "G: child of forged F");
check("(setup) baseline isAncestorCommit(M0, G) === true (M0 is G's real ancestor via M→F, no graph yet)", await MW.isAncestorCommit(repo, M0, G, TIMEOUT_MS) === true);
git(repo, "tag", "-f", "gsn-graph-reachable", G); // --reachable needs a ref; tagging G also makes its ancestor F reachable
git(repo, "commit-graph", "write", "--reachable");
forgeCommitGraphHideSecondParent(repo, F);
try {
  // (C1r)/(C2r) — UNCHANGED claim, correctly re-verified: resolving F DIRECTLY (as one of the call's own
  // two endpoints) really is immune in this git version, regardless of the fix.
  const c1r = await MW.readFirstParent(repo, F, TIMEOUT_MS);
  check(`(C1r) readFirstParent(F) under the forged graph (got ${c1r}) — resolving F DIRECTLY (rev-parse F^1) does not consult the graph's cached parent array in this repo; unaffected by the forgery either way`, c1r === P);
  let c2r;
  try { c2r = await MW.isAncestorCommit(repo, M, F, TIMEOUT_MS); } catch (e) { c2r = `<threw: ${e.message}>`; }
  check(`(C2r) isAncestorCommit(M, F) under the forged graph (got ${JSON.stringify(c2r)}) — merge-base(M, F) with F as a named ENDPOINT also does not consult the cached parent array; unaffected either way`, c2r === true);

  // (C1) NEGATIVE CONTROL — a RAW git call, with NO `-c core.commitGraph=false` anywhere, must be WRONG
  // here (walking from the descendant G, past the forged F), or this fixture proves nothing.
  const rawMergeBase = git(repo, "merge-base", M0, G);
  check(`(C1) RAW merge-base(M0, G) with no core.commitGraph=false is WRONG under the forged graph (got ${rawMergeBase}, truth is M0=${M0}) — negative control proving the forgery is genuinely live when walked past`, rawMergeBase !== M0);
  const rawIsAncestor = spawnSync("git", ["merge-base", "--is-ancestor", M0, G], { cwd: repo, env: { ...process.env, ...IDENT } }).status;
  check(`(C1) RAW merge-base --is-ancestor M0 G with no core.commitGraph=false exits NON-ZERO under the forged graph (got ${rawIsAncestor}) — M0 truly IS an ancestor of G, so a correct read would exit 0; negative control`, rawIsAncestor !== 0);
  const rawCount = Number(git(repo, "rev-list", "--count", G));
  check(`(C1) RAW rev-list --count G with no core.commitGraph=false UNDER-COUNTS under the forged graph (got ${rawCount}, truth is 7: ROOT,M0,M,P0,P,F,G) — negative control`, rawCount === 5);

  // (C2) THE FIX — via canonicalGit (CANONICAL_GIT_CONFIG's `-c core.commitGraph=false` on every call),
  // the SAME queries resolve correctly despite the identical forged graph still sitting on disk.
  const c2 = await MW.isAncestorCommit(repo, M0, G, TIMEOUT_MS);
  check(`(C2) isAncestorCommit(M0, G) through canonicalGit correctly reads TRUE despite the forged graph (got ${c2})`, c2 === true);
  const fixedMergeBase = (await BOUNDED.killableCanonicalRaw(repo, ["merge-base", M0, G], TIMEOUT_MS, "test(fixed merge-base under forged graph)")).trim();
  check(`(C2) merge-base(M0, G) through the canonical (killableCanonicalRaw) path correctly reads M0 despite the forged graph (got ${fixedMergeBase})`, fixedMergeBase === M0);
  const c3 = await WT.verifyReviewedTipChain(repo, P, F);
  check(`(C3) verifyReviewedTipChain under the forged graph (got ${JSON.stringify(c3)}) — THIS one IS skewed without core.commitGraph=false: rev-list --parents reads the graph's cached parent array directly and reported only P`, c3.ok === true);

  // ── (N3) ambient GIT_TEST_COMMIT_GRAPH overrides `-c core.commitGraph=false` — MUST be stripped by
  // prepareCanonicalEnv (git/bounded.ts), or the fix above is defeated from outside CANONICAL_GIT_CONFIG
  // entirely. Reuses the SAME forged-graph fixture (F/G/M0) still in scope here. ──
  {
    // (N3-neg) NEGATIVE CONTROL, bypassing prepareCanonicalEnv entirely (raw git, not canonicalGit): with
    // the env var ambiently set AND the flag passed explicitly, the answer must still be WRONG here, or
    // this isn't testing what it claims to.
    const n3raw = spawnSync("git", ["-c", "core.commitGraph=false", "merge-base", M0, G], { cwd: repo, env: { ...process.env, ...IDENT, GIT_TEST_COMMIT_GRAPH: "1" }, encoding: "utf8" }).stdout.trim();
    check(`(N3-neg) RAW git -c core.commitGraph=false merge-base M0 G with ambient GIT_TEST_COMMIT_GRAPH=1 is WRONG (got ${n3raw}, truth is M0=${M0}) — negative control proving the env var genuinely overrides the flag when nothing strips it`, n3raw !== M0);

    // (N3) THE FIX — the SAME ambient var, set on THIS process (so it is inherited by whatever canonicalGit
    // spawns), must be STRIPPED by prepareCanonicalEnv before reaching the child — the real query through
    // canonicalGit must still read correctly despite the ambient var.
    const prevGtcg = process.env.GIT_TEST_COMMIT_GRAPH;
    process.env.GIT_TEST_COMMIT_GRAPH = "1";
    try {
      const n3fixed = await MW.isAncestorCommit(repo, M0, G, TIMEOUT_MS);
      check(`(N3) isAncestorCommit(M0, G) through canonicalGit correctly reads TRUE despite ambient GIT_TEST_COMMIT_GRAPH=1 (got ${n3fixed}) — prepareCanonicalEnv stripped it before the child saw it`, n3fixed === true);
      const envSeen = BOUNDED.prepareCanonicalEnv();
      check("(N3) prepareCanonicalEnv()'s own materialized env does NOT carry GIT_TEST_COMMIT_GRAPH (case-aware strip)", !Object.keys(envSeen).some((k) => k.toUpperCase() === "GIT_TEST_COMMIT_GRAPH"));
    } finally {
      if (prevGtcg === undefined) delete process.env.GIT_TEST_COMMIT_GRAPH; else process.env.GIT_TEST_COMMIT_GRAPH = prevGtcg;
    }

    // (N3-casing) Code Review e9cbcb15, N3 — win32-only: Windows env names are case-insensitive, so an
    // ambient `Git_Test_Commit_Graph` is the SAME variable to git-for-windows and to Node's
    // `process.env.GIT_TEST_COMMIT_GRAPH` accessor, but a `{...process.env}` copy keeps the key AS
    // SPELLED — the exact casing trap `envKeysNamed`/`deleteEnvKeys` exists for (card e93703d9), now
    // checked for THIS var too, not just `GIT_CONFIG`. Mirrors canonical-git-isolation.mjs's own
    // "(GIT_CONFIG casing …)" block.
    if (process.platform !== "win32") {
      console.log("SKIP  (N3-casing) win32-only: POSIX env names are case-sensitive, so `Git_Test_Commit_Graph` is not `GIT_TEST_COMMIT_GRAPH` there");
    } else {
      for (const spelling of ["Git_Test_Commit_Graph", "git_test_commit_graph"]) {
        const prev = process.env.GIT_TEST_COMMIT_GRAPH;
        delete process.env.GIT_TEST_COMMIT_GRAPH; // drop any existing spelling so the assignment below fixes THIS one
        process.env[spelling] = "1";
        try {
          check(`(N3-casing ${spelling}) the env really carries the odd spelling (${Object.keys(process.env).filter((k) => k.toUpperCase() === "GIT_TEST_COMMIT_GRAPH").join(",")})`, Object.keys(process.env).includes(spelling));
          const n3cRaw = spawnSync("git", ["-c", "core.commitGraph=false", "merge-base", M0, G], { cwd: repo, env: { ...process.env, ...IDENT }, encoding: "utf8" }).stdout.trim();
          check(`(N3-casing ${spelling}) CONTROL: raw git -c core.commitGraph=false still sees the odd-cased var and returns the WRONG answer (got ${n3cRaw}, truth M0=${M0})`, n3cRaw !== M0);
          const n3cFixed = await MW.isAncestorCommit(repo, M0, G, TIMEOUT_MS);
          check(`(N3-casing ${spelling}) isAncestorCommit(M0, G) through canonicalGit correctly reads TRUE despite the odd-cased ambient var (got ${n3cFixed})`, n3cFixed === true);
          const envSeenC = BOUNDED.prepareCanonicalEnv();
          check(`(N3-casing ${spelling}) prepareCanonicalEnv()'s own materialized env does NOT carry it under ANY casing`, !Object.keys(envSeenC).some((k) => k.toUpperCase() === "GIT_TEST_COMMIT_GRAPH"));
        } finally {
          delete process.env[spelling];
          if (prev !== undefined) process.env.GIT_TEST_COMMIT_GRAPH = prev;
        }
      }
    }
  }
} finally {
  fs.rmSync(path.join(repo, ".git", "objects", "info", "commit-graph"), { force: true });
  execFileSync("git", ["tag", "-d", "gsn-graph-reachable"], { cwd: repo, stdio: "ignore" });
}

// ── (RAW) S3 — the SAME graft, exercised through the raw-spawn path (killableCanonicalRaw /
// spawnCanonicalGitTree), not canonicalGit's simple-git wrapper — proves prepareCanonicalEnv's sentinel
// reaches BOTH consumers, not just the one (G1)-(G3) already covered. ──
fs.writeFileSync(graftsPath, `${F} ${ROOT}\n`);
try {
  const rawMergeBase = (await BOUNDED.killableCanonicalRaw(repo, ["merge-base", M, F], TIMEOUT_MS, "test(raw-spawn merge-base under graft)")).trim();
  check(`(RAW) killableCanonicalRaw's own merge-base(M, F) under the graft returns the REAL ancestor M, not the graft-truncated answer (got ${rawMergeBase})`, rawMergeBase === M);
} finally {
  fs.rmSync(graftsPath, { force: true });
}

// ── (S4) prepareCanonicalEnv ITSELF (not freshGitSentinelPath) — two separate calls must get DIFFERENT
// sentinels, and the materialized env must still carry PATH and HOME/USERPROFILE (never a bare
// {GIT_GRAFT_FILE, GIT_SHALLOW_FILE} object — that would silently strip the child's whole environment). ──
{
  const env1 = BOUNDED.prepareCanonicalEnv();
  const env2 = BOUNDED.prepareCanonicalEnv();
  check(`(S4) two separate prepareCanonicalEnv() calls get DIFFERENT GIT_GRAFT_FILE sentinels (${env1.GIT_GRAFT_FILE} vs ${env2.GIT_GRAFT_FILE})`, env1.GIT_GRAFT_FILE !== env2.GIT_GRAFT_FILE);
  check(`(S4) two separate prepareCanonicalEnv() calls get DIFFERENT GIT_SHALLOW_FILE sentinels (${env1.GIT_SHALLOW_FILE} vs ${env2.GIT_SHALLOW_FILE})`, env1.GIT_SHALLOW_FILE !== env2.GIT_SHALLOW_FILE);
  const hasPath = Object.keys(env1).some((k) => k.toUpperCase() === "PATH" && env1[k]);
  check("(S4) the materialized env still carries PATH (never a bare {GIT_GRAFT_FILE, GIT_SHALLOW_FILE} object)", hasPath);
  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const hasHome = Object.keys(env1).some((k) => k.toUpperCase() === homeKey && env1[k]);
  check(`(S4) the materialized env still carries ${homeKey}`, hasHome);
}

// ── (N2) a RELATIVE LOOM_HOME must never produce a relative, cwd-dependent sentinel — path.resolve, not
// path.join. LOOM_HOME is captured once at module load from process.env, so this needs a FRESH child
// process with LOOM_HOME set to a relative value before bounded.js is ever imported. ──
{
  const probeScript = path.join(os.tmpdir(), `loom-gsn-n2-probe-${sfx}.mjs`);
  registerForCleanup(probeScript);
  const distBoundedUrl = new URL("../dist/git/bounded.js", import.meta.url).href;
  fs.writeFileSync(probeScript, `const B = await import(${JSON.stringify(distBoundedUrl)});\nconsole.log(B.freshGitSentinelPath("graft"));\n`);
  const r = spawnSync(process.execPath, [probeScript], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, LOOM_HOME: "a-relative-loom-home-dir" },
  });
  const printed = (r.stdout || "").trim();
  check(`(N2) a relative LOOM_HOME still produces an ABSOLUTE sentinel (path.resolve, not path.join) — got ${JSON.stringify(printed)}, stderr=${JSON.stringify((r.stderr || "").slice(0, 300))}`, path.isAbsolute(printed));
  check("(N2) the resolved sentinel is rooted under cwd + the relative LOOM_HOME (proves path.resolve actually ran against THIS cwd, not silently falling back to some other absolute default)", printed.startsWith(path.join(repo, "a-relative-loom-home-dir")));
}

// ── (P) the sentinel paths themselves: absolute, fresh per call, never "NUL" ──
// (Not via a live alias-probe spawn: canonicalGit routes through simple-git, whose own unsafe-operations
// plugin refuses a `-c alias.*=` argv flag outright — "Configuring alias is not permitted without
// enabling allowUnsafeAlias" — a DIFFERENT plugin check than the env-var one this card's fix relies on.
// `freshGitSentinelPath` is exported directly from git/bounded.ts for exactly this test seam, the same
// pattern `scrubGitEnv`/`canonicalRaw`/etc. already use.)
const graft1 = BOUNDED.freshGitSentinelPath("graft");
const shallow1 = BOUNDED.freshGitSentinelPath("shallow");
const graft2 = BOUNDED.freshGitSentinelPath("graft");
const shallow2 = BOUNDED.freshGitSentinelPath("shallow");
check(`(P) call 1's GIT_GRAFT_FILE sentinel is an absolute path (got ${graft1})`, path.isAbsolute(graft1));
check(`(P) call 1's GIT_SHALLOW_FILE sentinel is an absolute path (got ${shallow1})`, path.isAbsolute(shallow1));
check(`(P) call 2's GIT_GRAFT_FILE sentinel is an absolute path (got ${graft2})`, path.isAbsolute(graft2));
check(`(P) call 2's GIT_SHALLOW_FILE sentinel is an absolute path (got ${shallow2})`, path.isAbsolute(shallow2));
check(`(P) the graft sentinel differs between two separate calls (${graft1} vs ${graft2})`, graft1 !== graft2);
check(`(P) the shallow sentinel differs between two separate calls (${shallow1} vs ${shallow2})`, shallow1 !== shallow2);
check("(P) neither sentinel is ever the literal \"NUL\" (case-insensitive)", ![graft1, shallow1, graft2, shallow2].some((v) => v.toUpperCase() === "NUL"));
check("(P) neither sentinel points at a file that actually exists (the whole mechanism depends on absence)", ![graft1, shallow1, graft2, shallow2].some((v) => fs.existsSync(v)));
// (G4)/(S4) — end-to-end: `prepareCanonicalEnv` is only reachable indirectly via `canonicalGit`/
// `spawnCanonicalGitTree`, but (G1)-(G3)/(S1)-(S3) above already prove the sentinel reaches a REAL
// canonicalGit(...) call end-to-end (the lie is neutralized), so this is deliberately not re-proven here.

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
