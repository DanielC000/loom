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
// Card 849acf9b: PART 2 below drives the REAL (unsubclassed) createPty, which reaches
// ensureTrustedResilient -> ensureTrusted (host.ts) unconditionally, writing a trust entry into whatever
// claudeJsonPath() resolves to. Left unredirected, that landed in the OWNER'S REAL ~/.claude.json on every
// run. Redirect CLAUDE_CONFIG_DIR (claudeJsonPath() honors it directly) AND HOME/USERPROFILE (belt-and-
// suspenders — discoverProjectMcpServerNames, also called from ensureTrusted, walks up from cwd to
// os.homedir() for ~/.mcp.json) to this test's own temp root BEFORE the ../dist import, same convention as
// trust-lock.mjs/claude-config-worktree-prune.mjs.
const claudeConfigDir = path.join(tmpHome, "claude-config");
fs.mkdirSync(claudeConfigDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

// Card 8e32605d (2c9f0854 Code Review follow-up, item 2): PART 2 below drives a REAL (unsubclassed)
// PtyHost.spawn with projectId "proj-self"/"proj-other-a" (host.ts's ensureProjectWorkDir), with no prior
// pin — under a foreign ambient LOOM_PROJECT_WORK_ROOT (e.g. a human/another test's own tmp root) this
// created proj-self/proj-other-a inside THAT root instead of this test's own. Clear it before paths.js
// computes PROJECTS_WORK_ROOT at module load, mirroring pty-claude-spawn-env.mjs's same-shaped pin.
delete process.env.LOOM_PROJECT_WORK_ROOT;

const { PtyHost, withTranscriptRootDenyForSpawn, TRANSCRIPT_ROOT_DENY_ROLES, transcriptRootDenyRules } =
  await import("../dist/pty/host.js");
const { otherProjectTranscriptDenyRules, encodeProjectDir } = await import("../dist/pty/claude-transcript.js");
const { claudeJsonPath, claudeConfigHome } = await import("../dist/pty/claude-config.js");
const { toClaudeAbsoluteGlob } = await import("../dist/pty/loom-home-deny.js");

// Card a92a0913: this file ALREADY sets CLAUDE_CONFIG_DIR above (for the ensureTrusted concern) — so
// every transcript-root deny computed below now ALSO carries the absolute-path sibling rule, not just
// ROLE_DENY. Computed via the real claudeConfigHome()/toClaudeAbsoluteGlob() rather than hand-building
// the string, so this test can never drift from the production resolver independently.
const PROJECTS_ROOT = path.join(claudeConfigHome(), "projects");
const ABSOLUTE_PROJECTS_DENY = `Read(${toClaudeAbsoluteGlob(PROJECTS_ROOT)}/**)`;
// Round 3 (card a92a0913): win32 ONLY gets a THIRD, plain forward-slashed sibling — see
// claudeProjectsRootPlainSlashedGlob's own doc for why. WIN32 gates every expectation below so this
// file stays correct on either platform without a separate code path per assertion.
const WIN32 = process.platform === "win32";
const PLAIN_SLASHED_PROJECTS_DENY = `Read(${PROJECTS_ROOT.replace(/\\/g, "/")}/**)`;
const EXPECTED_TRANSCRIPT_ROOT_RULES = WIN32
  ? [ROLE_DENY, ABSOLUTE_PROJECTS_DENY, PLAIN_SLASHED_PROJECTS_DENY]
  : [ROLE_DENY, ABSOLUTE_PROJECTS_DENY];
{
  const resolvedConfigHome = path.resolve(claudeConfigHome());
  const expectedConfigHome = path.resolve(claudeConfigDir);
  check("claudeConfigHome() resolves under this test's own temp CLAUDE_CONFIG_DIR, never the real homedir",
    resolvedConfigHome === expectedConfigHome);
}

// Assert the redirect actually took before PART 2's real spawns below can reach ensureTrusted. A
// dropped/broken redirect fails HERE, by name, and this file ABORTS rather than falling through to a
// real spawn that would write the owner's real ~/.claude.json.
{
  const resolvedClaudeJsonPath = path.resolve(claudeJsonPath());
  const expectedClaudeJsonPath = path.resolve(path.join(claudeConfigDir, ".claude.json"));
  check("claudeJsonPath() resolves under this test's own temp CLAUDE_CONFIG_DIR, never the real ~/.claude.json",
    resolvedClaudeJsonPath === expectedClaudeJsonPath);
  if (resolvedClaudeJsonPath !== expectedClaudeJsonPath) {
    console.log(`\n❌ ${failures} FAILURE(S) — refusing to proceed: claudeJsonPath() does not resolve under this test's own CLAUDE_CONFIG_DIR, so PART 2's real spawns below would reach the OWNER'S REAL ~/.claude.json. Aborting before any real spawn.`);
    await finishAndExit(1);
  }
}

// =====================================================================================================
// PART 1 — the pure function, in isolation (no DB, no pty, no claude)
// =====================================================================================================
check("TRANSCRIPT_ROOT_DENY_ROLES = exactly {assistant, auditor, workspace-auditor, manager, platform, setup} (the scope fence — d78f8217's approved BLANKET widening, worker EXCLUDED)",
  JSON.stringify([...TRANSCRIPT_ROOT_DENY_ROLES].sort()) === JSON.stringify(["assistant", "auditor", "manager", "platform", "setup", "workspace-auditor"]));
// Card a92a0913: transcriptRootDenyRules() is the FUNCTION form now (CLAUDE_CONFIG_DIR read fresh) —
// this test's own env already sets CLAUDE_CONFIG_DIR above, so the real result carries the home-relative
// rule (kept byte-identical) PLUS the absolute-path sibling(s) computed the same way the production
// resolver does (a third, plain-slashed sibling on win32 — see EXPECTED_TRANSCRIPT_ROOT_RULES above).
check("transcriptRootDenyRules() = the home-relative rule PLUS the absolute-path sibling(s) (CLAUDE_CONFIG_DIR is set in this test's env)",
  JSON.stringify(transcriptRootDenyRules()) === JSON.stringify(EXPECTED_TRANSCRIPT_ROOT_RULES));

const EXPECTED_ROLE_RULE_COUNT = EXPECTED_TRANSCRIPT_ROOT_RULES.length;

// --- IN scope (BLANKET): assistant/auditor/workspace-auditor/manager/platform/setup get every rule unioned in ---
for (const role of ["assistant", "auditor", "workspace-auditor", "manager", "platform", "setup"]) {
  const empty = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [] }, role);
  check(`role '${role}': empty deny → every transcript-root rule added`,
    empty.deny.length === EXPECTED_ROLE_RULE_COUNT && EXPECTED_TRANSCRIPT_ROOT_RULES.every((r) => empty.deny.includes(r)));

  const withCustom = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] }, role);
  check(`role '${role}': a project's own custom deny survives (union, not replace)`, withCustom.deny.includes(CUSTOM_DENY));
  check(`role '${role}': every transcript-root rule is ALSO added alongside the custom entry`,
    EXPECTED_TRANSCRIPT_ROOT_RULES.every((r) => withCustom.deny.includes(r)) && withCustom.deny.length === EXPECTED_ROLE_RULE_COUNT + 1);

  const already = withTranscriptRootDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [...EXPECTED_TRANSCRIPT_ROOT_RULES] }, role);
  check(`role '${role}': idempotent — no duplicate when already present`,
    already.deny.filter((t) => EXPECTED_TRANSCRIPT_ROOT_RULES.includes(t)).length === EXPECTED_ROLE_RULE_COUNT && already.deny.length === EXPECTED_ROLE_RULE_COUNT);
  const alreadyPermission = { mode: "acceptEdits", allow: [], deny: [...EXPECTED_TRANSCRIPT_ROOT_RULES] };
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
  check(`role '${String(role)}': OUT of scope (blanket) — no rule leaked in`,
    !EXPECTED_TRANSCRIPT_ROOT_RULES.some((r) => out.deny.includes(r)));
}

// =====================================================================================================
// PART 1b — the `worker` PROJECT-SCOPED deny (card d78f8217): the third `workerProjectDenyRules` param
// =====================================================================================================
{
  const otherRules = otherProjectTranscriptDenyRules("proj-other", "/repos/other");
  // Card a92a0913: CLAUDE_CONFIG_DIR is set in this test's env, so the function ALSO appends the two
  // absolute-path siblings after the two home-relative ones (never replaces) — plus, on win32, two more
  // plain-slashed siblings (round 3) — six total on win32, four elsewhere.
  const expectedAbsoluteBase = toClaudeAbsoluteGlob(PROJECTS_ROOT);
  const expectedPlainBase = PROJECTS_ROOT.replace(/\\/g, "/");
  const expectedOtherRules = [
    "Read(~/.claude/projects/*-proj-other-*/**)",
    `Read(~/.claude/projects/${encodeProjectDir("/repos/other")}/**)`,
    `Read(${expectedAbsoluteBase}/*-proj-other-*/**)`,
    `Read(${expectedAbsoluteBase}/${encodeProjectDir("/repos/other")}/**)`,
    ...(WIN32 ? [
      `Read(${expectedPlainBase}/*-proj-other-*/**)`,
      `Read(${expectedPlainBase}/${encodeProjectDir("/repos/other")}/**)`,
    ] : []),
  ];
  check("otherProjectTranscriptDenyRules returns the two documented home-relative shapes, PLUS their absolute-path siblings (two more plain-slashed siblings on win32, CLAUDE_CONFIG_DIR is set)",
    JSON.stringify(otherRules) === JSON.stringify(expectedOtherRules));

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
  check("role 'worker' + workerProjectDenyRules ⇒ the BLANKET root rule is NOT added (worker never gets the blanket)",
    !EXPECTED_TRANSCRIPT_ROOT_RULES.some((r) => workerWithRules.deny.includes(r)));
  check("role 'worker' + workerProjectDenyRules ⇒ exactly custom + every other-project rule shape, no more",
    workerWithRules.deny.length === otherRules.length + 1);

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
  // Card ed0757d6: withSettingsDirDenyForSpawn unions ITS OWN rule into EVERY spawn's deny at the SAME
  // createPty chokepoint, unconditionally (no role carve-out — see that function's own doc) — so a
  // real-write assertion in THIS file (which predates that card) must account for it too, or an exact
  // length/equality check here goes stale the moment that unrelated card lands. Import the real constant
  // rather than hand-copying its literal value, so this file can never drift from it independently.
  const { SETTINGS_DIR_READ_DENY_RULE } = await import("../dist/pty/claude-settings.js");
  // Card 37310431 (round 2): the LOOM_HOME write-deny is now a FLAT, registry-only map with no per-role
  // logic (no readdir, no disk dependency) — so its exact rule set can be computed in-process and
  // compared EXACTLY, rather than hand-deriving a shape-only "every other entry starts with Edit(" check
  // the way round 1's readdir-dependent, disk-content-dependent count required.
  const { loomHomeWriteDenyRules } = await import("../dist/pty/loom-home-deny.js");
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
    const writtenAssistant = readWrittenDeny(sidAssistant) ?? [];
    check("(real) assistant spawn: WRITTEN settings.json permissions.deny INCLUDES the transcript-root rule", writtenAssistant.includes(ROLE_DENY));
    check("(real) assistant spawn: WRITTEN settings.json permissions.deny ALSO INCLUDES the absolute-path sibling (CLAUDE_CONFIG_DIR is set)", writtenAssistant.includes(ABSOLUTE_PROJECTS_DENY));
    check("(real) assistant spawn: WRITTEN settings.json permissions.deny ALSO INCLUDES the win32 plain-slashed sibling (round 3, card a92a0913)", writtenAssistant.includes(PLAIN_SLASHED_PROJECTS_DENY));

    // (b) role="worker" — OUT of scope for the transcript-root rule. Card 37310431 (round 2): every real
    // spawn (worker included — that deny is role-UNCONDITIONAL, same posture as SETTINGS_DIR) now ALSO
    // carries the LOOM_HOME write-deny's own Edit(...) rules — a FLAT, registry-only set with no per-role
    // logic, so it can be asserted EXACTLY against `loomHomeWriteDenyRules({role, sessionId})` computed
    // in-process, rather than the shape-only "every other entry starts with Edit(" check round 1's
    // disk-dependent, role-gated count required.
    const sidWorker = "trdc-real-worker";
    host.spawn({ sessionId: sidWorker, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker" });
    spawned.push(sidWorker);
    const writtenWorker = readWrittenDeny(sidWorker) ?? [];
    const expectedLoomHomeWorker = loomHomeWriteDenyRules({ role: "worker", sessionId: sidWorker });
    check("(real) worker spawn: WRITTEN settings.json permissions.deny has NO role-scoped (transcript-root) entry leaked", !writtenWorker.includes(ROLE_DENY));
    check("(real) worker spawn: WRITTEN settings.json permissions.deny carries the unconditional SETTINGS_DIR rule (card ed0757d6)", writtenWorker.includes(SETTINGS_DIR_READ_DENY_RULE));
    check("(real) worker spawn: every OTHER entry is EXACTLY the LOOM_HOME write-deny's own computed rule set (card 37310431) — no more, no fewer, never an unaccounted third source",
      JSON.stringify(writtenWorker.filter((r) => r !== SETTINGS_DIR_READ_DENY_RULE).sort()) === JSON.stringify([...expectedLoomHomeWorker].sort()));
    check("(real) worker spawn: at least one LOOM_HOME write-deny rule was actually added (so the check above can fail)", expectedLoomHomeWorker.length > 0);

    // (c) role="assistant" with a project's OWN custom deny — union survives through the REAL write.
    const sidCustom = "trdc-real-assistant-custom";
    host.spawn({ sessionId: sidCustom, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "assistant" });
    spawned.push(sidCustom);
    const customWritten = readWrittenDeny(sidCustom) ?? [];
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json KEEPS the project's own custom entry", customWritten.includes(CUSTOM_DENY));
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json ALSO carries the role-scoped rule (union)", customWritten.includes(ROLE_DENY));
    // Card a92a0913: CLAUDE_CONFIG_DIR is set in this test's env, so a real blanket-role spawn ALSO writes
    // the absolute-path sibling — check it explicitly, and exclude it from the "every OTHER entry" filter
    // below (same posture as ROLE_DENY/CUSTOM_DENY/SETTINGS_DIR_READ_DENY_RULE).
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json ALSO carries the absolute-path transcript-root sibling", customWritten.includes(ABSOLUTE_PROJECTS_DENY));
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json ALSO carries the win32 plain-slashed sibling (round 3, card a92a0913)", customWritten.includes(PLAIN_SLASHED_PROJECTS_DENY));
    check("(real) assistant+custom-deny spawn: WRITTEN settings.json ALSO carries the unconditional SETTINGS_DIR rule (card ed0757d6)", customWritten.includes(SETTINGS_DIR_READ_DENY_RULE));
    // Card 37310431 (round 2): same exact-comparison fix as (b) above — see that block's comment for why.
    const expectedLoomHomeCustom = loomHomeWriteDenyRules({ role: "assistant", sessionId: sidCustom });
    check("(real) assistant+custom-deny spawn: every OTHER entry is EXACTLY the LOOM_HOME write-deny's own computed rule set, never an unaccounted third source",
      JSON.stringify(customWritten.filter((r) => r !== CUSTOM_DENY && r !== ROLE_DENY && r !== ABSOLUTE_PROJECTS_DENY && r !== PLAIN_SLASHED_PROJECTS_DENY && r !== SETTINGS_DIR_READ_DENY_RULE).sort()) === JSON.stringify([...expectedLoomHomeCustom].sort()));
    check("(real) assistant+custom-deny spawn: at least one LOOM_HOME write-deny rule was actually added (so the check above can fail)", expectedLoomHomeCustom.length > 0);

    // (d)-(f) card d78f8217: manager/platform/setup are now BLANKET-denied too.
    for (const [sid, role] of [["trdc-real-manager", "manager"], ["trdc-real-platform", "platform"], ["trdc-real-setup", "setup"]]) {
      host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [] }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role });
      spawned.push(sid);
      const writtenBlanket = readWrittenDeny(sid) ?? [];
      check(`(real) ${role} spawn: WRITTEN settings.json permissions.deny INCLUDES the transcript-root rule (d78f8217 blanket)`, writtenBlanket.includes(ROLE_DENY));
      check(`(real) ${role} spawn: WRITTEN settings.json permissions.deny ALSO INCLUDES the absolute-path sibling (CLAUDE_CONFIG_DIR is set)`, writtenBlanket.includes(ABSOLUTE_PROJECTS_DENY));
      check(`(real) ${role} spawn: WRITTEN settings.json permissions.deny ALSO INCLUDES the win32 plain-slashed sibling (round 3, card a92a0913)`, writtenBlanket.includes(PLAIN_SLASHED_PROJECTS_DENY));
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
    check("(real, project-scoped) worker's deny does NOT include the blanket root rule (worker never gets the blanket)",
      !EXPECTED_TRANSCRIPT_ROOT_RULES.some((r) => scopedDeny.includes(r)));
    check("(real, project-scoped) worker's deny ALSO carries the unconditional SETTINGS_DIR rule (card ed0757d6)", scopedDeny.includes(SETTINGS_DIR_READ_DENY_RULE));
    // Card 37310431 (round 2): same exact-comparison fix as (b)/(c) above — see (b)'s comment for why.
    const expectedLoomHomeScoped = loomHomeWriteDenyRules({ role: "worker", sessionId: sidScopedWorker });
    check("(real, project-scoped) worker's deny: every entry beyond the other-project rules + SETTINGS_DIR is EXACTLY the LOOM_HOME write-deny's own computed rule set, never an unaccounted third source",
      JSON.stringify(scopedDeny.filter((r) => !expectedOther.includes(r) && r !== SETTINGS_DIR_READ_DENY_RULE).sort()) === JSON.stringify([...expectedLoomHomeScoped].sort()));
    check("(real, project-scoped) worker's deny: at least one LOOM_HOME write-deny rule was actually added (so the check above can fail)", expectedLoomHomeScoped.length > 0);

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
