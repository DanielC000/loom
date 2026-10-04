import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 963462f5 — persist a forced-plain flag so resume/fork/harnessDrainStatus keep a human's plain
// choice exactly, instead of re-deriving it from the agent's CURRENT profile (f900237d's interim rule,
// `role === null && profileConfersSpawnableRole(agent)`). Residuals f900237d itself named but deferred:
//
// (1) harnessDrainStatus (sessions/service.ts): the interim rule was NEVER even consulted there (the
//     call passed no forcePlain arg at all) — a forced-plain row on a worker-profile agent, under a
//     project default-harness of codex for "worker", mis-resolved its "wanted" harness as if it were a
//     real worker row, and sat in `pending` forever (nothing ever respawns a plain row with a different
//     role). PROVES: RED on pre-fix code (the call with no 4th arg), GREEN once `effectiveForcePlain` is
//     threaded through.
// (2) gen-393 scope addition: a forcePlain start on a SPAWNABLE-profile agent whose profile is LATER
//     reassigned (or edited to role-null/clamped) regains the NEW profile's allowDelta on resume/fork,
//     because the interim rule re-derives from the agent's CURRENT profile, not original intent. PROVES:
//     resume() and forkSession() must NOT layer the reassigned profile's allowDelta for a session whose
//     PERSISTED forcedPlain is true, regardless of what the agent's profile looks like now.
// (3) the persisted column itself: startNew always writes a DEFINITE true/false (never leaves a fresh
//     row ambiguous); forkSession stamps the RESOLVED value onto the new row (converging a legacy-null
//     source's ambiguity, never copying it forward) when the agent still exists, and falls back to a raw
//     copy of the source's (possibly-null) value when the agent is missing.
// (4) Round 2 MAJOR (Code Review c47b73d6 of 65d3c37c): `effectiveForcePlain` must combine `forcedPlain`
//     with the interim rule via OR, never `??` — a definite `false` (a non-forced role-null row, e.g.
//     from a null-role profile) must NOT suppress the interim rule's own check. `??` let such a row,
//     once its agent was LATER reassigned to a spawnable profile, adopt that NEW profile's allowDelta/
//     role pin and reappear as harness-drain pending. `forcedPlain` is sticky-TRUE ONLY.
//
// NEGATIVE CONTROLS throughout: a REAL (non-forced) worker-role row must keep resolving its CURRENT
// profile/harness default — forced-plain persistence must never freeze that.
//
// DETERMINISTIC + CLAUDE- AND CODEX-FREE + NETWORK-FREE, same hermetic shape as
// resume-fork-plain-role-not-widened.mjs: isolated LOOM_HOME + sandboxed HOME, a REAL Db + SessionService
// driven against a FAKE pty via PtyHost's createPty() seam — no real claude, no daemon, no network, no
// git repo needed. This project deliberately resolves a real "worker" role to harness "codex" (its own
// default, below) to make the harnessDrainStatus mismatch deterministic — `createSeamHost` fakes
// `createPty` ONLY, so ANY call that would spawn a codex-harness session LIVE (startNew/resume/fork on a
// row that resolves to harness "codex") is a real-process-spawn hazard, not merely a hypothetical one: an
// earlier version of this file did exactly that and spawned the real installed `codex.CMD` three times
// across repeated test runs before this was caught in review. The SeamHost below throws on
// `createCodexPty` as a backstop, and every LIVE spawn/resume/fork call in this file is verified to
// resolve to harness "claude"/undefined (never "codex") — any scenario that NEEDS a codex-harness ROW is
// seeded directly via `db.insertSession`, never reached through a live call.
//
// Run: 1) build (turbo builds shared first), 2) node test/forced-plain-persisted.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-fpp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const repo = path.join(os.tmpdir(), `loom-fpp-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const now = new Date().toISOString();

const db = new Db();
// Project default-harness: codex for role "worker" — makes a harnessDrainStatus mismatch deterministic.
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: { harness: { default: "codex", scope: "workers" } }, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profNullRoleAllow", name: "Null-role w/ allow", role: null, description: "", allowDelta: ["Bash(echo REASSIGNED_OK:*)"], skills: null, model: null, icon: null });
db.insertAgent({ id: "agSwap", projectId: "p1", name: "Agent", startupPrompt: "P", position: 0, profileId: "profWorker" });
db.insertAgent({ id: "agRealWorker", projectId: "p1", name: "Real Worker Agent", startupPrompt: "P", position: 1, profileId: "profWorker" });
// Round 2 MAJOR fixture: a profile whose role is null at start (so a role-omitted start honestly lands
// role-null, forcedPlain:false — NOT a human's forced-plain choice), later reassigned to a DIFFERENT
// spawnable profile carrying its OWN distinct allowDelta marker.
db.insertProfile({ id: "profNullRoleHonest", name: "Null-role at start", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorkerDrift", name: "Worker Rig (drift target)", role: "worker", description: "", allowDelta: ["Bash(echo DRIFT_OK:*)"], skills: null, model: null, icon: null });
db.insertAgent({ id: "agDrift", projectId: "p1", name: "Drift Agent", startupPrompt: "P", position: 2, profileId: "profNullRoleHonest" });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  // Belt and braces (found during review, card 963462f5): `createSeamHost` fakes `createPty` ONLY —
  // `PtyHost.spawn()` dispatches a codex-harness session to `createCodexPty` BEFORE it ever reaches
  // `createPty` (host.ts: `if (opts.harness === "codex") { this.spawnCodexProcess(opts); return; }`), and
  // `createCodexPty` is NOT overridden by the shared fixture. This project deliberately sets a codex
  // harness default (below), and an earlier version of this file really did spawn the real installed
  // `codex.CMD` this way. THROW here so any path that reaches a real codex spawn fails loudly instead of
  // launching a real process — mirrors the same override already used by harness-switch-now.mjs,
  // harness-drain-status.mjs, default-harness-config.mjs, and codex-fleet-switch-guard.mjs.
  createCodexPty() {
    throw new Error("forced-plain-persisted.mjs: a real codex spawn was attempted in a hermetic test — this must never reach createCodexPty");
  }
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy() {}, onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const lastOptsFor = (sid) => [...host.capture].reverse().find((o) => o.sessionId === sid);

function seedTranscript(sessionId) {
  const engId = `${sessionId}-eng-0000-0000-000000000000`;
  db.setEngineSessionId(sessionId, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setProcessState(sessionId, "exited");
}

try {
  // ===================== (3) startNew always writes a DEFINITE forcedPlain =====================
  const started = svc.startNew("agSwap", { forcePlain: true });
  check("(startNew, forcePlain:true) row.forcedPlain is persisted true", started.forcedPlain === true);
  check("(startNew, forcePlain:true) row.role stays undefined/null", started.role == null);

  // (startNew, role-omitted +New) on agRealWorker would resolve role="worker" AND harness="codex" — this
  // project's own codex default (below) applies to a real "worker" role. Exercising that LIVE via
  // startNew() is EXACTLY the hazard found during review (a prior version of this file did this and
  // really spawned the installed codex.CMD, bypassing createPty's fake entirely — see the SeamHost
  // override above). Seed the row directly instead; `forcedPlain: opts.forcePlain ?? false` is a trivial,
  // role-independent coercion whose OTHER branch (opts.forcePlain truthy) is already exercised LIVE by
  // the forcePlain:true startNew() call above, so this seed is not a meaningful coverage loss.
  // Doubles as the "real worker row that predates the project's codex default" fixture (harness still
  // null/"claude" on its own row) for the negative control below — seeded directly, never via
  // `Db.setSessionHarness` (write-once-at-insert elsewhere; see its own decision record aa82caed).
  const realWorkerId = "srcRealWorkerPreCodex";
  db.insertSession({
    id: realWorkerId, projectId: "p1", agentId: "agRealWorker", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false,
    noCommit: false, skills: null, connections: [], vaultWrite: false, harness: null, forcedPlain: false,
  });
  const seededRealWorker = db.getSession(realWorkerId);
  check("(seeded, role-omitted +New shape) row.forcedPlain is a definite false, not left ambiguous",
    seededRealWorker.forcedPlain === false);
  check("(seeded, role-omitted +New shape) row.role is 'worker' (what a real role-omitted start on this profile resolves to)",
    seededRealWorker.role === "worker");

  // ===================== (1) harnessDrainStatus — THE RESIDUAL =====================
  seedTranscript(started.id);
  db.setProcessState(started.id, "live"); // harnessDrainStatus only looks at LIVE sessions
  const drain1 = svc.harnessDrainStatus({ projectId: "p1" });
  check("(harnessDrainStatus) a forced-plain row on a worker-profile agent is NOT listed pending (was: mis-resolved as a worker, pending forever)",
    !drain1.pending.some((p) => p.sessionId === started.id));

  // Negative control: a REAL worker-role row (harness still null/"claude") with the SAME codex default
  // must still be reported pending — it genuinely needs a harness switch; forced-plain persistence must
  // never hide that.
  db.setProcessState(realWorkerId, "live");
  const drain2 = svc.harnessDrainStatus({ projectId: "p1" });
  check("(harnessDrainStatus, CONTROL) a REAL worker-role row under the same codex default IS listed pending",
    drain2.pending.some((p) => p.sessionId === realWorkerId));

  db.setProcessState(started.id, "exited");
  db.setProcessState(realWorkerId, "exited");

  // ===================== (2) gen-393 — profile reassignment after a forced-plain start =====================
  // Reassign agSwap's profile AFTER the forced-plain start above (started.agentId === "agSwap").
  db.updateAgent("agSwap", { profileId: "profNullRoleAllow" });

  host.capture.length = 0;
  const resumed = svc.resume(started.id);
  const resumedOpts = lastOptsFor(resumed.id);
  check("(gen-393, resume) a forced-plain row does NOT regain the REASSIGNED profile's allowDelta",
    !resumedOpts?.permission.allow.includes("Bash(echo REASSIGNED_OK:*)"));
  check("(gen-393, resume) opts.role stays undefined (still plain)", resumedOpts?.role === undefined);
  db.setProcessState(resumed.id, "exited");

  host.capture.length = 0;
  const forked = svc.forkSession(started.id);
  const forkedOpts = lastOptsFor(forked.id);
  check("(gen-393, fork) a forced-plain source does NOT leak the REASSIGNED profile's allowDelta onto the fork",
    !forkedOpts?.permission.allow.includes("Bash(echo REASSIGNED_OK:*)"));
  check("(gen-393, fork) the NEW forked row's own forcedPlain is stamped true (resolved, not copied-ambiguous)",
    forked.forcedPlain === true);

  // ===================== Round 2 MAJOR — a NON-forced role-null row must NOT follow a reassigned profile =====================
  // Card 963462f5 Round 2, Code Review c47b73d6: `effectiveForcePlain` must combine `forcedPlain` with the
  // interim rule via OR, never `??`. Reproduced by the reviewer on main's `??` form: a row honestly
  // written forcedPlain:false (its ORIGINAL profile's role was null — not a human's forced-plain choice)
  // whose agent is LATER reassigned to a SPAWNABLE profile picks up that NEW profile's allowDelta + role
  // pin on resume/fork, and reappears as harnessDrainStatus `pending` — exactly the widening f900237d's
  // interim rule exists to prevent, defeated by `??` short-circuiting past it on a definite `false`.
  const driftId = "srcDriftNonForced";
  db.insertSession({
    id: driftId, projectId: "p1", agentId: "agDrift", engineSessionId: null, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: null, browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false,
    noCommit: false, skills: null, connections: [], vaultWrite: false, harness: null, forcedPlain: false,
  });
  // Reassign AFTER the row was written — same shape as the gen-393 case above, but this row's forcedPlain
  // is a definite FALSE (not true), which is exactly what `??` mishandled.
  db.updateAgent("agDrift", { profileId: "profWorkerDrift" });
  seedTranscript(driftId);

  host.capture.length = 0;
  const driftResumed = svc.resume(driftId);
  const driftResumedOpts = lastOptsFor(driftResumed.id);
  check("(Round 2, resume) a non-forced role-null row does NOT adopt the REASSIGNED profile's allowDelta — RED on 65d3c37c's `??`",
    !driftResumedOpts?.permission.allow.includes("Bash(echo DRIFT_OK:*)"));
  // STANDING INVARIANT, not a discriminator for this round's fix: resume() always threads `role` from the
  // ROW's own pinned value (never from resolvedSpawn), so this passes identically on BOTH the `??` and OR
  // forms — same non-discriminating-guard shape as resume-fork-plain-role-not-widened.mjs's own ISOLATION
  // checks. Kept because it's still a real regression guard for role threading, just not for Round 2.
  check("(Round 2, resume) opts.role stays undefined (never silently promoted to 'worker')",
    driftResumedOpts?.role === undefined);
  db.setProcessState(driftResumed.id, "exited");

  host.capture.length = 0;
  const driftForked = svc.forkSession(driftId);
  const driftForkedOpts = lastOptsFor(driftForked.id);
  check("(Round 2, fork) a non-forced role-null source does NOT leak the REASSIGNED profile's allowDelta onto the fork — RED on 65d3c37c's `??`",
    !driftForkedOpts?.permission.allow.includes("Bash(echo DRIFT_OK:*)"));
  db.setProcessState(driftForked.id, "exited");

  // The reviewer's own reproduction: this row must also stay OUT of harnessDrainStatus's `pending` list
  // post-reassignment — under `??` it mis-resolved role:"worker" from the new profile, computed a
  // "wanted" harness of codex (this project's default), and sat there mismatched against harness:null.
  db.setProcessState(driftId, "live");
  const drain3 = svc.harnessDrainStatus({ projectId: "p1" });
  check("(Round 2, harnessDrainStatus) the reassigned non-forced role-null row is NOT listed pending — RED on 65d3c37c's `??`",
    !drain3.pending.some((p) => p.sessionId === driftId));
  db.setProcessState(driftId, "exited");

  // ===================== (3) fork of a LEGACY (forcedPlain:null) row converges to a definite value =====================
  // Seed a legacy-shaped plain row directly (bypassing startNew), mirroring resume-fork-plain-role-not-widened.mjs's
  // own `seedSource` helper — forcedPlain omitted entirely, exactly what every pre-963462f5 row looks like.
  const legacyId = "srcLegacyPlain";
  const legacyEngId = `${legacyId}-eng-0000-0000-000000000000`;
  db.insertSession({
    id: legacyId, projectId: "p1", agentId: "agRealWorker", engineSessionId: legacyEngId, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: null, browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false,
    noCommit: false, skills: null, connections: [], vaultWrite: false, harness: null,
  });
  const legacyTpath = engineTranscriptPath(repo, legacyEngId);
  fs.mkdirSync(path.dirname(legacyTpath), { recursive: true });
  fs.writeFileSync(legacyTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  const legacyRow = db.getSession(legacyId);
  check("(setup) the synthesized legacy row really does read back forcedPlain as null (never false)",
    legacyRow.forcedPlain === null);

  host.capture.length = 0;
  const legacyForked = svc.forkSession(legacyId);
  // legacyId's agent (agRealWorker) is pinned to profWorker, role "worker" — a PROFILE_SPAWNABLE_ROLES
  // member — so the interim rule (profileConfersSpawnableRole) resolves TRUE for this role-null row: the
  // resolved value is deterministically `true`, not merely "some definite boolean".
  check("(legacy fork) the new forked row's forcedPlain is stamped exactly true (resolved via the interim rule, never left null)",
    legacyForked.forcedPlain === true);
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — forced-plain is persisted as a definite boolean on every new/forked row, harnessDrainStatus no longer mis-resolves a forced-plain row's wanted harness, and a forcePlain row keeps its plain choice exactly even after its agent's profile is reassigned — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
