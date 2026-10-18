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
//       ordinary-sized data already on disk — no >50GiB payload or multi-second/200k-entry walk needed —
//       AND (card 2c9f0854, round 3, item 4b) that an override call's result is fully ISOLATED from the
//       shared cache: it never poisons what `getCachedProjectsWorkRootUsage()`/`buildServedStatus` report.
//   (6) `buildServedStatus` genuinely propagates whatever the cache holds, proven directly via the
//       `__setProjectsWorkRootUsageCacheForTest` seam — now that (5) no longer relies on an override
//       poisoning the cache to demonstrate this, it needs its own direct proof.
//   (7) item 4a — `kickProjectsWorkRootUsageRefresh`'s 5-minute floor (`MIN_REFRESH_INTERVAL_MS`) itself:
//       a kick is a synchronous no-op while the cache's `computedAt` is still fresh, and genuinely
//       re-walks once it's stale — proven deterministically (no sleep/wait needed for the negative half)
//       via a spy on `db.listAllProjects`, since the real walk's first statement is a synchronous call to
//       it, executed before any `await` suspends the async body.
//   (8) manager code-review follow-up (card 2c9f0854 round 2, item 3) — a concurrent dedupe/isolation
//       test: a default call and an override call issued back-to-back with no `await` between them (so
//       the override is structurally, not probabilistically, issued before the default settles) each
//       get their OWN result, and the shared cache ends up holding only the default's.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-work-dir-served-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

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
  kickProjectsWorkRootUsageRefresh,
  getCachedProjectsWorkRootUsage,
  __resetProjectsWorkRootUsageCacheForTest,
  __setProjectsWorkRootUsageCacheForTest,
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
  // Card 2c9f0854 (round 3, item 4a) — CORRECTED: the buildServedStatus call just above ALSO
  // fire-and-forgets its OWN background kick, but by this point `refreshProjectsWorkRootUsage(db)` on
  // the line just above has ALREADY set a fresh `cached.computedAt` — so `kickProjectsWorkRootUsageRefresh`'s
  // 5-minute floor (`MIN_REFRESH_INTERVAL_MS`, see section (7) below) blocks that kick as a synchronous
  // no-op; it never has "real I/O to do" at all, regardless of whether projA/projB's bytes would
  // otherwise warrant a re-walk. (The ORIGINAL version of this comment predated the floor and claimed
  // the opposite — that this kick genuinely re-walks and needs flushing; it did not, once the floor
  // existed.) This explicit, AWAITED call below is a deliberate, floor-BYPASSING direct refresh (per that
  // function's own doc: the floor applies only to the kick wrapper, never to a direct `await` of this
  // function) — needed so section (3) sees a baseline that reflects projA/projB, not to flush anything.
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
  //
  // Card 2c9f0854 (round 3, item 4b) — an override call's result is now ISOLATED from the shared cache
  // (docs/decisions/2c9f0854-work-root-hermetic-guard-hardening.md): it still computes correctly (proven
  // by its OWN direct return value below), but it must NEVER be visible through
  // `getCachedProjectsWorkRootUsage()`/`buildServedStatus` — this section proves BOTH halves, where the
  // OLD version of this test only proved the (buggy) opposite of the second half.
  const baselineCached = getCachedProjectsWorkRootUsage();
  check("(5) precondition — the cache currently holds a real (non-forced) baseline", baselineCached.truncated === false && baselineCached.overCeiling === false);

  const truncatedForced = await refreshProjectsWorkRootUsage(db, { maxEntries: 1, maxMs: 5_000 });
  check("(5) a tiny maxEntries override's OWN direct return value forces truncated:true against the SAME real project dirs", truncatedForced.truncated === true);
  check("(5) that override call did NOT poison the shared cache — getCachedProjectsWorkRootUsage() is byte-for-byte unchanged",
    getCachedProjectsWorkRootUsage().computedAt === baselineCached.computedAt && getCachedProjectsWorkRootUsage().truncated === false);
  check("(5) buildServedStatus therefore still reports the REAL (non-forced) truncated value, never the override's",
    buildServedStatus(db).projectsWorkRootTruncated === false);

  const overCeilingForced = await refreshProjectsWorkRootUsage(db, undefined, 1);
  check("(5) a near-zero warnBytes override's OWN direct return value forces overCeiling:true against the SAME real (non-zero) bytes", overCeilingForced.overCeiling === true);
  check("(5) that override call ALSO did NOT poison the shared cache",
    getCachedProjectsWorkRootUsage().computedAt === baselineCached.computedAt && getCachedProjectsWorkRootUsage().overCeiling === false);
  check("(5) buildServedStatus therefore still reports the REAL (non-forced) overCeiling value too",
    buildServedStatus(db).projectsWorkRootOverCeiling === false);

  // ===================== (6) buildServedStatus genuinely propagates whatever the cache holds =====================
  // Card 2c9f0854 — now that (5) can no longer demonstrate propagation by relying on an override
  // poisoning the cache (that write path no longer exists, by design), this proves the SAME claim
  // directly: inject a value via the test seam and confirm buildServedStatus reads it back field-for-
  // field. A deliberately FRESH injected `computedAt` (not a stale one) keeps `buildServedStatus`'s own
  // fire-and-forget `kickProjectsWorkRootUsageRefresh` call blocked by the 5-minute floor (section (7)
  // below), so a real background re-walk can never race in and silently overwrite the injected value
  // before this section's checks read it back.
  __setProjectsWorkRootUsageCacheForTest({ bytes: 123_456, truncated: true, overCeiling: false, computedAt: new Date().toISOString() });
  check("(6) buildServedStatus surfaces an injected truncated:true", buildServedStatus(db).projectsWorkRootTruncated === true);
  check("(6) buildServedStatus surfaces the injected bytes figure too", buildServedStatus(db).projectsWorkRootBytes === 123_456);
  __setProjectsWorkRootUsageCacheForTest({ bytes: 654_321, truncated: false, overCeiling: true, computedAt: new Date().toISOString() });
  check("(6) buildServedStatus surfaces an injected overCeiling:true", buildServedStatus(db).projectsWorkRootOverCeiling === true);

  // ===================== (7) item 4a — kickProjectsWorkRootUsageRefresh's 5-minute floor itself =====================
  // Card 2c9f0854 — MIN_REFRESH_INTERVAL_MS (card 5eace211 Code Review MINOR 3) was documented but never
  // actually tested. A spy on `db.listAllProjects` gives a DETERMINISTIC, synchronous signal with no
  // sleep/wait needed for the negative half: `refreshProjectsWorkRootUsage`'s real walk body's FIRST
  // statement is a synchronous call to `db.listAllProjects()`/`db.listArchivedProjects()`, executed as
  // part of the async IIFE's immediate (pre-first-`await`) execution — so if the floor genuinely blocks
  // the kick, that call site is NEVER reached, full stop, by the time `kickProjectsWorkRootUsageRefresh`
  // returns (it returns BEFORE ever calling `refreshProjectsWorkRootUsage` at all in that case).
  let listAllProjectsCalls = 0;
  const realListAllProjects = db.listAllProjects.bind(db);
  db.listAllProjects = (...args) => { listAllProjectsCalls++; return realListAllProjects(...args); };
  try {
    // (7a) FRESH computedAt — the floor must block the kick entirely; the real walk body never starts.
    __setProjectsWorkRootUsageCacheForTest({ bytes: 777_777, truncated: false, overCeiling: false, computedAt: new Date().toISOString() });
    listAllProjectsCalls = 0;
    kickProjectsWorkRootUsageRefresh(db);
    check("(7a) FLOOR BLOCKS the kick while computedAt is fresh — the real walk body never started (db.listAllProjects was never called)",
      listAllProjectsCalls === 0);
    check("(7a) ...and the cache is therefore still the untouched sentinel", getCachedProjectsWorkRootUsage().bytes === 777_777);

    // (7b) STALE computedAt (6 minutes old, past the 5-minute floor) — the floor must NOT block; the
    // real walk body starts, and the sentinel is genuinely replaced by a real re-walk.
    const staleComputedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    __setProjectsWorkRootUsageCacheForTest({ bytes: 111_111, truncated: false, overCeiling: false, computedAt: staleComputedAt });
    listAllProjectsCalls = 0;
    kickProjectsWorkRootUsageRefresh(db);
    check("(7b) FLOOR DOES NOT BLOCK the kick once computedAt is stale — the real walk body DID start (db.listAllProjects was called)",
      listAllProjectsCalls > 0);
    await waitUntil(() => getCachedProjectsWorkRootUsage().computedAt !== staleComputedAt,
      { label: "the stale-triggered real walk to replace the sentinel" });
    check("(7b) ...and the sentinel bytes were genuinely replaced by a real re-walk (not left stale)",
      getCachedProjectsWorkRootUsage().bytes !== 111_111);
  } finally {
    db.listAllProjects = realListAllProjects;
  }

  // Restore the cache to a realistic (default-bounds) figure before this file exits, so a reader who
  // extends it later doesn't inherit a deliberately-forced/injected cache.
  await refreshProjectsWorkRootUsage(db);
  check("(7) restoring with a real default-bounds refresh clears every forced/injected flag again",
    buildServedStatus(db).projectsWorkRootTruncated === false && buildServedStatus(db).projectsWorkRootOverCeiling === false);

  // ===================== (8) manager code-review follow-up item 3 — concurrent dedupe isolation =====================
  // Issue a DEFAULT call and an OVERRIDE call back-to-back with NO `await` between them, so the override
  // is issued STRUCTURALLY before the default could possibly have settled — not a guess about timing: a
  // promise cannot settle before the next synchronous line of this test runs, since nothing has yielded
  // to the microtask queue yet. Each caller must get its OWN, independently-computed result, and only
  // the default call's result may ever land in the shared cache (card 2c9f0854's own isolation fix).
  const defaultPromise = refreshProjectsWorkRootUsage(db);
  const overridePromise = refreshProjectsWorkRootUsage(db, { maxEntries: 1, maxMs: 5_000 });
  const [concurrentDefaultResult, concurrentOverrideResult] = await Promise.all([defaultPromise, overridePromise]);
  check("(8) the override call issued before the default settled still gets its OWN (forced-truncated) result",
    concurrentOverrideResult.truncated === true);
  check("(8) the default call's own concurrent result is NOT contaminated by the override (not forced-truncated)",
    concurrentDefaultResult.truncated === false);
  check("(8) the shared cache holds the DEFAULT call's result — matching its bytes/truncated, never the concurrent override's",
    getCachedProjectsWorkRootUsage().truncated === false && getCachedProjectsWorkRootUsage().bytes === concurrentDefaultResult.bytes);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(PROJECTS_WORK_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — served_status's projectsWorkRootBytes sums real on-disk bytes across every KNOWN project's work dir (active AND archived), scoped away from an unknown bystander directory under the same root, with projectsWorkRootOverCeiling/Truncated both reading false (genuine measured values, not hardcoded) for ordinary small payloads — and, via refreshProjectsWorkRootUsage's optional bounds/warnBytes overrides, both forced to true cheaply against that SAME real data, no pathological payload or multi-second walk needed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
