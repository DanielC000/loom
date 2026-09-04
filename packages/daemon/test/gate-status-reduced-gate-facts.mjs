import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GATE_STATUS RETROSPECTIVE REDUCED-GATE FACTS test (card 725dc89a — the scoped-out retrospective half of
// card 65336570). `65336570` echoed the reduced-gate/NOT_HERMETIC declaration into the LIVE
// `[loom:merge-done]` nudge TEXT; the durable `build_gate` audit event has always persisted the STRUCTURED
// facts (`emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles`/
// `emitCompareNotHermeticExcluded`, card 17cd1f30) but nothing read them back on a settled op — a manager
// investigating a PAST merge (after the nudge scrolled away) had to go read raw audit events. This proves
// the fix: `gate_status(opId)` (via `SessionService.gateStatus`) now surfaces the SAME structured facts on
// a settled "merge" row.
//
// Proves (RED-PROVEN per /worker doctrine — see the inline notes at each check below; hand-verified to FAIL
// against the pre-fix dist, built from HEAD before this card's edits):
//   (R) REDUCED — a diff changing one ordinary test file + one NOT_HERMETIC-named test file (the same
//       5113c720/65336570 shape): `gate_status(opId)` reports `emitCompareReduced:true`, names the excluded
//       NOT_HERMETIC file, and carries the changed ordinary test file + a numeric identical-file count.
//   (F) FULL, POSITIVE CONTROL — a genuine ONE-TOKEN BEHAVIORAL .ts edit (not eligible for reduction): a
//       real gate spawns and `gate_status(opId)` reports `emitCompareReduced:false` EXPLICITLY — never
//       `undefined` — and none of the three reduced-only fields, proving a non-reduced merge reads as
//       genuinely non-reduced, not as missing data (DoD-4's positive control).
//   (L) LEGACY ROW — a "merge" pending_gate_op settled with a verdict payload that predates this card (no
//       `emitCompareReduced` key at all, simulating a pre-725dc89a row): `gate_status(opId)` reports
//       `emitCompareReduced === undefined` — DECIDABLY DIFFERENT from (F)'s explicit `false` (DoD-3: "this
//       merge did not run a reduced gate" vs "this record predates the field" must be distinguishable).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-status-reduced-gate-facts.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync, registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gsrgf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// `_emit-compare-fixtures.mjs` has its OWN top-level `await import("../dist/git/worktrees.js")` (to
// derive GUARD_BASENAMES from the real STATIC_GUARD_REPO_PATHS) — a STATIC import of it here would be
// hoisted and evaluated before the LOOM_HOME lines above ever run, letting that transitive import lock
// paths.js's module-level DB_PATH to the real ~/.loom before this file's own override takes effect (the
// prod-DB guard then correctly refuses `new Db()` below). Importing it dynamically, after LOOM_HOME is
// set, keeps this file's own env setup ahead of anything that reads it.
const {
  GIT_ID, FULL_GATE, seed, mkdirp, mk, BASE_SRC, makeRepoWithBaseSrcFile, writeRealTestDaemonScript,
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "gate-status-reduced-gate-facts: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const NOT_HERMETIC_NAME = "board-consistency";
// Small on purpose: the fake gate below sleeps past this so confirmWorkerMergeTracked degrades to the
// async pending path (the only path a durable pending_gate_ops row/tombstone is even written for).
const TEST_SYNC_BUDGET_MS = 100;
const SLOW_GATE_MS = 400;

function initRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# gsrgf\n");
  mkdirp(path.join(p.repo, "packages", "daemon", "test"));
  writeRealTestDaemonScript(p.repo);
}

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

async function settleTrackedMerge(sessions, mgrId, workerId) {
  const first = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("degrades to the async pending path (the only path a pending_gate_ops row is written for)", first.settled === false);
  const opId = first.op.opId;
  await waitUntil(() => sessions.gateStatus(opId).state === "settled", 20_000);
  return opId;
}

const dbs = [];
const worktrees = [];
try {
  // ── (R) REDUCED — one ordinary test file + one NOT_HERMETIC test file, async path ─────────────────────
  {
    const R = mk("r");
    initRepo(R);
    fs.writeFileSync(path.join(R.repo, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v1\");\n");
    fs.writeFileSync(path.join(R.repo, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v1\");\n");
    execSync(`git init -q && git config user.email gsrgf@loom && git config user.name gsrgf`, { cwd: R.repo });
    commitAll(R.repo, "init", GIT_ID);
    const db = new Db(); dbs.push(db);
    const pty = makeSpyPty();
    const fakeGate = async () => { await sleep(SLOW_GATE_MS); return { passed: true }; };
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
    const { worktreePath, branch } = await createWorktree(R.repo, R.projId, R.taskId);
    R.worktreePath = worktreePath; R.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", "kickoff-real.mjs"), "// an ordinary hermetic test\nconsole.log(\"v2\");\n");
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${NOT_HERMETIC_NAME}.mjs`), "// needs a live daemon\nconsole.log(\"v2\");\n");
    commitAll(worktreePath, `test: update kickoff-real + ${NOT_HERMETIC_NAME}`, GIT_ID);
    seed(db, R);

    const opId = await settleTrackedMerge(sessions, R.mgrId, R.workerId);
    const status = sessions.gateStatus(opId);
    check("(R) settled and passed", status.state === "settled" && status.passed === true);
    // ⭐⭐ RED-PROVEN: hand-verified to FAIL against the pre-fix dist (`emitCompareReduced` was `undefined`
    // — the field didn't exist on the return type at all — for every settled merge row, reduced or not).
    check("(R) emitCompareReduced:true", status.emitCompareReduced === true);
    check("(R) emitCompareIdenticalCount is a number (0 — no .ts file changed, nothing to prove identical)", status.emitCompareIdenticalCount === 0);
    check("(R) emitCompareTestFiles names the ordinary changed test file", Array.isArray(status.emitCompareTestFiles) && status.emitCompareTestFiles.some((f) => f.includes("kickoff-real")));
    check("(R) emitCompareNotHermeticExcluded names the excluded NOT_HERMETIC file", Array.isArray(status.emitCompareNotHermeticExcluded) && status.emitCompareNotHermeticExcluded.some((f) => f.includes(NOT_HERMETIC_NAME)));
  }

  // ── (F) FULL, POSITIVE CONTROL — a genuine behavioral .ts edit, not eligible for reduction ─────────────
  {
    const F = mk("f");
    makeRepoWithBaseSrcFile(F, BASE_SRC);
    const db = new Db(); dbs.push(db);
    const pty = makeSpyPty();
    const fakeGate = async () => { await sleep(SLOW_GATE_MS); return { passed: true }; };
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "example.ts"), BASE_SRC.replace("x === 0", "x === 1"));
    commitAll(worktreePath, "fix: correct isReady threshold", GIT_ID);
    seed(db, F);

    const opId = await settleTrackedMerge(sessions, F.mgrId, F.workerId);
    const status = sessions.gateStatus(opId);
    check("(F) settled and passed", status.state === "settled" && status.passed === true);
    // ⭐⭐ THE POSITIVE CONTROL (DoD-4): a non-reduced merge must read as genuinely non-reduced, not as
    // missing data — `false`, never `undefined`. RED-PROVEN: pre-fix, this field doesn't exist at all, so
    // this assertion (`=== false`, not `=== undefined`) FAILS against the pre-fix dist.
    check("(F) emitCompareReduced:false EXPLICITLY (not undefined — a real gate ran and was proven not reduced)", status.emitCompareReduced === false);
    check("(F) emitCompareIdenticalCount absent (nothing to report — not reduced)", status.emitCompareIdenticalCount === undefined);
    check("(F) emitCompareTestFiles absent", status.emitCompareTestFiles === undefined);
    check("(F) emitCompareNotHermeticExcluded absent", status.emitCompareNotHermeticExcluded === undefined);
  }

  // ── (L) LEGACY ROW — a settled "merge" verdict payload written before this card ─────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const pty = makeSpyPty();
    const sessions = new SessionService(db, pty, new OrchestrationControl(), {});
    const opId = `gsrgf-legacy-${Date.now()}`;
    db.insertPendingGateOp({
      opId, kind: "merge", key: `merge:${opId}`, ownerSessionId: "gsrgf-legacy-mgr",
      projectId: null, taskId: null, branch: null, startedAt: new Date().toISOString(),
      state: "pending", surfacedPending: true,
    });
    // A pre-725dc89a "merge" pass payload: every OTHER field a real pass carries, but no
    // `emitCompareReduced` key at all — exactly what a row written before this card looks like.
    db.settlePendingGateOp(opId, { kind: "pass", payload: { reason: "ok", settledAt: new Date().toISOString(), totalDurationMs: 1000 } });

    const status = sessions.gateStatus(opId);
    check("(L) settled and passed", status.state === "settled" && status.passed === true);
    // DECIDABILITY (DoD-3): this MUST read differently from (F)'s explicit `false` above — `undefined`
    // here means "this record predates the field", not "genuinely not reduced".
    check("(L) emitCompareReduced is undefined (predates the field) — DECIDABLY DIFFERENT from (F)'s explicit false", status.emitCompareReduced === undefined);
    check("(L) emitCompareIdenticalCount absent", status.emitCompareIdenticalCount === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 725dc89a: gate_status(opId) now surfaces the reduced-gate/NOT_HERMETIC facts on a settled \"merge\" row, structurally (not just as the live [loom:merge-done] nudge text card 65336570 already covers) — a genuinely-reduced merge reads emitCompareReduced:true with the excluded file names, a genuinely-full merge reads emitCompareReduced:false explicitly (never missing data), and a row predating this card reads emitCompareReduced:undefined, decidably distinct from the explicit false."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
