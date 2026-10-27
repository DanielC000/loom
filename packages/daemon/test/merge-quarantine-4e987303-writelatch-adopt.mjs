import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 4e987303 — a caller that re-pointed memory to its own `updated` entry BEFORE calling
// writeMergeQuarantineLatch(..., reconciledAlready:false) never saw what that write's own internal
// reconcile actually persisted. See the decision record for the full per-caller table and the fix.
//
// writeLatchAndAdopt is now the ONE call site (enforced by merge-quarantine-writelatch-chokepoint-
// guard.mjs), returning the entry it actually wrote and re-pointing memory to it when it diverged.
//
// SCENARIO 1 ("4e987303-s1-reduceForeignUnionContributor") — the card's own probed case, CR probe shape:
// scenario 2 of merge-quarantine-84c1046f-reingest-field-drop.mjs (a reduceForeignUnionContributor write
// that reingests a just-recovered genuine record), followed by a PLAIN second raise. Pre-fix, the plain
// raise's own write (mark already cleared by the reduce's own successful write) persists the STALE
// pre-reconcile placeholder straight over the just-recovered genuine record — durably destroying the
// genuine token. Post-fix, memory already matches what was persisted, so the plain raise's own write only
// ever APPENDS.
//
// SCENARIO 2 ("4e987303-s2-clearActiveEntryTokenAtKey") — the token-clear route: a partial
// clearMergeQuarantineByToken clear (one of two outstanding tokens) reaches clearActiveEntryTokenAtKey's
// own armed-key write loop while that key's basename is marked and the genuine on-disk record there
// (same identity) carries an extra outstanding token the in-memory copy never saw (the GENERIC,
// non-reingest reconcile branch — a sibling shape to scenario 1's reingest branch).
//
// SCENARIO 3 ("4e987303-s3-secondary-armed-key") — the SEVENTH gap, found during the investigate-first
// checkpoint, not one of the card's own six named callers: enterMergeQuarantine's own "existing" branch
// passes `reconciledAlready: isPrimaryKey` to its per-armed-key write loop — true for the raise's own
// fresh PRIMARY key (pre-folded), but false for a SECONDARY armed key. A dual-armed entry whose
// SECONDARY key's own basename is marked reconciles internally on that write, and pre-fix the caller
// never adopted it either.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-4e987303-writelatch-adopt.mjs
// Solo runtime measured well under the 60s TEST_TIMEOUT_OVERRIDES threshold.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq4e9873-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineByToken,
  setActiveQuarantineTestOnly, markLatchFileUnreadableTestOnly, listActiveMergeQuarantines,
  PLACEHOLDER_BRANCH_UNREADABLE, pushPendingQuarantineTestOnly, clearMergeQuarantineLatchFile,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const note = (label) => console.log(`NOTE  ${label}`);
const GIT_ID = "-c user.email=mq4e9873@loom -c user.name=mq4e9873";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Same-identity check independent of spelling (case, `/` vs `\`) — matches the CR's own probe.
const ident = (p) => fs.realpathSync.native(p).toLowerCase();
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// @decision 9c681680 — registerForCleanup (never a bare mkdir-and-forget): an empty os.tmpdir() dir left
// behind per call leaks across every run of this file.
function freshRepo(tag) {
  const p = path.join(os.tmpdir(), `loom-mq4e9873-${tag}-${freshSfx()}`);
  fs.mkdirSync(p, { recursive: true });
  registerForCleanup(p);
  return p;
}

function makeRepoWithTwoSubdirs(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq4e9873-repo-${tag}-${freshSfx()}`);
  const dSub = path.join(repo, "d-sub");
  const sSub = path.join(repo, "s-sub");
  fs.mkdirSync(dSub, { recursive: true });
  fs.mkdirSync(sSub, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-4e987303-writelatch-adopt (${tag})\n`);
  execSync(`git init -q && git config user.email mq4e9873@loom && git config user.name mq4e9873`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, dSub, sSub };
}

function parkAt(key, repoPath, tag, tokens, extra = {}) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000, ...extra,
  }, null, 2) + "\n");
}

function injectPersistentReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) throw Object.assign(new Error(`${code}: simulated`), { code });
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; } };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — reduceForeignUnionContributor, the card's own probed case (CR probe shape, 84c1046f's
// own scenario 2), followed by a PLAIN second raise.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const { dSub, sSub } = makeRepoWithTwoSubdirs("s1");
  const key = canonicalRepoLockKey(sSub);
  check("(precondition) dSub and sSub share one canonical key", canonicalRepoLockKey(dSub) === key);

  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: sSub, branch: "s1-GENUINE", reason: "s1: sSub's own genuine durable raise",
    enteredAt: Date.now() - 60_000, tokens: ["s1-GENUINE-TOKEN"],
  }, null, 2) + "\n");

  const inject = injectPersistentReadFailure(finalPath);
  reenterMergeQuarantinesAtBoot([sSub]);
  activeMergeQuarantineFor(sSub); // graduate the lone placeholder (still placeholder — unreadable)

  enterMergeQuarantine(dSub, "s1-d-branch-fresh", "s1: dSub's fresh raise while sSub's latch is unreadable");
  check("(precondition) sSub entry carries dSub as contributor", (activeMergeQuarantineFor(dSub)?.contributorRepoPaths ?? []).includes(dSub));

  inject.restore();

  // dSub owns no key of its own -> routes to reduceForeignUnionContributor.
  const reduceResult = clearMergeQuarantine(dSub);
  note(`(s1) clearMergeQuarantine(dSub) => ${JSON.stringify(reduceResult)}`);

  const onDiskAfterReduce = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  check("(sanity) disk reingested the genuine record (token present)", (onDiskAfterReduce.tokens ?? []).includes("s1-GENUINE-TOKEN"));
  check("(sanity) disk no longer placeholder-shaped", !onDiskAfterReduce.branch?.includes("UNREADABLE"));

  const memEntryAfterReduce = activeMergeQuarantineFor(sSub);
  check("*** THE FIX *** memory ALREADY matches what the reduce's own write persisted (no longer the stale placeholder)", memEntryAfterReduce?.placeholder !== true && memEntryAfterReduce?.branch === "s1-GENUINE");
  check("*** THE FIX *** memory carries the genuine token too", (memEntryAfterReduce?.tokens ?? []).includes("s1-GENUINE-TOKEN"));

  // Now a PLAIN second raise for sSub — the keptUnreadableLatchFiles mark was already cleared by the
  // successful reduce-write above, so this write takes NO internal reconcile path at all; it just
  // persists whatever enterMergeQuarantine built from the (now-correct) in-memory entry.
  const secondToken = enterMergeQuarantine(sSub, "s1-branch-second", "s1: sSub's second raise");
  const onDiskAfterSecondRaise = JSON.parse(fs.readFileSync(finalPath, "utf8"));

  check("*** THE FIX *** GENUINE-TOKEN SURVIVES the second raise on disk", (onDiskAfterSecondRaise.tokens ?? []).includes("s1-GENUINE-TOKEN"));
  check("*** THE FIX *** disk's branch is STILL the genuine one (never reverted to a placeholder shape)", onDiskAfterSecondRaise.branch === "s1-GENUINE");
  check("(sanity) the second raise's own token is ALSO present (an append, not a replace)", (onDiskAfterSecondRaise.tokens ?? []).includes(secondToken));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — clearActiveEntryTokenAtKey's own armed-key write (the token-clear route), via the
// GENERIC (non-reingest) reconcile branch: a genuinely older on-disk record carries an extra outstanding
// token the in-memory copy never saw.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s2-y");
  const k = canonicalRepoLockKey(y);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);

  parkAt(k, y, "s2-ondisk", ["ta", "s2-ondisk-only-token"]);
  setActiveQuarantineTestOnly(k, { repoPath: y, branch: "s2-mem-branch", reason: "s2: in-memory copy, narrower than disk", tokens: ["ta", "tb"], armedKeys: [k], enteredAt: Date.now() });
  markLatchFileUnreadableTestOnly(path.basename(finalPath));

  check("(precondition) Y active in-memory with {ta,tb}, missing the on-disk-only token", listActiveMergeQuarantines().some((e) => e.repoPath === y && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["ta", "tb"])));

  clearMergeQuarantineByToken(y, "ta"); // partial clear (tb remains) -> clearActiveEntryTokenAtKey's armed-key loop

  const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
  note(`(s2) in-memory Y after the partial clear: ${JSON.stringify(memAfter)}`);
  check("*** THE FIX *** memory ADOPTS the on-disk-only token the write's own reconcile recovered", !!memAfter && memAfter.tokens.includes("s2-ondisk-only-token"));
  check("(sanity) ta is genuinely gone", !!memAfter && !memAfter.tokens.includes("ta"));
  check("(sanity) tb survives", !!memAfter && memAfter.tokens.includes("tb"));

  const onDiskAfter = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  check("(sanity) disk itself carries the same union memory now does", JSON.stringify([...onDiskAfter.tokens].sort()) === JSON.stringify([...memAfter.tokens].sort()));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — the SEVENTH gap (found during the investigate-first checkpoint, not one of the card's own
// six named callers): enterMergeQuarantine's "existing" branch passes `reconciledAlready: isPrimaryKey`
// to its per-armed-key loop — a SECONDARY armed key's own write (reconciledAlready:false) can reconcile
// internally too, and pre-fix the caller never adopted that either.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s3-y");
  const k1 = canonicalRepoLockKey(y);
  const v = freshRepo("s3-v"); // only to mint a stable, distinct SECONDARY key k2
  const k2 = canonicalRepoLockKey(v);
  const k1FinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
  const k2FinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);

  parkAt(k1, y, "s3-k1-ondisk", ["t0"]);
  parkAt(k2, y, "s3-k2-ondisk", ["t0", "s3-k2-only-token"]); // SAME identity (y) as the in-memory entry

  const existingEntry = { repoPath: y, branch: "s3-mem-branch", reason: "s3: existing, dual-armed", tokens: ["t0"], armedKeys: [k1, k2], identityAtRaise: k1, enteredAt: Date.now() - 5_000 };
  setActiveQuarantineTestOnly(k1, existingEntry);
  setActiveQuarantineTestOnly(k2, existingEntry);
  markLatchFileUnreadableTestOnly(path.basename(k2FinalPath)); // ONLY the SECONDARY key is marked

  check("(precondition) Y is dual-armed at k1 AND k2, in-memory", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.armedKeys?.includes(k1) && e.armedKeys?.includes(k2)));

  const freshToken = enterMergeQuarantine(y, "s3-fresh-branch", "s3: fresh raise while dual-armed");

  const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
  note(`(s3) in-memory Y after the raise: ${JSON.stringify(memAfter)}`);
  check("*** THE FIX *** memory ADOPTS the SECONDARY key's own reconciled token too", !!memAfter && memAfter.tokens.includes("s3-k2-only-token"));
  check("(sanity) the fresh raise's own token is present", !!memAfter && memAfter.tokens.includes(freshToken));
  check("(sanity) t0 survives", !!memAfter && memAfter.tokens.includes("t0"));

  const k2OnDiskAfter = JSON.parse(fs.readFileSync(k2FinalPath, "utf8"));
  check("(sanity) k2's own final carries the same union memory now does", memAfter.tokens.every((t) => (k2OnDiskAfter.tokens ?? []).includes(t)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — the CR MAJOR: a dual-armed placeholder Y whose TWO keys are BOTH marked, each with its
// own DIFFERENT genuine on-disk record (distinct contributorRepoPaths/orphanLatchFiles). Key k1's own
// reingest promotes the entry out of placeholder shape BEFORE k2's own write ever runs — so k2's write
// takes the GENERIC (non-reingest) branch, which, before this round's fix, carried forward only
// tokens/resolvedKeys/identity and silently dropped k2's own contributorRepoPaths/orphanLatchFiles from
// memory AND from BOTH physical files on the next write. RED on commit a9e1673a (this card's own first
// round); GREEN after the generic-branch both-sides-union fix.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s4-y");
  const k1 = canonicalRepoLockKey(y);
  const v = freshRepo("s4-v"); // only to mint a stable, distinct SECOND key k2
  const k2 = canonicalRepoLockKey(v);
  const k1FinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`);
  const k2FinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);

  fs.writeFileSync(k1FinalPath, JSON.stringify({
    repoPath: y, branch: "s4-k1-GENUINE", reason: "s4: k1's own genuine raise",
    enteredAt: Date.now() - 60_000, tokens: ["s4-k1-token"],
    contributorRepoPaths: ["s4-c1-contributor"], orphanLatchFiles: ["s4-o1.json"],
  }, null, 2) + "\n");
  fs.writeFileSync(k2FinalPath, JSON.stringify({
    repoPath: y, branch: "s4-k2-GENUINE", reason: "s4: k2's own genuine raise, DIFFERENT record",
    enteredAt: Date.now() - 60_000, tokens: ["s4-k2-token"],
    contributorRepoPaths: ["s4-c2-contributor"], orphanLatchFiles: ["s4-o2.json"],
  }, null, 2) + "\n");

  // ONE placeholder entry, armed at BOTH k1 and k2 — both keys marked unreadable, mirroring the exact
  // dual-arm-while-both-unreadable shape the CR's own probe constructed.
  const placeholderEntry = {
    repoPath: y, branch: PLACEHOLDER_BRANCH_UNREADABLE, reason: "s4: boot-minted placeholder, dual-armed",
    enteredAt: Date.now() - 120_000, tokens: ["s4-placeholder-token"], placeholder: true,
    armedKeys: [k1, k2], identityAtRaise: k1,
  };
  setActiveQuarantineTestOnly(k1, placeholderEntry);
  setActiveQuarantineTestOnly(k2, placeholderEntry);
  markLatchFileUnreadableTestOnly(path.basename(k1FinalPath));
  markLatchFileUnreadableTestOnly(path.basename(k2FinalPath));

  check("(precondition) Y is dual-armed at k1 AND k2, placeholder-shaped, BOTH keys marked", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.placeholder === true && e.armedKeys?.includes(k1) && e.armedKeys?.includes(k2)));

  enterMergeQuarantine(y, "s4-fresh-branch", "s4: fresh raise while dual-armed and both marked");

  const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
  note(`(s4) in-memory Y after the raise: ${JSON.stringify(memAfter)}`);
  check("*** THE FIX (CR MAJOR) *** k1's own contributorRepoPaths survives in memory", (memAfter?.contributorRepoPaths ?? []).includes("s4-c1-contributor"));
  check("*** THE FIX (CR MAJOR) *** k2's own contributorRepoPaths ALSO survives in memory (the cross-key drop this closes)", (memAfter?.contributorRepoPaths ?? []).includes("s4-c2-contributor"));
  check("*** THE FIX (CR MAJOR) *** k1's own orphanLatchFiles survives", (memAfter?.orphanLatchFiles ?? []).includes("s4-o1.json"));
  check("*** THE FIX (CR MAJOR) *** k2's own orphanLatchFiles ALSO survives", (memAfter?.orphanLatchFiles ?? []).includes("s4-o2.json"));

  // k1 (PRIMARY) is written FIRST in the loop, before k2's own union is even known — its own physical
  // file only ever reflects c1 (never retroactively re-written once k2's own write later discovers c2;
  // see the decision record's "Do not retroactively re-write an earlier key" rule). k2 (SECONDARY) is
  // written SECOND, with the full accumulated union — its own physical file gets BOTH (the accepted
  // fail-closed OVER-BLOCK direction: k1's own fields land on k2's file too, never a data loss).
  const k1OnDisk = JSON.parse(fs.readFileSync(k1FinalPath, "utf8"));
  const k2OnDisk = JSON.parse(fs.readFileSync(k2FinalPath, "utf8"));
  check("(sanity) k1's own final carries its own c1 (written first, never retroactively updated)", (k1OnDisk.contributorRepoPaths ?? []).includes("s4-c1-contributor"));
  check("(sanity, accepted over-block) k2's own final carries BOTH contributors (written second, full union)", (k2OnDisk.contributorRepoPaths ?? []).includes("s4-c1-contributor") && (k2OnDisk.contributorRepoPaths ?? []).includes("s4-c2-contributor"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 (CR2, M1) — consumeMatchedPendingsIntoArmedEntry's own sourceFile strip, MARKED vs UNMARKED.
// A pending entry P (sourceFile S) graduates into an armed entry at a marked key whose own genuine disk
// record ALREADY lists S in its own orphanLatchFiles (a stale cross-reference, independent of this
// consume). Pre-fix, the generic branch's own disk union re-added S even though it was just stripped —
// a dangling self-reference to a file this SAME call deletes a moment later via
// deleteSourceLatchIfSuperseded. Proves the reference is gone from BOTH memory and disk, and that a
// LATER, unrelated latch reusing S's own physical name is never misattributed back to Y.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
for (const marked of [true, false]) {
  const tag = marked ? "s5-marked" : "s5-unmarked";
  const y = freshRepo(tag);
  const key = canonicalRepoLockKey(y);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`);
  // @decision 4e987303 (round 4, CR item 2/3) — a REAL 24-hex id (round 3's fixed literal never reached
  // clearMergeQuarantineLatchFile's own ownership scan at all — VACUOUS, per the CR), with freshSfx()
  // baked in so two runs sharing one LOOM_HOME never collide.
  const sSfx = freshSfx();
  const sHash = createHash("sha256").update(`${tag}-S-${sSfx}`).digest("hex").slice(0, 24);
  const sFile = `${sHash}.json`;
  const sPath = path.join(MERGE_QUARANTINE_DIR, sFile);
  const pToken = `${tag}-p-token-${sSfx}`;

  fs.writeFileSync(sPath, JSON.stringify({ repoPath: y, branch: `${tag}-p-branch`, reason: `${tag}: pending`, tokens: [pToken], enteredAt: Date.now() - 10_000 }, null, 2) + "\n");
  pushPendingQuarantineTestOnly({ repoPath: y, branch: `${tag}-p-branch`, reason: `${tag}: pending`, tokens: [pToken], enteredAt: Date.now() - 10_000 }, sFile);
  // disk's own genuine record for `key` ALREADY (independently) lists S in its own orphanLatchFiles.
  parkAt(key, y, `${tag}-ondisk`, [`${tag}-ondisk-token-${sSfx}`], { orphanLatchFiles: [sFile] });
  if (marked) markLatchFileUnreadableTestOnly(path.basename(finalPath));

  const graduated = activeMergeQuarantineFor(y); // triggers consumeMatchedPendingsIntoArmedEntry

  note(`(${tag}) graduated entry: ${JSON.stringify(graduated)}`);
  check(`(${tag}) *** THE FIX (CR2 M1) *** S is gone from memory's own orphanLatchFiles`, !(graduated?.orphanLatchFiles ?? []).includes(sFile));
  check(`(${tag}) S's own physical file was deleted (superseded)`, !fs.existsSync(sPath));

  const onDiskAfter = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  check(`(${tag}) *** THE FIX (CR2 M1) *** S is gone from the DURABLE on-disk orphanLatchFiles too`, !(onDiskAfter.orphanLatchFiles ?? []).includes(sFile));

  // A LATER, unrelated latch reuses S's own freed physical name — must never come back to haunt Y. Now
  // a real 24-hex id, so clearMergeQuarantineLatchFile actually reaches its own ownership scan.
  fs.writeFileSync(sPath, JSON.stringify({ repoPath: `${tag}-unrelated-Z-${sSfx}`, branch: "z-branch", reason: "z: unrelated latch reusing S's own freed name", tokens: [`z-token-${sSfx}`] }, null, 2) + "\n");
  const clearResult = clearMergeQuarantineLatchFile(sHash);
  note(`(${tag}) clearMergeQuarantineLatchFile(${sHash}) against the REUSED name => ${JSON.stringify(clearResult)}`);
  check(`(${tag}) *** THE FIX (CR2 M1) *** the reused-name clear never mentions Y's own repoPath (no misattribution)`, !JSON.stringify(clearResult).includes(y));
  check(`(${tag}) Y's own quarantine is completely unaffected by the reused-name clear`, (activeMergeQuarantineFor(y)?.tokens ?? []).includes(pToken));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 (CR2, M2) — reduceForeignUnionContributor's own contributor removal, MARKED vs UNMARKED,
// PLUS (round 4, CR item 1) a disk-spelling-variant sweep for the marked case: the chokepoint's own
// subtract used to compare `contributorRepoPaths` by RAW string equality, so a disk-side spelling
// variant of the SAME identity (case, or `/` vs `\`) survived the subtract untouched and resurrected the
// contributor — the human's first /clear silently didn't stick for that spelling. Reproduced directly by
// the reviewer's own probe script. A genuine (non-placeholder) entry at a marked key already lists `dId`
// as a contributor; disk's own record ALREADY (independently) lists it too, under the VARIANT spelling.
// Proves ONE /clear call sticks, in memory AND on disk, for every spelling disk might carry.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
for (const { marked, variant } of [{ marked: true, variant: "same" }, { marked: false, variant: "same" }, { marked: true, variant: "upper" }, { marked: true, variant: "fwdslash" }]) {
  const tag = `s6-${marked ? "marked" : "unmarked"}-${variant}`;
  // @decision 4e987303 (round 3) — dId must share Y's own canonical key (ancestor-walk collision, same
  // as scenarios 1/5) — a bare standalone dir resolves its OWN path as its key, never reaches `freshIsForeign`.
  const { dSub: dId, sSub: y } = makeRepoWithTwoSubdirs(tag);
  const key = canonicalRepoLockKey(y);
  check(`(${tag} precondition) dId and Y share one canonical key`, canonicalRepoLockKey(dId) === key);
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`);
  // disk's own copy of the contributor may be spelled DIFFERENTLY than the in-memory `dId` — same
  // identity (verified below via realpath), different case or separator.
  const dOnDisk = variant === "same" ? dId : variant === "upper" ? dId.toUpperCase() : dId.split(path.sep).join("/");
  check(`(${tag} precondition) dOnDisk is still the SAME identity as dId despite the spelling`, ident(dOnDisk) === ident(dId));

  parkAt(key, y, `${tag}-ondisk`, [`${tag}-ondisk-token`], { contributorRepoPaths: [dOnDisk] });
  setActiveQuarantineTestOnly(key, { repoPath: y, branch: `${tag}-mem-branch`, reason: `${tag}: mem`, tokens: [`${tag}-mem-token`], contributorRepoPaths: [dId], armedKeys: [key], enteredAt: Date.now() });
  if (marked) markLatchFileUnreadableTestOnly(path.basename(finalPath));

  check(`(${tag} precondition) Y's own in-memory entry lists dId as contributor`, (listActiveMergeQuarantines().find((e) => e.repoPath === y)?.contributorRepoPaths ?? []).includes(dId));

  const clearResult = clearMergeQuarantine(dId); // routes to reduceForeignUnionContributor
  note(`(${tag}) clearMergeQuarantine(dId) => ${JSON.stringify(clearResult)}`);

  const memAfter = listActiveMergeQuarantines().find((e) => e.repoPath === y);
  note(`(${tag}) Y's own entry after ONE /clear: ${JSON.stringify(memAfter)}`);
  // @decision 4e987303 (round 4) — compare by `ident()` (identity), never raw `.includes` — disk may
  // carry `dOnDisk`'s own variant spelling, never `dId` verbatim, for the upper/fwdslash variants.
  check(`(${tag}) *** THE FIX (CR2 M2) *** ONE /clear sticks — dId is GONE from contributorRepoPaths in memory (no same-identity survivor)`, !(memAfter?.contributorRepoPaths ?? []).some((c) => ident(c) === ident(dId)));
  check(`(${tag}) (sanity) dId IS recorded in reducedContributorRepoPaths`, (memAfter?.reducedContributorRepoPaths ?? []).some((x) => x.toLowerCase() === dId.toLowerCase()));

  const onDiskAfter = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  check(`(${tag}) *** THE FIX (CR2 M2) *** dId is ALSO gone from the DURABLE on-disk contributorRepoPaths (no same-identity survivor)`, !(onDiskAfter.contributorRepoPaths ?? []).some((c) => ident(c) === ident(dId)));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — writeLatchAndAdopt is the one call site, and every caller (reduce, token-clear,\n"
    + "   and a secondary armed key) now adopts whatever writeMergeQuarantineLatch's own internal reconcile\n"
    + "   actually persisted, instead of silently re-overwriting it with a stale pre-reconcile local."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 4e987303.`);
process.exit(failures === 0 ? 0 : 1);
