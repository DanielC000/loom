import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 3388be4d — the transcript-root deny (card ac90ca8e / 44fa586a) MOVED from `resolveAgentSpawn`
// (sessions/service.ts, exactly ONE of ten `pty.spawn` call sites) to `withTranscriptRootDenyForSpawn` at
// the single `PtyHost.createPty` spawn chokepoint (pty/host.ts) — so EVERY spawn path (fresh/resume/fork/
// recycle*/startRun/boot) inherits it structurally, keyed off the session's PINNED `role`, never
// re-derived from the (possibly-missing) agent row.
//
// Card d78f8217 (31613c1e's approved split) extends the BLANKET set to `manager`/`platform`/`setup`, and
// gives `worker` a separate PROJECT-SCOPED deny (rules for every OTHER project, computed from the DB via
// the `getOtherProjects` PtyHost constructor callback) — see host.ts's own doc for the full reasoning.
// PART 1b below covers the pure-function shape of the worker project-scoped case; PART 2's tail covers it
// end to end through a REAL (unsubclassed) createPty + a second PtyHost wired with `getOtherProjects`.
//
// THIS FILE proves the chokepoint FUNCTION in isolation (pure, deterministic, no DB/pty — mirrors
// disallow-prompt-tools.mjs / disallow-task-tools.mjs's own style for the sibling human-prompt-disallow
// chokepoint), PLUS drives the REAL (unsubclassed) `PtyHost.createPty()` — a real node.exe substituted for
// `claude` via `LOOM_CLAUDE_BIN` (the same technique boot-mode-settings-argv-coupling.mjs /
// spawn-command-line-preflight.mjs / kickoff-real-spawn.mjs already established) — and reads the WRITTEN
// settings.json `permissions.deny` back off disk: proof the mechanism is actually wired into the real,
// shipped createPty, not just correct in a unit test that never calls it.
//
// LOOM_HOME is set exactly ONCE, before any dynamic import — `paths.js` computes LOOM_HOME-derived
// constants (SETTINGS_DIR etc.) at MODULE-LOAD time and caches them, so a second `process.env.LOOM_HOME`
// reassignment after that module is already loaded is silently ineffective (a real footgun this file
// avoids by construction, not by convention).
//
// See transcript-root-deny-spawn-paths.mjs for the SessionService-level coverage of the six respawn paths
// (resume/fork/recycleWorker/recycleManager/recyclePlatformLead/startRun), including the headline
// agent-row-missing regression this card exists to fix.
//
// Run: 1) build (turbo builds shared first), 2) node test/transcript-root-deny-chokepoint.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const ROLE_DENY = "Read(~/.claude/projects/**)";
const CUSTOM_DENY = "Bash(rm -rf /:*)";

const tmpHome = mkdtempManaged("loom-trdc-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_CLAUDE_BIN = process.execPath; // resolveExecutable passes an absolute path through unchanged — harmless on every platform even if PART 2 skips

const { PtyHost, withTranscriptRootDenyForSpawn, TRANSCRIPT_ROOT_DENY_ROLES, TRANSCRIPT_ROOT_DENY_RULES } =
  await import("../dist/pty/host.js");
const { otherProjectTranscriptDenyRules } = await import("../dist/pty/claude-transcript.js");

// =====================================================================================================
// PART 1 — the pure function, in isolation (no DB, no pty, no claude)
// =====================================================================================================
check("TRANSCRIPT_ROOT_DENY_ROLES = exactly {assistant, auditor, workspace-auditor, manager, platform, setup} (the scope fence — d78f8217's approved BLANKET widening, worker EXCLUDED)",
  JSON.stringify([...TRANSCRIPT_ROOT_DENY_ROLES].sort()) === JSON.stringify(["assistant", "auditor", "manager", "platform", "setup", "workspace-auditor"]));
check("TRANSCRIPT_ROOT_DENY_RULES = exactly the one transcript-root rule",
  JSON.stringify(TRANSCRIPT_ROOT_DENY_RULES) === JSON.stringify([ROLE_DENY]));

// --- IN scope (BLANKET): assistant/auditor/workspace-auditor/manager/platform/setup get the rule unioned in ---
for (const role of ["assistant", "auditor", "workspace-auditor", "manager", "platform", "setup"]) {
  const empty = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [] }, role);
  check(`role '${role}': empty deny → rule added`, empty.deny.length === 1 && empty.deny[0] === ROLE_DENY);

  const withCustom = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] }, role);
  check(`role '${role}': a project's own custom deny survives (union, not replace)`, withCustom.deny.includes(CUSTOM_DENY));
  check(`role '${role}': the rule is ALSO added alongside the custom entry`, withCustom.deny.includes(ROLE_DENY) && withCustom.deny.length === 2);

  const already = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [ROLE_DENY] }, role);
  check(`role '${role}': idempotent — no duplicate when already present`, already.deny.filter((t) => t === ROLE_DENY).length === 1 && already.deny.length === 1);
  const alreadyPermission = { mode: "acceptEdits", allow: [], deny: [ROLE_DENY] };
  check(`role '${role}': idempotent case returns the SAME object reference (byte-identical, no new allocation)`,
    withTranscriptRootDenyForSpawn(alreadyPermission, role) === alreadyPermission);
}

// --- OUT of scope for the BLANKET rule: `run` (DoD-5's deliberate, un-reopened exclusion) and `worker`
// (gets its OWN project-scoped mechanism instead — see PART 3 below), plus no-role. Note: `worker` here is
// called with NO third argument, so it correctly stays byte-identical — see PART 3 for the case where a
// worker DOES get project-scoped rules passed in. ---
for (const role of ["worker", "run", null, undefined]) {
  const permission = { mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] };
  const out = withTranscriptRootDenyForSpawn(permission, role);
  check(`role '${String(role)}': OUT of scope (blanket) — deny is the SAME object reference (byte-identical, no mutation)`, out === permission);
  check(`role '${String(role)}': OUT of scope (blanket) — no rule leaked in`, !out.deny.includes(ROLE_DENY));
}

// =====================================================================================================
// PART 1b — the `worker` PROJECT-SCOPED deny (card d78f8217): the third `workerProjectDenyRules` param
// =====================================================================================================
{
  const otherRules = otherProjectTranscriptDenyRules("proj-other", "/repos/other");
  check("otherProjectTranscriptDenyRules returns exactly the two documented rule shapes",
    otherRules.length === 2 && otherRules[0] === "Read(~/.claude/projects/*-proj-other-*/**)");

  // A NON-worker role ignores the third param entirely (inert — matches this function's "OUT of scope ⇒
  // byte-identical" contract for every role not in TRANSCRIPT_ROOT_DENY_ROLES).
  const runPermission = { mode: "acceptEdits", allow: [], deny: [] };
  const runOut = withTranscriptRootDenyForSpawn(runPermission, "run", otherRules);
  check("role 'run' + workerProjectDenyRules passed: still byte-identical (param is worker-only)", runOut === runPermission);

  // `worker` with NO rules (undefined/empty) ⇒ byte-identical, same as before this param existed.
  const workerBasePermission = { mode: "acceptEdits", allow: [], deny: [] };
  const workerNoRules = withTranscriptRootDenyForSpawn(workerBasePermission, "worker");
  check("role 'worker', no workerProjectDenyRules ⇒ byte-identical (same object reference)", workerNoRules === workerBasePermission);
  const workerEmptyRules = withTranscriptRootDenyForSpawn(workerBasePermission, "worker", []);
  check("role 'worker', empty workerProjectDenyRules array ⇒ byte-identical (same object reference)", workerEmptyRules === workerBasePermission);

  // `worker` WITH rules ⇒ unioned in, alongside any of the project's own custom deny.
  const workerWithRules = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] }, "worker", otherRules);
  check("role 'worker' + workerProjectDenyRules ⇒ both other-project rules ARE added", otherRules.every((r) => workerWithRules.deny.includes(r)));
  check("role 'worker' + workerProjectDenyRules ⇒ the project's OWN custom deny survives (union)", workerWithRules.deny.includes(CUSTOM_DENY));
  check("role 'worker' + workerProjectDenyRules ⇒ the BLANKET root rule is NOT added (worker never gets the blanket)", !workerWithRules.deny.includes(ROLE_DENY));
  check("role 'worker' + workerProjectDenyRules ⇒ exactly 3 entries (custom + 2 other-project rules, no more)", workerWithRules.deny.length === 3);

  // idempotent: calling again with the same already-present rules returns the SAME reference.
  const workerIdempotent = withTranscriptRootDenyForSpawn(workerWithRules, "worker", otherRules);
  check("role 'worker' + already-present workerProjectDenyRules ⇒ idempotent (same object reference)", workerIdempotent === workerWithRules);
}

// =====================================================================================================
// PART 2 — the REAL (unsubclassed) createPty, through a real node.exe standing in for claude
// =====================================================================================================
if (process.platform !== "win32") {
  console.log("SKIP  transcript-root-deny-chokepoint.mjs part 2 — the LOOM_CLAUDE_BIN real-node.exe-substitution technique this file uses was only established/verified on Windows (process.platform !== 'win32' here); see boot-mode-settings-argv-coupling.mjs's own header for the same gap.");
} else {
  const { ensureDirs, WORKTREES_DIR, SETTINGS_DIR } = await import("../dist/paths.js");
  ensureDirs();
  registerForCleanup(WORKTREES_DIR); // sibling of LOOM_HOME, created by production ensureDirs()

  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
  const host = new PtyHost(events);

  const readWrittenDeny = (sessionId) => {
    const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json.permissions?.deny;
  };

  const spawned = [];
  try {
    // (a) role="assistant" — the WRITTEN settings.json must carry the deny.
    const sidAssistant = "trdc-real-assistant";
    host.spawn({ sessionId: sidAssistant, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "assistant" });
    spawned.push(sidAssistant);
    check("(real) host actually spawned a real process for the assistant session (exercised the REAL createPty, not a stub)", host.isAlive(sidAssistant));
    check("(real) assistant spawn: WRITTEN settings.json permissions.deny INCLUDES the transcript-root rule", (readWrittenDeny(sidAssistant) ?? []).includes(ROLE_DENY));

    // (b) role="worker" — OUT of scope, must be byte-identical to the (empty) input deny.
    const sidWorker = "trdc-real-worker";
    host.spawn({ sessionId: sidWorker, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
    spawned.push(sidWorker);
    check("(real) worker spawn: WRITTEN settings.json permissions.deny is EMPTY (no role-scoped entry leaked)", JSON.stringify(readWrittenDeny(sidWorker)) === JSON.stringify([]));

    // (c) role="assistant" with a project's OWN custom deny — union survives through the REAL write.
    const sidCustom = "trdc-real-assistant-custom";
    host.spawn({ sessionId: sidCustom, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "assistant" });
    spawned.push(sidCustom);
    const customWritten = readWrittenDeny(sidCustom) ?? [];
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json KEEPS the project's own custom entry", customWritten.includes(CUSTOM_DENY));
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json ALSO carries the role-scoped rule (union)", customWritten.includes(ROLE_DENY) && customWritten.length === 2);

    // (d)-(f) card d78f8217: manager/platform/setup are now BLANKET-denied too.
    for (const [sid, role] of [["trdc-real-manager", "manager"], ["trdc-real-platform", "platform"], ["trdc-real-setup", "setup"]]) {
      host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role });
      spawned.push(sid);
      check(`(real) ${role} spawn: WRITTEN settings.json permissions.deny INCLUDES the transcript-root rule (d78f8217 blanket)`, (readWrittenDeny(sid) ?? []).includes(ROLE_DENY));
    }
  } finally {
    for (const sid of spawned) { try { host.stop(sid, "hard"); } catch { /* best-effort cleanup */ } }
  }

  // (g) card d78f8217: `worker` PROJECT-SCOPED deny through a REAL createPty, via a SECOND PtyHost wired
  // with `getOtherProjects` (the real index.ts wiring shape) — proves BOTH directions DoD-2 requires: a
  // worker's OWN project's transcript rule is ABSENT, and every OTHER project's IS present.
  const ALL_PROJECTS = [
    { id: "proj-self", repoPath: "/repos/self" },
    { id: "proj-other-a", repoPath: "/repos/other-a" },
    { id: "proj-other-b", repoPath: "/repos/other-b" },
  ];
  const hostWithProjects = new PtyHost(events, { getOtherProjects: (projectId) => ALL_PROJECTS.filter((p) => p.id !== projectId) });
  const scopedSpawned = [];
  try {
    const sidScopedWorker = "trdc-real-worker-scoped";
    hostWithProjects.spawn({ sessionId: sidScopedWorker, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", projectId: "proj-self" });
    scopedSpawned.push(sidScopedWorker);
    const scopedDeny = readWrittenDeny(sidScopedWorker) ?? [];
    const expectedOther = ["proj-other-a", "proj-other-b"].flatMap((id, i) => otherProjectTranscriptDenyRules(id, ["/repos/other-a", "/repos/other-b"][i]));
    check("(real, project-scoped) worker's OWN project deny does NOT include a rule keyed to its own project id (positive half — DoD-2)",
      !scopedDeny.some((r) => r.includes("proj-self")));
    check("(real, project-scoped) worker's deny INCLUDES both other projects' rules (negative half — DoD-2)",
      expectedOther.every((r) => scopedDeny.includes(r)));
    check("(real, project-scoped) worker's deny does NOT include the blanket root rule (worker never gets the blanket)", !scopedDeny.includes(ROLE_DENY));
    check("(real, project-scoped) worker's deny has exactly the 4 expected other-project entries, no more", scopedDeny.length === 4);

    // A worker spawned FOR one of the "other" projects gets denied the OTHER two, but not its own.
    const sidScopedWorkerB = "trdc-real-worker-scoped-b";
    hostWithProjects.spawn({ sessionId: sidScopedWorkerB, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", projectId: "proj-other-a" });
    scopedSpawned.push(sidScopedWorkerB);
    const scopedDenyB = readWrittenDeny(sidScopedWorkerB) ?? [];
    check("(real, project-scoped) a DIFFERENT project's worker does NOT get a rule keyed to ITS OWN project id",
      !scopedDenyB.some((r) => r.includes("proj-other-a")));
    check("(real, project-scoped) a DIFFERENT project's worker DOES get rules for the other two projects",
      scopedDenyB.some((r) => r.includes("proj-self")) && scopedDenyB.some((r) => r.includes("proj-other-b")));
  } finally {
    for (const sid of scopedSpawned) { try { hostWithProjects.stop(sid, "hard"); } catch { /* best-effort cleanup */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — withTranscriptRootDenyForSpawn is correct in isolation (BLANKET for assistant/auditor/workspace-auditor/manager/platform/setup, PROJECT-SCOPED for worker, unions with a project's own custom deny, idempotent, byte-identical elsewhere), AND the REAL (unsubclassed) createPty actually writes both shapes of deny into settings.json for a real spawn — the chokepoint is genuinely wired in, not just unit-tested, and the worker's project-scoping is selective (own project readable, every other project denied) not blanket."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
