import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// END-TO-END test for card 74716cfb's TWO real nudge-composition sites (sessions/service.ts's
// `[loom:merge-rejected]` and `[loom:gate-failed]`), through the REAL entry points — a genuinely spawned
// gate command that threads the REAL `LOOM_GATE_OP_ID` env var (gateOpIdEnvOverride) into a fixture
// script that writes a real `run-summary` row to the real gate-timing NDJSON, so `readFailedNamesForOp`/
// `deferredTriggerNotice` run unstubbed, exactly as they do in production. The pure-function-level
// coverage (retried-op tie-break, undefined-vs-[], multi-match, no-op short-circuit) lives in
// deferred-trigger-notice.mjs; this file is the "wire BOTH sites" + "byte-identical for no match"
// end-to-end proof the card's own DoD calls for.
//
// Mirrors merge-gate-diagnostic.mjs's in-process style for site (A)/(B) and
// worker-run-gate-completion-nudge.mjs's forced-async-settle style for site (C).
//
// Proves:
//   (A) [loom:merge-rejected] carries the [loom:deferred-trigger] line when a DIFFERENT task on the SAME
//       project has annotated deferredUntilEvent naming one of the failed gate's REAL failedNames.
//   (B) the identical gate failure on a project with NO deferredUntilEvent-carrying task produces a
//       [loom:merge-rejected] text with NO [loom:deferred-trigger] substring at all — the DoD's
//       byte-identical-for-no-match requirement, proven against the real nudge text (not a stub).
//   (C) [loom:gate-failed] (runWorkerGate's ASYNC completion nudge, forced onto the slow/pending path via
//       a small injected syncAttachBudgetMs — onSettledAfterPending only fires on that path) ALSO carries
//       the line — the card's own binding "wire BOTH sites, a test must assert both" constraint.
// Run: 1) build daemon (pnpm build), 2) node test/deferred-trigger-nudge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-dtng-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dtng@loom -c user.name=dtng";
const now = new Date().toISOString();

async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "deferred-trigger-nudge: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const db = new Db();
// The service only touches pty.stop/isAlive/enqueueStdin on these paths — capture every enqueueStdin call
// so the test can assert on the ACTUAL nudge text a manager/worker would see.
const enqueued = [];
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
// A separate instance for scenario (C) with a SHRUNK sync-attach budget so a REAL gate settles onto the
// async path instead of racing the (much larger) production default — same DI seam
// worker-run-gate-completion-nudge.mjs uses.
const TEST_SYNC_BUDGET_MS = 500;
const sessionsSlow = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: TEST_SYNC_BUDGET_MS });

// Fixture gate script: writes a REAL run-summary NDJSON row keyed by the REAL LOOM_GATE_OP_ID the daemon
// threads into every gate spawn (gateOpIdEnvOverride), then fails — mirroring what test-daemon.mjs itself
// writes (kind:"run-summary", failedNames), without needing the whole real test-daemon.mjs harness.
// DTN_SLOW_MS/DTN_FAILED_NAME (read from the INHERITED test-process env at spawn time — gate-runner.ts's
// `env = { ...process.env, ... }`) let one fixture serve every scenario below.
const FIXTURE_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const opId = process.env.LOOM_GATE_OP_ID;",
  "const home = process.env.LOOM_HOME;",
  "const failedName = process.env.DTN_FAILED_NAME || 'widget.spec.js';",
  "const delayMs = Number(process.env.DTN_SLOW_MS || '0');",
  "function run() {",
  "  const dir = path.join(home, 'gate-timing');",
  "  fs.mkdirSync(dir, { recursive: true });",
  "  const row = { kind: 'run-summary', opId, poolSize: 1, testCount: 1, executedCount: 1, failedCount: 1, durationMs: 5, failedNames: [failedName] };",
  "  fs.appendFileSync(path.join(dir, 'daemon-per-file-timing.ndjson'), JSON.stringify(row) + '\\n');",
  "  console.error('FAIL ' + failedName + ' > renders correctly');",
  "  process.exitCode = 1;",
  "}",
  "if (delayMs > 0) setTimeout(run, delayMs); else run();",
].join("\n");

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# dtng\n");
  fs.writeFileSync(path.join(dir, "write-fail-summary.cjs"), FIXTURE_SCRIPT);
  execSync(`git init -q && git config user.email dtng@loom && git config user.name dtng`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
}

function seed(p) {
  db.insertProject({ id: p.projId, name: "DTNG", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: "node write-fail-summary.cjs" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "DTNG-WORKER-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `dtng-${label}-proj-${sfx}`, agentId: `dtng-${label}-agent-${sfx}`, taskId: `dtng-${label}-task-${sfx}`,
  mgrId: `dtng-${label}-mgr-${sfx}`, workerId: `dtng-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-dtng-${label}-${sfx}`), file,
});
const A = mk("a", "feature-a.txt"); // (A) MATCHING deferred card ⇒ [loom:merge-rejected] carries the trigger line
const B = mk("b", "feature-b.txt"); // (B) NO deferred card ⇒ byte-identical (no trigger line at all)
const C = mk("c", "feature-c.txt"); // (C) worker self-check, forced async ⇒ [loom:gate-failed] ALSO carries it

try {
  // ── (A) a DIFFERENT task on the same project names the exact failing file ──────────────────────────────
  makeRepo(A.repo);
  {
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch;
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    commitAll(worktreePath, `${A.file}`, GIT_ID);
    seed(A);

    const deferredTaskId = randomUUID();
    db.insertTask({ id: deferredTaskId, projectId: A.projId, title: "watching for widget.spec.js to fail again", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: "parked on this exact gate-fail event resurfacing" });
    db.updateTask(deferredTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "widget.spec.js" } });

    process.env.DTN_FAILED_NAME = "widget.spec.js";
    delete process.env.DTN_SLOW_MS;
    const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) rejected: merged:false", confirmA.merged === false);

    const rejectMsgs = enqueued.filter((args) => args[0] === A.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(A) exactly ONE [loom:merge-rejected] signal fired", rejectMsgs.length === 1);
    const text = rejectMsgs[0]?.[1] ?? "";
    check("(A) signal text carries [loom:deferred-trigger]", text.includes("[loom:deferred-trigger]"));
    check("(A) it names the real failed file (from the REAL run-summary.failedNames, not a stub)", text.includes("this red names widget.spec.js"));
    check("(A) it names the matching card's real id", text.includes(deferredTaskId));
    check("(A) it carries the required pointer+deadline wording", text.includes("not itself a specimen") && text.includes("~20 min"));
  }

  // ── (B) SAME shape, NO deferredUntilEvent-carrying task anywhere on the project ─────────────────────────
  makeRepo(B.repo);
  {
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch;
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    commitAll(worktreePath, `${B.file}`, GIT_ID);
    seed(B);
    // No second task deferred on anything — this project's board carries only the worker's own task.

    process.env.DTN_FAILED_NAME = "widget.spec.js";
    delete process.env.DTN_SLOW_MS;
    const confirmB = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) rejected: merged:false", confirmB.merged === false);

    const rejectMsgs = enqueued.filter((args) => args[0] === B.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(B) exactly ONE [loom:merge-rejected] signal fired", rejectMsgs.length === 1);
    const text = rejectMsgs[0]?.[1] ?? "";
    check("(B) BYTE-IDENTICAL: no [loom:deferred-trigger] substring appears at all when nothing matches", !text.includes("[loom:deferred-trigger]"));
    // Still a normal, fully-formed rejection otherwise — the appendix is purely additive, never replacing
    // or truncating the existing text.
    check("(B) the rest of the diagnostic text is still present (untouched by this card)", text.includes("build gate failed") && /canonical repo untouched, worktree retained/.test(text));
  }

  // ── (C) worker self-check (run_gate), forced onto the ASYNC settle path — [loom:gate-failed] ────────────
  makeRepo(C.repo);
  {
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch;
    fs.writeFileSync(path.join(worktreePath, C.file), "work for C\n");
    commitAll(worktreePath, `${C.file}`, GIT_ID);
    seed(C);

    const deferredTaskId = randomUUID();
    db.insertTask({ id: deferredTaskId, projectId: C.projId, title: "watching for widget.spec.js on the worker self-check path", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: "parked on this exact gate-fail event resurfacing (self-check path)" });
    db.updateTask(deferredTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "widget.spec.js" } });

    process.env.DTN_FAILED_NAME = "widget.spec.js";
    process.env.DTN_SLOW_MS = "1500"; // outlives TEST_SYNC_BUDGET_MS, forcing the async onSettledAfterPending path
    const first = await sessionsSlow.runWorkerGate(C.workerId);
    check("(C) degrades to pending past the sync-wait budget (forces the async completion-nudge path)", first.settled === false);

    await waitUntil(() => enqueued.some((args) => args[0] === C.workerId && typeof args[1] === "string" && /\[loom:gate-(done|failed)\]/.test(args[1])), 20_000);
    const nudges = enqueued.filter((args) => args[0] === C.workerId && typeof args[1] === "string" && /\[loom:gate-(done|failed)\]/.test(args[1]));
    check("(C) exactly ONE completion nudge landed", nudges.length === 1);
    const textC = nudges[0]?.[1] ?? "";
    check("(C) it's the FAILURE nudge", /\[loom:gate-failed\]/.test(textC));
    check("(C) it ALSO carries [loom:deferred-trigger] — BOTH sites wired, not just [loom:merge-rejected]", textC.includes("[loom:deferred-trigger]"));
    check("(C) it names the real failed file", textC.includes("this red names widget.spec.js"));
    check("(C) it names the matching card's real id", textC.includes(deferredTaskId));
  }
} finally {
  delete process.env.DTN_FAILED_NAME;
  delete process.env.DTN_SLOW_MS;
  for (const p of [A, B, C]) {
    try { if (p.worktreePath) await removeWorktree(p.repo, p.worktreePath); } catch { /* best-effort */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL gate spawn's REAL run-summary.failedNames (via the REAL LOOM_GATE_OP_ID env thread) joins against a DIFFERENT task's real deferredUntilEvent annotation at BOTH nudge composition sites — [loom:merge-rejected] (confirmWorkerMerge) and [loom:gate-failed] (runWorkerGate's async completion nudge) — while a project with no matching card gets a BYTE-IDENTICAL nudge (no [loom:deferred-trigger] substring at all)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
