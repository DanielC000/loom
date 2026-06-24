import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform-prompt phase-NOTE strip + one-time migration (card 2b7bae7d). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE: a REAL Db over an isolated LOOM_HOME, no pty/daemon. Proves:
//   (a) neither SEEDED platform prompt (Lead / Auditor) contains a phase-gated time-bomb sentence
//       ("not yet spawned" / "land(s) in phase" / "operate within what exists today");
//   (b) migratePlatformPrompts REFRESHES an UNEDITED already-seeded row (byte-identical to the prior
//       phase-NOTE-bearing text) to the clean text, but LEAVES a user-edited row untouched — and is a
//       marker-guarded one-shot that returns WITHOUT stamping when there is no platform home yet.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-prompt-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME, set BEFORE importing dist so paths.js + the Db resolve to the throwaway env. ---
const tmpHome = path.join(os.tmpdir(), `loom-ppm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_DEV = "1"; // the Platform layer is dev-gated; this test exercises the seeded home

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const {
  seedPlatformHome,
  migratePlatformPrompts,
  PLATFORM_PROJECT_NAME,
  PLATFORM_PROMPT_MIGRATION_KEY,
  PLATFORM_PROMPT_REFRESH,
} = await import("../dist/platform/seed.js");

// Phase-gated time-bomb phrases that MUST NOT appear in any shipped (clean) seeded prompt.
const BANNED = ["not yet spawned", "land in phase", "lands in phase", "operate within what exists today"];
const hasBanned = (s) => BANNED.some((p) => s.toLowerCase().includes(p.toLowerCase()));

const db = new Db();

// ===================== guard 2: no platform home yet → no-op, and DOES NOT stamp =====================
// Run the migration on a brand-new DB with nothing seeded. It must return 0 AND leave the marker unset, so
// a later boot that actually seeds the home still migrates (the non-dev / pre-seed retry path).
const preHome = migratePlatformPrompts(db);
check("(b) migration on a DB with no platform home returns migrated:0", preHome.migrated === 0);
check("(b) ...and DID NOT stamp the one-shot marker (so a later seed-then-migrate still runs)",
  db.getMeta(PLATFORM_PROMPT_MIGRATION_KEY) === undefined);

// ===================== seed the platform home (fresh installs get the CLEAN prompts) =====================
seedDefaultProfiles(db); // platform agents bind to the bundled profiles by name
const seeded = seedPlatformHome(db);
check("seed reports the project + both platform agents",
  seeded.includes(`project:${PLATFORM_PROJECT_NAME}`) &&
  seeded.includes("agent:Platform Lead") && seeded.includes("agent:Platform Auditor"));

const home = db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
const byName = new Map(db.listAgents(home.id).map((a) => [a.name, a]));
const lead = byName.get("Platform Lead");
const auditor = byName.get("Platform Auditor");

// ===================== (a) the SEEDED prompts carry no phase-gated time-bomb =====================
check("(a) seeded Platform Lead prompt has no phase-gated time-bomb sentence", !hasBanned(lead.startupPrompt));
check("(a) seeded Platform Auditor prompt has no phase-gated time-bomb sentence", !hasBanned(auditor.startupPrompt));
// The seeded text IS the clean text in the refresh table; and the PRIOR text it migrates from DID carry one.
for (const [name, { prior, clean }] of Object.entries(PLATFORM_PROMPT_REFRESH)) {
  check(`(a) refresh '${name}'.clean has no banned phrase`, !hasBanned(clean));
  check(`(a) refresh '${name}'.prior DID carry a banned phrase (test-data sanity)`, hasBanned(prior));
  check(`(a) refresh '${name}'.prior !== .clean (a non-empty strip)`, prior !== clean && prior.length > clean.length);
}
check("(a) seeded Lead prompt is byte-identical to the clean constant", lead.startupPrompt === PLATFORM_PROMPT_REFRESH["Platform Lead"].clean);
check("(a) seeded Auditor prompt is byte-identical to the clean constant", auditor.startupPrompt === PLATFORM_PROMPT_REFRESH["Platform Auditor"].clean);

// ===================== (b) migration: refresh UNEDITED, leave a USER EDIT untouched =====================
// Simulate an OLD install: the Lead row carries the prior phase-NOTE-bearing text (unedited), while the
// user has hand-edited the Auditor row. The migration must refresh ONLY the Lead.
const leadPrior = PLATFORM_PROMPT_REFRESH["Platform Lead"].prior;
const leadClean = PLATFORM_PROMPT_REFRESH["Platform Lead"].clean;
const userEditedAuditor = `${PLATFORM_PROMPT_REFRESH["Platform Auditor"].clean}\n\nMy own appended house rule — do not touch.`;
db.updateAgent(lead.id, { startupPrompt: leadPrior });
db.updateAgent(auditor.id, { startupPrompt: userEditedAuditor });
check("(b) precondition: Lead row now carries the prior (phase-NOTE) text", db.getAgent(lead.id).startupPrompt === leadPrior);

const res1 = migratePlatformPrompts(db);
check("(b) migration refreshes exactly ONE row (the unedited Lead)", res1.migrated === 1);
check("(b) the UNEDITED Lead prompt is refreshed to the clean text", db.getAgent(lead.id).startupPrompt === leadClean);
check("(b) the refreshed Lead prompt no longer carries a banned phrase", !hasBanned(db.getAgent(lead.id).startupPrompt));
check("(b) the USER-EDITED Auditor prompt is left UNTOUCHED", db.getAgent(auditor.id).startupPrompt === userEditedAuditor);

// ===================== one-shot: the marker blocks a second run (no re-clobber) =====================
check("(b) the one-shot marker is stamped after a successful migration",
  typeof db.getMeta(PLATFORM_PROMPT_MIGRATION_KEY) === "string");
// Re-dirty the Lead, then re-run: the marker guard must SKIP it entirely (proves exactly-once, ever).
db.updateAgent(lead.id, { startupPrompt: leadPrior });
const res2 = migratePlatformPrompts(db);
check("(b) a second migration is a no-op (marker-guarded one-shot)", res2.migrated === 0);
check("(b) ...so the re-dirtied Lead row is left as-is (the migration did not re-run)",
  db.getAgent(lead.id).startupPrompt === leadPrior);

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — seeded platform prompts carry no phase-gated time-bomb, and the one-time migration refreshes an unedited already-seeded row to the clean text while leaving a user edit untouched (marker-guarded, no-stamp when home absent)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
