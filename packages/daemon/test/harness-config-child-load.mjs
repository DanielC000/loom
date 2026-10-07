import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fca110cf — loadExcludedTestDirNames / loadNotHermeticNames (git/worktrees.ts) evaluate the WORKTREE's
// own scripts/test-daemon.mjs in a killable CHILD PROCESS, never an in-process import(). Proves:
//   (a) HANG: a branch copy that never settles / loops forever ⇒ the caller settles within the timeout with
//       the safe default (null), AND the child is actually killed (not orphaned).
//   (b) FRESHNESS (card 758486bc round 4 — REPLACES round 1's STALE scenario and rounds 2-3's CLOSURE /
//       TRANSIENT-FAILURE / ruling (a)-(c) / TOCTOU cache scenarios, all DELETED along with the cache layer
//       itself): every call spawns fresh, unconditionally — there is no cache left to go stale on ANY
//       shape. Proves this for an ENTRY-file edit, a SIBLING-file edit (reached via a static import), and
//       an edit to a JSON file read via `fs.readFileSync` (never a static import specifier at all — the
//       exact shape a closure-hash precondition could never see, which round 4 moots entirely by removing
//       the hash rather than trying to enumerate every such shape).
//   (c) NORMAL: a well-formed copy yields exactly its Set; a non-Set export and a throwing module yield null.
//   (d) SPAWN-COUNT POSITIVE CONTROL (card 758486bc round 4 — REPLACES round 1's MEMO CACHE scenario): a
//       SINGLE `computeEmitCompareGate` call whose diff needs BOTH `EXCLUDED_DIR_NAMES` and `NOT_HERMETIC`
//       classification still issues exactly ONE config-loader spawn — `loadHarnessSetExports`
//       already folds both exports into one child evaluation (round 1); this proves
//       `computeEmitCompareGate` shares that ONE spawn between both its lazy locals itself, now that the
//       cache layer which used to paper over two independent per-field calls is gone.
//
// Card 758486bc round 4 (Code Review round 4) REMOVED the cross-call content-hash memo entirely:
//   - MAJOR 1: ruling (b)'s `includes("require")` text check matched ordinary ENGLISH PROSE in comments
//     ("require every transitive import", `requireHermeticEnv`, the word "requires") — on this repo's REAL
//     `scripts/test-daemon.mjs` the hash ALWAYS returned `null`, so the memo NEVER hit in practice; a merge
//     still paid 2 spawns, same as before the card.
//   - MAJOR 2: even granting a hit, 7 more shapes (`.add()` after a literal init, a shadowing local `class
//     Set`, `export let` + reassignment, a top-level-await-gated add, `new Function`, `eval`, a
//     `process.env`-driven conditional add) would have served a STALE result — no AST precondition can
//     enumerate every way a `Set` can be mutated or substituted after its own declaration.
// See docs/decisions/758486bc-harness-config-loader-spawn-memo.md for the full history (rounds 1-4).
// Run: 1) pnpm build, 2) node test/harness-config-child-load.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

// @decision f103dd2d (createworktree-loom-home-guard.mjs) — a temp LOOM_HOME must be in force BEFORE the
// first `../dist/` import (`_emit-compare-fixtures.mjs` and `../dist/git/worktrees.js` below both resolve
// WORKTREES_DIR as a sibling of LOOM_HOME at import time), so scenario (d)'s real `createWorktree()` call
// can never reach this host's actual `~/.loom-worktrees`.
useOwnLoomHome("loom-hccl-");

const { GIT_ID, mk, writeRealTestDaemonScript } = await import("./_emit-compare-fixtures.mjs");
const {
  loadExcludedTestDirNames, loadNotHermeticNames, createWorktree, computeEmitCompareGate,
} = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function mkWorktree(scriptSource) {
  const wt = mkdtempManaged("loom-hccl-");
  fs.mkdirSync(path.join(wt, "packages", "daemon", "scripts"), { recursive: true });
  writeScript(wt, scriptSource);
  return wt;
}
function writeScript(wt, source) {
  fs.writeFileSync(path.join(wt, "packages", "daemon", "scripts", "test-daemon.mjs"), source);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const TIMEOUT_MS = 1500;
const HANG_BOUND_MS = 10_000; // generous: proves "settles", not a tight latency

try {
  // ── (c) NORMAL ────────────────────────────────────────────────────────────────────────────────────────
  {
    const wt = mkWorktree(`export const NOT_HERMETIC = new Set(["alpha", "beta"]);\nexport const EXCLUDED_DIR_NAMES = new Set(["census", "fixtures"]);\n`);
    const nh = await loadNotHermeticNames(wt);
    const ex = await loadExcludedTestDirNames(wt);
    check("(c) NOT_HERMETIC resolves to the copy's exact Set", nh instanceof Set && nh.size === 2 && nh.has("alpha") && nh.has("beta"));
    check("(c) EXCLUDED_DIR_NAMES resolves to the copy's exact Set", ex instanceof Set && ex.size === 2 && ex.has("census") && ex.has("fixtures"));
    const inert = mkWorktree(`export const NOT_HERMETIC = ["alpha"];\n`);
    check("(c) a non-Set export ⇒ null (never an empty-but-truthy Set)", (await loadNotHermeticNames(inert)) === null);
    check("(c) a missing export ⇒ null", (await loadExcludedTestDirNames(inert)) === null);
    const throwing = mkWorktree(`throw new Error("boom");\n`);
    check("(c) a module that throws at load ⇒ null", (await loadNotHermeticNames(throwing)) === null);
    check("(c) no script at all ⇒ null", (await loadNotHermeticNames(mkdtempManaged("loom-hccl-empty-"))) === null);
  }

  // The REAL scripts/test-daemon.mjs (main-module guard, static sibling imports) must load in the child —
  // a synthetic export-only script cannot catch a child whose argv makes the real script refuse to load.
  {
    const wt = mkdtempManaged("loom-hccl-real-");
    writeRealTestDaemonScript(wt);
    const nh = await loadNotHermeticNames(wt);
    const ex = await loadExcludedTestDirNames(wt);
    check("(c) REAL test-daemon.mjs: NOT_HERMETIC resolves (contains board-consistency)", nh instanceof Set && nh.has("board-consistency"));
    check("(c) REAL test-daemon.mjs: EXCLUDED_DIR_NAMES resolves (contains fixtures)", ex instanceof Set && ex.has("fixtures"));
  }

  // ── (b) FRESHNESS (card 758486bc round 4) — every call spawns fresh, unconditionally; nothing is ever
  //        cached, so there is no shape left that could ever go stale ───────────────────────────────────────
  {
    // Entry-file edit.
    const wt = mkWorktree(`export const NOT_HERMETIC = new Set(["v1"]);\n`);
    const first = await loadNotHermeticNames(wt);
    check("(b) entry: first call sees v1", first instanceof Set && first.has("v1") && first.size === 1);
    writeScript(wt, `export const NOT_HERMETIC = new Set(["v1", "v2-added-after-first-load"]);\n`);
    const second = await loadNotHermeticNames(wt);
    check("(b) ⭐ entry edit is seen on the VERY NEXT call",
      second instanceof Set && second.has("v2-added-after-first-load") && second.size === 2);
  }
  {
    // Sibling-file edit — entry (test-daemon.mjs) bytes never change.
    const wt = mkWorktree(`import { EXTRA } from "./sibling-758486bc.mjs";\nexport const NOT_HERMETIC = new Set([EXTRA]);\n`);
    const siblingPath = path.join(wt, "packages", "daemon", "scripts", "sibling-758486bc.mjs");
    fs.writeFileSync(siblingPath, `export const EXTRA = "v1";\n`);
    const withV1 = await loadNotHermeticNames(wt);
    check("(b) sibling present (v1): resolves correctly", withV1 instanceof Set && withV1.has("v1"));
    fs.writeFileSync(siblingPath, `export const EXTRA = "v2";\n`);
    const withV2 = await loadNotHermeticNames(wt);
    check("(b) ⭐ a SIBLING-only edit (entry bytes identical) is seen on the VERY NEXT call",
      withV2 instanceof Set && withV2.has("v2") && !withV2.has("v1"));
    fs.rmSync(siblingPath);
    const withoutSibling = await loadNotHermeticNames(wt);
    check("(b) sibling REMOVED (entry bytes identical) ⇒ null (the import can no longer resolve)", withoutSibling === null);
  }
  {
    // fs-read JSON edit — "./nh.json" is never a static import specifier, so a round-3-style closure-hash
    // precondition could never even see this file. Round 4 moots the whole class: nothing is hashed at all.
    const wt = mkWorktree(
      `import fs from "node:fs";\n` +
      `export const NOT_HERMETIC = new Set(JSON.parse(fs.readFileSync(new URL("./nh.json", import.meta.url))));\n`,
    );
    const jsonPath = path.join(wt, "packages", "daemon", "scripts", "nh.json");
    fs.writeFileSync(jsonPath, JSON.stringify(["alpha"]));
    const withAlpha = await loadNotHermeticNames(wt);
    check("(b) fs-read JSON: resolves correctly", withAlpha instanceof Set && withAlpha.has("alpha") && withAlpha.size === 1);
    fs.writeFileSync(jsonPath, JSON.stringify(["alpha", "beta"]));
    const withBeta = await loadNotHermeticNames(wt);
    check("(b) ⭐ a JSON-file edit (never a static import specifier) is seen on the VERY NEXT call",
      withBeta instanceof Set && withBeta.has("alpha") && withBeta.has("beta") && withBeta.size === 2);
    fs.rmSync(jsonPath);
    const afterDelete = await loadNotHermeticNames(wt);
    check("(b) ⭐⭐ JSON file DELETED (entry bytes identical) ⇒ null (the module now throws), observed immediately", afterDelete === null);
  }

  // ── (d) SPAWN-COUNT POSITIVE CONTROL (card 758486bc round 4) — a SINGLE computeEmitCompareGate call
  //        whose diff needs BOTH EXCLUDED_DIR_NAMES (the changed path sits under a subdirectory) AND
  //        NOT_HERMETIC (any changed/added test/*.mjs path triggers this check) classification still
  //        issues exactly ONE config-loader spawn. Counted via a counter file the worktree's own harness
  //        script appends to on every real module evaluation (a spawn that never happens can never
  //        append) ───────────────────────────────────────────────────────────────────────────────────────
  {
    const counterPath = path.join(mkdtempManaged("loom-hccl-spawncount-counter-"), "spawns.txt");
    const spawnCount = () => (fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8").length : 0);
    const harnessScript =
      `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(counterPath)}, "x");\n` +
      `export const NOT_HERMETIC = new Set([]);\n` +
      `export const EXCLUDED_DIR_NAMES = new Set(["fixtures", "census"]);\n`;

    const D = mk("hccl-d");
    fs.mkdirSync(D.repo, { recursive: true });
    registerForCleanup(D.repo);
    fs.writeFileSync(path.join(D.repo, "README.md"), "# hccl-d\n");
    fs.mkdirSync(path.join(D.repo, "packages", "daemon", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(D.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), harnessScript);
    fs.mkdirSync(path.join(D.repo, "packages", "daemon", "test", "sub"), { recursive: true });
    fs.writeFileSync(path.join(D.repo, "packages", "daemon", "test", "sub", "one.mjs"), "// nested test file\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg`, { cwd: D.repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: D.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: D.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "sub", "one.mjs"), "// nested test file\nconsole.log(\"v2\");\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "test: update sub/one.mjs"`, { cwd: worktreePath });

    const result = await computeEmitCompareGate(worktreePath, baseSha, branch);
    check("(d) eligible:true", result.eligible === true);
    check("(d) the nested file was classified into changedTestFiles", result.changedTestFiles.some((p) => p.endsWith("sub/one.mjs")));
    check(`(d) ⭐ THE FIX: a SINGLE computeEmitCompareGate call needing BOTH EXCLUDED_DIR_NAMES and NOT_HERMETIC classification issues exactly ONE config-loader spawn, not two independent ones (observed spawnCount: ${spawnCount()})`,
      spawnCount() === 1);
  }

  // ── (a) HANG — never-settling top-level await kept alive by a timer, and a sync infinite loop ─────────
  for (const [label, body] of [
    ["never-settling TLA + live timer", `setInterval(() => {}, 1000);\nawait new Promise(() => {});\n`],
    ["sync infinite loop", `while (true) {}\n`],
  ]) {
    const pidFile = path.join(mkdtempManaged("loom-hccl-pid-"), "child.pid");
    const wt = mkWorktree(`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}export const NOT_HERMETIC = new Set(["never-reached"]);\n`);
    const t0 = performance.now();
    const r = await Promise.race([
      loadNotHermeticNames(wt, TIMEOUT_MS),
      new Promise((res) => setTimeout(() => res("CALLER-STILL-HUNG"), HANG_BOUND_MS)),
    ]);
    const elapsed = performance.now() - t0;
    check(`(a) ${label}: caller settles with the safe default (null), not hung`, r === null);
    check(`(a) ${label}: settled no sooner than the timeout (${Math.round(elapsed)}ms)`, elapsed >= TIMEOUT_MS - 200);
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
    check(`(a) ${label}: the child really started (pid recorded — the control that the hang was exercised)`, Number.isInteger(pid) && pid > 0);
    let dead = false;
    try { await waitUntil(() => !pidAlive(pid), { timeoutMs: 8000, label: `child ${pid} exit` }); dead = true; } catch { dead = false; }
    check(`(a) ${label}: the timed-out child was KILLED (not orphaned)`, dead);
    if (!dead) { try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ } }
  }
} catch (e) {
  console.error("UNEXPECTED", e);
  failures++;
}

process.exit(failures === 0 ? 0 : 1);
