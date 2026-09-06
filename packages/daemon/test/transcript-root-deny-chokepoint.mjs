import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 3388be4d — the transcript-root deny (card ac90ca8e / 44fa586a) MOVED from `resolveAgentSpawn`
// (sessions/service.ts, exactly ONE of ten `pty.spawn` call sites) to `withTranscriptRootDenyForSpawn` at
// the single `PtyHost.createPty` spawn chokepoint (pty/host.ts) — so EVERY spawn path (fresh/resume/fork/
// recycle*/startRun/boot) inherits it structurally, keyed off the session's PINNED `role`, never
// re-derived from the (possibly-missing) agent row.
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

// =====================================================================================================
// PART 1 — the pure function, in isolation (no DB, no pty, no claude)
// =====================================================================================================
check("TRANSCRIPT_ROOT_DENY_ROLES = exactly {assistant, auditor, workspace-auditor} (the scope fence — no widening)",
  JSON.stringify([...TRANSCRIPT_ROOT_DENY_ROLES].sort()) === JSON.stringify(["assistant", "auditor", "workspace-auditor"]));
check("TRANSCRIPT_ROOT_DENY_RULES = exactly the one transcript-root rule",
  JSON.stringify(TRANSCRIPT_ROOT_DENY_RULES) === JSON.stringify([ROLE_DENY]));

// --- IN scope: assistant/auditor/workspace-auditor get the rule unioned in ---
for (const role of ["assistant", "auditor", "workspace-auditor"]) {
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

// --- OUT of scope: every other role, including the DELIBERATE run/manager/platform/worker exclusions ---
// (DoD-5: `run` ingests untrusted input by design and never reached the old call site either — 3388be4d
// is a MOVE, not a widening; adding `run` is the separate, already-approved, deferred card d78f8217.)
for (const role of ["worker", "manager", "platform", "run", "setup", null, undefined]) {
  const permission = { mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] };
  const out = withTranscriptRootDenyForSpawn(permission, role);
  check(`role '${String(role)}': OUT of scope — deny is the SAME object reference (byte-identical, no mutation)`, out === permission);
  check(`role '${String(role)}': OUT of scope — no rule leaked in`, !out.deny.includes(ROLE_DENY));
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
  } finally {
    for (const sid of spawned) { try { host.stop(sid, "hard"); } catch { /* best-effort cleanup */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — withTranscriptRootDenyForSpawn is correct in isolation (scoped to exactly assistant/auditor/workspace-auditor, unions with a project's own custom deny, idempotent, byte-identical elsewhere), AND the REAL (unsubclassed) createPty actually writes that deny into settings.json for a real spawn — the chokepoint is genuinely wired in, not just unit-tested."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
