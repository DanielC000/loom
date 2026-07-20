import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform-layer DEV FLAG gate (LOOM_DEV, default OFF). HERMETIC + CLAUDE-FREE + NETWORK-FREE: an
// isolated LOOM_HOME + sandboxed HOME, REAL Db handles (separate files per phase), and the REAL seeders.
// isLoomDev() reads process.env.LOOM_DEV at CALL time, so one process exercises BOTH modes by toggling
// the env between phases. Proves the owner decision (2026-06-15): the Platform layer ships disabled to
// regular `loomctl` users while staying loadable in dev.
//   (1) DEFAULT boot (LOOM_DEV unset): seedDefaultProfiles seeds the CORE profiles but NOT the two
//       platform profiles; seedPlatformHome no-ops (no reserved project, no platform agents).
//   (2) DEV boot (LOOM_DEV=1): the platform profiles ALSO seed, seedPlatformHome seeds the reserved
//       project + Lead/Auditor agents, and a re-seed is idempotent (no duplicates).
//   (3) RELEASE skill curation: curateSkillDirs (the pure helper the npm builder uses) excludes the
//       dev-only platform skills AND the install-specific `research` skill from the staged assets/skills
//       but keeps the core ones — checked against the REAL bundled asset listing.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-dev-flag.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const PLATFORM_PROFILES = ["Platform-lead", "Platform-audit"];

try {
  // ===================== (1) DEFAULT boot — LOOM_DEV unset =====================
  check("(1) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
  const dbA = new Db(path.join(tmpHome, "default.db"));
  const seededProfA = seedDefaultProfiles(dbA);
  const seededPlatA = seedPlatformHome(dbA);
  const profNamesA = new Set(dbA.listProfiles().map((p) => p.name));
  check("(1) CORE profiles ARE seeded by default", CORE_PROFILES.every((n) => profNamesA.has(n)));
  check("(1) the seed result lists every core profile", CORE_PROFILES.every((n) => seededProfA.includes(n)));
  check("(1) the two PLATFORM profiles are NOT seeded", PLATFORM_PROFILES.every((n) => !profNamesA.has(n)));
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
  check("(2) the two PLATFORM profiles ALSO seed in dev mode", PLATFORM_PROFILES.every((n) => profNamesB.has(n)));
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
    ["orchestrate", "worker", "loom-pickup", "doc-hygiene", "web-design"].every((n) => kept.includes(n)));
  // The install-specific `research` skill (bespoke to the owner's geopolitics/history vault) must NOT
  // ship to regular `loomctl` users — it lives in DEV_ONLY_SKILLS and is dropped from the staged set.
  check("(3) research skill exists in the bundled assets", allSkillDirs.includes("research"));
  check("(3) research is omitted from the ship set", DEV_ONLY_SKILLS.includes("research"));
  check("(3) staged release EXCLUDES the install-specific research skill", !kept.includes("research"));
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
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform layer is gated behind LOOM_DEV: default boot seeds NO platform project/agents/profiles (core profiles present), LOOM_DEV=1 seeds the full layer idempotently, and the staged release assets/skills exclude the dev-only platform skills and the install-specific research skill while keeping the core ones."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
