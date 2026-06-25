import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup Assistant E1-4 — the reserved, UNGATED "Platform" onboarding home + its Setup Assistant
// agent, AND the name-scoped reserved-project idempotency that lets it coexist with the dev-only platform
// home. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on platform-dev-flag.mjs: an isolated LOOM_HOME +
// sandboxed HOME, REAL Db handles (separate files per phase) + the REAL seeders. isLoomDev() reads
// process.env.LOOM_DEV at CALL time, so one process exercises BOTH modes by toggling the env. Proves:
//   (1) DEFAULT boot (LOOM_DEV unset): seedSetupHome seeds the reserved "Platform" setup home + a single
//       "Setup Assistant" agent bound to the ungated Setup Assistant profile — and is idempotent across a
//       re-seed AND a fresh DB handle (a second boot); the home is hidden from the picker, in the admin feed.
//   (2) COEXISTENCE (LOOM_DEV=1): both reserved homes seed and live side-by-side — each name-scoped check
//       keys to its OWN name, so neither suppresses the other; both stay idempotent; platform-home seeding
//       is UNCHANGED (regression: still the "Loom Platform" project + its TWO agents).
//   (3) THE BUG THE FIX PREVENTS: the OLD name-agnostic hasReservedProject() is true after EITHER seed, so
//       it would have silently skipped the second home. The name-scoped gate lets the other home still seed.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-home.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). LOOM_DEV is deliberately LEFT UNSET — phase 1 needs the default; phase 2 sets it. ---
const tmpHome = path.join(os.tmpdir(), `loom-sh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
delete process.env.LOOM_DEV;           // ensure phase 1 sees the default-OFF state

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { seedSetupHome, seedSetupProjectRename, seedSetupAgentRename, seedSetupAuditorAgent, SETUP_PROJECT_NAME, SETUP_AGENT_NAME, SETUP_AUDITOR_AGENT_NAME } = await import("../dist/setup/seed.js");
const now = new Date().toISOString();
const { isLoomDev } = await import("../dist/paths.js");

try {
  // ===================== (1) DEFAULT boot — LOOM_DEV unset =====================
  check("(1) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
  const dbA = new Db(path.join(tmpHome, "default.db"));
  seedDefaultProfiles(dbA);
  const seededSetupA = seedSetupHome(dbA);
  check("(1) seedSetupHome seeds the 'Platform' setup home + Platform operator agent (ungated)",
    seededSetupA.includes(`project:${SETUP_PROJECT_NAME}`) && seededSetupA.includes(`agent:${SETUP_AGENT_NAME}`));
  // The platform home must NOT seed in default mode (proves my change didn't accidentally ungate it).
  const seededPlatA = seedPlatformHome(dbA);
  check("(1) seedPlatformHome still no-ops by default (platform stays dev-gated)", seededPlatA.length === 0);

  const reservedA = dbA.listAllProjects().filter((p) => p.reserved);
  check("(1) exactly ONE reserved project (the setup home only)", reservedA.length === 1);
  const setupProject = reservedA[0];
  check("(1) the reserved project is the 'Platform' setup home bound to LOOM_HOME",
    setupProject.name === SETUP_PROJECT_NAME && setupProject.repoPath === tmpHome && setupProject.vaultPath === tmpHome);
  const agentsA = dbA.listAgents(setupProject.id);
  check("(1) exactly ONE agent seeded into the setup home", agentsA.length === 1);
  const assistant = agentsA[0];
  check("(1) the agent is the Platform operator with a NON-empty default startupPrompt",
    assistant?.name === SETUP_AGENT_NAME && assistant?.name === "Platform" && typeof assistant.startupPrompt === "string" && assistant.startupPrompt.length > 200);
  check("(1) the agent prompt references its /setup-assistant doctrine skill", assistant.startupPrompt.includes("/setup-assistant"));
  const profById = new Map(dbA.listProfiles().map((p) => [p.id, p]));
  check("(1) the agent is bound to the bundled 'Setup Assistant' profile (role setup)",
    profById.get(assistant.profileId)?.name === "Setup Assistant" && profById.get(assistant.profileId)?.role === "setup");

  // Hidden from the picker, present in the inclusive admin feed.
  check("(1) listProjects() (the picker) EXCLUDES the reserved setup home",
    !dbA.listProjects().some((p) => p.name === SETUP_PROJECT_NAME));
  check("(1) listAllProjects() INCLUDES the reserved setup home",
    dbA.listAllProjects().some((p) => p.name === SETUP_PROJECT_NAME && p.reserved));

  // Idempotent: a second seed in-process AND a fresh DB handle (a second boot) both no-op.
  const reSetupA = seedSetupHome(dbA);
  check("(1) second seedSetupHome in the same process is a no-op (returns [])", reSetupA.length === 0);
  dbA.close();
  const dbA2 = new Db(path.join(tmpHome, "default.db")); // re-open the persisted DB = the NEXT boot
  const reSetupA2 = seedSetupHome(dbA2);
  check("(1) re-seed on a fresh DB handle (second boot) is a no-op", reSetupA2.length === 0);
  check("(1) still exactly ONE reserved setup home after re-seed", dbA2.listAllProjects().filter((p) => p.reserved).length === 1);
  check("(1) still exactly ONE Setup Assistant agent after re-seed", dbA2.listAgents(setupProject.id).length === 1);
  dbA2.close();

  // ===================== (2) COEXISTENCE — LOOM_DEV=1 (both homes) =====================
  process.env.LOOM_DEV = "1";
  check("(2) isLoomDev() is TRUE when LOOM_DEV=1", isLoomDev() === true);
  const dbB = new Db(path.join(tmpHome, "coexist.db"));
  seedDefaultProfiles(dbB);
  // Seed the SETUP home FIRST, then the PLATFORM home — the bug case: if idempotency were name-agnostic,
  // the platform seed would see "a reserved project already exists" and silently skip.
  const setupB = seedSetupHome(dbB);
  // BUG-THE-FIX-PREVENTS: a reserved project now exists, so the OLD name-agnostic gate would be true...
  check("(3) name-agnostic hasReservedProject() is TRUE after the setup seed (the old, ambiguous signal)",
    dbB.hasReservedProject() === true);
  // ...yet the name-scoped gate for the platform home is still false, so the platform home STILL seeds.
  check("(3) name-scoped hasReservedProjectNamed(platform) is FALSE before its seed",
    dbB.hasReservedProjectNamed(PLATFORM_PROJECT_NAME) === false);
  const platB = seedPlatformHome(dbB);
  check("(2) setup home seeded its project + agent", setupB.includes(`project:${SETUP_PROJECT_NAME}`) && setupB.includes(`agent:${SETUP_AGENT_NAME}`));
  check("(2) platform home STILL seeds despite the setup home already existing (name-scoped gate)",
    platB.includes(`project:${PLATFORM_PROJECT_NAME}`) && platB.includes("agent:Platform Lead") && platB.includes("agent:Platform Auditor"));

  const reservedB = dbB.listAllProjects().filter((p) => p.reserved);
  check("(2) BOTH reserved homes coexist (exactly TWO reserved projects)", reservedB.length === 2);
  check("(2) the two reserved homes are the setup + platform homes (distinct names)",
    new Set(reservedB.map((p) => p.name)).size === 2 &&
    reservedB.some((p) => p.name === SETUP_PROJECT_NAME) && reservedB.some((p) => p.name === PLATFORM_PROJECT_NAME));
  const setupHomeB = dbB.getReservedProjectByName(SETUP_PROJECT_NAME);
  const platHomeB = dbB.getReservedProjectByName(PLATFORM_PROJECT_NAME);
  check("(2) getReservedProjectByName resolves each home distinctly",
    setupHomeB?.name === SETUP_PROJECT_NAME && platHomeB?.name === PLATFORM_PROJECT_NAME && setupHomeB.id !== platHomeB.id);
  // Regression: platform home seeding is byte-for-byte unchanged — still its TWO agents; setup has ONE.
  check("(2) regression: platform home still has exactly TWO agents", dbB.listAgents(platHomeB.id).length === 2);
  check("(2) setup home has exactly ONE agent", dbB.listAgents(setupHomeB.id).length === 1);

  // Both idempotent together: re-seeding either no-ops, the two homes remain.
  check("(2) re-seedSetupHome is a no-op with both homes present", seedSetupHome(dbB).length === 0);
  check("(2) re-seedPlatformHome is a no-op with both homes present", seedPlatformHome(dbB).length === 0);
  check("(2) still exactly TWO reserved homes after both re-seeds", dbB.listAllProjects().filter((p) => p.reserved).length === 2);
  check("(2) still TWO platform agents + ONE setup agent after re-seeds",
    dbB.listAgents(platHomeB.id).length === 2 && dbB.listAgents(setupHomeB.id).length === 1);
  dbB.close();

  // ===================== (3) reverse order — platform FIRST, then setup =====================
  // Symmetric proof: seeding the platform home first must NOT suppress the setup home (the other direction).
  const dbC = new Db(path.join(tmpHome, "reverse.db"));
  seedDefaultProfiles(dbC);
  seedPlatformHome(dbC);
  check("(3) name-scoped hasReservedProjectNamed(setup) is FALSE before the setup seed (platform exists)",
    dbC.hasReservedProjectNamed(SETUP_PROJECT_NAME) === false);
  const setupC = seedSetupHome(dbC);
  check("(3) setup home STILL seeds despite the platform home already existing (reverse order)",
    setupC.includes(`project:${SETUP_PROJECT_NAME}`) && setupC.includes(`agent:${SETUP_AGENT_NAME}`));
  check("(3) both reserved homes present after reverse-order seeding", dbC.listAllProjects().filter((p) => p.reserved).length === 2);
  dbC.close();

  // ===================== (4) A2 guarded one-shot rename migration (existing installs) =====================
  // seedSetupHome no-ops once the home exists, so installs seeded BEFORE the Setup Assistant → "Platform"
  // rebrand keep the OLD operator name. seedSetupAgentRename backfills the single reserved-home operator
  // agent on boot — and ONLY that one: never a user-renamed agent, never a non-reserved-home agent.
  const dbD = new Db(path.join(tmpHome, "rename.db"));
  seedDefaultProfiles(dbD);
  seedSetupHome(dbD);
  const homeD = dbD.getReservedProjectByName(SETUP_PROJECT_NAME);
  const setupProfileId = dbD.listProfiles().find((p) => p.name === "Setup Assistant").id;
  // Simulate a pre-rebrand install: rename the seeded operator agent back to the OLD literal.
  const opD = dbD.listAgents(homeD.id)[0];
  dbD.updateAgent(opD.id, { name: "Setup Assistant" });
  // A user-renamed operator agent in the SAME home — must be left alone (only the exact old literal renames).
  dbD.insertAgent({ id: "user-renamed", projectId: homeD.id, name: "My Helper", startupPrompt: "x", position: 1, profileId: setupProfileId, endpoint: false, ioSchema: null });
  // A NON-reserved project with an agent that happens to be named "Setup Assistant" — must be left alone.
  dbD.insertProject({ id: "ord-rn", name: "RealWork", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  dbD.insertAgent({ id: "ord-agent", projectId: "ord-rn", name: "Setup Assistant", startupPrompt: "x", position: 0, profileId: setupProfileId, endpoint: false, ioSchema: null });

  const renamed = seedSetupAgentRename(dbD);
  check("(4) migration renames the legacy 'Setup Assistant' operator agent → 'Platform'",
    renamed === SETUP_AGENT_NAME && dbD.getAgent(opD.id)?.name === SETUP_AGENT_NAME);
  check("(4) migration leaves a user-renamed agent ('My Helper') in the SAME home untouched",
    dbD.getAgent("user-renamed")?.name === "My Helper");
  check("(4) migration leaves a NON-reserved-home 'Setup Assistant' agent untouched",
    dbD.getAgent("ord-agent")?.name === "Setup Assistant");
  check("(4) migration is idempotent — a second run finds no legacy literal → no-op (null)",
    seedSetupAgentRename(dbD) === null);
  dbD.close();

  // Fresh install: the seed already created "Platform", so the migration no-ops (nothing to backfill).
  const dbE = new Db(path.join(tmpHome, "fresh-rename.db"));
  seedDefaultProfiles(dbE);
  seedSetupHome(dbE);
  const homeE = dbE.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(4) fresh install seeds operator as 'Platform' AND the migration no-ops on it",
    dbE.listAgents(homeE.id)[0].name === SETUP_AGENT_NAME && seedSetupAgentRename(dbE) === null);
  dbE.close();

  // ===================== (5) B4 — the bundled Workspace Auditor agent (one home, TWO agents) =====================
  // seedSetupAuditorAgent seeds a SECOND agent into the SAME reserved "Platform" setup home, seed-if-absent
  // BY AGENT-NAME — a separate boot-time backfill (NOT folded into seedSetupHome, which no-ops once the home
  // exists). It must: backfill EXISTING installs (home + operator already there → add the auditor), cover
  // FRESH installs (operator + auditor on one boot), be idempotent (present → no-op), never clobber a
  // user-renamed agent, and leave the OPERATOR resolvable by SETUP_AGENT_NAME with both agents present.

  // (5a) FRESH install: seedSetupHome (operator only) THEN seedSetupAuditorAgent (auditor) on the same boot.
  const dbF = new Db(path.join(tmpHome, "auditor-fresh.db"));
  seedDefaultProfiles(dbF);
  seedSetupHome(dbF);
  const homeF = dbF.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(5a) before the auditor seed the fresh home has ONLY the operator agent",
    dbF.listAgents(homeF.id).length === 1 && dbF.listAgents(homeF.id)[0].name === SETUP_AGENT_NAME);
  const seededAudF = seedSetupAuditorAgent(dbF);
  check("(5a) seedSetupAuditorAgent seeds the 'Workspace Auditor' agent on a fresh install", seededAudF === SETUP_AUDITOR_AGENT_NAME);
  const agentsF = dbF.listAgents(homeF.id);
  check("(5a) the fresh home now holds BOTH agents — operator 'Platform' + 'Workspace Auditor'",
    agentsF.length === 2 && agentsF.some((a) => a.name === SETUP_AGENT_NAME) && agentsF.some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));
  const profByIdF = new Map(dbF.listProfiles().map((p) => [p.id, p]));
  const operatorF = agentsF.find((a) => a.name === SETUP_AGENT_NAME);
  const auditorF = agentsF.find((a) => a.name === SETUP_AUDITOR_AGENT_NAME);
  check("(5a) operator stays bound to the setup-role 'Setup Assistant' profile (unchanged by the 2nd agent)",
    profByIdF.get(operatorF.profileId)?.name === "Setup Assistant" && profByIdF.get(operatorF.profileId)?.role === "setup");
  check("(5a) auditor is bound to the bundled 'Workspace Auditor' profile (role workspace-auditor)",
    profByIdF.get(auditorF.profileId)?.name === "Workspace Auditor" && profByIdF.get(auditorF.profileId)?.role === "workspace-auditor");
  check("(5a) the auditor's default prompt loads its /workspace-audit doctrine skill + is non-empty",
    typeof auditorF.startupPrompt === "string" && auditorF.startupPrompt.includes("/workspace-audit") && auditorF.startupPrompt.length > 200);
  check("(5a) the operator stays FIRST in the home (auditor seeded after it, position-ordered)",
    dbF.listAgents(homeF.id)[0].name === SETUP_AGENT_NAME);
  // Idempotent: a second call no-ops, and a re-seed on a fresh DB handle (next boot) also no-ops.
  check("(5a) second seedSetupAuditorAgent in the same process no-ops (returns null)", seedSetupAuditorAgent(dbF) === null);
  check("(5a) still exactly TWO agents after the idempotent re-run", dbF.listAgents(homeF.id).length === 2);
  dbF.close();
  const dbF2 = new Db(path.join(tmpHome, "auditor-fresh.db")); // reopen = the NEXT boot
  check("(5a) re-seed on a fresh DB handle (second boot) no-ops AND keeps exactly two agents",
    seedSetupAuditorAgent(dbF2) === null && dbF2.listAgents(homeF.id).length === 2);
  dbF2.close();

  // (5b) EXISTING install (the gotcha #2 backfill): a home seeded BEFORE B4 has ONLY the operator. On the
  // next boot seedSetupAuditorAgent backfills the auditor — even though seedSetupHome itself no-ops.
  const dbG = new Db(path.join(tmpHome, "auditor-backfill.db"));
  seedDefaultProfiles(dbG);
  seedSetupHome(dbG); // simulates the pre-B4 install: home + operator only
  const homeG = dbG.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(5b) pre-B4 existing install has ONLY the operator (no auditor yet)",
    dbG.listAgents(homeG.id).length === 1 && !dbG.listAgents(homeG.id).some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));
  check("(5b) seedSetupHome STILL no-ops on the existing home (the reason the auditor needs its own seeder)",
    seedSetupHome(dbG).length === 0);
  const backfilled = seedSetupAuditorAgent(dbG);
  check("(5b) seedSetupAuditorAgent BACKFILLS the auditor onto the existing install", backfilled === SETUP_AUDITOR_AGENT_NAME);
  check("(5b) the existing home now has BOTH agents", dbG.listAgents(homeG.id).length === 2 &&
    dbG.listAgents(homeG.id).some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));
  check("(5b) re-running the backfill is idempotent (returns null, no duplicate)",
    seedSetupAuditorAgent(dbG) === null && dbG.listAgents(homeG.id).filter((a) => a.name === SETUP_AUDITOR_AGENT_NAME).length === 1);

  // (5c) NEVER clobbers a user EDIT to the seeded auditor: a user who edits the auditor's prompt keeps it.
  const auditorG = dbG.listAgents(homeG.id).find((a) => a.name === SETUP_AUDITOR_AGENT_NAME);
  dbG.updateAgent(auditorG.id, { startupPrompt: "USER EDITED" });
  check("(5c) a re-seed never clobbers the user's edited auditor prompt (seed-if-absent by name)",
    seedSetupAuditorAgent(dbG) === null && dbG.getAgent(auditorG.id)?.startupPrompt === "USER EDITED");

  // (5d) the seeder is scoped to the RESERVED home by NAME (gotcha #1): a NON-reserved project with an
  // agent named "Workspace Auditor" is irrelevant — the seeder only ever touches the reserved home.
  dbG.insertProject({ id: "ord-aud", name: "RealWork2", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  dbG.insertAgent({ id: "ord-aud-agent", projectId: "ord-aud", name: SETUP_AUDITOR_AGENT_NAME, startupPrompt: "x", position: 0, profileId: null, endpoint: false, ioSchema: null });
  check("(5d) a same-named agent in a NON-reserved project does not affect the reserved-home seeder (still no-op)",
    seedSetupAuditorAgent(dbG) === null && dbG.listAgents(homeG.id).filter((a) => a.name === SETUP_AUDITOR_AGENT_NAME).length === 1);
  dbG.close();

  // (5e) no setup home at all → the auditor seeder no-ops (nothing to attach to; seedSetupHome runs first).
  const dbH = new Db(path.join(tmpHome, "auditor-nohome.db"));
  seedDefaultProfiles(dbH);
  check("(5e) seedSetupAuditorAgent no-ops when the setup home is absent", seedSetupAuditorAgent(dbH) === null);
  dbH.close();

  // ===================== (6) "Getting Started" → "Platform" home rename migration (existing installs) =====
  // seedSetupHome is seed-if-absent keyed on the NEW name, so an install seeded BEFORE this rename keeps its
  // reserved home ROW under the OLD "Getting Started" literal while every resolver now looks it up by the new
  // SETUP_PROJECT_NAME. seedSetupProjectRename renames that one reserved home IN PLACE — and ONLY that one:
  // never a user-renamed home, never a user's ordinary project, never when a reserved "Platform" already
  // exists. It must run BEFORE seedSetupHome at boot (else seedSetupHome mints a 2nd empty "Platform" home).
  const LEGACY = "Getting Started";
  check("(6) the rename landed — SETUP_PROJECT_NAME is now 'Platform' (distinct from 'Loom Platform')",
    SETUP_PROJECT_NAME === "Platform" && SETUP_PROJECT_NAME !== PLATFORM_PROJECT_NAME);

  // (6a) EXISTING install: a reserved home seeded under the OLD literal → the migration backfills it in place.
  const dbI = new Db(path.join(tmpHome, "home-rename.db"));
  seedDefaultProfiles(dbI);
  const oldHomeId = "old-setup-home";
  dbI.insertProject({ id: oldHomeId, name: LEGACY, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(6a) pre-rename: the reserved home resolves under the OLD literal only (new name not yet present)",
    dbI.getReservedProjectByName(LEGACY)?.id === oldHomeId && dbI.getReservedProjectByName(SETUP_PROJECT_NAME) === undefined);
  const renamedHome = seedSetupProjectRename(dbI);
  check("(6a) migration renames the reserved 'Getting Started' home → 'Platform' (returns the new name)",
    renamedHome === SETUP_PROJECT_NAME && dbI.getProject(oldHomeId)?.name === SETUP_PROJECT_NAME);
  check("(6a) getReservedProjectByName('Platform') resolves the SAME row post-rename (id stable, renamed in place)",
    dbI.getReservedProjectByName(SETUP_PROJECT_NAME)?.id === oldHomeId);
  check("(6a) the old literal no longer resolves to any reserved home after the rename",
    dbI.getReservedProjectByName(LEGACY) === undefined && dbI.hasReservedProjectNamed(LEGACY) === false);
  check("(6a) still exactly ONE reserved home after the rename (renamed in place, not duplicated)",
    dbI.listAllProjects().filter((p) => p.reserved).length === 1);
  check("(6a) migration is idempotent — a second run finds no legacy home → no-op (null)",
    seedSetupProjectRename(dbI) === null);
  dbI.close();

  // (6b) FRESH install: seedSetupHome already creates the home under the NEW name → the migration no-ops.
  const dbJ = new Db(path.join(tmpHome, "home-rename-fresh.db"));
  seedDefaultProfiles(dbJ);
  seedSetupHome(dbJ);
  check("(6b) fresh install seeds the home as 'Platform' AND the migration no-ops on it (null)",
    dbJ.getReservedProjectByName(SETUP_PROJECT_NAME)?.name === SETUP_PROJECT_NAME && seedSetupProjectRename(dbJ) === null);
  check("(6b) no reserved home is ever named under the old literal on a fresh install",
    dbJ.hasReservedProjectNamed(LEGACY) === false);
  dbJ.close();

  // (6c) USER-RENAMED home: a reserved home the user renamed to something else is left ALONE (the migration
  // only matches the EXACT old literal); and a user's ORDINARY (non-reserved) project named "Getting Started"
  // is never touched (the lookup is reserved-scoped).
  const dbK = new Db(path.join(tmpHome, "home-rename-user.db"));
  seedDefaultProfiles(dbK);
  dbK.insertProject({ id: "user-home", name: "My Workspace", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  dbK.insertProject({ id: "ord-gs", name: LEGACY, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  check("(6c) migration no-ops when no RESERVED home carries the old literal (user-renamed home untouched)",
    seedSetupProjectRename(dbK) === null && dbK.getProject("user-home")?.name === "My Workspace");
  check("(6c) a user's ORDINARY project named 'Getting Started' is never renamed (reserved-scoped lookup)",
    dbK.getProject("ord-gs")?.name === LEGACY);
  dbK.close();

  // (6d) COLLISION guard: if a reserved "Platform" ALREADY exists, an old-named reserved home is NOT renamed
  // into it — never creates a duplicate / clobbers a distinct reserved "Platform".
  const dbL = new Db(path.join(tmpHome, "home-rename-collision.db"));
  seedDefaultProfiles(dbL);
  dbL.insertProject({ id: "new-plat", name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  dbL.insertProject({ id: "old-gs", name: LEGACY, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(6d) migration refuses to rename when a reserved 'Platform' already exists (collision guard → null)",
    seedSetupProjectRename(dbL) === null && dbL.getProject("old-gs")?.name === LEGACY && dbL.getProject("new-plat")?.name === SETUP_PROJECT_NAME);
  dbL.close();

  // (6e) ABSENT home: no reserved home at all → the migration no-ops (nothing to rename).
  const dbM = new Db(path.join(tmpHome, "home-rename-absent.db"));
  seedDefaultProfiles(dbM);
  check("(6e) migration no-ops when there is no reserved home at all (null)", seedSetupProjectRename(dbM) === null);
  dbM.close();

  // (6f) END-TO-END boot order: on a pre-rename install, running the rename BEFORE seedSetupHome (as boot
  // does) renames the existing home in place — NOT a 2nd empty home; the operator agent stays attached.
  const dbN = new Db(path.join(tmpHome, "home-rename-bootorder.db"));
  seedDefaultProfiles(dbN);
  const preHomeId = "pre-rename-home";
  dbN.insertProject({ id: preHomeId, name: LEGACY, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  dbN.insertAgent({ id: "pre-op", projectId: preHomeId, name: SETUP_AGENT_NAME, startupPrompt: "x".repeat(220), position: 0, profileId: null, endpoint: false, ioSchema: null });
  seedSetupProjectRename(dbN); // boot runs this FIRST...
  const afterSeed = seedSetupHome(dbN); // ...then seedSetupHome, which must now find "Platform" and no-op
  check("(6f) boot order (rename THEN seedSetupHome) keeps exactly ONE reserved home (no duplicate seeded)",
    afterSeed.length === 0 && dbN.listAllProjects().filter((p) => p.reserved).length === 1);
  check("(6f) the renamed home is the SAME row (id stable) and still holds its operator agent",
    dbN.getReservedProjectByName(SETUP_PROJECT_NAME)?.id === preHomeId && dbN.listAgents(preHomeId).some((a) => a.name === SETUP_AGENT_NAME));
  dbN.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the ungated 'Platform' setup home + 'Platform' operator agent seed for every user (no LOOM_DEV gate), idempotently across reboots, COEXIST with the dev-only 'Loom Platform' home (name-scoped gate; platform seeding unchanged at 2 agents); the A2 guarded rename backfills a pre-rebrand 'Setup Assistant' operator → 'Platform' while leaving user-renamed + non-reserved-home agents untouched; the B4 seedSetupAuditorAgent backfill seeds a 2nd 'Workspace Auditor' agent into the SAME home (fresh + existing installs), idempotently, never clobbering a user edit and scoped to the reserved home by name; and the 'Getting Started' → 'Platform' home rename migration backfills an existing install's reserved home IN PLACE (idempotent, collision-refusing, reserved-scoped, no-op on fresh/user-renamed/absent homes), with the boot order (rename THEN seed) never minting a duplicate home."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
