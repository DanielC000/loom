import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4b2e0146 — managerSessionBarredFrom (d25e4ea7) is consulted at the SESSION-START chokepoint
// (startNew/startManager, see startmanager-reserved-home-refusal.mjs) but NOT at recycleManager's
// fresh-spawn point, NOT at resume(), and checkRepoRebind's own live-session guard only ever scanned
// WORKTREE occupants (a manager has none) — so an ORDINARY project's repoPath could be rebound to a
// reserved/operational-home path (allowed by design, d25e4ea7's own "Do not") while a live manager
// already ran there, and that manager would keep recycling/resuming into a project the start guard
// would refuse. This file proves the three-part fix, plus round 2's (Code Review 70d926b8) follow-up
// corrections (C allowlist, D):
//
//   (A) checkRepoRebind (projects/rebind.ts) now refuses rebinding an ORDINARY project's repoPath to a
//       target `managerSessionBarredFrom` would flag WHILE a live manager session exists for that
//       project — naming the live manager session(s), unconditionally (no humanAuthorized override,
//       same structural-safety posture as its sibling live-worktree-session gate). Once the project has
//       NO live manager, the SAME rebind target is allowed (this gate is scoped to the live-manager
//       hazard, not a blanket "never point an ordinary project at LOOM_HOME" rule — d25e4ea7 deliberately
//       left that broader rule out of scope).
//   (B) recycleManager refuses BEFORE any teardown/insert when its project has since become barred —
//       the predecessor is left completely untouched (still live, no successor row minted AT ALL, unlike
//       a post-insert pre-spawn throw) — and files a durable `manager_session_barred` event.
//   (C) resume() refuses the SAME way for every caller (manual/boot/wake/rate-limit all funnel through
//       this one method) — the manager's own live-at-call-time worker sessions are named in the filed
//       event's `liveWorkerIds`, since resume() cannot itself stop or reparent them; they are left
//       exactly as found (never touched) for a human/Lead to see and act on. (C allowlist) resume()'s
//       thrown message also survives normalizeResumeOneResult's RESUME_KNOWN_SAFE_REASONS allowlist
//       (orchestration/resume-nudge.ts) verbatim, instead of being silently rewritten to the generic
//       fallback in fleet_resume_failed/the Lead's nudge/manager_crash_resume_failed.
//   (D) recycle_me (the MCP tool wrapper, mcp/orchestration.ts) returns an ACTIONABLE message when it
//       hits the bar — not the bare start-refusal text — naming that recycling will keep being refused
//       and pointing at end_me/human-escalation as the caller's options; an unrelated recycle_me error
//       is left unrewritten.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/onExit seam, mirroring resume-refuses-retired-recycle-successor.mjs's proven harness).
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-session-barred-recycle-resume-rebind.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-msbrr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "loom-test@example.com");
  git(dir, "config", "user.name", "loom-test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

// tmpHome itself must be a real repo too: gate (A)'s target (tmpHome, the barred path) must clear
// checkRepoRebind's OWN gate (1) (isGitRepo) to prove the live-manager gate — not isGitRepo — is what
// refuses it.
initRepo(tmpHome);

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { checkRepoRebind } = await import("../dist/projects/rebind.js");
const { managerSessionBarredFrom, MANAGER_SESSION_BARRED_ERROR } = await import("../dist/agents/clone-core.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { normalizeResumeOneResult } = await import("../dist/orchestration/resume-nudge.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onReady(id) { db.setReachedReady(id); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const sessions = new SessionService(db, host, new OrchestrationControl());

// Round 2 nit (Code Review 70d926b8): these repos used to be created directly under os.tmpdir() and
// never cleaned up (only tmpHome itself was rmSync'd in `finally`) — a 4-repo leak per run. They're
// descendants of tmpHome, never an ancestor of it, so isLoomHomeOrAncestor (checked above) never flags
// them as barred by virtue of nesting — and the existing `finally` block's `fs.rmSync(tmpHome, ...)`
// now sweeps them for free, so no separate cleanup list is needed.
const testRepoRoot = path.join(tmpHome, "repos");

function seedOrdinaryProject(id) {
  const now = new Date().toISOString();
  const repo = path.join(testRepoRoot, `loom-msbrr-repo-${id}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  initRepo(repo);
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  return { repo, now };
}

try {
  // ==================== (0) POSITIVE/NEGATIVE CONTROL on the predicate itself ====================
  check("(0) control: managerSessionBarredFrom({reserved:true}) is true regardless of repoPath",
    managerSessionBarredFrom({ reserved: true, repoPath: "/anything/at/all" }) === true);
  check("(0) control: managerSessionBarredFrom({reserved:false, repoPath: tmpHome}) is true (ancestor-or-equal LOOM_HOME)",
    managerSessionBarredFrom({ reserved: false, repoPath: tmpHome }) === true);

  // ==================== (A) checkRepoRebind: live-manager gate ====================
  const { repo: repoA } = seedOrdinaryProject("pA");
  const mA = sessions.startManager("pA-mgr");
  host.deliverHook(mA.id, { hook_event_name: "SessionStart", session_id: "eng-mA" });
  writeFakeTranscript(mA.cwd, "eng-mA");
  check("(A pre) mA is live", db.getSession(mA.id)?.processState === "live");

  const blocked = await checkRepoRebind(db, "pA", tmpHome);
  check("(A) checkRepoRebind REFUSES rebinding to a barred target while a live manager exists",
    blocked.ok === false);
  check("(A) the refusal NAMES the live manager session", !!blocked.liveSessions?.some((s) => s.sessionId === mA.id));
  check("(A) the refusal error text also names it", typeof blocked.error === "string" && blocked.error.includes(mA.id));

  // (A negative control 1) the SAME live manager does NOT block a rebind to a NON-barred target.
  const repoA2 = path.join(testRepoRoot, `loom-msbrr-repo-pA2-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  initRepo(repoA2);
  const allowedOrdinaryTarget = await checkRepoRebind(db, "pA", repoA2);
  check("(A control) rebinding to an ORDINARY (non-barred) target is NOT blocked by this gate while the manager is live",
    allowedOrdinaryTarget.ok === true);

  // (A negative control 2) once the manager is no longer live, the barred target is NOT blocked by
  // THIS gate (proving it is scoped to LIVE managers, not "ever had one").
  host.handles.get(mA.id).kill();
  check("(A pre) mA is no longer live", db.getSession(mA.id)?.processState === "exited");
  const noLongerBlocked = await checkRepoRebind(db, "pA", tmpHome);
  check("(A control) the SAME barred target is allowed once no live manager remains",
    noLongerBlocked.ok === true);

  // ==================== (B) recycleManager refuses once its project has become barred ====================
  const { repo: repoB } = seedOrdinaryProject("pB");
  const mB = sessions.startManager("pB-mgr");
  host.deliverHook(mB.id, { hook_event_name: "SessionStart", session_id: "eng-mB" });
  writeFakeTranscript(mB.cwd, "eng-mB");
  const preRecycleSessionCount = db.listAllSessionsIncludingArchived().length;

  db.updateProject("pB", { repoPath: tmpHome }); // simulate an already-barred project (pre-fix rebind, or any future path checkRepoRebind doesn't cover)

  let recycleErr;
  try { await sessions.recycleManager(mB.id, "continuation — must be refused"); } catch (e) { recycleErr = e; }
  check("(B) recycleManager THROWS the dedicated MANAGER_SESSION_BARRED_ERROR wording",
    !!recycleErr && /manager session can never start in this project/.test(recycleErr.message));
  check("(B) the predecessor is completely UNTOUCHED — still processState:'live'",
    db.getSession(mB.id)?.processState === "live");
  check("(B) NO successor row was minted at all (refused before any insert — unlike a post-insert pre-spawn throw)",
    db.listAllSessionsIncludingArchived().length === preRecycleSessionCount);
  check("(B) hasSuccessor(mB) is false", db.hasSuccessor(mB.id) === false);

  const barredEventsB = db.listEventsForSession(mB.id).filter((e) => e.kind === "manager_session_barred");
  check("(B) exactly one manager_session_barred event was filed under the predecessor", barredEventsB.length === 1);
  check("(B) its detail.source is \"recycle\"", barredEventsB[0]?.detail?.source === "recycle");
  check("(B) its detail.projectId/repoPath name the barred project", barredEventsB[0]?.detail?.projectId === "pB" && barredEventsB[0]?.detail?.repoPath === tmpHome);

  // (B negative control) reverting the project to ordinary lets the SAME predecessor recycle successfully.
  db.updateProject("pB", { repoPath: repoB });
  let freshB, recycleErr2;
  try { freshB = await sessions.recycleManager(mB.id, "continuation — now succeeds"); } catch (e) { recycleErr2 = e; }
  check("(B control) once un-barred, recycleManager on the SAME predecessor succeeds",
    !recycleErr2 && !!freshB && freshB.processState === "live");

  // ==================== (C) resume() refuses the same way, naming live workers it cannot itself stop ====================
  const { repo: repoC } = seedOrdinaryProject("pC");
  const mC = sessions.startManager("pC-mgr");
  host.deliverHook(mC.id, { hook_event_name: "SessionStart", session_id: "eng-mC" });
  writeFakeTranscript(mC.cwd, "eng-mC");
  host.handles.get(mC.id).kill(); // -> exited, resumable (mirrors a post-restart row before resume() runs)
  check("(C pre) mC is exited (not live) before resume()", db.getSession(mC.id)?.processState === "exited");

  // A directly-inserted LIVE worker row parented to mC — resume() must never touch it, only report it.
  const nowC = new Date().toISOString();
  db.insertAgent({ id: "pC-worker-agent", projectId: "pC", name: "W", startupPrompt: "W", position: 1, profileId: null });
  db.insertSession({
    id: "wC1", projectId: "pC", agentId: "pC-worker-agent", parentSessionId: mC.id, engineSessionId: "eng-wC1",
    title: null, cwd: repoC, processState: "live", resumability: "resumable", busy: false,
    createdAt: nowC, lastActivity: nowC, lastError: null, role: "worker",
  });

  db.updateProject("pC", { repoPath: tmpHome }); // simulate an already-barred project

  let resumeErr;
  try { sessions.resume(mC.id); } catch (e) { resumeErr = e; }
  check("(C) resume() THROWS the dedicated MANAGER_SESSION_BARRED_ERROR wording",
    !!resumeErr && /manager session can never start in this project/.test(resumeErr.message));
  check("(C) mC's own row is untouched — still processState:'exited' (never flipped to 'live')",
    db.getSession(mC.id)?.processState === "exited");
  check("(C) the live worker row wC1 is UNTOUCHED by the refusal (resume() never stops/reparents it)",
    db.getSession("wC1")?.processState === "live" && db.getSession("wC1")?.parentSessionId === mC.id);

  const barredEventsC = db.listEventsForSession(mC.id).filter((e) => e.kind === "manager_session_barred");
  check("(C) exactly one manager_session_barred event was filed under mC", barredEventsC.length === 1);
  check("(C) its detail.source is \"resume\"", barredEventsC[0]?.detail?.source === "resume");
  check("(C) its detail.liveWorkerIds names the still-live worker wC1 (so it isn't left silently unaccounted-for)",
    Array.isArray(barredEventsC[0]?.detail?.liveWorkerIds) && barredEventsC[0].detail.liveWorkerIds.includes("wC1") && barredEventsC[0].detail.liveWorkerIds.length === 1);

  // (C allowlist) Round 2 — Code Review 70d926b8: resume()'s own thrown MANAGER_SESSION_BARRED_ERROR
  // must survive normalizeResumeOneResult's RESUME_KNOWN_SAFE_REASONS allowlist (orchestration/
  // resume-nudge.ts) verbatim — otherwise fleet_resume_failed/the Lead's [loom:fleet-resume-failure]
  // nudge/manager_crash_resume_failed all silently rewrite it to RESUME_UNKNOWN_REASON_FALLBACK
  // ("unexpected error during resume"), masking a barred-project resume as a generic fault. This
  // assertion FAILS on the pre-fix allowlist (missing the entry) and PASSES once it's added.
  check("(C allowlist) normalizeResumeOneResult keeps MANAGER_SESSION_BARRED_ERROR verbatim, not the generic fallback",
    normalizeResumeOneResult({ ok: false, reason: resumeErr.message }).reason === MANAGER_SESSION_BARRED_ERROR);
  // (C allowlist negative control) an unrecognized/arbitrary reason IS still replaced by the fallback —
  // proves the allowlist discriminates rather than having been widened into a pass-through.
  check("(C allowlist control) an unrecognized reason is still sanitized to the generic fallback",
    normalizeResumeOneResult({ ok: false, reason: "some arbitrary propagated error, never allowlisted" }).reason === "unexpected error during resume");

  // (C negative control) reverting the project to ordinary lets the SAME manager resume successfully.
  db.updateProject("pC", { repoPath: repoC });
  let resumedC, resumeErr2;
  try { resumedC = sessions.resume(mC.id); } catch (e) { resumeErr2 = e; }
  check("(C control) once un-barred, resume() on the SAME manager succeeds",
    !resumeErr2 && !!resumedC && db.getSession(mC.id)?.processState === "live");

  // ==================== (D) recycle_me (MCP tool) returns an ACTIONABLE message when barred ====================
  // Round 2 — Code Review 70d926b8 (suggestion): the bare MANAGER_SESSION_BARRED_ERROR start-refusal text
  // reads like a transient failure to the calling manager. Through the REAL OrchestrationMcpRouter (not a
  // stub SessionService — this exercises the actual mcp/orchestration.ts catch block), recycle_me's error
  // must explain the refusal is permanent for this project, that recycling will keep being refused, and
  // name end_me/escalation as the caller's options.
  const { repo: repoD } = seedOrdinaryProject("pD");
  const mD = sessions.startManager("pD-mgr");
  host.deliverHook(mD.id, { hook_event_name: "SessionStart", session_id: "eng-mD" });
  writeFakeTranscript(mD.cwd, "eng-mD");
  db.updateProject("pD", { repoPath: tmpHome }); // simulate an already-barred project

  const serverD = new OrchestrationMcpRouter(db, sessions).buildServer(mD.id, "manager");
  const [clientTD, serverTD] = InMemoryTransport.createLinkedPair();
  await serverD.connect(serverTD);
  const clientD = new Client({ name: "manager-session-barred-recycle_me-test", version: "0" });
  await clientD.connect(clientTD);
  const rD = JSON.parse(
    (await clientD.callTool({ name: "recycle_me", arguments: { continuationPrompt: "CP — must be refused" } })).content[0].text,
  );
  check("(D) recycle_me still reports an error (not a fabricated success)", typeof rD.error === "string");
  check("(D) the error STILL carries the underlying MANAGER_SESSION_BARRED_ERROR text verbatim",
    rD.error.includes(MANAGER_SESSION_BARRED_ERROR));
  check("(D) the error is now ACTIONABLE: names recycling will keep being refused",
    /recycling will keep being refused/i.test(rD.error));
  check("(D) the error names end_me as an option", /end_me/.test(rD.error));
  check("(D) the error names escalating to a human/the Lead", /human|lead/i.test(rD.error));
  check("(D) the predecessor is completely UNTOUCHED — still processState:'live' (recycle_me did not close it)",
    db.getSession(mD.id)?.processState === "live");

  // (D negative control) an UNRELATED recycleManager failure reason is NOT given this actionable rewrite —
  // proves the rewrite is keyed on the exact MANAGER_SESSION_BARRED_ERROR text, not a blanket catch-all.
  db.updateProject("pD", { repoPath: repoD }); // un-bar pD so the barred-project branch can't fire instead
  const mD2 = sessions.startManager("pD-mgr");
  host.deliverHook(mD2.id, { hook_event_name: "SessionStart", session_id: "eng-mD2" });
  writeFakeTranscript(mD2.cwd, "eng-mD2");
  const serverD2 = new OrchestrationMcpRouter(db, sessions).buildServer(mD2.id, "manager");
  const [clientTD2, serverTD2] = InMemoryTransport.createLinkedPair();
  await serverD2.connect(serverTD2);
  const clientD2 = new Client({ name: "manager-session-barred-recycle_me-control", version: "0" });
  await clientD2.connect(clientTD2);
  const rD2 = JSON.parse((await clientD2.callTool({ name: "recycle_me", arguments: {} })).content[0].text);
  check("(D control) an unrelated recycle_me validation error (missing continuationPrompt) is NOT rewritten",
    typeof rD2.error === "string" && rD2.error.includes("continuationPrompt") && !/recycling will keep being refused/i.test(rD2.error));
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — checkRepoRebind refuses rebinding an ordinary project to a barred target while it has a live manager (naming it, and only while live); recycleManager and resume() both refuse a fresh-spawn/resume once their project has become barred, leaving the affected row(s) completely untouched and filing a durable manager_session_barred event (resume()'s also naming any live workers it cannot itself stop); every refusal is reversible once the project is un-barred again; resume()'s thrown message survives the resume-nudge allowlist verbatim (round 2); and recycle_me's MCP-facing error is now actionable rather than the bare start-refusal text (round 2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
