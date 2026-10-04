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
  partitionQuarantinesByRegistration, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
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
  function makeNestedGitFixture(tag) {
    const outer = freshDir(`${tag}-outer`);
    fs.mkdirSync(path.join(outer, ".git"), { recursive: true }); // marks outer as its own git root
    const inner = path.join(outer, "inner");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true }); // marks inner as a NESTED git root
    return { outer, inner };
  }

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

  // --- (L negative control) the identical fixture, with NO drift — proves (L)'s own assertions aren't
  // vacuously true for every shape; without the drift, round 1/2's own code ALSO passes this, so only the
  // drifted case above can ever manifest the round-3 bug. ---
  const { outer: outerLNC, inner: innerLNC } = makeNestedGitFixture("nestLnc");
  const idOuterLNC = quarantineLatchIdFor(outerLNC);
  const outerLatchPathLNC = path.join(MERGE_QUARANTINE_DIR, `${idOuterLNC}.json`);
  enterMergeQuarantine(innerLNC, "b", "nested-inner-nc (L-NC)");
  enterMergeQuarantine(outerLNC, "b", "nested-outer-nc (L-NC)");
  const idInnerLNC = quarantineLatchIdFor(innerLNC);
  const innerLatchPathLNC = path.join(MERGE_QUARANTINE_DIR, `${idInnerLNC}.json`);
  const clearLNC = clearMergeQuarantineLatchFile(idInnerLNC);
  check("(L negative control, no drift) clearing inner by id reports ok:true", clearLNC.ok === true);
  check("(L negative control, no drift) inner's own latch file is deleted", !fs.existsSync(innerLatchPathLNC));
  check("(L negative control, no drift) outer's own latch file is still there", fs.existsSync(outerLatchPathLNC));
  clearMergeQuarantine(outerLNC);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /internal/merge-quarantine/clear-by-path (repoPath AND id addressing, exactly-one-of validation, path-traversal id rejection), GET /internal/merge-quarantine/list (id/registered projection), the shared clearMergeQuarantineReporting helper (no drift between /clear and /clear-by-path), partitionQuarantinesByRegistration / db.listAllRegisteredRepoPaths (live + multi-repo + archived registration, never swallowing a registered+quarantined repo into the orphan bucket, and a registered-path spelling variant), clearMergeQuarantineLatchFile's round-2 fixes (a dual-armed entry's real file, and an orphanLatchFiles sweep, both actually cleared by id), quarantineLatchFileIdsFor's round-3 real-file-first ordering, and clearMergeQuarantineLatchFile's round-3 key-addressed clear (immune to key drift between match and act) all behave as designed (card c0be9bf9)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
