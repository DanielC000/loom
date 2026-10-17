import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a9174861 — two round-2 fixes in merge-quarantine.ts (card 6c04633d / docs/decisions/8db913e2-*.md,
// Round 2) have no test that catches their removal: all merge-quarantine*.mjs stay green when either is
// deleted. This file pins both, each proven RED by a single-line mutation of the exact fixed line.
//
//   (1) orphanRewriteOwnershipConfirmed's `keptUnreadableLatchFiles.has(orphanFile)` skip
//       (merge-quarantine.ts, inside orphanRewriteOwnershipConfirmed). If it regresses, an A-identity
//       orphan file marked kept (its tokens never folded in after a transient read failure) gets
//       rewritten with `updated`'s tokens — any token only that file held is durably dropped, bypassing
//       writeMergeQuarantineLatch's own reconcile chokepoint.
//   (2) the M2 stamp inside consumeMatchedPendingsIntoArmedEntry's raise-divert branch
//       (resolvedKey/armedKeys/provenanceTracked stamped onto `raiserUnion`). If it regresses, a FRESH
//       pending-divert record minted on that branch loses its own resolvedKey/provenanceTracked, so a
//       later query that must reach it via findPendingIndicesFor's resolvedKey tier (merge-quarantine.ts,
//       ~3865-3874) fails open after a reboot.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-round2-pins.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqr2p-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR, enterMergeQuarantine,
  clearMergeQuarantineByToken, activeMergeQuarantineFor,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

function contentIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqr2p@loom -c user.name=mqr2p";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqr2p-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-round2-pins (${tag})\n`);
  execSync(`git init -q && git config user.email mqr2p@loom && git config user.name mqr2p`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Mirrors merge-quarantine.ts's own `directPathIdentity` (unexported) — realpath, lowercased on win32.
function identityOf(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function finalBasenameForKey(key) {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`;
}

// Mirrors merge-quarantine.ts's own `pendingDivertCollisionFilenameFor` shape — used only to assert a
// collision file was NOT minted (site 2's loud fresh-divert check).
function isCollisionFileFor(repoPath, basename) {
  const prefix = `pending-${createHash("sha256").update(identityOf(repoPath)).digest("hex").slice(0, 24)}-collision-`;
  return basename.startsWith(prefix);
}

// Fails ONLY the read(s) of `targetPath` whose call-index is IN `indices` (1-based) — every other call
// succeeds normally. Mirrors merge-quarantine-raise-protect-failure.mjs's own helper of the same name.
function injectReadFailureAtCalls(targetPath, indices, code = "EACCES") {
  const real = fs.readFileSync;
  const idxSet = new Set(indices);
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (idxSet.has(callCount)) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SITE 1 ("orphan-kept-mark-blocks-rewrite") — pins orphanRewriteOwnershipConfirmed's own
  // `keptUnreadableLatchFiles.has(orphanFile)` skip, in isolation from its other two layers (structural
  // ownership, content/token-accounting), both of which are proven to pass on their own below.
  //
  // Fixture: A is raised twice (t1, t2 — two tokens, so a later clear of t2 is PARTIAL, reaching
  // rewriteOrphanLatchFilesAfterPartialClear). A's own real final JSON is hand-edited to list a SEPARATE
  // file (T's own canonical-key final path, never actually raised FOR T itself) as an `orphanLatchFile` —
  // a stand-in for the real production path, same technique this project's own 29fe2372 scenarios use
  // (merge-quarantine-raise-protect-failure.mjs), labeled as such there and here. A fresh-process reboot
  // re-parses A's file so its in-memory entry genuinely carries the orphanLatchFiles reference.
  //
  // T's own final path is then hand-written DIRECTLY with the fixture's actual target content — A's own
  // identity, holding t2 (the token about to be partially cleared) — and marked `keptUnreadableLatchFiles`
  // via a SINGLE throwaway raise on a real (mkdirSync'd) subdirectory of T, never T itself: that raise
  // degrades (canonicalRepoLockKey walks up) to T's own canonical key, finds NO existing active entry
  // there (T itself was never raised through enterMergeQuarantine), and reaches the "verified branch's
  // protect-before-anything" region (merge-quarantine.ts, inside enterMergeQuarantine's own `if (verified)`
  // block, just before pendingIndices are collected) — protectDegradedOccupantBeforeDelete's own read of
  // T's final is forced to fail (call #1), marking the basename kept; resolveRaiseOverwrite's own
  // independent re-read (call #2) is ALSO forced to fail, so mustDivert resolves true and the throwaway
  // raise's own token is diverted to ITS OWN pending record (the subdir's own distinct identity) WITHOUT
  // ever writing to — or reading successfully from — T's own final. T's final is therefore left exactly as
  // hand-written, marked kept, with no live active or pending entry (T's or the subdir's) structurally
  // owning it. Empirically verified via scratch probes before being encoded here (both the two-read
  // ordering and the "no intermediate write touches it" property).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const A = makeToplevelRepo("s1-a");
  const T = makeToplevelRepo("s1-t");
  const Ka = canonicalRepoLockKey(A);
  const Kt = canonicalRepoLockKey(T);
  const aFinalPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKey(Ka));
  const tFinalPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKey(Kt));
  const tFinalBasename = path.basename(tFinalPath);

  reenterMergeQuarantinesAtBoot([]);
  const t1 = enterMergeQuarantine(A, "a-branch", "s1 A raise 1");
  const t2 = enterMergeQuarantine(A, "a-branch-2", "s1 A raise 2");

  // Stand-in hand-edit (see header comment above) — A's own durable file gains an orphanLatchFiles
  // reference to T's own (not-yet-written) final path.
  const aRaw = JSON.parse(contentIfExists(aFinalPath));
  aRaw.orphanLatchFiles = [tFinalBasename];
  fs.writeFileSync(aFinalPath, JSON.stringify(aRaw, null, 2) + "\n");

  const freshS1 = await freshBootModule();
  freshS1.reenterMergeQuarantinesAtBoot([A]);
  const aEntryPostBoot = freshS1.listActiveMergeQuarantines().find((e) => e.repoPath === A);
  check("(s1 precondition) A carries the orphanLatchFiles reference to T's final post-boot",
    (aEntryPostBoot?.orphanLatchFiles ?? []).includes(tFinalBasename));
  check("(s1 precondition) A's tokens post-boot are {t1,t2}",
    new Set(aEntryPostBoot?.tokens ?? []).size === 2 && (aEntryPostBoot?.tokens ?? []).includes(t1) && (aEntryPostBoot?.tokens ?? []).includes(t2));

  // Hand-write T's own final DIRECTLY with the fixture's target content — A's own identity, holding t2.
  fs.writeFileSync(tFinalPath, JSON.stringify({
    repoPath: A, branch: "a-branch", reason: "s1 fixture: A's own identity, holding t2", enteredAt: Date.now(), tokens: [t2],
  }, null, 2) + "\n");
  check("(s1 precondition) the fixture file's own identity matches A's (layer 2/3's content-identity check will see this)",
    identityOf(JSON.parse(contentIfExists(tFinalPath)).repoPath) === identityOf(A));

  // ONE throwaway raise on a real subdir of T — never T itself — marks T's own final kept without ever
  // touching its bytes (see header comment for the exact call-ordering this relies on).
  const tSub = path.join(T, "throwaway-subdir");
  fs.mkdirSync(tSub, { recursive: true });
  const injectS1 = injectReadFailureAtCalls(tFinalPath, [1, 2]);
  let tSubToken;
  try {
    tSubToken = freshS1.enterMergeQuarantine(tSub, "t-sub-branch", "s1 throwaway raise to mark T's final kept");
  } finally {
    injectS1.restore();
  }
  check("(s1 precondition) the throwaway raise's own read of T's final was actually attempted (both injected calls fired)",
    injectS1.count() >= 2);
  check("(s1 precondition) T's final is UNTOUCHED by the throwaway raise — still the fixture content, holding t2",
    (contentIfExists(tFinalPath) ?? "").includes(t2));

  // Precondition (manager note 3): no live entry (active OR pending — listActiveMergeQuarantines merges
  // both) structurally owns T's final via its own armedKeys hashing to it — the exact thing
  // physicalOwnerRepoPaths/anotherLiveEntryOwnsFile would otherwise object to, proven absent here so a RED
  // with line 2947 removed can only be attributed to that one line, never to a layer-1/layer-2 conflict.
  const noStructuralOwner = freshS1.listActiveMergeQuarantines().every((e) => !(e.armedKeys ?? []).some((k) => finalBasenameForKey(k) === tFinalBasename));
  check("(s1 precondition) no live entry's own armedKeys hashes to T's final (no structural owner)", noStructuralOwner);

  // Partial clear of A's t2 (t1 remains outstanding) — reaches rewriteOrphanLatchFilesAfterPartialClear →
  // orphanRewriteOwnershipConfirmed(tFinalBasename, updatedA, t2).
  freshS1.clearMergeQuarantineByToken(A, t2);
  check("*** THE FIX (a9174861, site 1) *** T's final still contains t2 — the kept-mark alone refused the rewrite (layers 1-3 would otherwise all pass, per the preconditions above)",
    (contentIfExists(tFinalPath) ?? "").includes(t2));
  const tokensAfterS1 = new Set(freshS1.listActiveMergeQuarantines().flatMap((e) => e.tokens ?? []));
  check("(s1) A's own t1 remains outstanding, t2 is gone from A's own in-memory record (the clear itself still worked)",
    tokensAfterS1.has(t1) && !tokensAfterS1.has(t2));

  freshS1.clearMergeQuarantineByToken(A, t1);
  freshS1.clearMergeQuarantineByToken(tSub, tSubToken);
  // T's own final was hand-written and never owned by any live entry (that's the whole point of this
  // fixture) — nothing clears it on its own; remove it explicitly so it can't contaminate a later
  // scenario's own boot (MERGE_QUARANTINE_DIR is shared across this whole file's single LOOM_HOME).
  fs.rmSync(tFinalPath, { force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SITE 2 ("m2-stamp-fresh-divert") — pins the M2 stamp (resolvedKey/armedKeys/provenanceTracked) stamped
  // onto `raiserUnion` inside consumeMatchedPendingsIntoArmedEntry's raise-divert branch, reached via
  // divertRaiseEntry's FRESH-divert path (mintPendingDivert — indices.length === 0), never the
  // merge-into-existing-pending branch.
  //
  // Fixture: A raises once while UNRESOLVABLE (rmSync'd away first) — per d4b25feb's own "brand new while
  // unresolvable" branch, this mints an INDEPENDENT pending divert record P (no active-map entry at all).
  // A is then re-created (resolvable again) and A's own would-be final path is pre-seeded with dummy,
  // valid-but-unusable JSON (nothing has ever written there, since the only prior raise went straight to
  // the pending record). A raises AGAIN — this second raise's own three reads of its own final are each
  // individually targeted: read #1 (protectDegradedOccupantBeforeDelete, since no `existing` active entry
  // exists yet) is forced to fail, marking the basename kept; read #2 (resolveRaiseOverwrite's own
  // independent re-read) is left to succeed — it reads the dummy JSON, finds no usable `repoPath`, and
  // resolves "proceed" (mustDivert=false), so the raise falls through to the allPendingIndices branch and
  // finds P; read #3 (consumeMatchedPendingsIntoArmedEntry's own foldInOnDiskTokensIfMarked →
  // reconcileMarkedBasenameBeforeWrite) is forced to fail again, which is what actually returns the
  // literal "unreadable" that routes into the raise-divert branch and the M2 stamp. This exact 3-read
  // ordering was verified empirically (a scratch probe printing each call's real stack trace) before being
  // encoded as [1, 3] below — see the worker report for this card.
  //
  // Because `consumeMatchedPendingsIntoArmedEntry` always splices every matched pending index (here: P)
  // out of `pendingUnresolvedQuarantines` BEFORE building `raiserUnion` (merge-quarantine.ts, the splice at
  // the top of that function, unconditional for every caller), nothing matching raiserUnion's own identity
  // remains in that array by the time `divertRaiseEntry(raiserUnion)` runs — so its own
  // `collectPendingIndices` call is STRUCTURALLY guaranteed to find zero matches here, taking the
  // FRESH-divert branch (mintPendingDivert), never the merge-into-existing-pending one. The loud,
  // regression-trip-wire checks below assert the OBSERVABLE consequences of that: no `-collision-` file
  // was minted (which the OTHER branch's own union-into-primary path could produce on a future change),
  // and exactly one physical record exists for A's identity.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const A = makeToplevelRepo("s2-a");
  const Ka = canonicalRepoLockKey(A);
  const aFinalPath = path.join(MERGE_QUARANTINE_DIR, finalBasenameForKey(Ka));

  reenterMergeQuarantinesAtBoot([]);
  fs.rmSync(A, { recursive: true, force: true });
  const t1 = enterMergeQuarantine(A, "p-branch", "s2 raise 1, unresolvable -> independent pending P");
  check("(s2 precondition) raise 1 produced an independent PENDING record, no active entry for A yet",
    listActiveMergeQuarantines().filter((e) => e.repoPath === A).length === 1 && !(listActiveMergeQuarantines().find((e) => e.repoPath === A)?.armedKeys?.length));

  fs.mkdirSync(A, { recursive: true });
  fs.writeFileSync(path.join(A, "README.md"), "# s2 reinit\n");
  execSync(`git init -q && git config user.email mqr2p@loom && git config user.name mqr2p`, { cwd: A });
  commitAll(A, "reinit", GIT_ID);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(aFinalPath, JSON.stringify({ dummy: true }, null, 2) + "\n");

  const injectS2 = injectReadFailureAtCalls(aFinalPath, [1, 3]);
  let t2;
  try {
    t2 = enterMergeQuarantine(A, "p-branch-2", "s2 raise 2, resolvable again, must hit the M2 stamp");
  } finally {
    injectS2.restore();
  }
  check("(s2 precondition) all three targeted reads of A's own final were actually attempted", injectS2.count() === 3);

  const entriesForA = listActiveMergeQuarantines().filter((e) => e.repoPath === A);
  check("*** THE FIX (a9174861, site 2) *** exactly one record survives for A's identity (the FRESH-divert branch, never a second, separate merge-into-existing record)",
    entriesForA.length === 1);
  const diverted = entriesForA[0];
  check("*** THE FIX (a9174861, site 2) *** the FRESH-divert record carries resolvedKey === key (the M2 stamp)",
    diverted?.resolvedKey === Ka);
  check("*** THE FIX (a9174861, site 2) *** the FRESH-divert record carries provenanceTracked === true (the M2 stamp)",
    diverted?.provenanceTracked === true);
  check("(s2) both tokens are enforced on the one surviving record",
    new Set(diverted?.tokens ?? []).has(t1) && new Set(diverted?.tokens ?? []).has(t2));

  // Loud fresh-divert-branch tripwire (manager note 2): no `-collision-` file was minted for A's identity
  // — the shape the merge-into-existing-pending branch's own union-into-primary path could otherwise leave
  // behind on a future regression that stops splicing P out before divertRaiseEntry runs.
  const dirFiles = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const collisionFiles = dirFiles.filter((f) => isCollisionFileFor(A, f));
  check("(s2) no -collision- file was minted for A's identity (confirms the FRESH-divert path, not a collision union)",
    collisionFiles.length === 0);

  // Reboot: the stamp must survive a fresh-process reload (checked directly, tier-agnostic).
  const freshS2 = await freshBootModule();
  freshS2.reenterMergeQuarantinesAtBoot([]);
  const onDiskEntry = freshS2.listActiveMergeQuarantines().find((e) => e.repoPath === A);
  check("(s2, reboot) the record survives a fresh-process reload with both tokens intact",
    new Set(onDiskEntry?.tokens ?? []).has(t1) && new Set(onDiskEntry?.tokens ?? []).has(t2));
  check("*** THE FIX (a9174861, site 2, reboot) *** on-disk, the reloaded record still carries resolvedKey === key and provenanceTracked (the M2 stamp round-trips through serialization)",
    onDiskEntry?.resolvedKey === Ka && onDiskEntry?.provenanceTracked === true);

  // A direct query for A, still unresolvable, satisfies the card's own "a query finds it" ask — but
  // NAMED FOR WHAT IT DOES NOT ISOLATE: findPendingIndicesFor's tier 1 (direct identity) matches this
  // EXACT repoPath string regardless of resolvedKey, so this check alone does not prove the query reaches
  // SPECIFICALLY tier 4 (the resolvedKey-gated tier, merge-quarantine.ts ~3865-3874). Isolating tier 4
  // would need the query's OWN canonicalRepoLockKey to still resolve to A's key via a DIFFERENT ancestor
  // walk while A's own exact repoPath stays unresolvable — contradictory once A's own `.git` is removed
  // (verified empirically: a non-existent leaf under a REMOVED A no longer walks up to the SAME key at
  // all, so that query fails for both the fixed and the mutated build alike, proving nothing). The direct
  // in-memory and on-disk-post-reboot assertions above already cover "load-bearing, not cosmetic" from the
  // persistence angle; this check only adds the literal "a query finds it" the card also asked for.
  const queried = freshS2.activeMergeQuarantineFor(A);
  check("(s2, reboot) a direct query for A finds the diverted record (via tier 1 here — see the note above for what this does not isolate)",
    !!queried && new Set(queried.tokens ?? []).has(t1) && new Set(queried.tokens ?? []).has(t2));

  freshS2.clearMergeQuarantineByToken(A, t1);
  freshS2.clearMergeQuarantineByToken(A, t2);
  // The dummy `{dummy:true}` placeholder hand-written at A's own hash (pre-divert setup, never owned by
  // any live entry once the raise diverted elsewhere) is left as a corrupt orphan at that same hash —
  // harmless to this file's own throwaway LOOM_HOME, but removed explicitly for tidiness.
  fs.rmSync(aFinalPath, { force: true });
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both card a9174861 round-2 regression pins hold: orphanRewriteOwnershipConfirmed's " +
    "keptUnreadableLatchFiles skip (site 1) and consumeMatchedPendingsIntoArmedEntry's raise-divert M2 " +
    "stamp (site 2) are each covered, with their other discriminating layers proven to pass independently."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
