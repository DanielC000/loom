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
//   (7)-(11) card a47dd144: both homes now resolve by a STABLE app_meta id marker, not their `name` — a
//       human CAN rename a reserved project's name (only repoPath rebind/archive/delete are refused), so
//       the OLD name-only gate would mint a duplicate home after a rename. Proves the marker survives a
//       rename for both homes, backfills correctly for a pre-marker existing install, and self-heals from
//       a stale/mis-stamped/colliding marker (never skips creation or attaches to the wrong project).
//   (12) card a47dd144 ROUND 2, fix #1: the id-collision check alone misses a marker mis-stamped to the
//       OTHER home's row when that OTHER home's OWN marker was never stamped (nothing to collide
//       against by id) — resolveReservedHomeByMarker now ALSO rejects a marked row named for the other
//       home. RED on a22d42ce: a mis-stamped setup marker pointing at "Loom Platform" (no platform
//       marker yet) used to be trusted as the setup home, silently attaching the Workspace Auditor to
//       "Loom Platform" instead of minting the real setup home.
//   (13) card a47dd144 ROUND 2, fix #2: the name-match fallback now uses the ARCHIVE-AGNOSTIC
//       getReservedProjectByNameIncludingArchived, matching the pre-marker hasReservedProjectNamed gate
//       it replaces. RED on a22d42ce: a pre-marker install whose reserved home was archived was
//       invisible to the LIVE-only getReservedProjectByName fallback, so the seeder minted a second,
//       live home beside the archived one instead of treating it as already-seeded.
//   (6g)/(6h) card 247d0977: seedSetupProjectRename is now MARKER-scoped, not name-scoped — once
//       setup.homeProjectId is stamped it no-ops unconditionally, never inspecting either home's name.
//       RED on 06e9682d (before this card): (6g) a human swapping the platform/setup homes' names used
//       to get the PLATFORM home renamed to "Platform"; (6h) a human's deliberate rename of the setup
//       home back to the legacy literal used to get reverted on every following boot.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-home.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

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
const { SETUP_HOME_PROJECT_ID_KEY, PLATFORM_HOME_PROJECT_ID_KEY } = await import("../dist/projects/reserved-home-markers.js");
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

  // The getting-started checklist seeds onto the home board (the doctrine promises "a board for a setup
  // checklist" — the seed must actually fulfil it). Cards land on the home's resolved defaultLanding column.
  check("(1) seedSetupHome reports the seeded checklist in its summary", seededSetupA.some((s) => /^checklist:\d+$/.test(s)));
  const checklistA = dbA.listTasks(setupProject.id);
  check("(1) the checklist cards seeded onto the home board (≥5 cards)", checklistA.length >= 5);
  const { resolveConfig, columnKeyForRole } = await import("@loom/shared");
  const landingKey = columnKeyForRole(resolveConfig(setupProject.config).kanbanColumns, "defaultLanding");
  check("(1) every checklist card lands on the home's resolved defaultLanding column (no orphan key)",
    checklistA.every((c) => c.columnKey === landingKey));
  check("(1) the checklist covers the operating loop (a 'create' + a 'manager' card both present)",
    checklistA.some((c) => /create/i.test(c.title)) && checklistA.some((c) => /manager/i.test(c.title)));

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

  // ===================== (6g)/(6h) card 247d0977 — the migration is MARKER-scoped, not name-scoped ===
  // The pre-fix migration identified "the setup home" by NAME alone, with no reference to the stable
  // setup.homeProjectId marker every other resolver in this file already trusts. That produced two
  // human-triggered failure shapes RED on main (commit 06e9682d / before card 247d0977):

  // (6g) SHAPE (a): a human swaps the two homes' names — renames the PLATFORM home to the legacy literal
  // and renames the SETUP home away from "Platform" to something else. Pre-fix, the next boot's name
  // match found the PLATFORM home (now literally "Getting Started") and renamed IT to "Platform",
  // colliding with/blinding the platform resolver, even though neither marker ever moved. Fixed: once
  // the setup marker is stamped, the migration is marker-scoped and never inspects either home's name.
  const dbSwap = new Db(path.join(tmpHome, "home-rename-swap.db"));
  seedDefaultProfiles(dbSwap);
  seedPlatformHome(dbSwap); // LOOM_DEV=1 since phase (2) — stamps the platform marker
  seedSetupHome(dbSwap); // stamps the setup marker
  const platSwap = dbSwap.getReservedProjectByName(PLATFORM_PROJECT_NAME);
  const setupSwap = dbSwap.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(6g) pre-condition: both homes seeded + marked before the human swap", !!platSwap && !!setupSwap &&
    dbSwap.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === platSwap.id && dbSwap.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setupSwap.id);
  dbSwap.updateProject(platSwap.id, { name: LEGACY }); // human renames the PLATFORM home to the legacy literal
  dbSwap.updateProject(setupSwap.id, { name: "My Workspace" }); // human renames the SETUP home away from "Platform"
  const renameSwap = seedSetupProjectRename(dbSwap);
  check("(6g) migration no-ops once the setup marker is stamped — no name is ever inspected (returns null)",
    renameSwap === null);
  check("(6g) the PLATFORM home's rename to the legacy literal is left ALONE — NOT renamed to 'Platform'",
    dbSwap.getProject(platSwap.id)?.name === LEGACY);
  check("(6g) the SETUP home's rename away from 'Platform' is also left ALONE (nothing was touched)",
    dbSwap.getProject(setupSwap.id)?.name === "My Workspace");
  dbSwap.close();

  // (6h) SHAPE (b): a human DELIBERATELY renames the already-migrated setup home back to the legacy
  // literal (a legitimate reserved-project edit). Pre-fix, every following boot's name match found that
  // SAME row again and renamed it straight back to "Platform", permanently overriding the human's own
  // edit. Fixed: the marker being stamped means the migration is already done — the row's current name
  // is live state, never state to force back.
  const dbRevert = new Db(path.join(tmpHome, "home-rename-revert.db"));
  seedDefaultProfiles(dbRevert);
  seedSetupHome(dbRevert);
  const setupRevert = dbRevert.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(6h) pre-condition: the setup home is seeded + marked", dbRevert.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setupRevert.id);
  dbRevert.updateProject(setupRevert.id, { name: LEGACY }); // human deliberately renames it back to "Getting Started"
  const renameRevert1 = seedSetupProjectRename(dbRevert);
  check("(6h) migration no-ops on the deliberate rename (returns null, does not revert it)", renameRevert1 === null);
  check("(6h) the home STAYS named 'Getting Started' — the deliberate edit is not forced back",
    dbRevert.getProject(setupRevert.id)?.name === LEGACY);
  const renameRevert2 = seedSetupProjectRename(dbRevert); // a second boot — still never reverted
  check("(6h) a second boot still leaves the deliberate rename alone (idempotent no-op)",
    renameRevert2 === null && dbRevert.getProject(setupRevert.id)?.name === LEGACY);
  dbRevert.close();

  // ===================== (7) card a47dd144 — STABLE MARKER survives a human rename (setup) ============
  // THE BUG THIS CARD FIXES: a human CAN rename a reserved project's `name` via PATCH /api/projects/:id
  // (only repoPath rebind/archive/delete are refused for `p.reserved`). The OLD idempotency gate
  // (db.hasReservedProjectNamed(SETUP_PROJECT_NAME)) would then be FALSE on the next boot and mint a
  // SECOND, empty "Platform" home. RED on pre-fix code: seedSetupHome used to re-create here.
  const dbO = new Db(path.join(tmpHome, "marker-rename.db"));
  seedDefaultProfiles(dbO);
  seedSetupHome(dbO);
  const homeO = dbO.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(7) the stable marker is stamped to the home's id at creation", dbO.getMeta(SETUP_HOME_PROJECT_ID_KEY) === homeO.id);
  dbO.updateProject(homeO.id, { name: "My Renamed Platform" }); // simulates the human REST rename
  check("(7) the OLD name-scoped signal is now false after the rename (why the old gate would double-seed)",
    dbO.hasReservedProjectNamed(SETUP_PROJECT_NAME) === false);
  const reseedO = seedSetupHome(dbO);
  check("(7) re-seedSetupHome after a rename does NOT mint a duplicate (returns [])", reseedO.length === 0);
  check("(7) still exactly ONE reserved project after the rename + re-seed", dbO.listAllProjects().filter((p) => p.reserved).length === 1);
  check("(7) a same-file lookup (seedSetupAuditorAgent) also resolves the RENAMED home, not a phantom one",
    seedSetupAuditorAgent(dbO) === SETUP_AUDITOR_AGENT_NAME && dbO.listAgents(homeO.id).some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));
  check("(7) still exactly ONE reserved project after attaching the auditor", dbO.listAllProjects().filter((p) => p.reserved).length === 1);
  dbO.close();

  // ===================== (8) card a47dd144 — BACKFILL for a pre-marker existing install (setup) =======
  // Simulates upgrading from a version before this fix: the home exists (seeded the OLD way, so no
  // marker was ever stamped). seedSetupHome must still no-op (name match) AND backfill the marker, so a
  // LATER rename (post-upgrade) doesn't reopen the double-seed hole.
  const dbP = new Db(path.join(tmpHome, "marker-backfill.db"));
  seedDefaultProfiles(dbP);
  const preMarkerHomeId = "pre-marker-home";
  dbP.insertProject({ id: preMarkerHomeId, name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(8) a pre-marker install genuinely has no marker yet", dbP.getMeta(SETUP_HOME_PROJECT_ID_KEY) === undefined);
  const seedP1 = seedSetupHome(dbP);
  check("(8) seedSetupHome no-ops on the pre-marker home (name match) AND backfills the marker",
    seedP1.length === 0 && dbP.getMeta(SETUP_HOME_PROJECT_ID_KEY) === preMarkerHomeId);
  dbP.updateProject(preMarkerHomeId, { name: "Something Else Entirely" }); // the post-upgrade human rename
  const seedP2 = seedSetupHome(dbP);
  check("(8) a LATER rename after the backfill still does not cause a double-seed (marker survives it)",
    seedP2.length === 0 && dbP.listAllProjects().filter((p) => p.reserved).length === 1);
  dbP.close();

  // ===================== (9) card a47dd144 — STABLE MARKER survives a human rename (platform) =========
  // The exact mirror of (7) for the dev-only platform home. LOOM_DEV is already "1" from phase (2) on.
  const dbQ = new Db(path.join(tmpHome, "marker-rename-platform.db"));
  seedDefaultProfiles(dbQ);
  seedPlatformHome(dbQ);
  const platQ = dbQ.getReservedProjectByName(PLATFORM_PROJECT_NAME);
  check("(9) the platform marker is stamped to the home's id at creation", dbQ.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === platQ.id);
  dbQ.updateProject(platQ.id, { name: "Renamed Platform Home" });
  check("(9) the OLD name-scoped signal is now false after the rename", dbQ.hasReservedProjectNamed(PLATFORM_PROJECT_NAME) === false);
  const reseedQ = seedPlatformHome(dbQ);
  check("(9) re-seedPlatformHome after a rename does NOT mint a duplicate (RED on pre-fix code)", reseedQ.length === 0);
  check("(9) still exactly ONE reserved project after the rename + re-seed", dbQ.listAllProjects().filter((p) => p.reserved).length === 1);
  dbQ.close();

  // ===================== (10) card a47dd144 — BACKFILL for a pre-marker existing install (platform) ====
  const dbR = new Db(path.join(tmpHome, "marker-backfill-platform.db"));
  seedDefaultProfiles(dbR);
  const preMarkerPlatId = "pre-marker-platform";
  dbR.insertProject({ id: preMarkerPlatId, name: PLATFORM_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(10) a pre-marker platform install genuinely has no marker yet", dbR.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === undefined);
  const seedR1 = seedPlatformHome(dbR);
  check("(10) seedPlatformHome no-ops on the pre-marker home AND backfills the marker",
    seedR1.length === 0 && dbR.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === preMarkerPlatId);
  dbR.updateProject(preMarkerPlatId, { name: "Something Else" });
  const seedR2 = seedPlatformHome(dbR);
  check("(10) a LATER rename after the backfill still does not cause a double-seed (platform)",
    seedR2.length === 0 && dbR.listAllProjects().filter((p) => p.reserved).length === 1);
  dbR.close();

  // ===================== (11) card a47dd144 review condition — MARKER VALIDATION ========================
  // A stale/mis-stamped/colliding marker must never make a seeder skip creation or attach agents to the
  // wrong project. No OLD-code equivalent exists (the old gate never read any marker at all) — this is
  // new coverage for the new validation branch in resolveReservedHomeByMarker, not a RED-on-old-code case.
  const dbS = new Db(path.join(tmpHome, "marker-validate.db"));
  seedDefaultProfiles(dbS);
  seedSetupHome(dbS);
  seedPlatformHome(dbS);
  const setupS = dbS.getReservedProjectByName(SETUP_PROJECT_NAME);
  const platS = dbS.getReservedProjectByName(PLATFORM_PROJECT_NAME);

  // (11a) COLLISION: mis-stamp setup's marker with the PLATFORM home's id.
  dbS.setMeta(SETUP_HOME_PROJECT_ID_KEY, platS.id);
  check("(11a) setup still resolves ITS OWN home despite a marker collision with the platform home's id",
    seedSetupHome(dbS).length === 0 && dbS.listAllProjects().filter((p) => p.reserved).length === 2);
  check("(11a) the collision self-heals: setup's marker is re-stamped back to the setup home's own id",
    dbS.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setupS.id);
  check("(11a) a same-file lookup (seedSetupAuditorAgent) also resolves the CORRECT (setup) home despite the collision",
    seedSetupAuditorAgent(dbS) === SETUP_AUDITOR_AGENT_NAME && dbS.listAgents(setupS.id).some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));

  // (11b) NONEXISTENT: setup's marker points at a project id that doesn't exist at all.
  dbS.setMeta(SETUP_HOME_PROJECT_ID_KEY, "does-not-exist");
  check("(11b) a marker pointing at a nonexistent project id falls back to the name match (no double-seed)",
    seedSetupHome(dbS).length === 0 && dbS.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setupS.id);

  // (11c) NOT RESERVED: setup's marker points at an ORDINARY (non-reserved) project.
  dbS.insertProject({ id: "ordinary-collide", name: "RealWork3", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  dbS.setMeta(SETUP_HOME_PROJECT_ID_KEY, "ordinary-collide");
  check("(11c) a marker pointing at a NON-reserved project is rejected and falls back to the name match",
    seedSetupHome(dbS).length === 0 && dbS.getMeta(SETUP_HOME_PROJECT_ID_KEY) === setupS.id);
  dbS.close();

  // (11d-f) the EXACT mirror of (11a-c), the other direction (platform's marker validated against setup's).
  const dbT = new Db(path.join(tmpHome, "marker-validate-platform.db"));
  seedDefaultProfiles(dbT);
  seedSetupHome(dbT);
  seedPlatformHome(dbT);
  const setupT = dbT.getReservedProjectByName(SETUP_PROJECT_NAME);
  const platT = dbT.getReservedProjectByName(PLATFORM_PROJECT_NAME);

  dbT.setMeta(PLATFORM_HOME_PROJECT_ID_KEY, setupT.id);
  check("(11d) platform still resolves ITS OWN home despite a marker collision with the setup home's id",
    seedPlatformHome(dbT).length === 0 && dbT.listAllProjects().filter((p) => p.reserved).length === 2);
  check("(11d) the collision self-heals: platform's marker is re-stamped back to the platform home's own id",
    dbT.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === platT.id);

  dbT.setMeta(PLATFORM_HOME_PROJECT_ID_KEY, "does-not-exist");
  check("(11e) a marker pointing at a nonexistent project id falls back to the name match (platform)",
    seedPlatformHome(dbT).length === 0 && dbT.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === platT.id);

  dbT.insertProject({ id: "ordinary-collide-2", name: "RealWork4", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  dbT.setMeta(PLATFORM_HOME_PROJECT_ID_KEY, "ordinary-collide-2");
  check("(11f) a marker pointing at a NON-reserved project is rejected and falls back to the name match (platform)",
    seedPlatformHome(dbT).length === 0 && dbT.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === platT.id);
  dbT.close();

  // ===================== (12) card a47dd144 ROUND 2 fix #1 — NAME collision when the OTHER marker is
  // UNSET ====================================================================================
  // The id-collision check (`markedId !== otherId`) alone is blind here: when the OTHER home's marker was
  // NEVER stamped, otherId is undefined, and any real id string !== undefined — so a marker mis-stamped to
  // the OTHER home's row used to pass validation and be trusted. RED on a22d42ce.
  //
  // Card 5dff8d08 round 3 narrowed WHAT counts as rejection-worthy evidence here (see
  // reserved-home-markers.ts's own doc + decision record): a marker is now rejected on name-adjacent
  // grounds only when a DIFFERENT, genuinely real row matching THIS home's own name candidates exists —
  // never merely because the mis-stamped row happens to be named like the other side. That means these
  // (12a)/(12b) fixtures must seed the REAL home FIRST (so a genuine competing candidate actually exists),
  // then corrupt the marker onto an unrelated fake row — reproducing a corruption of an ALREADY-SET-UP
  // install, which is the realistic shape of this bug. Self-healing now lands back on the REAL existing
  // home (never mints a redundant 3rd project) rather than minting a brand-new empty one beside the fake.

  // (12a) the REAL "Platform" setup home already exists; setup's marker is then corrupted to point at an
  // unrelated, pre-marker (unmarked) "Loom Platform" row instead.
  const dbU = new Db(path.join(tmpHome, "marker-name-collision.db"));
  seedDefaultProfiles(dbU);
  seedSetupHome(dbU); // the REAL setup home, correctly marked
  const realSetupHomeU = dbU.getReservedProjectByName(SETUP_PROJECT_NAME);
  check("(12a setup) the real setup home is seeded + correctly marked", dbU.getMeta(SETUP_HOME_PROJECT_ID_KEY) === realSetupHomeU.id);
  const preMarkerPlatId2 = "pre-marker-platform-2";
  dbU.insertProject({ id: preMarkerPlatId2, name: PLATFORM_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(12a) the 'Loom Platform' home exists with NO platform marker stamped yet", dbU.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === undefined);
  dbU.setMeta(SETUP_HOME_PROJECT_ID_KEY, preMarkerPlatId2); // corrupt: setup's marker now points at the platform home
  const seededU = seedSetupHome(dbU);
  check("(12a) seedSetupHome does NOT trust the corrupted marker, but does NOT mint a 3rd project either — the REAL home already exists, so this is a no-op",
    seededU.length === 0);
  check("(12a) still exactly TWO reserved homes (the real setup home + the fake platform-named orphan) — no 3rd minted",
    dbU.listAllProjects().filter((p) => p.reserved).length === 2);
  const seededAudU = seedSetupAuditorAgent(dbU);
  check("(12a) seedSetupAuditorAgent attaches the auditor to the REAL setup home", seededAudU === SETUP_AUDITOR_AGENT_NAME);
  check("(12a) the 'Loom Platform' home gets NO Workspace Auditor (or any) agent attached — not mistaken for the setup home",
    dbU.listAgents(preMarkerPlatId2).length === 0);
  check("(12a) the Workspace Auditor landed on the real 'Platform' setup home",
    dbU.listAgents(realSetupHomeU.id).some((a) => a.name === SETUP_AUDITOR_AGENT_NAME));
  check("(12a) the setup marker self-heals BACK to the real setup home's id, not the corrupted platform id",
    dbU.getMeta(SETUP_HOME_PROJECT_ID_KEY) === realSetupHomeU.id);
  dbU.close();

  // (12b) the exact mirror: the REAL "Loom Platform" home already exists; platform's marker is then
  // corrupted to point at an unrelated, pre-marker (unmarked) "Platform" setup row instead.
  const dbV = new Db(path.join(tmpHome, "marker-name-collision-platform.db"));
  seedDefaultProfiles(dbV);
  seedPlatformHome(dbV); // the REAL platform home, correctly marked
  const realPlatHomeV = dbV.getReservedProjectByName(PLATFORM_PROJECT_NAME);
  check("(12b setup) the real platform home is seeded + correctly marked", dbV.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === realPlatHomeV.id);
  const preMarkerSetupId2 = "pre-marker-setup-2";
  dbV.insertProject({ id: preMarkerSetupId2, name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
  check("(12b) the 'Platform' setup home exists with NO setup marker stamped yet", dbV.getMeta(SETUP_HOME_PROJECT_ID_KEY) === undefined);
  dbV.setMeta(PLATFORM_HOME_PROJECT_ID_KEY, preMarkerSetupId2); // corrupt: platform's marker now points at the setup home
  const seededPlatV = seedPlatformHome(dbV);
  check("(12b) seedPlatformHome does NOT trust the corrupted marker, but does NOT mint a 3rd project either — the REAL home already exists, so this is a no-op",
    seededPlatV.length === 0);
  check("(12b) still exactly TWO reserved homes (the real platform home + the fake setup-named orphan) — no 3rd minted",
    dbV.listAllProjects().filter((p) => p.reserved).length === 2);
  check("(12b) the setup home gets NO Platform Lead/Auditor agents attached — not mistaken for the platform home",
    dbV.listAgents(preMarkerSetupId2).length === 0);
  check("(12b) the platform marker self-heals BACK to the real platform home's id, not the corrupted setup id",
    dbV.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === realPlatHomeV.id);
  dbV.close();

  // ===================== (13) card a47dd144 ROUND 2 fix #2 — an ARCHIVED home must still count as
  // already-seeded ==========================================================================
  // The name-match fallback used the LIVE-only getReservedProjectByName, regressing the archive-agnostic
  // never-clobber behavior the old hasReservedProjectNamed gate had. RED on a22d42ce.

  // (13a) setup: a pre-marker reserved home that is ARCHIVED.
  const dbW = new Db(path.join(tmpHome, "marker-archived-fallback.db"));
  seedDefaultProfiles(dbW);
  const archivedHomeId = "archived-setup-home";
  dbW.insertProject({ id: archivedHomeId, name: SETUP_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: now, reserved: true });
  check("(13a) the pre-marker reserved home exists but is ARCHIVED, and carries no marker yet",
    dbW.getProject(archivedHomeId)?.archivedAt === now && dbW.getMeta(SETUP_HOME_PROJECT_ID_KEY) === undefined);
  check("(13a) the archive-agnostic hasReservedProjectNamed still sees it (the gate the OLD pre-marker code used)",
    dbW.hasReservedProjectNamed(SETUP_PROJECT_NAME) === true);
  check("(13a) the LIVE-only getReservedProjectByName does NOT see it (why the fallback needed to change)",
    dbW.getReservedProjectByName(SETUP_PROJECT_NAME) === undefined);
  check("(13a) the new archive-agnostic getReservedProjectByNameIncludingArchived DOES see it",
    dbW.getReservedProjectByNameIncludingArchived?.(SETUP_PROJECT_NAME)?.id === archivedHomeId);
  const seededW = seedSetupHome(dbW);
  check("(13a) seedSetupHome treats the archived home as already-seeded and does NOT mint a second, live one (returns [])",
    seededW.length === 0);
  check("(13a) still exactly ONE reserved home (the archived one) — no duplicate minted (listAllProjects() excludes archived rows, so this uses listAllProjectsIncludingArchived instead)",
    dbW.listAllProjectsIncludingArchived().filter((p) => p.reserved).length === 1);
  check("(13a) the marker backfills to the archived home's id", dbW.getMeta(SETUP_HOME_PROJECT_ID_KEY) === archivedHomeId);
  dbW.close();

  // (13b) the exact mirror for the platform home.
  const dbX = new Db(path.join(tmpHome, "marker-archived-fallback-platform.db"));
  seedDefaultProfiles(dbX);
  const archivedPlatId = "archived-platform-home";
  dbX.insertProject({ id: archivedPlatId, name: PLATFORM_PROJECT_NAME, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: now, reserved: true });
  check("(13b) the pre-marker platform home exists but is ARCHIVED, and carries no marker yet",
    dbX.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === undefined);
  const seededPlatX = seedPlatformHome(dbX);
  check("(13b) seedPlatformHome treats the archived home as already-seeded and does NOT mint a second, live one (returns [])",
    seededPlatX.length === 0);
  check("(13b) still exactly ONE reserved home (platform, archived) — no duplicate minted (listAllProjectsIncludingArchived, same reason as 13a)",
    dbX.listAllProjectsIncludingArchived().filter((p) => p.reserved).length === 1);
  check("(13b) the marker backfills to the archived platform home's id", dbX.getMeta(PLATFORM_HOME_PROJECT_ID_KEY) === archivedPlatId);
  dbX.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the ungated 'Platform' setup home + 'Platform' operator agent seed for every user (no LOOM_DEV gate), idempotently across reboots, COEXIST with the dev-only 'Loom Platform' home (gate unchanged at 2 agents); the A2 guarded rename backfills a pre-rebrand 'Setup Assistant' operator → 'Platform' while leaving user-renamed + non-reserved-home agents untouched; the B4 seedSetupAuditorAgent backfill seeds a 2nd 'Workspace Auditor' agent into the SAME home (fresh + existing installs), idempotently, never clobbering a user edit; the 'Getting Started' → 'Platform' home rename migration backfills an existing install's reserved home IN PLACE (idempotent, collision-refusing, reserved-scoped, no-op on fresh/user-renamed/absent homes), with the boot order (rename THEN seed) never minting a duplicate home; (card a47dd144) both reserved homes now resolve by a STABLE app_meta id marker, not their `name` — surviving a human rename of either home without minting a duplicate, backfilling the marker for a pre-marker existing install, and self-healing from a stale/mis-stamped/colliding marker; and (card a47dd144 round 2) the collision check also rejects a marker mis-stamped to the OTHER home's row even when that other home's OWN marker was never stamped (name-collision, not just id-collision), and the name-match fallback is archive-agnostic, so an ARCHIVED legacy home still counts as already-seeded rather than growing a second, live duplicate beside it; and (card 247d0977) the rename migration is now MARKER-scoped, not name-scoped — once stamped it never inspects either home's current name, so a human swapping the two homes' names no longer renames the platform home, and a deliberate rename of the setup home back to the legacy literal is no longer reverted on every boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
