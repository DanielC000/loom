import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a06650d2 — the manager surface's `agent_assign_profile` (SessionService.assignAgentProfile) used to
// have NO check at all beyond "does the profileId resolve" (Option B's premise: every assignable profile
// is human-blessed, so assignment can't escalate). That premise broke once (a) the ungated setup surface
// could mint its own manager/worker-role profiles, and (b) a human-minted profile could independently
// carry connections/capabilities/vaultWrite — fields that are human-only to CREATE but, until this card,
// were never checked at ASSIGN time. VERIFIED pre-fix by direct repro: a manager could bind its OWN agent
// to a platform/auditor/workspace-auditor/assistant-role profile, or to a worker-role profile carrying
// vaultWrite/connections/capabilities, with no rejection at all.
//
// HERMETIC + CLAUDE-FREE (real Db + SessionService against a no-op fake pty, same harness shape as
// mgr-own-project-scope.mjs). Proves, per the 3de74275 decision record's amendment:
//   (a) assignAgentProfile REJECTS a profile whose role is elevated/locked (platform/auditor/
//       workspace-auditor/assistant/operator/setup) — the manager surface NEVER gets allowElevatedRoles.
//   (b) assignAgentProfile REJECTS a profile carrying a non-empty connections, a non-empty capabilities,
//       or vaultWrite:true — regardless of role.
//   (c) every rejection makes NO write (the agent's profileId is left exactly as it was).
//   (d) an ordinary manager/worker/null-role profile with none of those fields still assigns fine
//       (regression guard — this task must stay additive for the common case).
//
// Card 1f52bc75 extends (b) to the 3 other AGENT_FORBIDDEN_PROFILE_KEYS members CREATE already
// fail-closed on but ASSIGN never checked (same gap class as a06650d2):
//   (e) assignAgentProfile REJECTS a profile carrying documentConversion:true, harness:"codex", or a
//       non-empty allowDelta — regardless of role, with no write (mirrors (b)/(c)).
//   (f) assignAgentProfile on a browserTesting:true profile (QA-Tester-shaped) still SUCCEEDS — this is
//       the ONE key deliberately excluded from the check (see the 3de74275 decision record's amendment):
//       agent_assign_profile's own tool description documents autonomously provisioning the bundled
//       "QA Tester"/"Web Designer" rigs as its intended use case.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-assignable-profile-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = (label, fn, re) => {
  let msg = null;
  try { fn(); } catch (e) { msg = (e instanceof Error ? e.message : String(e)); }
  check(label, msg !== null && (re ? re.test(msg) : true));
  return msg;
};

const tmpHome = path.join(os.tmpdir(), `loom-assignguard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

db.insertProject({ id: "pMine", name: "Mine", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "aMine", projectId: "pMine", name: "Dev", startupPrompt: "MINE", position: 0, profileId: null });

// (a) elevated/locked-role fixtures.
db.insertProfile({ id: "profPlatform", name: "Platform Rig", role: "platform", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profAuditor", name: "Auditor Rig", role: "auditor", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profWorkspaceAuditor", name: "Workspace Auditor Rig", role: "workspace-auditor", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profAssistant", name: "Companion Rig", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, restrictedTools: true });
db.insertProfile({ id: "profOperator", name: "Operator Rig", role: "operator", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "profSetup", name: "Setup Rig", role: "setup", description: "", allowDelta: [], skills: null, model: null, icon: null });

// (b) non-elevated (worker) role, each carrying ONE human-only field.
db.insertProfile({ id: "profVaultWrite", name: "Vault Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, vaultWrite: true });
db.insertProfile({ id: "profConnections", name: "Connections Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: ["connX"] });
db.insertProfile({ id: "profCapabilities", name: "Capabilities Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, capabilities: [{ slug: "some-cap" }] });

// (d) a clean profile with neither an elevated role nor any human-only field — the regression case.
db.insertProfile({ id: "profClean", name: "Clean Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

// (e) non-elevated role, each carrying ONE of the 3 newly-checked human-only fields.
db.insertProfile({ id: "profDocConversion", name: "DocConversion Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, documentConversion: true });
db.insertProfile({ id: "profHarnessCodex", name: "Codex Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
db.insertProfile({ id: "profAllowDelta", name: "AllowDelta Rig", role: "worker", description: "", allowDelta: ["Bash(*)"], skills: null, model: null, icon: null });
// harness:"claude" explicit is the same as absent/default — must NOT be rejected (it isn't "codex").
db.insertProfile({ id: "profHarnessClaude", name: "Claude Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "claude" });
// Code review (fe4ae005): fail-closed on ANY unknown future harness value, not an allowlist of "codex"
// specifically — simulated here with a value outside today's HARNESS_ID_SCHEMA enum (runtime has no
// enum enforcement; the point is the CHECK's own `!= null && !== "claude"` logic, not DB validation).
db.insertProfile({ id: "profHarnessFuture", name: "Future Harness Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "some-future-vendor" });

// (f) a QA-Tester-shaped profile (browserTesting:true, otherwise clean) — the deliberately-UNCHECKED key.
db.insertProfile({ id: "profBrowserTesting", name: "QA Tester Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: true });

db.insertSession({
  id: "M", projectId: "pMine", agentId: "aMine", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});

const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());

try {
  // ════════ (a) elevated/locked role → REJECTED, no write ════════
  for (const [id, label] of [
    ["profPlatform", "platform"], ["profAuditor", "auditor"],
    ["profWorkspaceAuditor", "workspace-auditor"], ["profAssistant", "assistant"],
    ["profOperator", "operator"], ["profSetup", "setup"],
  ]) {
    rejects(`assignAgentProfile REJECTS a "${label}"-role profile`,
      () => svc.assignAgentProfile("M", "aMine", id), new RegExp(label));
    check(`assignAgentProfile left aMine's profileId UNCHANGED after the "${label}" rejection`, db.getAgent("aMine").profileId === null);
  }

  // ════════ (b) non-elevated role, human-only field → REJECTED, no write ════════
  rejects("assignAgentProfile REJECTS a profile carrying vaultWrite:true",
    () => svc.assignAgentProfile("M", "aMine", "profVaultWrite"), /vaultWrite/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the vaultWrite rejection", db.getAgent("aMine").profileId === null);
  rejects("assignAgentProfile REJECTS a profile carrying a non-empty connections",
    () => svc.assignAgentProfile("M", "aMine", "profConnections"), /connections/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the connections rejection", db.getAgent("aMine").profileId === null);
  rejects("assignAgentProfile REJECTS a profile carrying a non-empty capabilities",
    () => svc.assignAgentProfile("M", "aMine", "profCapabilities"), /capabilities/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the capabilities rejection", db.getAgent("aMine").profileId === null);

  // ════════ (e) card 1f52bc75: documentConversion / harness("codex") / non-empty allowDelta → REJECTED ════════
  rejects("assignAgentProfile REJECTS a profile carrying documentConversion:true",
    () => svc.assignAgentProfile("M", "aMine", "profDocConversion"), /documentConversion/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the documentConversion rejection", db.getAgent("aMine").profileId === null);
  rejects("assignAgentProfile REJECTS a profile carrying harness \"codex\"",
    () => svc.assignAgentProfile("M", "aMine", "profHarnessCodex"), /codex/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the harness rejection", db.getAgent("aMine").profileId === null);
  rejects("assignAgentProfile REJECTS a profile carrying a non-empty allowDelta",
    () => svc.assignAgentProfile("M", "aMine", "profAllowDelta"), /allowDelta/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the allowDelta rejection", db.getAgent("aMine").profileId === null);
  // Code review: fail-CLOSED on any unknown future harness value, not a "codex"-only allowlist.
  rejects("assignAgentProfile REJECTS a profile carrying an UNKNOWN (future) harness value",
    () => svc.assignAgentProfile("M", "aMine", "profHarnessFuture"), /some-future-vendor/);
  check("assignAgentProfile left aMine's profileId UNCHANGED after the unknown-harness rejection", db.getAgent("aMine").profileId === null);

  // ════════ (d) a clean (no elevated role, no human-only field) profile still assigns fine ════════
  const assigned = svc.assignAgentProfile("M", "aMine", "profClean");
  check("assignAgentProfile on a CLEAN profile still SUCCEEDS (regression guard)",
    assigned.profileId === "profClean" && db.getAgent("aMine").profileId === "profClean");
  // Clearing (profileId: null) is unaffected — there's no profile to check.
  const cleared = svc.assignAgentProfile("M", "aMine", null);
  check("assignAgentProfile(profileId: null) still CLEARS fine (regression guard)",
    cleared.profileId === null && db.getAgent("aMine").profileId === null);

  // ════════ (f) card 1f52bc75: an explicit harness:"claude" is the default, NOT rejected ════════
  const claudeAssigned = svc.assignAgentProfile("M", "aMine", "profHarnessClaude");
  check("assignAgentProfile on a profile carrying harness:\"claude\" (the default) still SUCCEEDS",
    claudeAssigned.profileId === "profHarnessClaude" && db.getAgent("aMine").profileId === "profHarnessClaude");

  // ════════ (g) card 1f52bc75: browserTesting is DELIBERATELY unchecked — a QA-Tester-shaped profile
  // still assigns fine (this is the key finding from the investigate-first checkpoint: agent_assign_profile's
  // own tool description documents this as its intended, no-human-needed provisioning path) ════════
  const browserAssigned = svc.assignAgentProfile("M", "aMine", "profBrowserTesting");
  check("assignAgentProfile on a browserTesting:true (QA-Tester-shaped) profile still SUCCEEDS",
    browserAssigned.profileId === "profBrowserTesting" && db.getAgent("aMine").profileId === "profBrowserTesting");
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the manager surface's agent_assign_profile now REJECTS a profile whose role is elevated/locked (platform/auditor/workspace-auditor/assistant), or that carries connections/capabilities/vaultWrite/documentConversion/harness(\"codex\")/a non-empty allowDelta, with NO write in every case, while an ordinary clean profile (a clear, an explicit harness:\"claude\", or a browserTesting:true QA-Tester-shaped profile) still assigns fine — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
