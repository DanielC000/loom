// Hermetic regression guard for card 610abe29 — worker_set_mode: a manager-driven, daemon-side
// permission-mode override for a live worker (recovery + mid-run override). A worker can never change
// its own mode (Shift+Tab is a human TUI keystroke; ExitPlanMode/EnterPlanMode are disallowed for a
// worker), so mode changes must be daemon-driven — this is the MANUAL belt-and-suspenders override above
// the already-shipped spawn-convergence + auto-heal (b99d3d67).
//
// What it locks:
//   1. PtyHost.setPermissionMode (the primitive) drives a REAL fake-footer session to EACH allowed mode
//      (acceptEdits/plan/auto) by the SAME feedback-verified cycleToMode the spawn/resume convergence
//      uses — no blind fixed-count cycling — and resolves with the mode actually READ off the footer
//      once the cycle settles. Mirrors test/pty-mode-convergence.mjs's fake-pty seam.
//   2. SessionService.setWorkerMode fails CLOSED on the mode allowlist BEFORE ever touching the pty:
//      bypassPermissions and an unknown mode are both rejected (the escalation-out-of-sandbox guard),
//      and neither reaches the pty stub.
//   3. setWorkerMode is parent-scoped exactly like stopWorker/messageWorker/redirectWorker — a
//      non-owned (or unknown) worker is rejected with "not your worker".
//   4. A successful call records a `set_worker_mode` orchestration event carrying {target, landed}.
//
// Run: 1) build daemon, 2) node test/worker-set-mode.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════ Part 1: PtyHost.setPermissionMode (real cycler, fake footer) ═══════════════════════════
{
  const tmpHome = path.join(os.tmpdir(), `loom-wsm-pty-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;
  process.env.LOOM_RESUME_MODE_POLL_MS = "40";   // fast footer polling
  process.env.LOOM_RESUME_MODE_MAX_POLLS = "3";  // change-wait cap ≈ 120ms
  process.env.LOOM_READY_FALLBACK_MS = "9000";

  const { PtyHost } = await import("../dist/pty/host.js");

  const SHIFT_TAB = "\x1b[Z";
  const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
  const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
  const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";

  const fakes = [];
  function makeFakePty() {
    const writes = [];
    let dataCb = null;
    const fake = {
      pid: 4242, write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
      feed: (s) => { if (dataCb) dataCb(s); },
    };
    fakes.push(fake);
    return fake;
  }
  class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const host = new TestPtyHost(events);
  const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;

  const spawnAtAcceptEdits = (id) => {
    // startupModeCycles:0 → the boot convergence targets acceptEdits itself (0 presses), so the session
    // settles at the boot mode and every Shift+Tab counted below comes ONLY from setPermissionMode.
    host.spawn({
      sessionId: id, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
    });
    const fake = fakes[fakes.length - 1];
    fake.feed(ACCEPT_EDITS_FOOTER);
    host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
    return fake;
  };

  try {
    // ---- (1) already at target (acceptEdits→acceptEdits): 0 presses, resolves immediately ----
    {
      const id = "sess-wsm-A";
      const fake = spawnAtAcceptEdits(id);
      await sleep(750); // > MODE_CYCLE_SETTLE_MS(700): let the boot convergence settle (0 presses)
      check("(1) setup: boot convergence issued no presses (already at acceptEdits)", countShiftTabs(fake) === 0);

      const p = host.setPermissionMode(id, "acceptEdits");
      await sleep(750); // MODE_CYCLE_SETTLE_MS again (setPermissionMode reuses cycleToMode's own settle)
      const landed = await p;
      check("(1) setPermissionMode(acceptEdits→acceptEdits) issued 0 presses", countShiftTabs(fake) === 0);
      check(`(1) setPermissionMode resolves the FEEDBACK-VERIFIED landed mode 'acceptEdits' (got ${landed})`, landed === "acceptEdits");
    }

    // ---- (2) one press away (acceptEdits→plan) ----
    {
      const id = "sess-wsm-B";
      const fake = spawnAtAcceptEdits(id);
      await sleep(750);
      const p = host.setPermissionMode(id, "plan");
      await sleep(750); // settle + first decide → 1st press
      check("(2) setPermissionMode(acceptEdits→plan) issued its 1st Shift+Tab", countShiftTabs(fake) === 1);
      fake.feed(PLAN_FOOTER); // the press registers
      await sleep(200);
      const landed = await p;
      check("(2) setPermissionMode(acceptEdits→plan) converged in exactly 1 press", countShiftTabs(fake) === 1);
      check(`(2) landed mode = 'plan' (got ${landed})`, landed === "plan");
    }

    // ---- (3) two presses away (acceptEdits→auto), same contract as the spawn/resume convergence ----
    {
      const id = "sess-wsm-C";
      const fake = spawnAtAcceptEdits(id);
      await sleep(750);
      const p = host.setPermissionMode(id, "auto");
      await sleep(750);
      check("(3) setPermissionMode(acceptEdits→auto) issued its 1st Shift+Tab", countShiftTabs(fake) === 1);
      fake.feed(PLAN_FOOTER);
      // 150ms (not 200ms): the change-wait cap here is overridden to ≈120ms (40ms poll × 3) — feeding the
      // NEXT footer must land inside that window or the 2nd press's own awaitChange gives up first
      // (mirrors test/pty-mode-convergence.mjs scenario 1's identical timing under the same overrides).
      await sleep(150);
      check("(3) the confirmed plan reading issued the 2nd Shift+Tab", countShiftTabs(fake) === 2);
      fake.feed(AUTO_FOOTER);
      await sleep(150);
      const landed = await p;
      check("(3) setPermissionMode(acceptEdits→auto) converged in exactly 2 presses", countShiftTabs(fake) === 2);
      check(`(3) landed mode = 'auto' (got ${landed})`, landed === "auto");
    }

    // ---- (4) a dead/unknown session resolves 'unknown' without touching any pty ----
    {
      const landed = await host.setPermissionMode("no-such-session", "auto");
      check(`(4) setPermissionMode on a non-live session resolves 'unknown' (got ${landed})`, landed === "unknown");
    }
  } finally {
    for (const id of ["sess-wsm-A", "sess-wsm-B", "sess-wsm-C"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ═══════════════════════════ Part 2: SessionService.setWorkerMode (allowlist + ownership) ═══════════════════════════
{
  const tmpHome = path.join(os.tmpdir(), `loom-wsm-svc-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;

  const { Db } = await import("../dist/db.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");

  const now = new Date().toISOString();
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // A minimal PtyStub for setPermissionMode: records every call and simulates PERFECT convergence
  // (landed === requested mode) — the allowlist/ownership gates below must never even reach it for a
  // rejected call, which the "0 calls" assertions verify.
  class PtyStub {
    constructor() { this.calls = []; }
    async setPermissionMode(id, mode) { this.calls.push({ id, mode }); return mode; }
  }

  // Pass the db file EXPLICITLY rather than relying on the default DB_PATH — paths.ts reads LOOM_HOME
  // at IMPORT time, and Part 1 already imported pty/host.js (which pulls in paths.js) under a DIFFERENT
  // LOOM_HOME, so the cached DB_PATH constant would still point at Part 1's tmpHome.
  const db = new Db(path.join(tmpHome, "loom.db"));
  const proj = `wsm-proj-${sfx}`, agent = `wsm-ag-${sfx}`;
  db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
  const mkSession = (o) => db.insertSession({
    id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
    processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
    worktreePath: null, branch: null, recycledFrom: null,
  });

  try {
    // ===================== (a) MODE ALLOWLIST — fails closed BEFORE touching the pty =====================
    {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const mgr = `wsm-a-mgr-${sfx}`, wkr = `wsm-a-wkr-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr });

      let threw = null;
      try { await sessions.setWorkerMode(mgr, wkr, "bypassPermissions"); } catch (e) { threw = e.message; }
      check(`(a) 'bypassPermissions' REJECTED (got: ${threw})`, threw != null && threw.includes("acceptEdits|auto|plan"));
      check("(a) the rejected bypassPermissions call never reached the pty", pty.calls.length === 0);
      check("(a) no set_worker_mode event recorded for the refused bypassPermissions call",
        db.listEventsForWorker(wkr).filter((e) => e.kind === "set_worker_mode").length === 0);

      let threwUnknown = null;
      try { await sessions.setWorkerMode(mgr, wkr, "default"); } catch (e) { threwUnknown = e.message; }
      check(`(a) unknown mode 'default' REJECTED (got: ${threwUnknown})`, threwUnknown != null && threwUnknown.includes("acceptEdits|auto|plan"));
      check("(a) the rejected 'default' call never reached the pty either", pty.calls.length === 0);

      let threwGarbage = null;
      try { await sessions.setWorkerMode(mgr, wkr, "not-a-real-mode"); } catch (e) { threwGarbage = e.message; }
      check(`(a) an arbitrary garbage string REJECTED (got: ${threwGarbage})`, threwGarbage != null);
      check("(a) still 0 pty calls after 3 rejected modes", pty.calls.length === 0);
    }

    // ===================== (b) OWNERSHIP SCOPE — exact-parent, mirrors stopWorker/messageWorker =====================
    {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const mgr = `wsm-b-mgr-${sfx}`, other = `wsm-b-other-${sfx}`, notMine = `wsm-b-nm-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: other, role: "manager" });
      mkSession({ id: notMine, role: "worker", parentSessionId: other }); // a DIFFERENT manager's worker

      let threw = null;
      try { await sessions.setWorkerMode(mgr, notMine, "auto"); } catch (e) { threw = e.message; }
      check(`(b) a non-owned worker REJECTED ('not your worker', got: ${threw})`, threw === "not your worker");
      check("(b) the foreign worker's pty was never touched", pty.calls.length === 0);

      let threwUnknownWorker = null;
      try { await sessions.setWorkerMode(mgr, "no-such-worker", "auto"); } catch (e) { threwUnknownWorker = e.message; }
      check(`(b) an unknown workerSessionId REJECTED ('not your worker', got: ${threwUnknownWorker})`, threwUnknownWorker === "not your worker");
    }

    // ===================== (c) HAPPY PATH — owned worker, a WORKING mode: lands + records the event =====================
    // `plan` is deliberately EXCLUDED from this happy-path loop now (card 9c03f5a6) — see (d) below.
    {
      const pty = new PtyStub();
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const mgr = `wsm-c-mgr-${sfx}`, wkr = `wsm-c-wkr-${sfx}`;
      mkSession({ id: mgr, role: "manager" });
      mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: "task-wsm-c" });

      for (const mode of ["acceptEdits", "auto"]) {
        const landed = await sessions.setWorkerMode(mgr, wkr, mode);
        check(`(c) setWorkerMode(${mode}) reaches the pty and lands '${mode}' (got ${landed})`, landed === mode);
      }
      check("(c) the pty stub recorded both working-mode calls for the owned worker",
        pty.calls.length === 2 && pty.calls.every((c) => c.id === wkr));

      const evts = db.listEventsForWorker(wkr).filter((e) => e.kind === "set_worker_mode");
      check("(c) a set_worker_mode event is recorded per call, under the manager", evts.length === 2 && evts.every((e) => e.managerSessionId === mgr));
      check("(c) each event's detail carries {target, landed}",
        evts.every((e) => ["acceptEdits", "auto"].includes(e.detail?.target) && e.detail?.landed === e.detail?.target));
    }

    // ===================== (d) PLAN-REJECT BOUNDARY (card 9c03f5a6) =====================
    // `plan` is rejected for a role that structurally CANNOT self-exit it — DERIVED from the exact same
    // `disallowedToolsForRole(role).includes("ExitPlanMode")` predicate `buildSpawnArgs` uses at spawn,
    // so the two can never drift. That predicate's ExitPlanMode-disallowed set today is EXACTLY:
    // worker / setup / auditor / workspace-auditor / run / assistant — manager/platform/plain are NOT in
    // it (a human can legitimately Shift+Tab one of those into plan), which the second half of this block
    // proves by asserting plan is NOT rejected for those roles.
    {
      const REJECTED_ROLES = ["worker", "setup", "auditor", "workspace-auditor", "run", "assistant"];
      const ALLOWED_ROLES = ["manager", "platform", null]; // null = a plain/role-less session

      for (const role of REJECTED_ROLES) {
        const pty = new PtyStub();
        const sessions = new SessionService(db, pty, new OrchestrationControl());
        const mgr = `wsm-d-mgr-${role}-${sfx}`, wkr = `wsm-d-wkr-${role}-${sfx}`;
        mkSession({ id: mgr, role: "manager" });
        mkSession({ id: wkr, role, parentSessionId: mgr });

        let threw = null;
        try { await sessions.setWorkerMode(mgr, wkr, "plan"); } catch (e) { threw = e.message; }
        check(`(d) plan REJECTED for role='${role}' (cannot self-exit plan, got: ${threw})`,
          threw != null && threw.includes("plan") && threw.toLowerCase().includes(String(role).toLowerCase()));
        check(`(d) the rejected plan call for role='${role}' never reached the pty`, pty.calls.length === 0);
        check(`(d) no set_worker_mode event recorded for the refused plan call (role='${role}')`,
          db.listEventsForWorker(wkr).filter((e) => e.kind === "set_worker_mode").length === 0);
        // acceptEdits/auto stay UNAFFECTED for the same role — this is a plan-SPECIFIC boundary, not a
        // blanket lockout of worker_set_mode for these roles.
        const landed = await sessions.setWorkerMode(mgr, wkr, "auto");
        check(`(d) 'auto' still lands normally for role='${role}' (got ${landed})`, landed === "auto");
      }

      for (const role of ALLOWED_ROLES) {
        const pty = new PtyStub();
        const sessions = new SessionService(db, pty, new OrchestrationControl());
        const label = role ?? "plain";
        const mgr = `wsm-d2-mgr-${label}-${sfx}`, tgt = `wsm-d2-tgt-${label}-${sfx}`;
        mkSession({ id: mgr, role: "manager" });
        mkSession({ id: tgt, role, parentSessionId: mgr });

        const landed = await sessions.setWorkerMode(mgr, tgt, "plan");
        check(`(d) plan is NOT rejected for role='${label}' (can self-exit / human-driven, got landed=${landed})`,
          landed === "plan");
        check(`(d) the pty WAS reached for role='${label}'`, pty.calls.length === 1 && pty.calls[0].mode === "plan");
      }
    }

    db.close();
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_set_mode drives a live worker's footer to acceptEdits/auto via the SAME "
    + "feedback-verified cycler the spawn/resume convergence uses, fails CLOSED on bypassPermissions/an "
    + "unknown mode BEFORE touching the pty, REJECTS 'plan' for exactly the roles that cannot self-exit it "
    + "(derived from disallowedToolsForRole, never a second hand-maintained list) while leaving plan usable "
    + "for a human-driven manager/platform/plain session, is parent-scoped exactly like "
    + "stopWorker/messageWorker, and records a set_worker_mode event carrying {target, landed} on success."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
