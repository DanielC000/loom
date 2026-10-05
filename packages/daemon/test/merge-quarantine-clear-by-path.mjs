import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c0be9bf9 — the no-project-resolution clear route (`POST /internal/merge-quarantine/clear-by-path`),
// the read-only list route (`GET /internal/merge-quarantine/list`), and the registration-based boot-summary
// partition (`partitionQuarantinesByRegistration`) that collapses a wall of per-latch boot warnings for
// repos that were never a registered Loom project (or no longer are) into one line.
//
// Auth/trust-tier mechanics for `/clear-by-path` (loopback + isGuardedInternalWrite bearer guard, same tier
// as the existing `/clear`) are covered by test/loopback-write-guard.mjs — this file is BEHAVIOR only, so
// the gateway-level checks below build `buildServer` WITHOUT a `loopbackSecret` (the guard's own documented
// no-op posture when omitted — see that file's own (A)) to keep every call here auth-free and focused on
// what each route actually DOES.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqcbp-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantine,
  quarantineLatchIdFor, quarantineLatchFileIdsFor, clearMergeQuarantineReporting, clearMergeQuarantineLatchFile,
  clearMergeQuarantineByRecordedPath, partitionQuarantinesByRegistration, reenterMergeQuarantinesAtBoot,
  assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleUrl);
const repoLockModuleUrl = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const { canonicalRepoLockKey } = await import(repoLockModuleUrl);
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function freshDir(tag) {
  const d = path.join(os.tmpdir(), `loom-mqcbp-${tag}-${sfx}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A repo nested inside another git repo (its own `.git`) — shared by section (L) (the `{id}` form's
// round-3 key-drift fix) and section (M) (the `{repoPath}` form's round-4 fix, card abccee85). Marker-only
// (`resolveGitToplevelSync` just checks `fs.existsSync(path.join(dir, ".git"))` — no real git needed).
function makeNestedGitFixture(tag) {
  const outer = freshDir(`${tag}-outer`);
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true }); // marks outer as its own git root
  const inner = path.join(outer, "inner");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true }); // marks inner as a NESTED git root
  return { outer, inner };
}

// ===================== (A) quarantineLatchIdFor — format =====================
const repoA = freshDir("repoA");
const idA = quarantineLatchIdFor(repoA);
check("(A) quarantineLatchIdFor returns a 24-hex-character id", /^[0-9a-f]{24}$/.test(idA));
// Negative control on the PATTERN itself: a known-bad shape must fail the same regex the function's own
// id passes — proves the assertion above actually discriminates, not a vacuous always-true check.
check("(A) negative control: an obviously-malformed id fails the SAME 24-hex pattern", !/^[0-9a-f]{24}$/.test("not-an-id"));

// ===================== (B) clearMergeQuarantineReporting — the shared helper =====================
const repoB = freshDir("repoB");
check("(B) sanity: repoB starts un-quarantined", !activeMergeQuarantineFor(repoB));
const noopClear = clearMergeQuarantineReporting(repoB);
check("(B) clearing a never-quarantined repo reports wasQuarantined:false (no-op, no throw)", noopClear.wasQuarantined === false);
enterMergeQuarantine(repoB, "some-branch", "test raise (B)");
check("(B) sanity: repoB is now quarantined", !!activeMergeQuarantineFor(repoB));
const realClear = clearMergeQuarantineReporting(repoB);
check("(B) clearing a genuinely quarantined repo reports wasQuarantined:true", realClear.wasQuarantined === true);
check("(B) and it's actually lifted afterward", !activeMergeQuarantineFor(repoB));

// ===================== (C) clearMergeQuarantineLatchFile — id validation (negative controls) =====================
// Each of these must be REJECTED before touching the filesystem at all (no partial-match tolerance).
const badIds = ["not-an-id", "ABCDEF0123456789ABCDEF0", "a".repeat(23), "a".repeat(25), "../../etc/passwd", "a/b", ""];
for (const bad of badIds) {
  const r = clearMergeQuarantineLatchFile(bad);
  check(`(C) invalid id '${JSON.stringify(bad)}' is rejected (ok:false) before any fs access`, r.ok === false);
}
// Path-traversal canary: a sibling file OUTSIDE MERGE_QUARANTINE_DIR must survive every rejected attempt
// above, including the literal "../../etc/passwd" shape — proves the regex gate, not luck, is what's
// stopping a real escape.
const canaryPath = path.join(path.dirname(MERGE_QUARANTINE_DIR), "canary-c0be9bf9.txt");
fs.writeFileSync(canaryPath, "untouched\n");
for (const bad of badIds) clearMergeQuarantineLatchFile(bad);
check("(C) path-traversal canary file survives every malformed-id attempt", fs.existsSync(canaryPath) && fs.readFileSync(canaryPath, "utf8") === "untouched\n");

// ===================== (D) clearMergeQuarantineLatchFile — a real, in-memory entry =====================
const repoD = freshDir("repoD");
enterMergeQuarantine(repoD, "some-branch", "test raise (D)");
const idD = quarantineLatchIdFor(repoD);
check("(D) sanity: the latch file exists on disk before clearing", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${idD}.json`)));
const clearD = clearMergeQuarantineLatchFile(idD);
check("(D) clearing by id reports ok:true", clearD.ok === true);
check("(D) clearing by id reports wasQuarantined:true (a real entry matched)", clearD.ok === true && clearD.wasQuarantined === true);
check("(D) the in-memory entry is gone", !activeMergeQuarantineFor(repoD));
check("(D) the latch file is deleted from disk", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${idD}.json`)));

// ===================== (E) clearMergeQuarantineLatchFile — a genuinely corrupt/unparsable latch =====================
// No real `enterMergeQuarantine` raise behind it (this process's own activeQuarantines never heard of it)
// — the shape a truly unparsable boot-time orphan latch has. Must still be removable BY ITS FILE ID alone.
const idE = "deadbeefdeadbeefdeadbeef"; // 24 hex chars, never derived from a real repoPath
fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${idE}.json`), "{ not valid json");
const clearE = clearMergeQuarantineLatchFile(idE);
check("(E) clearing a corrupt latch's raw file by id reports ok:true", clearE.ok === true);
check("(E) wasQuarantined:false (no in-memory entry could ever match a hand-written corrupt file)", clearE.ok === true && clearE.wasQuarantined === false);
check("(E) the corrupt file is deleted from disk regardless", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${idE}.json`)));

// ===================== (F) partitionQuarantinesByRegistration =====================
const repoRegistered = freshDir("repoRegistered");
const repoOrphan = freshDir("repoOrphan");
enterMergeQuarantine(repoRegistered, "b", "registered+quarantined (F)");
enterMergeQuarantine(repoOrphan, "b", "orphan (F)");
const { registered, orphaned } = partitionQuarantinesByRegistration(listActiveMergeQuarantines(), [repoRegistered]);
check("(F) a repo present in registeredRepoPaths lands in `registered`", registered.some((e) => e.repoPath === repoRegistered));
check("(F) that same repo is NEVER ALSO in `orphaned`", !orphaned.some((e) => e.repoPath === repoRegistered));
check("(F) a repo absent from registeredRepoPaths lands in `orphaned`", orphaned.some((e) => e.repoPath === repoOrphan));
check("(F) that orphan is NEVER ALSO in `registered`", !registered.some((e) => e.repoPath === repoOrphan));
// Negative control on the partition itself: an empty registeredRepoPaths list must put EVERYTHING in
// orphaned — proves the split is actually keyed on membership, not vacuously registering everything.
const { registered: regEmpty, orphaned: orphEmpty } = partitionQuarantinesByRegistration(listActiveMergeQuarantines(), []);
check("(F) negative control: with NO registered repos at all, nothing lands in `registered`", regEmpty.length === 0);
check("(F) negative control: with NO registered repos at all, everything lands in `orphaned`", orphEmpty.length === listActiveMergeQuarantines().length);
clearMergeQuarantine(repoRegistered);
clearMergeQuarantine(repoOrphan);

// ===================== (G) db.listAllRegisteredRepoPaths — live + multi-repo + archived =====================
{
  const db = new Db(path.join(loomHome, "g.db"));
  const now = new Date().toISOString();
  const liveRepo = freshDir("liveRepo");
  const liveSecondaryRepo = freshDir("liveSecondaryRepo");
  const archivedRepo = freshDir("archivedRepo");
  const unregisteredRepo = freshDir("unregisteredRepo");
  db.insertProject({
    id: "pLive", name: "Live", repoPath: liveRepo, vaultPath: liveRepo, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [{ key: "secondary", path: liveSecondaryRepo }],
  });
  db.insertProject({
    id: "pArchived", name: "Archived", repoPath: archivedRepo, vaultPath: archivedRepo, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  db.archiveProject("pArchived");
  const all = db.listAllRegisteredRepoPaths();
  check("(G) a live project's PRIMARY repoPath is included", all.includes(liveRepo));
  check("(G) a live project's SECONDARY (repos[]) path is included", all.includes(liveSecondaryRepo));
  check("(G) an ARCHIVED project's repoPath is STILL included (card c0be9bf9 ruling)", all.includes(archivedRepo));
  check("(G) negative control: a path never registered anywhere is absent", !all.includes(unregisteredRepo));
  db.close();
}

// ===================== (H) gateway routes — behavior (no loopbackSecret; see file header) =====================
{
  const TMP = mkdtempManaged("loom-mqcbp-gw-");
  const PORT = 45900 + (process.pid % 400);
  const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
  const db = new Db(path.join(TMP, "loom.db"));
  const now = new Date().toISOString();
  const projRepo = freshDir("projRepo");
  db.insertProject({
    id: "projH", name: "ProjH", repoPath: projRepo, vaultPath: projRepo, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    // --- (H1) the EXISTING /clear structurally cannot reach an orphan (no project resolves to it) ---
    const orphanRepo = freshDir("orphanRepoH");
    enterMergeQuarantine(orphanRepo, "b", "orphan (H1)");
    const oldClearMiss = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "no-such-project" } });
    check("(H1) CONTRAST: the OLD /clear route 404s for a project that doesn't exist", oldClearMiss.statusCode === 404);
    check("(H1) and the orphan is STILL quarantined after that miss", !!activeMergeQuarantineFor(orphanRepo));

    // --- (H2) the NEW /clear-by-path DOES reach it, by repoPath ---
    const newClearHit = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { repoPath: orphanRepo } });
    check("(H2) /clear-by-path with {repoPath} → 200", newClearHit.statusCode === 200);
    check("(H2) /clear-by-path reports wasQuarantined:true", newClearHit.json().wasQuarantined === true);
    check("(H2) the orphan is now actually cleared", !activeMergeQuarantineFor(orphanRepo));

    // --- (H3) /clear-by-path with {id} on a real raised quarantine ---
    const idRepo = freshDir("idRepoH");
    enterMergeQuarantine(idRepo, "b", "id-addressed (H3)");
    const latchId = quarantineLatchIdFor(idRepo);
    const clearById = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { id: latchId } });
    check("(H3) /clear-by-path with {id} → 200", clearById.statusCode === 200);
    check("(H3) and it's actually cleared", !activeMergeQuarantineFor(idRepo));

    // --- (H4) exactly-one-of validation ---
    const neither = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: {} });
    check("(H4) neither repoPath nor id → 400", neither.statusCode === 400);
    const both = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { repoPath: orphanRepo, id: latchId } });
    check("(H4) BOTH repoPath and id → 400 (ambiguous address refused, not guessed)", both.statusCode === 400);

    // --- (H5) a malformed id over HTTP → 400, never a 500 (the route-level twin of (C) above) ---
    const traversal = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: H, payload: { id: "../../../../etc/passwd" } });
    check("(H5) a path-traversal-shaped id → 400 (rejected, not a crash)", traversal.statusCode === 400);

    // --- (H6) GET /internal/merge-quarantine/list — contents + registered flag ---
    const registeredRepoH = projRepo; // already bound to project "projH" above
    enterMergeQuarantine(registeredRepoH, "b", "registered (H6)");
    const orphanRepoH2 = freshDir("orphanRepoH2");
    enterMergeQuarantine(orphanRepoH2, "b", "orphan (H6)");
    const listRes = await app.inject({ method: "GET", url: "/internal/merge-quarantine/list", headers: H });
    check("(H6) GET /list → 200", listRes.statusCode === 200);
    const items = listRes.json().items;
    const registeredItem = items.find((it) => it.repoPath === registeredRepoH);
    const orphanItem = items.find((it) => it.repoPath === orphanRepoH2);
    check("(H6) a repo bound to a real project is listed with registered:true", registeredItem?.registered === true);
    check("(H6) an orphan repo is listed with registered:false", orphanItem?.registered === false);
    check("(H6) each item's id matches quarantineLatchIdFor(repoPath)", registeredItem?.id === quarantineLatchIdFor(registeredRepoH) && orphanItem?.id === quarantineLatchIdFor(orphanRepoH2));
    clearMergeQuarantine(registeredRepoH);
    clearMergeQuarantine(orphanRepoH2);
  } finally {
    await app.close();
    db.close();
  }
}

// Mirrors merge-quarantine.ts's own private `quarantineHashForKey` — hashes a raw KEY directly (never a
// repoPath), the same primitive the real module uses to name a latch file.
function hashKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// ===================== (I) clearMergeQuarantineLatchFile — a DUAL-ARMED entry (round 2, card c0be9bf9) =====================
// Round 2 scope (Code Review c2aa28c3 of e5ba5376, blocking Major): clearing by id used to re-implement
// clearMergeQuarantine by hand and only ever unlink the ONE file named `<id>.json` — missing a
// dual-armed entry's SECOND latch file entirely (decision 54054c01: an entry armed under both its
// `resolvedKey` and a degraded current-key fallback has its REAL physical file at the resolvedKey hash,
// which can differ from the id a human reads off a recomputed-key listing). Reproduced the same way
// decision 54054c01's own fixture does: a latch manufactured BY HAND with an explicit `resolvedKey` that
// differs from the repo's own (degraded, since the repo path never exists) current key — this is exactly
// what `reenterMergeQuarantinesAtBoot`'s PASS 1 dual-arms under BOTH keys, with only ONE physical file
// (at the resolvedKey hash) ever written.
{
  const repoDual = path.join(os.tmpdir(), `loom-mqcbp-dual-nonexist-${sfx}`); // deliberately never created
  check("(I precondition) repoDual does not resolve on disk at all", !fs.existsSync(repoDual));

  // A synthetic "original" key this entry was supposedly raised under while the repo was once resolvable
  // — never actually produced by resolveGitToplevelSync, just needs to be a stable string distinct from
  // repoDual's own (degraded) current key, which is all `canonicalRepoLockKey` can ever fall back to for
  // a path that never exists.
  const resolvedKeyFake = `/synthetic/toplevel/for-dual-arm-${sfx}`;
  const realHash = hashKey(resolvedKeyFake);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const realLatchPathDual = path.join(MERGE_QUARANTINE_DIR, `${realHash}.json`);
  fs.writeFileSync(realLatchPathDual, JSON.stringify({
    repoPath: repoDual, branch: "dual-arm-branch", reason: "round 2 (c0be9bf9) — manufactured dual-armed latch",
    enteredAt: Date.now(), tokens: ["token-dual-i"], resolvedKey: resolvedKeyFake,
  }, null, 2) + "\n");
  check("(I precondition) the manufactured real latch file exists under the resolvedKey hash", fs.existsSync(realLatchPathDual));

  reenterMergeQuarantinesAtBoot([repoDual]);
  const dualEntry = activeMergeQuarantineFor(repoDual);
  check("(I precondition) boot re-entry arms repoDual in-memory", !!dualEntry);
  check("(I precondition) it is genuinely DUAL-armed (two distinct keys)", (dualEntry?.armedKeys?.length ?? 0) >= 2);
  check("(I precondition) one of those armed keys is the resolvedKey (hashes to the real file)", (dualEntry?.armedKeys ?? []).some((k) => hashKey(k) === realHash));

  // The id a human would actually be handed by a RECOMPUTED-key listing (quarantineLatchIdFor) — this is
  // the DEGRADED current-key hash, which has NO physical file of its own.
  const degradedId = quarantineLatchIdFor(repoDual);
  check("(I precondition) the recomputed/degraded id differs from the real file's own hash", degradedId !== realHash);
  check("(I precondition) no file exists under the degraded id", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${degradedId}.json`)));

  // Round 3 (card c0be9bf9, minor): quarantineLatchFileIdsFor must sort this dual-armed entry's own id
  // list so the id with a REAL on-disk file sorts first — PASS 1 always arms the degraded (no-file)
  // current key before the real resolvedKey one, so an unsorted list's ids[0] would be the wrong one
  // (what GET /internal/merge-quarantine/list hands out as its `id` field).
  const idsI = quarantineLatchFileIdsFor(dualEntry);
  check("(I) THE ROUND-3 ORDERING BUG: quarantineLatchFileIdsFor's ids[0] (what /list hands out as `id`) names the hash with a real on-disk file", idsI[0] === realHash);
  check("(I) negative control: the OTHER id in the list (the degraded one) genuinely has NO file on disk", idsI.length === 2 && !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${idsI[1]}.json`)));

  // --- (I-list) GET /internal/merge-quarantine/list projects THIS dual-armed entry's own `id`/`ids`
  // correctly, BEFORE it's cleared (round 4, card abccee85) — the existing (H6) coverage only exercises a
  // single-armed entry's id/ids, so a revert of the /list route back to `id: quarantineLatchIdFor(e.repoPath)`
  // would pass (H6) but silently hand out the wrong (no-file) id for a dual-armed entry like this one.
  {
    const TMPI = mkdtempManaged("loom-mqcbp-gw-i-");
    const PORTI = 46300 + (process.pid % 400);
    const HI = { host: `127.0.0.1:${PORTI}`, origin: `http://127.0.0.1:${PORTI}`, "content-type": "application/json" };
    const dbI = new Db(path.join(TMPI, "loom.db"));
    const stubI = {};
    const appI = await buildServer({
      db: dbI, pty: stubI, sessions: stubI, mcp: stubI, orchMcp: stubI, platformMcp: stubI, auditMcp: stubI,
      userAuditMcp: stubI, setupMcp: stubI, runMcp: stubI, control: stubI, usageStatus: stubI,
    });
    try {
      const listResI = await appI.inject({ method: "GET", url: "/internal/merge-quarantine/list", headers: HI });
      check("(I-list) GET /list → 200", listResI.statusCode === 200);
      const itemI = listResI.json().items.find((it) => it.repoPath === repoDual);
      check("(I-list) THE ROUND-3 ORDERING BUG, VIA THE ROUTE: item.id names the hash WITH a real on-disk file", itemI?.id === realHash);
      check("(I-list) item.ids includes the degraded (no-file) id too", (itemI?.ids ?? []).includes(degradedId));
    } finally {
      await appI.close();
      dbI.close();
    }
  }

  const clearDual = clearMergeQuarantineLatchFile(degradedId);
  check("(I) clearing by the degraded id reports ok:true, wasQuarantined:true", clearDual.ok === true && clearDual.wasQuarantined === true);
  check("(I) the in-memory entry is fully gone (both armed keys lifted)", !activeMergeQuarantineFor(repoDual));
  check("(I) THE ROUND-2 BUG: the REAL (resolvedKey-hashed) latch file is actually deleted, not left behind to re-arm on the next boot", !fs.existsSync(realLatchPathDual));
}

// ===================== (J) clearMergeQuarantineLatchFile — an orphanLatchFiles sweep (round 2, card c0be9bf9) =====================
// Round 2: clearing by id never ran clearMergeQuarantine's own orphanLatchFiles sweep (decision 24c0bdba
// round 7 M2) — an entry that exists only because a corrupt boot-time orphan latch fail-closed every
// registered repo must also delete that orphan file once nothing else references it, or the orphan
// re-quarantines everything again on the next boot even after every repo is "cleared" by id.
{
  const repoOrphanJ = freshDir("repoOrphanJ");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const orphanPathJ = path.join(MERGE_QUARANTINE_DIR, `orphan-j-${sfx}.json`);
  fs.writeFileSync(orphanPathJ, "{not valid json");
  check("(J precondition) the unmatched corrupt orphan latch exists", fs.existsSync(orphanPathJ));

  reenterMergeQuarantinesAtBoot([repoOrphanJ]);
  const orphanEntryJ = activeMergeQuarantineFor(repoOrphanJ);
  check("(J precondition) repoOrphanJ is quarantined fail-closed after boot", !!orphanEntryJ);
  check("(J precondition) the entry carries the orphan filename", (orphanEntryJ?.orphanLatchFiles ?? []).includes(path.basename(orphanPathJ)));
  const idJ = quarantineLatchIdFor(repoOrphanJ);
  const ownLatchPathJ = path.join(MERGE_QUARANTINE_DIR, `${idJ}.json`);
  check("(J precondition) repoOrphanJ's own latch file exists on disk", fs.existsSync(ownLatchPathJ));

  const clearJ = clearMergeQuarantineLatchFile(idJ);
  check("(J) clearing by id reports ok:true, wasQuarantined:true", clearJ.ok === true && clearJ.wasQuarantined === true);
  check("(J) repoOrphanJ's own latch file is deleted", !fs.existsSync(ownLatchPathJ));
  check("(J) THE ROUND-2 BUG: the orphan latch file is ALSO deleted (not left to re-quarantine every repo on the next boot)", !fs.existsSync(orphanPathJ));
  check("(J) repoOrphanJ is no longer quarantined", !activeMergeQuarantineFor(repoOrphanJ));
}

// ===================== (K) partitionQuarantinesByRegistration — spelling-variant discrimination (round 2) =====================
// Round 2 scope item 2: prove the partition is keyed on canonicalRepoLockKey, not a raw string match, by
// feeding it a registered path that is a DIFFERENT spelling of the exact same physical repo.
{
  const repoK = freshDir("repoK");
  // A trailing-separator spelling of the identical directory — same realpath, same canonical key, just a
  // different literal string than what's recorded on the quarantine entry below.
  const repoKTrailingSep = repoK + path.sep;
  enterMergeQuarantine(repoK, "b", "spelling-variant (K)");
  const { registered: registeredK } = partitionQuarantinesByRegistration(listActiveMergeQuarantines(), [repoKTrailingSep]);
  check("(K) a registered path spelled with a trailing separator still matches the quarantine entry's own (unadorned) repoPath", registeredK.some((e) => e.repoPath === repoK));
  // Negative control on the fixture itself: the two spellings really are textually different, so a match
  // here is the canonical-key comparison actually discriminating, not an accidental exact-string hit.
  check("(K) negative control: the two spellings are not literally identical strings", repoKTrailingSep !== repoK);
  clearMergeQuarantine(repoK);
}

// ===================== (L) clearMergeQuarantineLatchFile — key drift, not a repoPath re-derive (round 3, card c0be9bf9) =====================
// Round 3 scope (delta Code Review 4168d232 on f82358d8, BLOCKING): the {id} clear used to re-derive the
// repo's key by calling clearMergeQuarantineReporting(entry.repoPath), which recomputes
// canonicalRepoLockKey FRESH at clear time — under KEY DRIFT (a nested .git removed between match and
// act) that fresh recompute can land on a DIFFERENT repo's key, lifting the WRONG entry while reporting
// ok:true and leaving the entry actually addressed by `id` fully armed.
{
  // NOTE: after the drift below, inner and outer recompute to the SAME canonical key — querying
  // `activeMergeQuarantineFor(innerL)` post-drift is then indistinguishable from querying it for outerL
  // (both resolve the SAME key). So every assertion here is keyed on the entries' own PHYSICAL latch
  // files (computed BEFORE any drift) and `listActiveMergeQuarantines()`'s own repoPath field, never on a
  // post-drift `activeMergeQuarantineFor(innerL/outerL)` call, which would conflate the two.

  // --- (L) the drifted case: inner's own .git disappears between match and act ---
  const { outer: outerL, inner: innerL } = makeNestedGitFixture("nestL");
  const idOuterL = quarantineLatchIdFor(outerL); // outer's own key never changes — safe to compute any time
  const outerLatchPathL = path.join(MERGE_QUARANTINE_DIR, `${idOuterL}.json`);
  enterMergeQuarantine(innerL, "b", "nested-inner (L)");
  enterMergeQuarantine(outerL, "b", "nested-outer (L)");
  check("(L precondition) inner and outer currently resolve to DIFFERENT keys", canonicalRepoLockKey(innerL) !== canonicalRepoLockKey(outerL));
  check("(L precondition) outer's own latch file exists on disk", fs.existsSync(outerLatchPathL));

  const idInnerL = quarantineLatchIdFor(innerL); // computed BEFORE the drift below
  const innerLatchPathL = path.join(MERGE_QUARANTINE_DIR, `${idInnerL}.json`);
  check("(L precondition) inner's own latch file exists on disk", fs.existsSync(innerLatchPathL));

  fs.rmSync(path.join(innerL, ".git"), { recursive: true, force: true }); // the drift
  check("(L precondition) inner's own .git is gone", !fs.existsSync(path.join(innerL, ".git")));
  check("(L precondition) a FRESH recompute of inner's key now drifts to equal outer's key", canonicalRepoLockKey(innerL) === canonicalRepoLockKey(outerL));

  const clearL = clearMergeQuarantineLatchFile(idInnerL);
  check("(L) clearing by inner's id reports ok:true", clearL.ok === true);
  check("(L) THE ROUND-3 BUG: inner's own latch file (the one actually matched by this id) is deleted", !fs.existsSync(innerLatchPathL));
  check("(L) and outer's own latch file is STILL there, never collaterally deleted", fs.existsSync(outerLatchPathL));
  const remainingL = listActiveMergeQuarantines();
  check("(L) exactly one entry remains active, and it's the OUTER one", remainingL.length === 1 && remainingL[0]?.repoPath === outerL);
  clearMergeQuarantine(outerL);
  check("(L cleanup) outer's own latch file is now gone too", !fs.existsSync(outerLatchPathL));

  // --- (L fixture sanity, no drift) the identical fixture, with NO drift — this does NOT discriminate the
  // round-3 bug (round 1/2's own code ALSO passes it), so it's not a negative control; it just confirms
  // the inner-cleared/outer-armed outcome holds on the ordinary (non-drifted) shape too. ---
  const { outer: outerLNC, inner: innerLNC } = makeNestedGitFixture("nestLnc");
  const idOuterLNC = quarantineLatchIdFor(outerLNC);
  const outerLatchPathLNC = path.join(MERGE_QUARANTINE_DIR, `${idOuterLNC}.json`);
  enterMergeQuarantine(innerLNC, "b", "nested-inner-nc (L-NC)");
  enterMergeQuarantine(outerLNC, "b", "nested-outer-nc (L-NC)");
  const idInnerLNC = quarantineLatchIdFor(innerLNC);
  const innerLatchPathLNC = path.join(MERGE_QUARANTINE_DIR, `${idInnerLNC}.json`);
  const clearLNC = clearMergeQuarantineLatchFile(idInnerLNC);
  check("(L fixture sanity, no drift) clearing inner by id reports ok:true", clearLNC.ok === true);
  check("(L fixture sanity, no drift) inner's own latch file is deleted", !fs.existsSync(innerLatchPathLNC));
  check("(L fixture sanity, no drift) outer's own latch file is still there", fs.existsSync(outerLatchPathLNC));
  clearMergeQuarantine(outerLNC);
}

// ===================== (M) clearMergeQuarantineByRecordedPath — key drift, not a repoPath re-derive (round 4, card abccee85) =====================
// Round 4 scope (delta Code Review c574056b of c0be9bf9 round 3): the `{repoPath}` form of
// /clear-by-path still re-derived the repo's key by calling clearMergeQuarantineReporting(repoPath), which
// recomputes canonicalRepoLockKey FRESH at clear time — the SAME class of bug round 3 fixed for the `{id}`
// form (section (L) above). Under KEY DRIFT (a nested .git removed between match and act) that fresh
// recompute can land on a DIFFERENT repo's key, lifting the WRONG entry while reporting
// wasQuarantined:true and leaving the entry actually named by the given repoPath fully armed.
{
  // --- (M) the drifted case, at the module level ---
  const { outer: outerM, inner: innerM } = makeNestedGitFixture("nestM");
  const idOuterM = quarantineLatchIdFor(outerM);
  const outerLatchPathM = path.join(MERGE_QUARANTINE_DIR, `${idOuterM}.json`);
  enterMergeQuarantine(innerM, "b", "nested-inner (M)");
  enterMergeQuarantine(outerM, "b", "nested-outer (M)");
  check("(M precondition) inner and outer currently resolve to DIFFERENT keys", canonicalRepoLockKey(innerM) !== canonicalRepoLockKey(outerM));
  check("(M precondition) outer's own latch file exists on disk", fs.existsSync(outerLatchPathM));

  const idInnerM = quarantineLatchIdFor(innerM); // computed BEFORE the drift below
  const innerLatchPathM = path.join(MERGE_QUARANTINE_DIR, `${idInnerM}.json`);
  check("(M precondition) inner's own latch file exists on disk", fs.existsSync(innerLatchPathM));

  fs.rmSync(path.join(innerM, ".git"), { recursive: true, force: true }); // the drift
  check("(M precondition) a FRESH recompute of inner's key now drifts to equal outer's key", canonicalRepoLockKey(innerM) === canonicalRepoLockKey(outerM));

  const clearM = clearMergeQuarantineByRecordedPath(innerM);
  check("(M) clearing by inner's STORED repoPath reports wasQuarantined:true", clearM.wasQuarantined === true);
  check("(M) THE ROUND-4 BUG: inner's own latch file (the one actually matched by this repoPath) is deleted", !fs.existsSync(innerLatchPathM));
  check("(M) and outer's own latch file is STILL there, never collaterally deleted", fs.existsSync(outerLatchPathM));
  const remainingM = listActiveMergeQuarantines();
  check("(M) exactly one entry remains active, and it's the OUTER one", remainingM.length === 1 && remainingM[0]?.repoPath === outerM);
  clearMergeQuarantine(outerM);
  check("(M cleanup) outer's own latch file is now gone too", !fs.existsSync(outerLatchPathM));

  // --- (M fixture sanity, no drift) the identical fixture, with NO drift ---
  const { outer: outerMNC, inner: innerMNC } = makeNestedGitFixture("nestMnc");
  const idOuterMNC = quarantineLatchIdFor(outerMNC);
  const outerLatchPathMNC = path.join(MERGE_QUARANTINE_DIR, `${idOuterMNC}.json`);
  enterMergeQuarantine(innerMNC, "b", "nested-inner-nc (M-NC)");
  enterMergeQuarantine(outerMNC, "b", "nested-outer-nc (M-NC)");
  const idInnerMNC = quarantineLatchIdFor(innerMNC);
  const innerLatchPathMNC = path.join(MERGE_QUARANTINE_DIR, `${idInnerMNC}.json`);
  const clearMNC = clearMergeQuarantineByRecordedPath(innerMNC);
  check("(M fixture sanity, no drift) clearing inner by repoPath reports wasQuarantined:true", clearMNC.wasQuarantined === true);
  check("(M fixture sanity, no drift) inner's own latch file is deleted", !fs.existsSync(innerLatchPathMNC));
  check("(M fixture sanity, no drift) outer's own latch file is still there", fs.existsSync(outerLatchPathMNC));
  clearMergeQuarantine(outerMNC);
}

// ===================== (M-route) /clear-by-path {repoPath} is actually WIRED to clearMergeQuarantineByRecordedPath, via real HTTP (round 4, card abccee85) =====================
// (M) above proves the helper function itself; this proves the gateway route actually calls it (not just
// a module-level unit that nothing in production reaches).
{
  const { outer: outerMR, inner: innerMR } = makeNestedGitFixture("nestMR");
  const idOuterMR = quarantineLatchIdFor(outerMR);
  const outerLatchPathMR = path.join(MERGE_QUARANTINE_DIR, `${idOuterMR}.json`);
  enterMergeQuarantine(innerMR, "b", "nested-inner (M-route)");
  enterMergeQuarantine(outerMR, "b", "nested-outer (M-route)");
  const idInnerMR = quarantineLatchIdFor(innerMR);
  const innerLatchPathMR = path.join(MERGE_QUARANTINE_DIR, `${idInnerMR}.json`);
  fs.rmSync(path.join(innerMR, ".git"), { recursive: true, force: true }); // the drift

  const TMPM = mkdtempManaged("loom-mqcbp-gw-m-");
  const PORTM = 46700 + (process.pid % 400);
  const HM = { host: `127.0.0.1:${PORTM}`, origin: `http://127.0.0.1:${PORTM}`, "content-type": "application/json" };
  const dbM = new Db(path.join(TMPM, "loom.db"));
  const stubM = {};
  const appM = await buildServer({
    db: dbM, pty: stubM, sessions: stubM, mcp: stubM, orchMcp: stubM, platformMcp: stubM, auditMcp: stubM,
    userAuditMcp: stubM, setupMcp: stubM, runMcp: stubM, control: stubM, usageStatus: stubM,
  });
  try {
    const clearMR = await appM.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HM, payload: { repoPath: innerMR } });
    check("(M-route) POST /clear-by-path {repoPath: inner} (drifted) → 200", clearMR.statusCode === 200);
    check("(M-route) reports wasQuarantined:true", clearMR.json().wasQuarantined === true);
    check("(M-route) THE ROUND-4 BUG, VIA THE ROUTE: inner's own latch file is deleted", !fs.existsSync(innerLatchPathMR));
    check("(M-route) outer's own latch file is STILL there, never collaterally deleted via the route", fs.existsSync(outerLatchPathMR));
  } finally {
    await appM.close();
    dbM.close();
  }
  clearMergeQuarantine(outerMR);
}

// ===================== (N) legacyQuarantineHashFor — byte-identical after the directPathIdentity extraction (round 4, card abccee85) =====================
// legacyQuarantineHashFor isn't exported — exercised indirectly via reenterMergeQuarantinesAtBoot's own
// legacy-hash matching (the same technique merge-quarantine-key-migration.mjs already uses), against a
// hand-rolled replica of the OLD (pre-7673d096) key algorithm computed independently in THIS file. Two
// registered repos so a hash MISMATCH (the refactor broke something) is actually discriminated: it would
// fall through to the broad every-registered-repo fail-closed sweep and wrongly quarantine BOTH.
//
// Round 5 correction (Code Review of 2362064b, finding 2): repoN used to be a bare freshDir with NO
// enclosing `.git` anywhere up to the filesystem root — `canonicalRepoLockKey(repoN)` (the WALKING,
// current algorithm) then falls back to repoN's own direct realpath, the EXACT SAME value
// `legacyQuarantineHashFor` (which NEVER walks) produces. The two algorithms were coincidentally
// indistinguishable for this fixture, so this section could not actually discriminate an extraction bug —
// it would pass identically whether or not `legacyQuarantineHashFor` secretly started walking too. Fixed
// by nesting repoN (no `.git` of its own) inside an outer directory that DOES have one, so the fresh
// (walking) key resolves to the OUTER directory while the legacy (direct) hash still hashes repoN itself —
// genuinely different values, so a broken extraction now actually fails this section's own checks below.
{
  function oldHashForN(boundPath) {
    const real = fs.realpathSync.native(boundPath);
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    return createHash("sha256").update(key).digest("hex").slice(0, 24);
  }
  const repoNOuter = freshDir("repoN-outer");
  fs.mkdirSync(path.join(repoNOuter, ".git"), { recursive: true }); // marks the OUTER dir as its own git root
  const repoN = path.join(repoNOuter, "repoN-nested"); // no .git of its own — nested inside repoNOuter
  fs.mkdirSync(repoN, { recursive: true });
  const repoNOther = freshDir("repoNOther"); // registered too, but NOT referenced by the corrupt latch below
  const legacyHashN = oldHashForN(repoN);
  const freshHashN = createHash("sha256").update(canonicalRepoLockKey(repoN)).digest("hex").slice(0, 24);
  check("(N precondition) THE FIX ITSELF: the fresh (walking) hash and the legacy (direct) hash are now DIFFERENT values, so this section can actually discriminate an extraction bug", freshHashN !== legacyHashN);
  const legacyLatchPathN = path.join(MERGE_QUARANTINE_DIR, `${legacyHashN}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(legacyLatchPathN, "{not valid json"); // corrupt — forces the hash-match branch, never a clean parse
  check("(N precondition) a corrupt latch exists under the hand-rolled legacy hash", fs.existsSync(legacyLatchPathN));
  check("(N precondition) neither repo reads as quarantined yet", !activeMergeQuarantineFor(repoN) && !activeMergeQuarantineFor(repoNOther));

  reenterMergeQuarantinesAtBoot([repoN, repoNOther]);
  check("(N) THE BYTE-IDENTICAL PROOF: boot narrowed the corrupt legacy-hash latch to repoN ONLY — production's own legacyQuarantineHashFor(repoN) equals this file's own hand-rolled replica", !!activeMergeQuarantineFor(repoN));
  check("(N) negative control: the UNRELATED registered repo is NOT quarantined (a hash mismatch would have fallen through to the broad every-registered-repo fail-closed sweep and caught it too)", !activeMergeQuarantineFor(repoNOther));
  try { fs.unlinkSync(legacyLatchPathN); } catch { /* best-effort — the repo's own latch now lives under the fresh hash */ }
  clearMergeQuarantine(repoN);
}

// ===================== (P) TRACE ONLY — a pending entry's own orphanLatchFiles sweep gap (round 4, card abccee85) =====================
// Card abccee85 item 5: "confirm or refute with a repro before fixing" — a REPRO, not a fix (the manager
// files the follow-up card for the actual fix). A PASS-2-created fail-closed entry (an orphan latch
// matching NO registered repo) persists NO `resolvedKey` (only the in-memory-only `armedKeys`, stripped
// before writeMergeQuarantineLatch persists it) — so if that repo's OWN path later becomes unresolvable on
// a SUBSEQUENT boot, it reloads as a PENDING entry (the `!resolvableNow && !entry.resolvedKey` gate in
// reenterMergeQuarantinesAtBoot), still carrying its old orphanLatchFiles forward. Neither pending-removal
// branch (clearMergeQuarantineByKey's pending filter, or clearMergeQuarantineLatchFile's pending-match
// branch) ever looks at orphanLatchFiles — only the pending entry's own sourceFile is deleted.
//
// GOTCHA that cost real debugging time: calling `reenterMergeQuarantinesAtBoot` TWICE in THIS process does
// NOT correctly simulate "two separate real daemon boots" for this scenario — boot 1's own write already
// sits in THIS process's module-level `activeQuarantines` map, so a second in-process call never actually
// reaches the pending branch at all; it just re-matches the stale boot-1 ACTIVE entry still resident at the
// same key, and clears it via the (fully-swept) active path, which trivially "passes" for the wrong
// reason. BOOT 2 (and the clear that follows it) must run in a GENUINELY SEPARATE child process — a fresh
// module instance, a fresh empty `activeQuarantines` map — same technique as
// `merge-quarantine-unresolvable-path.mjs`'s own `rebootInChildProcess`.
{
  const repoP = freshDir("repoP");
  const orphanPathP = path.join(MERGE_QUARANTINE_DIR, `orphan-p-${sfx}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(orphanPathP, "{not valid json"); // unmatched corrupt orphan latch
  check("(P precondition) the unmatched corrupt orphan latch exists", fs.existsSync(orphanPathP));

  // BOOT 1 (in-process is fine here — nothing pre-exists for repoP's key yet): PASS 2 fail-closes repoP
  // (its only registered repo), referencing the orphan file.
  reenterMergeQuarantinesAtBoot([repoP]);
  const entryP1 = activeMergeQuarantineFor(repoP);
  check("(P precondition) repoP is quarantined fail-closed after boot 1", !!entryP1);
  check("(P precondition) the entry carries the orphan filename", (entryP1?.orphanLatchFiles ?? []).includes(path.basename(orphanPathP)));
  check("(P precondition) the entry has NO resolvedKey persisted (PASS 2's own fail-closed shape)", entryP1?.resolvedKey === undefined);
  const idP = quarantineLatchIdFor(repoP); // computed BEFORE repoP's own directory is removed below
  const ownLatchPathP = path.join(MERGE_QUARANTINE_DIR, `${idP}.json`);
  check("(P precondition) repoP's own latch file exists on disk", fs.existsSync(ownLatchPathP));

  // Between boot 1 and boot 2, repoP's own directory disappears entirely (only its MERGE_QUARANTINE_DIR
  // latch content and the orphan file remain — neither lives under repoP itself) AND repoP stops being a
  // registered project (simulating the project being deleted/unregistered alongside its own directory) —
  // this is what keeps PASS 2, in the child's own boot 2, from re-arming a fresh ACTIVE entry under the
  // same key and masking the pending-only code path this section exists to exercise.
  fs.rmSync(repoP, { recursive: true, force: true });
  check("(P precondition) repoP no longer resolves on disk at all", !fs.existsSync(repoP));

  // BOOT 2 + the clear, BOTH in one child process (so the clear sees the SAME pending entry boot 2 itself
  // produced, never this process's own stale state).
  const childScript = `
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, clearMergeQuarantineLatchFile } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]); // repoP is no longer registered — PASS 2 cannot re-arm an active entry for it
    const entry = activeMergeQuarantineFor(${JSON.stringify(repoP)});
    const clearResult = clearMergeQuarantineLatchFile(${JSON.stringify(idP)});
    process.stdout.write(JSON.stringify({
      entryOrphanLatchFiles: entry?.orphanLatchFiles ?? null,
      entryResolvedKey: entry?.resolvedKey ?? null,
      clearResult,
    }));
  `;
  const childOut = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultP = JSON.parse(childOut);

  check("(P precondition, child boot 2) repoP is reported via the PENDING lazy-resolve (no resolvedKey, no active re-arm)", resultP.entryResolvedKey === null);
  check("(P precondition, child boot 2) the PENDING entry still carries the orphan filename forward", (resultP.entryOrphanLatchFiles ?? []).includes(path.basename(orphanPathP)));
  check("(P) clearing the pending entry by id (in the child) reports ok:true", resultP.clearResult?.ok === true);
  check("(P) the pending entry's OWN latch/source file is gone", !fs.existsSync(ownLatchPathP));

  // Informational — see this card's own instruction: confirm/refute, don't fix here. Never fails the suite.
  if (fs.existsSync(orphanPathP)) {
    console.log(
      "SKIP  (P) THE TRACED GAP, CONFIRMED: the orphan latch file survives clearing the pending entry that " +
      "referenced it (card abccee85 item 5, traced not fixed — a follow-up card owns the actual fix; see " +
      "docs/decisions/abccee85-recorded-path-clear-immune-to-key-drift.md)."
    );
  } else {
    console.log("SKIP  (P) REFUTED this run: the orphan latch file was swept after all when the pending entry referencing it was cleared.");
  }
  try { fs.unlinkSync(orphanPathP); } catch { /* best-effort cleanup regardless of outcome */ }
}

// ===================== (Q) clearMergeQuarantineByRecordedPath — the FALLBACK recompute lifts an ENCLOSING repo's quarantine for a PENDING entry (round 5, Code Review of 2362064b, finding 1) =====================
// When no ACTIVE entry's stored repoPath matches the given identity, the old fallback called
// clearMergeQuarantineReporting(repoPath) directly, which recomputes canonicalRepoLockKey(repoPath) FRESH.
// A PENDING entry's own repoPath typically does not resolve on disk AT ALL, so that fresh recompute walks
// UP past it to the nearest EXISTING ancestor — which can be an ENCLOSING repo that is itself genuinely,
// separately, ACTIVELY quarantined. The old code then lifted that OUTER active quarantine while reporting
// wasQuarantined:true, leaving the actual (pending, inner) target fully intact. Reproduced with a REAL
// child-process boot (same technique as (P) — a genuinely separate module instance/empty activeQuarantines
// map), mirroring the reviewer's own repro: an outer repo quarantined WITH a resolvedKey, plus an inner
// latch with NO resolvedKey at a path that never exists on disk.
{
  const outerQ = freshDir("outerQ");
  fs.mkdirSync(path.join(outerQ, ".git"), { recursive: true });
  const innerQ = path.join(outerQ, "inner-never-created-q"); // deliberately never created on disk
  check("(Q precondition) innerQ does not exist on disk at all", !fs.existsSync(innerQ));

  // Hand-write outer's own clean, already-correctly-keyed ACTIVE latch.
  const outerKeyQ = canonicalRepoLockKey(outerQ);
  const outerHashQ = hashKey(outerKeyQ);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const outerLatchPathQ = path.join(MERGE_QUARANTINE_DIR, `${outerHashQ}.json`);
  fs.writeFileSync(outerLatchPathQ, JSON.stringify({
    repoPath: outerQ, branch: "nested-outer (Q)", reason: "round-5 fallback-drift repro outer (finding 1)",
    enteredAt: Date.now(), tokens: ["t-outer-q"], resolvedKey: outerKeyQ,
  }, null, 2) + "\n");

  // Hand-write inner's own PENDING (no resolvedKey, unresolvable path) latch under an unrelated filename.
  const innerSourceFileQ = `pending-inner-q-${sfx}.json`;
  const innerLatchPathQ = path.join(MERGE_QUARANTINE_DIR, innerSourceFileQ);
  fs.writeFileSync(innerLatchPathQ, JSON.stringify({
    repoPath: innerQ, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: "round-5 fallback-drift repro inner (finding 1) — never resolvable", enteredAt: Date.now(), tokens: ["t-inner-q"],
  }, null, 2) + "\n");

  const childScriptQ = `
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantineByRecordedPath } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    const beforeOuter = !!activeMergeQuarantineFor(${JSON.stringify(outerQ)});
    const beforePendingInner = listActiveMergeQuarantines().some((e) => e.repoPath === ${JSON.stringify(innerQ)});
    const clearResult = clearMergeQuarantineByRecordedPath(${JSON.stringify(innerQ)});
    const afterOuter = !!activeMergeQuarantineFor(${JSON.stringify(outerQ)});
    const afterPendingInner = listActiveMergeQuarantines().some((e) => e.repoPath === ${JSON.stringify(innerQ)});
    process.stdout.write(JSON.stringify({ beforeOuter, beforePendingInner, clearResult, afterOuter, afterPendingInner }));
  `;
  const childOutQ = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptQ], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultQ = JSON.parse(childOutQ);

  check("(Q precondition, child) outer is active before the clear", resultQ.beforeOuter === true);
  check("(Q precondition, child) inner is pending before the clear", resultQ.beforePendingInner === true);
  check("(Q) clearing by inner's (pending) stored repoPath reports wasQuarantined:true", resultQ.clearResult?.wasQuarantined === true);
  check("(Q) THE ROUND-5 BUG: outer's genuinely separate active quarantine is NEVER collaterally lifted", resultQ.afterOuter === true);
  check("(Q) and outer's own latch file is STILL on disk, never collaterally deleted", fs.existsSync(outerLatchPathQ));
  check("(Q) the inner pending entry is actually gone", resultQ.afterPendingInner === false);
  check("(Q) and inner's own source latch file is deleted", !fs.existsSync(innerLatchPathQ));

  clearMergeQuarantine(outerQ);
  check("(Q cleanup) outer's own latch file is now gone too", !fs.existsSync(outerLatchPathQ));
}

// ===================== (R) clearMergeQuarantineByRecordedPath — clears EVERY matching active entry, not just the first (round 5, Code Review of 2362064b, finding 3) =====================
// Two distinct active entries, under two distinct keys, can come to share ONE stored repoPath: a repo
// raised once before an enclosing `.git` existed (keyed to itself) and raised AGAIN after one appears
// nearby (keyed to the new enclosing toplevel) never merge into a single entry — `enterMergeQuarantine`
// only merges when the CURRENT key already has an existing entry. The old loop returned on the FIRST
// active match it found (Map iteration order), leaving any OTHER matching entry fully armed.
{
  const parentR = freshDir("repoR-parent");
  const repoR = path.join(parentR, "repo");
  fs.mkdirSync(repoR, { recursive: true });

  enterMergeQuarantine(repoR, "b", "first-raise, no enclosing git yet (R)");
  const keyR1 = canonicalRepoLockKey(repoR);
  const idR1 = hashKey(keyR1);
  const latchPathR1 = path.join(MERGE_QUARANTINE_DIR, `${idR1}.json`);
  check("(R precondition) repoR's first raise has its own latch file on disk", fs.existsSync(latchPathR1));

  fs.mkdirSync(path.join(parentR, ".git"), { recursive: true }); // the drift — parentR becomes repoR's new toplevel
  const keyR2 = canonicalRepoLockKey(repoR);
  check("(R precondition) repoR's key actually changed after the drift", keyR2 !== keyR1);

  enterMergeQuarantine(repoR, "b", "second-raise, same repoPath, DIFFERENT key (R)");
  const idR2 = hashKey(keyR2);
  const latchPathR2 = path.join(MERGE_QUARANTINE_DIR, `${idR2}.json`);
  check("(R precondition) repoR's second raise has its OWN, separate latch file under the new key", fs.existsSync(latchPathR2) && idR2 !== idR1);
  check("(R precondition) TWO distinct active entries now share repoR's exact stored repoPath", listActiveMergeQuarantines().filter((e) => e.repoPath === repoR).length === 2);

  const clearR = clearMergeQuarantineByRecordedPath(repoR);
  check("(R) clearing by repoR's stored repoPath reports wasQuarantined:true", clearR.wasQuarantined === true);
  check("(R) THE ROUND-5 BUG: BOTH matching active entries are cleared, not just the first one found", listActiveMergeQuarantines().filter((e) => e.repoPath === repoR).length === 0);
  check("(R) the first raise's own latch file is gone", !fs.existsSync(latchPathR1));
  check("(R) the second raise's own latch file is ALSO gone", !fs.existsSync(latchPathR2));
}

// ===================== (S) clearMergeQuarantineByKey's pending-sweep — REVERSE drift, reachable with NO given-string drift at all (round 5, Code Review of 2362064b, finding 4) =====================
// clearMergeQuarantineByKey's own pending-sweep used to match a pending entry by a FRESH
// canonicalRepoLockKey(p.entry.repoPath) recompute === the key being cleared — the SAME drift class as (Q)
// above, but reachable through the ORDINARY clearMergeQuarantine helper (used by e.g. the project-resolved
// `/clear` route and the in-process auto-clear-by-token path) with NO drift in the CALLER's own address at
// all: the caller names OUTER's own exact, never-drifted repoPath, and an UNRELATED pending INNER entry
// (whose own path never resolves, so its fresh recompute walks UP to OUTER's key) still gets silently
// swept as collateral.
{
  const outerS = freshDir("outerS");
  fs.mkdirSync(path.join(outerS, ".git"), { recursive: true });
  const innerS = path.join(outerS, "inner-never-created-s"); // deliberately never created on disk
  check("(S precondition) innerS does not exist on disk at all", !fs.existsSync(innerS));

  // Hand-write OUTER's own clean, already-correctly-keyed ACTIVE latch — NOT via enterMergeQuarantine,
  // which has its own separate pending-merge check (decision 54054c01) that would otherwise consume the
  // pending latch below before this test ever reaches the clearMergeQuarantineByKey code path under test.
  const outerKeyS = canonicalRepoLockKey(outerS);
  const outerHashS = hashKey(outerKeyS);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const outerLatchPathS = path.join(MERGE_QUARANTINE_DIR, `${outerHashS}.json`);
  fs.writeFileSync(outerLatchPathS, JSON.stringify({
    repoPath: outerS, branch: "outer (S)", reason: "round-5 reverse-drift repro outer (finding 4)",
    enteredAt: Date.now(), tokens: ["t-outer-s"], resolvedKey: outerKeyS,
  }, null, 2) + "\n");

  // Hand-write INNER's own PENDING (no resolvedKey, unresolvable path) latch under an unrelated filename.
  const innerSourceFileS = `pending-inner-s-${sfx}.json`;
  const innerLatchPathS = path.join(MERGE_QUARANTINE_DIR, innerSourceFileS);
  fs.writeFileSync(innerLatchPathS, JSON.stringify({
    repoPath: innerS, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: "round-5 reverse-drift repro inner (finding 4) — never resolvable", enteredAt: Date.now(), tokens: ["t-inner-s"],
  }, null, 2) + "\n");

  // Round 6 (delta Code Review of 810e485b, finding 1, BLOCKING): the post-clear check now asserts the
  // USER-VISIBLE outcome via `assertRepoNotQuarantined`, not the latch file's own on-disk presence. Before
  // this round, `activeMergeQuarantineFor`'s own lazy pending-resolve ALSO recomputed `canonicalRepoLockKey`
  // on the pending entry's repoPath (the same drift class (Q)/(S) exist to close) — so even though
  // `clearMergeQuarantineByKey` genuinely lifted outer's own entry and deleted its latch file, a QUERY for
  // outer right afterward still walked innerS's still-pending, still-unresolvable path UP to outer's key
  // and misreported outer as still quarantined, FOREVER (clear and query had diverged). Fixed by matching
  // the pending lookup there via `directPathIdentity` too — see the decision record, round 6.
  const childScriptS = `
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, listActiveMergeQuarantines, clearMergeQuarantine, assertRepoNotQuarantined } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    const beforeOuter = !!activeMergeQuarantineFor(${JSON.stringify(outerS)});
    const beforePendingInner = listActiveMergeQuarantines().some((e) => e.repoPath === ${JSON.stringify(innerS)});
    clearMergeQuarantine(${JSON.stringify(outerS)});
    const afterOuterCheck = assertRepoNotQuarantined(${JSON.stringify(outerS)});
    const afterPendingInner = listActiveMergeQuarantines().some((e) => e.repoPath === ${JSON.stringify(innerS)});
    process.stdout.write(JSON.stringify({ beforeOuter, beforePendingInner, afterOuterCheck, afterPendingInner }));
  `;
  const childOutS = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptS], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultS = JSON.parse(childOutS);

  check("(S precondition, child) outer is active before the clear", resultS.beforeOuter === true);
  check("(S precondition, child) inner is pending before the clear", resultS.beforePendingInner === true);
  check("(S) clearing OUTER by its own exact, never-drifted repoPath deletes its own latch file", !fs.existsSync(outerLatchPathS));
  check("(S) THE ROUND-6 BLOCKING BUG: the USER-VISIBLE outcome (assertRepoNotQuarantined) agrees outer is genuinely unblocked, not just the latch file", resultS.afterOuterCheck.ok === true);
  check("(S) THE REVERSE-DRIFT BUG: clearing OUTER does NOT collaterally sweep the unrelated pending INNER entry", resultS.afterPendingInner === true);
  check("(S) and inner's own source latch file is still on disk, never collaterally deleted", fs.existsSync(innerLatchPathS));

  try { fs.unlinkSync(innerLatchPathS); } catch { /* best-effort cleanup */ }
}

// ===================== (T) enterMergeQuarantine's pending-merge check — a FRESH raise must never adopt an unrelated pending entry's identity (round 6, Code Review of 810e485b, finding 2, MAJOR, pre-existing) =====================
// `enterMergeQuarantine`'s own pending-merge check (decision 54054c01) used to match by a FRESH
// `canonicalRepoLockKey(p.entry.repoPath) === key` recompute, the SAME drift class as (Q)/(S) above.
// `unionQuarantineEntries` keeps the OLDER identity's `repoPath` — so a brand-new raise on OUTER, with an
// unrelated, still-pending, never-resolvable INNER latch recomputing to the SAME key, would silently adopt
// INNER's repoPath for OUTER's own live, real unconfirmed-kill quarantine. A later clear-by-path targeting
// INNER's own (genuinely unrelated) repoPath would then lift OUTER's real quarantine.
{
  const outerT = freshDir("outerT");
  fs.mkdirSync(path.join(outerT, ".git"), { recursive: true });
  const innerT = path.join(outerT, "inner-never-created-t"); // deliberately never created on disk

  // Hand-write INNER's own PENDING (no resolvedKey, unresolvable path) latch, written BEFORE outer's raise
  // below so it is unambiguously the OLDER entry (unionQuarantineEntries picks the older identity) — the
  // exact shape that let the bug win every time it fired. NOTE: `branch` must NOT be
  // PLACEHOLDER_BRANCH_CORRUPT/PLACEHOLDER_BRANCH_UNRESOLVED — isPlaceholderEntryShape would otherwise
  // flag this as a generic boot-placeholder and unionQuarantineEntries' OWN "never let a placeholder win
  // identity" rule (decision 92c645cc) masks this test's actual bug entirely (caught mid-development: with
  // that text, the identity check below passed even on the unfixed code, for the wrong reason).
  const innerSourceFileT = `pending-inner-t-${sfx}.json`;
  const innerLatchPathT = path.join(MERGE_QUARANTINE_DIR, innerSourceFileT);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(innerLatchPathT, JSON.stringify({
    repoPath: innerT, branch: "feature/unrelated-raise-on-inner",
    reason: "round-6 cross-identity-merge repro inner (finding 2) — never resolvable", enteredAt: Date.now() - 60_000, tokens: ["t-inner-t"],
  }, null, 2) + "\n");

  const childScriptT = `
    const { reenterMergeQuarantinesAtBoot, enterMergeQuarantine, activeMergeQuarantineFor, assertRepoNotQuarantined, clearMergeQuarantineByRecordedPath } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    enterMergeQuarantine(${JSON.stringify(outerT)}, "real-outer-branch", "unconfirmed-kill on outer (T)");
    const outerEntry = activeMergeQuarantineFor(${JSON.stringify(outerT)});
    const outerRepoPathAfterRaise = outerEntry ? outerEntry.repoPath : null;
    clearMergeQuarantineByRecordedPath(${JSON.stringify(innerT)});
    const outerCheckAfterClearingInner = assertRepoNotQuarantined(${JSON.stringify(outerT)});
    process.stdout.write(JSON.stringify({ outerRepoPathAfterRaise, outerCheckAfterClearingInner }));
  `;
  const childOutT = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptT], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultT = JSON.parse(childOutT);

  check("(T) THE ROUND-6 MAJOR BUG: a fresh raise on OUTER carries OUTER's own repoPath, never adopting the unrelated pending INNER's identity", resultT.outerRepoPathAfterRaise === outerT);
  check("(T) and clearing INNER by its own stored repoPath leaves OUTER's real, independent quarantine fully armed", resultT.outerCheckAfterClearingInner.ok === false);

  try { fs.unlinkSync(innerLatchPathT); } catch { /* best-effort cleanup — may already be gone if the bug reproduced */ }
}

// ===================== (U) clearMergeQuarantineByRecordedPath's pending branch drops EVERY identity-matching pending entry, not just the first (round 6, Code Review of 810e485b, item 4) =====================
// Consistent with clearMergeQuarantineByKey's own pending filter (which already dropped every match): more
// than one pending latch can share one stored identity (e.g. duplicate/stale residue), and the old
// `findIndex` + single-splice shape here left every match after the first fully intact.
{
  const parentU = freshDir("innerU-parent");
  const innerU = path.join(parentU, "inner-never-created-u"); // deliberately never created on disk
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sourceFileU1 = `pending-inner-u1-${sfx}.json`;
  const sourceFileU2 = `pending-inner-u2-${sfx}.json`;
  const pathU1 = path.join(MERGE_QUARANTINE_DIR, sourceFileU1);
  const pathU2 = path.join(MERGE_QUARANTINE_DIR, sourceFileU2);
  const bodyU = (tag) => JSON.stringify({
    repoPath: innerU, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: `round-6 duplicate-pending repro ${tag} (item 4) — never resolvable`, enteredAt: Date.now(), tokens: [`t-${tag}`],
  }, null, 2) + "\n";
  fs.writeFileSync(pathU1, bodyU("u1"));
  fs.writeFileSync(pathU2, bodyU("u2"));

  reenterMergeQuarantinesAtBoot([]);
  const pendingCountBeforeU = listActiveMergeQuarantines().filter((e) => e.repoPath === innerU).length;
  check("(U precondition) TWO distinct pending entries share the exact same stored repoPath", pendingCountBeforeU === 2);
  check("(U precondition) both source files exist on disk", fs.existsSync(pathU1) && fs.existsSync(pathU2));

  const clearU = clearMergeQuarantineByRecordedPath(innerU);
  check("(U) clearing by the shared stored repoPath reports wasQuarantined:true", clearU.wasQuarantined === true);
  check("(U) THE ITEM-4 BUG: BOTH pending entries are dropped, not just the first one found", listActiveMergeQuarantines().filter((e) => e.repoPath === innerU).length === 0);
  check("(U) the first duplicate's source file is gone", !fs.existsSync(pathU1));
  check("(U) the SECOND duplicate's source file is ALSO gone", !fs.existsSync(pathU2));
}

// ===================== (V) assertRepoNotQuarantined — names the BLOCKING entry's own repoPath/latch id, points at /clear-by-path (round 6, Code Review of 810e485b, item 3) =====================
{
  // --- (V1) ordinary case: the blocking entry IS the one asked about ---
  const repoV = freshDir("repoV");
  enterMergeQuarantine(repoV, "branch-v", "reason-v (V1)");
  const checkV1 = assertRepoNotQuarantined(repoV);
  check("(V1 precondition) repoV reads as quarantined", checkV1.ok === false);
  const latchIdV1 = quarantineLatchIdFor(repoV);
  check("(V1) the refusal reason names the blocking entry's own repoPath", checkV1.ok === false && checkV1.reason.includes(repoV));
  check("(V1) the refusal reason names the blocking entry's own latch id", checkV1.ok === false && checkV1.reason.includes(latchIdV1));
  check("(V1) the refusal reason points at /clear-by-path (not just the project-resolved /clear, which can be a dead end)", checkV1.ok === false && checkV1.reason.includes("/clear-by-path"));
  clearMergeQuarantine(repoV);

  // --- (V2) the blocking entry's repoPath DIFFERS from the one asked about: querying a SUBDIRECTORY of a
  // quarantined repo returns the entry keyed by the repo's own ROOT (decision 7673d096 — two paths of one
  // physical repo collapse onto one entry, by design) — the reason must name the ROOT, not the subdir. ---
  const repoRootV2 = freshDir("repoRootV2");
  fs.mkdirSync(path.join(repoRootV2, ".git"), { recursive: true });
  const subdirV2 = path.join(repoRootV2, "sub");
  fs.mkdirSync(subdirV2, { recursive: true });
  enterMergeQuarantine(repoRootV2, "branch-v2", "reason-v2 (V2)");
  check("(V2 precondition) the subdir and its repo root are genuinely different strings", subdirV2 !== repoRootV2);
  const checkV2 = assertRepoNotQuarantined(subdirV2);
  check("(V2 precondition) querying the SUBDIRECTORY still reads as quarantined (same canonical key)", checkV2.ok === false);
  check("(V2) THE ITEM-3 FIX: the reason names the BLOCKING entry's own repoPath (the repo root), not the subdir that was asked about", checkV2.ok === false && checkV2.reason.includes(repoRootV2) && !checkV2.reason.includes(subdirV2));
  clearMergeQuarantine(repoRootV2);
}

// ===================== (W) partitionQuarantinesByRegistration — a PENDING entry must not be mis-registered via an enclosing registered repo's key (round 6, Code Review of 810e485b — additional finding from the grep audit) =====================
{
  const registeredOuterW = freshDir("registeredOuterW");
  fs.mkdirSync(path.join(registeredOuterW, ".git"), { recursive: true });
  const innerW = path.join(registeredOuterW, "inner-never-created-w"); // deliberately never created on disk

  const sourceFileW = `pending-inner-w-${sfx}.json`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const pathW = path.join(MERGE_QUARANTINE_DIR, sourceFileW);
  fs.writeFileSync(pathW, JSON.stringify({
    repoPath: innerW, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: "round-6 pending-registration repro (additional finding) — never resolvable, unrelated to the registered outer repo",
    enteredAt: Date.now(), tokens: ["t-w"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([registeredOuterW]);
  const entriesW = listActiveMergeQuarantines();
  const innerEntryW = entriesW.find((e) => e.repoPath === innerW);
  check("(W precondition) innerW is loaded as a PENDING entry", !!innerEntryW);
  check("(W precondition) a fresh recompute of innerW's key WOULD coincidentally equal registeredOuterW's own key (the hazard this test exercises)", canonicalRepoLockKey(innerW) === canonicalRepoLockKey(registeredOuterW));

  const { registered: registeredW, orphaned: orphanedW } = partitionQuarantinesByRegistration(entriesW, [registeredOuterW]);
  check("(W) THE ADDITIONAL FINDING: the pending INNER entry is classified as orphaned, never wrongly registered via the enclosing repo's key", orphanedW.includes(innerEntryW) && !registeredW.includes(innerEntryW));

  try { fs.unlinkSync(pathW); } catch { /* best-effort cleanup */ }
}

// ===================== (X) clearMergeQuarantineByRecordedPath — the LAST-RESORT fallback no longer recomputes from the given string (round 7, card abccee85) =====================
// Once neither an ACTIVE nor a PENDING entry's stored repoPath matches at all, the old fallback called
// clearMergeQuarantineReporting(repoPath) directly, recomputing canonicalRepoLockKey(repoPath) FRESH. A
// typo'd/stale path that was NEVER itself quarantined (no entry anywhere — active or pending — stores it)
// can still walk UP past its own non-existent leaf to a real, genuinely-quarantined ENCLOSING repo and
// collaterally lift THAT unrelated quarantine while reporting wasQuarantined:true — the same drift class
// round 5/6 already closed for the pending-entry case, reached here through the "nothing matches at all"
// door instead.
{
  const outerX = freshDir("outerX");
  fs.mkdirSync(path.join(outerX, ".git"), { recursive: true });
  enterMergeQuarantine(outerX, "outer-x-branch", "round-7 last-resort-fallback repro (X)");
  const typoX = path.join(outerX, "typo-path-never-quarantined-x"); // never created, never raised against
  check("(X precondition) typoX does not exist on disk", !fs.existsSync(typoX));
  check("(X precondition) outer is active before the clear attempt", assertRepoNotQuarantined(outerX).ok === false);

  const clearX = clearMergeQuarantineByRecordedPath(typoX);
  check("(X) THE ROUND-7 BUG: clearing a never-quarantined (typo'd) path reports wasQuarantined:false, never a collateral lift", clearX.wasQuarantined === false);
  check("(X) the not-found reason names GET /internal/merge-quarantine/list", typeof clearX.reason === "string" && clearX.reason.includes("/internal/merge-quarantine/list"));
  check("(X) outer's genuinely separate, real quarantine is NEVER collaterally lifted", assertRepoNotQuarantined(outerX).ok === false);

  clearMergeQuarantine(outerX);
  check("(X cleanup) outer is cleared for real afterward", assertRepoNotQuarantined(outerX).ok === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /internal/merge-quarantine/clear-by-path (repoPath AND id addressing, exactly-one-of validation, path-traversal id rejection), GET /internal/merge-quarantine/list (id/registered projection, incl. a dual-armed entry's own id/ids BEFORE it's cleared), the shared clearMergeQuarantineReporting helper (no drift between /clear and /clear-by-path), partitionQuarantinesByRegistration / db.listAllRegisteredRepoPaths (live + multi-repo + archived registration, never swallowing a registered+quarantined repo into the orphan bucket, and a registered-path spelling variant), clearMergeQuarantineLatchFile's round-2/3 fixes, quarantineLatchFileIdsFor's round-3 real-file-first ordering, clearMergeQuarantineByRecordedPath's round-4/5 stored-repoPath-addressed clear (the `{repoPath}` form's own immunity to key drift, clearing every matching active entry, and the pending-fallback drift) and legacyQuarantineHashFor's byte-identical behavior, PLUS round 6's governing-rule fixes — pending entries are matched by stored directPathIdentity, never a freshly re-walked canonicalRepoLockKey, at every site: (T) enterMergeQuarantine's pending-merge no longer adopts an unrelated pending entry's identity for a fresh raise, (U) clearMergeQuarantineByRecordedPath's pending branch drops EVERY identity-matching pending entry, (V) assertRepoNotQuarantined names the BLOCKING entry's own repoPath/latch id and points at /clear-by-path, and (W) partitionQuarantinesByRegistration no longer mis-registers a pending entry via an enclosing repo's key — all behave as designed (cards c0be9bf9, abccee85). Section (P) is a card-abccee85-item-5 REPRO (trace only, informational, never fails this suite). Round 7: (X) clearMergeQuarantineByRecordedPath's own last-resort fallback no longer recomputes a fresh key from a never-quarantined (typo'd) given path — it reports not-found instead of collaterally lifting an unrelated enclosing repo's real quarantine."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
