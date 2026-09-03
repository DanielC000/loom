import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// REDUCED-GATE NOTE test (card 65336570) — card 17cd1f30 shipped the NOT_HERMETIC exclusion declaration
// onto `confirmWorkerMerge`'s SYNC return value (`warning`), but a REAL gate ALWAYS returns
// `{status:"pending",opId}` (13m+ runs) — so the sync return is never what a manager actually sees; the
// async `[loom:merge-done]` nudge is. That nudge template did NOT echo the declaration at all: it was
// built into the generic `warning` field, and the async completion callback never reads `warning`, only
// specific named fields (mirroring `skillWarning`'s own precedent — see merge-skill-liveness-warning.mjs
// and service.ts:475's doc). This proves the fix: a dedicated `reducedGateWarning` field, echoed into the
// composed `[loom:merge-done]` TEXT itself — not just the return object, which is what the pre-fix code
// already got right and is NOT what a manager on the normal (pending) path ever reads.
//
// REAL git + REAL SessionService, injected `runGate` (no real subprocess — mirrors
// emit-compare-gate-not-hermetic.mjs's fakeGate) delayed past an injected small `syncAttachBudgetMs` (no
// real slow gate needed — mirrors merge-confirm-completion-nudge.mjs's SLOW_GATE_MS/TEST_SYNC_BUDGET_MS
// shape) so confirmWorkerMergeTracked genuinely degrades to the async pending path and the completion
// nudge actually fires — the ONLY path this bug can be observed on (the fast/sync path never nudges at
// all, scenario (3) in merge-confirm-completion-nudge.mjs).
//
// Proves:
//   (N) MIXED — a diff changing one ordinary test file PLUS one NOT_HERMETIC-named test file (the
//       5113c720 shape, same fixture as emit-compare-gate-not-hermetic.mjs's scenario N): the composed
//       `[loom:merge-done]` TEXT itself names the excluded file and says NOT_HERMETIC — RED-PROVEN first
//       (asserted to FAIL against the pre-fix dist, per /worker doctrine — see the inline note below).
//   (O) ALL-HERMETIC, POSITIVE CONTROL — a diff touching only ordinary test file(s), no NOT_HERMETIC name
//       anywhere: the reduced-gate announcement still appears in the nudge (the reduction itself is worth
//       surfacing — DoD-2), but with NO stray "NOT_HERMETIC" clause and no stray double-space/semicolon
//       artifact (mirrors `stepsLine`'s documented omit-when-empty convention).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-reduced-gate-note.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync, registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcrgn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// `_emit-compare-fixtures.mjs` has its OWN top-level `await import("../dist/git/worktrees.js")` (to
// derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) — a STATIC import of it here would be
// hoisted and evaluated before the LOOM_HOME lines above ever run, letting that transitive import lock
// paths.js's module-level DB_PATH to the real ~/.loom before this file's own override takes effect (the
// prod-DB guard then correctly refuses `new Db()` below). Importing it dynamically, after LOOM_HOME is
// set, keeps this file's own env setup ahead of anything that reads it.
const {
  GIT_ID, GUARD_BASENAMES, seed, mkdirp, mk, writeRealTestDaemonScript,
} = await import("./_emit-compare-fixtures.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "merge-confirm-reduced-gate-note: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

// One real, currently-live NOT_HERMETIC name (scripts/test-daemon.mjs) — same specimen the sibling
// emit-compare-gate-not-hermetic.mjs uses, matching the actual 5113c720 incident.
const NOT_HERMETIC_NAME = "board-consistency";
// Small on purpose: the fake gate below sleeps past this so confirmWorkerMergeTracked degrades to the
// async pending path — the ONLY path this bug is observable on.
const TEST_SYNC_BUDGET_MS = 100;
const SLOW_GATE_MS = 400;

function initRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mcrgn\n");
  mkdirp(path.join(p.repo, "packages", "daemon", "test"));
  writeRealTestDaemonScript(p.repo);
}

// Spy pty stub — records every enqueueStdin() call (kind included), mirroring
// merge-confirm-completion-nudge.mjs's SpyHost but as a plain stub (matches this file's sibling
// emit-compare-gate-*.mjs tests' minimal-stub style — no real PtyHost needed).
function makeSpyPty() {
  return {
    enqueueCalls: [],
    stop() {},
    isAlive() { return false; },
    enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
      this.enqueueCalls.push({ sessionId, text, kind });
    },
  };
}

const dbs = [];
const worktrees = [];
try {
  // ── (N) MIXED — one ordinary test file + one NOT_HERMETIC test file, async path ────────────────────────
  {
    const N = mk("n");
    initRepo(N);
    fs.writeFileSync(path.join(N.repo, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v1\");\n");
    fs.writeFileSync(path.join(N.repo, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email mcrgn@loom && git config user.name mcrgn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: N.repo });
    const db = new Db(); dbs.push(db);
    const pty = makeSpyPty();
    const fakeGate = async (gate) => { await sleep(SLOW_GATE_MS); return { passed: true }; };
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
    const { worktreePath, branch } = await createWorktree(N.repo, N.projId, N.taskId);
    N.worktreePath = worktreePath; N.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v2\");\n");
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update kickoff-real + ${NOT_HERMETIC_NAME}"`, { cwd: worktreePath });
    seed(db, N);

    const first = await sessions.confirmWorkerMergeTracked(N.mgrId, N.workerId);
    check("(N) degrades to the async pending path (the ONLY path this bug is observable on)", first.settled === false);

    await waitUntil(() => pty.enqueueCalls.some((c) => c.sessionId === N.mgrId && /\[loom:merge-done\]/.test(c.text)), 20_000);
    const nudges = pty.enqueueCalls.filter((c) => c.sessionId === N.mgrId && /\[loom:merge-done\]/.test(c.text));
    check("(N) exactly one [loom:merge-done] nudge landed", nudges.length === 1);
    const nudgeText = nudges[0]?.text ?? "";
    // ⭐⭐ THE ACTUAL DEFECT, RED-PROVEN (per /worker doctrine): this assertion was hand-verified to FAIL
    // against the pre-fix dist (built from HEAD before this card's edits) — the composed nudge text
    // carried no NOT_HERMETIC clause at all, only stepsLine/concurrencyNote/skillNote — and to PASS
    // against the post-fix dist below. See this task's worker_report for the before/after transcript.
    check("(N) the composed [loom:merge-done] TEXT itself names the excluded file", nudgeText.includes(NOT_HERMETIC_NAME));
    check("(N) the composed [loom:merge-done] TEXT itself says NOT_HERMETIC", /NOT_HERMETIC/.test(nudgeText));
    check("(N) the composed TEXT also carries the reduction announcement itself (DoD-2: whole message, not just the exclusion clause)",
      /merge gate reduced/.test(nudgeText));
    // Card cf4aa7d1: the NOT_HERMETIC file is excluded from `emitCompareTestFiles` (it never reaches
    // `--only=` — see EmitCompareGateResult.notHermeticExcluded's own doc), so exactly one file
    // (kickoff-real.mjs) was actually run in isolation here; the caveat must still fire for that one.
    check("(N) card cf4aa7d1: the isolation caveat still fires for the one ordinary test file actually run via --only= (the NOT_HERMETIC file is excluded, not counted)",
      /this changed test file was run in ISOLATION/.test(nudgeText));
  }

  // ── (O) ALL-HERMETIC, POSITIVE CONTROL — no NOT_HERMETIC name; no stray clause/whitespace ──────────────
  {
    const O = mk("o");
    initRepo(O);
    fs.writeFileSync(path.join(O.repo, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email mcrgn@loom && git config user.name mcrgn && git add . && git ${GIT_ID} commit -q -m init`, { cwd: O.repo });
    const db = new Db(); dbs.push(db);
    const pty = makeSpyPty();
    const fakeGate = async (gate) => { await sleep(SLOW_GATE_MS); return { passed: true }; };
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
    const { worktreePath, branch } = await createWorktree(O.repo, O.projId, O.taskId);
    O.worktreePath = worktreePath; O.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v2\");\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "test: update kickoff-real"`, { cwd: worktreePath });
    seed(db, O);

    const first = await sessions.confirmWorkerMergeTracked(O.mgrId, O.workerId);
    check("(O) degrades to the async pending path", first.settled === false);

    await waitUntil(() => pty.enqueueCalls.some((c) => c.sessionId === O.mgrId && /\[loom:merge-done\]/.test(c.text)), 20_000);
    const nudges = pty.enqueueCalls.filter((c) => c.sessionId === O.mgrId && /\[loom:merge-done\]/.test(c.text));
    check("(O) exactly one [loom:merge-done] nudge landed", nudges.length === 1);
    const nudgeText = nudges[0]?.text ?? "";
    check("(O) still carries the reduction announcement (a reduced gate stays distinguishable from a full one)",
      /merge gate reduced/.test(nudgeText));
    check("(O) no NOT_HERMETIC clause — nothing was excluded", !/NOT_HERMETIC/.test(nudgeText));
    check("(O) no stray double-space or dangling semicolon artifact around the omitted clause",
      !/  /.test(nudgeText) && !/;\s*$/.test(nudgeText.trim()) && !/;\s+⚠/.test(nudgeText));
    // Card cf4aa7d1 DoD-3 (positive control, test-only arm, OBSERVED on the real composed nudge TEXT —
    // the actual surface a manager reads on the always-pending path, not just the sync return object):
    // this diff changed ONE ordinary test file and NO compiled .ts file — the transpile-identity check
    // never ran, so the leading clause must say so honestly rather than rendering that skip as a measured
    // "0 compiled file(s) proven transpile-identical".
    check("(O) card cf4aa7d1: the leading clause honestly reports the compiled-check as not applicable (no compiled file changed), not a measured zero",
      /no compiled file\(s\) changed in this diff — transpile-identity check not applicable/.test(nudgeText));
    check("(O) card cf4aa7d1: the stale \"0 compiled file(s) proven transpile-identical\" wording is gone",
      !/0 compiled file\(s\) proven transpile-identical/.test(nudgeText));
    // Card cf4aa7d1 DoD-3 (positive control, isolation caveat): the one changed test file WAS run via
    // `--only=` — an isolation run — so the caveat must be present and must name it as isolation, singular.
    check("(O) card cf4aa7d1: the isolation caveat is present and singular-worded for the one changed test file",
      /this changed test file was run in ISOLATION/.test(nudgeText));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 65336570: the reduced-gate NOT_HERMETIC declaration is echoed into the composed [loom:merge-done] nudge TEXT itself (the only surface a manager actually reads on the normal, always-pending gate path), naming the excluded file(s) and the reduction itself; an all-hermetic reduced gate still announces the reduction but with no stray NOT_HERMETIC clause or formatting artifact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
