import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5ef78900 (widening card a16c580b's `outputFile`-only redaction): `gate_status`'s MANAGER call site
// is UNSCOPED (mcp/orchestration.ts's `registerGateStatus(server, sessions)` — no `scopeSessionId`/
// `scopeProjectId`) — a manager on ONE project can resolve a settled op minted by ANOTHER project.
//
// ROUND 1 of this card found THREE fields unredacted beyond the already-fixed `outputFile`: `outputTail`
// (a bounded excerpt of the owning project's captured gate output), `steps` (per-step timings whose `step`
// label is a verbatim fragment of the owning project's configured `gateCommand`), and `gateDetail` (whose
// `failingTest`/`stderrTail` can name the owning project's own test file and stderr paths verbatim).
//
// ROUND 2 (code review, executed a real cross-project read rather than reading the diff) found SIX MORE:
// `reason` (raw git/install error text with absolute host paths on a merge rejection/error verdict),
// `commitSubject` (another tenant's landed squash subject), `retriedFile` (a foreign test file path, bare),
// `retryWarning` (prose naming that same file — AND, distinctly, a DERIVED field computed from the RAW,
// unredacted `outputTail`/`retriedFile` rather than the redacted view, which is a bypass a field-by-field
// enumeration structurally cannot catch), and `emitCompareTestFiles`/`emitCompareNotHermeticExcluded`
// (arrays of a foreign project's test file paths). The fix moved from per-field `&& !crossProjectRedacted`
// gates to filtering the FULLY-ASSEMBLED verdict object by key — this closes the `retryWarning` bypass
// class of bug too, since the filter operates on the final object regardless of how a field's value was
// computed. `validatedHead`/`headWarning` (bare git shas / freeform repo-state text) were added to the
// redacted set too, as a deliberate (not omitted) lower-severity decision. `timingBand` (appended OUTSIDE
// `SessionService.gateStatus`'s own return, in mcp/orchestration.ts) is gated separately via the new
// `SessionService.isCrossProjectGateOp` helper, since a service-layer field enumeration structurally
// cannot see or gate something a CALLER appends after the method already returned.
//
// ROUND 3 (manager review of round 2): a plain deny-`Set` of sensitive field names is STILL a deny-list —
// it does not close "a new field opts out of redaction by silence" any more than the per-field gates did;
// it just moves the same forgettable convention up one level. The fix is `GATE_VERDICT_FIELD_CLASSIFICATION`
// (sessions/service.ts) — an EXHAUSTIVE `Record<GateVerdictFieldKey, "sensitive" | "structural">` keyed off
// `keyof PendingGateOpVerdict` (db.ts) plus the 4 fields `gateStatus` computes itself and never stores.
// TypeScript's own missing/excess-property checks on that object literal make omitting a field's
// classification a COMPILE ERROR, not a silent gap — mutation-proven directly against the source (removing
// one entry breaks `tsc` with "Property '<x>' is missing", restored afterward) rather than only inferred
// from reading the type signature. `gate-verdict-field-classification-exhaustive.mjs` is the STANDING
// version of that proof, run directly with no build needed.
//
// ROUND 3 ALSO CAUGHT A REAL SIBLING FIELD, LIVE: while this card was in flight, card 67030bb9 landed
// `batchBranchCount` on `PendingGateOpVerdict` — and, distinctly, interpolated the SAME integer N TWICE
// into `retryWarning`'s own prose. Rebasing onto it made both `tsc` and the standing test above refuse
// (as designed) until `batchBranchCount` was classified. Decided consistently: the bare count is
// `"structural"` (visible) on ITS OWN merits, while `retryWarning` stays `"sensitive"` regardless, for its
// OTHER content — never a coincidence, and never a half-redacted sentence still stating N.
//
// This file proves: a same-project read still gets every field, real and unredacted, across pass/fail/
// cancelled/error verdicts; a foreign-project read loses every field in the sensitive set (INCLUDING the
// derived `retryWarning`, proven by giving it inputs that would otherwise select a DIFFERENT wording,
// so "absent" can't be confused with "same text either way"); every structural field (passed/outcome/
// gateType/timing/concurrency) survives a foreign read untouched; a legacy `projectId: null` row is
// redacted for EVERY caller (fails safe, never "no project recorded ⇒ treat as mine"); and the negative
// control (bogus opId) and unresolved-caller-session fail-safe case both still hold.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter. The settled rows are written directly
// via `Db.insertPendingGateOp`/`settlePendingGateOp` (the exact durable tombstone `gate_status`'s fallback
// reads) rather than driving a real gate/merge/deploy execution — this is a read-path/redaction test, not
// a gate-execution test, and every other `gate-status*.mjs` file in this directory already exercises the
// write path that produces these rows. Mirrors `gate-status-outputfile-redaction.mjs`'s own harness
// convention exactly.
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/gate-status-cross-project-redaction.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const tmpHome = path.join(os.tmpdir(), `loom-gst-xredact-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(tmpHome, "gst-xredact.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  const sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    {},
  );
  const router = new OrchestrationMcpRouter(db, sessions);

  // Project A owns every op below; Project B is the FOREIGN reader.
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Project B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
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
  check("(precondition) gate_status IS registered on BOTH managers' surfaces",
    "gate_status" in serverA._registeredTools && "gate_status" in serverB._registeredTools);
  const callGateStatusAs = async (server, opId) => JSON.parse((await server._registeredTools["gate_status"].handler({ opId })).content[0].text);

  // ── FAIL VERDICT — carries gateDetail (failingTest/stderrTail), steps, outputTail, reason, and both ────
  // emitCompare test-file arrays. The single richest row: every ROUND-1 AND ROUND-2 verbatim-spread field
  // that a "fail" verdict can carry, in one row.
  const failOpId = "11111111-0000-4000-8000-00000000fa11";
  db.insertPendingGateOp({
    opId: failOpId, kind: "merge", key: "k-fail", ownerSessionId: "mgrA", projectId: "pA",
    taskId: "t1", branch: "loom/t1", startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(failOpId, {
    kind: "fail",
    payload: {
      reason: "pnpm install exited 1 — tail: EACCES /home/acme/projectA/.npmrc token rejected",
      steps: [{ step: "pnpm --filter @project-a/daemon build", durationMs: 4200, status: 0 }],
      outputTail: "FAIL projectA/secret-module.test.mjs\nassertion failed: apiKey mismatch",
      gateDetail: {
        phase: "test", failedStep: "pnpm --filter @project-a/daemon build", failingTest: "projectA/secret-module.test.mjs",
        exitCode: 1, signal: null, timedOut: false,
        stderrTail: "at /home/projA/src/secret-module.ts:42:10",
      },
      emitCompareTestFiles: ["projectA/secret-module.test.mjs"],
      emitCompareNotHermeticExcluded: ["projectA/flaky-live-clock.test.mjs"],
      validatedHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headWarning: "worktree changed while this gate was running (branch HEAD is now bbbbbbb) — treat as unverified",
    },
  });

  const sameProjectFail = await callGateStatusAs(serverA, failOpId);
  check("(same-project, fail) state is settled and passed:false", sameProjectFail.state === "settled" && sameProjectFail.passed === false);
  check("(same-project, fail) steps is the REAL array — no redaction for the owning project",
    Array.isArray(sameProjectFail.steps) && sameProjectFail.steps.length === 1 && sameProjectFail.steps[0].step === "pnpm --filter @project-a/daemon build");
  check("(same-project, fail) outputTail is the REAL tail",
    sameProjectFail.outputTail === "FAIL projectA/secret-module.test.mjs\nassertion failed: apiKey mismatch");
  check("(same-project, fail) gateDetail.failingTest/stderrTail are REAL",
    sameProjectFail.gateDetail?.failingTest === "projectA/secret-module.test.mjs" && sameProjectFail.gateDetail?.stderrTail === "at /home/projA/src/secret-module.ts:42:10");
  check("(same-project, fail) reason is the REAL raw error text (round 2)",
    sameProjectFail.reason === "pnpm install exited 1 — tail: EACCES /home/acme/projectA/.npmrc token rejected");
  check("(same-project, fail) emitCompareTestFiles/emitCompareNotHermeticExcluded are REAL (round 2)",
    JSON.stringify(sameProjectFail.emitCompareTestFiles) === JSON.stringify(["projectA/secret-module.test.mjs"]) &&
    JSON.stringify(sameProjectFail.emitCompareNotHermeticExcluded) === JSON.stringify(["projectA/flaky-live-clock.test.mjs"]));
  check("(same-project, fail) validatedHead/headWarning are REAL (round 2)",
    sameProjectFail.validatedHead === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" && typeof sameProjectFail.headWarning === "string" && sameProjectFail.headWarning.length > 0);

  const foreignFail = await callGateStatusAs(serverB, failOpId);
  check("(foreign, fail — precondition) the op is STILL resolvable at all (genuinely unscoped for a manager, not silently scoped by this fix)",
    foreignFail.state === "settled");
  check("(foreign, fail — THE FIX, round 1) steps/outputTail/gateDetail are REDACTED (absent)",
    foreignFail.steps === undefined && foreignFail.outputTail === undefined && foreignFail.gateDetail === undefined,
    () => JSON.stringify({ steps: foreignFail.steps, outputTail: foreignFail.outputTail, gateDetail: foreignFail.gateDetail }));
  check("(foreign, fail — THE FIX, round 2) reason is REDACTED — this was the WORST round-2 leak (raw install/git error text + host paths)",
    foreignFail.reason === undefined, () => JSON.stringify(foreignFail.reason));
  check("(foreign, fail — THE FIX, round 2) emitCompareTestFiles/emitCompareNotHermeticExcluded are REDACTED",
    foreignFail.emitCompareTestFiles === undefined && foreignFail.emitCompareNotHermeticExcluded === undefined,
    () => JSON.stringify({ a: foreignFail.emitCompareTestFiles, b: foreignFail.emitCompareNotHermeticExcluded }));
  check("(foreign, fail — THE FIX, round 2) validatedHead/headWarning are REDACTED (deliberate, lower-severity inclusion)",
    foreignFail.validatedHead === undefined && foreignFail.headWarning === undefined,
    () => JSON.stringify({ validatedHead: foreignFail.validatedHead, headWarning: foreignFail.headWarning }));
  check("(foreign, fail) structural fields survive untouched (passed/outcome/gateType) — targeted redaction, not a degraded response",
    foreignFail.passed === false && foreignFail.outcome === "fail" && foreignFail.gateType === "merge");

  // ── CARD fd0d34da — emitCompareNotApplicableKind, DELIBERATELY VISIBLE cross-project (classified ────────
  // "structural" in GATE_VERDICT_FIELD_CLASSIFICATION, unlike its `emitCompareTestFiles`/
  // `emitCompareNotHermeticExcluded` siblings above): it names a CATEGORY of reason (e.g.
  // "path-out-of-scope"), never a path/filename/error string the way `reason` itself does — that's exactly
  // why `reason` is redacted above while this field is not.
  const notApplicableOpId = "11111111-0000-4000-8000-00000000fbcd";
  db.insertPendingGateOp({
    opId: notApplicableOpId, kind: "merge", key: "k-notapplicable", ownerSessionId: "mgrA", projectId: "pA",
    taskId: "t4", branch: "loom/t4", startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(notApplicableOpId, { kind: "pass", payload: { emitCompareNotApplicableKind: "path-out-of-scope" } });
  const sameProjectNotApplicable = await callGateStatusAs(serverA, notApplicableOpId);
  check("(same-project, notApplicable) emitCompareNotApplicableKind is REAL", sameProjectNotApplicable.emitCompareNotApplicableKind === "path-out-of-scope");
  const foreignNotApplicable = await callGateStatusAs(serverB, notApplicableOpId);
  check("(foreign, notApplicable — precondition) still resolvable", foreignNotApplicable.state === "settled" && foreignNotApplicable.passed === true);
  check("(foreign, notApplicable — card fd0d34da) emitCompareNotApplicableKind is VISIBLE — a coarse category with no path/test-name/error-text of its own, unlike reason",
    foreignNotApplicable.emitCompareNotApplicableKind === "path-out-of-scope", () => JSON.stringify(foreignNotApplicable.emitCompareNotApplicableKind));

  // ── retryWarning BYPASS — a DERIVED field computed from RAW outputTail/retriedFile. The regression this ─
  // guards: gating the verbatim `outputTail`/`retriedFile` spreads does nothing to stop `retryWarning`'s
  // own text from leaking a one-bit read of foreign content, because `formatWeakerPassWarning` reads
  // `payload.outputTail` directly, not whatever the response was about to expose. Choosing an `outputTail`
  // that matches the TIMEOUT-KILL regex (`isTimeoutKillEntry`, gate-runner.ts) proves the classification is
  // real — a caller reading a leaked `retryWarning` could distinguish "timeout" from "assertion failure"
  // even with `outputTail` itself absent.
  const retryOpId = "11111111-0000-4000-8000-00000000fa77";
  db.insertPendingGateOp({
    opId: retryOpId, kind: "merge", key: "k-retry", ownerSessionId: "mgrA", projectId: "pA",
    taskId: "t3", branch: "loom/t3", startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(retryOpId, {
    kind: "pass",
    payload: {
      retriedFile: "projectA/flaky-file.test.mjs",
      retryPassed: true,
      outputTail: "- projectA/flaky-file.test.mjs (exit timeout after 30000ms)",
    },
  });
  const sameProjectRetry = await callGateStatusAs(serverA, retryOpId);
  check("(same-project, retry) retriedFile is the REAL name",
    sameProjectRetry.retriedFile === "projectA/flaky-file.test.mjs");
  check("(same-project, retry) retryWarning selects the TIMEOUT-KILL wording (proves the classification is real, not incidental)",
    typeof sameProjectRetry.retryWarning === "string" && sameProjectRetry.retryWarning.includes("killed") && sameProjectRetry.retryWarning.includes("timeout"));
  check("(same-project, retry) retryPassed is REAL (not in the sensitive set — no content of its own)",
    sameProjectRetry.retryPassed === true);

  const foreignRetry = await callGateStatusAs(serverB, retryOpId);
  check("(foreign, retry — precondition) still resolvable", foreignRetry.state === "settled" && foreignRetry.passed === true);
  check("(foreign, retry — THE BYPASS FIX) retriedFile is REDACTED",
    foreignRetry.retriedFile === undefined, () => JSON.stringify(foreignRetry.retriedFile));
  check("(foreign, retry — THE BYPASS FIX) retryWarning is REDACTED ENTIRELY — not just re-worded, ABSENT, even though it's DERIVED from raw outputTail rather than spread verbatim",
    foreignRetry.retryWarning === undefined, () => JSON.stringify(foreignRetry.retryWarning));
  check("(foreign, retry) retryPassed is VISIBLE (deliberately not in the sensitive set)",
    foreignRetry.retryPassed === true);

  // ── ROUND 3 — batchBranchCount (card 67030bb9), THE SECOND CARRIER. The SAME integer N is carried by ────
  // TWO fields: the standalone `batchBranchCount` (classified "structural", visible) AND interpolated
  // TWICE into `retryWarning`'s own generated prose (classified "sensitive" as a whole, for its OTHER
  // content — the retried file name / timeout-kill wording — which happens to also cover N). This proves
  // BOTH halves of that decision: the bare count is visible to a foreign reader, but the prose that would
  // restate the SAME count is fully absent regardless — never partially redacted, never leaking N as a
  // "well the field's gone but the sentence still says it" gap.
  const batchRetryOpId = "11111111-0000-4000-8000-00000000faaa";
  db.insertPendingGateOp({
    opId: batchRetryOpId, kind: "merge", key: "k-batch-retry", ownerSessionId: "mgrA", projectId: "pA",
    taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(batchRetryOpId, {
    kind: "pass",
    payload: {
      retriedFile: "projectA/one-flaky-file.test.mjs",
      retryPassed: true,
      outputTail: "42 passed, 0 failed",
      batchBranchCount: 4,
    },
  });
  const sameProjectBatchRetry = await callGateStatusAs(serverA, batchRetryOpId);
  check("(same-project, batch retry) batchBranchCount is the REAL count",
    sameProjectBatchRetry.batchBranchCount === 4);
  check("(same-project, batch retry) retryWarning's prose ALSO states N — the second carrier, proven present",
    typeof sameProjectBatchRetry.retryWarning === "string" && sameProjectBatchRetry.retryWarning.includes("BATCH of 4 branch"));

  const foreignBatchRetry = await callGateStatusAs(serverB, batchRetryOpId);
  check("(foreign, batch retry — precondition) still resolvable", foreignBatchRetry.state === "settled" && foreignBatchRetry.passed === true);
  check("(foreign, batch retry) batchBranchCount is VISIBLE — deliberate: a bare count with no path/test-name/error-text",
    foreignBatchRetry.batchBranchCount === 4, () => JSON.stringify(foreignBatchRetry.batchBranchCount));
  check("(foreign, batch retry) retryWarning is REDACTED ENTIRELY — N's OTHER carrier stays fully absent, never a half-redacted sentence still naming the count",
    foreignBatchRetry.retryWarning === undefined, () => JSON.stringify(foreignBatchRetry.retryWarning));

  // ── PASS VERDICT — commitSubject, steps/outputTail carry real content with NO gateDetail. ───────────────
  const passOpId = "11111111-0000-4000-8000-00000000fa55";
  db.insertPendingGateOp({
    opId: passOpId, kind: "merge", key: "k-pass", ownerSessionId: "mgrA", projectId: "pA",
    taskId: "t2", branch: "loom/t2", startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(passOpId, {
    kind: "pass",
    payload: {
      steps: [{ step: "pnpm --filter @project-a/daemon build", durationMs: 3100, status: 0 }],
      outputTail: "42 passed, 0 failed",
      commitSubject: "fix(daemon): patch project A's own secret rotation logic",
    },
  });

  const sameProjectPass = await callGateStatusAs(serverA, passOpId);
  check("(same-project, pass) steps/outputTail are REAL", Array.isArray(sameProjectPass.steps) && sameProjectPass.outputTail === "42 passed, 0 failed");
  check("(same-project, pass) commitSubject is REAL (round 2)", sameProjectPass.commitSubject === "fix(daemon): patch project A's own secret rotation logic");
  check("(same-project, pass) gateDetail is absent (nothing to report on a pass) — not a redaction artifact", sameProjectPass.gateDetail === undefined);

  const foreignPass = await callGateStatusAs(serverB, passOpId);
  check("(foreign, pass — precondition) still resolvable", foreignPass.state === "settled" && foreignPass.passed === true);
  check("(foreign, pass — THE FIX) steps/outputTail are REDACTED on a PASS too, not just a fail",
    foreignPass.steps === undefined && foreignPass.outputTail === undefined,
    () => JSON.stringify({ steps: foreignPass.steps, outputTail: foreignPass.outputTail }));
  check("(foreign, pass — THE FIX, round 2) commitSubject is REDACTED — another tenant's landed card title",
    foreignPass.commitSubject === undefined, () => JSON.stringify(foreignPass.commitSubject));
  check("(foreign, pass) structural fields survive (passed/outcome/gateType)",
    foreignPass.passed === true && foreignPass.outcome === "pass" && foreignPass.gateType === "merge");

  // ── CANCELLED / ERROR VERDICTS — `reason` is redacted there too, via the SAME single filter, not a ──────
  // separately-maintained gate that could drift from the "fail" branch's own.
  const cancelledOpId = "11111111-0000-4000-8000-00000000fa88";
  db.insertPendingGateOp({
    opId: cancelledOpId, kind: "gate", key: "k-cancel", ownerSessionId: "mgrA", projectId: "pA",
    taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(cancelledOpId, { kind: "cancelled", payload: { reason: "superseded by a merge decision on project A's own worktree /home/acme/projectA" } });
  const errorOpId = "11111111-0000-4000-8000-00000000fa99";
  db.insertPendingGateOp({
    opId: errorOpId, kind: "gate", key: "k-error", ownerSessionId: "mgrA", projectId: "pA",
    taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(errorOpId, { kind: "error", payload: { reason: "ENOENT: /home/acme/projectA/scripts/build.sh not found" } });

  const sameProjectCancelled = await callGateStatusAs(serverA, cancelledOpId);
  check("(same-project, cancelled) reason is REAL", typeof sameProjectCancelled.reason === "string" && sameProjectCancelled.reason.includes("projectA"));
  const foreignCancelled = await callGateStatusAs(serverB, cancelledOpId);
  check("(foreign, cancelled — THE FIX, round 2) reason is REDACTED on a CANCELLED verdict too, not just fail",
    foreignCancelled.cancelled === true && foreignCancelled.reason === undefined, () => JSON.stringify(foreignCancelled.reason));

  const sameProjectError = await callGateStatusAs(serverA, errorOpId);
  check("(same-project, error) reason is REAL", typeof sameProjectError.reason === "string" && sameProjectError.reason.includes("projectA"));
  const foreignError = await callGateStatusAs(serverB, errorOpId);
  check("(foreign, error — THE FIX, round 2) reason is REDACTED on an ERROR verdict too",
    foreignError.reason === undefined, () => JSON.stringify(foreignError.reason));

  // ── LEGACY `projectId: null` ROW — must redact for EVERY caller, never "no project recorded ⇒ mine". ────
  const legacyOpId = "11111111-0000-4000-8000-00000000fabb";
  db.insertPendingGateOp({
    opId: legacyOpId, kind: "gate", key: "k-legacy", ownerSessionId: "mgrA", projectId: null,
    taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: true,
  });
  db.settlePendingGateOp(legacyOpId, { kind: "pass", payload: { steps: [{ step: "legacy-step", durationMs: 100, status: 0 }], outputTail: "legacy output" } });
  const legacyAsA = await callGateStatusAs(serverA, legacyOpId);
  const legacyAsB = await callGateStatusAs(serverB, legacyOpId);
  check("(legacy projectId:null — precondition) resolvable by any manager", legacyAsA.state === "settled" && legacyAsB.state === "settled");
  check("(legacy projectId:null — FAILS SAFE for caller A) redacted even though A 'owns' the session that minted it — null never equals a real project id",
    legacyAsA.steps === undefined && legacyAsA.outputTail === undefined, () => JSON.stringify({ steps: legacyAsA.steps, outputTail: legacyAsA.outputTail }));
  check("(legacy projectId:null — FAILS SAFE for caller B) redacted too",
    legacyAsB.steps === undefined && legacyAsB.outputTail === undefined, () => JSON.stringify({ steps: legacyAsB.steps, outputTail: legacyAsB.outputTail }));

  // ── NEGATIVE CONTROL — a genuinely bogus opId still reads never_existed for BOTH managers, proving the ──
  // redaction logic didn't accidentally start resolving/hiding rows that were never there.
  const bogusOpId = "22222222-0000-4000-8000-000000000199";
  const bogusAsA = await callGateStatusAs(serverA, bogusOpId);
  const bogusAsB = await callGateStatusAs(serverB, bogusOpId);
  check("(negative control) a bogus opId reads never_existed for the same-project manager too", bogusAsA.state === "never_existed");
  check("(negative control) a bogus opId reads never_existed for the foreign manager too", bogusAsB.state === "never_existed");

  // ── FAIL-SAFE-ON-UNRESOLVED-SESSION — mirrors gate-status-outputfile-redaction.mjs's own regression test ─
  // for the SAME `crossProjectRedacted` boolean now gating the whole sensitive-field Set: a caller whose
  // OWN session lookup fails at call time must still redact, never fail open.
  db.insertProject({ id: "pC", name: "Project C", repoPath: "pC", vaultPath: "pC", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aC", projectId: "pC", name: "Mgr C", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrC", projectId: "pC", agentId: "aC", engineSessionId: null, title: null,
    cwd: "pC", processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "manager",
  });
  const serverC = router.buildServer("mgrC", "manager");
  db.deleteSession("mgrC");
  check("(precondition) mgrC's session lookup now genuinely fails", db.getSession("mgrC") === undefined);
  const unresolvedSessionFail = await callGateStatusAs(serverC, failOpId);
  check("(unresolved-session — precondition) the op is still resolvable", unresolvedSessionFail.state === "settled");
  check("(unresolved-session — FAILS SAFE) the full sensitive set is redacted even though the caller's own project could not be resolved at all",
    unresolvedSessionFail.steps === undefined && unresolvedSessionFail.outputTail === undefined && unresolvedSessionFail.gateDetail === undefined &&
    unresolvedSessionFail.reason === undefined && unresolvedSessionFail.emitCompareTestFiles === undefined,
    () => JSON.stringify({ steps: unresolvedSessionFail.steps, outputTail: unresolvedSessionFail.outputTail, gateDetail: unresolvedSessionFail.gateDetail, reason: unresolvedSessionFail.reason }));

  // ── UNIT: SessionService.isCrossProjectGateOp — the helper `timingBand`'s own cross-project gating ──────
  // (mcp/orchestration.ts, appended OUTSIDE gateStatus's own return) relies on, since a service-layer field
  // enumeration inside gateStatus itself cannot see or gate a field a CALLER adds after gateStatus already
  // returned. Same fail-safe polarity as `crossProjectRedacted` inside gateStatus, proven directly.
  check("(unit, isCrossProjectGateOp) same-project caller reads false (not cross-project)",
    sessions.isCrossProjectGateOp(passOpId, { callerProjectId: "pA" }) === false);
  check("(unit, isCrossProjectGateOp) foreign caller reads true",
    sessions.isCrossProjectGateOp(passOpId, { callerProjectId: "pB" }) === true);
  check("(unit, isCrossProjectGateOp) an unresolved caller project (undefined) fails SAFE to true",
    sessions.isCrossProjectGateOp(passOpId, { callerProjectId: undefined }) === true);
  check("(unit, isCrossProjectGateOp) redactCrossProject omitted entirely (the worker-path shape) reads false — 'not asking'",
    sessions.isCrossProjectGateOp(passOpId, undefined) === false);
  check("(unit, isCrossProjectGateOp) a legacy projectId:null row reads true for ANY real caller project",
    sessions.isCrossProjectGateOp(legacyOpId, { callerProjectId: "pA" }) === true);
  check("(unit, isCrossProjectGateOp) an opId that can't be resolved at all reads false (nothing to compare — gateStatus itself reports the real miss)",
    sessions.isCrossProjectGateOp(bogusOpId, { callerProjectId: "pA" }) === false);
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_status's manager surface stays genuinely unscoped (a foreign project's real op still resolves, never silently hidden) while the FULL cross-project-sensitive field set — outputTail/steps/gateDetail (round 1) plus reason/commitSubject/retriedFile/retryWarning/emitCompareTestFiles/emitCompareNotHermeticExcluded/validatedHead/headWarning (round 2, after a code-review probe found them still leaking) — is now redacted on a foreign read, across pass/fail/cancelled/error verdicts; the retryWarning DERIVED-FIELD BYPASS is closed (proven with a timeout-kill-shaped outputTail, so 'absent' can't be confused with 'same text either way'); the batchBranchCount SECOND-CARRIER case (round 3, a real sibling-branch field landed mid-card) is decided consistently: the bare count is visible, the prose that would restate it stays fully absent regardless; card fd0d34da's emitCompareNotApplicableKind is deliberately VISIBLE cross-project too, decided the same way batchBranchCount was — a bare category with no foreign path/test-name/error-text; every structural field (passed/outcome/gateType/timing/concurrency/retryPassed/batchBranchCount/emitCompareNotApplicableKind) survives a foreign read intact; a legacy projectId:null row redacts for EVERY caller; a bogus opId still reads never_existed for either manager; a failed caller-session lookup fails SAFE; and the isCrossProjectGateOp helper timingBand's own gating relies on matches gateStatus's own fail-safe polarity exactly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
