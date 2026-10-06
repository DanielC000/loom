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

    // --- (H7) /clear's own `reason` threading (card 883e29bc, round 3, finding 4) — a diverted blocker
    // (X = projRepo's own nested sub-repo, unresolvable, resolvedKey=Kx) must have its `reason` field
    // actually forwarded by the ROUTE, not just computed and dropped. projRepo needs its OWN `.git`
    // marker so X's degraded walked-up key (once X itself vanishes) lands EXACTLY on projRepo's own key
    // — never a coincidental collision with an unrelated path, which would let a single clear fully
    // resolve X instead of leaving it as a genuine, re-discoverable (tier 4) residual blocker. ---
    fs.mkdirSync(path.join(projRepo, ".git"), { recursive: true }); // never existed before (H1-H6 never needed it)
    const kProjRepo = canonicalRepoLockKey(projRepo);
    const nestedH7 = path.join(projRepo, "nestedH7");
    fs.mkdirSync(path.join(nestedH7, ".git"), { recursive: true });
    const kNestedH7 = canonicalRepoLockKey(nestedH7); // X's own TRUE key, captured while it still resolves
    check("(H7 precondition) X's own key differs from projRepo's own key", kNestedH7 !== kProjRepo);
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineLatchIdFor(nestedH7)}.json`), JSON.stringify({
      repoPath: nestedH7, branch: "x-h7-branch", reason: "X's own prior raise, recorded under its TRUE key",
      enteredAt: Date.now() - 60_000, tokens: ["x-h7-token"], resolvedKey: kNestedH7,
    }, null, 2) + "\n");
    fs.rmSync(nestedH7, { recursive: true, force: true }); // X vanishes — its degraded walk now lands on projRepo
    check("(H7 precondition) X no longer resolves", !fs.existsSync(nestedH7));
    reenterMergeQuarantinesAtBoot([projRepo, nestedH7]);
    check("(H7 precondition) projRepo reads quarantined via X's diverted entry", !!activeMergeQuarantineFor(projRepo) && (activeMergeQuarantineFor(projRepo).tokens ?? []).includes("x-h7-token"));

    const clearH7 = await app.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: H, payload: { projectId: "projH" } });
    check("(H7) /clear → 200", clearH7.statusCode === 200);
    const bodyH7 = clearH7.json();
    check("(H7) wasQuarantined:true — projRepo genuinely still quarantined (nothing was lifted)", bodyH7.wasQuarantined === true);
    check("*** THE FIX *** the route threads a `reason` naming X — never silently dropping the spread", typeof bodyH7.reason === "string" && bodyH7.reason.includes(nestedH7));
    check("*** THE FIX *** the reason points at /clear-by-path", bodyH7.reason.includes("clear-by-path"));

    clearMergeQuarantineByRecordedPath(nestedH7); // cleanup
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

// ===================== (I) clearMergeQuarantineLatchFile — a degraded-divert entry (round 2, card c0be9bf9; SUPERSEDED by card 883e29bc) =====================
// Round 2 scope (Code Review c2aa28c3 of e5ba5376, blocking Major): clearing by id used to re-implement
// clearMergeQuarantine by hand and only ever unlink the ONE file named `<id>.json` — missing a
// dual-armed entry's SECOND latch file entirely (decision 54054c01: an entry armed under both its
// `resolvedKey` and a degraded current-key fallback has its REAL physical file at the resolvedKey hash,
// which can differ from the id a human reads off a recomputed-key listing).
//
// @decision 883e29bc — board card 883e29bc stopped PASS 1 from EVER arming a degraded, unresolvable
// entry directly at its walked-up current key at all (it arms ONLY at the entry's own trusted
// resolvedKey, diverting the degraded key's own signal to pendingUnresolvedQuarantines instead — see
// that card's own decision record). So the shape this scenario originally manufactured — a repo that
// never resolves, armed under TWO distinct keys — can no longer occur for an entry with no verified
// sibling sharing its degraded key; it is now SINGLE-armed, under resolvedKey alone, and the "degraded
// id" a human might previously have read off a recomputed-key listing no longer corresponds to anything
// at all (`quarantineLatchFileIdsFor` now returns exactly one id, the real one). Updated to assert the
// new (single-arm) contract directly, and to cover the new no-op shape (clearing by a key nothing is
// armed under is a benign `{ok:true, wasQuarantined:false}`, never a false positive or a thrown error).
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
    repoPath: repoDual, branch: "dual-arm-branch", reason: "round 2 (c0be9bf9) — manufactured degraded-divert latch",
    enteredAt: Date.now(), tokens: ["token-dual-i"], resolvedKey: resolvedKeyFake,
  }, null, 2) + "\n");
  check("(I precondition) the manufactured real latch file exists under the resolvedKey hash", fs.existsSync(realLatchPathDual));

  reenterMergeQuarantinesAtBoot([repoDual]);
  const dualEntry = activeMergeQuarantineFor(repoDual);
  check("(I precondition) boot re-entry arms repoDual in-memory", !!dualEntry);
  check("(I) THE 883e29bc FIX: it is SINGLE-armed, at resolvedKey alone — never the degraded current key too", (dualEntry?.armedKeys?.length ?? 0) === 1 && (dualEntry?.armedKeys ?? []).every((k) => hashKey(k) === realHash));

  // The id a human would have been handed by a RECOMPUTED-key listing pre-883e29bc — the DEGRADED
  // current-key hash. It has NO physical file, and (post-883e29bc) nothing is armed there either.
  const degradedId = quarantineLatchIdFor(repoDual);
  check("(I precondition) the recomputed/degraded id differs from the real file's own hash", degradedId !== realHash);
  check("(I precondition) no file exists under the degraded id", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${degradedId}.json`)));

  const idsI = quarantineLatchFileIdsFor(dualEntry);
  check("(I) THE 883e29bc FIX: quarantineLatchFileIdsFor returns EXACTLY one id — the real, on-disk one", idsI.length === 1 && idsI[0] === realHash);

  // --- (I-list) GET /internal/merge-quarantine/list projects this single-armed entry's own `id`/`ids`
  // correctly — only the real id, never the now-meaningless degraded one.
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
      check("(I-list) item.id names the real, on-disk hash", itemI?.id === realHash);
      check("(I-list) THE 883e29bc FIX: item.ids no longer includes the (now-meaningless) degraded id", !(itemI?.ids ?? []).includes(degradedId));
    } finally {
      await appI.close();
      dbI.close();
    }
  }

  // Clearing by the (now-meaningless) degraded id is a benign no-op — nothing is armed there, nothing on
  // disk names it, so this must report success without any wasQuarantined/latch-removal side effect.
  const clearByDegraded = clearMergeQuarantineLatchFile(degradedId);
  check("(I) clearing by the degraded id is a benign no-op: ok:true, wasQuarantined:false", clearByDegraded.ok === true && clearByDegraded.wasQuarantined === false);
  check("(I) the real entry is UNAFFECTED by that no-op clear", !!activeMergeQuarantineFor(repoDual));
  check("(I) its real latch file is UNAFFECTED too", fs.existsSync(realLatchPathDual));

  // Clearing by the REAL id is what actually lifts this entry now.
  const clearByReal = clearMergeQuarantineLatchFile(realHash);
  check("(I) clearing by the real id reports ok:true, wasQuarantined:true", clearByReal.ok === true && clearByReal.wasQuarantined === true);
  check("(I) the in-memory entry is fully gone", !activeMergeQuarantineFor(repoDual));
  check("(I) its real latch file is actually deleted, not left behind to re-arm on the next boot", !fs.existsSync(realLatchPathDual));
}

// ===================== (I2) clearMergeQuarantineLatchFile — a GENUINE dual-armed entry still exists (round 2, card 883e29bc, finding 4) =====================
// Card 883e29bc stopped PASS 1/1b from dual-arming a DEGRADED, unresolvable entry — but PASS 1b's own
// fall-through for a RESOLVABLE tmp-residue entry whose stored resolvedKey differs from its current key
// is UNCHANGED (that branch is gated on `!isRepoPathCurrentlyResolvable`, never reached when the path
// DOES resolve) — so a genuine dual-arm, with two distinct ids, is still fully reachable this way. This
// restores the coverage (I)'s own rewrite lost for `quarantineLatchFileIdsFor`'s round-3 real-file-first
// sort: repoDual2 is a REAL, RESOLVABLE directory the whole time; its latch exists only as a torn-write
// tmp residue (PASS 1b's recovery path) carrying a SYNTHETIC resolvedKey distinct from its own real key.
{
  const repoDual2 = freshDir("dual2");
  const realKey2 = canonicalRepoLockKey(repoDual2);
  const realHash2 = quarantineLatchIdFor(repoDual2);
  const fakeResolvedKey2 = `/synthetic/toplevel/for-dual-arm-i2-${sfx}`;
  const fakeHash2 = hashKey(fakeResolvedKey2);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // Filed under the FAKE key's own hash, as a `.json.tmp-<pid>-<hex>` torn-write residue — PASS 1b reads
  // every `*.json.tmp-...` file regardless of its own filename hash.
  const tmpLatchPathDual2 = path.join(MERGE_QUARANTINE_DIR, `${fakeHash2}.json.tmp-999-deadbeef`);
  fs.writeFileSync(tmpLatchPathDual2, JSON.stringify({
    repoPath: repoDual2, branch: "dual-arm-i2-branch", reason: "round 2 (883e29bc, finding 4) — genuine resolvable dual-arm via PASS 1b",
    enteredAt: Date.now(), tokens: ["token-dual-i2"], resolvedKey: fakeResolvedKey2,
  }, null, 2) + "\n");
  check("(I2 precondition) repoDual2 is genuinely resolvable", fs.existsSync(repoDual2));

  reenterMergeQuarantinesAtBoot([repoDual2]);
  const dualEntry2 = activeMergeQuarantineFor(repoDual2);
  check("(I2 precondition) boot re-entry arms repoDual2 in-memory", !!dualEntry2);
  check("(I2) genuinely DUAL-armed (two distinct keys) — PASS 1b's resolvable fall-through is unaffected by 883e29bc", (dualEntry2?.armedKeys?.length ?? 0) === 2);
  check("(I2) one of those armed keys is repoDual2's own real key", (dualEntry2?.armedKeys ?? []).some((k) => k === realKey2));
  check("(I2) the other is the synthetic resolvedKey", (dualEntry2?.armedKeys ?? []).some((k) => k === fakeResolvedKey2));

  // PASS 1b's own post-loop promotion (`writeMergeQuarantineLatch`) durably writes the union under the
  // REAL key's own hash and deletes the tmp residue on success — so by now realHash2.json exists and
  // fakeHash2 has no file at all; natural armedKeys insertion order (currentKey=real first, resolvedKey=
  // fake second) already happens to put the real-file id first here too, so this alone does not
  // discriminate the SORT specifically (verified separately below).
  const idsI2 = quarantineLatchFileIdsFor(dualEntry2);
  check("(I2) exactly two ids, the on-disk (real-key) one sorted FIRST", idsI2.length === 2 && idsI2[0] === realHash2 && idsI2[1] === fakeHash2);
  check("(I2) negative control: the synthetic-key id genuinely has NO file of its own on disk", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${fakeHash2}.json`)));
  check("(I2) and the real-key id's own file DOES exist (promoted by PASS 1b)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${realHash2}.json`)));

  const clearDual2 = clearMergeQuarantineLatchFile(idsI2[0]);
  check("(I2) clearing by the real (on-disk) id reports ok:true, wasQuarantined:true", clearDual2.ok === true && clearDual2.wasQuarantined === true);
  check("(I2) the in-memory entry is fully gone (BOTH armed keys lifted)", !activeMergeQuarantineFor(repoDual2));
  check("(I2) the tmp residue is actually deleted", !fs.existsSync(tmpLatchPathDual2));
}

// ===================== (I3) quarantineLatchFileIdsFor — real-file-first sort, directly (round 2, card 883e29bc, finding 4) =====================
// (I2) above restores a genuine PRODUCTION path (PASS 1b's resolvable dual-arm) that still creates a
// multi-key armedKeys entry — but its own NATURAL armedKeys insertion order happens to already put the
// real-file key first, so it cannot by itself discriminate whether the SORT in quarantineLatchFileIdsFor
// is actually doing anything (round 1 of this card's own review: disabling the sort there does NOT flip
// (I2)'s own result). This isolates the sort's OWN contract directly: armedKeys whose NATURAL (insertion)
// order has the NO-FILE key first and the HAS-FILE key second — the shape PASS 1's original (now-removed)
// degraded-dual-arm used to produce, and the one the round-3 sort (card c0be9bf9) exists for.
{
  const keyNoFile = `/synthetic/sort-check/no-file-${sfx}`;
  const keyHasFile = `/synthetic/sort-check/has-file-${sfx}`;
  const hashNoFile = hashKey(keyNoFile);
  const hashHasFile = hashKey(keyHasFile);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashHasFile}.json`), JSON.stringify({
    repoPath: "/unused/sort-check-fixture", branch: "b", reason: "fixture file for the sort check only",
    enteredAt: Date.now(), tokens: ["unused"],
  }, null, 2) + "\n");
  check("(I3 precondition) the has-file hash's own file exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashHasFile}.json`)));
  check("(I3 precondition) the no-file hash's own file does NOT exist", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashNoFile}.json`)));

  const constructedEntry = {
    repoPath: "/unused/sort-check-entry", branch: "b", reason: "r", enteredAt: Date.now(), tokens: ["t"],
    armedKeys: [keyNoFile, keyHasFile], // NATURAL insertion order: no-file FIRST, has-file SECOND
  };
  const idsI3 = quarantineLatchFileIdsFor(constructedEntry);
  check("(I3) THE SORT: the on-disk (has-file) id is returned FIRST despite natural insertion order", idsI3[0] === hashHasFile && idsI3[1] === hashNoFile);

  try { fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, `${hashHasFile}.json`)); } catch { /* best-effort */ }
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

// ===================== (P) a pending entry's own orphanLatchFiles sweep gap — now FIXED (card 6237bef6, traced by round 4's abccee85) =====================
// abccee85 item 5 only confirmed this with a REPRO (deliberately not a fix — see that card's own decision
// record, "Traced, not fixed"). Card 6237bef6 closes it: a PASS-2-created fail-closed entry (an orphan
// latch matching NO registered repo) persists NO `resolvedKey` (only the in-memory-only `armedKeys`,
// stripped before writeMergeQuarantineLatch persists it) — so if that repo's OWN path later becomes
// unresolvable on a SUBSEQUENT boot, it reloads as a PENDING entry (the `!resolvableNow && !entry.resolvedKey`
// gate in reenterMergeQuarantinesAtBoot), still carrying its old orphanLatchFiles forward. All THREE
// pending-removal sites (clearMergeQuarantineByKey's pending filter, clearMergeQuarantineLatchFile's
// pending-match branch — both below — and clearMergeQuarantineByRecordedPath's own pending branch, (P2)
// below, which abccee85's own trace never named) now sweep a cleared pending entry's own orphanLatchFiles
// too, via the shared `sweepOrphanLatchFileIfUnreferenced` helper.
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
  // The module's own boot-time/clear-time console.log (e.g. "deleted orphan latch...") shares stdout with
  // our deliberate final write — only the LAST line is ever our own JSON.stringify payload.
  const resultP = JSON.parse(childOut.trim().split("\n").pop());

  check("(P precondition, child boot 2) repoP is reported via the PENDING lazy-resolve (no resolvedKey, no active re-arm)", resultP.entryResolvedKey === null);
  check("(P precondition, child boot 2) the PENDING entry still carries the orphan filename forward", (resultP.entryOrphanLatchFiles ?? []).includes(path.basename(orphanPathP)));
  check("(P) clearing the pending entry by id (in the child) reports ok:true", resultP.clearResult?.ok === true);
  check("(P) the pending entry's OWN latch/source file is gone", !fs.existsSync(ownLatchPathP));
  // card 6237bef6 — was INFORMATIONAL (a bare SKIP print either way); now a HARD assertion: the orphan file
  // referenced by nothing else must actually be swept once the pending entry that referenced it is cleared.
  check("(P) THE FIX: the orphan latch file is swept once the pending entry referencing it is cleared", !fs.existsSync(orphanPathP));
}

// ===================== (P2) site 3 of 3 — clearMergeQuarantineByRecordedPath's own pending branch sweeps orphanLatchFiles too (card 6237bef6) =====================
// abccee85's own trace named only two pending-removal sites (clearMergeQuarantineByKey's pending filter,
// and clearMergeQuarantineLatchFile's pending-match branch, section (P) above). This third site —
// clearMergeQuarantineByRecordedPath's own direct `matchedPending` branch, reachable via
// `/clear-by-path {repoPath}` — has the IDENTICAL gap and was not named. Same PASS-2/two-boot repro shape
// as (P), but cleared by repoPath instead of by id.
{
  const repoP2 = freshDir("repoP2");
  const orphanPathP2 = path.join(MERGE_QUARANTINE_DIR, `orphan-p2-${sfx}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(orphanPathP2, "{not valid json");
  check("(P2 precondition) the unmatched corrupt orphan latch exists", fs.existsSync(orphanPathP2));

  reenterMergeQuarantinesAtBoot([repoP2]);
  const entryP2_1 = activeMergeQuarantineFor(repoP2);
  check("(P2 precondition) repoP2 is quarantined fail-closed after boot 1", !!entryP2_1);
  check("(P2 precondition) the entry carries the orphan filename", (entryP2_1?.orphanLatchFiles ?? []).includes(path.basename(orphanPathP2)));
  const idP2 = quarantineLatchIdFor(repoP2);
  const ownLatchPathP2 = path.join(MERGE_QUARANTINE_DIR, `${idP2}.json`);
  check("(P2 precondition) repoP2's own latch file exists on disk", fs.existsSync(ownLatchPathP2));

  fs.rmSync(repoP2, { recursive: true, force: true });
  check("(P2 precondition) repoP2 no longer resolves on disk at all", !fs.existsSync(repoP2));

  const childScriptP2 = `
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, clearMergeQuarantineByRecordedPath } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]); // repoP2 is no longer registered
    const entry = activeMergeQuarantineFor(${JSON.stringify(repoP2)});
    const clearResult = clearMergeQuarantineByRecordedPath(${JSON.stringify(repoP2)});
    process.stdout.write(JSON.stringify({
      entryOrphanLatchFiles: entry?.orphanLatchFiles ?? null,
      entryResolvedKey: entry?.resolvedKey ?? null,
      clearResult,
    }));
  `;
  const childOutP2 = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptP2], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  // Same stdout-sharing caveat as (P) above — take only the last line.
  const resultP2 = JSON.parse(childOutP2.trim().split("\n").pop());

  check("(P2 precondition, child boot 2) repoP2 is reported via the PENDING lazy-resolve", resultP2.entryResolvedKey === null);
  check("(P2 precondition, child boot 2) the PENDING entry still carries the orphan filename forward", (resultP2.entryOrphanLatchFiles ?? []).includes(path.basename(orphanPathP2)));
  check("(P2) clearing the pending entry by repoPath (in the child) reports wasQuarantined:true", resultP2.clearResult?.wasQuarantined === true);
  check("(P2) the pending entry's OWN latch/source file is gone", !fs.existsSync(ownLatchPathP2));
  check("(P2) THE FIX: clearMergeQuarantineByRecordedPath's own pending branch also sweeps the orphan latch file", !fs.existsSync(orphanPathP2));
}

// ===================== (P-SHARED) an orphan file referenced by BOTH a pending and an active entry survives clearing EITHER one alone, and is swept once BOTH are cleared (card 6237bef6) =====================
// Exercises the shared `sweepOrphanLatchFileIfUnreferenced` helper's own "still referenced" check across
// BOTH structures, in both orders. Also closes a quieter, narrower sibling of the traced bug: the
// PRE-EXISTING active-entry sweep used to check only `activeQuarantines`, so clearing the active side
// alone (sub-case B) would, pre-fix, have deleted a file a PENDING entry still needed.
{
  // Sub-case A: clear the PENDING side first, then the ACTIVE side.
  const repoActiveA = freshDir("repoActiveA");
  const pendingPathA = path.join(os.tmpdir(), `loom-mqcbp-pendingA-${sfx}`); // deliberately never created
  const orphanSharedA = path.join(MERGE_QUARANTINE_DIR, `orphan-shared-a-${sfx}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(orphanSharedA, "{}\n"); // the shared file itself — content irrelevant, only existence matters here
  check("(P-SHARED A precondition) neither repoActiveA's own latch nor pendingPathA exist yet", !fs.existsSync(pendingPathA));

  const activeKeyA = canonicalRepoLockKey(repoActiveA);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(activeKeyA)}.json`), JSON.stringify({
    repoPath: repoActiveA, branch: "shared-orphan-active-a", reason: "P-SHARED A — active side",
    enteredAt: Date.now(), tokens: ["t-active-a"], resolvedKey: activeKeyA,
    orphanLatchFiles: [path.basename(orphanSharedA)],
  }, null, 2) + "\n");
  const pendingSourceA = `pending-shared-a-${sfx}.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingSourceA), JSON.stringify({
    repoPath: pendingPathA, branch: "shared-orphan-pending-a", reason: "P-SHARED A — pending side",
    enteredAt: Date.now(), tokens: ["t-pending-a"],
    orphanLatchFiles: [path.basename(orphanSharedA)],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([repoActiveA]);
  check("(P-SHARED A precondition) the active entry loaded with the shared orphan reference", (activeMergeQuarantineFor(repoActiveA)?.orphanLatchFiles ?? []).includes(path.basename(orphanSharedA)));
  check("(P-SHARED A precondition) the pending entry loaded too (unresolvable path)", listActiveMergeQuarantines().some((e) => e.repoPath === pendingPathA && (e.orphanLatchFiles ?? []).includes(path.basename(orphanSharedA))));

  // Clear the PENDING side alone (also exercises site 3, clearMergeQuarantineByRecordedPath, again).
  clearMergeQuarantineByRecordedPath(pendingPathA);
  check("(P-SHARED A) the pending entry is gone", !listActiveMergeQuarantines().some((e) => e.repoPath === pendingPathA));
  check("(P-SHARED A) the shared orphan file SURVIVES — the active entry still references it", fs.existsSync(orphanSharedA));

  // Now clear the ACTIVE side too — nothing references the orphan file any more.
  clearMergeQuarantine(repoActiveA);
  check("(P-SHARED A) the active entry is gone", !activeMergeQuarantineFor(repoActiveA));
  check("(P-SHARED A) THE FIX: the shared orphan file is now swept once BOTH referencing entries are cleared", !fs.existsSync(orphanSharedA));

  // Sub-case B: the REVERSE order — clear the ACTIVE side first, then the PENDING side. Also proves the
  // pre-existing active-path sweep no longer ignores a surviving PENDING reference (the narrower sibling
  // bug this card's shared helper also closes).
  const repoActiveB = freshDir("repoActiveB");
  const pendingPathB = path.join(os.tmpdir(), `loom-mqcbp-pendingB-${sfx}`);
  const orphanSharedB = path.join(MERGE_QUARANTINE_DIR, `orphan-shared-b-${sfx}.json`);
  fs.writeFileSync(orphanSharedB, "{}\n");

  const activeKeyB = canonicalRepoLockKey(repoActiveB);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(activeKeyB)}.json`), JSON.stringify({
    repoPath: repoActiveB, branch: "shared-orphan-active-b", reason: "P-SHARED B — active side",
    enteredAt: Date.now(), tokens: ["t-active-b"], resolvedKey: activeKeyB,
    orphanLatchFiles: [path.basename(orphanSharedB)],
  }, null, 2) + "\n");
  const pendingSourceB = `pending-shared-b-${sfx}.json`;
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pendingSourceB), JSON.stringify({
    repoPath: pendingPathB, branch: "shared-orphan-pending-b", reason: "P-SHARED B — pending side",
    enteredAt: Date.now(), tokens: ["t-pending-b"],
    orphanLatchFiles: [path.basename(orphanSharedB)],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([repoActiveB]);
  check("(P-SHARED B precondition) both entries loaded with the shared orphan reference", (activeMergeQuarantineFor(repoActiveB)?.orphanLatchFiles ?? []).includes(path.basename(orphanSharedB)) &&
    listActiveMergeQuarantines().some((e) => e.repoPath === pendingPathB && (e.orphanLatchFiles ?? []).includes(path.basename(orphanSharedB))));

  // Clear the ACTIVE side alone FIRST this time.
  clearMergeQuarantine(repoActiveB);
  check("(P-SHARED B) the active entry is gone", !activeMergeQuarantineFor(repoActiveB));
  check("(P-SHARED B) THE NARROWER SIBLING BUG: the shared orphan file SURVIVES — a PENDING entry still references it", fs.existsSync(orphanSharedB));

  clearMergeQuarantineByRecordedPath(pendingPathB);
  check("(P-SHARED B) the pending entry is gone", !listActiveMergeQuarantines().some((e) => e.repoPath === pendingPathB));
  check("(P-SHARED B) THE FIX: the shared orphan file is now swept once BOTH referencing entries are cleared", !fs.existsSync(orphanSharedB));
}

// ===================== (P-MULTI) clearMergeQuarantineLatchFile drops EVERY pending entry sharing one id, not just the first found (card 6237bef6, round 2, item 1 — BLOCKING) =====================
// PASS 1 (a `.json` final) and PASS 1b (a `.json.tmp-<pid>` residue) both independently defer an
// unresolvable, no-resolvedKey entry to `pendingUnresolvedQuarantines` — so ONE unresolvable repo can end
// up with SEVERAL distinct pending entries that all share the SAME hash/id (its own final plus a tmp, or
// two tmps left by two interrupted writes). The pre-fix code used a plain `for...of` loop with an early
// `return` on the FIRST match, so clearing by that shared id dropped only one of them: the repo stayed
// blocked, the sibling file survived on disk, and it re-quarantined the repo on the next boot. Fixed:
// collect EVERY matching pending entry via `.filter(...)`, drop them all, sweep each one's own
// sourceFile + orphanLatchFiles, same "drop every one" rule abccee85 r6 already applies elsewhere.
{
  // Sub-case A: a FINAL (`.json`) and a TMP (`.json.tmp-<pid>`) residue, same id, same unresolvable repo.
  const repoMultiA = path.join(os.tmpdir(), `loom-mqcbp-multiA-${sfx}`); // deliberately never created
  const idMultiA = "aaaa11112222333344445555";
  const finalPathMultiA = path.join(MERGE_QUARANTINE_DIR, `${idMultiA}.json`);
  const tmpPathMultiA = path.join(MERGE_QUARANTINE_DIR, `${idMultiA}.json.tmp-111111`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(finalPathMultiA, JSON.stringify({
    repoPath: repoMultiA, branch: "multi-a-final-branch", reason: "P-MULTI A — final, no resolvedKey",
    enteredAt: Date.now(), tokens: ["t-multi-a-final"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmpPathMultiA, JSON.stringify({
    repoPath: repoMultiA, branch: "multi-a-tmp-branch", reason: "P-MULTI A — tmp, no resolvedKey",
    enteredAt: Date.now(), tokens: ["t-multi-a-tmp"],
  }, null, 2) + "\n");

  const childScriptMultiA = `
    const { reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, clearMergeQuarantineLatchFile } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    const beforeCount = listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiA)}).length;
    const clearResult = clearMergeQuarantineLatchFile(${JSON.stringify(idMultiA)});
    const afterCount = listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiA)}).length;
    process.stdout.write(JSON.stringify({ beforeCount, clearResult, afterCount }));
  `;
  const outMultiA = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptMultiA], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultMultiA = JSON.parse(outMultiA.trim().split("\n").pop());

  check("(P-MULTI A precondition) boot 1 produced TWO distinct pending entries sharing one id (the final AND the tmp)", resultMultiA.beforeCount === 2);
  check("(P-MULTI A) ONE clear-by-id reports ok:true, wasQuarantined:true", resultMultiA.clearResult?.ok === true && resultMultiA.clearResult?.wasQuarantined === true);
  check("(P-MULTI A) THE FIX: that ONE clear drops BOTH pending entries, not just the first found", resultMultiA.afterCount === 0);
  check("(P-MULTI A) the final file is gone from disk", !fs.existsSync(finalPathMultiA));
  check("(P-MULTI A) the tmp file is ALSO gone from disk — never left behind to re-quarantine the next boot", !fs.existsSync(tmpPathMultiA));

  const childScriptMultiABoot2 = `
    const { reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    process.stdout.write(JSON.stringify({ count: listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiA)}).length }));
  `;
  const outMultiABoot2 = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptMultiABoot2], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  check("(P-MULTI A) a SEPARATE boot 2 lists NOTHING for this repo — no resurrection", JSON.parse(outMultiABoot2.trim().split("\n").pop()).count === 0);

  // Sub-case B: TWO tmp residues (no final at all), same id, same unresolvable repo.
  const repoMultiB = path.join(os.tmpdir(), `loom-mqcbp-multiB-${sfx}`); // deliberately never created
  const idMultiB = "bbbb11112222333344445555";
  const tmpPathMultiB1 = path.join(MERGE_QUARANTINE_DIR, `${idMultiB}.json.tmp-222222`);
  const tmpPathMultiB2 = path.join(MERGE_QUARANTINE_DIR, `${idMultiB}.json.tmp-333333`);
  fs.writeFileSync(tmpPathMultiB1, JSON.stringify({
    repoPath: repoMultiB, branch: "multi-b-tmp1-branch", reason: "P-MULTI B — tmp 1, no resolvedKey",
    enteredAt: Date.now(), tokens: ["t-multi-b-tmp1"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmpPathMultiB2, JSON.stringify({
    repoPath: repoMultiB, branch: "multi-b-tmp2-branch", reason: "P-MULTI B — tmp 2, no resolvedKey",
    enteredAt: Date.now(), tokens: ["t-multi-b-tmp2"],
  }, null, 2) + "\n");

  const childScriptMultiB = `
    const { reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, clearMergeQuarantineLatchFile } =
      await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    const beforeCount = listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiB)}).length;
    const clearResult = clearMergeQuarantineLatchFile(${JSON.stringify(idMultiB)});
    const afterCount = listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiB)}).length;
    process.stdout.write(JSON.stringify({ beforeCount, clearResult, afterCount }));
  `;
  const outMultiB = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptMultiB], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultMultiB = JSON.parse(outMultiB.trim().split("\n").pop());

  check("(P-MULTI B precondition) boot 1 produced TWO distinct pending entries sharing one id (two tmps, no final)", resultMultiB.beforeCount === 2);
  check("(P-MULTI B) ONE clear-by-id reports ok:true, wasQuarantined:true", resultMultiB.clearResult?.ok === true && resultMultiB.clearResult?.wasQuarantined === true);
  check("(P-MULTI B) THE FIX: that ONE clear drops BOTH pending entries, not just the first found", resultMultiB.afterCount === 0);
  check("(P-MULTI B) the first tmp file is gone from disk", !fs.existsSync(tmpPathMultiB1));
  check("(P-MULTI B) the second tmp file is ALSO gone from disk", !fs.existsSync(tmpPathMultiB2));

  const childScriptMultiBBoot2 = `
    const { reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([]);
    process.stdout.write(JSON.stringify({ count: listActiveMergeQuarantines().filter((e) => e.repoPath === ${JSON.stringify(repoMultiB)}).length }));
  `;
  const outMultiBBoot2 = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptMultiBBoot2], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  check("(P-MULTI B) a SEPARATE boot 2 lists NOTHING for this repo — no resurrection", JSON.parse(outMultiBBoot2.trim().split("\n").pop()).count === 0);
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
  // .trim().split("\n").pop() — card 883e29bc round 4: clearMergeQuarantineByRecordedPath's pending
  // branch now routes its sourceFile delete through sweepOwnLatchFileUnlessOwnedElsewhere, which LOGS on
  // a successful delete (unlike the old bare, silent unlink) — stdout is no longer pure JSON.
  const resultQ = JSON.parse(childOutQ.trim().split("\n").pop());

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
  // .trim().split("\n").pop() — same reason as (Q) above.
  const resultT = JSON.parse(childOutT.trim().split("\n").pop());

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

// ===================== (Y) sweepOrphanLatchFileIfUnreferenced — never delete a filename a SURVIVING entry has since legitimately reclaimed as its own physical latch (card 9cabd143) =====================
// A corrupt/unparsable orphan at boot is fanned into every OTHER registered repo's orphanLatchFiles — but
// that filename is just `<hash-of-some-repo's-own-key>.json`. If that repo gets registered LATER and
// raises a real quarantine in-process, its durable write legitimately lands at that SAME deterministic
// filename, overwriting the stale debris with live, real data. The old sweep only checked whether some
// OTHER entry's own orphanLatchFiles still referenced the filename — never whether the filename IS itself
// a surviving entry's own current physical latch — so clearing the repo that still remembers it as an
// orphan deleted the file out from under the repo that now genuinely owns it. No real SHA-256 collision
// is needed: the "orphan" and the "live owner" are the SAME repo's own deterministic filename, at two
// different points in time.
{
  const repoY_B = freshDir("repoY-B"); // the repo whose own deterministic filename becomes the "orphan"
  const hashY_B = quarantineLatchIdFor(repoY_B); // computed BEFORE anything is ever written for it
  const latchPathY_B = path.join(MERGE_QUARANTINE_DIR, `${hashY_B}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(latchPathY_B, "{not valid json — pre-registration debris for Y}");
  check("(Y precondition) corrupt debris exists under repoY_B's own deterministic hash", fs.existsSync(latchPathY_B));

  const repoY_A = freshDir("repoY-A"); // registered at THIS boot — the debris fans into its own entry
  reenterMergeQuarantinesAtBoot([repoY_A]); // repoY_B deliberately excluded — "not registered yet"
  const entryY_A = activeMergeQuarantineFor(repoY_A);
  check("(Y precondition) repoY_A is quarantined fail-closed after boot", !!entryY_A);
  check("(Y precondition) repoY_A's entry carries repoY_B's own filename as an orphan reference", (entryY_A?.orphanLatchFiles ?? []).includes(`${hashY_B}.json`));
  check("(Y precondition) the file on disk is STILL the corrupt debris — PASS 2 never overwrites an orphan it merely references", fs.readFileSync(latchPathY_B, "utf8").startsWith("{not valid json"));

  // repoY_B gets registered "after boot" and raises a REAL quarantine — its own legitimate write lands at
  // the SAME deterministic filename, overwriting the debris with real, live data.
  enterMergeQuarantine(repoY_B, "real-branch-y-b", "raised AFTER boot, post-registration (Y)");
  check("(Y precondition) repoY_B's own file now holds REAL, valid JSON", JSON.parse(fs.readFileSync(latchPathY_B, "utf8")).repoPath === repoY_B);
  check("(Y precondition) repoY_B is genuinely quarantined in-process right now", !!activeMergeQuarantineFor(repoY_B));

  // THE KEY CHECK (step 4): clearing repoY_A sweeps its own orphanLatchFiles, including repoY_B's
  // filename. This is the exact assertion the manager asked to see go RED on unfixed code — see the
  // negative-control proof reported alongside this card's `done` report (packages/daemon/src/git/
  // merge-quarantine.ts reverted to HEAD, this file run, confirmed FAIL on this line; restored, confirmed
  // PASS) rather than re-deriving a revert cycle from inside this file.
  clearMergeQuarantine(repoY_A);
  check("(Y) repoY_A is cleared", !activeMergeQuarantineFor(repoY_A));
  check("(Y) THE FIX (step 4): repoY_B's own live latch file SURVIVES — it is NOT deleted as a stale orphan", fs.existsSync(latchPathY_B));
  check("(Y) and repoY_B's in-memory quarantine is untouched by clearing the unrelated repoY_A", !!activeMergeQuarantineFor(repoY_B));

  // Prove the CONSEQUENCE, not just the file-survival proxy: a GENUINELY fresh boot (separate child
  // process — same technique as (P)'s own GOTCHA note above explains why this can't be simulated
  // in-process) must still find repoY_B quarantined. On pre-fix code this is exactly where "fails open"
  // shows up: the file is gone, so a real restart silently drops the quarantine.
  const childScriptY = `
    const { reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([${JSON.stringify(repoY_A)}, ${JSON.stringify(repoY_B)}]);
    const entry = activeMergeQuarantineFor(${JSON.stringify(repoY_B)});
    process.stdout.write(JSON.stringify({ stillQuarantined: !!entry, reason: entry?.reason ?? null }));
  `;
  const childOutY = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptY], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultY = JSON.parse(childOutY.trim().split("\n").pop());
  check("(Y) THE CONSEQUENCE, PROVEN ACROSS A REAL RESTART: a genuinely fresh boot still finds repoY_B quarantined — the fix closes the fail-open window", resultY.stillQuarantined === true);
  check("(Y) and it's the REAL raise that survived, not a fail-closed placeholder standing in for lost data", resultY.reason === "raised AFTER boot, post-registration (Y)");

  clearMergeQuarantine(repoY_B);
  check("(Y cleanup) repoY_B is cleared for real", !activeMergeQuarantineFor(repoY_B));
}

// ===================== (Z1) clearMergeQuarantineLatchFile's RAW-FALLBACK branch no longer bypasses the orphan-reference check (card 9cabd143, triage note) =====================
// Found during review of 6237bef6 round 2 (d449dff8): the raw-fallback branch (reached when NO in-memory
// entry anywhere matches `id`) unlinked `<id>.json` directly, bypassing sweepOrphanLatchFileIfUnreferenced
// entirely — including its PRE-EXISTING orphanLatchFiles check, not just card 9cabd143's new one. Two
// SEPARATE registered repos both reference the same corrupt orphan; clearing it BY ID must not delete it
// while either one still references it, and must report `latchKept` rather than a bare `ok:true`.
{
  const repoZ1_C1 = freshDir("repoZ1-C1");
  const repoZ1_C2 = freshDir("repoZ1-C2");
  const repoZ1_Ghost = freshDir("repoZ1-Ghost"); // never registered, never raised — just donates its own hash
  const hashZ1_Ghost = quarantineLatchIdFor(repoZ1_Ghost);
  const latchPathZ1_Ghost = path.join(MERGE_QUARANTINE_DIR, `${hashZ1_Ghost}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(latchPathZ1_Ghost, "{not valid json — Z1 ghost debris");
  check("(Z1 precondition) the ghost's corrupt debris exists", fs.existsSync(latchPathZ1_Ghost));

  reenterMergeQuarantinesAtBoot([repoZ1_C1, repoZ1_C2]); // ghost excluded — fans into BOTH registered repos
  check("(Z1 precondition) BOTH registered repos reference the ghost's filename", (activeMergeQuarantineFor(repoZ1_C1)?.orphanLatchFiles ?? []).includes(`${hashZ1_Ghost}.json`)
    && (activeMergeQuarantineFor(repoZ1_C2)?.orphanLatchFiles ?? []).includes(`${hashZ1_Ghost}.json`));
  check("(Z1 precondition) clearing by the ghost's id hits the RAW-FALLBACK branch — nothing in-memory matches repoZ1_Ghost itself", !listActiveMergeQuarantines().some((e) => e.repoPath === repoZ1_Ghost));

  const clearZ1 = clearMergeQuarantineLatchFile(hashZ1_Ghost);
  check("(Z1) clearing by id reports ok:true", clearZ1.ok === true);
  check("(Z1) THE FIX: the file is KEPT (not silently deleted) while repoZ1_C1/C2 still reference it", clearZ1.ok === true && clearZ1.latchKept === true);
  check("(Z1) the result names BOTH referencing repoPaths", clearZ1.ok === true && clearZ1.referencingRepoPaths?.includes(repoZ1_C1) && clearZ1.referencingRepoPaths?.includes(repoZ1_C2));
  check("(Z1) the file genuinely SURVIVES on disk", fs.existsSync(latchPathZ1_Ghost));

  // Positive control: this is NOT "never delete" — once nothing references it, it's swept for real.
  clearMergeQuarantine(repoZ1_C1);
  check("(Z1) still survives with ONE referencing repo left", fs.existsSync(latchPathZ1_Ghost));
  clearMergeQuarantine(repoZ1_C2);
  check("(Z1) POSITIVE CONTROL: once BOTH referencing repos are cleared, the file is finally swept for real", !fs.existsSync(latchPathZ1_Ghost));
}

// ===================== (Z1-route) POST /internal/merge-quarantine/clear-by-path {id} forwards latchKept/referencingRepoPaths over REAL HTTP (card 9cabd143, Round 2 item 5) =====================
// (Z1) proves the underlying function; this proves the gateway route actually forwards the new fields on
// its JSON response, not just that the function itself carries them.
{
  const repoZ1R_C1 = freshDir("repoZ1R-C1");
  const repoZ1R_Ghost = freshDir("repoZ1R-Ghost"); // never registered, never raised — donates its own hash
  const hashZ1R_Ghost = quarantineLatchIdFor(repoZ1R_Ghost);
  const latchPathZ1R_Ghost = path.join(MERGE_QUARANTINE_DIR, `${hashZ1R_Ghost}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(latchPathZ1R_Ghost, "{not valid json — Z1-route ghost debris");

  reenterMergeQuarantinesAtBoot([repoZ1R_C1]);
  check("(Z1-route precondition) repoZ1R_C1 references the ghost's filename", (activeMergeQuarantineFor(repoZ1R_C1)?.orphanLatchFiles ?? []).includes(`${hashZ1R_Ghost}.json`));

  const TMPZ1R = mkdtempManaged("loom-mqcbp-gw-z1r-");
  const PORTZ1R = 47100 + (process.pid % 400);
  const HZ1R = { host: `127.0.0.1:${PORTZ1R}`, origin: `http://127.0.0.1:${PORTZ1R}`, "content-type": "application/json" };
  const dbZ1R = new Db(path.join(TMPZ1R, "loom.db"));
  const stubZ1R = {};
  const appZ1R = await buildServer({
    db: dbZ1R, pty: stubZ1R, sessions: stubZ1R, mcp: stubZ1R, orchMcp: stubZ1R, platformMcp: stubZ1R, auditMcp: stubZ1R,
    userAuditMcp: stubZ1R, setupMcp: stubZ1R, runMcp: stubZ1R, control: stubZ1R, usageStatus: stubZ1R,
  });
  try {
    const clearZ1R = await appZ1R.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HZ1R, payload: { id: hashZ1R_Ghost } });
    check("(Z1-route) POST /clear-by-path {id} (still-referenced ghost) → 200", clearZ1R.statusCode === 200);
    const bodyZ1R = clearZ1R.json();
    check("(Z1-route) ok:true", bodyZ1R.ok === true);
    check("(Z1-route) THE FIX (item 5): the route forwards latchKept:true", bodyZ1R.latchKept === true);
    check("(Z1-route) the route forwards referencingRepoPaths naming repoZ1R_C1", Array.isArray(bodyZ1R.referencingRepoPaths) && bodyZ1R.referencingRepoPaths.includes(repoZ1R_C1));
    check("(Z1-route) the file genuinely survives on disk", fs.existsSync(latchPathZ1R_Ghost));

    // Negative control on the SAME route: once nothing references it, latchKept is OMITTED, not false.
    clearMergeQuarantine(repoZ1R_C1);
    const corruptIdZ1R = "fade0000fade0000fade0000"; // 24 hex — never derived from any real entry
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${corruptIdZ1R}.json`), "{not valid json — unreferenced");
    const clearZ1R_unreferenced = await appZ1R.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HZ1R, payload: { id: corruptIdZ1R } });
    check("(Z1-route) NEGATIVE CONTROL: clearing a genuinely unreferenced corrupt latch → 200", clearZ1R_unreferenced.statusCode === 200);
    const bodyZ1R_unreferenced = clearZ1R_unreferenced.json();
    check("(Z1-route) NEGATIVE CONTROL: latchKept is OMITTED (not present, not false) when the file is genuinely gone", !("latchKept" in bodyZ1R_unreferenced));
    check("(Z1-route) NEGATIVE CONTROL: the file is actually deleted", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${corruptIdZ1R}.json`)));
  } finally {
    await appZ1R.close();
    dbZ1R.close();
  }
}

// ===================== (Z2) clearMergeQuarantineLatchFile's PENDING-MATCH branch deletes a CLEARED entry's own file even when an unrelated SURVIVING entry's orphanLatchFiles still lists it (card 9cabd143, Round 2 item 1 — BLOCKING, Code Review d37fd1aa of 627293b7) =====================
// RE-POINTED from its original form (round 1 — see this card's own decision record for the full
// correction): clearing a PENDING entry by id must delete its OWN file regardless of whether some OTHER
// entry's orphanLatchFiles merely LISTS that filename (check 1) — only another SURVIVING entry's genuine
// physical OWNERSHIP of that exact filename (check 2) may keep it. The entry being cleared OWNS this
// file; a stale cross-reference from an unrelated entry is never a reason to keep it, or the cleared
// quarantine RE-ARMS on restart while /clear and /clear-by-path {repoPath} (unconditional for an entry's
// own sourceFile) genuinely clear it — all three address forms must agree. Hand-written fixtures (same
// technique as sections (Q)/(S)/(T)/(U) above), fully in-process for the clear itself, then a GENUINELY
// separate child-process boot (same rigor as (Y)) proving the clear actually STICKS.
{
  const hashZ2_H = "cccc11112222333344445555"; // made-up 24-hex id — never derived from a real repoPath
  const repoZ2_H = path.join(os.tmpdir(), `loom-mqcbp-pendingZ2H-${sfx}`); // deliberately never created
  const latchPathZ2_H = path.join(MERGE_QUARANTINE_DIR, `${hashZ2_H}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(latchPathZ2_H, JSON.stringify({
    repoPath: repoZ2_H, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: "Z2 pending fixture — never resolvable", enteredAt: Date.now(), tokens: ["t-z2-h"],
  }, null, 2) + "\n");

  const repoZ2_C3 = freshDir("repoZ2-C3"); // its own ACTIVE latch, hand-written with a STALE cross-reference
  const keyZ2_C3 = canonicalRepoLockKey(repoZ2_C3);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(keyZ2_C3)}.json`), JSON.stringify({
    repoPath: repoZ2_C3, branch: "z2-c3-branch", reason: "Z2 — active side merely REFERENCING the pending id's own file",
    enteredAt: Date.now(), tokens: ["t-z2-c3"], resolvedKey: keyZ2_C3,
    orphanLatchFiles: [`${hashZ2_H}.json`], // check (1) only — repoZ2_C3 does NOT own this filename (check 2)
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([repoZ2_C3]);
  check("(Z2 precondition) repoZ2_H loaded as a PENDING entry", listActiveMergeQuarantines().some((e) => e.repoPath === repoZ2_H));
  check("(Z2 precondition) repoZ2_C3 loaded ACTIVE, referencing (not owning) the pending entry's own filename", (activeMergeQuarantineFor(repoZ2_C3)?.orphanLatchFiles ?? []).includes(`${hashZ2_H}.json`));
  check("(Z2 precondition) repoZ2_C3's OWN physical latch is a DIFFERENT file — it does not own hashZ2_H's filename", `${hashKey(keyZ2_C3)}.json` !== `${hashZ2_H}.json`);

  const clearZ2 = clearMergeQuarantineLatchFile(hashZ2_H);
  check("(Z2) clearing by id reports ok:true, wasQuarantined:true (the pending entry matched)", clearZ2.ok === true && clearZ2.wasQuarantined === true);
  check("(Z2) THE FIX (item 1): NOT kept — a mere orphanLatchFiles reference from repoZ2_C3 never blocks deleting the cleared entry's OWN file", clearZ2.ok === true && clearZ2.latchKept === undefined);
  check("(Z2) the pending entry itself is gone", !listActiveMergeQuarantines().some((e) => e.repoPath === repoZ2_H));
  check("(Z2) the file is genuinely DELETED from disk", !fs.existsSync(latchPathZ2_H));
  check("(Z2) repoZ2_C3's own, unrelated active entry is UNTOUCHED by clearing hashZ2_H", !!activeMergeQuarantineFor(repoZ2_C3));

  // THE CONSEQUENCE, PROVEN ACROSS A REAL RESTART: a genuinely fresh boot must NOT re-arm repoZ2_H as
  // pending (its own source file is gone — nothing left to re-parse), while repoZ2_C3's real, independent
  // quarantine survives untouched (its own stale orphanLatchFiles reference is harmless bookkeeping, never
  // re-resurrects anything).
  const childScriptZ2 = `
    const { reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, activeMergeQuarantineFor } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    reenterMergeQuarantinesAtBoot([${JSON.stringify(repoZ2_C3)}]);
    process.stdout.write(JSON.stringify({
      repoZ2_H_stillPresent: listActiveMergeQuarantines().some((e) => e.repoPath === ${JSON.stringify(repoZ2_H)}),
      repoZ2_C3_stillActive: !!activeMergeQuarantineFor(${JSON.stringify(repoZ2_C3)}),
    }));
  `;
  const childOutZ2 = execFileSync(process.execPath, ["--input-type=module", "-e", childScriptZ2], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  const resultZ2 = JSON.parse(childOutZ2.trim().split("\n").pop());
  check("(Z2) THE CONSEQUENCE: a genuinely fresh boot does NOT re-arm repoZ2_H — the clear by id genuinely stuck", resultZ2.repoZ2_H_stillPresent === false);
  check("(Z2) and repoZ2_C3's own, unrelated real quarantine is unaffected by the restart too", resultZ2.repoZ2_C3_stillActive === true);

  clearMergeQuarantine(repoZ2_C3);
  check("(Z2 cleanup) repoZ2_C3 is cleared for real", !activeMergeQuarantineFor(repoZ2_C3));
}

// ===================== (AA) physicalOwnerRepoPaths's PENDING half — a reachable scenario, not just a defensive arm (card 9cabd143, Round 2 item 4) =====================
// Unlike check (2)'s pending half inside clearMergeQuarantineLatchFile's OWN pending-match branch (where
// it is PROVABLY unreachable — see the decision record), sweepOrphanLatchFileIfUnreferenced's ordinary
// callers (clearMergeQuarantineByKey / clearMergeQuarantineByRecordedPath, clearing an entry's OWN
// orphanLatchFiles REFERENCES) genuinely reach it: a pending entry P's own sourceFile protects it when a
// SEPARATE, surviving entry references that exact filename and THAT entry (not P) is the one cleared.
{
  const hashAA_P = "dddd11112222333344445555"; // made-up 24-hex filename — P's own sourceFile lives here
  const repoAA_P = path.join(os.tmpdir(), `loom-mqcbp-pendingAA-${sfx}`); // deliberately never created
  const latchPathAA_P = path.join(MERGE_QUARANTINE_DIR, `${hashAA_P}.json`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(latchPathAA_P, JSON.stringify({
    repoPath: repoAA_P, branch: "(unknown — boot could not resolve which repo/branch this protects)",
    reason: "AA — pending entry P, genuinely owns hashAA_P's own filename", enteredAt: Date.now(), tokens: ["t-aa-p"],
  }, null, 2) + "\n");

  const repoAA_Q = freshDir("repoAA-Q"); // a SEPARATE active entry that merely REFERENCES P's own filename
  const keyAA_Q = canonicalRepoLockKey(repoAA_Q);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(keyAA_Q)}.json`), JSON.stringify({
    repoPath: repoAA_Q, branch: "aa-q-branch", reason: "AA — references P's own filename as an orphan",
    enteredAt: Date.now(), tokens: ["t-aa-q"], resolvedKey: keyAA_Q,
    orphanLatchFiles: [`${hashAA_P}.json`],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([repoAA_Q]);
  check("(AA precondition) repoAA_P loaded as a PENDING entry", listActiveMergeQuarantines().some((e) => e.repoPath === repoAA_P));
  check("(AA precondition) repoAA_Q loaded ACTIVE, referencing P's own filename", (activeMergeQuarantineFor(repoAA_Q)?.orphanLatchFiles ?? []).includes(`${hashAA_P}.json`));

  // Clear repoAA_Q (NOT P) — its own orphanLatchFiles sweep reaches sweepOrphanLatchFileIfUnreferenced,
  // which must find P's own sourceFile match (check 2's pending half) and keep the file.
  clearMergeQuarantine(repoAA_Q);
  check("(AA) repoAA_Q is cleared", !activeMergeQuarantineFor(repoAA_Q));
  check("(AA) THE FIX (item 4): P's own file SURVIVES — check (2)'s pending half protects it from a mere orphanLatchFiles reference elsewhere", fs.existsSync(latchPathAA_P));
  check("(AA) P's own pending entry is still intact", listActiveMergeQuarantines().some((e) => e.repoPath === repoAA_P));

  // Positive control: clearing P itself (its OWN file, via /clear-by-path {repoPath}) still works normally.
  clearMergeQuarantineByRecordedPath(repoAA_P);
  check("(AA) POSITIVE CONTROL: clearing P itself still deletes its own file normally", !fs.existsSync(latchPathAA_P));
}

// ===================== (AB) physicalOwnerRepoPaths's active-entry half ALSO covers the TRUE current write target, not only armedKeys (card 9cabd143, Round 2 item 3) =====================
// An entry's armedKeys can go STALE relative to its current key after a drift (card abccee85) — e.g. a
// repo raised BEFORE an enclosing .git existed, keyed to itself, then an enclosing .git appears nearby
// and canonicalRepoLockKey(repoPath) now resolves differently, WITHOUT anything re-arming the already-live
// entry under the new key. writeMergeQuarantineLatch always targets the FRESH key, never a stale armed
// one, so checking only armedKeys can miss the filename a NEXT write to this entry would actually land on.
{
  const parentAB = freshDir("repoAB-parent");
  const repoAB_E = path.join(parentAB, "repo");
  fs.mkdirSync(repoAB_E, { recursive: true });
  enterMergeQuarantine(repoAB_E, "branch-ab-e", "AB — E raised BEFORE the enclosing git exists");
  const keyE1 = canonicalRepoLockKey(repoAB_E);
  const latchPathE1 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(keyE1)}.json`);
  check("(AB precondition) E's own latch exists under its pre-drift key", fs.existsSync(latchPathE1));

  fs.mkdirSync(path.join(parentAB, ".git"), { recursive: true }); // the drift — parentAB becomes E's new toplevel
  const keyE2 = canonicalRepoLockKey(repoAB_E);
  check("(AB precondition) E's key actually changed after the drift", keyE2 !== keyE1);

  // Remove E's own (now-stale-key) file so the reboot below (which scans the WHOLE shared quarantine dir)
  // never rediscovers and auto-migrates it — that would re-arm E under keyE2 too, defeating this test's
  // whole premise (E staying armed ONLY under its stale key keyE1).
  fs.rmSync(latchPathE1, { force: true });
  const latchPathE2 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(keyE2)}.json`); // E's TRUE current write target
  fs.writeFileSync(latchPathE2, "{not valid json — AB marker, simulating content sitting at E's fresh write target");
  check("(AB precondition) a marker sits at E's fresh write target — a filename NONE of E's own armedKeys hash to", fs.existsSync(latchPathE2));

  const repoAB_F = freshDir("repoAB-F");
  reenterMergeQuarantinesAtBoot([repoAB_F]); // repoAB_E deliberately excluded — the marker fans into F as an orphan
  const eEntryAB = listActiveMergeQuarantines().find((e) => e.repoPath === repoAB_E);
  check("(AB precondition) E survived the reboot UNMIGRATED (its own file was gone, nothing to re-scan)", !!eEntryAB);
  check("(AB precondition) E is armed ONLY under its stale key — keyE2 is NOT among its own armedKeys", !(eEntryAB?.armedKeys ?? []).includes(keyE2));
  check("(AB precondition) F is fail-closed, referencing the marker's filename as an orphan", (activeMergeQuarantineFor(repoAB_F)?.orphanLatchFiles ?? []).includes(`${hashKey(keyE2)}.json`));

  // THE KEY CHECK: clearing F sweeps its own orphanLatchFiles, including the marker's filename — which is
  // NOT any of E's own armedKeys, but IS E's TRUE current write target.
  clearMergeQuarantine(repoAB_F);
  check("(AB) F is cleared", !listActiveMergeQuarantines().some((e) => e.repoPath === repoAB_F));
  check("(AB) THE FIX (item 3): the marker SURVIVES — recognized as E's own CURRENT write target, not just its stale armedKeys", fs.existsSync(latchPathE2));
  check("(AB) E's own in-memory entry (still armed only under its stale key) is untouched", listActiveMergeQuarantines().some((e) => e.repoPath === repoAB_E));

  // Cleanup: E was never cleared through the normal path (its own armedKeys are stale) — remove its
  // marker + in-memory presence directly rather than leaving residue for later sections.
  fs.rmSync(latchPathE2, { force: true });
  clearMergeQuarantineByRecordedPath(repoAB_E);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /internal/merge-quarantine/clear-by-path (repoPath AND id addressing, exactly-one-of validation, path-traversal id rejection), GET /internal/merge-quarantine/list (id/registered projection, incl. a dual-armed entry's own id/ids BEFORE it's cleared), the shared clearMergeQuarantineReporting helper (no drift between /clear and /clear-by-path), partitionQuarantinesByRegistration / db.listAllRegisteredRepoPaths (live + multi-repo + archived registration, never swallowing a registered+quarantined repo into the orphan bucket, and a registered-path spelling variant), clearMergeQuarantineLatchFile's round-2/3 fixes, quarantineLatchFileIdsFor's round-3 real-file-first ordering, clearMergeQuarantineByRecordedPath's round-4/5 stored-repoPath-addressed clear (the `{repoPath}` form's own immunity to key drift, clearing every matching active entry, and the pending-fallback drift) and legacyQuarantineHashFor's byte-identical behavior, PLUS round 6's governing-rule fixes — pending entries are matched by stored directPathIdentity, never a freshly re-walked canonicalRepoLockKey, at every site: (T) enterMergeQuarantine's pending-merge no longer adopts an unrelated pending entry's identity for a fresh raise, (U) clearMergeQuarantineByRecordedPath's pending branch drops EVERY identity-matching pending entry, (V) assertRepoNotQuarantined names the BLOCKING entry's own repoPath/latch id and points at /clear-by-path, and (W) partitionQuarantinesByRegistration no longer mis-registers a pending entry via an enclosing repo's key — all behave as designed (cards c0be9bf9, abccee85). Round 7: (X) clearMergeQuarantineByRecordedPath's own last-resort fallback no longer recomputes a fresh key from a never-quarantined (typo'd) given path — it reports not-found instead of collaterally lifting an unrelated enclosing repo's real quarantine. Card 6237bef6: (P)/(P2)/(P-SHARED) turn card abccee85's traced-not-fixed gap into hard, two-way checks — a pending entry's own orphanLatchFiles are now actually swept on clear, at all three pending-removal sites (clearMergeQuarantineByKey, clearMergeQuarantineLatchFile, and clearMergeQuarantineByRecordedPath, the third abccee85 never named), and an orphan file still referenced by a SURVIVING entry (active or pending) is never deleted out from under it. Card 9cabd143: (Y) the sweep never deletes a filename a SURVIVING entry has since legitimately reclaimed as its own live physical latch (proven across a real restart, in a separate child process), (Z1)/(Z1-route) close the SAME gap at clearMergeQuarantineLatchFile's raw-fallback bypass site (over both the function and the real HTTP route), now reporting `latchKept`/`referencingRepoPaths` instead of a bare `ok:true` when a file survives. Round 2 (Code Review d37fd1aa): (Z2) is RE-POINTED — clearing a PENDING entry by id deletes its OWN file even when an unrelated entry's `orphanLatchFiles` merely lists it (check 1 alone must never protect an entry's own file; only genuine ownership, check 2, may), proven to stick across a real child-process restart and to agree with `/clear`/`/clear-by-path {repoPath}`; (AA) proves check (2)'s PENDING-ownership half is genuinely reachable (not just defensive) via the ordinary orphan-reference sweep; (AB) proves check (2)'s ACTIVE-ownership half also covers an entry's TRUE current write target (`quarantinePathFor`), not only its own (possibly stale, post-drift) `armedKeys`."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
