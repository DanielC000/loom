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
//       exactly { my_context, worker_report }.
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

// ============================ (S) SURFACE: still READ-ONLY ============================
{
  const file = tmpDbFile("surface");
  const db = new Db(file);
  const router = new OrchestrationMcpRouter(db, {});
  const toolNames = (role) => Object.keys(router.buildServer("sid", role)._registeredTools);

  const managerTools = toolNames("manager");
  const workerTools = toolNames("worker");

  // READ-ONLY: folding the gate into my_context must add NO set/propose/confirm gate surface anywhere.
  const gateSetTool = (names) => names.find((n) => /gate/i.test(n));
  check("(S) NO gate-setting tool on the manager surface (read-only — trust boundary intact)",
    gateSetTool(managerTools) === undefined);
  check("(S) NO gate-setting tool on the worker surface", gateSetTool(workerTools) === undefined);
  // The worker surface is unchanged: exactly { my_context, worker_report } (no new tool was added).
  check("(S) worker surface is STILL exactly { my_context, worker_report }",
    workerTools.slice().sort().join(",") === "my_context,worker_report");
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
