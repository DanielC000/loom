import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 (Code Review MINOR 5e) — `buildServedStatus` (served-status.ts) carries
// `projectsWorkRootBytes`/`projectsWorkRootOverCeiling`/`projectsWorkRootTruncated`, sourced from the
// background-refreshed cache in `sessions/project-work-dir-usage.ts` (Decision 5: `served_status`'s own
// read path NEVER walks the filesystem itself).
//
// HERMETIC, real Db + real on-disk project work dirs under a temp LOOM_HOME/LOOM_PROJECT_WORK_ROOT. Calls
// `refreshProjectsWorkRootUsage(db)` directly (awaited) rather than relying on `kickProjectsWorkRootUsageRefresh`'s
// fire-and-forget timing, mirroring scratch-gc-sweep-outcome.mjs's own "wait for the real mechanism, don't
// fake the cache" posture.
//
// Proves:
//   (1) before any refresh, the cache's initial value is surfaced honestly: bytes 0, truncated/overCeiling
//       false — never fabricated.
//   (2) after a real refresh, projectsWorkRootBytes sums REAL on-disk bytes across every KNOWN project's
//       own work dir — scoped (Decision 5): an UNKNOWN directory sitting under PROJECTS_WORK_ROOT (not
//       matching any project id db knows about) contributes NOTHING to the sum.
//   (3) an ARCHIVED project's work dir still counts (db.listArchivedProjects() is consulted too, not just
//       the active list) — mirrors the soft-archive design (the dir survives, Decision 5 includes it).
//   (4) for ordinary small payloads, projectsWorkRootOverCeiling and projectsWorkRootTruncated both read
//       false — proving they're genuine measured values (not hardcoded true), via the negative case.
//   (5) the TRUE case for each (Code Review MINOR 5), cheaply: `refreshProjectsWorkRootUsage`'s OPTIONAL
//       `bounds`/`warnBytes` overrides force truncated:true / overCeiling:true against the SAME real,
//       ordinary-sized data already on disk — no >50GiB payload or multi-second/200k-entry walk needed.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-dir-served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pwd-status-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 5eace211 (Code Review, CRITICAL): clear any AMBIENT LOOM_PROJECT_WORK_ROOT (a human may set this
// to point at the REAL shared project-work-dir root — Decision 2) BEFORE importing dist/paths.js, which
// reads it at module load. Falling through to the default derives PROJECTS_WORK_ROOT as a sibling of
// `tmpHome` above instead — this file's own ensure/refresh/cleanup calls below then mutate only that
// throwaway sibling, never a human's real one.
delete process.env.LOOM_PROJECT_WORK_ROOT;

const { requireHermeticEnv, assertUnderOsTmpdir } = await import("./_guard.mjs");
requireHermeticEnv(); // confirms LOOM_HOME (and, now, LOOM_PROJECT_WORK_ROOT if still ambient) are isolated

const { Db } = await import("../dist/db.js");
const { ensureProjectWorkDir, projectWorkDir, PROJECTS_WORK_ROOT } = await import("../dist/paths.js");
// Card 5eace211 (Code Review, CRITICAL): assert this is GENUINELY a temp-derived root before the finally
// block below ever recursively removes it — defense in depth on top of the delete+requireHermeticEnv
// above, in case a future edit to this file ever reorders past that pin.
assertUnderOsTmpdir("PROJECTS_WORK_ROOT", PROJECTS_WORK_ROOT);
const {
  refreshProjectsWorkRootUsage,
  getCachedProjectsWorkRootUsage,
  __resetProjectsWorkRootUsageCacheForTest,
} = await import("../dist/sessions/project-work-dir-usage.js");
const { buildServedStatus } = await import("../dist/served-status.js");

const db = new Db();
const now = new Date().toISOString();

try {
  // ===================== (1) before any refresh — honest initial value =====================
  __resetProjectsWorkRootUsageCacheForTest();
  const beforeStatus = buildServedStatus(db);
  check("(1) before any refresh: projectsWorkRootBytes is 0", beforeStatus.projectsWorkRootBytes === 0);
  check("(1) before any refresh: projectsWorkRootOverCeiling is false", beforeStatus.projectsWorkRootOverCeiling === false);
  check("(1) before any refresh: projectsWorkRootTruncated is false", beforeStatus.projectsWorkRootTruncated === false);
  // `buildServedStatus` ALSO fire-and-forgets a background `kickProjectsWorkRootUsageRefresh` on this
  // same call (never awaited) — with zero known project ids, that refresh has no I/O to await and its
  // whole body (including the `cached = {...}` assignment) runs SYNCHRONOUSLY to completion, only its
  // OWN `refreshInFlight` bookkeeping clears on a later microtask. Yield once here so that in-flight
  // promise is fully cleared before section (2) calls `refreshProjectsWorkRootUsage` explicitly — not
  // taking this tick leaves `refreshInFlight` still set to the (already-settled, but zero-project) kick
  // from THIS call, and the explicit refresh below would wrongly return THAT stale cached result instead
  // of actually re-walking with projA/projB now on disk.
  await new Promise((r) => setTimeout(r, 10));

  // ===================== (2) real bytes, scoped to KNOWN project ids only =====================
  db.insertProject({ id: "projA", name: "A", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "projB", name: "B", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  const dirA = ensureProjectWorkDir("projA", "A");
  const dirB = ensureProjectWorkDir("projB", "B");
  fs.writeFileSync(path.join(dirA, "a.bin"), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(dirB, "b.bin"), Buffer.alloc(5000, 2));
  // An UNKNOWN directory under the SAME root, whose name does not match any real project id — Decision 5
  // says the fleet-wide walk must scope to real known ids, never arbitrary directory entries.
  const unknownDir = path.join(PROJECTS_WORK_ROOT, "not-a-real-project-id");
  fs.mkdirSync(unknownDir, { recursive: true });
  fs.writeFileSync(path.join(unknownDir, "bystander.bin"), Buffer.alloc(999_999, 9));

  const refreshed = await refreshProjectsWorkRootUsage(db);
  check("(2) refresh sums A + B's real payloads", refreshed.bytes >= 8000);
  check("(2) refresh does NOT count the unknown bystander directory's ~1MB payload",
    refreshed.bytes < 100_000); // would be >=999_999 if the bystander leaked in
  check("(2) buildServedStatus surfaces the SAME refreshed figure (no separate walk on the read path)",
    buildServedStatus(db).projectsWorkRootBytes === refreshed.bytes);
  check("(2) the cache now carries a real computedAt timestamp", typeof getCachedProjectsWorkRootUsage().computedAt === "string");
  // The buildServedStatus call just above ALSO fire-and-forgot its OWN background kick (same mechanism
  // as section (1)'s own comment) — this one has REAL I/O to do (projA/projB's real bytes), so it does
  // NOT resolve synchronously; flush it to completion by awaiting the SAME dedup entry point before
  // section (3) mutates the project list again, or that dangling kick's `refreshInFlight` would make the
  // NEXT explicit refresh below wrongly return ITS (pre-projC) stale result instead of re-walking.
  await refreshProjectsWorkRootUsage(db);

  // ===================== (3) an ARCHIVED project's work dir still counts =====================
  db.insertProject({ id: "projC", name: "C", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: now }); // archived at creation
  check("(3) precondition — projC is genuinely NOT in the active list", !db.listAllProjects().some((p) => p.id === "projC"));
  check("(3) precondition — projC IS in the archived list", db.listArchivedProjects().some((p) => p.id === "projC"));
  const dirC = ensureProjectWorkDir("projC", "C");
  fs.writeFileSync(path.join(dirC, "c.bin"), Buffer.alloc(4000, 3));
  const refreshedWithArchived = await refreshProjectsWorkRootUsage(db);
  check("(3) the archived project's own bytes are INCLUDED in the fleet-wide sum",
    refreshedWithArchived.bytes >= refreshed.bytes + 4000);

  // ===================== (4) negative control — overCeiling/truncated stay false for ordinary small data =====================
  check("(4) projectsWorkRootOverCeiling is false for these small, ordinary-sized payloads (not hardcoded true)",
    buildServedStatus(db).projectsWorkRootOverCeiling === false);
  check("(4) projectsWorkRootTruncated is false — the walk completed well under its entry/time bound",
    buildServedStatus(db).projectsWorkRootTruncated === false);
  check("(4) projectWorkDir(id) resolves the SAME path refreshProjectsWorkRootUsage walked, for a sanity cross-check",
    dirA === projectWorkDir("projA") && dirB === projectWorkDir("projB"));

  // ===================== (5) overCeiling/truncated TRUE-case, CHEAPLY (card 5eace211 Code Review MINOR 5) =====================
  // The real >50GiB / 200k-entry-or-5s walk needed to trip these naturally is excluded by this project's
  // own "no synthetic load" rule (see (4) above and this file's own header) — `refreshProjectsWorkRootUsage`'s
  // OPTIONAL `bounds`/`warnBytes` overrides exist exactly to make the TRUE case cheap to prove instead:
  // a tiny `maxEntries` against the SAME real project dirs already on disk forces truncated:true, and a
  // near-zero `warnBytes` against their SAME real (non-zero) bytes forces overCeiling:true — no new data,
  // no multi-second wait.
  const truncatedForced = await refreshProjectsWorkRootUsage(db, { maxEntries: 1, maxMs: 5_000 });
  check("(5) a tiny maxEntries override forces truncated:true against the SAME real project dirs", truncatedForced.truncated === true);
  check("(5) that SAME override is surfaced through buildServedStatus's projectsWorkRootTruncated field",
    buildServedStatus(db).projectsWorkRootTruncated === true);

  const overCeilingForced = await refreshProjectsWorkRootUsage(db, undefined, 1);
  check("(5) a near-zero warnBytes override forces overCeiling:true against the SAME real (non-zero) bytes", overCeilingForced.overCeiling === true);
  check("(5) that SAME override is surfaced through buildServedStatus's projectsWorkRootOverCeiling field",
    buildServedStatus(db).projectsWorkRootOverCeiling === true);

  // Restore the cache to a realistic (default-bounds) figure before this file exits, so a reader who
  // extends it later doesn't inherit a deliberately-forced truncated/overCeiling cache.
  await refreshProjectsWorkRootUsage(db);
  check("(5) restoring with default bounds clears both forced flags again",
    buildServedStatus(db).projectsWorkRootTruncated === false && buildServedStatus(db).projectsWorkRootOverCeiling === false);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(PROJECTS_WORK_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status's projectsWorkRootBytes sums real on-disk bytes across every KNOWN project's work dir (active AND archived), scoped away from an unknown bystander directory under the same root, with projectsWorkRootOverCeiling/Truncated both reading false (genuine measured values, not hardcoded) for ordinary small payloads — and, via refreshProjectsWorkRootUsage's optional bounds/warnBytes overrides, both forced to true cheaply against that SAME real data, no pathological payload or multi-second walk needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
