import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Arms foreign tmp residue that collapses onto a key freed by a clear.
//
// @decision f8e11853
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqf8e1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mqf8e1@loom -c user.name=mqf8e1";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqf8e1-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-f8e11853 (${tag})\n`);
  execSync(`git init -q && git config user.email mqf8e1@loom && git config user.name mqf8e1`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same shape as 25d0d45b's own `plantTmpResidue` — a `.json.tmp-<pid>-<hex>` residue directly at `key`'s
// own hash. The pid/hex suffix matches boot's own strict `tmpFiles` filter.
function plantTmpResidue(key, repoPath, branch, reason, tokens, suffix, againstModule = mod) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(againstModule.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
  return tmpPath;
}

// Plant a residue with ARBITRARY, RAW content (no `branch`/`reason`, or a NUL-byte repoPath, or
// malformed JSON) at `hash` verbatim -- for the UNRESOLVABLE/UNARMABLE negative scenarios below, which
// need content shapes `plantTmpResidue`'s own JSON.stringify can't produce.
function plantRawTmpResidueAtHash(hash, rawContent, suffix, againstModule = mod) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(againstModule.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, rawContent);
  return tmpPath;
}

function hashOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// The reboot leg must be a genuinely independent derivation of the SAME on-disk bytes the real clear
// left behind, never a boot from whatever the in-process leg's own LATER queries (assertRepoNotQuarantined/
// resolveQuarantineFor can mutate as a side effect) might additionally produce. Same posture as
// 9f387d7e's own Round 2 hardening ("snapshots ... right after the clearer's own clear ... restores
// from that snapshot before [the] reboot leg boots").
//
// @decision f8e11853 — snapshot right after the clear's own mutations land, before any further
// in-process verdict query runs; restore that exact snapshot before the reboot leg boots.
function snapshotDir(dir) {
  const snap = new Map();
  for (const f of fs.readdirSync(dir)) snap.set(f, fs.readFileSync(path.join(dir, f)));
  return snap;
}
function restoreDirSnapshot(dir, snap) {
  for (const f of fs.readdirSync(dir)) if (!snap.has(f)) fs.unlinkSync(path.join(dir, f));
  for (const [f, content] of snap) fs.writeFileSync(path.join(dir, f), content);
}

// `withDistMutation` -- same technique as 25d0d45b's own scenario (EXCL-B): a scoped mutation of a
// THROWAWAY COPY of the minimal dist import closure, never the real shared `dist/`. Used below to prove
// the two Round-2 CR fixes are load-bearing (API-preserving mutants, never a RED that merely removes a
// function/export -- lesson 298). The real dist/git/merge-quarantine.js is verified byte-identical
// before and after every call.
const DIST_ROOT = path.join(__dirname, "..", "dist");
const CLOSURE_RELATIVE_FILES = [
  "paths.js",
  path.join("pty", "resolve-bin.js"),
  path.join("pty", "claude-dirname.js"),
  path.join("git", "repo-lock.js"),
  path.join("git", "merge-quarantine.js"),
];
const REAL_MERGE_QUARANTINE_PATH = path.join(DIST_ROOT, "git", "merge-quarantine.js");
const hashFile = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const REAL_MERGE_QUARANTINE_HASH_BEFORE = hashFile(REAL_MERGE_QUARANTINE_PATH);

async function withDistMutation(find, replace, fn) {
  const tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-f8e1r2-distcopy-"));
  tmpDirs.push(tmpDistDir);
  try {
    for (const rel of CLOSURE_RELATIVE_FILES) {
      const dest = path.join(tmpDistDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(DIST_ROOT, rel), dest);
    }
    const copyMqPath = path.join(tmpDistDir, "git", "merge-quarantine.js");
    const original = fs.readFileSync(copyMqPath, "utf8");
    const occurrences = original.split(find).length - 1;
    // @decision f8e11853 (round 2) — report a FAIL, never throw: a RED run whose own find-text has
    // drifted must not crash the whole process before any LATER scenario gets to run (lesson 298's own
    // precedent from 25d0d45b's Round 4 ruling).
    if (occurrences !== 1) {
      check(`(withDistMutation) expected EXACTLY 1 occurrence of the given find-text, found ${occurrences}`, false);
      return undefined;
    }
    fs.writeFileSync(copyMqPath, original.replace(find, replace));
    const mutatedModule = await import(pathToFileURL(copyMqPath).href);
    return await fn(mutatedModule);
  } finally {
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
    check("(byte-identical guard) the REAL dist/git/merge-quarantine.js was never written", hashFile(REAL_MERGE_QUARANTINE_PATH) === REAL_MERGE_QUARANTINE_HASH_BEFORE);
  }
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MAIN) -- the card's own repro. Y independently quarantined; X = Y/ghost (no own .git, so X's real
  // canonical key is always Y's); X's own armable foreign tmp sits at a WHOLLY DIFFERENT repo R's hash
  // (R is never itself quarantined -- only its key is used to misplace X's residue). Clearing Y must arm
  // X in-process, matching what a fresh boot independently derives from the identical on-disk bytes.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("main-y");
    const r = makeRepo("main-r");
    const keyY = canonicalRepoLockKey(y);
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(y, "ghost-subdir-main");
    fs.mkdirSync(x, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    const xToken = randomUUID();
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, mismatched onto R's own hash", [xToken], "80001-cafef001");

    const clearResult = mod.clearMergeQuarantine(y);
    // 97516691: X is armed at Y's key, so assertRepoNotQuarantined(y) refuses and Y is NOT reported lifted (was: lifted).
    check("(main) Y NOT reported lifted — X armed at Y's key still refuses Y (lifted <=> assert passes)", !clearResult.liftedRepoPaths?.includes(y) && mod.assertRepoNotQuarantined(y).ok === false);
    check("(main) X's own residue at R's hash SURVIVES Y's clear (never unlinked)", fs.existsSync(xTmpAtRsHash));

    // Snapshot BEFORE any further in-process verdict query -- see snapshotDir's own doc above.
    const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);

    // *** THE FIX *** -- X reports as a genuine, routable blocked co-occupant, never content-kept.
    check("*** THE FIX (main) *** X reported via stillBlockedCoOccupants, never contentKeptRepoPaths", !!clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x) && !clearResult.contentKeptRepoPaths?.includes(x));
    const xCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === x);
    check("(main) ...with a REAL, working {id} route", !!xCoOccupant?.route?.id);

    const inProcessEntry = mod.stillBlockedEntryFor(x);
    check("*** THE FIX (main) *** X is ARMED in-process (stillBlockedEntryFor finds it)", inProcessEntry !== undefined);
    check("(main) ...carrying X's OWN real token set", !!inProcessEntry && inProcessEntry.tokens.includes(xToken) && inProcessEntry.tokens.length === 1);
    const inProcessOk = mod.assertRepoNotQuarantined(x);
    check("(main) assertRepoNotQuarantined(X) in-process REFUSES", inProcessOk.ok === false);

    // Reboot from the pre-query snapshot -- a genuinely independent derivation of the same bytes.
    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, r]);
    const rebootEntry = fresh.stillBlockedEntryFor(x);
    // Guarded via `?.tokens` on BOTH sides (never a bare `.tokens`) -- on the pre-fix code, X is never
    // armed in-process at all (`inProcessEntry === undefined`), and this check must FAIL cleanly rather
    // than crash the whole process before any later scenario gets to run.
    check("*** THE GOVERNING INVARIANT (main) *** in-process token set === post-reboot token set", inProcessEntry?.tokens !== undefined && rebootEntry?.tokens !== undefined && JSON.stringify([...inProcessEntry.tokens].sort()) === JSON.stringify([...rebootEntry.tokens].sort()));
    check("(main) ...and both are BLOCKED (never a split)", (inProcessEntry !== undefined) === (rebootEntry !== undefined));
    const rebootOk = fresh.assertRepoNotQuarantined(x);
    check("(main) in-process .ok === post-reboot .ok", inProcessOk.ok === rebootOk.ok);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (R-OCCUPIED-NEG, manager directive 1) -- same shape, but R is ALSO independently, genuinely
  // quarantined (its own live latch/entry at K_R). After Y's clear, X still arms correctly, and R's own
  // entry/tokens/latch-file content are BYTE-FOR-BYTE unchanged -- the cross-hash branch must never
  // unlink, rewrite, or fold anything belonging to R's own identity, even though it shares R's hash as
  // the misfiled location of X's residue.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("rocc-y");
    const r = makeRepo("rocc-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(y, "ghost-subdir-rocc");
    fs.mkdirSync(x, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    const rToken = enterMergeQuarantine(r, "loom/r-branch", "r's own real, UNRELATED, STILL-LIVE raise");
    const xToken = randomUUID();
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, mismatched onto R's own hash", [xToken], "80002-cafef002");

    const rEntryBefore = mod.stillBlockedEntryFor(r);
    const rLatchPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(keyR)}.json`);
    const rLatchBytesBefore = fs.readFileSync(rLatchPath);

    const clearResult = mod.clearMergeQuarantine(y);
    // 97516691: same as (main) — X armed at Y's key refuses Y, so Y is NOT reported lifted (was: lifted).
    check("(rocc) Y NOT reported lifted — X armed at Y's key still refuses Y (lifted <=> assert passes)", !clearResult.liftedRepoPaths?.includes(y) && mod.assertRepoNotQuarantined(y).ok === false);
    check("(rocc) Y's clear never lifts, addresses, or names R at all", !clearResult.liftedRepoPaths?.includes(r) && !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === r) && !clearResult.contentKeptRepoPaths?.includes(r));

    const inProcessX = mod.stillBlockedEntryFor(x);
    check("*** THE FIX (rocc) *** X is still ARMED in-process even with R genuinely occupying R's own hash", inProcessX !== undefined && inProcessX.tokens.includes(xToken));

    const rEntryAfter = mod.stillBlockedEntryFor(r);
    check("(rocc) R's own in-memory entry token set is BYTE-FOR-BYTE unchanged", JSON.stringify([...rEntryBefore.tokens].sort()) === JSON.stringify([...rEntryAfter.tokens].sort()) && rEntryAfter.tokens.includes(rToken));
    check("(rocc) R's own in-memory entry repoPath/branch/reason unchanged", rEntryAfter.repoPath === rEntryBefore.repoPath && rEntryAfter.branch === rEntryBefore.branch && rEntryAfter.reason === rEntryBefore.reason);
    const rLatchBytesAfter = fs.readFileSync(rLatchPath);
    check("*** THE FIX (rocc) *** R's own on-disk latch file is BYTE-FOR-BYTE unchanged", Buffer.compare(rLatchBytesBefore, rLatchBytesAfter) === 0);
    check("(rocc) R is still genuinely, independently quarantined", mod.assertRepoNotQuarantined(r).ok === false);

    // Clean up R's own live quarantine so it doesn't bleed into a later scenario's own directory state.
    mod.clearMergeQuarantine(r);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (READFAILED-NEG, round 2 CR MAJOR) -- a cross-hash file's relevance to `freedKey` is UNPROVABLE
  // without a successful read. R is an UNRELATED repo, never itself quarantined -- a genuinely unreadable
  // (EISDIR) file misfiled at R's own hash must be left COMPLETELY UNTOUCHED by Y's clear: no mark, no
  // flag, no `latchKept`/`unattributed` disclosure. Reviewer's own repro shape: a DIRECTORY planted at the
  // tmp-residue naming convention forces `readFileSync` to throw EISDIR, portable on both Windows and
  // POSIX (never the MSYS-`ps`/EPERM shape `1fea8b15` already ruled unreachable via a live raise).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("readfail-y");
    const r = makeRepo("readfail-r"); // never itself quarantined
    const rCtl = makeRepo("readfail-rctl"); // untouched CONTROL -- never exposed to Y's cross-hash sweep
    const keyR = canonicalRepoLockKey(r);
    const keyRCtl = canonicalRepoLockKey(rCtl);
    const hashR = hashOf(keyR);
    const hashRCtl = hashOf(keyRCtl);

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");

    // A DIRECTORY (not a file) at R's own hash's tmp-residue naming shape -- readFileSync throws EISDIR.
    const eisdirPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashR}.json.tmp-80020-deadbeef1`);
    fs.mkdirSync(eisdirPath, { recursive: true });

    const clearResult = mod.clearMergeQuarantine(y);
    check("(readfailed-neg) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE FIX (readfailed-neg) *** no latchKept/unattributed disclosure from an unreadable, UNRELATED cross-hash file", !clearResult.latchKept && !clearResult.unattributed);
    check("(readfailed-neg) the EISDIR directory survives, left COMPLETELY UNTOUCHED (never unlinked, never marked)", fs.existsSync(eisdirPath) && fs.statSync(eisdirPath).isDirectory());

    // R's own same-hash loop, afterward, reaches the SAME disposition as an identical, never-touched
    // CONTROL repo (rCtl) carrying the IDENTICAL EISDIR shape at ITS OWN hash -- a same-shape PARITY
    // check, not a sticky-contamination proof (downgraded, card `503c8114`): r's own basename is
    // genuinely re-exposed to the SAME EISDIR read failure during r's own clear regardless of whether
    // Y's earlier cross-hash touch marked it, since a marked basename's own re-read
    // (`reconcileClearedEntryIfPlaceholder`) also throws EISDIR and converges on the identical
    // `anyUnattributed`/untouched outcome a fresh, unmarked read-failure reaches -- so this differential
    // cannot diverge for this shape regardless of whether the bug is present. See the decision record's
    // "CR Round 2" section for why, and what a genuinely diverging construction would need.
    const eisdirCtlPath = path.join(mod.MERGE_QUARANTINE_DIR, `${hashRCtl}.json.tmp-80022-deadbeef2`);
    fs.mkdirSync(eisdirCtlPath, { recursive: true });

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise, AFTER y's earlier cross-hash EISDIR attempt against r's own hash");
    enterMergeQuarantine(rCtl, "loom/rctl-branch", "rCtl's own real raise -- CONTROL, never touched by any cross-hash sweep");

    const rClear = mod.clearMergeQuarantine(r);
    const rCtlClear = mod.clearMergeQuarantine(rCtl);
    check("(readfailed-neg, parity check -- not a sticky-contamination proof for this shape) r's clear reaches the IDENTICAL disposition as an untouched control", !!rClear.latchKept === !!rCtlClear.latchKept && !!rClear.unattributed === !!rCtlClear.unattributed);
    check("(readfailed-neg) ...and both directories survive, untouched, the same way", fs.existsSync(eisdirPath) === fs.existsSync(eisdirCtlPath));

    // Clean up both EISDIR directories -- a later scenario's own snapshotDir()/restoreDirSnapshot() calls
    // readFileSync on EVERY entry in MERGE_QUARANTINE_DIR, which throws on a leftover directory.
    try { fs.rmSync(eisdirPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(eisdirCtlPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (ORDER-NEG, round 2 CR item 2) -- pins the Round-2 ordering fix: the cross-hash ownership check must
  // run AFTER confirming relevance to `freedKey`, never before. M is a SURVIVING, independently
  // quarantined entry that (test-only) OWNS a cross-hash file F via its own `orphanLatchFiles` -- but F's
  // own content belongs to M's OWN key, never Y's. Under the real (fixed) ordering, F is skipped by the
  // relevance gate before ownership is even consulted, so Y's clear must never name M. RED-proven below
  // via mutant `ownerfirst`, which swaps the order so ownership runs first.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("order-y");
    const m = makeRepo("order-m");
    const s = makeRepo("order-s"); // a third, unrelated repo whose hash misfiles F
    const keyM = canonicalRepoLockKey(m);
    const keyS = canonicalRepoLockKey(s);
    const w = path.join(m, "ghost-subdir-order"); // W's real key is M's, never Y's
    fs.mkdirSync(w, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    enterMergeQuarantine(m, "loom/m-branch", "m's own real, UNRELATED, STILL-LIVE raise");
    const fToken = randomUUID();
    const fTmp = plantTmpResidue(keyS, w, "loom/w-branch", "F's own stray tmp, filed at an unrelated third hash -- belongs to M's key, NOT Y's", [fToken], "80010-deadcafe1");
    const mEntryBefore = mod.activeMergeQuarantineFor(m);
    mod.setActiveQuarantineTestOnly(keyM, { ...mEntryBefore, orphanLatchFiles: [...(mEntryBefore.orphanLatchFiles ?? []), path.basename(fTmp)] });

    const clearResult = mod.clearMergeQuarantine(y);
    check("(order-neg) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE ORDERING FIX (order-neg) *** M (owns F via orphanLatchFiles) is NEVER named by Y's clear -- F is irrelevant to freedKey", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === m) && !clearResult.contentKeptRepoPaths?.includes(m));
    check("(order-neg) F's own residue survives, untouched", fs.existsSync(fTmp));

    mod.clearMergeQuarantine(m);

    // RED PROOF -- mutant `ownerfirst`: moves the SAME ownership check to run BEFORE the relevance gate.
    // API-preserving (same signature, same downstream pipeline) -- only the ORDER changes.
    await withDistMutation(
      "            if (safety.parsedRepoPath === undefined)\n                continue; // corrupt/unparsable/no repoPath — nothing to classify\n            const residueKey = canonicalKeyOrUndefined(safety.parsedRepoPath);\n            if (residueKey === undefined || !freedKeys.has(residueKey))\n                continue; // belongs to a DIFFERENT identity/key entirely — not this call's concern\n            // Only NOW, for a file genuinely confirmed to belong to `freedKeys`, does ownership matter — the\n            // SAME in-memory check the same-hash loop above runs, cheap, no I/O.\n            const owners = new Set();\n            for (const e of activeQuarantines.values())\n                if (e.orphanLatchFiles?.includes(f))\n                    owners.add(e.repoPath);\n            for (const p of pendingUnresolvedQuarantines)\n                if (p.entry.orphanLatchFiles?.includes(f))\n                    owners.add(p.entry.repoPath);\n            if (owners.size > 0) {\n                for (const o of owners) {\n                    referencingRepoPaths.add(o);\n                    keptEntries.push({ repoPath: o, sourceFile: f });\n                }\n                continue;\n            }",
      "            const ownersFirst = new Set();\n            for (const e of activeQuarantines.values())\n                if (e.orphanLatchFiles?.includes(f))\n                    ownersFirst.add(e.repoPath);\n            for (const p of pendingUnresolvedQuarantines)\n                if (p.entry.orphanLatchFiles?.includes(f))\n                    ownersFirst.add(p.entry.repoPath);\n            if (ownersFirst.size > 0) {\n                for (const o of ownersFirst) {\n                    referencingRepoPaths.add(o);\n                    keptEntries.push({ repoPath: o, sourceFile: f });\n                }\n                continue;\n            }\n            if (safety.parsedRepoPath === undefined)\n                continue; // corrupt/unparsable/no repoPath — nothing to classify\n            const residueKey = canonicalKeyOrUndefined(safety.parsedRepoPath);\n            if (residueKey === undefined || !freedKeys.has(residueKey))\n                continue; // belongs to a DIFFERENT identity/key entirely — not this call's concern",
      async (mutated) => {
        const y2 = makeRepo("order-mut-y");
        const m2 = makeRepo("order-mut-m");
        const s2 = makeRepo("order-mut-s");
        const keyM2 = canonicalRepoLockKey(m2);
        const keyS2 = canonicalRepoLockKey(s2);
        const w2 = path.join(m2, "ghost-subdir-ordermut");
        fs.mkdirSync(w2, { recursive: true });

        mutated.enterMergeQuarantine(m2, "loom/m2-branch", "m2's own real, independent raise");
        const fToken2 = randomUUID();
        const fTmp2 = plantTmpResidue(keyS2, w2, "loom/w2-branch", "F2's own stray tmp, filed at an unrelated third hash -- belongs to M2's key, NOT Y2's", [fToken2], "80011-deadcafe2", mutated);
        const m2EntryBefore = mutated.activeMergeQuarantineFor(m2);
        mutated.setActiveQuarantineTestOnly(keyM2, { ...m2EntryBefore, orphanLatchFiles: [...(m2EntryBefore.orphanLatchFiles ?? []), path.basename(fTmp2)] });

        mutated.enterMergeQuarantine(y2, "loom/y2-branch", "y2's own real, independent raise");
        const clearResult2 = mutated.clearMergeQuarantine(y2);
        check("*** RED PROOF (order-neg) *** WITHOUT relevance-before-ownership, M2 (owns F2, irrelevant to Y2's freed key) is WRONGLY folded into Y2's clear result", !!clearResult2.stillBlockedCoOccupants?.some((c) => c.repoPath === m2) || !!clearResult2.contentKeptRepoPaths?.includes(m2));

        try { fs.rmSync(fTmp2, { force: true }); } catch { /* best-effort */ }
      },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (OWNED-NEG, round 2 CR item 3) -- Disposition 1 ("already owned"): a cross-hash file genuinely
  // RELEVANT to `freedKey` (X is Y's own ghost subdir -- X's real key is always Y's) but already OWNED by
  // a DIFFERENT surviving entry N (test-only, via N's own `orphanLatchFiles`) must be folded into
  // `referencingRepoPaths`/reported via N, never armed/deleted/dropped independently. RED-proven below
  // via mutant `ownedskip`, which `continue`s on ownership without filling kept/referencing at all.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("owned-y");
    const r = makeRepo("owned-r"); // misfiled hash location for X's own residue
    const n = makeRepo("owned-n"); // the surviving entry that OWNS X's residue (test-only)
    const keyR = canonicalRepoLockKey(r);
    const keyN = canonicalRepoLockKey(n);
    const x = path.join(y, "ghost-subdir-owned");
    fs.mkdirSync(x, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    enterMergeQuarantine(n, "loom/n-branch", "n's own real, UNRELATED, STILL-LIVE raise");
    const xToken = randomUUID();
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, mismatched onto R's own hash -- but genuinely relevant to Y's own key", [xToken], "80012-deadface1");
    const nEntryBefore = mod.activeMergeQuarantineFor(n);
    mod.setActiveQuarantineTestOnly(keyN, { ...nEntryBefore, orphanLatchFiles: [...(nEntryBefore.orphanLatchFiles ?? []), path.basename(xTmpAtRsHash)] });

    const clearResult = mod.clearMergeQuarantine(y);
    check("(owned-neg) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE FIX (owned-neg) *** N (already owns X's cross-hash residue) is reported via stillBlockedCoOccupants", !!clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === n));
    check("(owned-neg) X's own residue survives, untouched (owned, never unlinked or independently re-armed)", fs.existsSync(xTmpAtRsHash));
    check("(owned-neg) X itself is never separately reported -- it's N's ownership that's reported, not X's own identity", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x) && !clearResult.contentKeptRepoPaths?.includes(x));

    mod.clearMergeQuarantine(n);

    // RED PROOF -- mutant `ownedskip`: the SAME ownership check still runs (relevance-gated, as fixed),
    // but on a hit it `continue`s WITHOUT filling `referencingRepoPaths`/`keptEntries` -- silently
    // dropping the report while still correctly leaving the file untouched (the subtle, easy-to-miss
    // failure mode: nothing crashes, nothing gets destroyed, the report is just silently absent).
    await withDistMutation(
      "            if (owners.size > 0) {\n                for (const o of owners) {\n                    referencingRepoPaths.add(o);\n                    keptEntries.push({ repoPath: o, sourceFile: f });\n                }\n                continue;\n            }\n            const identity = directPathIdentity(safety.parsedRepoPath);\n            if (excludeIdentities?.has(identity)) {\n                contentKeptEntries.push({ repoPath: safety.parsedRepoPath, sourceFile: f });\n                continue;\n            }\n            if (!safety.safe) {\n                deferredAttributedKept.push({ repoPath: safety.parsedRepoPath, sourceFile: f });\n                if (safety.armable) {\n                    const bucket = armableByIdentity.get(identity);",
      "            if (owners.size > 0) {\n                continue;\n            }\n            const identity = directPathIdentity(safety.parsedRepoPath);\n            if (excludeIdentities?.has(identity)) {\n                contentKeptEntries.push({ repoPath: safety.parsedRepoPath, sourceFile: f });\n                continue;\n            }\n            if (!safety.safe) {\n                deferredAttributedKept.push({ repoPath: safety.parsedRepoPath, sourceFile: f });\n                if (safety.armable) {\n                    const bucket = armableByIdentity.get(identity);",
      async (mutated) => {
        const y2 = makeRepo("owned-mut-y");
        const r2 = makeRepo("owned-mut-r");
        const n2 = makeRepo("owned-mut-n");
        const keyR2 = canonicalRepoLockKey(r2);
        const keyN2 = canonicalRepoLockKey(n2);
        const x2 = path.join(y2, "ghost-subdir-ownedmut");
        fs.mkdirSync(x2, { recursive: true });

        mutated.enterMergeQuarantine(n2, "loom/n2-branch", "n2's own real, UNRELATED, STILL-LIVE raise");
        const x2Token = randomUUID();
        const x2Tmp = plantTmpResidue(keyR2, x2, "loom/x2-branch", "X2's own stray tmp, mismatched onto R2's own hash -- genuinely relevant to Y2's own key", [x2Token], "80013-deadface2", mutated);
        const n2EntryBefore = mutated.activeMergeQuarantineFor(n2);
        mutated.setActiveQuarantineTestOnly(keyN2, { ...n2EntryBefore, orphanLatchFiles: [...(n2EntryBefore.orphanLatchFiles ?? []), path.basename(x2Tmp)] });

        mutated.enterMergeQuarantine(y2, "loom/y2-branch", "y2's own real, independent raise");
        const clearResult2 = mutated.clearMergeQuarantine(y2);
        check("*** RED PROOF (owned-neg) *** WITHOUT filling kept/referencing on an owned hit, N2's ownership of X2 is silently DROPPED from Y2's clear result", !clearResult2.stillBlockedCoOccupants?.some((c) => c.repoPath === n2) && !clearResult2.contentKeptRepoPaths?.includes(n2));
      },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (SCOPE-NEG) -- a cross-hash file whose own content canonicalises onto a DIFFERENT, still-occupied
  // key (not the key Y's clear just freed) must NEVER be touched/armed by Y's clear -- the identity
  // match is exact, never "any foreign content lying around."
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("scope-y");
    const z = makeRepo("scope-z"); // Z's own real, INDEPENDENT, still-live raise -- never freed by Y's clear
    const s = makeRepo("scope-s"); // a third, unrelated repo whose hash misfiles Z's own residue
    const keyS = canonicalRepoLockKey(s);
    const w = path.join(z, "ghost-subdir-scope"); // W's real key is Z's, never Y's

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    const zToken = enterMergeQuarantine(z, "loom/z-branch", "z's own real, UNRELATED, STILL-LIVE raise");
    const wToken = randomUUID();
    const wTmpAtSsHash = plantTmpResidue(keyS, w, "loom/w-branch", "W's own stray tmp, mismatched onto S's own hash -- belongs to Z's key, NOT Y's", [wToken], "80003-cafef003");

    const clearResult = mod.clearMergeQuarantine(y);
    check("(scope-neg) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE SCOPE GUARANTEE (scope-neg) *** W's residue (belongs to Z's key) SURVIVES, untouched, on disk", fs.existsSync(wTmpAtSsHash));
    check("(scope-neg) Y's clear never arms, reports, or otherwise names W", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === w) && !clearResult.contentKeptRepoPaths?.includes(w));
    // W (no own .git) ALWAYS collapses onto Z's own key -- so `stillBlockedEntryFor(w)` is expected to
    // find a blocker regardless of this card's own fix, since Z is independently, genuinely quarantined.
    // The real scope guarantee is that W's OWN residue (and its own token) was never FOLDED into that
    // block by Y's clear -- Z's entry must still be EXACTLY its own real raise, nothing unioned in.
    const wBlocker = mod.stillBlockedEntryFor(w);
    check("*** THE SCOPE GUARANTEE (scope-neg) *** W is blocked only via Z's OWN real entry, never its own residue", wBlocker?.repoPath === z && !wBlocker.tokens.includes(wToken) && !(wBlocker.orphanLatchFiles ?? []).includes(path.basename(wTmpAtSsHash)));
    // Z itself is untouched too -- its own real raise is independent of all of this.
    check("(scope-neg) Z's own entry is unaffected", mod.stillBlockedEntryFor(z)?.tokens.includes(zToken));

    mod.clearMergeQuarantine(z);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (UNARMABLE-NEG) -- a cross-hash residue that DOES match the freed key, but is genuinely UNARMABLE
  // (content missing `branch`) must stay content-kept FOREVER in-process -- never armed, never deleted. A
  // REBOOT, however, now attributes it by CONTENT (0f58a09a) and arms a placeholder for X: a deliberate
  // in-process content-kept / reboot-armed split, in the safe direction (follow-up card 63569b55).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("unarm-y");
    const r = makeRepo("unarm-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(y, "ghost-subdir-unarm");
    fs.mkdirSync(x, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    const xToken = randomUUID();
    // No `branch` field -- orphanSweepSafeToDelete's own armableByPass1 gate requires BOTH `branch` and
    // `reason` as strings, so this can never arm.
    const unarmableContent = JSON.stringify({ repoPath: x, reason: "X's own genuinely unarmable stray tmp (no branch)", enteredAt: Date.now() - 1000, tokens: [xToken] });
    const xTmpAtRsHash = plantRawTmpResidueAtHash(hashOf(keyR), unarmableContent, "80004-cafef004");

    const clearResult = mod.clearMergeQuarantine(y);
    check("(unarm-neg) X's own unarmable residue SURVIVES, untouched, on disk", fs.existsSync(xTmpAtRsHash));
    check("*** THE FIX (unarm-neg) *** X stays contentKept in-process (a reboot arms it, 0f58a09a), never a routed co-occupant", !!clearResult.contentKeptRepoPaths?.includes(x) && !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x));

    // @decision f8e11853 (round 2) — snapshot right after the clear's own mutations land, BEFORE any
    // further in-process verdict query — MAIN's own ordering (see snapshotDir's own doc above). The prior
    // ordering here snapshotted AFTER the in-process query, so the restore below was a no-op.
    const dirSnapshot = snapshotDir(mod.MERGE_QUARANTINE_DIR);

    const inProcessX = mod.assertRepoNotQuarantined(x);
    check("(unarm-neg) X is NOT armed in-process (genuinely unarmable, nothing enforces it)", inProcessX.ok === true);
    const inProcessEntry = mod.stillBlockedEntryFor(x);
    check("(unarm-neg) stillBlockedEntryFor(X) finds nothing in-process either (genuinely unarmable)", inProcessEntry === undefined);

    restoreDirSnapshot(mod.MERGE_QUARANTINE_DIR, dirSnapshot);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([y, r]);
    const rebootX = fresh.assertRepoNotQuarantined(x);
    const rebootEntry = fresh.stillBlockedEntryFor(x);
    // @decision 0f58a09a — boot now attributes an unarmable file by the repo its CONTENT names, so a reboot
    // fail-CLOSES X with a placeholder (previously it blocked the filename-hash claimant R and left X open).
    // This is a deliberate in-process-open / reboot-closed split on X, in the SAFE direction; R stays open.
    check("(unarm-neg) post-reboot X is fail-closed by CONTENT attribution (0f58a09a), not left open", rebootX.ok === false && rebootEntry?.repoPath === x);
    check("*** THE GOVERNING INVARIANT (unarm-neg) *** the reboot never blocks the innocent filename claimant R", fresh.stillBlockedEntryFor(r) === undefined);
    // X is a ghost SUBDIR of Y (same canonical key), so the reboot's X placeholder re-blocks Y via key(Y);
    // one clear(y) lifts both, because they share that key.
    check("(unarm-neg) the reboot re-blocks Y via key(Y) (X is a ghost subdir of Y)", fresh.stillBlockedEntryFor(y) !== undefined);
    fresh.clearMergeQuarantine(y);
    check("(unarm-neg) clear(y) lifts both Y and X (shared key)", fresh.stillBlockedEntryFor(y) === undefined && fresh.stillBlockedEntryFor(x) === undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (UNRESOLVABLE-NEG, manager directive 3) -- a cross-hash candidate whose content is malformed JSON,
  // or whose `repoPath` field is not a string at all, must be SKIPPED -- never armed, never deleted,
  // left exactly as it was.
  //
  // `canonicalKeyOrUndefined`'s own try/catch (the "canonicalRepoLockKey itself throws" half of the
  // directive) is kept as a defensive guard, but EMPIRICALLY no constructible `repoPath` string makes it
  // throw in this codebase: `findExistingAncestorRealpath`'s own try/catch (repo-lock.ts) already
  // swallows the one real throw point (`fs.realpathSync.native` on a NUL byte) before it can ever
  // propagate -- verified directly, not assumed (see this file's own git history for the probe). The
  // reachable "cannot classify" shapes are both exercised below instead.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("unresolv-y");
    const r = makeRepo("unresolv-r");
    const keyR = canonicalRepoLockKey(r);

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");

    // (a) malformed JSON entirely.
    const malformedTmp = plantRawTmpResidueAtHash(hashOf(keyR), "{ not valid json at all", "80005-cafef005");

    // (b) valid JSON, but `repoPath` is not a string at all -- `orphanSweepSafeToDelete`'s own
    // `parsedRepoPath` is `undefined` for this shape, same as a missing field.
    const nonStringRepoPathContent = JSON.stringify({ repoPath: 12345, branch: "loom/bad-branch", reason: "repoPath is a number, not a string", enteredAt: Date.now() - 1000, tokens: [randomUUID()] });
    const nonStringTmp = plantRawTmpResidueAtHash(hashOf(keyR), nonStringRepoPathContent, "80006-cafef006");

    const bytesBeforeMalformed = fs.readFileSync(malformedTmp);
    const bytesBeforeNonString = fs.readFileSync(nonStringTmp);

    const clearResult = mod.clearMergeQuarantine(y);
    check("(unresolv-neg) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE FIX (unresolv-neg) *** the malformed-JSON residue is left COMPLETELY UNTOUCHED (byte-identical)", fs.existsSync(malformedTmp) && Buffer.compare(bytesBeforeMalformed, fs.readFileSync(malformedTmp)) === 0);
    check("*** THE FIX (unresolv-neg) *** the non-string-repoPath residue is also left COMPLETELY UNTOUCHED", fs.existsSync(nonStringTmp) && Buffer.compare(bytesBeforeNonString, fs.readFileSync(nonStringTmp)) === 0);
    check("(unresolv-neg) neither is reported anywhere in the clear result", !clearResult.stillBlockedCoOccupants?.length && !clearResult.contentKeptRepoPaths?.length);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (DELETE-SAFE, manager directive 2 -- deletion discipline) -- a cross-hash candidate IS genuinely
  // safe to delete (every on-disk token already covered by the clearer's own cleared tokens) reaches the
  // SAME disposition the same-hash loop already reaches for an analogous file: deleted. This is not a
  // new capability the cross-hash branch invents -- it is the identical `orphanSweepSafeToDelete` safety
  // check the same-hash loop already runs, now also reachable for a file filed at a different hash.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("delsafe-y");
    const r = makeRepo("delsafe-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(y, "ghost-subdir-delsafe");
    fs.mkdirSync(x, { recursive: true });

    const yToken = enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    // X's own residue, at R's hash, whose ONLY on-disk token happens to equal Y's own cleared token --
    // i.e. already fully accounted for by `clearedEntry.tokens`, genuinely safe to delete.
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, but its only token is already covered by Y's own clear", [yToken], "80007-cafef007");

    const clearResult = mod.clearMergeQuarantine(y);
    check("(delete-safe) Y genuinely lifted", clearResult.liftedRepoPaths?.includes(y));
    check("*** THE FIX (delete-safe) *** the genuinely-safe-to-delete cross-hash residue IS deleted", !fs.existsSync(xTmpAtRsHash));
    check("(delete-safe) X is NOT armed (there was nothing uncovered left to arm)", mod.stillBlockedEntryFor(x) === undefined);
    check("(delete-safe) X is not reported anywhere in the clear result", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x) && !clearResult.contentKeptRepoPaths?.includes(x));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (NON-FREEING regression check) -- the OTHER 4 real call sites of sweepTmpResidueForHashIfUnreferenced
  // never pass `freedKey`, so they must stay byte-identical: a cross-hash residue must NEVER be touched
  // by a call that does not free a key (writeMergeQuarantineLatch's success sweep; the partial-clear
  // branch). Direct source check, not behavioral re-derivation of the whole corpus (the full
  // merge-quarantine*.mjs run covers that regression separately).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const distSrc = fs.readFileSync(path.join(distGitDir, "merge-quarantine.js"), "utf8");
    // Excludes the function's OWN declaration line (`function sweepTmpResidueForHashIfUnreferenced(`),
    // which also matches the bare name+paren pattern but is not a call site.
    const callSiteCount = (distSrc.match(/(?<!function )sweepTmpResidueForHashIfUnreferenced\(/g) ?? []).length;
    // 7aa9c406: 5 -> 6. The one added site is inside `sweepTmpResidueForClearedPendingEntries`, the shared
    // wrapper the by-key pending loop, the by-own-identity pending branch and the token route all call
    // (each frees a key, so each passes freed keys through it) -- not three more raw call sites.
    check("(non-freeing) sweepTmpResidueForHashIfUnreferenced still has exactly 6 real call sites (never silently added/removed)", callSiteCount === 6);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
