import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Lazy ship-state backfill for GET /api/tasks/:id (card 1eebc46a) — a card that merged BEFORE mergedSha
// started being persisted at merge-confirm time has no cached ship-state. The drawer's single-task read
// fills it in on first open (ONE bounded git lookup, never the board LIST route's per-poll-scale cost).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL temp git repo (execSync) + a real Db, driven through the
// REAL buildServer via app.inject (modeled on agent-runs-keys.mjs's `stub = {}` pattern — this route
// touches only `deps.db`).
//
// Proves:
//   (1) a done task whose branch has a landed squash commit (real trailer, simulating a pre-1eebc46a
//       merge) but no persisted mergedSha: the FIRST GET /api/tasks/:id resolves + returns ship-state,
//       AND persists it onto the row (a second read is then served straight from the column, no git call
//       — proven by moving the repo out from under it and confirming the second read still succeeds).
//   (2) a task with no landed commit at all: GET returns the row with mergedSha still null, no error.
//   (3) BEST-EFFORT (guardrail #2): a task whose project repoPath doesn't exist on disk (a moved/deleted
//       repo) still 200s with the row returned unchanged — never a 500 over a cache-fill failure.
//   (4) a task that ALREADY has a persisted mergedSha is returned as-is, no backfill attempted (proven by
//       the returned mergedSha being the pre-seeded value, not re-derived from git).
//   (6a) card 03f85c8e item 2: a commitTrailers:"off" project's scan is NO LONGER skipped — the gateway
//       route stopped special-casing `commitTrailers` because `resolveMergedInfo` already threads the
//       branch-keyed `"ledger"` tier (decision e8d4fdc3), so a ledger-backed, trailer-less landing whose
//       sha matches what's already recorded backfills its verification to "ledger".
//   (6a-mismatch) the SAME trailers-off/ledger shape as (6a), but the scan resolves a DIFFERENT sha than
//       the one already recorded — nothing is written, mirroring (6c)'s trailered-mismatch contract.
//   (6b) a TRAILERED legacy card (mergedSha set, mergedVerification null) DOES still backfill verification
//       when the scan's own sha matches the one already recorded — the case 634edd2b/d6d40edd built this
//       for in the first place; sha/repoKey stay untouched, only verification is filled in.
//   (6c) a TRAILERED card whose scan resolves a DIFFERENT sha than the one recorded (e.g. the same branch
//       landed twice) writes NOTHING — never overwrites an existing, different mergedSha.
//   (7) card 79090e65: a stored mergedSha in FULL (40-hex) form against the REAL resolveMergedInfo scan
//       of the SAME commit (which always returns SHORT, 7-char form) writes NOTHING — proves the
//       comparison's safe failure direction for a sha-form mismatch, a shape that never actually occurs
//       in production (see that scenario's own comment for the writer-chokepoint evidence).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-merged-lazy-backfill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-lazy-backfill-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45411";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const stub = {};
const now = new Date().toISOString();
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const repo = path.join(os.tmpdir(), `loom-lazy-backfill-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
execSync("git init -q && git -c user.email=x@loom -c user.name=x commit --allow-empty -q -m init", { cwd: repo });
const defaultBranch = git(repo, "rev-parse --abbrev-ref HEAD");

const db = new Db(path.join(tmpHome, "test.db"));
db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pGone", name: "Moved Repo Project", repoPath: path.join(os.tmpdir(), `loom-lazy-backfill-gone-${Date.now()}-${process.pid}`), vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// Card 5933734e (Code Review 295fdd33 round 2): a SEPARATE project with commitTrailers:"off" — shares the
// SAME repo as pRepo (the toggle governs behavior, not which bytes are on disk), so a commit trailered
// for a pTrailersOff task is just as findable BY GIT as any pRepo one; only the config differs.
db.insertProject({ id: "pTrailersOff", name: "Trailers-Off Project", repoPath: repo, vaultPath: repo, config: { orchestration: { commitTrailers: "off" } }, createdAt: now, archivedAt: null });

try {
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

  // ===== (1) landed commit, no persisted mergedSha yet: first GET resolves + persists it =====
  const t1 = { id: `lazy-merged-${Date.now()}`, projectId: "pRepo", title: "landed before 1eebc46a", body: "", columnKey: "done", position: 1, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t1);
  const branch1 = `loom/${taskKey(t1.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(x): landed" -m "Loom-Worker-Branch: ${branch1}"`);
  const landedSha1 = git(repo, "log -1 --format=%H").slice(0, 7);

  check("(1) setup: task starts with no persisted mergedSha", db.getTask(t1.id)?.mergedSha == null);
  const res1a = await app.inject({ method: "GET", url: `/api/tasks/${t1.id}` });
  check("(1) first GET returns 200", res1a.statusCode === 200);
  const body1a = res1a.json();
  check("(1) first GET's response carries the resolved mergedSha", body1a.mergedSha === landedSha1);
  check("(1) first GET's response carries mergedRepoKey null (primary)", body1a.mergedRepoKey === null);
  check("(1) first GET's response carries a parseable mergedDate", !isNaN(Date.parse(body1a.mergedDate ?? "")));
  check("(1) the write-through persisted it onto the row", db.getTask(t1.id)?.mergedSha === landedSha1);
  // Code Review MAJOR finding: a pure GET-triggered cache-fill must NOT bump updatedAt — the done lane
  // sorts byRecentlyDone, so bumping it here would jump this card to the top of its lane the moment
  // anyone opens its drawer, a pure read visibly reordering the board.
  check("(1) the lazy backfill does NOT bump updatedAt (would reorder the byRecentlyDone done lane)", db.getTask(t1.id)?.updatedAt === t1.updatedAt);
  check("(1) the GET response itself also reflects the UNCHANGED updatedAt", body1a.updatedAt === t1.updatedAt);

  // Second read must be served from the persisted column, not re-derived — proven by moving the repo
  // out from under the project (a fresh git lookup would now fail/return null) and confirming the
  // SECOND read still returns the correct sha.
  fs.renameSync(repo, `${repo}-moved-away`);
  const res1b = await app.inject({ method: "GET", url: `/api/tasks/${t1.id}` });
  check("(1) second GET (repo now gone) still returns 200 (served from the persisted column, no re-scan)", res1b.statusCode === 200);
  check("(1) second GET still carries the same mergedSha (cache-served, not re-derived)", res1b.json().mergedSha === landedSha1);
  fs.renameSync(`${repo}-moved-away`, repo); // restore for the remaining scenarios

  // ===== (2) no landed commit at all: GET returns the row with mergedSha still null, no error =====
  const t2 = { id: `lazy-unmerged-${Date.now()}`, projectId: "pRepo", title: "never merged", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t2);
  const res2 = await app.inject({ method: "GET", url: `/api/tasks/${t2.id}` });
  check("(2) an unmerged task's GET returns 200", res2.statusCode === 200);
  check("(2) an unmerged task's mergedSha stays null (no error, no false positive)", res2.json().mergedSha === null);

  // ===== (3) BEST-EFFORT: a project whose repoPath is gone must still 200, never 500 =====
  const t3 = { id: `lazy-norepo-${Date.now()}`, projectId: "pGone", title: "project repo moved/deleted", body: "", columnKey: "done", position: 1, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t3);
  const res3 = await app.inject({ method: "GET", url: `/api/tasks/${t3.id}` });
  check("(3) a task whose project repoPath doesn't exist still 200s (best-effort, never 500)", res3.statusCode === 200);
  check("(3) its mergedSha stays null (the failed cache-fill degrades silently)", res3.json().mergedSha === null);

  // ===== (4) a task that ALREADY has a persisted mergedSha is returned as-is (no backfill attempted) =====
  const t4 = { id: `lazy-already-${Date.now()}`, projectId: "pRepo", title: "already has ship-state", body: "", columnKey: "done", position: 3, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t4);
  db.updateTask(t4.id, { mergedSha: "deadbee", mergedRepoKey: null, mergedDate: "2026-01-01T00:00:00.000Z" });
  const res4 = await app.inject({ method: "GET", url: `/api/tasks/${t4.id}` });
  check("(4) a task with an existing mergedSha is returned UNCHANGED (pre-seeded value, not git-derived)", res4.json().mergedSha === "deadbee");

  // ===== (5) Code Review Minor 2: a STALE task.repoKey (names no entry in pRepo's EMPTY registry) that
  // degrades to primary must backfill mergedRepoKey to null (where the sha was ACTUALLY found), never the
  // stale key itself — stamping the stale key would render "<key> — no longer registered" in the UI for a
  // sha that's really on primary. =====
  const t5 = { id: `lazy-stale-repokey-${Date.now()}`, projectId: "pRepo", title: "stale repoKey, degrades to primary", body: "", columnKey: "done", position: 4, priority: "p2", repoKey: "no-such-registry-entry", createdAt: now, updatedAt: now };
  db.insertTask(t5);
  const branch5 = `loom/${taskKey(t5.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(y): landed on primary despite a stale repoKey" -m "Loom-Worker-Branch: ${branch5}"`);
  const landedSha5 = git(repo, "log -1 --format=%H").slice(0, 7);
  const res5 = await app.inject({ method: "GET", url: `/api/tasks/${t5.id}` });
  check("(5) a stale-repoKey task's sha is still found (degraded scan against primary)", res5.json().mergedSha === landedSha5);
  check("(5) mergedRepoKey backfills to null (primary — where it was ACTUALLY found), NOT the stale 'no-such-registry-entry' key", res5.json().mergedRepoKey === null);

  // ===== (6a) card 03f85c8e item 2: a commitTrailers:"off" repo's scan is NO LONGER skipped — a
  // ledger-backed landing (no reserved trailer at all) whose branch was NEVER created as a real git ref
  // (the gone-branch arm) must still resolve via `resolveMergedInfo`'s branch-keyed "ledger" tier
  // (decision e8d4fdc3) and backfill the recorded mergedSha's verification =====
  const t6a = { id: `lazy-trailersoff-ledger-${Date.now()}`, projectId: "pTrailersOff", title: "trailers-off, ledger-backed landing", body: "", columnKey: "done", position: 5, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t6a);
  const branch6a = `loom/${taskKey(t6a.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(z): trailers-off, ledger-backed landing"`); // no Loom-Worker-Branch trailer
  const landedSha6aFull = git(repo, "log -1 --format=%H");
  const landedSha6a = landedSha6aFull.slice(0, 7);
  const landedBase6a = git(repo, `log -1 --format=%H ${landedSha6aFull}^`);
  db.recordMainlineLandedCommit("pTrailersOff", "primary", defaultBranch, landedSha6aFull, landedBase6a, "f".repeat(40), branch6a);
  db.updateTask(t6a.id, { mergedSha: landedSha6a, mergedRepoKey: null, mergedVerification: null });
  const res6a = await app.inject({ method: "GET", url: `/api/tasks/${t6a.id}` });
  check("(6a) GET 200s", res6a.statusCode === 200);
  check("(6a) mergedSha is unchanged (still the recorded sha)", res6a.json().mergedSha === landedSha6a);
  check("(6a) THE FIX: mergedVerification backfills to \"ledger\" — the scan is no longer skipped for trailers-off", res6a.json().mergedVerification === "ledger");
  check("(6a) the PERSISTED column also reflects the backfilled \"ledger\" verification", db.getTask(t6a.id)?.mergedVerification === "ledger");

  // ===== (6a-mismatch) the SAME trailers-off/ledger shape as (6a), but the ledger-aware scan resolves a
  // DIFFERENT sha than the one already recorded — nothing is written, mirroring (6c)'s contract =====
  const t6aMismatch = { id: `lazy-trailersoff-mismatch-${Date.now()}`, projectId: "pTrailersOff", title: "trailers-off, ledger scan finds a different sha", body: "", columnKey: "done", position: 8, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t6aMismatch);
  const branch6aMismatch = `loom/${taskKey(t6aMismatch.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(z): another trailers-off, ledger-backed landing"`);
  const landedSha6aMismatchFull = git(repo, "log -1 --format=%H");
  const landedBase6aMismatch = git(repo, `log -1 --format=%H ${landedSha6aMismatchFull}^`);
  db.recordMainlineLandedCommit("pTrailersOff", "primary", defaultBranch, landedSha6aMismatchFull, landedBase6aMismatch, "f".repeat(40), branch6aMismatch);
  db.updateTask(t6aMismatch.id, { mergedSha: "cafef00", mergedRepoKey: null, mergedVerification: null });
  check("(6a-mismatch) setup: the ledger-resolved sha genuinely differs from the recorded one", landedSha6aMismatchFull.slice(0, 7) !== "cafef00");
  const res6aMismatch = await app.inject({ method: "GET", url: `/api/tasks/${t6aMismatch.id}` });
  check("(6a-mismatch) GET 200s", res6aMismatch.statusCode === 200);
  check("(6a-mismatch) the response's mergedSha is UNCHANGED (never overwritten by the ledger-resolved, differently-shaped commit)", res6aMismatch.json().mergedSha === "cafef00");
  check("(6a-mismatch) mergedVerification STAYS null (never backfilled from a mismatched ledger resolve)", res6aMismatch.json().mergedVerification == null);
  check("(6a-mismatch) the PERSISTED column is also unchanged — no write happened at all", db.getTask(t6aMismatch.id)?.mergedSha === "cafef00");

  // ===== (6b) a TRAILERED (commitTrailers "on", the default) legacy card with mergedSha already set but
  // mergedVerification null — this IS the case 634edd2b/d6d40edd built the backfill for: the scan's own
  // sha matches the one already recorded, so verification backfills while sha/repoKey stay untouched =====
  const t6b = { id: `lazy-trailered-legacy-${Date.now()}`, projectId: "pRepo", title: "trailered legacy card, null verification", body: "", columnKey: "done", position: 6, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t6b);
  const branch6b = `loom/${taskKey(t6b.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(z): trailered legacy landing" -m "Loom-Worker-Branch: ${branch6b}"`);
  const landedSha6b = git(repo, "log -1 --format=%H").slice(0, 7);
  db.updateTask(t6b.id, { mergedSha: landedSha6b, mergedRepoKey: null, mergedVerification: null });
  const res6b = await app.inject({ method: "GET", url: `/api/tasks/${t6b.id}` });
  check("(6b) GET 200s", res6b.statusCode === 200);
  check("(6b) mergedSha stays exactly the recorded (sha-matched) value", res6b.json().mergedSha === landedSha6b);
  check("(6b) mergedVerification IS backfilled (the scan's sha matched the recorded one)", res6b.json().mergedVerification != null);
  check("(6b) the PERSISTED column reflects the backfilled verification too", db.getTask(t6b.id)?.mergedVerification != null);

  // ===== (6c) a TRAILERED card whose scan resolves a DIFFERENT sha than the one already recorded (e.g. the
  // same branch name landed twice) — nothing is written, sha and verification both stay exactly as seeded =====
  const t6c = { id: `lazy-trailered-mismatch-${Date.now()}`, projectId: "pRepo", title: "trailered card, scan finds a different sha", body: "", columnKey: "done", position: 7, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t6c);
  const branch6c = `loom/${taskKey(t6c.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(z): stale earlier trailered landing" -m "Loom-Worker-Branch: ${branch6c}"`);
  const staleLandedSha6c = git(repo, "log -1 --format=%H").slice(0, 7);
  db.updateTask(t6c.id, { mergedSha: "cafef00", mergedRepoKey: null, mergedVerification: null });
  check("(6c) setup: the stale trailered commit's sha genuinely differs from the recorded one", staleLandedSha6c !== "cafef00");
  const res6c = await app.inject({ method: "GET", url: `/api/tasks/${t6c.id}` });
  check("(6c) GET 200s", res6c.statusCode === 200);
  check("(6c) the response's mergedSha is UNCHANGED (never overwritten by the stale, differently-shaped commit)", res6c.json().mergedSha === "cafef00");
  check("(6c) the response's mergedVerification STAYS null (never backfilled from an unrelated commit's own tier)", res6c.json().mergedVerification == null);
  check("(6c) the PERSISTED column is also unchanged — no write happened at all", db.getTask(t6c.id)?.mergedSha === "cafef00");

  // @decision 79090e65 — do not drop this scenario as redundant with (6b)/(6c): those seed their OWN
  // expected sha via the SAME `.slice(0, 7)` the route applies, so they can't catch a short-vs-full
  // mismatch the way a stored FULL-form sha against a real SHORT-form scan can.
  const t7 = { id: `lazy-full-vs-short-${Date.now()}`, projectId: "pRepo", title: "full-form stored sha vs real short-form scan", body: "", columnKey: "done", position: 9, priority: "p2", createdAt: now, updatedAt: now };
  db.insertTask(t7);
  const branch7 = `loom/${taskKey(t7.id)}`;
  git(repo, `-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(z): full-vs-short landing" -m "Loom-Worker-Branch: ${branch7}"`);
  const landedSha7Full = git(repo, "log -1 --format=%H");
  const landedSha7Short = landedSha7Full.slice(0, 7);
  check("(7) setup: the full sha genuinely differs, as a STRING, from its own short prefix", landedSha7Full !== landedSha7Short);
  db.updateTask(t7.id, { mergedSha: landedSha7Full, mergedRepoKey: null, mergedVerification: null });
  const res7 = await app.inject({ method: "GET", url: `/api/tasks/${t7.id}` });
  check("(7) GET 200s", res7.statusCode === 200);
  check("(7) mergedSha is UNCHANGED (full form), never silently rewritten to the short form", res7.json().mergedSha === landedSha7Full);
  check("(7) mergedVerification STAYS null — the real scan resolves the SAME commit, but in short form, so the strict-equality guard treats it as a mismatch and writes NOTHING (the safe direction: never a wrong write, but also no backfill for this unreachable shape)", res7.json().mergedVerification == null);
  check("(7) the PERSISTED column is also unchanged — no write happened at all", db.getTask(t7.id)?.mergedSha === landedSha7Full);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
  for (const d of [repo, `${repo}-moved-away`]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/tasks/:id lazily backfills a pre-existing merged card's ship-state on first open (resolves + persists, so a second read is served from the column with no re-scan), leaves a genuinely unmerged task's mergedSha null with no error, degrades to a plain 200 (never a 500) when the underlying git lookup fails (a moved/deleted project repo), never re-derives ship-state for a task that already has it persisted, backfills a commitTrailers:\"off\" card's null verification to \"ledger\" when the ledger-aware scan's sha matches the one recorded (never when it doesn't), backfills a trailered legacy card's null verification when the scan's sha matches the recorded one, and writes nothing when a trailered card's scan resolves a different sha than the one already recorded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
