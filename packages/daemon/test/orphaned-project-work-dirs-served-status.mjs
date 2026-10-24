import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3b65028c (Code Review follow-up on 8e32605d) — `buildServedStatus` (served-status.ts) carries
// `orphanedProjectWorkDirs`, sourced from the background-refreshed cache in
// `sessions/orphaned-project-work-dirs.ts` (@decision 3b65028c: VISIBILITY ONLY — never a fresh scan on
// `served_status`'s own read path, never a deletion/re-removal sweep).
//
// HERMETIC, real Db + real on-disk project/orphan dirs under a temp LOOM_HOME/LOOM_PROJECT_WORK_ROOT.
// Calls `refreshOrphanedProjectWorkDirs(db)` directly (awaited) rather than relying on
// `kickOrphanedProjectWorkDirsRefresh`'s fire-and-forget timing, mirroring
// project-work-dir-served-status.mjs's own "wait for the real mechanism, don't fake the cache" posture.
//
// Proves:
//   (1) before any refresh, the cache's initial value is surfaced honestly: count 0, entries [],
//       truncated false — never fabricated.
//   (2) a genuine orphan dir (UUID-shaped, no matching project row at all) IS surfaced: named in
//       `entries`, counted.
//   (3) an ACTIVE project's own work dir is NEVER counted as an orphan.
//   (4) an ARCHIVED project's own work dir is NEVER counted as an orphan either (db.listArchivedProjects()
//       is consulted, not just the active list).
//   (5) a BYSTANDER directory (round 2, Lead review of 8c67248a) — a non-UUID-shaped dir under
//       PROJECTS_WORK_ROOT (the shape `LOOM_PROJECT_WORK_ROOT` as a human-settable override can
//       legitimately hold) is NEVER counted as an orphan, regardless of knownIds.
//   (6) a DB READ FAILURE (round 2) never degrades to "report every real project dir as orphaned" — the
//       refresh is skipped, the previous cache is kept byte-for-byte, and a warn is logged.
//   (7) `buildServedStatus` genuinely propagates whatever the cache holds (no separate scan on the read
//       path), proven both by the real-refresh figure and directly via the `__set...ForTest` seam.
//   (8) RED/GREEN — a deliberately-broken "known ids" set (active projects only, never archived) is shown
//       to wrongly flag the archived project's dir as an orphan, proving this test's checks can actually
//       fail; restoring the real (correct) scan clears it again.
//   (9) `truncated:true` forced cheaply via the OPTIONAL `bounds` override, isolated from the shared cache
//       (an override call never poisons `getCachedOrphanedProjectWorkDirs()`/`buildServedStatus`), mirroring
//       `refreshProjectsWorkRootUsage`'s own override isolation (decision 2c9f0854).
//
// Run: 1) build (turbo builds shared first), 2) node test/orphaned-project-work-dirs-served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-opwd-status-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 5eace211's own CRITICAL precondition (mirrored here, same hazard): clear any AMBIENT
// LOOM_PROJECT_WORK_ROOT (a human may set this to the REAL shared root) BEFORE importing dist/paths.js,
// which reads it at module load — falling through to the default derives PROJECTS_WORK_ROOT as a sibling
// of `tmpHome` above instead.
delete process.env.LOOM_PROJECT_WORK_ROOT;

const { requireHermeticEnv, assertUnderOsTmpdir } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { ensureProjectWorkDir, PROJECTS_WORK_ROOT } = await import("../dist/paths.js");
assertUnderOsTmpdir("PROJECTS_WORK_ROOT", PROJECTS_WORK_ROOT);
const {
  refreshOrphanedProjectWorkDirs,
  getCachedOrphanedProjectWorkDirs,
  __resetOrphanedProjectWorkDirsCacheForTest,
  __setOrphanedProjectWorkDirsCacheForTest,
  findOrphanedProjectWorkDirs,
} = await import("../dist/sessions/orphaned-project-work-dirs.js");
const { buildServedStatus } = await import("../dist/served-status.js");

const db = new Db();
const now = new Date().toISOString();

// Genuinely UUID-shaped ids — the dir names created from them must clear the shape filter and actually
// exercise the knownIds exclusion logic (a non-UUID project id, like the old literal "projActive", would
// now be filtered out by SHAPE ALONE, making sections (3)/(4)/(8) pass vacuously rather than for the
// reason they claim to).
const PROJ_ACTIVE_ID = "11111111-1111-4111-8111-111111111111";
const PROJ_ARCHIVED_ID = "22222222-2222-4222-8222-222222222222";
const REAL_ORPHAN_ID = "33333333-3333-4333-8333-333333333333"; // UUID-shaped, matches no project row
const BYSTANDER_DIR_NAME = "not-a-real-project-id"; // non-UUID-shaped — mirrors project-work-dir-served-status.mjs's own bystander

try {
  // ===================== (1) before any refresh — honest initial value =====================
  __resetOrphanedProjectWorkDirsCacheForTest();
  const beforeStatus = buildServedStatus(db);
  check("(1) before any refresh: count is 0", beforeStatus.orphanedProjectWorkDirs.count === 0);
  check("(1) before any refresh: entries is []", beforeStatus.orphanedProjectWorkDirs.entries.length === 0);
  check("(1) before any refresh: truncated is false", beforeStatus.orphanedProjectWorkDirs.truncated === false);
  // buildServedStatus ALSO fire-and-forgets its own background kick on this same call — yield once so
  // that settles before the explicit refresh below, mirroring project-work-dir-served-status.mjs's own
  // documented reason for the identical yield.
  await new Promise((r) => setTimeout(r, 10));

  // ===================== (2)+(3) a genuine (UUID-shaped) orphan IS surfaced; ACTIVE's dir is NOT =====================
  db.insertProject({ id: PROJ_ACTIVE_ID, name: "Active", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  ensureProjectWorkDir(PROJ_ACTIVE_ID, "Active");
  const orphanDir = path.join(PROJECTS_WORK_ROOT, REAL_ORPHAN_ID);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, "stray.bin"), Buffer.alloc(10, 1));
  // (5) the bystander — created alongside, so every later refresh in this file is exposed to it too.
  const bystanderDir = path.join(PROJECTS_WORK_ROOT, BYSTANDER_DIR_NAME);
  fs.mkdirSync(bystanderDir, { recursive: true });
  fs.writeFileSync(path.join(bystanderDir, "unrelated.bin"), Buffer.alloc(999_999, 9));

  const refreshed = await refreshOrphanedProjectWorkDirs(db);
  check("(2) the genuine (UUID-shaped) orphan dir is counted", refreshed.count === 1);
  check("(2) the genuine orphan dir is named in entries", refreshed.entries.some((e) => e.dirName === REAL_ORPHAN_ID));
  check("(3) the ACTIVE project's own dir is never counted as an orphan", !refreshed.entries.some((e) => e.dirName === PROJ_ACTIVE_ID));
  check("(5) the non-UUID-shaped bystander dir is NEVER counted as an orphan", !refreshed.entries.some((e) => e.dirName === BYSTANDER_DIR_NAME));
  check("(5) the bystander does not inflate the count either (still exactly 1)", refreshed.count === 1);

  // ===================== (4) an ARCHIVED project's dir is NOT counted as an orphan =====================
  db.insertProject({ id: PROJ_ARCHIVED_ID, name: "Archived", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: now });
  check("(4) precondition — the archived project is genuinely NOT in the active list", !db.listAllProjects().some((p) => p.id === PROJ_ARCHIVED_ID));
  check("(4) precondition — the archived project IS in the archived list", db.listArchivedProjects().some((p) => p.id === PROJ_ARCHIVED_ID));
  ensureProjectWorkDir(PROJ_ARCHIVED_ID, "Archived");

  const refreshedWithArchived = await refreshOrphanedProjectWorkDirs(db);
  check("(4) the ARCHIVED project's own dir is never counted as an orphan", !refreshedWithArchived.entries.some((e) => e.dirName === PROJ_ARCHIVED_ID));
  check("(4) the genuine orphan is still the only one counted", refreshedWithArchived.count === 1);
  check("(5) the bystander is STILL excluded after the archived project's dir was added", !refreshedWithArchived.entries.some((e) => e.dirName === BYSTANDER_DIR_NAME));

  // ===================== (6) a DB read failure must NEVER report every real project dir as orphaned =====================
  const baselineBeforeFailure = await refreshOrphanedProjectWorkDirs(db);
  check("(6) precondition — a real baseline refresh currently holds exactly the one genuine orphan", baselineBeforeFailure.count === 1);

  const realListAllProjects = db.listAllProjects.bind(db);
  let warned = false;
  const realWarn = console.warn;
  console.warn = (...args) => { warned = true; return realWarn.apply(console, args); };
  db.listAllProjects = () => { throw new Error("simulated DB read failure"); };
  let failureResult;
  try {
    failureResult = await refreshOrphanedProjectWorkDirs(db);
  } finally {
    db.listAllProjects = realListAllProjects;
    console.warn = realWarn;
  }
  check("(6) on a DB read failure, the refresh returns the PREVIOUS cache unchanged (not every project flagged)",
    failureResult.count === baselineBeforeFailure.count
    && !failureResult.entries.some((e) => e.dirName === PROJ_ACTIVE_ID)
    && !failureResult.entries.some((e) => e.dirName === PROJ_ARCHIVED_ID));
  check("(6) the shared cache itself is also left byte-for-byte unchanged (never overwritten with a bad scan)",
    getCachedOrphanedProjectWorkDirs().computedAt === baselineBeforeFailure.computedAt
    && getCachedOrphanedProjectWorkDirs().count === baselineBeforeFailure.count);
  check("(6) a warn was logged for the failure (not silently swallowed)", warned === true);
  check("(6) buildServedStatus also still reports the untouched baseline after the failed refresh",
    buildServedStatus(db).orphanedProjectWorkDirs.count === baselineBeforeFailure.count);

  // ===================== (7) buildServedStatus propagates the real refreshed figure =====================
  check("(7) buildServedStatus surfaces the SAME refreshed count (no separate scan on the read path)",
    buildServedStatus(db).orphanedProjectWorkDirs.count === refreshedWithArchived.count);
  __setOrphanedProjectWorkDirsCacheForTest({ count: 7, entries: [{ dirName: "injected" }], truncated: true, computedAt: new Date().toISOString() });
  check("(7) buildServedStatus also surfaces a directly-injected cache value verbatim",
    buildServedStatus(db).orphanedProjectWorkDirs.count === 7
    && buildServedStatus(db).orphanedProjectWorkDirs.entries[0]?.dirName === "injected"
    && buildServedStatus(db).orphanedProjectWorkDirs.truncated === true);
  // Restore a real figure before the RED/GREEN section below reasons about real on-disk state.
  await refreshOrphanedProjectWorkDirs(db);

  // ===================== (8) RED/GREEN — prove this test's own archived-exclusion check can actually fail =====================
  // Card 3b65028c's own standing verification posture: a check that has never been shown capable of
  // failing is not evidence. `findOrphanedProjectWorkDirs` is the pure scan core — call it DIRECTLY with a
  // deliberately-wrong "known ids" set (active projects only, omitting archived) to reproduce exactly the
  // defect this module exists to avoid (an archived project's dir wrongly read as orphaned), then with the
  // real, correct set to show it clears.
  const activeOnlyIds = new Set(db.listAllProjects().map((p) => p.id)); // deliberately omits archived
  const brokenScan = findOrphanedProjectWorkDirs(PROJECTS_WORK_ROOT, activeOnlyIds);
  check("(8) RED — with archived ids wrongly omitted, the archived project's dir IS (incorrectly) flagged as an orphan",
    brokenScan.entries.some((e) => e.dirName === PROJ_ARCHIVED_ID));
  check("(8) RED — the bystander is STILL correctly excluded even in the broken scan (shape filter is independent of knownIds)",
    !brokenScan.entries.some((e) => e.dirName === BYSTANDER_DIR_NAME));

  const correctIds = new Set([...db.listAllProjects(), ...db.listArchivedProjects()].map((p) => p.id));
  const fixedScan = findOrphanedProjectWorkDirs(PROJECTS_WORK_ROOT, correctIds);
  check("(8) GREEN — with the real (active ∪ archived) known-id set, the archived project's dir is correctly excluded",
    !fixedScan.entries.some((e) => e.dirName === PROJ_ARCHIVED_ID));
  check("(8) GREEN — the genuine orphan is still (correctly) the only one counted",
    fixedScan.count === 1 && fixedScan.entries.some((e) => e.dirName === REAL_ORPHAN_ID));

  // ===================== (9) truncated:true forced cheaply via the override, isolated from the shared cache =====================
  const baselineCached = getCachedOrphanedProjectWorkDirs();
  check("(9) precondition — the cache currently holds a real (non-forced) baseline", baselineCached.truncated === false);

  const truncatedForced = await refreshOrphanedProjectWorkDirs(db, { maxEntries: 1, listMax: 20 });
  check("(9) a tiny maxEntries override's OWN direct return value forces truncated:true against the SAME real dirs",
    truncatedForced.truncated === true);
  check("(9) that override call did NOT poison the shared cache",
    getCachedOrphanedProjectWorkDirs().computedAt === baselineCached.computedAt && getCachedOrphanedProjectWorkDirs().truncated === false);
  check("(9) buildServedStatus therefore still reports the REAL (non-forced) truncated value, never the override's",
    buildServedStatus(db).orphanedProjectWorkDirs.truncated === false);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(PROJECTS_WORK_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status's orphanedProjectWorkDirs surfaces a genuine UUID-shaped orphan dir under PROJECTS_WORK_ROOT while never flagging an ACTIVE/ARCHIVED project's own dir or a non-UUID-shaped bystander dir, a DB read failure keeps the previous cache instead of flagging every real project dir, buildServedStatus propagates whatever the cache holds with no separate scan on its own read path, and the archived-exclusion check is proven capable of actually failing (RED) before being shown to pass for real (GREEN)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
