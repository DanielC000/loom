import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform-layer DEV FLAG gate (LOOM_DEV, default OFF). HERMETIC + CLAUDE-FREE + NETWORK-FREE: an
// isolated LOOM_HOME + sandboxed HOME, REAL Db handles (separate files per phase), and the REAL seeders.
// isLoomDev() reads process.env.LOOM_DEV at CALL time, so one process exercises BOTH modes by toggling
// the env between phases. Proves the owner decision (2026-06-15, NARROWED by card f437d4e9 C1,
// 2026-10-15): the dev-only "Loom Platform" reserved home + its Platform Auditor profile still ship
// disabled to regular `loomctl` users, but the Platform-lead profile itself now seeds for EVERY install
// — only its SESSION-minting path stays restricted (see platform-ungated-minting.mjs for that proof).
//   (1) DEFAULT boot (LOOM_DEV unset): seedDefaultProfiles seeds the CORE profiles AND the Platform-lead
//       profile (f437d4e9), but NOT Platform-audit; seedPlatformHome still no-ops (no reserved project,
//       no platform agents — unchanged, dev-only).
//   (2) DEV boot (LOOM_DEV=1): Platform-audit ALSO seeds (Platform-lead already did in phase 1, and
//       stays seeded here too), seedPlatformHome seeds the reserved project + Lead/Auditor agents, and a
//       re-seed is idempotent (no duplicates).
//   (3) RELEASE skill curation: curateSkillDirs (the pure helper the npm builder uses) excludes the
//       dev-only platform-audit skill AND the install-specific `research` skill from the staged
//       assets/skills but keeps the core ones AND platform-lead (shipped to all users since card
//       f437d4e9 C4 — its dev-only rules moved into a spawn-time prompt addendum instead, gated on
//       isLoomDev() — see sessions/platform-lead-prompt.ts) — checked against the REAL bundled asset
//       listing.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-dev-flag.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import
// time). LOOM_DEV is deliberately LEFT UNSET here — phase 1 needs the default; phase 2 sets it. ---
const tmpHome = path.join(os.tmpdir(), `loom-pdf-${Date.now()}-${process.pid}`);
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
const { isLoomDev } = await import("../dist/paths.js");
const { curateSkillDirs, DEV_ONLY_SKILLS } = await import("../../../scripts/curate-release-skills.mjs");

const CORE_PROFILES = ["Orchestrator", "Planning & Triage", "Dev", "Bugfix", "QA Tester", "Web Designer", "Content Strategy", "Setup Assistant"];
// f437d4e9 C1 narrowed the seed-gate to JUST the Auditor profile — "Platform-lead" now ships ungated
// (CORE, in effect) and only "Platform-audit" stays dev-only.
const DEV_ONLY_PLATFORM_PROFILES = ["Platform-audit"];

try {
  // ===================== (1) DEFAULT boot — LOOM_DEV unset =====================
  check("(1) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
  const dbA = new Db(path.join(tmpHome, "default.db"));
  const seededProfA = seedDefaultProfiles(dbA);
  const seededPlatA = seedPlatformHome(dbA);
  const profNamesA = new Set(dbA.listProfiles().map((p) => p.name));
  check("(1) CORE profiles ARE seeded by default", CORE_PROFILES.every((n) => profNamesA.has(n)));
  check("(1) the seed result lists every core profile", CORE_PROFILES.every((n) => seededProfA.includes(n)));
  check("(1) card f437d4e9: Platform-lead profile IS seeded by default (ungated)", profNamesA.has("Platform-lead"));
  check("(1) the seed result lists Platform-lead too", seededProfA.includes("Platform-lead"));
  check("(1) the seeded Platform-lead row has role 'platform'", dbA.listProfiles().find((p) => p.name === "Platform-lead")?.role === "platform");
  check("(1) Platform-audit is NOT seeded (stays LOOM_DEV-only)", DEV_ONLY_PLATFORM_PROFILES.every((n) => !profNamesA.has(n)));
  check("(1) seedPlatformHome no-ops by default (returns [])", seededPlatA.length === 0);
  check("(1) NO reserved 'Loom Platform' project exists", dbA.listAllProjects().filter((p) => p.reserved).length === 0);
  dbA.close();

  // ===================== (2) DEV boot — LOOM_DEV=1 =====================
  process.env.LOOM_DEV = "1";
  check("(2) isLoomDev() is TRUE when LOOM_DEV=1", isLoomDev() === true);
  const dbB = new Db(path.join(tmpHome, "dev.db"));
  seedDefaultProfiles(dbB);
  const seededPlatB = seedPlatformHome(dbB);
  const profNamesB = new Set(dbB.listProfiles().map((p) => p.name));
  check("(2) CORE profiles still seed in dev mode", CORE_PROFILES.every((n) => profNamesB.has(n)));
  check("(2) Platform-lead still seeds in dev mode", profNamesB.has("Platform-lead"));
  check("(2) Platform-audit ALSO seeds in dev mode", DEV_ONLY_PLATFORM_PROFILES.every((n) => profNamesB.has(n)));
  check("(2) seedPlatformHome seeds the reserved project + both agents",
    seededPlatB.includes(`project:${PLATFORM_PROJECT_NAME}`) &&
    seededPlatB.includes("agent:Platform Lead") && seededPlatB.includes("agent:Platform Auditor"));
  const reservedB = dbB.listAllProjects().filter((p) => p.reserved);
  check("(2) exactly ONE reserved platform project", reservedB.length === 1);
  check("(2) exactly TWO platform agents under it", dbB.listAgents(reservedB[0].id).length === 2);

  // Re-seed is idempotent (no duplicate profiles, project, or agents).
  const reProf = seedDefaultProfiles(dbB);
  const rePlat = seedPlatformHome(dbB);
  check("(2) re-seed profiles is a no-op (nothing new)", reProf.length === 0);
  check("(2) re-seed platform home is a no-op (nothing new)", rePlat.length === 0);
  check("(2) still exactly ONE reserved project after re-seed", dbB.listAllProjects().filter((p) => p.reserved).length === 1);
  check("(2) still exactly TWO platform agents after re-seed", dbB.listAgents(reservedB[0].id).length === 2);
  dbB.close();

  // ===================== (3) release skill curation =====================
  // The REAL bundled skill dirs are the source the npm builder copies (packages/daemon/assets/skills).
  const assetSkills = path.join(__dirname, "..", "assets", "skills");
  const allSkillDirs = fs.readdirSync(assetSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const kept = curateSkillDirs(allSkillDirs);
  check("(3) precondition: every omitted skill exists in the bundled assets",
    DEV_ONLY_SKILLS.every((n) => allSkillDirs.includes(n)));
  check("(3) staged release EXCLUDES every omitted skill (dev-only + install-specific)", DEV_ONLY_SKILLS.every((n) => !kept.includes(n)));
  check("(3) staged release KEEPS the core orchestration skills",
    ["orchestrate", "worker", "loom-pickup", "loom-doc-hygiene", "web-design"].every((n) => kept.includes(n)));
  // Card f437d4e9 C4: platform-lead is now a generic shipped skill (dropped from DEV_ONLY_SKILLS) while
  // platform-audit (the dev Platform Auditor) stays dev-only — this is the exact split this card ships.
  check("(3) platform-lead skill exists in the bundled assets", allSkillDirs.includes("platform-lead"));
  check("(3) platform-lead is NOT dev-only anymore (ships to all users)", !DEV_ONLY_SKILLS.includes("platform-lead"));
  check("(3) staged release KEEPS the platform-lead skill", kept.includes("platform-lead"));
  check("(3) platform-audit skill exists in the bundled assets", allSkillDirs.includes("platform-audit"));
  check("(3) platform-audit is STILL dev-only", DEV_ONLY_SKILLS.includes("platform-audit"));
  check("(3) staged release EXCLUDES the dev-only platform-audit skill", !kept.includes("platform-audit"));
  // The install-specific `research` skill (bespoke to the owner's geopolitics/history vault) must NOT
  // ship to regular `loomctl` users — it lives in DEV_ONLY_SKILLS and is dropped from the staged set.
  check("(3) research skill exists in the bundled assets", allSkillDirs.includes("research"));
  check("(3) research is omitted from the ship set", DEV_ONLY_SKILLS.includes("research"));
  check("(3) staged release EXCLUDES the install-specific research skill", !kept.includes("research"));
  // codescape is a private product end users cannot access (card 187873f9) — its skill/doctrine must
  // never reach a regular loomctl install even though its runtime is ALSO LOOM_DEV-gated independently
  // (paths.ts isCodescapeSupervisorEnabled). Kept canonical in the repo (dev/self-host still bundles it).
  check("(3) codescape skill exists in the bundled assets", allSkillDirs.includes("codescape"));
  check("(3) codescape is omitted from the ship set (private product)", DEV_ONLY_SKILLS.includes("codescape"));
  check("(3) staged release EXCLUDES the private-product codescape skill", !kept.includes("codescape"));
  // The user-facing Setup Assistant SHIPS to all users (ungated, core-seed): it is NOT a dev-only
  // platform skill, so it must survive curation. Guard against it ever being added to DEV_ONLY_SKILLS.
  check("(3) Setup Assistant skill exists in the bundled assets", allSkillDirs.includes("setup-assistant"));
  check("(3) Setup Assistant is NOT dev-only (ships to all users)", !DEV_ONLY_SKILLS.includes("setup-assistant"));
  check("(3) staged release KEEPS the Setup Assistant skill", kept.includes("setup-assistant"));
  // The Workspace Auditor skill is the de-Loom-ified, suggest-only cousin of the dev platform-audit and
  // SHIPS to all users (ungated, core-seed): it must survive curation. Guard against it ever being added
  // to DEV_ONLY_SKILLS.
  check("(3) workspace-audit skill exists in the bundled assets", allSkillDirs.includes("workspace-audit"));
  check("(3) workspace-audit is NOT dev-only (ships to all users)", !DEV_ONLY_SKILLS.includes("workspace-audit"));
  check("(3) staged release KEEPS the workspace-audit skill", kept.includes("workspace-audit"));
  check("(3) curation drops EXACTLY the omitted skills (kept = all − omitted)",
    kept.length === allSkillDirs.length - DEV_ONLY_SKILLS.length);
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the dev-only reserved 'Loom Platform' home + its Platform Auditor profile still gate behind LOOM_DEV, but the Platform-lead profile now seeds ungated (f437d4e9); LOOM_DEV=1 still seeds the full dev layer (home + both agents + both profiles) idempotently, and the staged release assets/skills exclude the dev-only platform-audit skill and the install-specific research skill while keeping the core ones AND platform-lead (shipped to all users since f437d4e9 C4, its dev-only rules moved into a spawn-time prompt addendum)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
