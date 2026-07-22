import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// `my_context` now folds in the project's RESOLVED gateCommand, READ-ONLY (PL Auditor finding #9, PL
// signed off on option (b)). HERMETIC like idle-report.mjs / inbox-pull.mjs: isolated temp DB, imports
// dist/* + @loom/shared, NO daemon, NO real claude, NO pty. Covers:
//   (G) The myContext projection resolves gateCommand via resolveConfig (the ONE config mechanism):
//        - project WITH a per-project gateCommand override → {configured:true, command:<resolved>}
//        - project with NO gate (empty default) → {configured:false, command:null, note:<ask-owner>}
//        - available to BOTH a manager and a worker session (it's project-derived, any role)
//        - resolves LIVE: a human setProjectConfig is reflected with no restart
//        - a session whose project is gone resolves gracefully to the "none configured" sentinel
//        - the unmeasured-context branch (ctxInputTokens null) ALSO carries gateCommand
//   (S) SURFACE — my_context stays READ-ONLY: NO set/propose/confirm gate tool is registered on the
//       manager or worker surface (the trust boundary is untouched), and the worker surface is still
//       exactly { my_context, run_gate, worker_report }.
//   (W) Pre-first-turn contextWindow/model reflect the session's CONFIGURED profile model (not the
//       misleading DEFAULT_CONTEXT_WINDOW/null), with an explicit measured:false marker either way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-myctxgate-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

// ============================ (G) gateCommand projection ============================
{
  const file = tmpDbFile("gate");
  const db = new Db(file);
  const now = new Date().toISOString();

  // Project G: a per-project gateCommand override (resolveConfig must surface THIS, not the default "").
  const GATE = "pnpm build && pnpm --filter @loom/daemon test:daemon";
  db.insertProject({
    id: "pG", name: "Gated", repoPath: "/x", vaultPath: "/x",
    config: { orchestration: { gateCommand: GATE } }, createdAt: now, archivedAt: null,
  });
  // Project N: NO gate configured (empty override → resolveConfig yields the "" default).
  db.insertProject({
    id: "pN", name: "NoGate", repoPath: "/y", vaultPath: "/y",
    config: {}, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "aG", projectId: "pG", name: "g", startupPrompt: "x", position: 0 });
  db.insertAgent({ id: "aN", projectId: "pN", name: "n", startupPrompt: "x", position: 0 });

  const mkSession = (id, projectId, agentId, role, measured) => db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
    ...(measured ? { ctxInputTokens: 120_000, ctxUpdatedAt: now, model: "claude-opus-4-8" } : {}),
  });

  // A MANAGER in the gated project (measured), a WORKER in the gated project (unmeasured), and a
  // manager in the un-gated project — so we exercise both roles AND both measured/unmeasured branches.
  mkSession("mgrG", "pG", "aG", "manager", true);
  mkSession("wkrG", "pG", "aG", "worker", false);
  mkSession("mgrN", "pN", "aN", "manager", true);

  const router = new OrchestrationMcpRouter(db, {});
  // TS `private` is not enforced at runtime (dist is plain JS) — idle-report.mjs already calls the
  // private buildServer the same way. So we read the projection directly off the method under test.
  const ctx = (id) => router.myContext(id);

  // Gated manager → configured:true with the RESOLVED command (the override, not the "" default).
  {
    const c = ctx("mgrG");
    check("(G) gated manager → gateCommand.configured true", c.gateCommand?.configured === true);
    check("(G) gated manager → gateCommand.command === the resolved override", c.gateCommand?.command === GATE);
    check("(G) gated manager → no spurious note when configured", c.gateCommand?.note === undefined);
    // The occupancy fields are unchanged (additive — measured session still reports its pct).
    check("(G) gated manager → measured occupancy preserved alongside gateCommand",
      c.ctxInputTokens === 120_000 && c.pct === 12 && c.model === "claude-opus-4-8");
  }

  // Gated WORKER (unmeasured) → still carries the gateCommand AND the unmeasured pct:null+note branch.
  {
    const c = ctx("wkrG");
    check("(G) gated worker → gateCommand.configured true + command (any role gets it)",
      c.gateCommand?.configured === true && c.gateCommand?.command === GATE);
    check("(G) gated worker → unmeasured branch still returns pct null + occupancy note",
      c.ctxInputTokens === null && c.pct === null && typeof c.note === "string" && c.note.length > 0);
  }

  // Un-gated manager → explicit "none configured" sentinel: configured:false, command:null, a note.
  {
    const c = ctx("mgrN");
    check("(G) un-gated manager → gateCommand.configured false", c.gateCommand?.configured === false);
    check("(G) un-gated manager → gateCommand.command null", c.gateCommand?.command === null);
    check("(G) un-gated manager → an explicit 'none configured' note that points at the OWNER",
      typeof c.gateCommand?.note === "string" && /none configured/i.test(c.gateCommand.note) &&
      /owner/i.test(c.gateCommand.note));
  }

  // RESOLVE-LIVE: a human config PATCH is reflected with no restart (resolveConfig is called per-read).
  {
    db.setProjectConfig("pN", { orchestration: { gateCommand: "make check" } });
    const c = ctx("mgrN");
    check("(G) live PATCH → previously un-gated project now reports the new gate, no restart",
      c.gateCommand?.configured === true && c.gateCommand?.command === "make check");
    // And clearing it back to "" returns the sentinel again.
    db.setProjectConfig("pN", { orchestration: { gateCommand: "" } });
    check("(G) clearing the gate back to '' → 'none configured' sentinel again",
      ctx("mgrN").gateCommand?.configured === false);
  }

  // Defense: an UNKNOWN session (getSession → undefined → projectId undefined) resolves gracefully —
  // resolveConfig(undefined) → "" → the "none configured" sentinel — never throwing.
  {
    let threw = false; let c;
    try { c = ctx("does-not-exist"); } catch { threw = true; }
    check("(G) unknown session → resolves to 'none configured', does not throw",
      !threw && c?.gateCommand?.configured === false && c?.gateCommand?.command === null);
  }

  db.close();
  rmDb(file);
}

// ================ (W) pre-first-turn contextWindow reflects the CONFIGURED model ================
// Board bug: before any measured turn, my_context used to return the DEFAULT_CONTEXT_WINDOW (200k) +
// model:null even for a session whose Profile pins a genuine 1M-window model — a manager reading that
// pre-turn could misjudge headroom or recycle prematurely. The CONFIGURED model is knowable at spawn
// (session.agentId → agent.profileId → profile.model), so the unmeasured branch must reuse it instead
// of guessing, and must mark `measured:false` so a genuine 200k (no profile) is never confused for one.
{
  const file = tmpDbFile("premeasure");
  const db = new Db(file);
  const now = new Date().toISOString();

  db.insertProject({
    id: "pW", name: "Windowed", repoPath: "/w", vaultPath: "/w", config: {}, createdAt: now, archivedAt: null,
  });
  // A Profile pinned to a genuine 1M-window model (Claude 5 flagship family).
  db.insertProfile({
    id: "profBig", name: "Big Window", role: "worker", description: "", allowDelta: [], skills: null,
    model: "claude-opus-4-8", icon: null,
  });
  // A Profile with NO model set (null = engine default — genuinely unknown pre-turn).
  db.insertProfile({
    id: "profNoModel", name: "No Model", role: "worker", description: "", allowDelta: [], skills: null,
    model: null, icon: null,
  });
  db.insertAgent({ id: "aBig", projectId: "pW", name: "big", startupPrompt: "x", position: 0, profileId: "profBig" });
  db.insertAgent({ id: "aNoModel", projectId: "pW", name: "nm", startupPrompt: "x", position: 0, profileId: "profNoModel" });
  db.insertAgent({ id: "aNoProfile", projectId: "pW", name: "np", startupPrompt: "x", position: 0, profileId: null });

  const mkUnmeasured = (id, agentId) => db.insertSession({
    id, projectId: "pW", agentId, engineSessionId: null, title: null, cwd: "/w",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
  mkUnmeasured("wkrBig", "aBig");
  mkUnmeasured("wkrNoModel", "aNoModel");
  mkUnmeasured("wkrNoProfile", "aNoProfile");

  const router = new OrchestrationMcpRouter(db, {});
  const ctx = (id) => router.myContext(id);

  // A 1M-model Profile's window is surfaced BEFORE any measured turn (the fix).
  {
    const c = ctx("wkrBig");
    check("(W) unmeasured 1M-profile session → contextWindow reflects the CONFIGURED model, not 200k",
      c.contextWindow === 1_000_000);
    check("(W) unmeasured 1M-profile session → model is the CONFIGURED model id (not null)",
      c.model === "claude-opus-4-8");
    check("(W) unmeasured session → measured:false explicitly marks the unmeasured reading",
      c.measured === false);
    check("(W) unmeasured session → pct stays null (never a fake occupancy)", c.pct === null);
  }

  // A Profile with no model set (engine default) → genuinely unknown pre-turn: falls back to the
  // DEFAULT_CONTEXT_WINDOW, but still explicit measured:false (never mistaken for a real 200k reading).
  {
    const c = ctx("wkrNoModel");
    check("(W) unmeasured no-model-profile session → falls back to DEFAULT_CONTEXT_WINDOW (200k)",
      c.contextWindow === 200_000);
    check("(W) unmeasured no-model-profile session → measured:false", c.measured === false);
  }

  // No profile at all (plain agent) → same graceful fallback, never throws.
  {
    let threw = false; let c;
    try { c = ctx("wkrNoProfile"); } catch { threw = true; }
    check("(W) unmeasured no-profile session → resolves gracefully, no throw",
      !threw && c?.contextWindow === 200_000 && c?.measured === false);
  }

  db.close();
  rmDb(file);
}

// ============================ (S) SURFACE: still READ-ONLY ============================
{
  const file = tmpDbFile("surface");
  const db = new Db(file);
  const router = new OrchestrationMcpRouter(db, {});
  const toolNames = (role) => Object.keys(router.buildServer("sid", role)._registeredTools);

  const managerTools = toolNames("manager");
  const workerTools = toolNames("worker");

  // READ-ONLY: folding the gate into my_context must add NO set/propose/confirm gate surface anywhere.
  // `run_gate` (card 7f96aa09) and `gate_status` (card edc1ec12, now on BOTH surfaces per card fc243a43 —
  // the worker's own call is scoped to its own ops) are DELIBERATE, reviewed exceptions to the /gate/i
  // sweep below: `run_gate` only EXECUTES the project's EXISTING gateCommand (daemon-mediated, through the
  // GateSemaphore), and `gate_status` only READS the live GateSemaphore registry by opId — neither ever
  // sets/configures gateCommand, so the trust boundary this check protects (no agent-writable gateCommand
  // surface) is untouched by either.
  const gateSetTool = (names) => names.find((n) => /gate/i.test(n) && n !== "run_gate" && n !== "gate_status");
  check("(S) NO gate-setting tool on the manager surface (read-only — trust boundary intact)",
    gateSetTool(managerTools) === undefined);
  check("(S) NO gate-setting tool on the worker surface (run_gate EXECUTES, never SETS, the gate)",
    gateSetTool(workerTools) === undefined);
  // The worker surface is exactly { gate_status, my_context, run_gate, worker_report } — run_gate (card
  // 7f96aa09) and gate_status (card fc243a43, read-only + own-op-scoped) are the deliberate additions
  // since this assertion was written; anything else would be a surface leak.
  check("(S) worker surface is STILL exactly { gate_status, my_context, run_gate, worker_report }",
    workerTools.slice().sort().join(",") === "gate_status,my_context,run_gate,worker_report");
  // my_context is present on BOTH role branches (it's the tool the gate is folded into).
  check("(S) my_context registered on both manager + worker surfaces",
    managerTools.includes("my_context") && workerTools.includes("my_context"));

  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — my_context folds in the RESOLVED project gateCommand (resolveConfig) READ-ONLY: {configured:true,command} when set, an explicit 'none configured' sentinel when absent, for any role and across measured/unmeasured + live-PATCH; NO set/propose gate surface was added."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
