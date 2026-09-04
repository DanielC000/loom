import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// AUTO-CANCEL-ON-NUDGE (card 9d521792, origin finding 23d8864a) — a session parked on run_gate/
// worker_merge_confirm schedules a `wake_me` fallback so it doesn't sleep forever; when the awaited
// [loom:gate-*]/[loom:merge-*] settle nudge actually lands, nothing used to cancel that now-pointless
// wake, so it fired anyway (sometimes after the session already reported done), burning turns
// rediscovering "already handled". SessionService.autoCancelSettleWakes (service.ts) closes the gap:
// on a SUCCESSFUL settle-nudge delivery, it reaps every pending wake on the (lineage-resolved) target
// session whose `createdAt >= opStartedAt` — the op's own PendingOpRegistry-recorded start instant.
//
// This test drives the "gate" kind (runWorkerGate) through a REAL pending→settle cycle — the fast path
// never surfaces `[settled:false]`, so onSettledAfterPending (where the cancel lives) never fires; only
// a gate that outlives the SessionService's own `syncAttachBudgetMs` (shrunk to 100ms via test-only DI —
// card 0faaaa55) exercises it. Mirrors pending-op-settle-lineage.mjs's own "real gate that outlives the
// budget" convention, and folds the predecessor/successor recycle question into the SAME scenario
// (worker_recycle mid-gate) rather than paying the wall-clock cost twice.
//
// Proves, all in one scenario:
//   (1) a wake scheduled BEFORE run_gate started (unrelated — createdAt < opStartedAt) SURVIVES the
//       settle nudge untouched — the guard against over-cancellation.
//   (2) a wake scheduled AFTER run_gate started (the fallback park wake — createdAt >= opStartedAt) is
//       auto-cancelled the instant the [loom:gate-done] nudge successfully lands.
//   (3) the worker recycles to a successor MID-GATE (predecessor/successor case): both wakes are
//       reparented onto the successor by recycleWorker (db.reparentWakes) before the gate ever settles,
//       and the auto-cancel correctly runs against the successor's session id (the SAME lineage-resolved
//       target the nudge itself lands on) — the fallback wake is reaped off the SUCCESSOR, the unrelated
//       one survives on the SUCCESSOR too.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/wake-auto-cancel-on-settle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ON-FAILURE DIAGNOSTIC (card 7dc0cca5): this scenario's two checks around the fallback wake's fate are
// racing a millisecond-resolution timestamp comparison (autoCancelSettleWakes's `createdAt >= opStartedAt`)
// against real wall-clock scheduling — a bare PASS/FAIL never showed WHICH of the two candidate causes
// (a missed comparison vs. the documented fail-safe) actually fired. Captured unconditionally (cheap: one
// timestamp read + a console wrap) but only PRINTED if a check above failed, so a normal green run stays
// quiet. `capturedSettleLogLines` intercepts the exact two production log lines autoCancelSettleWakes
// itself emits — "auto-cancelling wake …" (reaped) and "auto-cancel-on-nudge skipped …" (the fail-safe,
// opStartedAt unavailable) — so a future regression is diagnosable from THIS test's own output, not by
// re-deriving the mechanism from scratch the way this card had to.
const capturedSettleLogLines = [];
const realConsoleLog = console.log.bind(console), realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { const s = String(args[0] ?? ""); if (/auto-cancelling wake/.test(s)) capturedSettleLogLines.push(s); realConsoleLog(...args); };
console.warn = (...args) => { const s = String(args[0] ?? ""); if (/auto-cancel-on-nudge skipped/.test(s)) capturedSettleLogLines.push(s); realConsoleWarn(...args); };
let diagPreCallInstant = null, diagFallbackWakeCreatedAt = null;
function printFailureDiagnosticIfAny() {
  if (failures === 0) return;
  realConsoleLog("\n--- ON-FAILURE DIAGNOSTIC (card 7dc0cca5): millisecond-resolution race evidence ---");
  realConsoleLog(`caller-side instant right before issuing run_gate (proxy for opStartedAt's own capture): ${diagPreCallInstant}`);
  realConsoleLog(`fallback wake's own createdAt (stamped by the test immediately after issuing run_gate): ${diagFallbackWakeCreatedAt}`);
  realConsoleLog(capturedSettleLogLines.length
    ? `captured settle-wake log line(s):\n  ${capturedSettleLogLines.join("\n  ")}`
    : "NO settle-wake log line was emitted for the fallback wake at all — it was silently excluded by the createdAt >= opStartedAt comparison (not the fail-safe branch, which always logs 'auto-cancel-on-nudge skipped').");
}
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/intervalMs budget
// (still monotonic — the shared helper uses performance.now() internally too), still does a final
// `predicate()` re-check on timeout (unchanged) instead of hardcoding false.
async function waitUntil(predicate, timeoutMs, intervalMs = 200) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "wake-auto-cancel-on-settle: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-wacs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=wacs@loom -c user.name=wacs";
const now = new Date().toISOString();

class SeamHost extends createSeamHost(PtyHost) {}
// SPY: records every enqueueStdin() call so the exact TARGET a completion nudge landed on is assertable.
// stop()/isAlive() tracking mirrors pending-op-settle-lineage.mjs — SeamHost's fake pty never fires a
// real exit event, so recycleWorker's synchronous "wait until the old pty is gone" poll needs this to
// return promptly instead of spinning its full timeout.
class SpyHost extends SeamHost {
  enqueueCalls = [];
  stoppedIds = new Set();
  spawn(opts) {
    super.spawn(opts);
    // Card 5ff6586d: this scenario's whole point is a settle nudge that ACTUALLY DELIVERS (the "(2)"
    // claim below), so the successor must reach genuine ready+idle — a real worker spawn only gets
    // there via SessionStart + mode-cycling + a completed first turn, none of which this fake pty ever
    // fires (no real claude output). Force it straight there instead of faking the hook sequence: this
    // is what exposed the underlying defect in the first place — before the fix, EVERY push here was
    // actually "held" (never delivered), and the fallback wake was only ever reaped because
    // autoCancelSettleWakes ran unconditionally, not because delivery genuinely succeeded.
    const live = this.live.get(opts.sessionId);
    if (live) { live.ready = true; live.busy = false; }
  }
  enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId) {
    this.enqueueCalls.push({ sessionId, text, kind });
    return super.enqueueStdin(sessionId, text, source, onDeliver, route, kind, questionId);
  }
  stop(sessionId, mode) {
    this.stoppedIds.add(sessionId);
    return super.stop(sessionId, mode);
  }
  isAlive(sessionId) {
    if (this.stoppedIds.has(sessionId)) return false;
    return super.isAlive(sessionId);
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SpyHost(events);
// A gate that outlives the SessionService's own `syncAttachBudgetMs` then resolves — comfortable margin,
// same convention as pending-op-settle-lineage.mjs. Shrunk to 100ms budget / 400ms sleep here (from the
// 12s production SYNC_ATTACH_BUDGET_MS / 15s sleep) via the same test-only DI seam `gateOpRetainMs`/
// `gateCancelVerifyMs` already use — card 0faaaa55 made SYNC_ATTACH_BUDGET_MS injectable.
const slowGate = async () => { await sleep(400); return { passed: true }; };
const svc = new SessionService(db, host, new OrchestrationControl(), { runGate: slowGate, syncAttachBudgetMs: 100 });

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-wacs-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo); // this file's own cleanup only rmSync's tmpHome, never this separate repo dir
  fs.writeFileSync(path.join(repo, "README.md"), "# wacs\n");
  execSync(`git init -q && git config user.email wacs@loom && git config user.name wacs`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const worktrees = [];
try {
  const P = "wacs-gate", repo = makeRepo();
  const { worktreePath, branch } = await createWorktree(repo, P, "twacs");
  worktrees.push([repo, worktreePath]);
  db.insertProject({ id: P, name: "WACS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
  db.insertTask({ id: "twacs", projectId: P, title: "twacs", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "twacs", worktreePath, branch });

  // (1) UNRELATED wake, scheduled well BEFORE run_gate starts — must survive.
  const unrelatedWakeAt = new Date(Date.now() + 3600_000).toISOString(); // far future; must never fire in-test
  db.insertWake({ id: "wake-unrelated", sessionId: workerAId, wakeAt: unrelatedWakeAt, note: "unrelated — check the owner decision", createdAt: new Date(Date.now() - 60_000).toISOString() });

  // Card c976f009 (Part 2, resolved (b)): this ordering — `diagFallbackWakeCreatedAt` stamped after
  // firing `runWorkerGate` WITHOUT awaiting it — relies on `opStartedAt` being captured synchronously
  // before any `await` inside `runWorkerGate`, otherwise the fallback wake's createdAt could race ahead
  // of production's own opStartedAt capture. CHECKED: sessions/service.ts's `runWorkerGate` stamps
  // `fnEntryInstant = new Date().toISOString()` as its literal first statement (before `requireWorker`
  // and before any `await`), documented there (card 7dc0cca5) as deliberately closing exactly this race
  // — so this ordering is guaranteed by construction, not by luck/margin. No fix needed.
  //
  // Kick off the gate — degrades to pending past this instance's (shrunk) syncAttachBudgetMs.
  diagPreCallInstant = new Date().toISOString();
  const firstPromise = svc.runWorkerGate(workerAId);

  // (2) FALLBACK wake, scheduled immediately AFTER run_gate started (mirrors the doctrine: park on
  // run_gate, then wake_me as a fallback in the same/next turn) — createdAt is now, at/after the op's
  // own startedAt, so it's in-scope for the auto-cancel.
  diagFallbackWakeCreatedAt = new Date().toISOString();
  db.insertWake({ id: "wake-fallback", sessionId: workerAId, wakeAt: new Date(Date.now() + 3600_000).toISOString(), note: "fallback in case gate-done never lands", createdAt: diagFallbackWakeCreatedAt });

  const first = await firstPromise;
  check("degrades to pending past the sync-wait budget", first.settled === false);

  // (3) Worker A recycles to B WHILE the gate is still running in the background — reparents BOTH
  // pending wakes onto B (db.reparentWakes), preserving their original createdAt.
  const workerB = await svc.recycleWorker(mgrId, workerAId, "handoff: continuing twacs; the pending run_gate self-check is still in flight and will land on its own.");
  check("recycleWorker produced a fresh successor session", !!workerB && workerB.id !== workerAId);
  db.setProcessState(workerAId, "exited"); // SeamHost's fake pty never fires a real exit — stamp it dead

  check("both wakes were reparented onto the successor by recycle (predecessor row emptied)", db.listWakesForSession(workerAId).length === 0);
  const reparented = db.listWakesForSession(workerB.id).map((w) => w.id).sort();
  check("both wakes now live under the successor's session id, original createdAt intact", reparented.length === 2 && reparented.includes("wake-unrelated") && reparented.includes("wake-fallback"));

  await waitUntil(() => host.enqueueCalls.some((c) => c.sessionId === workerB.id && /\[loom:gate-done\]/.test(c.text)), 30_000);
  const onSuccessor = host.enqueueCalls.filter((c) => c.sessionId === workerB.id && /\[loom:gate-done\]/.test(c.text));
  const onDeadPredecessor = host.enqueueCalls.filter((c) => c.sessionId === workerAId && /\[loom:gate-(done|failed)\]/.test(c.text));
  check("the completion nudge landed on the LIVE SUCCESSOR B, exactly once", onSuccessor.length === 1);
  check("NO completion nudge ever landed on the dead predecessor A", onDeadPredecessor.length === 0);

  const remaining = db.listWakesForSession(workerB.id).map((w) => w.id);
  check("THE GUARD AGAINST OVER-CANCELLATION: the wake scheduled BEFORE the op started (unrelated) SURVIVES the settle nudge, on the successor", remaining.includes("wake-unrelated"));
  check("the fallback wake scheduled WHILE parked on the op was auto-cancelled off the successor once its settle nudge landed", !remaining.includes("wake-fallback"));
  check("exactly one wake remains (only the fallback was reaped, not both)", remaining.length === 1);
} finally {
  for (const [repo, wt] of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

printFailureDiagnosticIfAny();
console.log(failures === 0
  ? "\n✅ ALL PASS — a settle nudge's SUCCESSFUL delivery auto-cancels only the fallback wake(s) scheduled while the awaited op was pending (createdAt >= opStartedAt), correctly following a mid-op recycle onto the LIVE SUCCESSOR (wakes already reparented there), while a wake that predates the op survives untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
