import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e8df2659 — the per-project HUMAN-only `orchestration.mergeGate:"off"` switch: BEHAVIOUR half.
// REAL git on temp repos + an INJECTED `runGate` seam whose CALL COUNTER proves whether the gate command ran
// (same style as merge-gate-inert-diff.mjs, whose skip machinery "off" reuses).
//
//   (A) OFF, solo, a SOURCE diff (never inert): the gate command is called ZERO times, the merge lands,
//       gateRan:false + skipped:true + skipReason:"gate-disabled", a warning naming the OFF switch, the
//       build_gate + merge_done events carry skipReason:"gate-disabled" (NOT "inert-docs-only-diff"),
//       gate_history reads "skipped" — never "pass".
//   (B) CONTROL, mergeGate unset (default "on") on the identical diff: the gate runs once, no skipReason —
//       proves (A)'s zero is the switch, not a broken counter.
//   (C) OFF + a noGateByDesign project: the gate-disabled warning is STILL present (never suppressed).
//   (D) OFF + a dirty worktree: REFUSED (gateWorktreeDirty), gate never called, main untouched — the
//       inert-skip's own "dirty is fine" leniency must NOT carry over.
//   (F) OFF, merge_batch of two branches: no gate call, batch reports reason "merge gate disabled", both
//       branches land through the per-branch solo fallback with skipReason:"gate-disabled" (build_gate rows).
// NOT COVERED: reuse of a worker self-check under OFF (code path disabled by `!gateDisabled &&`, not exercised);
// the pinned-tip refusal is N/A when off (no gate ever pins a tip); the in-lock squash checks are unchanged code.
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-off.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgoff-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgoff@loom -c user.name=mgoff";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(repo) {
  mkdirp(repo);
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mgoff\n");
  mkdirp(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mgoff@loom && git config user.name mgoff`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const mk = (label) => ({
  projId: `mgoff-${label}-proj-${sfx}`, agentId: `mgoff-${label}-agent-${sfx}`, mgrId: `mgoff-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgoff-${label}-${sfx}`),
});

/** Seed project (+ manager) then ONE worker with its own task/worktree/branch, committing `files` on it. */
async function seedProject(db, P, { mergeGate, noGateByDesign }) {
  const orchestration = { gateCommand: "pnpm gate", ...(mergeGate ? { mergeGate } : {}) };
  db.insertProject({ id: P.projId, name: "MGOFF", repoPath: P.repo, vaultPath: P.repo, config: { orchestration }, createdAt: now, archivedAt: null });
  if (noGateByDesign) db.updateProject(P.projId, { noGateByDesign: true });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
async function addWorker(db, P, n, files) {
  const taskId = `mgoff-${n}-task-${sfx}`;
  const workerId = `mgoff-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `MGOFF-${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  worktrees.push(worktreePath);
  for (const [rel, body] of Object.entries(files)) { mkdirp(path.dirname(path.join(worktreePath, rel))); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

const dbs = [];
const worktrees = [];
try {
  // ── (A) OFF, solo, a source (never-inert) diff ─────────────────────────────────────────────────────
  {
    const P = mk("a"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "a", { "src/feature.ts": "export const feature = 1;\n" });

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    check("(A) the gate command was NEVER called", calls === 0);
    check("(A) merged:true", confirm.merged === true);
    check("(A) gateRan:false and skipped:true", confirm.gateRan === false && confirm.skipped === true);
    check("(A) skipReason is \"gate-disabled\"", confirm.skipReason === "gate-disabled");
    check("(A) a warning names the OFF switch and says it is not a pass", typeof confirm.warning === "string" && /merge gate is OFF/.test(confirm.warning) && /NOT a pass/.test(confirm.warning));
    check("(A) the warning is NOT the docs/ inert-skip wording", !/docs\//.test(confirm.warning ?? ""));
    check("(A) the source change landed on main", fs.existsSync(path.join(P.repo, "src", "feature.ts")));
    const bg = eventsOfKind(db, P.mgrId, "build_gate")[0];
    check("(A) build_gate event: skipped:true, skipReason gate-disabled, no reused", bg?.detail?.skipped === true && bg?.detail?.skipReason === "gate-disabled" && bg?.detail?.reused !== true);
    const md = eventsOfKind(db, P.mgrId, "merge_done")[0];
    check("(A) merge_done event carries skipReason gate-disabled", md?.detail?.skipReason === "gate-disabled");
    const history = db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 });
    check("(A) gate_history outcome is \"skipped\" (never \"pass\") and gateRan:false", history.items[0]?.outcome === "skipped" && history.items[0]?.gateRan === false);
    check("(A) task moved to done", db.getTask(w.taskId).columnKey === "done");
  }

  // ── (B) CONTROL — default (on), identical diff ─────────────────────────────────────────────────────
  {
    const P = mk("b"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, {});
    const w = await addWorker(db, P, "b", { "src/feature.ts": "export const feature = 1;\n" });
    const confirm = await sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    check("(B) CONTROL: gate command called exactly once by default", calls === 1);
    check("(B) CONTROL: merged, gateRan:true, no skipped/skipReason", confirm.merged === true && confirm.gateRan === true && confirm.skipped === undefined && confirm.skipReason === undefined);
    const bg = eventsOfKind(db, P.mgrId, "build_gate")[0];
    check("(B) CONTROL: build_gate carries no skipReason", bg?.detail?.skipReason === undefined);
    check("(B) CONTROL: gate_history outcome is \"pass\"", db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items[0]?.outcome === "pass");
  }

  // ── (C) OFF + noGateByDesign: the warning is never suppressed ──────────────────────────────────────
  {
    const P = mk("c"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }), reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off", noGateByDesign: true });
    const w = await addWorker(db, P, "c", { "src/feature.ts": "export const feature = 1;\n" });
    const confirm = await sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    check("(C) project.noGateByDesign is really set (control)", db.getProject(P.projId).noGateByDesign === true);
    check("(C) merged AND the gate-disabled warning is still present", confirm.merged === true && /merge gate is OFF/.test(confirm.warning ?? ""));
  }

  // ── (D) OFF + dirty worktree: refused ──────────────────────────────────────────────────────────────
  {
    const P = mk("d"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "d", { "src/feature.ts": "export const feature = 1;\n" });
    fs.writeFileSync(path.join(w.worktreePath, "uncommitted-scratch.txt"), "never committed\n");
    const confirm = await sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    check("(D) OFF + dirty tree: NOT merged, refused with gateWorktreeDirty", confirm.merged === false && confirm.gateWorktreeDirty !== undefined);
    check("(D) the gate command was never called", calls === 0);
    check("(D) nothing landed on main (canonical repo untouched)", !fs.existsSync(path.join(P.repo, "src", "feature.ts")));
    check("(D) the worker's uncommitted file is still in its worktree (nothing destroyed)", fs.existsSync(path.join(w.worktreePath, "uncommitted-scratch.txt")));
  }

  // ── (F) OFF, merge_batch of two branches ───────────────────────────────────────────────────────────
  {
    const P = mk("f"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    const w1 = await addWorker(db, P, "f1", { "src/one.ts": "export const one = 1;\n" });
    const w2 = await addWorker(db, P, "f2", { "src/two.ts": "export const two = 2;\n" });
    const r = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("(F) the batch call settled", r.settled === true && r.ok === true);
    const v = r.value;
    check("(F) batch result reason is \"merge gate disabled\" (not \"no gateCommand configured\")", v?.ok === false && v?.reason === "merge gate disabled");
    check("(F) every fallback entry carries reason \"merge gate disabled\"", Array.isArray(v?.fallback) && v.fallback.length === 2 && v.fallback.every((f) => f.reason === "merge gate disabled"));
    let landed = false;
    try { landed = await waitUntil(() => db.getTask(w1.taskId).columnKey === "done" && db.getTask(w2.taskId).columnKey === "done", { timeoutMs: 60000, intervalMs: 50, label: "merge-gate-off (F): both fallback merges landed" }); } catch { landed = false; }
    check("(F) both branches landed via the per-branch fallback", landed && fs.existsSync(path.join(P.repo, "src", "one.ts")) && fs.existsSync(path.join(P.repo, "src", "two.ts")));
    check("(F) the gate command was NEVER called", calls === 0);
    const skips = eventsOfKind(db, P.mgrId, "build_gate").filter((e) => e.detail?.skipReason === "gate-disabled");
    check("(F) each solo landing recorded a gate-disabled build_gate row", skips.length === 2);
  }
  // ── (G) CACHED REJECTION vs the switch (review 143ea9a5 MAJOR): red gate → owner flips OFF → re-confirm ─
  {
    const P = mk("g"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const red = { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "boom" };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return red; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, {});
    const w = await addWorker(db, P, "g", { "src/feature.ts": "export const feature = 1;\n" });
    const r1 = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(G) red gate: first confirm settled as a rejection", r1.settled === true && r1.ok === true && r1.value.merged === false);
    const callsAfterRed = calls;
    check("(G) the gate ran (at least once) to earn the rejection", callsAfterRed >= 1);
    const r1b = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(G) CONTROL: an unchanged re-confirm is served from the cache (same op, no new gate run)", r1b.settled === true && r1b.freshMint === undefined && calls === callsAfterRed && r1b.value?.merged === false);
    check("(G) CONTROL: cacheHit.identity is the BARE commit — the cache-key suffix never reaches a manager", typeof r1b.cacheHit?.identity === "string" && !r1b.cacheHit.identity.includes("mergeGate") && /^[0-9a-f]{7,64}$/.test(r1b.cacheHit.identity));
    db.setProjectConfig(P.projId, { orchestration: { gateCommand: "pnpm gate", mergeGate: "off" } });
    const r2 = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(G) the fresh mint names the SAME bare commit before and after (only the switch changed)", r2.freshMint?.priorIdentity !== undefined && r2.freshMint.priorIdentity === r2.freshMint.currentIdentity && !String(r2.freshMint.priorIdentity).includes("mergeGate"));
    check("(G) after flipping OFF the re-confirm is NOT the cached rejection — it LANDS", r2.settled === true && r2.ok === true && r2.value.merged === true);
    check("(G) it landed with skipReason gate-disabled", r2.value?.skipReason === "gate-disabled" && r2.value?.gateRan === false);
    check("(G) the gate command was NOT run again (calls unchanged)", calls === callsAfterRed);
    check("(G) the change is on main", fs.existsSync(path.join(P.repo, "src", "feature.ts")));
  }

  // ── (H) the reverse: an OFF-mode refusal must not be replayed after flipping back ON ──────────────────
  {
    const P = mk("h"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let calls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { calls++; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "h", { "src/clash.ts": "export const v = 'branch';\n" });
    fs.writeFileSync(path.join(P.repo, "src", "clash.ts"), "export const v = 'main';\n");
    commitAll(P.repo, "chore(x): conflicting change on main", GIT_ID);
    const r1 = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(H) OFF + a real conflict: refused (merged:false), gate never called", r1.settled === true && r1.ok === true && r1.value.merged === false && calls === 0);
    const r1b = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(H) CONTROL: unchanged re-confirm is the cached refusal (no fresh mint)", r1b.settled === true && r1b.freshMint === undefined && r1b.value?.merged === false);
    db.setProjectConfig(P.projId, { orchestration: { gateCommand: "pnpm gate" } });
    const r2 = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(H) after flipping back ON the re-confirm is a FRESH mint (identity-mismatch), not the replayed OFF-mode refusal", r2.settled === true && r2.freshMint?.reason === "identity-mismatch");
    check("(H) the manager-facing identities name the bare commit (no cache-key suffix leaks)", r2.freshMint?.priorIdentity !== undefined && !String(r2.freshMint.priorIdentity).includes("mergeGate") && !String(r2.freshMint.currentIdentity).includes("mergeGate"));
  }

  // ── (I) OFF + edits made WHILE waiting on the repo merge guard are refused (review MINOR 1) ────────────
  {
    const P = mk("i"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    let releaseSibling; const siblingHeld = new Promise((r) => { releaseSibling = r; });
    let siblingCalls = 0;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { siblingCalls++; await siblingHeld; return { passed: true }; }, reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    // A SECOND project on the SAME repo path, gate ON: its real gate holds the per-repo merge guard.
    const S = { projId: `mgoff-i2-proj-${sfx}`, agentId: `mgoff-i2-agent-${sfx}`, mgrId: `mgoff-i2-mgr-${sfx}`, repo: P.repo };
    await seedProject(db, S, {});
    const wOff = await addWorker(db, P, "i1", { "src/off.ts": "export const off = 1;\n" });
    const wSib = await addWorker(db, S, "i2", { "src/sib.ts": "export const sib = 1;\n" });
    const sibling = sessions.confirmWorkerMerge(S.mgrId, wSib.workerId);
    const gateRunning = await waitUntil(() => siblingCalls === 1, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-off (I): sibling real gate running" });
    check("(I) fixture: the same-repo sibling's REAL gate is running and holds the repo guard", gateRunning === true);
    const offMerge = sessions.confirmWorkerMerge(P.mgrId, wOff.workerId);
    const queued = await waitUntil(() => sessions.gateQueueForManager(P.projId).repoGuardOnly.some((e) => e.phase === "queued" && e.repoPath === P.repo), { timeoutMs: 60000, intervalMs: 10, label: "merge-gate-off (I): OFF merge queued on the repo guard" });
    check("(I) fixture: the OFF merge is now genuinely queued behind the sibling on the repo guard", queued === true);
    fs.writeFileSync(path.join(wOff.worktreePath, "edited-during-wait.txt"), "written while queued\n");
    releaseSibling();
    const sibRes = await sibling;
    check("(I) the sibling landed", sibRes.merged === true);
    const offRes = await offMerge;
    check("(I) the OFF merge is REFUSED as dirty (edit made during the guard wait)", offRes.merged === false && offRes.gateWorktreeDirty !== undefined);
    check("(I) nothing of the OFF branch landed on main", !fs.existsSync(path.join(P.repo, "src", "off.ts")));
    check("(I) the worker's edit survives in its worktree", fs.existsSync(path.join(wOff.worktreePath, "edited-during-wait.txt")));
  }

  // ── (J) OFF with NO gateCommand: merge_done carries skipReason only if the skip really happened ─────
  {
    const P = mk("j"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }), reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    db.setProjectConfig(P.projId, { orchestration: { mergeGate: "off" } }); // no gateCommand at all
    const w = await addWorker(db, P, "j", { "src/feature.ts": "export const feature = 1;\n" });
    const confirm = await sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    const md = eventsOfKind(db, P.mgrId, "merge_done")[0];
    check("(J) merged with the gate off and NO gateCommand (nothing to skip — the gateless path): skipReason ABSENT on BOTH the result and merge_done (pinned), and the gateless warning stands", confirm.merged === true && confirm.skipReason === undefined && md?.detail?.skipReason === undefined && /no gateCommand is configured/.test(confirm.warning ?? ""));
  }

  // ── (K) durable surfaces: settled verdict payload + gate_history row carry skipReason ────────────────
  {
    const P = mk("k"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true }), reapWorktreeProcesses: noReap });
    await seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "k", { "src/feature.ts": "export const feature = 1;\n" });
    const r = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(K) merged with gate-disabled", r.settled === true && r.value?.skipReason === "gate-disabled");
    const tomb = db.listPendingGateOpsByOpIds([r.value.opId])[0];
    check("(K) the settled tombstone verdict is skipped + carries skipReason gate-disabled", tomb?.verdict === "skipped" && tomb?.verdictPayload?.skipReason === "gate-disabled");
    const hist = db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items[0];
    check("(K) gate_history row carries skipReason gate-disabled", hist?.skipReason === "gate-disabled");
  }
  // ── (L) the ASYNC surfaces: [loom:merge-done] nudge echoes the warning; gate_status carries skipReason ──
  {
    const P = mk("l"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const spyPty = { stop() {}, isAlive() { return false; }, enqueueStdin(sessionId, text, source, onDeliver, route, kind) { enqueued.push({ sessionId, text, kind }); } };
    const sessions = new SessionService(db, spyPty, new OrchestrationControl(), { runGate: async () => ({ passed: true }), reapWorktreeProcesses: noReap, syncAttachBudgetMs: 1 });
    await seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "l", { "src/feature.ts": "export const feature = 1;\n" });
    const first = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId);
    check("(L) fixture: the call degraded to the async pending path (the path the nudge exists for)", first.settled === false);
    const opId = first.op.opId;
    await waitUntil(() => sessions.gateStatus(opId).state === "settled", { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-off (L): op settled" });
    const st = sessions.gateStatus(opId);
    check("(L) gate_status: settled, outcome skipped (never pass), skipReason gate-disabled", st.state === "settled" && st.outcome === "skipped" && st.skipReason === "gate-disabled");
    const done = enqueued.find((e) => /\[loom:merge-done\]/.test(e.text));
    check("(L) the [loom:merge-done] nudge was sent and echoes the gate-disabled warning", done !== undefined && /merge gate is OFF/.test(done.text) && /NOT a pass/.test(done.text));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeGate:\"off\" merges without calling the gate command and records skipReason:\"gate-disabled\" (result, warning, build_gate, merge_done, gate_history \"skipped\"), never suppressed by noGateByDesign; a dirty tree is still refused; merge_batch falls back to per-branch gate-less merges with reason \"merge gate disabled\"; the default (\"on\") is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
