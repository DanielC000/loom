import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card f900237d — `resume()` (sessions/service.ts) and `forkSession()` both call
// `resolveAgentSpawn(agent, config, row.role ?? undefined)`. For a row PINNED to plain (`role === null` —
// a human-chosen "+New -> force plain" session), `row.role ?? undefined` collapses that explicit plain
// pin into `undefined`, which `resolveAgentSpawn` reads as "no explicit role, consult the profile"
// (`const role = explicitRole ?? profileRole ?? undefined`) rather than "explicitly plain". When the
// agent's profile confers "manager"/"worker"/"assistant" (PROFILE_SPAWNABLE_ROLES — all three members),
// the resumed/forked session is silently WIDENED: it inherits the profile's permission.allow delta AND,
// for a worker/assistant profile specifically, the startupModeCycles -> "auto" pin
// (withRolePermissionModeCyclesPin, which pins only those two roles, not manager) — permission and mode
// the human never asked for when they started this session plain.
//
// THE FIX (round 1): pass `forcePlain: row.role === null` as resolveAgentSpawn's existing 4th parameter
// at both call sites — the SAME mechanism `startNew`'s own forcePlain path already uses (drops the
// profile lookup entirely, so `role` stays undefined and permission/mode get no role-pin). For a
// non-null row role this stays `false` — byte-identical to today.
//
// ROUND 2 (card f900237d, Code Review 7fd9a414 — CHANGES-REQUESTED): round 1's blanket `row.role===null`
// is ITSELF a fail-closed narrowing regression. A role-null row does NOT only mean "a human forced
// plain" — `startNew` WITHOUT forcePlain also writes a role-null row when (a) the profile's own role is
// null, or (b) the profile's role is clamped out of PROFILE_SPAWNABLE_ROLES (platform/auditor/setup/run).
// Both (a) and (b) legitimately booted WITH the profile's allowDelta, and round 1 stripped it on every
// resume/fork. THE FIX (round 2): forcePlain only when the row's role is null AND the agent's CURRENT
// profile would confer a PROFILE_SPAWNABLE role (manager, worker, or assistant — all three members) —
// i.e. exactly the widening this card names (a plain row on a manager/worker/assistant-profile agent);
// cases (a) and (b) keep their allowDelta.
//
// ROUND 3 (minor 4): added a plain-row case on a MANAGER- and an ASSISTANT-profile agent (the two
// PROFILE_SPAWNABLE_ROLES members the round-1/round-2 fixtures never exercised — only "worker" had a
// case), asserting allowDelta stays ABSENT on resume AND fork. Same shape as the existing worker case;
// proves the fix's clamp genuinely covers all three members, not just the one the fixtures happened to use.
//
// PROVES:
//   - (resume, THE BUG) a plain row (role:null) on a worker-profile-pinned agent resumes with the
//     project's OWN startupModeCycles/resumeModeTarget (NOT the auto pin) and WITHOUT the profile's
//     allowDelta — RED on pre-fix code.
//   - (fork, same bug) identical shape via forkSession().
//   - NEGATIVE CONTROL (resume + fork): a WORKER-role row on the SAME agent/profile still gets the
//     profile's allowDelta AND the auto pin — the fix must not blanket-force every resume/fork to plain.
//   - ROUND 2, NULL-ROLE PROFILE (resume + fork): a role-null row on an agent whose profile itself has
//     role:null (but a real allowDelta) KEEPS that allowDelta — RED on round 1's commit (8a24930f), which
//     force-plains every role-null row regardless of why it's null.
//   - ROUND 2, CLAMPED-ROLE PROFILE (resume + fork): a role-null row on an agent whose profile's role is
//     clamped out of PROFILE_SPAWNABLE_ROLES ("auditor") KEEPS that profile's allowDelta — same RED on
//     round 1's commit.
//   - ROUND 3, MANAGER- AND ASSISTANT-PROFILE PLAIN ROWS (resume + fork): a plain row (role:null) on a
//     MANAGER-profile-pinned agent, and on an ASSISTANT-profile-pinned agent, both resume/fork WITHOUT
//     that profile's allowDelta — the same widening THE BUG proves for "worker", now proven for the
//     other two PROFILE_SPAWNABLE_ROLES members too.
//   - ISOLATION: `model` and `restrictedTools` are READ BY resume()/forkSession() FROM THE ROW'S OWN
//     PINNED COLUMNS, never from resolveAgentSpawn's return — so even though the test profile pins a
//     DISTINCT model + restrictedTools:true (deliberately different from the row's own false/undefined),
//     neither leaks into the spawned opts in EITHER the plain or the worker-role case, before or after
//     the fix. This is the enumeration the manager asked for, executable: every field resolveAgentSpawn
//     returns that resume()/forkSession() could theoretically read is checked here or named in the report
//     as provably unread (browserTesting/documentConversion/capabilities/noCommit/skills/connections/
///    vaultWrite/harness/role are all threaded from the SESSION ROW, never from resolvedSpawn, in both
//     methods' ordinary paths — see sessions/service.ts's own pty.spawn() call sites).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like resume-permission-pin-agent-missing.mjs /
// fork-allow-baseline.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven
// against a FAKE pty via PtyHost's createPty() seam — no real claude, no daemon, no network, no git repo
// needed (neither resume() nor forkSession() touches git).
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-fork-plain-role-not-widened.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (resume()/forkSession()'s engineTranscriptExists must never
// touch the real ~/.claude). Set BEFORE importing dist (paths.ts/os.homedir reads happen at module load). ---
const tmpHome = path.join(os.tmpdir(), `loom-rfpnw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveConfig } = await import("@loom/shared");
const { cyclesToReachFromAcceptEdits } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// --- a plain (non-git) project dir — neither resume() nor forkSession() touches git ---
const repo = path.join(os.tmpdir(), `loom-rfpnw-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });

const now = new Date().toISOString();
const BASELINE = "mcp__loom-tasks";
const PROFILE_ALLOW = "Bash(echo PROFILE_OK:*)";
// Deliberately DIFFERENT from the row's own pinned false/undefined, so a leak through resolvedSpawn
// would be visible rather than coincidentally matching the row value.
const PROFILE_MODEL = "claude-profile-pin-should-never-leak";

const db = new Db();
// The project deliberately disables the boot-cycle knob (0 cycles ⇒ stays at acceptEdits) — a value that
// is NOT what the worker/assistant pin targets (auto), so landing on "auto" anyway is a real
// discriminator (mirrors resume-permission-pin-agent-missing.mjs's own discriminating-pair rationale).
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: { permission: { startupModeCycles: 0 } }, createdAt: now, archivedAt: null });
const resolved = resolveConfig({ permission: { startupModeCycles: 0 } });
check("(setup) the project's resolved config really carries startupModeCycles:0", resolved.permission.startupModeCycles === 0);
check("(setup) the project's resolved config does NOT already carry the profile allow entry (no false positive)", !resolved.permission.allow.includes(PROFILE_ALLOW));

// A worker-role profile conferring an allowDelta + a distinct model + restrictedTools:true — the agent
// below is pinned to this profile, so a widened resume/fork would pick ALL of this up if it leaked.
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [PROFILE_ALLOW], skills: null, model: PROFILE_MODEL, icon: null, restrictedTools: true });
db.insertAgent({ id: "agPlain", projectId: "p1", name: "Agent", startupPrompt: "P", position: 0, profileId: "profWorker" });

// ROUND 2 fixtures — two profiles whose OWN role is NOT profile-spawnable, so a role-omitted "+New"
// start through either one legitimately writes a role-null row (per resolveAgentSpawn's `profileRole`
// clamp) while STILL layering the profile's allowDelta (resolveProfile's `allow` is read before the
// role clamp applies) — exactly the (a)/(b) cases round 1 wrongly force-plained.
const PROFILE_ALLOW_NULLROLE = "Bash(echo NULLROLE_OK:*)";
const PROFILE_ALLOW_CLAMPED = "Bash(echo CLAMPED_OK:*)";
// (a) profile.role is null itself.
db.insertProfile({ id: "profNullRole", name: "Null-role Rig", role: null, description: "", allowDelta: [PROFILE_ALLOW_NULLROLE], skills: null, model: null, icon: null });
db.insertAgent({ id: "agNullRoleProfile", projectId: "p1", name: "Agent NullRole", startupPrompt: "P", position: 1, profileId: "profNullRole" });
// (b) profile.role is "auditor" — outside PROFILE_SPAWNABLE_ROLES, so a role-omitted start clamps it to
// undefined (never auto-elevates), but the allowDelta is NOT part of that clamp.
db.insertProfile({ id: "profAuditorClamped", name: "Clamped Auditor Rig", role: "auditor", description: "", allowDelta: [PROFILE_ALLOW_CLAMPED], skills: null, model: null, icon: null });
db.insertAgent({ id: "agAuditorClampedProfile", projectId: "p1", name: "Agent ClampedAuditor", startupPrompt: "P", position: 2, profileId: "profAuditorClamped" });

// ROUND 3 fixtures (minor 4) — the other two PROFILE_SPAWNABLE_ROLES members (round 1/2 only ever
// exercised "worker"); a plain row pinned to either must resume/fork WITHOUT the profile's allowDelta,
// same as the worker case above.
const PROFILE_ALLOW_MANAGER = "Bash(echo MANAGER_OK:*)";
const PROFILE_ALLOW_ASSISTANT = "Bash(echo ASSISTANT_OK:*)";
db.insertProfile({ id: "profManager", name: "Manager Rig", role: "manager", description: "", allowDelta: [PROFILE_ALLOW_MANAGER], skills: null, model: null, icon: null });
db.insertAgent({ id: "agManagerProfile", projectId: "p1", name: "Agent Manager", startupPrompt: "P", position: 3, profileId: "profManager" });
db.insertProfile({ id: "profAssistant", name: "Assistant Rig", role: "assistant", description: "", allowDelta: [PROFILE_ALLOW_ASSISTANT], skills: null, model: null, icon: null });
db.insertAgent({ id: "agAssistantProfile", projectId: "p1", name: "Agent Assistant", startupPrompt: "P", position: 4, profileId: "profAssistant" });

/** Seed a resumable/forkable session row directly against the real agent row (bypasses spawn). Every
 *  capability column is left at its "today's plain-spawn default" value (false/null/[]/undefined) —
 *  exactly what a REAL `startNew(agent, {forcePlain:true})` would have pinned on this row at ITS OWN
 *  original start, which is the invariant this test is checking resume/fork against. */
function seedSource(id, role, agentId = "agPlain") {
  const engId = `${id}-eng-0000-0000-000000000000`;
  db.insertSession({
    id, projectId: "p1", agentId, engineSessionId: engId, title: null, cwd: repo,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, browserTesting: false, documentConversion: false, capabilities: [], restrictedTools: false,
    noCommit: false, skills: null, connections: [], vaultWrite: false, harness: null,
  });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return engId;
}

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; } // no real OS pty behind this seam — resume()'s already-live short-circuit must not trip
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const lastOptsFor = (sid) => [...host.capture].reverse().find((o) => o.sessionId === sid);

const AUTO_CYCLES = cyclesToReachFromAcceptEdits("auto");

try {
  // ===================== RESUME, plain row (role:null) — THE BUG =====================
  seedSource("srcPlainResume", null);
  host.capture.length = 0;
  const resumedPlain = svc.resume("srcPlainResume");
  const oPlainResume = lastOptsFor(resumedPlain.id);
  check("(resume, PLAIN row) resumeModeTarget stays 'acceptEdits' — the project's own knob, NOT the worker auto pin",
    oPlainResume?.resumeModeTarget === "acceptEdits");
  // NOT a signal: opts.permission.startupModeCycles is UNCONDITIONALLY zeroed by resume() itself right
  // before pty.spawn (`{ ...resumePermission, startupModeCycles: 0 }`, decision f05e4897 — --resume
  // restores mode via resumeModeTarget, never a blind cycle count), so it reads 0 for every role,
  // buggy or fixed. Asserting it here would be vacuous; resumeModeTarget above is the real discriminator.
  check("(resume, PLAIN row) permission.allow does NOT include the profile's allowDelta (no silent widening)",
    !oPlainResume?.permission.allow.includes(PROFILE_ALLOW));
  check("(resume, PLAIN row) permission.allow still carries the task-board baseline (forcePlain unions it, doesn't drop it)",
    oPlainResume?.permission.allow.includes(BASELINE));
  check("(resume, PLAIN row) opts.role stays undefined (row's own pinned role, unaffected either way)",
    oPlainResume?.role === undefined);
  check("(resume, PLAIN row, ISOLATION) opts.model is undefined — never threaded on --resume regardless of the profile's model pin",
    oPlainResume?.model === undefined);
  check("(resume, PLAIN row, ISOLATION) opts.restrictedTools is false — the ROW's own pinned value, not the profile's true",
    oPlainResume?.restrictedTools === false);
  check("(resume, PLAIN row, ISOLATION) opts.harness is undefined/null — the ROW's own pinned value",
    oPlainResume?.harness == null);

  // ===================== RESUME, WORKER row (role:"worker") — NEGATIVE CONTROL =====================
  // Same agent/profile as above. Must NOT be forced plain — the fix must not blanket-force every resume.
  seedSource("srcWorkerResume", "worker");
  host.capture.length = 0;
  const resumedWorker = svc.resume("srcWorkerResume");
  const oWorkerResume = lastOptsFor(resumedWorker.id);
  check("(resume, WORKER row, CONTROL) resumeModeTarget is 'auto' — the role pin still applies for a real worker row",
    oWorkerResume?.resumeModeTarget === "auto");
  // Same non-signal as above: resume() always zeroes opts.permission.startupModeCycles before spawn —
  // resumeModeTarget (just asserted) is the real discriminator for resume's mode, not this field.
  check("(resume, WORKER row, CONTROL) permission.allow DOES include the profile's allowDelta — still layered for a real worker",
    oWorkerResume?.permission.allow.includes(PROFILE_ALLOW));
  check("(resume, WORKER row, CONTROL, ISOLATION) opts.model is still undefined — never threaded on --resume, role notwithstanding",
    oWorkerResume?.model === undefined);
  check("(resume, WORKER row, CONTROL, ISOLATION) opts.restrictedTools is still false — the ROW's own pinned value, not the profile's true",
    oWorkerResume?.restrictedTools === false);

  // ===================== FORK, plain row (role:null) — THE BUG, SAME SHAPE =====================
  seedSource("srcPlainFork", null);
  host.capture.length = 0;
  const forkedPlain = svc.forkSession("srcPlainFork");
  const oPlainFork = lastOptsFor(forkedPlain.id);
  check("(fork, PLAIN row) permission.startupModeCycles stays 0 — NOT re-pinned to the auto-reaching count",
    oPlainFork?.permission.startupModeCycles === 0);
  check("(fork, PLAIN row) permission.allow does NOT include the profile's allowDelta (no silent widening)",
    !oPlainFork?.permission.allow.includes(PROFILE_ALLOW));
  check("(fork, PLAIN row) permission.allow still carries the task-board baseline",
    oPlainFork?.permission.allow.includes(BASELINE));
  check("(fork, PLAIN row) opts.role stays undefined (the source row's own pinned role)",
    oPlainFork?.role === undefined);
  check("(fork, PLAIN row, ISOLATION) opts.model is undefined — never threaded on --fork-session regardless of the profile's model pin",
    oPlainFork?.model === undefined);
  check("(fork, PLAIN row, ISOLATION) opts.restrictedTools is false — the SOURCE row's own pinned value, not the profile's true",
    oPlainFork?.restrictedTools === false);
  check("(fork, PLAIN row) really IS a --fork-session of the source transcript",
    oPlainFork?.fork === true && oPlainFork?.resumeId === "srcPlainFork-eng-0000-0000-000000000000");

  // ===================== FORK, WORKER row (role:"worker") — NEGATIVE CONTROL =====================
  seedSource("srcWorkerFork", "worker");
  host.capture.length = 0;
  const forkedWorker = svc.forkSession("srcWorkerFork");
  const oWorkerFork = lastOptsFor(forkedWorker.id);
  check("(fork, WORKER row, CONTROL) permission.startupModeCycles is pinned to the auto-reaching count",
    oWorkerFork?.permission.startupModeCycles === AUTO_CYCLES);
  check("(fork, WORKER row, CONTROL) permission.allow DOES include the profile's allowDelta — still layered for a real worker",
    oWorkerFork?.permission.allow.includes(PROFILE_ALLOW));
  check("(fork, WORKER row, CONTROL, ISOLATION) opts.model is still undefined — never threaded on --fork-session, role notwithstanding",
    oWorkerFork?.model === undefined);
  check("(fork, WORKER row, CONTROL, ISOLATION) opts.restrictedTools is still false — the SOURCE row's own pinned value, not the profile's true",
    oWorkerFork?.restrictedTools === false);

  // ============== ROUND 2: RESUME, role-null row on a NULL-ROLE-PROFILE agent — KEEPS allowDelta ==============
  // profNullRole's own role is null (not "forced plain" by a human — a role-omitted start through this
  // profile legitimately resolves role:null while still layering allowDelta). RED on round 1 (8a24930f):
  // that commit force-plains every role===null row, which drops this profile's allowDelta too.
  seedSource("srcNullRoleProfileResume", null, "agNullRoleProfile");
  host.capture.length = 0;
  const resumedNullRoleProfile = svc.resume("srcNullRoleProfileResume");
  const oNullRoleProfileResume = lastOptsFor(resumedNullRoleProfile.id);
  check("(resume, ROUND 2, null-role-profile row) permission.allow DOES include the profile's allowDelta — a null-role profile is not a human's forced-plain choice",
    oNullRoleProfileResume?.permission.allow.includes(PROFILE_ALLOW_NULLROLE));
  check("(resume, ROUND 2, null-role-profile row) permission.allow still carries the task-board baseline",
    oNullRoleProfileResume?.permission.allow.includes(BASELINE));
  check("(resume, ROUND 2, null-role-profile row, INVARIANT) opts.role stays undefined — a null profile role never clamps to a role, so this cannot fail via forcePlain either way; a plain regression guard, not a discriminator for this card's fix",
    oNullRoleProfileResume?.role === undefined);

  // ============== ROUND 2: FORK, same null-role-profile agent — KEEPS allowDelta ==============
  seedSource("srcNullRoleProfileFork", null, "agNullRoleProfile");
  host.capture.length = 0;
  const forkedNullRoleProfile = svc.forkSession("srcNullRoleProfileFork");
  const oNullRoleProfileFork = lastOptsFor(forkedNullRoleProfile.id);
  check("(fork, ROUND 2, null-role-profile row) permission.allow DOES include the profile's allowDelta",
    oNullRoleProfileFork?.permission.allow.includes(PROFILE_ALLOW_NULLROLE));
  check("(fork, ROUND 2, null-role-profile row) permission.allow still carries the task-board baseline",
    oNullRoleProfileFork?.permission.allow.includes(BASELINE));
  check("(fork, ROUND 2, null-role-profile row, INVARIANT) opts.role stays undefined — same non-discriminating regression guard as the resume case above",
    oNullRoleProfileFork?.role === undefined);

  // ============== ROUND 2: RESUME, role-null row on a CLAMPED-ROLE-PROFILE agent — KEEPS allowDelta ==============
  // profAuditorClamped's role is "auditor" — outside PROFILE_SPAWNABLE_ROLES, so a role-omitted "+New"
  // start clamps the resolved role to undefined (never auto-elevates an "auditor" profile via +New), but
  // the layered allowDelta is NOT part of that clamp. RED on round 1 for the same reason as above.
  seedSource("srcAuditorClampedResume", null, "agAuditorClampedProfile");
  host.capture.length = 0;
  const resumedAuditorClamped = svc.resume("srcAuditorClampedResume");
  const oAuditorClampedResume = lastOptsFor(resumedAuditorClamped.id);
  check("(resume, ROUND 2, clamped-role-profile row) permission.allow DOES include the profile's allowDelta — the clamp drops the ROLE, not the allowDelta",
    oAuditorClampedResume?.permission.allow.includes(PROFILE_ALLOW_CLAMPED));
  check("(resume, ROUND 2, clamped-role-profile row) permission.allow still carries the task-board baseline",
    oAuditorClampedResume?.permission.allow.includes(BASELINE));
  check("(resume, ROUND 2, clamped-role-profile row, INVARIANT) opts.role stays undefined — the clamp already drops 'auditor' from profileRole regardless of forcePlain, so this cannot fail via this path; a plain regression guard, not a discriminator for this card's fix",
    oAuditorClampedResume?.role === undefined);

  // ============== ROUND 2: FORK, same clamped-role-profile agent — KEEPS allowDelta ==============
  seedSource("srcAuditorClampedFork", null, "agAuditorClampedProfile");
  host.capture.length = 0;
  const forkedAuditorClamped = svc.forkSession("srcAuditorClampedFork");
  const oAuditorClampedFork = lastOptsFor(forkedAuditorClamped.id);
  check("(fork, ROUND 2, clamped-role-profile row) permission.allow DOES include the profile's allowDelta",
    oAuditorClampedFork?.permission.allow.includes(PROFILE_ALLOW_CLAMPED));
  check("(fork, ROUND 2, clamped-role-profile row) permission.allow still carries the task-board baseline",
    oAuditorClampedFork?.permission.allow.includes(BASELINE));
  check("(fork, ROUND 2, clamped-role-profile row, INVARIANT) opts.role stays undefined — same non-discriminating regression guard as the resume case above",
    oAuditorClampedFork?.role === undefined);

  // ============== ROUND 3 (minor 4): RESUME, plain row on a MANAGER-profile agent — allowDelta ABSENT ==============
  // profManager's role IS a PROFILE_SPAWNABLE_ROLES member (unlike round 2's null/clamped fixtures), so a
  // plain (role:null) row on this agent is exactly the widening THE BUG proves for "worker" — now proven
  // for "manager" too, closing the gap where round 1/2's fixtures only ever exercised one of the three members.
  seedSource("srcManagerProfilePlainResume", null, "agManagerProfile");
  host.capture.length = 0;
  const resumedManagerProfilePlain = svc.resume("srcManagerProfilePlainResume");
  const oManagerProfilePlainResume = lastOptsFor(resumedManagerProfilePlain.id);
  check("(resume, ROUND 3, plain row on MANAGER-profile agent) permission.allow does NOT include the profile's allowDelta",
    !oManagerProfilePlainResume?.permission.allow.includes(PROFILE_ALLOW_MANAGER));
  check("(resume, ROUND 3, plain row on MANAGER-profile agent) permission.allow still carries the task-board baseline",
    oManagerProfilePlainResume?.permission.allow.includes(BASELINE));
  check("(resume, ROUND 3, plain row on MANAGER-profile agent) opts.role stays undefined",
    oManagerProfilePlainResume?.role === undefined);

  // ============== ROUND 3: FORK, same manager-profile agent — allowDelta ABSENT ==============
  seedSource("srcManagerProfilePlainFork", null, "agManagerProfile");
  host.capture.length = 0;
  const forkedManagerProfilePlain = svc.forkSession("srcManagerProfilePlainFork");
  const oManagerProfilePlainFork = lastOptsFor(forkedManagerProfilePlain.id);
  check("(fork, ROUND 3, plain row on MANAGER-profile agent) permission.allow does NOT include the profile's allowDelta",
    !oManagerProfilePlainFork?.permission.allow.includes(PROFILE_ALLOW_MANAGER));
  check("(fork, ROUND 3, plain row on MANAGER-profile agent) permission.allow still carries the task-board baseline",
    oManagerProfilePlainFork?.permission.allow.includes(BASELINE));
  check("(fork, ROUND 3, plain row on MANAGER-profile agent) opts.role stays undefined",
    oManagerProfilePlainFork?.role === undefined);

  // ============== ROUND 3: RESUME, plain row on an ASSISTANT-profile agent — allowDelta ABSENT ==============
  // Same shape as the manager case above, for the third and last PROFILE_SPAWNABLE_ROLES member.
  seedSource("srcAssistantProfilePlainResume", null, "agAssistantProfile");
  host.capture.length = 0;
  const resumedAssistantProfilePlain = svc.resume("srcAssistantProfilePlainResume");
  const oAssistantProfilePlainResume = lastOptsFor(resumedAssistantProfilePlain.id);
  check("(resume, ROUND 3, plain row on ASSISTANT-profile agent) permission.allow does NOT include the profile's allowDelta",
    !oAssistantProfilePlainResume?.permission.allow.includes(PROFILE_ALLOW_ASSISTANT));
  check("(resume, ROUND 3, plain row on ASSISTANT-profile agent) permission.allow still carries the task-board baseline",
    oAssistantProfilePlainResume?.permission.allow.includes(BASELINE));
  check("(resume, ROUND 3, plain row on ASSISTANT-profile agent) opts.role stays undefined",
    oAssistantProfilePlainResume?.role === undefined);

  // ============== ROUND 3: FORK, same assistant-profile agent — allowDelta ABSENT ==============
  seedSource("srcAssistantProfilePlainFork", null, "agAssistantProfile");
  host.capture.length = 0;
  const forkedAssistantProfilePlain = svc.forkSession("srcAssistantProfilePlainFork");
  const oAssistantProfilePlainFork = lastOptsFor(forkedAssistantProfilePlain.id);
  check("(fork, ROUND 3, plain row on ASSISTANT-profile agent) permission.allow does NOT include the profile's allowDelta",
    !oAssistantProfilePlainFork?.permission.allow.includes(PROFILE_ALLOW_ASSISTANT));
  check("(fork, ROUND 3, plain row on ASSISTANT-profile agent) permission.allow still carries the task-board baseline",
    oAssistantProfilePlainFork?.permission.allow.includes(BASELINE));
  check("(fork, ROUND 3, plain row on ASSISTANT-profile agent) opts.role stays undefined",
    oAssistantProfilePlainFork?.role === undefined);
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a plain (role:null) row resumes/forks with the project's OWN mode knob and WITHOUT its agent's profile allowDelta, a worker-role row on the SAME agent/profile keeps both (negative control), model/restrictedTools never leak through resolvedSpawn into either case, (round 2) a role-null row caused by a null-role or clamped-role (non-spawnable) profile KEEPS that profile's allowDelta on resume/fork, AND (round 3) a plain row on a manager- or assistant-profile agent is WITHOUT that profile's allowDelta too, covering all three PROFILE_SPAWNABLE_ROLES members — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
