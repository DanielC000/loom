import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a16c580b, manager-review follow-up: `gate_status`'s MANAGER call site is UNSCOPED
// (mcp/orchestration.ts's `registerGateStatus(server, sessions)` — no `scopeSessionId`/`scopeProjectId`)
// — a manager on ONE project can resolve a settled op minted by ANOTHER project, including its
// `outputTail` (a real, PRE-EXISTING exposure this card does not touch). Adding `outputFile` — an
// absolute host path into that op's FULL captured output — to the same unscoped surface would have handed
// a manager on a foreign project a zero-effort pointer into another project's complete gate output, wider
// than the pre-existing `outputTail` tail. This proves the fix: `SessionService.gateStatus`'s new
// `redactOutputFileForProject` param (threaded from the manager call site as
// `() => db.getSession(managerSessionId)?.projectId`) omits `outputFile` for a foreign-project op while
// leaving every other field — INCLUDING the pre-existing `outputTail` — untouched, and a same-project read
// still gets the real path.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, `deploy`'s injected `runGate` seam so no
// real host exec ever happens (mirrors gate-status-deploy-opid.mjs's own harness convention exactly).
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/gate-status-outputfile-redaction.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const tmpHome = path.join(os.tmpdir(), `loom-gst-redact-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(tmpHome, "gst-redact.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  const REAL_OUTPUT_FILE = path.join(tmpHome, "gate-output", "specimen.log");
  let nextResult = { passed: true, steps: [], outputTail: "shipping\n", outputFile: REAL_OUTPUT_FILE };
  const fakeRunGate = async () => nextResult;
  const sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    { runGate: fakeRunGate },
  );
  const router = new OrchestrationMcpRouter(db, sessions);

  // Project A owns the op; Project B is the FOREIGN reader.
  db.insertProject({
    id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA",
    config: { orchestration: { deployCommand: "echo shipping" } }, createdAt: now, archivedAt: null,
  });
  db.insertProject({
    id: "pB", name: "Project B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "aA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "aB", projectId: "pB", name: "Mgr B", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "aA", engineSessionId: null, title: null,
    cwd: "pA", processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "manager",
  });
  db.insertSession({
    id: "mgrB", projectId: "pB", agentId: "aB", engineSessionId: null, title: null,
    cwd: "pB", processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "manager",
  });

  const serverA = router.buildServer("mgrA", "manager");
  const serverB = router.buildServer("mgrB", "manager");
  check("(precondition) deploy IS registered on mgrA's surface", "deploy" in serverA._registeredTools);
  check("(precondition) gate_status IS registered on BOTH managers' surfaces",
    "gate_status" in serverA._registeredTools && "gate_status" in serverB._registeredTools);

  const callDeployAsA = async (reason) => JSON.parse((await serverA._registeredTools["deploy"].handler({ reason })).content[0].text);
  const callGateStatusAs = async (server, opId) => JSON.parse((await server._registeredTools["gate_status"].handler({ opId })).content[0].text);

  const ok = await callDeployAsA("ship it");
  check("(precondition) mgrA's deploy succeeds and returns a real opId", ok.deployed === true && typeof ok.opId === "string" && ok.opId.length > 0);

  // ── SAME-PROJECT READ — the op's OWNING manager sees the real path, unredacted. ─────────────────────────
  const sameProjectStatus = await callGateStatusAs(serverA, ok.opId);
  check("(same-project) state is settled", sameProjectStatus.state === "settled");
  check("(same-project) outputFile is the REAL path — no redaction for the owning project",
    sameProjectStatus.outputFile === REAL_OUTPUT_FILE,
    () => JSON.stringify(sameProjectStatus.outputFile));
  check("(same-project) outputTail is present too (both fields visible to the owner)",
    sameProjectStatus.outputTail === "shipping\n");

  // ── THE FIX — a FOREIGN manager (Project B) queries the SAME real opId. ─────────────────────────────────
  const foreignStatus = await callGateStatusAs(serverB, ok.opId);
  check("(foreign — precondition) the op is STILL resolvable at all (this tool is genuinely unscoped for a manager, not silently scoped by this fix)",
    foreignStatus.state === "settled");
  check("(foreign — THE FIX) outputFile is REDACTED (absent) for a manager on a DIFFERENT project",
    foreignStatus.outputFile === undefined,
    () => JSON.stringify(foreignStatus.outputFile));
  check("(foreign) outputTail is UNCHANGED — this fix redacts outputFile ONLY, never widens to the pre-existing outputTail exposure",
    foreignStatus.outputTail === "shipping\n");
  check("(foreign) every OTHER field survives untouched (passed/outcome/gateType) — this is a targeted redaction, not a degraded response",
    foreignStatus.passed === true && foreignStatus.outcome === "pass" && foreignStatus.gateType === "deploy");

  // ── NEGATIVE CONTROL — a genuinely bogus opId still reads never_existed for BOTH managers, proving the ──
  // redaction logic didn't accidentally start resolving/hiding rows that were never there.
  const bogusOpId = "22222222-0000-4000-8000-000000000099";
  const bogusAsA = await callGateStatusAs(serverA, bogusOpId);
  const bogusAsB = await callGateStatusAs(serverB, bogusOpId);
  check("(negative control) a bogus opId reads never_existed for the same-project manager too",
    bogusAsA.state === "never_existed");
  check("(negative control) a bogus opId reads never_existed for the foreign manager too",
    bogusAsB.state === "never_existed");

  // ── 2nd MANAGER-REVIEW CATCH — THE FAIL-SAFE-ON-UNRESOLVED-SESSION CASE ─────────────────────────────────
  // A first version of this fix passed a bare `string | undefined` for the redaction target, resolved via
  // `db.getSession(managerSessionId)?.projectId` — collapsing "worker path, no redaction needed" (safe) and
  // "manager path, but the session lookup itself came back undefined" (NOT safe — no filter sits behind
  // it) onto the SAME `undefined` value. Reproduced here: build a THIRD manager's server, then delete that
  // manager's OWN session row before calling gate_status — `registerGateStatus`'s handler re-reads
  // `db.getSession(managerSessionId)` FRESH on every call (see that router's own "LAZY" doc comment), so
  // this genuinely exercises a failed lookup at call time, not a stale cached value.
  db.insertProject({
    id: "pC", name: "Project C", repoPath: "pC", vaultPath: "pC", config: {}, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "aC", projectId: "pC", name: "Mgr C", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrC", projectId: "pC", agentId: "aC", engineSessionId: null, title: null,
    cwd: "pC", processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "manager",
  });
  const serverC = router.buildServer("mgrC", "manager");
  check("(precondition) mgrC's OWN session lookup succeeds BEFORE deletion (proves the deletion below is what changes)",
    db.getSession("mgrC") !== undefined);
  db.deleteSession("mgrC");
  check("(precondition) mgrC's session lookup NOW genuinely fails — this is the exact condition the bug needs",
    db.getSession("mgrC") === undefined);
  const unresolvedSessionStatus = await callGateStatusAs(serverC, ok.opId);
  check("(unresolved-session — precondition) the op is still resolvable (gate_status itself doesn't require the caller's OWN session to exist)",
    unresolvedSessionStatus.state === "settled");
  check("(unresolved-session — THE 2nd FIX) outputFile is REDACTED even though the caller's own project could not be resolved at all — fails SAFE, not open",
    unresolvedSessionStatus.outputFile === undefined,
    () => JSON.stringify(unresolvedSessionStatus.outputFile));
  check("(unresolved-session) outputTail is still untouched (this fix is outputFile-only, same as every other case)",
    unresolvedSessionStatus.outputTail === "shipping\n");
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_status's manager surface stays genuinely unscoped (a foreign project's real op still resolves, never silently hidden) while outputFile — the absolute host path card a16c580b added — is redacted specifically for a cross-project read, mirroring gate_queue's own redaction precedent; the pre-existing outputTail exposure is deliberately left untouched by this narrower fix; every other field on a foreign read survives intact; AND a failed caller-session lookup at call time (db.getSession returning undefined) fails SAFE to redacted rather than silently un-redacting — mutation-proven against the bare-string pre-fix version, which failed exactly this last check."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
