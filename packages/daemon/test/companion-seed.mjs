import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the shipped default "Companion" RIG: an assistant-role Profile + a Companion agent bound
// to it, seeded via the CORE seed-if-absent pattern (ships to ALL users, NOT LOOM_DEV-gated). It is the
// default spawn TARGET for the human-triggered "New companion" provision flow — a TEMPLATE only: seeding it
// creates NO session and writes NO companion_config; the rig is invisible until a human provisions from it.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on setup-home.mjs: an isolated LOOM_HOME + sandboxed HOME,
// REAL Db handles + the REAL seeders. Proves:
//   (1) FRESH DB: seedDefaultProfiles seeds the ungated "Companion" profile (role=assistant, restrictedTools
//       true); seedCompanionAgent seeds a "Companion" agent bound to it into the reserved "Platform" home
//       with a LIGHT persona prompt — and creates NO session and NO companion_config.
//   (2) IDEMPOTENT: a re-seed (same process + a fresh DB handle / next boot) never duplicates the profile or
//       the agent, and NEVER clobbers a user-customized Companion profile or a user-edited Companion agent.
//   (3) UNGATED: the Companion profile seeds with LOOM_DEV unset (it is not a platform-exclusive role).
//   (4) NO-SPAWN INVARIANT: across every seed/re-seed above, the sessions + companion_config tables stay empty.
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-seed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). LOOM_DEV deliberately UNSET — the Companion rig is CORE and must seed on the default path. ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
delete process.env.LOOM_DEV;           // CORE seed must not depend on the dev flag

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome, seedCompanionAgent, SETUP_PROJECT_NAME, COMPANION_AGENT_NAME } = await import("../dist/setup/seed.js");
const { isLoomDev } = await import("../dist/paths.js");
const { ASSISTANT_BASE_BRIEF } = await import("../dist/sessions/assistant-prompt.js");

try {
  // ===================== (1) FRESH DB — the Companion rig seeds (profile + agent) =====================
  check("(3) isLoomDev() is FALSE (LOOM_DEV unset) — proves the rig is UNGATED", isLoomDev() === false);
  const dbA = new Db(path.join(tmpHome, "fresh.db"));

  // The Companion PROFILE seeds ungated with the core profiles.
  const seededProfiles = seedDefaultProfiles(dbA);
  check("(1) seedDefaultProfiles reports 'Companion' among the seeded core profiles", seededProfiles.includes("Companion"));
  const companionProfile = dbA.listProfiles().find((p) => p.name === "Companion");
  check("(1) the 'Companion' profile exists with role=assistant", companionProfile?.role === "assistant");
  check("(1) the 'Companion' profile is restrictedTools=true (least-privilege for chat)", companionProfile?.restrictedTools === true);
  check("(1) the 'Companion' profile carries a non-empty UI description + an icon",
    typeof companionProfile?.description === "string" && companionProfile.description.length > 20 && !!companionProfile.icon);
  // Not a platform-exclusive role, so it is NOT dev-gated: exactly one Companion profile even with LOOM_DEV unset.
  check("(3) exactly ONE 'Companion' profile seeded (ungated, not duplicated)",
    dbA.listProfiles().filter((p) => p.name === "Companion").length === 1);

  // The AGENT needs the reserved home to attach to — mirror boot: seedSetupHome FIRST, then seedCompanionAgent.
  check("(1) seedCompanionAgent no-ops before the setup home exists (nothing to attach to)", seedCompanionAgent(dbA) === null);
  seedSetupHome(dbA);
  const homeA = dbA.getReservedProjectByName(SETUP_PROJECT_NAME);
  const seededCompanionA = seedCompanionAgent(dbA);
  check("(1) seedCompanionAgent seeds the 'Companion' agent into the reserved 'Platform' home", seededCompanionA === COMPANION_AGENT_NAME);

  const companionAgent = dbA.listAgents(homeA.id).find((a) => a.name === COMPANION_AGENT_NAME);
  check("(1) the Companion agent is bound to the bundled 'Companion' profile (role assistant)",
    companionAgent?.profileId === companionProfile.id);
  check("(1) the Companion agent has a LIGHT, non-empty persona startup prompt", typeof companionAgent?.startupPrompt === "string" && companionAgent.startupPrompt.length > 40);
  // The server-owned ASSISTANT_BASE_BRIEF supplies identity + untrusted-input posture + chat_reply doctrine,
  // so the seeded persona prompt must NOT restate them (persona/tone only).
  check("(1) the persona prompt does NOT restate the untrusted-input posture (server-owned base brief supplies it)",
    !companionAgent.startupPrompt.includes("UNTRUSTED") && !ASSISTANT_BASE_BRIEF.includes(companionAgent.startupPrompt));
  check("(1) the persona prompt does NOT restate the chat_reply mechanism (base brief supplies it)",
    !companionAgent.startupPrompt.includes("chat_reply"));
  check("(1) the operator ('Platform') stays FIRST in the home (companion seeded after it)",
    dbA.listAgents(homeA.id)[0].name === "Platform");

  // ===================== (4) NO-SPAWN INVARIANT — no session, no companion_config =====================
  const assertNoSpawn = (phase) => {
    check(`(4) ${phase}: NO session created (sessions table empty)`, dbA.listAllSessionsIncludingArchived().length === 0);
    check(`(4) ${phase}: NO companion_config row created`, dbA.listCompanionConfigs().length === 0);
  };
  assertNoSpawn("after fresh seed");

  // ===================== (2) IDEMPOTENT — no duplicates, never clobber user edits =====================
  check("(2) second seedCompanionAgent in the same process no-ops (returns null)", seedCompanionAgent(dbA) === null);
  check("(2) second seedDefaultProfiles no longer re-seeds 'Companion' (preserved)", !seedDefaultProfiles(dbA).includes("Companion"));
  check("(2) still exactly ONE Companion agent after the idempotent re-run",
    dbA.listAgents(homeA.id).filter((a) => a.name === COMPANION_AGENT_NAME).length === 1);
  check("(2) still exactly ONE Companion profile after the idempotent re-run",
    dbA.listProfiles().filter((p) => p.name === "Companion").length === 1);
  assertNoSpawn("after in-process re-seed");
  dbA.close();

  // Re-open the persisted DB = the NEXT boot: re-seed still no-ops on both the profile and the agent.
  const dbA2 = new Db(path.join(tmpHome, "fresh.db"));
  check("(2) re-seed on a fresh DB handle (second boot): profile not re-seeded", !seedDefaultProfiles(dbA2).includes("Companion"));
  check("(2) re-seed on a fresh DB handle (second boot): agent not re-seeded (null)", seedCompanionAgent(dbA2) === null);
  check("(2) still exactly ONE Companion agent after the second boot", dbA2.listAgents(homeA.id).filter((a) => a.name === COMPANION_AGENT_NAME).length === 1);
  check("(2) second boot still creates NO session + NO companion_config",
    dbA2.listAllSessionsIncludingArchived().length === 0 && dbA2.listCompanionConfigs().length === 0);

  // A user CUSTOMIZES both rows — a re-seed must never clobber either.
  const custProfileId = dbA2.listProfiles().find((p) => p.name === "Companion").id;
  dbA2.updateProfile(custProfileId, { description: "MY EDITED DESCRIPTION", restrictedTools: false });
  const custAgent = dbA2.listAgents(homeA.id).find((a) => a.name === COMPANION_AGENT_NAME);
  dbA2.updateAgent(custAgent.id, { startupPrompt: "USER EDITED PERSONA" });
  check("(2) re-seed never clobbers a user-CUSTOMIZED Companion profile",
    !seedDefaultProfiles(dbA2).includes("Companion") && dbA2.getProfile(custProfileId).description === "MY EDITED DESCRIPTION" && dbA2.getProfile(custProfileId).restrictedTools === false);
  check("(2) re-seed never clobbers a user-EDITED Companion agent prompt",
    seedCompanionAgent(dbA2) === null && dbA2.getAgent(custAgent.id).startupPrompt === "USER EDITED PERSONA");
  dbA2.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the CORE (ungated) 'Companion' rig seeds a role=assistant restrictedTools profile + a Companion agent bound to it into the reserved 'Platform' home with a light persona prompt; idempotently across reboots (no duplicate profile/agent); never clobbers a user-customized profile or edited agent; and — the load-bearing invariant — creates NO session and NO companion_config (template only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
