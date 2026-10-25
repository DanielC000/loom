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
  assertRepoNotQuarantined, MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly, reenterMergeQuarantinesAtBootTestOnly,
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

// A REAL reboot — a fresh, second child process, SAME LOOM_HOME, re-scanning the quarantine dir from
// scratch (mirrors merge-quarantine-unresolvable-path.mjs's own `rebootInChildProcess`). Used for a
// DURABILITY claim (card 182c01cc round 3, lesson 203) — an in-process check can never tell "lifted" from
// "lifted only until the next boot re-scans disk". Writes its result to a TEMP FILE rather than stdout:
// the real module can `console.log` (not just `console.error`) during a boot/sweep (e.g. "deleted orphan
// latch ..."), which would otherwise corrupt a stdout-JSON capture.
function rebootInChildProcess(repoPaths, tag) {
  const outFile = path.join(os.tmpdir(), `loom-mqcbp-reboot-out-${tag}-${sfx}.json`);
  const childScript = `
    const fs = (await import("node:fs")).default;
    const { reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined, listActiveMergeQuarantines } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const repoPaths = ${JSON.stringify(repoPaths)};
    const found = reenterMergeQuarantinesAtBoot(repoPaths);
    const refusals = Object.fromEntries(repoPaths.map((p) => [p, assertRepoNotQuarantined(p).ok]));
    const activeForThese = listActiveMergeQuarantines().filter((q) => repoPaths.includes(q.repoPath)).length;
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ foundRepos: found.map((q) => q.repoPath), refusals, activeForThese }));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, LOOM_HOME: loomHome },
  });
  const result = JSON.parse(fs.readFileSync(outFile, "utf8"));
  fs.rmSync(outFile, { force: true });
  return result;
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
//
// @decision 8db913e2 (Follow-up 3152ec90) — a bare, hand-constructed entry object (never actually armed
// anywhere) is no longer valid here: quarantineLatchFileIdsFor now gates every armedKeys member through
// entryStillOwnsKey, so an unarmed synthetic object reports ZERO ids. Arm both synthetic keys for real
// via a single pending latch's own `resolvedKeys` (PASS 1's genuine degraded dual-arm) instead.
{
  const keyNoFile = `/synthetic/sort-check/no-file-${sfx}`;
  const keyHasFile = `/synthetic/sort-check/has-file-${sfx}`;
  const hashNoFile = hashKey(keyNoFile);
  const hashHasFile = hashKey(keyHasFile);
  const d3 = `/synthetic/sort-check/unresolvable-repo-${sfx}`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // repoPath is deliberately a DIFFERENT, foreign-looking identity (never d3 itself — PASS1 treats a
  // final `.json` whose own repoPath IS d3 as a second raise for d3, breaking the dual-arm this fixture
  // needs). Booting below ALSO gives this unresolvable identity its own independent pending entry (see
  // the cleanup note further down) — cleared separately, after d3's own cleanup.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashHasFile}.json`), JSON.stringify({
    repoPath: "/unused/sort-check-fixture", branch: "b", reason: "fixture file for the sort check only",
    enteredAt: Date.now(), tokens: ["unused"],
  }, null, 2) + "\n");
  check("(I3 precondition) the has-file hash's own file exists", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashHasFile}.json`)));
  check("(I3 precondition) the no-file hash's own file does NOT exist", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashNoFile}.json`)));

  const pendingId3 = hashKey(`pending-for-i3-${sfx}`);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `pending-${pendingId3}.json`), JSON.stringify({
    repoPath: d3, branch: "b3", reason: "r", enteredAt: Date.now(), tokens: ["t3"],
    resolvedKeys: [keyNoFile, keyHasFile], // NATURAL insertion order: no-file FIRST, has-file SECOND
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  const realEntry = activeMergeQuarantineFor(d3);
  check("(I3 precondition) d3 is genuinely dual-armed at both synthetic keys", (realEntry?.armedKeys?.length ?? 0) === 2
    && (realEntry?.armedKeys ?? []).includes(keyNoFile) && (realEntry?.armedKeys ?? []).includes(keyHasFile));
  // Card 78fccd3f, item 3: pin the NATURAL (insertion) order itself, not just membership — a future change
  // to boot's own arm order could otherwise make this precondition pass without actually exercising (I3)'s
  // own sort (the thing this fixture exists to isolate).
  check("(I3 precondition) armedKeys' own NATURAL order has the no-file key FIRST, before any sort runs",
    (realEntry?.armedKeys ?? [])[0] === keyNoFile);
  const idsI3 = quarantineLatchFileIdsFor(realEntry);
  check("(I3) THE SORT: the on-disk (has-file) id is returned FIRST despite natural insertion order", idsI3[0] === hashHasFile && idsI3[1] === hashNoFile);

  clearMergeQuarantineByRecordedPath(d3);
  // The fixture file's OWN repoPath ("/unused/sort-check-fixture") is itself unresolvable, so booting
  // above ALSO gave it its own independent pending entry (same sourceFile basename as d3's own keyHasFile
  // final) — d3's clear just above protects-and-rehomes its content (foreignPending in
  // deleteMergeQuarantineLatchByKey) rather than touching it, since it's a genuinely different identity.
  // Clear that identity too, or it leaks into every later section's own listActiveMergeQuarantines() count.
  clearMergeQuarantineByRecordedPath("/unused/sort-check-fixture");
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
  // @decision 2a169469 (round 2) — UPDATED: `stillBlockedEntryFor` now closes THIS exact gap too (finding
  // 3's own "ghost ancestor" shape), so typoX is HONESTLY reported `stillQuarantined` via outer's own
  // ancestor quarantine, never a bare "not found" — this is a MORE complete disclosure than round-7's own
  // fix gave, not a regression of it: the ORIGINAL "never a collateral LIFT" property this scenario exists
  // to prove is the THIRD check below (unchanged, still passing) — nothing here MUTATES outer's own state.
  // `wasQuarantined` stays FALSE (minor 3's own rule, same as a pure contributor on this exact branch):
  // this route genuinely acted on nothing of typoX's own — it never had a record to begin with.
  check("*** THE FIX (round 2) *** clearing a never-quarantined (typo'd) ghost subdirectory now HONESTLY discloses it is still blocked by its real ancestor, never a bare not-found", clearX.wasQuarantined === false && clearX.stillQuarantined === true);
  check("*** THE FIX (round 2) *** the reason names outer as the ancestor blocker", typeof clearX.reason === "string" && clearX.reason.includes(`'${outerX}'`));
  check("(X) outer's genuinely separate, real quarantine is NEVER collaterally LIFTED (the round-7 property, unchanged)", assertRepoNotQuarantined(outerX).ok === false);

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
  // *** THE FIX (round 4, CR3 finding 4) *** — this raw-fallback branch used to hard-code
  // `stillBlockedCoOccupants:[]` even while reporting `latchKept:true` — field-inconsistent with every
  // other clear path in this card. Both referencing repoPaths now get a real `{id}` route too.
  const z1CoC1 = clearZ1.stillBlockedCoOccupants?.find((c) => c.repoPath === repoZ1_C1);
  const z1CoC2 = clearZ1.stillBlockedCoOccupants?.find((c) => c.repoPath === repoZ1_C2);
  check("*** THE FIX (round 4, Z1) *** stillBlockedCoOccupants names BOTH referencing repoPaths", !!z1CoC1 && !!z1CoC2);

  // *** THE FIX (round 5, MAJOR) *** — round 4's own offered `{id}` route was `hashZ1_Ghost` itself, the
  // id this exact clear just acted on: C1/C2 only CROSS-REFERENCE the ghost's file via `orphanLatchFiles`,
  // they do not own it, so that id is a FIXED POINT for them — nothing in memory ever matches it as their
  // OWN identity, and re-clearing it no-ops forever while the repo stays blocked. The working route is
  // each repo's own real latch id instead.
  const ownIdC1 = quarantineLatchFileIdsFor(activeMergeQuarantineFor(repoZ1_C1))[0];
  const ownIdC2 = quarantineLatchFileIdsFor(activeMergeQuarantineFor(repoZ1_C2))[0];
  check("*** THE FIX (round 5, MAJOR) *** C1's offered route id is its OWN latch id, never the ghost's", z1CoC1.route.id === ownIdC1 && z1CoC1.route.id !== hashZ1_Ghost);
  check("*** THE FIX (round 5, MAJOR) *** C2's offered route id is its OWN latch id, never the ghost's", z1CoC2.route.id === ownIdC2 && z1CoC2.route.id !== hashZ1_Ghost);

  // NEGATIVE CONTROL reproducing round 4's own bug: re-clearing the GHOST's id (what the old test asserted
  // as "the real route") is a no-op — C1 is still blocked.
  clearMergeQuarantineLatchFile(hashZ1_Ghost);
  check("(Z1) negative control: re-clearing the GHOST's id is a FIXED POINT — C1 is still quarantined", !!activeMergeQuarantineFor(repoZ1_C1));

  // *** THE FIX (round 5, MAJOR) *** — clearing the OFFERED route genuinely lifts C1 in-process.
  const clearByOwnIdZ1 = clearMergeQuarantineLatchFile(z1CoC1.route.id);
  check("(Z1) THE FIX: clearing C1 by its OWN offered route id reports ok:true", clearByOwnIdZ1.ok === true);
  check("(Z1) THE FIX: C1 is genuinely unblocked in-process", !activeMergeQuarantineFor(repoZ1_C1));
  check("(Z1) the ghost file still survives — C1's own clear never touched it (C2 still references it)", fs.existsSync(latchPathZ1_Ghost));
  // NOTE: deliberately no intermediate reboot here, in either direction — while the ghost's own corrupt
  // file is STILL on disk, a boot re-scan would fail closed and durably RE-WRITE a fresh fail-closed latch
  // for C1 to disk (the ghost is still unreadable, so a boot can't yet tell it's resolved) — a side effect
  // this test's own later clears/sweeps (keyed off THIS process's in-memory state) would never account
  // for, contaminating the durability proof below. Go straight to resolving the root cause instead.

  // *** THE FIX (round 5, MAJOR) *** — clear C2 by ITS OWN offered route too (never by repoPath, which
  // round 4's test used and which proves nothing about the fix). Once BOTH referencing repos are cleared
  // through their own real routes, the ghost's own corrupt file is finally unreferenced and swept for
  // real — and NEITHER C1 NOR C2 re-quarantines after a REAL reboot (lesson 203: an in-process check alone
  // can't tell "lifted" from "lifted only until the next boot re-scans disk").
  const clearZ1Again = clearMergeQuarantineLatchFile(hashZ1_Ghost); // ghost still corrupt; C2 still references it — same as before, nothing changed yet
  const z1CoC2Again = clearZ1Again.stillBlockedCoOccupants?.find((c) => c.repoPath === repoZ1_C2);
  check("(Z1) sanity: C2's offered route is still its own id, unaffected by C1's own clear", !!z1CoC2Again && z1CoC2Again.route.id === ownIdC2);
  const clearByOwnIdZ1C2 = clearMergeQuarantineLatchFile(z1CoC2Again.route.id);
  check("(Z1) THE FIX: clearing C2 by its OWN offered route id reports ok:true", clearByOwnIdZ1C2.ok === true);
  check("(Z1) THE FIX: C2 is genuinely unblocked in-process", !activeMergeQuarantineFor(repoZ1_C2));
  check("(Z1) POSITIVE CONTROL: once BOTH referencing repos are cleared via their OWN routes, the ghost file is finally swept for real", !fs.existsSync(latchPathZ1_Ghost));
  const rebootZ1AfterBoth = rebootInChildProcess([repoZ1_C1, repoZ1_C2], "z1-both-own-ids");
  check("*** THE FIX (round 5, MAJOR) *** with the ghost file genuinely gone, BOTH C1 and C2 stay unblocked after a REAL reboot", rebootZ1AfterBoth.refusals[repoZ1_C1] === true && rebootZ1AfterBoth.refusals[repoZ1_C2] === true && rebootZ1AfterBoth.activeForThese === 0);
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

// ===================== (AC) POST /clear-by-path {id} forwards stillQuarantined/reason over REAL HTTP (card 64283e06, CR 3439677b, item 2) =====================
// (D)/finding-3's own module-level test proves clearMergeQuarantineLatchFile itself; this proves the
// gateway route actually forwards the new fields on its JSON response, not just that the function carries
// them — mirrors (Z1-route)'s own latchKept/referencingRepoPaths route-forwarding proof, for the NEW
// stillQuarantined/reason fields instead. Dropping the route's own conditional spread
// (`...(result.stillQuarantined ? {...} : {})`) must fail this.
{
  const repoAC = freshDir("repoAC");
  enterMergeQuarantine(repoAC, "x-branch", "t1 — X's own founding raise, while resolvable (AC)");
  const idActiveAC = quarantineLatchIdFor(repoAC); // captured BEFORE park, while resolvable
  const parkedAC = path.join(os.tmpdir(), `loom-mqcbp-parked-ac-${sfx}`);
  fs.renameSync(repoAC, parkedAC);
  enterMergeQuarantine(repoAC, "x-branch", "t2 — X's own second raise, AFTER becoming unresolvable (AC)");
  check("(AC precondition) X now has TWO independent entries: one active (t1), one pending (t2)", listActiveMergeQuarantines().filter((e) => e.repoPath === repoAC).length === 2);

  const TMPAC = mkdtempManaged("loom-mqcbp-gw-ac-");
  const PORTAC = 47900 + (process.pid % 400);
  const HAC = { host: `127.0.0.1:${PORTAC}`, origin: `http://127.0.0.1:${PORTAC}`, "content-type": "application/json" };
  const dbAC = new Db(path.join(TMPAC, "loom.db"));
  const stubAC = {};
  const appAC = await buildServer({
    db: dbAC, pty: stubAC, sessions: stubAC, mcp: stubAC, orchMcp: stubAC, platformMcp: stubAC, auditMcp: stubAC,
    userAuditMcp: stubAC, setupMcp: stubAC, runMcp: stubAC, control: stubAC, usageStatus: stubAC,
  });
  try {
    const clearAC = await appAC.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAC, payload: { id: idActiveAC } });
    check("(AC) POST /clear-by-path {id} (active, still-blocked-by-independent-pending) → 200", clearAC.statusCode === 200);
    const bodyAC = clearAC.json();
    check("(AC) ok:true, wasQuarantined:true", bodyAC.ok === true && bodyAC.wasQuarantined === true);
    check("(AC) THE FIX: X is NOT in liftedRepoPaths (still blocked by its own independent pending record)", !bodyAC.liftedRepoPaths.includes(repoAC));
    check("(AC) THE FIX (item 2): the route forwards stillQuarantined:true", bodyAC.stillQuarantined === true);
    check("(AC) THE FIX (item 2): the route forwards reason, naming the remaining record", typeof bodyAC.reason === "string" && bodyAC.reason.includes(repoAC));
    check("(AC) a direct query for X still correctly refuses", !!activeMergeQuarantineFor(repoAC));
  } finally {
    await appAC.close();
    dbAC.close();
  }
  fs.renameSync(parkedAC, repoAC); // restore, then cleanup
  clearMergeQuarantineByRecordedPath(repoAC);
  check("(AC cleanup) repoAC is fully cleared", !activeMergeQuarantineFor(repoAC));
}

// ===================== (AD) stillBlockedCoOccupants names a co-occupant found at the physical file being
// deleted, including one re-homed to a NEW pending id (card 182c01cc — the a4481c3b repro shape: X a
// placeholder occupying sub's own key file) =====================
// Root cause: deleteMergeQuarantineLatchByKey's protect wrappers (protectDegradedOccupantBeforeDelete,
// protectUnincorporatedOccupantBeforeDelete — exercised below, since `clearedEntry` is ALWAYS passed
// whenever an active `entry` exists — and the inline foreignPending branch) each already have the
// foreign occupant's own repoPath in hand before calling protectOccupantContentBeforeDelete, which used
// to discard it behind a bare boolean. THE FIX threads {ok, persisted:{repoPath,sourceFile}} through to
// a `stillBlockedCoOccupants: [{repoPath, route:{repoPath,id}}]` field on clearMergeQuarantineByKey /
// clearMergeQuarantine / clearMergeQuarantineReporting / clearMergeQuarantineByRecordedPath.
//
// Construction: X's content is written DIRECTLY into sub's own physical final file AFTER sub's own
// genuine raise — sub's in-memory entry is unaffected by the overwrite, but a fresh disk read at clear
// time (unincorporatedOccupantRepoPathAt) finds X's foreign bytes sitting there.
{
  // --- (AD1) MINT branch: X has no pre-existing pending record anywhere — first discovery. ---
  const subAD1 = freshDir("subAD1");
  enterMergeQuarantine(subAD1, "b", "sub's own genuine raise (AD1)");
  const ksubAD1 = canonicalRepoLockKey(subAD1);
  const subFinalAD1 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(ksubAD1)}.json`);
  check("(AD1 precondition) sub's own final file exists after its own raise", fs.existsSync(subFinalAD1));
  const xAD1 = path.join(os.tmpdir(), `loom-mqcbp-xAD1-never-exists-${sfx}`); // X's own repoPath — never created
  fs.writeFileSync(subFinalAD1, JSON.stringify({
    repoPath: xAD1, branch: "x-ad1-branch", reason: "X's own placeholder, now occupying sub's own key file (AD1)",
    enteredAt: Date.now(), tokens: ["x-ad1-token"],
  }, null, 2) + "\n");
  check("(AD1 precondition) sub's own in-memory entry is unaffected by the overwrite", activeMergeQuarantineFor(subAD1)?.repoPath === subAD1);

  const clearAD1 = clearMergeQuarantineReporting(subAD1);
  check("(AD1) clearing sub reports wasQuarantined:true (sub's own raise is genuinely lifted)", clearAD1.wasQuarantined === true);
  // @decision 182c01cc (round 2, finding 2) — a RELOCATED co-occupant is NOT "kept": X's old file is
  // genuinely gone (durably moved to a new latch), so latchKept must stay ABSENT here, never true.
  check("*** THE FIX (AD1, round 2) *** latchKept is ABSENT (a relocation is never \"kept\")", clearAD1.latchKept === undefined);
  check("*** THE FIX (AD1, MINT) *** stillBlockedCoOccupants names X", Array.isArray(clearAD1.stillBlockedCoOccupants) && clearAD1.stillBlockedCoOccupants.some((c) => c.repoPath === xAD1));
  const coAD1 = clearAD1.stillBlockedCoOccupants.find((c) => c.repoPath === xAD1);
  check("*** THE FIX (AD1) *** X's own route names both a repoPath and a 24-hex id form", coAD1?.route?.repoPath === xAD1 && /^[0-9a-f]{24}$/.test(coAD1?.route?.id ?? ""));
  check("*** THE FIX (AD1, round 2) *** the reason is the RELOCATED clause, never the kept/\"stays on disk\" wording", typeof clearAD1.reason === "string" && clearAD1.reason.includes("RELOCATED") && clearAD1.reason.includes(xAD1) && !clearAD1.reason.includes("stays on disk"));
  check("(AD1) X is STILL genuinely blocked after sub's own clear", !!activeMergeQuarantineFor(xAD1));
  check("(AD1) sub's own OLD key file is gone (X was durably relocated off it, not left in place)", !fs.existsSync(subFinalAD1));
  check("(AD1) X survives under a NEW, independent filename elsewhere on disk", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("x-ad1-token")));

  // The named route is genuinely actionable, not just string-shaped.
  const clearXByIdAD1 = clearMergeQuarantineLatchFile(coAD1.route.id);
  check("(AD1) THE NAMED ROUTE WORKS: clearing X by its own reported id lifts it for real", clearXByIdAD1.ok === true && clearXByIdAD1.wasQuarantined === true);
  check("(AD1) X is now actually unblocked", !activeMergeQuarantineFor(xAD1));
}

{
  // --- (AD2) X ALREADY has its own independent pending record (a genuine prior raise, now unresolvable)
  // BEFORE a SEPARATE, later incident ALSO squats sub's own key file with X's same identity. Measured
  // live (not assumed): protectOccupantContentBeforeDelete's own atFilenameIdx/atFinalBasenameIdx match
  // against the RECONCILED target filename, which this fixture's two independent divert events do not
  // happen to collide on — so this reaches the MINT branch a second time (two independent on-disk
  // records for the SAME identity X), never a union. (AD1) above already proves the pure first-mint
  // case; this proves the fix still correctly names X EVEN WHEN X already had unrelated history — the
  // thing actually under test here, regardless of which of the two reachable sub-branches runs.
  const xHomeAD2 = freshDir("xAD2-home");
  enterMergeQuarantine(xHomeAD2, "b", "X's own genuine FIRST raise, while resolvable (AD2)");
  const parkedXAD2 = path.join(os.tmpdir(), `loom-mqcbp-parked-xad2-${sfx}`);
  fs.renameSync(xHomeAD2, parkedXAD2);
  enterMergeQuarantine(xHomeAD2, "b", "X's own SECOND raise, now unresolvable — mints its own pending-divert record (AD2)");
  check("(AD2 precondition) X now has its own independent PENDING record", listActiveMergeQuarantines().some((e) => e.repoPath === xHomeAD2));

  const subAD2 = freshDir("subAD2");
  enterMergeQuarantine(subAD2, "b", "sub's own genuine raise (AD2)");
  const ksubAD2 = canonicalRepoLockKey(subAD2);
  const subFinalAD2 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(ksubAD2)}.json`);
  // X's SAME identity, now ALSO squatting sub's own key file — the second-incident shape.
  fs.writeFileSync(subFinalAD2, JSON.stringify({
    repoPath: xHomeAD2, branch: "x-ad2-branch-squat", reason: "X's own placeholder, now ALSO occupying sub's own key file (AD2)",
    enteredAt: Date.now(), tokens: ["x-ad2-token-squat"],
  }, null, 2) + "\n");

  const clearAD2 = clearMergeQuarantineReporting(subAD2);
  check("(AD2) clearing sub reports wasQuarantined:true", clearAD2.wasQuarantined === true);
  // @decision 182c01cc (round 2, finding 2) — same reasoning as (AD1): a relocation is never "kept".
  check("*** THE FIX (AD2, round 2) *** latchKept is ABSENT", clearAD2.latchKept === undefined);
  check("*** THE FIX (AD2) *** stillBlockedCoOccupants names X, even though X already had unrelated prior history", Array.isArray(clearAD2.stillBlockedCoOccupants) && clearAD2.stillBlockedCoOccupants.some((c) => c.repoPath === xHomeAD2));
  check("(AD2) X's own ORIGINAL (first-raise) pending record is untouched — this clear never touched it", !!activeMergeQuarantineFor(xHomeAD2));
  check("(AD2) X's SQUATTING content is ALSO still enforced somewhere on disk, not silently dropped", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("x-ad2-token-squat")));
  check("(AD2) sub's own OLD key file is gone (the squat content was durably relocated off it)", !fs.existsSync(subFinalAD2));

  fs.renameSync(parkedXAD2, xHomeAD2); // restore for cleanup
  clearMergeQuarantineByRecordedPath(xHomeAD2);
}

{
  // --- (AD3) THE SAME mechanism, reached via clearMergeQuarantineByRecordedPath (/clear-by-path
  // {repoPath}) instead of the key-addressed clearMergeQuarantineReporting — AND the triage note's own
  // wording fix: sub's own identity must NOT be named in the "WILL RE-DIVERT" claim (it is already fully
  // lifted and will not itself re-divert) — only the OTHER claimant (X here) can.
  const subAD3 = freshDir("subAD3");
  enterMergeQuarantine(subAD3, "b", "sub's own genuine raise (AD3)");
  const ksubAD3 = canonicalRepoLockKey(subAD3);
  const subFinalAD3 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(ksubAD3)}.json`);
  const xAD3 = path.join(os.tmpdir(), `loom-mqcbp-xAD3-never-exists-${sfx}`);
  fs.writeFileSync(subFinalAD3, JSON.stringify({
    repoPath: xAD3, branch: "x-ad3-branch", reason: "X's own placeholder, occupying sub's own key file (AD3)",
    enteredAt: Date.now(), tokens: ["x-ad3-token"],
  }, null, 2) + "\n");

  const clearAD3 = clearMergeQuarantineByRecordedPath(subAD3);
  // @decision 182c01cc (round 2, finding 2) — this is a PURE relocation (X has no pre-existing record,
  // sub itself is never kept) — latchKept must stay ABSENT; the OLD "WILL RE-DIVERT ... stays on disk"
  // wording is false for this shape (X's content lives at a BRAND-NEW name, nothing stays at the old
  // one), so the reason must be the RELOCATED clause instead.
  check("(AD3) clearMergeQuarantineByRecordedPath ALSO reaches the SAME fix (identity-addressed route)", clearAD3.wasQuarantined === true && clearAD3.latchKept === undefined);
  check("*** THE FIX (AD3) *** stillBlockedCoOccupants names X here too", Array.isArray(clearAD3.stillBlockedCoOccupants) && clearAD3.stillBlockedCoOccupants.some((c) => c.repoPath === xAD3));
  check("*** THE WORDING FIX (AD3, round 2) *** the reason is the RELOCATED clause, names X, and never claims the old file \"stays on disk\"", typeof clearAD3.reason === "string" && clearAD3.reason.includes("RELOCATED") && clearAD3.reason.includes(xAD3) && !clearAD3.reason.includes("stays on disk"));
  check("(AD3) sub itself is genuinely NOT quarantined after this clear", !activeMergeQuarantineFor(subAD3));
  // Card 182c01cc, round 2, M8 (CR test-gap): verify the route id clearMergeQuarantineByRecordedPath's
  // OWN matched-loop fold names is the CORRECT one, not merely a well-formed 24-hex string — a wrong id
  // (e.g. a stale/mismatched hash) would still pass the regex check above but fail to actually clear X.
  const coAD3 = clearAD3.stillBlockedCoOccupants.find((c) => c.repoPath === xAD3);
  const clearXByIdAD3 = clearMergeQuarantineLatchFile(coAD3.route.id);
  check("*** THE FIX (AD3, M8) *** the fold's own route id is genuinely CORRECT — clearing X by it actually lifts X", clearXByIdAD3.ok === true && clearXByIdAD3.wasQuarantined === true);
  check("(AD3) X is now actually unblocked", !activeMergeQuarantineFor(xAD3));
}

{
  // --- (AE) test gap M2 (CR): the INLINE `foreignPending` branch inside deleteMergeQuarantineLatchByKey
  // is reached when sub has NO entry of its own at all (`clearedEntry`/`entry` both undefined, so
  // protectUnincorporatedOccupantBeforeDelete never even runs), and X is ALREADY a genuine PENDING
  // record (discovered via a real boot, never a direct file overwrite after a raise like (AD1)-(AD3)
  // above) whose own `sourceFile` happens to equal sub's own key-hash filename.
  //
  // DISCOVERED while writing this test (not something the CR named, but caught by it): `entry`/
  // `clearedEntry` undefined is EXACTLY the precondition that ALSO arms the pre-existing
  // `contentClaimants` check (`!clearingRepoPath && !clearedEntry`), which independently re-reads
  // `final`'s raw on-disk bytes and finds X too — so in every real reachable case, `foreignPending`'s
  // own protect/relocate and `contentClaimants`'s own kept-tracking BOTH fire on the SAME foreign
  // occupant: X's OLD file genuinely stays on disk (contentClaimants vetoes the unlink — latchKept:true,
  // referencingRepoPaths names X), WHILE the SAME protect call's own re-point ALSO moves X's in-memory
  // bookkeeping to a brand-new latch.
  //
  // *** ROUND 3 (M1, CR2 80217ba5) *** — round 2's own dedupe (pick RELOCATED, drop KEPT) was ITSELF a
  // bug: it under-reports. Empirically verified below (a REAL reboot, in a fresh child process, same
  // LOOM_HOME) across all four possible clear orderings: relocated-ALONE lifts X in-process but
  // RE-QUARANTINES on reboot (the OLD kept file still durably holds X's own record); kept-ALONE is a
  // no-op (nothing in memory matches the old file's id anymore, so it only sweeps dead debris without
  // lifting X); even kept-THEN-relocated re-blocks on reboot (clearing kept first, before anything
  // references it as a live orphan, strands it on disk — the later relocated-clear never revisits it).
  // Only relocated-THEN-kept is durable. So X must be named ONCE, with BOTH routes, in that explicit
  // order — never deduped down to one.
  const subAE = freshDir("subAE");
  const ksubAE = canonicalRepoLockKey(subAE);
  const subHashAE = hashKey(ksubAE);
  const subFinalAE = path.join(MERGE_QUARANTINE_DIR, `${subHashAE}.json`);
  const xAE = path.join(os.tmpdir(), `loom-mqcbp-xAE-never-exists-${sfx}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(subFinalAE, JSON.stringify({
    repoPath: xAE, branch: "x-ae-branch", reason: "X's own placeholder, occupying sub's own key file (AE)",
    enteredAt: Date.now(), tokens: ["x-ae-token"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([subAE]); // subAE never raised — X diverts to pending, sourceFile=subHashAE.json
  check("(AE precondition) X loaded as a PENDING entry (no resolvedKey)", listActiveMergeQuarantines().some((e) => e.repoPath === xAE));
  check("(AE precondition) sub itself has no entry at all — no active raise ever happened", !activeMergeQuarantineFor(subAE));

  const clearAE = clearMergeQuarantineReporting(subAE);
  check("*** THE FIX (AE, M2) *** stillBlockedCoOccupants names X", Array.isArray(clearAE.stillBlockedCoOccupants) && clearAE.stillBlockedCoOccupants.some((c) => c.repoPath === xAE));
  check("(AE) X is still genuinely blocked", !!activeMergeQuarantineFor(xAE));
  // contentClaimants ALSO fires here (see the note above) — X's OLD file is genuinely kept on disk, so
  // latchKept IS true for this specific construction, unlike (AD1)-(AD3)'s pure-relocation shapes.
  check("(AE) latchKept is true (contentClaimants ALSO independently catches X here — the OLD file genuinely survives)", clearAE.latchKept === true);
  // X must still be named EXACTLY ONCE (one object), never twice with two different routes — round 3
  // changed WHAT that one object carries, not whether there's one of it.
  check("(AE, round 3) X is named EXACTLY ONCE in stillBlockedCoOccupants", clearAE.stillBlockedCoOccupants.filter((c) => c.repoPath === xAE).length === 1);
  const coAE = clearAE.stillBlockedCoOccupants.find((c) => c.repoPath === xAE);
  // *** THE FIX (AE, round 3, M1) *** — X carries BOTH routes now: `route` (relocated, clear FIRST) and
  // `alsoClear` (the OLD kept file, clear SECOND) — never deduped down to one.
  check("*** THE FIX (AE, round 3) *** X carries BOTH routes: route (relocated) and alsoClear (kept)", !!coAE.route && !!coAE.alsoClear && coAE.route.id !== coAE.alsoClear.id);
  check("(AE, round 3) the reason states the required order explicitly: relocated id FIRST, then kept id", typeof clearAE.reason === "string" && clearAE.reason.includes(coAE.route.id) && clearAE.reason.includes(coAE.alsoClear.id) && /FIRST/.test(clearAE.reason) && /THEN/.test(clearAE.reason));

  // *** THE DURABILITY PROOF (round 3, lesson 203: a real reboot, not reasoning) *** — clearing ONLY the
  // relocated route lifts X in-process (as before) but does NOT survive a reboot: the kept file still
  // holds X's own record on disk.
  check("(AE) clearing the relocated route alone lifts X in-process", clearMergeQuarantineLatchFile(coAE.route.id).wasQuarantined === true);
  check("(AE) X reads as unblocked in-process after the relocated-only clear", !activeMergeQuarantineFor(xAE));
  const rebootAfterRelocatedOnly = rebootInChildProcess([subAE, xAE], "AE-relocated-only");
  check("*** THE FIX (AE, round 3) *** relocated-ONLY does NOT survive a reboot — X re-quarantines (a single step is not durable)", rebootAfterRelocatedOnly.refusals[xAE] === false && rebootAfterRelocatedOnly.activeForThese > 0);

  // Clear the SECOND, required step (the kept id) too, then reboot again — NOW it must be durably gone.
  const alsoClearResultAE = clearMergeQuarantineLatchFile(coAE.alsoClear.id);
  check("(AE) the second (kept) clear itself succeeds (ok:true — it may report wasQuarantined:false, a raw-file sweep, which is fine)", alsoClearResultAE.ok === true);
  const rebootAfterBothSteps = rebootInChildProcess([subAE, xAE], "AE-both-steps");
  check("*** THE FIX (AE, round 3) *** relocated-THEN-kept (both steps, in order) IS durable — X stays lifted across a reboot", rebootAfterBothSteps.refusals[xAE] === true && rebootAfterBothSteps.activeForThese === 0);
}

// ===================== (AE2) card 182c01cc round 4, nit 3: the round-3 table/comment claimed all 4
// orderings were "verified with a real reboot" — AE above (just before this scenario) only asserted 2
// (relocated-only, relocated-then-kept) with a real reboot. This scenario adds the kept-ALONE ordering,
// with a real reboot, on an independent fixture (the SAME AE shape, freshly constructed — AE's own X is
// already durably lifted by the time this runs). =====================
{
  const subAE2 = freshDir("subAE2");
  const ksubAE2 = canonicalRepoLockKey(subAE2);
  const subHashAE2 = hashKey(ksubAE2);
  const subFinalAE2 = path.join(MERGE_QUARANTINE_DIR, `${subHashAE2}.json`);
  const xAE2 = path.join(os.tmpdir(), `loom-mqcbp-xAE2-never-exists-${sfx}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(subFinalAE2, JSON.stringify({
    repoPath: xAE2, branch: "x-ae2-branch", reason: "X's own placeholder, occupying sub's own key file (AE2)",
    enteredAt: Date.now(), tokens: ["x-ae2-token"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([subAE2]);
  const clearAE2 = clearMergeQuarantineReporting(subAE2);
  const coAE2 = clearAE2.stillBlockedCoOccupants.find((c) => c.repoPath === xAE2);
  check("(AE2 precondition) X carries both routes, same shape as AE", !!coAE2?.route && !!coAE2?.alsoClear);

  // KEPT-ALONE: clear only the alsoClear (kept) id — a no-op in-process (nothing in memory matches the
  // OLD file's id anymore, since X's own bookkeeping already moved to the relocated name) — and a real
  // reboot must show X is STILL genuinely blocked (nothing was ever durably lifted).
  const keptAloneResult = clearMergeQuarantineLatchFile(coAE2.alsoClear.id);
  check("(AE2) clearing the kept id alone is a no-op (wasQuarantined:false — nothing in memory matched it)", keptAloneResult.ok === true && keptAloneResult.wasQuarantined === false);
  check("(AE2) X still reads as blocked in-process after the kept-alone clear", !!activeMergeQuarantineFor(xAE2));
  const rebootAfterKeptAlone = rebootInChildProcess([subAE2, xAE2], "AE2-kept-alone");
  check("*** THE FIX (AE2, round 4) *** kept-ALONE is a no-op — a real reboot confirms X is STILL blocked (never lifted at all)", rebootAfterKeptAlone.refusals[xAE2] === false && rebootAfterKeptAlone.activeForThese > 0);
}

// ===================== (AE3) card 182c01cc round 4, nit 3: the kept-THEN-relocated ordering, with a
// real reboot — empirically the one order that LOOKS like it should work (both ids get cleared) but
// doesn't, because clearing kept first (before anything references it as a live orphan) strands it on
// disk; the later relocated-clear never revisits it. =====================
{
  const subAE3 = freshDir("subAE3");
  const ksubAE3 = canonicalRepoLockKey(subAE3);
  const subHashAE3 = hashKey(ksubAE3);
  const subFinalAE3 = path.join(MERGE_QUARANTINE_DIR, `${subHashAE3}.json`);
  const xAE3 = path.join(os.tmpdir(), `loom-mqcbp-xAE3-never-exists-${sfx}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(subFinalAE3, JSON.stringify({
    repoPath: xAE3, branch: "x-ae3-branch", reason: "X's own placeholder, occupying sub's own key file (AE3)",
    enteredAt: Date.now(), tokens: ["x-ae3-token"],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([subAE3]);
  const clearAE3 = clearMergeQuarantineReporting(subAE3);
  const coAE3 = clearAE3.stillBlockedCoOccupants.find((c) => c.repoPath === xAE3);
  check("(AE3 precondition) X carries both routes, same shape as AE", !!coAE3?.route && !!coAE3?.alsoClear);

  // KEPT-THEN-RELOCATED: clear the alsoClear (kept) id FIRST, then the route (relocated) id SECOND —
  // the WRONG order. In-process this can still look like a clean lift (the relocated clear itself
  // succeeds), but a real reboot must show X re-quarantines — the kept file's own sweep never got a
  // chance to run after it had anything live still referencing it as an orphan.
  const keptFirstResult = clearMergeQuarantineLatchFile(coAE3.alsoClear.id);
  check("(AE3) the kept-first clear is a no-op (nothing in memory matches it yet)", keptFirstResult.ok === true && keptFirstResult.wasQuarantined === false);
  const relocatedSecondResult = clearMergeQuarantineLatchFile(coAE3.route.id);
  check("(AE3) the relocated-second clear reports success in-process", relocatedSecondResult.ok === true && relocatedSecondResult.wasQuarantined === true);
  check("(AE3) X reads as unblocked in-process after both (wrong-order) steps", !activeMergeQuarantineFor(xAE3));
  const rebootAfterKeptThenRelocated = rebootInChildProcess([subAE3, xAE3], "AE3-kept-then-relocated");
  check("*** THE FIX (AE3, round 4) *** kept-THEN-relocated is NOT durable — a real reboot confirms X re-quarantines (wrong order)", rebootAfterKeptThenRelocated.refusals[xAE3] === false && rebootAfterKeptThenRelocated.activeForThese > 0);
}

{
  // --- (AF) test gap M12 (CR): clearMergeQuarantineLatchFile's own ACTIVE-MATCH branch (the bug this
  // card's round 2 fixed) must ALSO carry a pure relocation's stillBlockedCoOccupants, cleared BY ID
  // rather than by repoPath — the exact (AD1) shape, routed through the OTHER clear entry point.
  const subAF = freshDir("subAF");
  enterMergeQuarantine(subAF, "b", "sub's own genuine raise (AF)");
  const idSubAF = quarantineLatchIdFor(subAF); // captured BEFORE the overwrite below, while resolvable
  const ksubAF = canonicalRepoLockKey(subAF);
  const subFinalAF = path.join(MERGE_QUARANTINE_DIR, `${hashKey(ksubAF)}.json`);
  const xAF = path.join(os.tmpdir(), `loom-mqcbp-xAF-never-exists-${sfx}`);
  fs.writeFileSync(subFinalAF, JSON.stringify({
    repoPath: xAF, branch: "x-af-branch", reason: "X's own placeholder, occupying sub's own key file (AF)",
    enteredAt: Date.now(), tokens: ["x-af-token"],
  }, null, 2) + "\n");

  const clearAF = clearMergeQuarantineLatchFile(idSubAF);
  check("(AF) clearMergeQuarantineLatchFile clears sub by its own id", clearAF.ok === true && clearAF.wasQuarantined === true && clearAF.liftedRepoPaths.includes(subAF));
  check("*** THE FIX (AF, M12) *** stillBlockedCoOccupants names X via the active pass-through branch", Array.isArray(clearAF.stillBlockedCoOccupants) && clearAF.stillBlockedCoOccupants.some((c) => c.repoPath === xAF));
  check("(AF) latchKept is ABSENT (a relocation, never kept)", clearAF.latchKept === undefined);
  check("(AF) X is still genuinely blocked", !!activeMergeQuarantineFor(xAF));

  clearMergeQuarantineByRecordedPath(xAF); // cleanup
}

// ===================== (AG) REST-level: /clear and /clear-by-path forward stillBlockedCoOccupants over
// REAL HTTP, for a PURE relocation (no latchKept) — the shape gateway/server.ts's own conditional spread
// used to drop entirely (card 182c01cc, round 2) =====================
{
  const TMPAG = mkdtempManaged("loom-mqcbp-gw-ag-");
  const PORTAG = 48300 + (process.pid % 400);
  const HAG = { host: `127.0.0.1:${PORTAG}`, origin: `http://127.0.0.1:${PORTAG}`, "content-type": "application/json" };
  const dbAG = new Db(path.join(TMPAG, "loom.db"));
  const now = new Date().toISOString();
  const projRepoAG = freshDir("projRepoAG");
  dbAG.insertProject({
    id: "projAG", name: "ProjAG", repoPath: projRepoAG, vaultPath: projRepoAG, config: {}, createdAt: now,
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stubAG = {};
  const appAG = await buildServer({
    db: dbAG, pty: stubAG, sessions: stubAG, mcp: stubAG, orchMcp: stubAG, platformMcp: stubAG, auditMcp: stubAG,
    userAuditMcp: stubAG, setupMcp: stubAG, runMcp: stubAG, control: stubAG, usageStatus: stubAG,
  });
  try {
    // --- (AG1)-(AG3): each uses `appAG.inject` (in-process, no real socket) against a server built
    // WITHOUT loopbackSecret (this file's own top-of-file note) — these prove the ROUTE HANDLER forwards
    // the new field for its own payload shape, nothing about transport or auth; route-auth stays covered
    // by test/loopback-write-guard.mjs's own (Q). (round 3, nit2: reworded from "over real HTTP"/"REST",
    // which read as a transport/auth claim neither test makes.)
    // --- (AG1) /clear (project-resolved) ---
    enterMergeQuarantine(projRepoAG, "b", "sub's own genuine raise (AG1)");
    const kProjAG = canonicalRepoLockKey(projRepoAG);
    const projFinalAG = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kProjAG)}.json`);
    const xAG1 = path.join(os.tmpdir(), `loom-mqcbp-xAG1-never-exists-${sfx}`);
    fs.writeFileSync(projFinalAG, JSON.stringify({
      repoPath: xAG1, branch: "x-ag1-branch", reason: "X's own placeholder, occupying sub's own key file (AG1)",
      enteredAt: Date.now(), tokens: ["x-ag1-token"],
    }, null, 2) + "\n");
    const clearAG1 = await appAG.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: HAG, payload: { projectId: "projAG" } });
    check("(AG1) POST /clear → 200", clearAG1.statusCode === 200);
    const bodyAG1 = clearAG1.json();
    check("*** THE FIX (AG1, route) *** /clear forwards stillBlockedCoOccupants naming X, even with latchKept ABSENT", Array.isArray(bodyAG1.stillBlockedCoOccupants) && bodyAG1.stillBlockedCoOccupants.some((c) => c.repoPath === xAG1) && bodyAG1.latchKept === undefined);
    clearMergeQuarantineByRecordedPath(xAG1); // cleanup

    // --- (AG2) /clear-by-path {repoPath} (no project resolution) ---
    const subAG2 = freshDir("subAG2");
    enterMergeQuarantine(subAG2, "b", "sub's own genuine raise (AG2)");
    const kSubAG2 = canonicalRepoLockKey(subAG2);
    const subFinalAG2 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kSubAG2)}.json`);
    const xAG2 = path.join(os.tmpdir(), `loom-mqcbp-xAG2-never-exists-${sfx}`);
    fs.writeFileSync(subFinalAG2, JSON.stringify({
      repoPath: xAG2, branch: "x-ag2-branch", reason: "X's own placeholder, occupying sub's own key file (AG2)",
      enteredAt: Date.now(), tokens: ["x-ag2-token"],
    }, null, 2) + "\n");
    const clearAG2 = await appAG.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAG, payload: { repoPath: subAG2 } });
    check("(AG2) POST /clear-by-path {repoPath} → 200", clearAG2.statusCode === 200);
    const bodyAG2 = clearAG2.json();
    check("*** THE FIX (AG2, route) *** /clear-by-path {repoPath} forwards stillBlockedCoOccupants naming X, even with latchKept ABSENT", Array.isArray(bodyAG2.stillBlockedCoOccupants) && bodyAG2.stillBlockedCoOccupants.some((c) => c.repoPath === xAG2) && bodyAG2.latchKept === undefined);

    // --- (AG3) /clear-by-path {id} (clearMergeQuarantineLatchFile's own active branch, M12) ---
    const subAG3 = freshDir("subAG3");
    enterMergeQuarantine(subAG3, "b", "sub's own genuine raise (AG3)");
    const idSubAG3 = quarantineLatchIdFor(subAG3);
    const kSubAG3 = canonicalRepoLockKey(subAG3);
    const subFinalAG3 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kSubAG3)}.json`);
    const xAG3 = path.join(os.tmpdir(), `loom-mqcbp-xAG3-never-exists-${sfx}`);
    fs.writeFileSync(subFinalAG3, JSON.stringify({
      repoPath: xAG3, branch: "x-ag3-branch", reason: "X's own placeholder, occupying sub's own key file (AG3)",
      enteredAt: Date.now(), tokens: ["x-ag3-token"],
    }, null, 2) + "\n");
    const clearAG3 = await appAG.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAG, payload: { id: idSubAG3 } });
    check("(AG3) POST /clear-by-path {id} → 200", clearAG3.statusCode === 200);
    const bodyAG3 = clearAG3.json();
    check("*** THE FIX (AG3, route, M12) *** /clear-by-path {id} forwards stillBlockedCoOccupants naming X, even with latchKept ABSENT", Array.isArray(bodyAG3.stillBlockedCoOccupants) && bodyAG3.stillBlockedCoOccupants.some((c) => c.repoPath === xAG3) && bodyAG3.latchKept === undefined);
    clearMergeQuarantineByRecordedPath(xAG2);
    clearMergeQuarantineByRecordedPath(xAG3);
  } finally {
    await appAG.close();
    dbAG.close();
  }
}

// ===================== (AH) card 182c01cc round 3, m1/M6: clearMergeQuarantineByKey's own PENDING-LOOP
// fold (deleteMergeQuarantineLatchByKey called per `plan.ownedArmedKeys` member, ~line 3950) IS reachable
// — a DIFFERENT fold site than the one (AD1)-(AE) already exercise (the OUTER matched-key loop). Manager's
// exact recipe (CR2 80217ba5): P unresolvable at boot, armed at a SYNTHETIC resolvedKey K (an
// 883e29bc-shaped degraded dual-arm: a raw latch carrying a pre-set resolvedKey/armedKeys gets ARMED
// into activeQuarantines under that recorded key even though P itself cannot currently resolve — AND
// ALSO pushed into pendingUnresolvedQuarantines for P's own (unresolvable) identity); a foreign X record
// sits at hash(K).json, WRITTEN AFTER BOOT (never scanned into memory — a genuinely fresh clear-time read,
// not a pre-existing record discovered via a re-point/union, which is what actually produces a MINT,
// the shape the pre-existing drop below needs). P then becomes resolvable (mkdir) and
// `clearMergeQuarantine(P)` is called: it dispatches to `clearMergeQuarantineByKey(canonical(P), P)`,
// which has NO active entry at `canonical(P)` (only P's own pending twin, armed at the DIFFERENT key K)
// — so the pending loop (where `!entry` makes `tiedToThisEntity` unconditionally true for any
// same-identity pending record) drops P's own tied pending entry and, processing its
// `ownedArmedKeys = [K]`, reaches `deleteMergeQuarantineLatchByKey(K, ...)`, which mints a fresh pending
// divert for the foreign X it finds at `hash(K).json` and folds it into THIS clear's own
// `stillBlockedCoOccupants` — the SAME fold code (AD1)-(AE) exercise via the OUTER loop, now proven
// reachable via the PENDING loop too.
{
  const pAH = path.join(os.tmpdir(), `loom-mqcbp-pAH-never-exists-yet-${sfx}`); // created later, below
  const kAH = "loom-mqcbp-AH-synthetic-resolved-key"; // a made-up resolvedKey — never a real canonical key
  const hashKAH = hashKey(kAH);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "mqcbp-ah-p-synthetic-twin.json"), JSON.stringify({
    repoPath: pAH, branch: "p-ah-branch", reason: "P — AH, armed at a synthetic resolvedKey K (883e29bc-shaped twin)",
    enteredAt: Date.now(), tokens: ["p-ah-token"], resolvedKey: kAH, armedKeys: [kAH],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([pAH]); // P diverts to pending AND arms active at K — X's file doesn't exist yet
  check("(AH precondition) P reads as blocked right after this boot", !!activeMergeQuarantineFor(pAH));

  // X's foreign record, written AFTER boot — never scanned into memory, so the clear-time discovery
  // below is a genuine fresh MINT (no pre-existing record to re-point onto), which is exactly the shape
  // the pre-existing drop (below) needs to manifest.
  const xAH = path.join(os.tmpdir(), `loom-mqcbp-xAH-never-exists-${sfx}`);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKAH}.json`), JSON.stringify({
    repoPath: xAH, branch: "x-ah-branch", reason: "X — AH, foreign occupant at hash(K).json, written AFTER boot",
    enteredAt: Date.now(), tokens: ["x-ah-token"],
  }, null, 2) + "\n");
  check("(AH precondition) X is NOT yet known to memory before the clear (never scanned)", !activeMergeQuarantineFor(xAH));

  fs.mkdirSync(pAH, { recursive: true }); // P becomes resolvable
  const clearAH = clearMergeQuarantine(pAH);
  check("*** THE FIX (AH, round 3, m1/M6) *** the PENDING-LOOP fold names X in stillBlockedCoOccupants", !!clearAH && Array.isArray(clearAH.stillBlockedCoOccupants) && clearAH.stillBlockedCoOccupants.some((c) => c.repoPath === xAH));
  const coAH = clearAH.stillBlockedCoOccupants.find((c) => c.repoPath === xAH);

  // *** CONTROL S8 *** — see the manual revert proof in this card's own worker_report / decision record:
  // commenting out this pending loop's own `for (const kc of r.kept) ...`/`for (const rc of r.relocated)
  // ...` fold lines (merge-quarantine.ts, the `plan.action !== "reduce"` branch) makes THIS check fail —
  // proving the assertion actually exercises that fold, not a vacuous pass.

  // *** THE FIX (card 07e3ad30) *** — these TWO checks are INVERTED from this scenario's pre-fix form
  // (dropped the `!`, per that scenario's own prior instruction to flip rather than delete). Before the
  // fix, the pending-filter's own `.filter()` callback dropped P's tied record from
  // `pendingUnresolvedQuarantines` WITHOUT the foreign mint (X's own brand-new pending-divert entry,
  // minted by this SAME call) ever landing back in that array for THIS process, so X read as UNBLOCKED
  // in-process even though its record genuinely survived on disk. Firsthand, on pre-fix main: the clear
  // leaves X's content durably relocated to a fresh `pending-<hash>.json` file (the OLD `hash(K).json` is
  // gone — its content moved, not destroyed) and a real reboot already re-blocked X correctly — this was
  // always an IN-MEMORY-ONLY drop, never a durable file loss. See the decision record for the firsthand
  // disk/reboot evidence. The fix (the in-place splice replacing the `.filter()` reassignment) makes the
  // push survive in THIS process too, so X now reads BLOCKED immediately, with no reboot required.
  check("*** THE FIX (AH) *** X reads as BLOCKED in-process right after this clear (the push survives)", !!activeMergeQuarantineFor(xAH));
  check("*** THE FIX (AH) *** listActiveMergeQuarantines() carries X too", listActiveMergeQuarantines().some((e) => e.repoPath === xAH));

  // A REAL reboot (fresh child process, same LOOM_HOME) still proves durability independently of the
  // in-process read above (lesson 203 — never let one process's own memory stand in for "durable").
  const rebootAH = rebootInChildProcess([pAH, xAH], "AH");
  check("*** THE DURABILITY PROOF (AH) *** a real reboot still blocks X", rebootAH.refusals[xAH] === false && rebootAH.activeForThese > 0);

  // "Name the route that actually works" — post-fix, clearing `coAH.route.id` DIRECTLY in THIS SAME
  // process (no reboot needed first) now genuinely lifts X, since the fold's own push survived into
  // memory. Pre-fix, this same call used to be a no-op here (nothing in memory matched the id until a
  // fresh boot re-discovered X from disk) — see git history for that prior shape.
  const directClearAH = clearMergeQuarantineLatchFile(coAH.route.id);
  check("*** THE ROUTE THAT ACTUALLY WORKS (AH) *** clearing the fold's own named id DIRECTLY, in this same process, genuinely lifts X", directClearAH.ok === true && directClearAH.wasQuarantined === true && directClearAH.liftedRepoPaths.includes(xAH));
  check("(AH) X reads unblocked in-process right after that direct clear", !activeMergeQuarantineFor(xAH));
  // *** THE DURABILITY PROOF (round 4, nit; still required post-fix) *** — "durably" is a claim about
  // surviving a FURTHER reboot, never provable from a single process's own in-memory read; a SECOND,
  // genuinely separate boot (same LOOM_HOME, after the direct clear above already ran) is what backs it.
  const rebootAfterAHClear = rebootInChildProcess([pAH, xAH], "AH-after-clear");
  check("*** THE DURABILITY PROOF (AH) *** the direct clear DURABLY lifts X (confirmed by yet another, later reboot)", rebootAfterAHClear.refusals[xAH] === true && rebootAfterAHClear.activeForThese === 0);
}

// ===================== (AI) card 182c01cc round 3, m5/S21: the kept route's own sourceFile, when it
// comes from clearMergeQuarantineByKey's own `for (const f of sourceFilesToSweep) { sweepOwnLatchFileUnlessOwnedElsewhere(f) ... }`
// loop (~line 3996) — a DIFFERENT source than the deleteMergeQuarantineLatchByKey-derived kept entries
// (AE), which use `finalBasename` instead. =====================
// R is a SURVIVING entry (armed, via the SAME synthetic-resolvedKey technique as AH, at a key K2) whose
// OWN latch-file hash is made to EQUAL P's own sourceFile's basename (chosen, not coincidental — both
// derived from the SAME `hashKey` this file already uses for a real canonicalRepoLockKey). When P (tied
// to the identity being cleared) is dropped, its OWN sourceFile is swept via sweepOwnLatchFileUnlessOwnedElsewhere
// — which must recognize R's claim and report `kept:true, referencingRepoPaths:[R]`, with the resulting
// BlockedCoOccupant's route.id derived from THAT exact sourceFile, not any other.
{
  const pAI = path.join(os.tmpdir(), `loom-mqcbp-pAI-never-exists-yet-${sfx}`);
  const k2AI = "loom-mqcbp-AI-synthetic-resolved-key-for-R"; // R's own synthetic resolvedKey
  const hashK2AI = hashKey(k2AI); // R's own fresh-write-target hash — chosen to equal P's OWN sourceFile's stem
  const pSourceFileAI = `${hashK2AI}.json`; // P's own sourceFile, DELIBERATELY set to R's own hash
  const rAI = path.join(os.tmpdir(), `loom-mqcbp-rAI-never-exists-${sfx}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // P's own raw latch, written AT pSourceFileAI (R's own hash) — P is armed at an UNRELATED key kAI, never k2AI.
  const kAI = "loom-mqcbp-AI-synthetic-resolved-key-for-P";
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFileAI), JSON.stringify({
    repoPath: pAI, branch: "p-ai-branch", reason: "P — AI, own sourceFile deliberately collides with R's own hash",
    enteredAt: Date.now(), tokens: ["p-ai-token"], resolvedKey: kAI, armedKeys: [kAI],
  }, null, 2) + "\n");
  // R's own raw latch, armed at k2AI — an UNRELATED basename on disk (its OWN physical file is irrelevant
  // to this check; only its claim via armedKeys/quarantineHashForKey matters).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "mqcbp-ai-r-twin.json"), JSON.stringify({
    repoPath: rAI, branch: "r-ai-branch", reason: "R — AI, survives, claims pSourceFileAI as its OWN fresh write target",
    enteredAt: Date.now(), tokens: ["r-ai-token"], resolvedKey: k2AI, armedKeys: [k2AI],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([pAI, rAI]);
  check("(AI precondition) P reads as blocked after boot", !!activeMergeQuarantineFor(pAI));
  check("(AI precondition) R reads as blocked after boot (it SURVIVES — P's clear below never touches R)", !!activeMergeQuarantineFor(rAI));

  fs.mkdirSync(pAI, { recursive: true });
  const clearAI = clearMergeQuarantine(pAI);
  check("(AI) R is untouched — still genuinely blocked after clearing P", !!activeMergeQuarantineFor(rAI));
  check("*** THE FIX (AI, round 3, m5/S21) *** stillBlockedCoOccupants names R via the sourceFilesToSweep loop", !!clearAI && Array.isArray(clearAI.stillBlockedCoOccupants) && clearAI.stillBlockedCoOccupants.some((c) => c.repoPath === rAI));
  const coAI = clearAI.stillBlockedCoOccupants.find((c) => c.repoPath === rAI);
  // *** THE ASSERTION (S21) *** — the route's own id is derived from THE REAL sourceFile (pSourceFileAI's
  // own stem), not any other value. Inline negative control: a bogus 24-hex id (or P/R's OWN unrelated
  // key hashes) must NOT equal it — proving this assertion actually discriminates rather than passing
  // vacuously for any well-formed-looking id.
  check("*** THE FIX (AI, S21) *** the kept route's id equals the REAL sourceFile's own stem (hashK2AI)", coAI.route.id === hashK2AI);
  check("(AI, S21) *** NEGATIVE CONTROL *** a bogus id does NOT equal it (proves the check above discriminates)", coAI.route.id !== "0".repeat(24) && coAI.route.id !== hashKey(kAI));
  check("(AI) clearing R by the route the fold named for it genuinely matches R (not a dead/raw-fallback id)", clearMergeQuarantineLatchFile(coAI.route.id).liftedRepoPaths.includes(rAI));
}

// ===================== (AJ) card 07e3ad30: the PENDING-LOOP's own push-during-iteration must survive —
// interleaved reduce+remove, with unrelated pending entries both BEFORE and AFTER the removed one in the
// array. =====================
// W is a REAL active entry at y's own real key (kY), tokens {w-token}. FOUR pending twins coexist, in this
// exact array order: (1) `beforeAJ` — a wholly UNRELATED identity/token, injected FIRST, must survive
// untouched. (2) `qRemoveAJ` — SAME identity as y, tokens {w-token} (a full subset of W's tokens, so it
// takes the "remove" branch), armed (via `setActiveQuarantineTestOnly`, the SAME object reference also
// injected into pending — mirroring 883e29bc's own diverted-pending shape) at a SYNTHETIC key `kForeignAJ`
// where a FOREIGN occupant `xAJ`'s own real latch sits, written to disk AFTER every boot/inject call below
// (never scanned into memory, so the clear-time discovery is a genuine fresh MINT — same technique as AH).
// (3) `qReduceAJ` — SAME identity as y, tokens {w-token, private-token}, armedKeys [kY] (tied to W via the
// armedKeys-overlap branch, card 64119847) — NOT a token subset of W's, so it takes the "reduce" branch,
// surviving with {private-token} alone. (4) `afterAJ` — another wholly UNRELATED identity/token, injected
// LAST, must survive untouched. Clearing y exercises the remove branch's own protect-call push (xAJ's
// mint) interleaved, in ONE pending-loop pass, with a reduce — the exact combination card 07e3ad30's own
// approval asked to be tested, never exercised by (AH) alone (which has no active `entry` and so can never
// reach the "reduce" gate at all — see `clearMergeQuarantineByKey`'s own `entry &&` guard).
//
// ⚠️ LABELLING (Code Review 46d6e471): on a revert of ONLY the source fix, measured, only this scenario's
// own two "X reads BLOCKED"/"carries X" checks go RED — the interleaved-reduce, Before/After-survive, and
// stillBlockedCoOccupants-names-X checks below all still PASS pre-fix too (a single remove's own drop
// never disturbs anything else in the array). So those are SAFETY checks (they'd catch a DIFFERENT kind of
// regression — a fix that broke the reduce/survival contract while "fixing" the push) — the push survival
// pair is this scenario's actual regression witness. See (AK) below for the scenario whose checks actually
// DO regress on a revert beyond the push-survival pair: two sequential "remove" twins, where the fix's own
// index-after-protect-calls re-resolution is what the splice logic depends on.
{
  const yAJ = freshDir("ajY");
  const kYAJ = canonicalRepoLockKey(yAJ);
  const kForeignAJ = "loom-mqcbp-AJ-synthetic-foreign-key";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kYAJ)}.json`), JSON.stringify({
    repoPath: yAJ, branch: "w-aj-branch", reason: "W — AJ, y's own real active entry", enteredAt: Date.now(), tokens: ["w-aj-token"],
  }, null, 2) + "\n");

  const beforeAJ = path.join(os.tmpdir(), `loom-mqcbp-beforeAJ-unrelated-${sfx}`);
  reenterMergeQuarantinesAtBootTestOnly([], [{
    entry: { repoPath: beforeAJ, branch: "before-aj-branch", reason: "Before — AJ, wholly unrelated, must survive untouched", enteredAt: Date.now(), tokens: ["before-aj-token"] },
    sourceFile: "pending-aj-before-test.json",
  }]);

  const xAJ = path.join(os.tmpdir(), `loom-mqcbp-xAJ-never-exists-${sfx}`);
  const qRemoveEntryAJ = {
    repoPath: yAJ, branch: "q-remove-aj-branch", reason: "Q_remove — AJ, tied to y, armed at the synthetic foreign key",
    enteredAt: Date.now(), tokens: ["w-aj-token"], armedKeys: [kForeignAJ],
  };
  setActiveQuarantineTestOnly(kForeignAJ, qRemoveEntryAJ); // ARMED — entryStillOwnsKey needs this, not just the armedKeys field
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: qRemoveEntryAJ, sourceFile: "pending-aj-remove-test.json" }]);

  const qReduceEntryAJ = {
    repoPath: yAJ, branch: "q-reduce-aj-branch", reason: "Q_reduce — AJ, tied to y via armedKeys-overlap, holds a private token",
    enteredAt: Date.now(), tokens: ["w-aj-token", "private-aj-token"], armedKeys: [kYAJ],
  };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: qReduceEntryAJ, sourceFile: "pending-aj-reduce-test.json" }]);

  const afterAJ = path.join(os.tmpdir(), `loom-mqcbp-afterAJ-unrelated-${sfx}`);
  reenterMergeQuarantinesAtBootTestOnly([], [{
    entry: { repoPath: afterAJ, branch: "after-aj-branch", reason: "After — AJ, wholly unrelated, must survive untouched", enteredAt: Date.now(), tokens: ["after-aj-token"] },
    sourceFile: "pending-aj-after-test.json",
  }]);

  reenterMergeQuarantinesAtBootTestOnly([yAJ], []); // the real scan — arms W at kYAJ from its own real latch file

  check("(AJ precondition) W active with w-aj-token", listActiveMergeQuarantines().some((e) => e.repoPath === yAJ && e.tokens.includes("w-aj-token")));
  check("(AJ precondition) Before present, untouched", listActiveMergeQuarantines().some((e) => e.repoPath === beforeAJ && e.tokens.includes("before-aj-token")));
  check("(AJ precondition) After present, untouched", listActiveMergeQuarantines().some((e) => e.repoPath === afterAJ && e.tokens.includes("after-aj-token")));
  check("(AJ precondition) Q_reduce present with BOTH tokens (not yet reduced)", listActiveMergeQuarantines().some((e) => e.repoPath === yAJ && e.tokens.includes("private-aj-token") && e.tokens.includes("w-aj-token")));
  check("(AJ precondition) X unknown to memory before the clear (never scanned)", !activeMergeQuarantineFor(xAJ));

  // X's foreign record, written AFTER every boot/inject call above — never scanned into memory, so the
  // clear-time discovery below is a genuine fresh MINT (same technique as (AH)).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kForeignAJ)}.json`), JSON.stringify({
    repoPath: xAJ, branch: "x-aj-branch", reason: "X — AJ, foreign occupant at hash(kForeignAJ).json, written AFTER every inject call",
    enteredAt: Date.now(), tokens: ["x-aj-token"],
  }, null, 2) + "\n");

  const clearAJ = clearMergeQuarantine(yAJ);

  // *** THE FIX (AJ, card 07e3ad30) *** — X's fresh mint (pushed by the remove branch's own protect call,
  // mid-iteration) must survive IN-PROCESS, right here, not just on disk / after a reboot.
  check("*** THE FIX (AJ) *** X reads as BLOCKED in-process right after this clear (the push survives)", !!activeMergeQuarantineFor(xAJ));
  check("*** THE FIX (AJ) *** listActiveMergeQuarantines() carries X too", listActiveMergeQuarantines().some((e) => e.repoPath === xAJ));
  // (condition 4) the clear's own response still names X as still blocked (182c01cc's stillBlockedCoOccupants).
  check("*** THE FIX (AJ) *** the clear's response names X in stillBlockedCoOccupants", !!clearAJ && Array.isArray(clearAJ.stillBlockedCoOccupants) && clearAJ.stillBlockedCoOccupants.some((c) => c.repoPath === xAJ));

  // The intended removals actually happened: W's own token is genuinely gone (not just hidden) — no
  // surviving entry anywhere still carries it.
  check("(AJ) W's own w-aj-token is actually gone from every surviving entry (not just hidden)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("w-aj-token")));
  // Q_reduce survived, reduced to ONLY its own private token (the interleaved "reduce" branch, mirroring
  // card 64119847's own mechanism-level check) — y itself is therefore STILL blocked, via Q_reduce alone.
  const reducedAJ = listActiveMergeQuarantines().find((e) => e.repoPath === yAJ && e.tokens.includes("private-aj-token"));
  check("*** THE FIX (AJ, interleaved reduce) *** Q_reduce survived, reduced to EXACTLY {private-aj-token}", !!reducedAJ && JSON.stringify([...reducedAJ.tokens].sort()) === JSON.stringify(["private-aj-token"]));
  check("(AJ) y is still blocked for real merge admission, via Q_reduce's surviving private token", assertRepoNotQuarantined(yAJ).ok === false);

  // Nothing else was removed: Before and After, wholly unrelated to y, must still be present with their
  // OWN original tokens — proving the fix's splice touches only the entries it means to.
  check("(AJ) Before is STILL present, untouched, after the clear", listActiveMergeQuarantines().some((e) => e.repoPath === beforeAJ && e.tokens.includes("before-aj-token")));
  check("(AJ) After is STILL present, untouched, after the clear", listActiveMergeQuarantines().some((e) => e.repoPath === afterAJ && e.tokens.includes("after-aj-token")));

  // A REAL reboot (fresh child process, same LOOM_HOME) proves X's own durable record — not just the
  // in-process read above — genuinely survives (card 07e3ad30's own firsthand finding: the file was never
  // destroyed; only the in-process read was wrong). Before/After were pure in-memory test-only injections
  // (never durably written), so only yAJ/xAJ are meaningful to reboot-check here.
  const rebootAJ = rebootInChildProcess([yAJ, xAJ], "AJ");
  check("*** THE DURABILITY PROOF (AJ) *** a real reboot still blocks X", rebootAJ.refusals[xAJ] === false && rebootAJ.activeForThese > 0);
  check("(AJ) a real reboot still blocks y too (Q_reduce's own private token persisted)", rebootAJ.refusals[yAJ] === false);
}

// ===================== (AK) card 07e3ad30, Code Review 46d6e471 — TWO sequential "remove" twins in ONE
// pending-loop pass: Q1's own push must not disturb Q2's own splice, and Q2's own index must be resolved
// AFTER the array has already shrunk (by Q1's removal) and grown (by Q1's own push) — the actual
// interleaving the fix's `indexOf`-at-removal-time design is FOR, never exercised by (AJ) alone (which has
// only ONE remove). =====================
// W is a REAL active entry at y's own real key, tokens {w-token}. Pending twins, in this exact array
// order: (1) `q1AK` — SAME identity as y, tokens {w-token} (a subset, so "remove"), armed at a SYNTHETIC
// key `kForeign1AK` where a foreign `x1AK`'s own real latch sits (written AFTER every inject/boot call — a
// genuine fresh mint). (2) `q2AK` — same shape, armed at a DIFFERENT synthetic key `kForeign2AK` where a
// SECOND foreign `x2AK`'s own real latch sits. (3) `uAK` — a wholly unrelated pending entry, injected LAST.
// Processing q1AK first: its own protect call pushes x1AK's mint onto the array's tail, then q1AK's own
// slot (still at its ORIGINAL index — nothing has shifted yet) is spliced out. Processing q2AK next (from
// the snapshot, regardless of the live array's own current shape): its own protect call pushes x2AK's mint
// onto the (now longer) tail, then q2AK's own CURRENT index is resolved fresh — it has SHIFTED DOWN BY ONE
// from where it started, because q1AK's own earlier splice shifted everything after it. A stale/precomputed
// index here would splice the WRONG slot (or hit uAK, corrupting it) — only a fresh `indexOf` lookup at
// splice time gets this right. Code Review 46d6e471 measured: on a revert of ONLY the source fix, just the
// "X1/X2 blocked in-process" checks go RED; every other check below still passes pre-fix (q1AK/q2AK's own
// removal and uAK's own survival never depended on the push-loss bug at all — only the two FRESH mints do).
{
  const yAK = freshDir("akY");
  const kYAK = canonicalRepoLockKey(yAK);
  const kForeign1AK = "loom-mqcbp-AK-synthetic-foreign-key-1";
  const kForeign2AK = "loom-mqcbp-AK-synthetic-foreign-key-2";
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kYAK)}.json`), JSON.stringify({
    repoPath: yAK, branch: "w-ak-branch", reason: "W — AK, y's own real active entry", enteredAt: Date.now(), tokens: ["w-ak-token"],
  }, null, 2) + "\n");

  const q1EntryAK = {
    repoPath: yAK, branch: "q1-ak-branch", reason: "Q1 — AK, tied to y, armed at the first synthetic foreign key",
    enteredAt: Date.now(), tokens: ["w-ak-token"], armedKeys: [kForeign1AK],
  };
  setActiveQuarantineTestOnly(kForeign1AK, q1EntryAK);
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: q1EntryAK, sourceFile: "pending-ak-q1-test.json" }]);

  const q2EntryAK = {
    repoPath: yAK, branch: "q2-ak-branch", reason: "Q2 — AK, tied to y, armed at the second synthetic foreign key",
    enteredAt: Date.now(), tokens: ["w-ak-token"], armedKeys: [kForeign2AK],
  };
  setActiveQuarantineTestOnly(kForeign2AK, q2EntryAK);
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: q2EntryAK, sourceFile: "pending-ak-q2-test.json" }]);

  const uAK = path.join(os.tmpdir(), `loom-mqcbp-uAK-unrelated-${sfx}`);
  reenterMergeQuarantinesAtBootTestOnly([], [{
    entry: { repoPath: uAK, branch: "u-ak-branch", reason: "U — AK, wholly unrelated, injected after both removes, must survive untouched", enteredAt: Date.now(), tokens: ["u-ak-token"] },
    sourceFile: "pending-ak-u-test.json",
  }]);

  reenterMergeQuarantinesAtBootTestOnly([yAK], []); // the real scan — arms W at kYAK from its own real latch file

  const x1AK = path.join(os.tmpdir(), `loom-mqcbp-x1AK-never-exists-${sfx}`);
  const x2AK = path.join(os.tmpdir(), `loom-mqcbp-x2AK-never-exists-${sfx}`);
  check("(AK precondition) W active with w-ak-token", listActiveMergeQuarantines().some((e) => e.repoPath === yAK && e.tokens.includes("w-ak-token")));
  check("(AK precondition) U present, untouched", listActiveMergeQuarantines().some((e) => e.repoPath === uAK && e.tokens.includes("u-ak-token")));
  check("(AK precondition) X1/X2 unknown to memory before the clear (never scanned)", !activeMergeQuarantineFor(x1AK) && !activeMergeQuarantineFor(x2AK));

  // X1/X2's foreign records, written AFTER every inject/boot call above — never scanned into memory, so
  // the clear-time discovery below is a genuine fresh MINT for each (same technique as (AH)/(AJ)).
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kForeign1AK)}.json`), JSON.stringify({
    repoPath: x1AK, branch: "x1-ak-branch", reason: "X1 — AK, foreign occupant at hash(kForeign1AK).json",
    enteredAt: Date.now(), tokens: ["x1-ak-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(kForeign2AK)}.json`), JSON.stringify({
    repoPath: x2AK, branch: "x2-ak-branch", reason: "X2 — AK, foreign occupant at hash(kForeign2AK).json",
    enteredAt: Date.now(), tokens: ["x2-ak-token"],
  }, null, 2) + "\n");

  // Capture console.error during the clear — asserting the fix's own "expected to remove ... but it was
  // already absent" log NEVER fires, i.e. every `indexOf` lookup this call makes finds its own wrapper
  // exactly where expected (Code Review 46d6e471's explicit ask).
  const capturedErrorsAK = [];
  const realConsoleErrorAK = console.error;
  console.error = (...args) => { capturedErrorsAK.push(String(args[0] ?? "")); realConsoleErrorAK(...args); };
  let clearAK;
  try {
    clearAK = clearMergeQuarantine(yAK);
  } finally {
    console.error = realConsoleErrorAK;
  }
  check("(AK) the fix's own 'expected to remove ... already absent' log never fired", !capturedErrorsAK.some((l) => l.includes("expected to remove") && l.includes("already absent")));

  // *** THE FIX (AK, card 07e3ad30) *** — BOTH fresh mints survive IN-PROCESS, right here.
  check("*** THE FIX (AK) *** X1 reads as BLOCKED in-process right after this clear", !!activeMergeQuarantineFor(x1AK));
  check("*** THE FIX (AK) *** X2 reads as BLOCKED in-process right after this clear", !!activeMergeQuarantineFor(x2AK));
  check("(AK) listActiveMergeQuarantines() carries BOTH X1 and X2", listActiveMergeQuarantines().some((e) => e.repoPath === x1AK) && listActiveMergeQuarantines().some((e) => e.repoPath === x2AK));
  check("(AK) the clear's response names BOTH X1 and X2 in stillBlockedCoOccupants", !!clearAK && Array.isArray(clearAK.stillBlockedCoOccupants) && clearAK.stillBlockedCoOccupants.some((c) => c.repoPath === x1AK) && clearAK.stillBlockedCoOccupants.some((c) => c.repoPath === x2AK));

  // Q1, Q2, W all removed — y's own token is genuinely gone (no reduce twin this time to keep it alive).
  check("(AK) y's own w-ak-token is gone from every surviving entry", !listActiveMergeQuarantines().some((e) => e.tokens.includes("w-ak-token")));
  check("(AK) y itself is fully UNblocked (W/Q1/Q2 all lifted, nothing survives to hold it)", assertRepoNotQuarantined(yAK).ok === true);
  // U, injected AFTER both removes, must still be present with its own original token.
  check("(AK) U is STILL present, untouched, after the clear", listActiveMergeQuarantines().some((e) => e.repoPath === uAK && e.tokens.includes("u-ak-token")));

  // A REAL reboot proves X1/X2's own durable records survive and y stays unblocked.
  const rebootAK = rebootInChildProcess([yAK, x1AK, x2AK], "AK");
  check("*** THE DURABILITY PROOF (AK) *** a real reboot still blocks BOTH X1 and X2", rebootAK.refusals[x1AK] === false && rebootAK.refusals[x2AK] === false && rebootAK.activeForThese > 0);
  check("(AK) a real reboot confirms y stays unblocked", rebootAK.refusals[yAK] === true);
}

// ===================== (AL) card 0a783fb2 — /clear-by-path {repoPath} AND {id} both forward a
// content-based orphan keep as `contentKeptRepoPaths` over REAL HTTP, never folded into
// `referencingRepoPaths` — the gateway-level twin of merge-quarantine-orphan-sweep-content-aware.mjs's
// own module-level (H)/(I)/(J) proofs; this proves the ROUTE HANDLER itself forwards the new field. =====================
{
  const TMPAL = mkdtempManaged("loom-mqcbp-gw-al-");
  const PORTAL = 48700 + (process.pid % 400);
  const HAL = { host: `127.0.0.1:${PORTAL}`, origin: `http://127.0.0.1:${PORTAL}`, "content-type": "application/json" };
  const dbAL = new Db(path.join(TMPAL, "loom.db"));
  const stubAL = {};
  const appAL = await buildServer({
    db: dbAL, pty: stubAL, sessions: stubAL, mcp: stubAL, orchMcp: stubAL, platformMcp: stubAL, auditMcp: stubAL,
    userAuditMcp: stubAL, setupMcp: stubAL, runMcp: stubAL, control: stubAL, usageStatus: stubAL,
  });
  try {
    // --- (AL1) /clear-by-path {repoPath} → clearMergeQuarantineByRecordedPath's own orphan-sweep ---
    const subAL1 = freshDir("subAL1");
    enterMergeQuarantine(subAL1, "b", "sub's own genuine raise (AL1)");
    const kSubAL1 = canonicalRepoLockKey(subAL1);
    const subFinalAL1 = path.join(MERGE_QUARANTINE_DIR, `${hashKey(kSubAL1)}.json`);
    const orphanBasenameAL1 = `${createHash("sha256").update(`al1-${sfx}`).digest("hex").slice(0, 24)}.json`;
    const subRecordAL1 = JSON.parse(fs.readFileSync(subFinalAL1, "utf8"));
    subRecordAL1.orphanLatchFiles = [orphanBasenameAL1];
    fs.writeFileSync(subFinalAL1, JSON.stringify(subRecordAL1, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([subAL1]); // reload so the hand-edited orphanLatchFiles reaches memory
    check("(AL1 precondition) sub is armed, carrying the orphan reference", (listActiveMergeQuarantines().find((e) => e.repoPath === subAL1)?.orphanLatchFiles ?? []).includes(orphanBasenameAL1));
    const foreignAL1 = freshDir("foreignAL1");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameAL1), JSON.stringify({
      repoPath: foreignAL1, branch: "loom/al1-foreign-branch", reason: "foreign occupant, written AFTER boot",
      enteredAt: Date.now(), tokens: [createHash("sha256").update(`al1-token-${sfx}`).digest("hex")],
    }));
    const clearAL1 = await appAL.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAL, payload: { repoPath: subAL1 } });
    check("(AL1) POST /clear-by-path {repoPath} → 200", clearAL1.statusCode === 200);
    const bodyAL1 = clearAL1.json();
    check("*** CARD 0a783fb2 *** (AL1, route) /clear-by-path {repoPath} forwards the content-parsed keep via contentKeptRepoPaths", (bodyAL1.contentKeptRepoPaths ?? []).includes(foreignAL1));
    check("*** CARD 0a783fb2 *** (AL1, route) ...and never folds it into referencingRepoPaths", !(bodyAL1.referencingRepoPaths ?? []).includes(foreignAL1));

    // --- (AL2) /clear-by-path {id} → clearMergeQuarantineLatchFile's own pending-match branch ---
    const pAL2 = path.join(os.tmpdir(), `loom-mqcbp-pAL2-never-exists-${sfx}`);
    const orphanBasenameAL2 = `${createHash("sha256").update(`al2-${sfx}`).digest("hex").slice(0, 24)}.json`;
    // @decision 8db913e2 (Follow-up 0a783fb2, test-construction fix) — a PASS-1-sourced pending entry's
    // own sourceFile must be `<24-hex>.json` — pendingLatchIdFor's fallback (no other naming pattern
    // matches) returns everything before `.json` VERBATIM as the id, never hashing it; a `pending-al2-...`
    // basename derived an invalid, non-24-hex id and clearMergeQuarantineLatchFile refused it outright.
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(`al2-pending-${sfx}`).digest("hex").slice(0, 24)}.json`), JSON.stringify({
      repoPath: pAL2, branch: "p-al2-branch", reason: "P — AL2, unresolvable, carries the orphan reference",
      enteredAt: Date.now(), tokens: [createHash("sha256").update(`al2-token-${sfx}`).digest("hex")],
      orphanLatchFiles: [orphanBasenameAL2],
    }, null, 2) + "\n");
    reenterMergeQuarantinesAtBoot([pAL2]);
    const entryAL2 = listActiveMergeQuarantines().find((e) => e.repoPath === pAL2);
    check("(AL2 precondition) P is quarantined (pending, unresolvable), carrying the orphan reference", !!entryAL2 && (entryAL2.orphanLatchFiles ?? []).includes(orphanBasenameAL2));
    const idAL2 = quarantineLatchFileIdsFor(entryAL2)[0];
    const foreignAL2 = freshDir("foreignAL2");
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanBasenameAL2), JSON.stringify({
      repoPath: foreignAL2, branch: "loom/al2-foreign-branch", reason: "foreign occupant, written AFTER boot",
      enteredAt: Date.now(), tokens: [createHash("sha256").update(`al2-foreign-token-${sfx}`).digest("hex")],
    }));
    const clearAL2 = await appAL.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAL, payload: { id: idAL2 } });
    check("(AL2) POST /clear-by-path {id} → 200", clearAL2.statusCode === 200);
    const bodyAL2 = clearAL2.json();
    check("*** CARD 0a783fb2 *** (AL2, route) /clear-by-path {id} forwards the content-parsed keep via contentKeptRepoPaths", (bodyAL2.contentKeptRepoPaths ?? []).includes(foreignAL2));
    check("*** CARD 0a783fb2 *** (AL2, route) ...and never folds it into referencingRepoPaths", !(bodyAL2.referencingRepoPaths ?? []).includes(foreignAL2));
  } finally {
    await appAL.close();
    dbAL.close();
  }
}

// ===================== (AM) card 0a783fb2, Code Review 47289f8d — MAJOR: a SAME-IDENTITY pending twin,
// not yet cleared at orphan-sweep time, must NEVER be reported as the cleared identity's OWN still-blocked
// co-occupant. R3's own repro shape: X has an UNTIED pending twin (boot-diverted, unresolvable at the
// time) AND a SEPARATE, test-seam-armed active entry, both sharing identity X and both listing orphan F.
// Pre-fix, clearing X via ByRecordedPath processed the active entry first (via a delegated
// clearMergeQuarantineByKey call) while the pending twin was still live — that twin read as a TRUE
// referencer of F, so the result reported X as blocking ITSELF, with a route id (F's own hash) that no
// longer exists once the whole clear finishes (the pending twin's own later pass deletes F for real,
// since nothing it finds at THAT point still needs it). =====================
{
  const X = path.join(os.tmpdir(), `loom-mqcbp-x-am-${sfx}`);
  const F = `${createHash("sha256").update(`am-f-${sfx}`).digest("hex").slice(0, 24)}.json`;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // The untied pending twin — written BEFORE X exists on disk, so boot diverts it to pending.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(`am-pending-${sfx}`).digest("hex").slice(0, 24)}.json`), JSON.stringify({
    repoPath: X, branch: "pb", reason: "pr", enteredAt: Date.now(),
    tokens: [createHash("sha256").update(`am-t1-${sfx}`).digest("hex")], orphanLatchFiles: [F],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([X]);
  // X becomes resolvable, THEN gets a SEPARATE, test-seam-armed active entry at its own canonical key —
  // the "two independent raise-groups" shape (d4b25feb), never derived from the pending twin above.
  fs.mkdirSync(X, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: X });
  const keyAM = canonicalRepoLockKey(X);
  setActiveQuarantineTestOnly(keyAM, {
    repoPath: X, branch: "ab", reason: "ar", enteredAt: Date.now(),
    tokens: [createHash("sha256").update(`am-t2-${sfx}`).digest("hex")], orphanLatchFiles: [F],
  });
  check("(AM precondition) X now has TWO independent entries: one active, one untied pending, both sharing identity X", listActiveMergeQuarantines().filter((e) => e.repoPath === X).length === 2);

  const clearAM = clearMergeQuarantineByRecordedPath(X);
  check("*** THE FIX (AM, MAJOR) *** latchKept is FALSE/absent — X is never reported as its own still-blocked co-occupant", clearAM.latchKept === undefined);
  check("*** THE FIX (AM, MAJOR) *** stillBlockedCoOccupants is EMPTY — no self-reference", Array.isArray(clearAM.stillBlockedCoOccupants) && clearAM.stillBlockedCoOccupants.length === 0);
  check("*** THE FIX (AM, MAJOR) *** referencingRepoPaths is EMPTY or absent", (clearAM.referencingRepoPaths ?? []).length === 0);
  check("(AM) X genuinely has ZERO entries left — both the active entry and its untied pending twin are cleared", listActiveMergeQuarantines().filter((e) => e.repoPath === X).length === 0);
  check("(AM) a direct query for X confirms it is fully unblocked", assertRepoNotQuarantined(X).ok === true);
  // The content-safety check still runs independently — F genuinely never held any real content in this
  // scenario (no file was ever written at its own path), so it is correctly gone, not merely "unreported".
  check("(AM) F itself is gone (nothing real ever lived there, so deleting it loses nothing)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, F)));
}

// ===================== (AN) POST /internal/merge-quarantine/clear {projectId} forwards latchKept/
// referencingRepoPaths over REAL HTTP for a genuine N>1-claimants shared-latch clear-ONE-claimant shape
// (card d48465e5, item 3 — the 882d6cff round-4 docs/decisions record's own "latchKept"/"referencingRepoPaths"
// fields were, until this section, asserted only on the underlying functions, never over the real route).
// Fixture: y (marker-only git root) with absent subdirs w1AN/w2AN sharing ONE corrupt latch — boot diverts
// BOTH to pending; clearing w1AN alone (via /clear, projectId-addressed) must keep the shared file (w2AN
// still references it) and report latchKept:true + referencingRepoPaths naming w2AN, mirroring
// clearMergeQuarantineLatchFile's own long-established shape for the SAME multi-claimant situation. =====================
{
  const yAN = freshDir("yAN");
  fs.mkdirSync(path.join(yAN, ".git"), { recursive: true }); // marker-only git root — no real git needed
  const w1AN = path.join(yAN, "w1");
  const w2AN = path.join(yAN, "w2"); // both deliberately never created
  check("(AN precondition) w1AN does not exist on disk", !fs.existsSync(w1AN));
  check("(AN precondition) w2AN does not exist on disk", !fs.existsSync(w2AN));
  const sharedIdAN = quarantineLatchIdFor(w1AN);
  check("(AN precondition) w1AN and w2AN degrade to the SAME shared latch id", sharedIdAN === quarantineLatchIdFor(w2AN));
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sharedPathAN = path.join(MERGE_QUARANTINE_DIR, `${sharedIdAN}.json`);
  fs.writeFileSync(sharedPathAN, "{"); // corrupt — diverts BOTH claimants to pending, sharing this one file

  reenterMergeQuarantinesAtBoot([w1AN, w2AN]);
  check("(AN precondition) w1AN is diverted pending", !!activeMergeQuarantineFor(w1AN));
  check("(AN precondition) w2AN is diverted pending", !!activeMergeQuarantineFor(w2AN));

  const TMPAN = mkdtempManaged("loom-mqcbp-gw-an-");
  const PORTAN = 47500 + (process.pid % 400);
  const HAN = { host: `127.0.0.1:${PORTAN}`, origin: `http://127.0.0.1:${PORTAN}`, "content-type": "application/json" };
  const dbAN = new Db(path.join(TMPAN, "loom.db"));
  dbAN.insertProject({
    id: "projAN", name: "ProjAN", repoPath: w1AN, vaultPath: w1AN, config: {}, createdAt: new Date().toISOString(),
    archivedAt: null, reserved: false, referenceRepos: [], repos: [],
  });
  const stubAN = {};
  const appAN = await buildServer({
    db: dbAN, pty: stubAN, sessions: stubAN, mcp: stubAN, orchMcp: stubAN, platformMcp: stubAN, auditMcp: stubAN,
    userAuditMcp: stubAN, setupMcp: stubAN, runMcp: stubAN, control: stubAN, usageStatus: stubAN,
  });
  try {
    const clearAN = await appAN.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: HAN, payload: { projectId: "projAN" } });
    check("(AN) POST /clear {projectId} → 200", clearAN.statusCode === 200);
    const bodyAN = clearAN.json();
    check("(AN) wasQuarantined:true — w1AN's own pending record was genuinely lifted", bodyAN.wasQuarantined === true);
    check("*** THE FIX (AN, card d48465e5 item 3) *** the route forwards latchKept:true — w2AN still references the shared file", bodyAN.latchKept === true);
    check("(AN) the route forwards referencingRepoPaths naming w2AN", Array.isArray(bodyAN.referencingRepoPaths) && bodyAN.referencingRepoPaths.includes(w2AN));
    check("(AN) the shared latch file genuinely SURVIVES on disk", fs.existsSync(sharedPathAN));
    check("(AN) w1AN is lifted in-process", !activeMergeQuarantineFor(w1AN));
    check("(AN) w2AN is STILL pending in-process (never collaterally lifted)", !!activeMergeQuarantineFor(w2AN));

    // NEGATIVE CONTROL, same route: once w2AN is ALSO cleared (nothing left to reference the shared
    // file), latchKept must be OMITTED, not true — proves this check genuinely DISCRIMINATES kept from
    // not-kept, rather than the route always spreading latchKept regardless of whether anything survives.
    dbAN.insertProject({
      id: "projAN2", name: "ProjAN2", repoPath: w2AN, vaultPath: w2AN, config: {}, createdAt: new Date().toISOString(),
      archivedAt: null, reserved: false, referenceRepos: [], repos: [],
    });
    const clearAN2 = await appAN.inject({ method: "POST", url: "/internal/merge-quarantine/clear", headers: HAN, payload: { projectId: "projAN2" } });
    const bodyAN2 = clearAN2.json();
    check("(AN) NEGATIVE CONTROL: once the last claimant (w2AN) is also cleared, latchKept is OMITTED", !("latchKept" in bodyAN2));
    check("(AN) NEGATIVE CONTROL: the shared file is now actually gone", !fs.existsSync(sharedPathAN));
  } finally {
    await appAN.close();
    dbAN.close();
  }
}

// ===================== (AO) POST /internal/merge-quarantine/clear-by-path {repoPath} forwards latchKept/
// referencingRepoPaths over REAL HTTP, for the SAME shared-latch clear-ONE-claimant shape as (AN) above,
// via the no-project-resolution route (card d48465e5, item 3). =====================
{
  const yAO = freshDir("yAO");
  fs.mkdirSync(path.join(yAO, ".git"), { recursive: true }); // marker-only git root
  const w1AO = path.join(yAO, "w1");
  const w2AO = path.join(yAO, "w2"); // both deliberately never created
  check("(AO precondition) w1AO does not exist on disk", !fs.existsSync(w1AO));
  check("(AO precondition) w2AO does not exist on disk", !fs.existsSync(w2AO));
  const sharedIdAO = quarantineLatchIdFor(w1AO);
  check("(AO precondition) w1AO and w2AO degrade to the SAME shared latch id", sharedIdAO === quarantineLatchIdFor(w2AO));
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const sharedPathAO = path.join(MERGE_QUARANTINE_DIR, `${sharedIdAO}.json`);
  fs.writeFileSync(sharedPathAO, "{"); // corrupt — diverts BOTH claimants to pending, sharing this one file

  reenterMergeQuarantinesAtBoot([w1AO, w2AO]);
  check("(AO precondition) w1AO is diverted pending", !!activeMergeQuarantineFor(w1AO));
  check("(AO precondition) w2AO is diverted pending", !!activeMergeQuarantineFor(w2AO));

  const TMPAO = mkdtempManaged("loom-mqcbp-gw-ao-");
  const PORTAO = 47900 + (process.pid % 400);
  const HAO = { host: `127.0.0.1:${PORTAO}`, origin: `http://127.0.0.1:${PORTAO}`, "content-type": "application/json" };
  const dbAO = new Db(path.join(TMPAO, "loom.db"));
  const stubAO = {};
  const appAO = await buildServer({
    db: dbAO, pty: stubAO, sessions: stubAO, mcp: stubAO, orchMcp: stubAO, platformMcp: stubAO, auditMcp: stubAO,
    userAuditMcp: stubAO, setupMcp: stubAO, runMcp: stubAO, control: stubAO, usageStatus: stubAO,
  });
  try {
    const clearAO = await appAO.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAO, payload: { repoPath: w1AO } });
    check("(AO) POST /clear-by-path {repoPath} → 200", clearAO.statusCode === 200);
    const bodyAO = clearAO.json();
    check("(AO) wasQuarantined:true — w1AO's own pending record was genuinely lifted", bodyAO.wasQuarantined === true);
    check("*** THE FIX (AO, card d48465e5 item 3) *** the route forwards latchKept:true — w2AO still references the shared file", bodyAO.latchKept === true);
    check("(AO) the route forwards referencingRepoPaths naming w2AO", Array.isArray(bodyAO.referencingRepoPaths) && bodyAO.referencingRepoPaths.includes(w2AO));
    check("(AO) the shared latch file genuinely SURVIVES on disk", fs.existsSync(sharedPathAO));
    check("(AO) w1AO is lifted in-process", !activeMergeQuarantineFor(w1AO));
    check("(AO) w2AO is STILL pending in-process (never collaterally lifted)", !!activeMergeQuarantineFor(w2AO));

    // NEGATIVE CONTROL, same route: once w2AO is ALSO cleared (nothing left to reference the shared
    // file), latchKept must be OMITTED, not true — same discrimination proof as (AN) above, for the
    // {repoPath} form.
    const clearAO2 = await appAO.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAO, payload: { repoPath: w2AO } });
    const bodyAO2 = clearAO2.json();
    check("(AO) NEGATIVE CONTROL: once the last claimant (w2AO) is also cleared, latchKept is OMITTED", !("latchKept" in bodyAO2));
    check("(AO) NEGATIVE CONTROL: the shared file is now actually gone", !fs.existsSync(sharedPathAO));
  } finally {
    await appAO.close();
    dbAO.close();
  }
}

// ===================== (AP) POST /internal/merge-quarantine/clear-by-path {repoPath} forwards
// stillQuarantined/reason over REAL HTTP — the `{repoPath}` twin of (AC)'s own `{id}` proof (card
// 2a169469, round 2, minor 4). Dropping the route's own `...(stillQuarantined ? {...} : {})` spread must
// fail this. =====================
{
  const xAP = freshDir("xAP"); // active, resolvable — the HOST
  const yAP = path.join(os.tmpdir(), `loom-mqcbp-yAP-ghost-${sfx}`); // never created — unresolvable, the CONTRIBUTOR
  const kXAP = `kXAP-${sfx}`;
  const kYAP = `kYAP-${sfx}`;
  setActiveQuarantineTestOnly(kXAP, {
    repoPath: xAP, branch: "x-branch", reason: "2a169469 (AP): active X, unrelated, with Y as a contributor",
    enteredAt: Date.now(), tokens: [`x-token-ap-${sfx}`], contributorRepoPaths: [yAP],
  });
  setActiveQuarantineTestOnly(kYAP, {
    repoPath: yAP, branch: "y-branch", reason: "2a169469 (AP): Y's OWN active record",
    enteredAt: Date.now() - 1000, tokens: [`y-token-ap-${sfx}`],
  });

  const TMPAP = mkdtempManaged("loom-mqcbp-gw-ap-");
  const PORTAP = 47900 + (process.pid % 400);
  const HAP = { host: `127.0.0.1:${PORTAP}`, origin: `http://127.0.0.1:${PORTAP}`, "content-type": "application/json" };
  const dbAP = new Db(path.join(TMPAP, "loom.db"));
  const stubAP = {};
  const appAP = await buildServer({
    db: dbAP, pty: stubAP, sessions: stubAP, mcp: stubAP, orchMcp: stubAP, platformMcp: stubAP, auditMcp: stubAP,
    userAuditMcp: stubAP, setupMcp: stubAP, runMcp: stubAP, control: stubAP, usageStatus: stubAP,
  });
  try {
    const clearAP = await appAP.inject({ method: "POST", url: "/internal/merge-quarantine/clear-by-path", headers: HAP, payload: { repoPath: yAP } });
    check("(AP) POST /clear-by-path {repoPath} (Y, a contributor of active X) → 200", clearAP.statusCode === 200);
    const bodyAP = clearAP.json();
    check("(AP) ok:true, wasQuarantined:true", bodyAP.ok === true && bodyAP.wasQuarantined === true);
    check("*** THE FIX (AP) *** Y is NOT in liftedRepoPaths (never a false success)", !bodyAP.liftedRepoPaths.includes(yAP));
    check("*** THE FIX (AP, minor 4) *** the route forwards stillQuarantined:true", bodyAP.stillQuarantined === true);
    check("*** THE FIX (AP, minor 4) *** the route forwards reason, naming the host X", typeof bodyAP.reason === "string" && bodyAP.reason.includes(xAP));
    check("(AP) a direct query for Y still correctly refuses", !assertRepoNotQuarantined(yAP).ok);
  } finally {
    await appAP.close();
    dbAP.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /internal/merge-quarantine/clear-by-path (repoPath AND id addressing, exactly-one-of validation, path-traversal id rejection), GET /internal/merge-quarantine/list (id/registered projection, incl. a dual-armed entry's own id/ids BEFORE it's cleared), the shared clearMergeQuarantineReporting helper (no drift between /clear and /clear-by-path), partitionQuarantinesByRegistration / db.listAllRegisteredRepoPaths (live + multi-repo + archived registration, never swallowing a registered+quarantined repo into the orphan bucket, and a registered-path spelling variant), clearMergeQuarantineLatchFile's round-2/3 fixes, quarantineLatchFileIdsFor's round-3 real-file-first ordering, clearMergeQuarantineByRecordedPath's round-4/5 stored-repoPath-addressed clear (the `{repoPath}` form's own immunity to key drift, clearing every matching active entry, and the pending-fallback drift) and legacyQuarantineHashFor's byte-identical behavior, PLUS round 6's governing-rule fixes — pending entries are matched by stored directPathIdentity, never a freshly re-walked canonicalRepoLockKey, at every site: (T) enterMergeQuarantine's pending-merge no longer adopts an unrelated pending entry's identity for a fresh raise, (U) clearMergeQuarantineByRecordedPath's pending branch drops EVERY identity-matching pending entry, (V) assertRepoNotQuarantined names the BLOCKING entry's own repoPath/latch id and points at /clear-by-path, and (W) partitionQuarantinesByRegistration no longer mis-registers a pending entry via an enclosing repo's key — all behave as designed (cards c0be9bf9, abccee85). Round 7: (X) clearMergeQuarantineByRecordedPath's own last-resort fallback no longer recomputes a fresh key from a never-quarantined (typo'd) given path — it reports not-found instead of collaterally lifting an unrelated enclosing repo's real quarantine. Card 6237bef6: (P)/(P2)/(P-SHARED) turn card abccee85's traced-not-fixed gap into hard, two-way checks — a pending entry's own orphanLatchFiles are now actually swept on clear, at all three pending-removal sites (clearMergeQuarantineByKey, clearMergeQuarantineLatchFile, and clearMergeQuarantineByRecordedPath, the third abccee85 never named), and an orphan file still referenced by a SURVIVING entry (active or pending) is never deleted out from under it. Card 9cabd143: (Y) the sweep never deletes a filename a SURVIVING entry has since legitimately reclaimed as its own live physical latch (proven across a real restart, in a separate child process), (Z1)/(Z1-route) close the SAME gap at clearMergeQuarantineLatchFile's raw-fallback bypass site (over both the function and the real HTTP route), now reporting `latchKept`/`referencingRepoPaths` instead of a bare `ok:true` when a file survives. Round 2 (Code Review d37fd1aa): (Z2) is RE-POINTED — clearing a PENDING entry by id deletes its OWN file even when an unrelated entry's `orphanLatchFiles` merely lists it (check 1 alone must never protect an entry's own file; only genuine ownership, check 2, may), proven to stick across a real child-process restart and to agree with `/clear`/`/clear-by-path {repoPath}`; (AA) proves check (2)'s PENDING-ownership half is genuinely reachable (not just defensive) via the ordinary orphan-reference sweep; (AB) proves check (2)'s ACTIVE-ownership half also covers an entry's TRUE current write target (`quarantinePathFor`), not only its own (possibly stale, post-drift) `armedKeys`. Card 07e3ad30: (AJ) clearMergeQuarantineByKey's own pending-loop no longer loses a mid-iteration protect-call push to a `.filter()` reassignment — a foreign occupant's fresh mint, triggered by the remove branch, now survives IN-PROCESS (not just after a reboot), interleaved in one pass with an unrelated reduce and two wholly-unrelated pending entries that must (and do) survive untouched. (AK), added per Code Review 46d6e471: TWO sequential remove twins in one pass — the second twin's own splice index is correctly re-resolved after the array has both shrunk (the first twin's own removal) and grown (the first twin's own push) in between, with no stale-index corruption of the unrelated entry injected after both, and the fix's own defensive 'already absent' log never fires. Card 0a783fb2: (AL) both /clear-by-path forms (repoPath AND id) forward a content-based orphan keep over real HTTP as contentKeptRepoPaths, never folded into referencingRepoPaths — the gateway-level twin of merge-quarantine-orphan-sweep-content-aware.mjs's own module-level proofs. Code Review 47289f8d (round 2): (AM) a same-identity pending twin, not yet cleared at orphan-sweep time, is never reported as the cleared identity's own still-blocked co-occupant (the MAJOR self-reference fix, via excludeIdentities on sweepOrphanLatchFileIfUnreferenced). Card d48465e5 (item 3): (AN)/(AO) close the real-HTTP test gap for the 882d6cff round-4 clear-one-claimant shape — both /clear {projectId} and /clear-by-path {repoPath} forward latchKept:true + referencingRepoPaths over a real app.inject() call when a shared latch still has another pending claimant. Card 2a169469 (round 2, minor 4): (AP) /clear-by-path {repoPath} forwards stillQuarantined:true + reason over real HTTP for a contributor-blocked identity — the {repoPath} twin of (AC)'s own {id} proof."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
