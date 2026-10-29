import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 25d0d45b — the `.tmp-residue` twin of `1dd00dca` (see
// docs/decisions/1dd00dca-arm-foreign-orphan-latch-in-memory.md for that card's own full design/history).
// See docs/decisions/25d0d45b-arm-foreign-tmp-residue-in-memory.md for this card's own design.
//
// THE FIX: `sweepTmpResidueForHashIfUnreferenced`'s own content-kept branch now collects an armable
// record PER IDENTITY across its whole per-hash loop and arms each one ONCE, after the loop, via the SAME
// `armForeignOrphanContentInMemoryIfUnenforced` helper `1dd00dca` introduced (widened, never copied, to
// take `basenames: string[]` + an optional `kind` for log wording only). A NEW `excludeIdentities` param
// (mirrors `sweepOrphanLatchFileIfUnreferenced`'s own shape) gates the arm at the two call sites whose own
// identity may have ALREADY been fully removed from `activeQuarantines`/`pendingUnresolvedQuarantines` by
// the time this runs — never the clearer's own just-lifted content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq25d0d4-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Same posture as 1dd00dca's own crossCheck — a drift guard against the real mutating lookup, never
// independent verification of the lookup order itself.
const crossCheck = (label, booted, repoPath) => {
  check(`(${label}) stillBlockedEntryFor/resolveQuarantineFor agree`, (booted.stillBlockedEntryFor(repoPath) !== undefined) === booted.resolveQuarantineForTestOnly(repoPath));
};
const GIT_ID = "-c user.email=mq25d0d4@loom -c user.name=mq25d0d4";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq25d0d4-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-25d0d45b (${tag})\n`);
  execSync(`git init -q && git config user.email mq25d0d4@loom && git config user.name mq25d0d4`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Plant a `.json.tmp-<pid>-<hex>` residue directly at `key`'s own hash — the SAME shape a real torn write
// leaves behind. The pid/hex suffix MUST match boot's own strict `tmpFiles` filter
// (`/\.json\.tmp-\d+(-[0-9a-f]+)?$/`, merge-quarantine.ts ~:8417) or boot silently never scans it at all —
// unlike the runtime sweep's own loose prefix check, which matches any suffix.
function plantTmpResidue(key, repoPath, branch, reason, tokens, suffix, againstModule = mod) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return plantTmpResidueAtHash(hash, repoPath, branch, reason, tokens, suffix, againstModule);
}

// Same as `plantTmpResidue`, but `hash` is used VERBATIM (never re-hashed) — for a call site (like
// EXCL-C below) whose own `hash`-equivalent (a pending latch id) is already the final 24-hex value, not
// a canonical-repo-lock-key string that itself still needs hashing.
function plantTmpResidueAtHash(hash, repoPath, branch, reason, tokens, suffix, againstModule = mod) {
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(againstModule.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now() - 1000, tokens }, null, 2) + "\n");
  return tmpPath;
}

// Same technique as 1dd00dca's own test file (used for the `.json` orphan path's own MAJOR-1 scenario
// below): fold `orphanBasename` into `repoPath`'s own on-disk final JSON BEFORE `orphanBasename` itself
// exists, standing in for a real production fold whose own durable write landed before the referenced
// file did. A later reboot picks this up into the in-memory entry's own `orphanLatchFiles`.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule = mod) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${createHash("sha256").update(`${repoPath}-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule = mod) {
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens }));
  return orphanPath;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// `withDistMutation` — same technique as 1dd00dca's own scenario (I): a scoped mutation of a THROWAWAY
// COPY of the minimal dist import closure, never the real shared `dist/`. Used here to prove the two
// `excludeIdentities` call sites are load-bearing — strip the argument and show the SAME scenario now
// wrongly re-arms the just-cleared identity from its own stray content. The real
// dist/git/merge-quarantine.js is verified byte-identical before and after every call.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
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
  const tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-25d0d45b-distcopy-"));
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
    // @decision 25d0d45b (Round 4 ruling, item a) — report a FAIL, never throw: a RED run whose own
    // find-text has drifted must not crash the whole process before any LATER scenario gets to run.
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
  // (MAIN) a genuinely foreign, resolvable tmp residue is armed ACTIVE in-process immediately — the
  // consumer-surface RED-at-pre-fix-sha premise (card 1fea8b15's own "fail-open at runtime" window,
  // closed here for this one shape). D shares R's own degraded key (ancestor-walk collapse).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("main-r");
    const key = canonicalRepoLockKey(r);
    const tR = enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const d = path.join(r, "ghost-subdir"); // no own .git -- walks up to r's own key
    const dToken = randomUUID();
    const strandedDTmp = plantTmpResidue(key, d, "loom/d-branch", "D's own real raise, never promoted (torn write)", [dToken], "88881-cafed001");
    fs.mkdirSync(d, { recursive: true }); // D "remounts" -- still no own .git, still resolvable

    mod.clearMergeQuarantineByToken(r, tR); // r's own full lift (token route) -- NOT identity-wide
    check("(main precondition) D's foreign tmp SURVIVES r's clear", fs.existsSync(strandedDTmp));
    const assertD = mod.assertRepoNotQuarantined(d);
    check("*** THE MAIN FIX *** (main) assertRepoNotQuarantined(D) REFUSES in-process, same process, no reboot needed", assertD.ok === false);
    const dEntry = mod.activeMergeQuarantineFor(d);
    check("(main) ...the armed entry carries D's own real, surviving foreign token", !!dEntry && dEntry.tokens.includes(dToken));
    check("(main) ...and still names the tmp in its own orphanLatchFiles (so D's own later clear sweeps it)", !!dEntry && (dEntry.orphanLatchFiles ?? []).includes(path.basename(strandedDTmp)));
    crossCheck("main-D", mod, d);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (EXCL-B) TOKEN-ROUTE FULL LIFT (identityWideHumanClear:false) — R's OWN stray tmp, same identity,
  // holds an EXTRA token the current raise never carried. `protectForeignTmpResidueBeforeSweep`'s own
  // `ownTokensByFile` is computed either way but deliberately WITHHELD from this route (1fea8b15 round 2:
  // "a narrower token-scoped clear must never get it") -- so WITHOUT `excludeIdentities`, this card's own
  // new arm phase would resurrect R from its own just-lifted content. WITH it, R stays correctly lifted.
  //
  // Note (documented, pre-existing, UNRELATED to this card): the stray tmp itself still survives on disk
  // (fail-closed, correctly uncovered) and a LATER real boot independently re-arms R from it -- this is
  // 1fea8b15's own already-ACCEPTED "fail-closed over-block" trade-off for this exact call shape, present
  // identically before and after this card. This scenario asserts the IN-PROCESS state only for that
  // reason; it does not assert in-process === post-reboot here (see the UNION scenario below for the
  // shape where that equality genuinely IS the governing invariant).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("exclb-r");
    const key = canonicalRepoLockKey(r);
    const tR = enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const strayTmp = plantTmpResidue(key, r, "loom/r-old-branch", "r's own prior crashed raise, never promoted", ["R-EXTRA-STRAY-TOKEN-B"], "88882-cafed002");

    mod.clearMergeQuarantineByToken(r, tR); // FULL LIFT via the token route
    check("(exclB) r's own stray tmp SURVIVES (fail-closed, correctly uncovered)", fs.existsSync(strayTmp));
    check("*** THE FIX IS LOAD-BEARING (exclB) *** r reads UNBLOCKED in-process right after its own full lift", mod.assertRepoNotQuarantined(r).ok === true);
    check("(exclB) ...no second representation of r was armed", mod.listActiveMergeQuarantines().filter((e) => e.repoPath === r).length === 0);

    // RED PROOF: the SAME scenario, replayed from scratch against a dist COPY with the exclusion
    // stripped at this exact call site -- r SHOULD get wrongly resurrected from its own stray content.
    await withDistMutation(
      "identityWideHumanClear ? clearIdentityOwnTmpTokensByFile : [], new Set([clearIdentity]));",
      "identityWideHumanClear ? clearIdentityOwnTmpTokensByFile : [], undefined);",
      async (mutated) => {
        const r2 = makeRepo("exclb-r2");
        const key2 = canonicalRepoLockKey(r2);
        const tR2 = mutated.enterMergeQuarantine(r2, "loom/r2-branch", "r2's own real raise");
        const strayTmp2 = plantTmpResidue(key2, r2, "loom/r2-old-branch", "r2's own prior crashed raise, never promoted", ["R2-EXTRA-STRAY-TOKEN-B"], "88883-cafed003", mutated);
        mutated.clearMergeQuarantineByToken(r2, tR2);
        check("*** RED PROOF (exclB) *** WITHOUT excludeIdentities, r2 is WRONGLY re-armed from its own just-lifted stray content", mutated.assertRepoNotQuarantined(r2).ok === false);
        try { fs.rmSync(strayTmp2, { force: true }); } catch { /* best-effort */ }
      },
    );
    crossCheck("exclB-r", mod, r);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (EXCL-C) REST CLEAR-BY-ID, matchedPending branch (`clearMergeQuarantineLatchFile`) -- P is a genuinely
  // UNRESOLVABLE identity, raised once (lands PENDING), whose OWN pending-divert hash ALSO has a stray
  // `.tmp-<pid>` residue (same identity, an uncovered extra token) sitting at that exact id. Clearing by
  // that id removes P from `pendingUnresolvedQuarantines` BEFORE the tmp sweep runs, so WITHOUT
  // `matchedIdentities` excluded, the stray residue would resurrect P right after its own REST clear.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = path.join(os.tmpdir(), `loom-mq25d0d4-exclc-p-never-exists-${freshSfx()}`); // never created
    enterMergeQuarantine(p, "loom/p-branch", "p's own real raise (unresolvable)");
    const pending = mod.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === p);
    check("(exclC precondition) p landed PENDING", !!pending);
    // Mirrors `pendingLatchIdFor`'s own PENDING_DIVERT_RE branch (merge-quarantine.ts ~:7567): hash the
    // FULL basename, never slice a bare 24-hex id out of it.
    const pId = createHash("sha256").update(pending.sourceFile).digest("hex").slice(0, 24);
    const strayTmp = plantTmpResidueAtHash(pId, p, "loom/p-old-branch", "p's own prior crashed raise, never promoted", ["P-EXTRA-STRAY-TOKEN-C"], "88884-cafed004");

    const clearResult = mod.clearMergeQuarantineLatchFile(pId);
    check("(exclC) clear-by-id succeeded", clearResult.ok === true);
    check("(exclC) p's own stray tmp SURVIVES (fail-closed, correctly uncovered)", fs.existsSync(strayTmp));
    check("*** THE FIX IS LOAD-BEARING (exclC) *** p reads UNBLOCKED in-process right after its own REST clear-by-id", mod.assertRepoNotQuarantined(p).ok === true);

    await withDistMutation(
      "const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id, pendingCandidateTokens, undefined, false, [], matchedIdentities);",
      "const tmpSweep = sweepTmpResidueForHashIfUnreferenced(id, pendingCandidateTokens, undefined, false, [], undefined);",
      async (mutated) => {
        const p2 = path.join(os.tmpdir(), `loom-mq25d0d4-exclc-p2-never-exists-${freshSfx()}`);
        mutated.enterMergeQuarantine(p2, "loom/p2-branch", "p2's own real raise (unresolvable)");
        const pending2 = mutated.listPendingMergeQuarantinesTestOnly().find((e) => e.repoPath === p2);
        const pId2 = createHash("sha256").update(pending2.sourceFile).digest("hex").slice(0, 24);
        const strayTmp2 = plantTmpResidueAtHash(pId2, p2, "loom/p2-old-branch", "p2's own prior crashed raise, never promoted", ["P2-EXTRA-STRAY-TOKEN-C"], "88885-cafed005", mutated);
        mutated.clearMergeQuarantineLatchFile(pId2);
        check("*** RED PROOF (exclC) *** WITHOUT matchedIdentities excluded, p2 is WRONGLY re-armed from its own just-cleared stray content", mutated.assertRepoNotQuarantined(p2).ok === false);
        try { fs.rmSync(strayTmp2, { force: true }); } catch { /* best-effort */ }
      },
    );
    crossCheck("exclC-p", mod, p);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (EXCL-A, investigated, NOT a RED test) identity-wide human clear by key (identityWideHumanClear:true).
  // Investigated directly: `protectForeignTmpResidueBeforeSweep`'s own `ownTokensByFile` captures EVERY
  // on-disk token of a SAME-IDENTITY tmp UNCONDITIONALLY (never gated on whether the token overlaps the
  // current raise) whenever `clearIdentity` is set -- which it always is for this route. So a same-
  // identity stray tmp can never reach this card's own content-kept+armable branch via ANY reachable
  // identity-wide-clear-by-key path; `excludeIdentities` is a correct, defensive backstop at this call
  // site, but not reachable as a RED case through real production code. Verified directly (not merely
  // asserted): R's own stray tmp, holding a token OUTSIDE the current raise's own set, is swept CLEAN
  // (never kept, never armed) by an ordinary identity-wide `clearMergeQuarantine(r)`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("excla-r");
    const key = canonicalRepoLockKey(r);
    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const strayTmp = plantTmpResidue(key, r, "loom/r-old-branch", "r's own prior crashed raise", ["R-EXTRA-STRAY-TOKEN-A"], "88886-cafed006");

    const clearResult = mod.clearMergeQuarantine(r); // identity-wide human clear by key
    check("(exclA, investigated) r's own stray tmp is SWEPT CLEAN (never content-kept) under an identity-wide clear", !fs.existsSync(strayTmp));
    check("(exclA, investigated) r is fully lifted, no entry for it remains", clearResult.liftedRepoPaths.includes(r) && !mod.listActiveMergeQuarantines().some((e) => e.repoPath === r));
    check("(exclA, investigated) assertRepoNotQuarantined(r) reads unblocked", mod.assertRepoNotQuarantined(r).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (UNION) two foreign `.tmp-<pid>` residues for the SAME unenforced identity T, sharing one hash.
  // Clearing r releases ONLY the first file's own token -- the second, SEPARATE file's own disjoint token
  // must still be armed too (the union collected across the WHOLE per-hash loop, armed ONCE), or T's
  // in-process verdict would SPLIT from what the next real boot (which unions every tmp at a key) would
  // derive from the identical bytes -- exactly the shape 1dd00dca round 3 was corrected for on the `.json`
  // side, now proven on the `.tmp` side too.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("union-r");
    const key = canonicalRepoLockKey(r);
    const tR = enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const t = path.join(r, "ghost-subdir-union"); // no own .git -- shares r's own key
    const tTokenA = "T-UNION-TOKEN-A";
    const tTokenB = "T-UNION-TOKEN-B";
    const tmpA = plantTmpResidue(key, t, "loom/t-branch", "T's own first crashed raise, never promoted", [tTokenA], "88887-cafed007");
    const tmpB = plantTmpResidue(key, t, "loom/t-branch", "T's own second, SEPARATE crashed raise, never promoted", [tTokenB], "88888-cafed008");
    fs.mkdirSync(t, { recursive: true }); // T "remounts" -- still resolvable, still shares r's key

    mod.clearMergeQuarantineByToken(r, tR);
    check("(union precondition) BOTH of T's foreign tmps survive r's clear", fs.existsSync(tmpA) && fs.existsSync(tmpB));
    const tEntry = mod.activeMergeQuarantineFor(t);
    check("*** THE UNION FIX *** (union) T is armed with BOTH tokens, from BOTH files, in ONE arm", !!tEntry && tEntry.tokens.includes(tTokenA) && tEntry.tokens.includes(tTokenB));
    check("(union) ...and both basenames are named in orphanLatchFiles (so T's own later clear sweeps BOTH)", !!tEntry && [path.basename(tmpA), path.basename(tmpB)].every((b) => (tEntry.orphanLatchFiles ?? []).includes(b)));

    // Release ONLY tTokenA (as if only the FIRST crashed raise's own caller were still tracking it).
    mod.clearMergeQuarantineByToken(t, tTokenA);
    const beforeReboot = mod.assertRepoNotQuarantined(t);
    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    const afterReboot = fresh.assertRepoNotQuarantined(t);
    check("*** THE GOVERNING INVARIANT (union) *** T's in-process verdict after releasing only tTokenA === its post-reboot verdict", beforeReboot.ok === afterReboot.ok);
    check("(union) ...and that verdict is BLOCKED (tTokenB is still genuinely outstanding either way)", beforeReboot.ok === false && afterReboot.ok === false);
    crossCheck("union-T", mod, t);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (COVERAGE-TMP, Round 3 ruling, item 1) -- restores the positive assertion lost when round 1/2's own
  // fix flipped every "parsed-but-kept" assertion toward "referencing": a tmp residue that is GENUINELY
  // UN-ARMABLE (foreign, but its own content is missing `branch` -- `orphanSweepSafeToDelete`'s own
  // `armableByPass1` gate requires BOTH `branch` and `reason` as strings) must stay reported via
  // contentKeptRepoPaths FOREVER, never stillBlockedCoOccupants -- nothing ever arms it, and nothing else
  // in-process collides with its own key. RED-under-mutation: a dist copy whose shared
  // `classifyKeptRepoPath` predicate always answers "live" must WRONGLY report U as blocked instead.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("covtmp-r");
    const key = canonicalRepoLockKey(r);
    const u = path.join(r, "ghost-subdir-covtmp"); // no own .git -- shares r's own key
    const uToken = randomUUID();
    // No `branch` field -- deliberately non-armable.
    const nonArmableTmp = plantTmpResidue(key, u, undefined, "U's own real raise, never promoted (missing branch)", [uToken], "88891-cafed011");
    fs.mkdirSync(u, { recursive: true }); // U "remounts" -- still no own .git, still resolvable

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const clearResult = mod.clearMergeQuarantine(r);
    check("(covTmp) U's non-armable tmp SURVIVES r's clear", fs.existsSync(nonArmableTmp));
    check("*** THE COVERAGE FIX (covTmp) *** U IS in contentKeptRepoPaths", !!clearResult.contentKeptRepoPaths?.includes(u));
    check("(covTmp) U is NOT in stillBlockedCoOccupants (genuinely never armed -- missing branch)", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === u));
    check("(covTmp) ...and assertRepoNotQuarantined(U) reads UNBLOCKED (nothing ever armed it)", mod.assertRepoNotQuarantined(u).ok === true);

    await withDistMutation(
      "function classifyKeptRepoPath(repoPath, sourceFile) {\n    const co = blockedCoOccupantForReferencer(repoPath, sourceFile);",
      "function classifyKeptRepoPath(repoPath, sourceFile) {\n    return { live: true, coOccupant: blockedCoOccupant(repoPath, sourceFile) };\n    const co = blockedCoOccupantForReferencer(repoPath, sourceFile);",
      async (mutated) => {
        const r2 = makeRepo("covtmp-r2");
        const key2 = canonicalRepoLockKey(r2);
        const u2 = path.join(r2, "ghost-subdir-covtmp2");
        const nonArmableTmp2 = plantTmpResidue(key2, u2, undefined, "U2's own real raise, never promoted (missing branch)", [randomUUID()], "88892-cafed012", mutated);
        fs.mkdirSync(u2, { recursive: true });
        mutated.enterMergeQuarantine(r2, "loom/r2-branch", "r2's own real raise");
        const clearResult2 = mutated.clearMergeQuarantine(r2);
        check("*** RED PROOF (covTmp) *** with the gate mutated to always say 'blocked', U2 is WRONGLY reported in stillBlockedCoOccupants", !!clearResult2.stillBlockedCoOccupants?.some((c) => c.repoPath === u2));
        try { fs.rmSync(nonArmableTmp2, { force: true }); } catch { /* best-effort */ }
      },
    );
    try { fs.rmSync(nonArmableTmp, { force: true }); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (COVERAGE-ORPHAN, Round 3 ruling, item 1) -- the SAME restored coverage, for the `.json` orphan path
  // this card shares `classifyKeptRepoPath` with (`sweepOrphanLatchFileIfUnreferenced`, owned by card
  // 1dd00dca). A foreign orphan reference whose own content is missing `branch` is genuinely UN-ARMABLE
  // -- it must stay content-kept forever, never a blocked co-occupant.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const a = makeRepo("covjson-a");
    const keyA = canonicalRepoLockKey(a);
    enterMergeQuarantine(a, "loom/a-branch", "a's own real raise");
    // Fold a fresh orphan reference directly onto a's OWN live in-memory entry (never a disk-fold +
    // reboot -- this sweep reads `entry.orphanLatchFiles` from the LIVE object, not a freshly-reloaded
    // one, so skipping the fold-on-disk's own reboot step here is deliberate, not an oversight).
    const activeA = mod.activeMergeQuarantineFor(a);
    const orphanBasename = `${createHash("sha256").update(`covjson-v-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    mod.setActiveQuarantineTestOnly(keyA, { ...activeA, orphanLatchFiles: [...(activeA.orphanLatchFiles ?? []), orphanBasename] });

    const vRepoPath = path.join(os.tmpdir(), `loom-mq25d0d4-covjson-v-${freshSfx()}`); // never exists -- genuinely unresolvable, never collides with anything
    const vToken = randomUUID();
    // No `branch` field -- deliberately non-armable.
    const orphanPath = writeOrphanContent(orphanBasename, vRepoPath, undefined, "merge in progress for V (covJson, no branch)", [vToken]);
    check("(covJson precondition) O exists before a's clear", fs.existsSync(orphanPath));

    const clearResult = mod.clearMergeQuarantine(a);
    check("(covJson) O (holding V's foreign, non-armable content) SURVIVES a's clear", fs.existsSync(orphanPath));
    check("*** THE COVERAGE FIX (covJson) *** V IS in contentKeptRepoPaths", !!clearResult.contentKeptRepoPaths?.includes(vRepoPath));
    check("(covJson) V is NOT in stillBlockedCoOccupants (genuinely never armed -- missing branch)", !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === vRepoPath));
    check("(covJson) ...and assertRepoNotQuarantined(V) reads UNBLOCKED (nothing ever armed it)", mod.assertRepoNotQuarantined(vRepoPath).ok === true);

    await withDistMutation(
      "function classifyKeptRepoPath(repoPath, sourceFile) {\n    const co = blockedCoOccupantForReferencer(repoPath, sourceFile);",
      "function classifyKeptRepoPath(repoPath, sourceFile) {\n    return { live: true, coOccupant: blockedCoOccupant(repoPath, sourceFile) };\n    const co = blockedCoOccupantForReferencer(repoPath, sourceFile);",
      async (mutated) => {
        const a2 = makeRepo("covjson-a2");
        const keyA2 = canonicalRepoLockKey(a2);
        mutated.enterMergeQuarantine(a2, "loom/a2-branch", "a2's own real raise");
        const activeA2 = mutated.activeMergeQuarantineFor(a2);
        const orphanBasename2 = `${createHash("sha256").update(`covjson-v2-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
        mutated.setActiveQuarantineTestOnly(keyA2, { ...activeA2, orphanLatchFiles: [...(activeA2.orphanLatchFiles ?? []), orphanBasename2] });
        const v2RepoPath = path.join(os.tmpdir(), `loom-mq25d0d4-covjson-v2-${freshSfx()}`);
        const orphanPath2 = writeOrphanContent(orphanBasename2, v2RepoPath, undefined, "merge in progress for V2 (covJson, no branch)", [randomUUID()], mutated);
        const clearResult2 = mutated.clearMergeQuarantine(a2);
        check("*** RED PROOF (covJson) *** with the gate mutated to always say 'blocked', V2 is WRONGLY reported in stillBlockedCoOccupants", !!clearResult2.stillBlockedCoOccupants?.some((c) => c.repoPath === v2RepoPath));
        try { fs.rmSync(orphanPath2, { force: true }); } catch { /* best-effort */ }
      },
    );
    try { fs.rmSync(orphanPath, { force: true }); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (PROBE, Round 4 ruling) -- the final re-CR's own probe shape: Y is independently quarantined (its
  // own real raise); X = Y's own subdirectory (no own .git, so X's REAL canonical key is Y's, always);
  // X's own armable tmp sits at a WHOLLY DIFFERENT repo R's hash (a stray/mismatched residue -- R's own
  // trailing sweep is what examines it, never X's). Clearing R must report X as CONTENT-KEPT with
  // blockedBy Y -- NEVER a routed co-occupant (X's own real key is Y's, not R's, so routing X to ANY id
  // derived from R's own sweep is categorically wrong) -- and R's own clear must never lift, address, or
  // otherwise name Y at all. RED at 9513fe1c (round 3's own tip): that code reported X as blocked and
  // routed it to a DEAD id derived from R's own just-cleared hash.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("probe-y");
    const r = makeRepo("probe-r");
    const keyR = canonicalRepoLockKey(r);
    const x = path.join(y, "ghost-subdir-probe"); // no own .git -- X's real key is Y's, always
    fs.mkdirSync(x, { recursive: true });

    enterMergeQuarantine(y, "loom/y-branch", "y's own real, independent raise");
    enterMergeQuarantine(r, "loom/r-branch", "r's own real, UNRELATED raise");
    // X's own tmp is planted at R's hash -- a stray/mismatched residue, never X's own real key's hash.
    const xToken = randomUUID();
    const xTmpAtRsHash = plantTmpResidue(keyR, x, "loom/x-branch", "X's own stray tmp, mismatched onto R's own hash", [xToken], "88899-cafed019");

    const clearResult = mod.clearMergeQuarantine(r);
    check("(probe) X's own stray tmp SURVIVES r's clear", fs.existsSync(xTmpAtRsHash));
    check("*** THE FIX (probe) *** X is CONTENT-KEPT, never a routed co-occupant", !!clearResult.contentKeptRepoPaths?.includes(x) && !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === x));
    const xBlockedBy = clearResult.contentKeptBlockedBy?.find((b) => b.repoPath === x);
    check("(probe) ...with a blockedBy disclosure correctly naming Y (X's OWN real blocker), with a real id", xBlockedBy?.blockedBy?.repoPath === y && !!xBlockedBy?.blockedBy?.id);
    check("*** THE FIX (probe) *** r's own clear never lifts, addresses, or names Y at all", !clearResult.liftedRepoPaths?.includes(y) && !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === y));
    check("(probe) assertRepoNotQuarantined(X) refuses, matching the blockedBy disclosure", mod.assertRepoNotQuarantined(x).ok === false);
    check("(probe) ...and Y is untouched by r's clear -- still genuinely, independently quarantined", mod.assertRepoNotQuarantined(y).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (PROBE-SPELLING, Round 5 ruling, item 3 MINOR) -- Y is independently quarantined (own real raise,
  // spelling B). A FOREIGN tmp residue at a WHOLLY DIFFERENT repo R's hash names Y's own SELF via a
  // spelling/separator variant (spelling A -- same realpath/canonical key, a different literal string;
  // same technique as (K) in merge-quarantine-clear-by-path.mjs). `blockedCoOccupantForReferencer`'s own
  // raw string compare (`e.repoPath === repoPath`) MISSES this (different literal strings), so only
  // `classifyKeptRepoPath`'s `directPathIdentity` equality (this round's MINOR fix) recognizes the
  // blocker IS spelling-A's own entry (same identity as itself), never "a DIFFERENT identity". Pre-fix,
  // this would wrongly report spelling-A as CONTENT-KEPT with a `blockedBy` disclosure naming itself.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const ySpellB = makeRepo("probe-spelling-y");
    const r = makeRepo("probe-spelling-r");
    const keyR = canonicalRepoLockKey(r);
    const ySpellA = ySpellB + path.sep;

    enterMergeQuarantine(ySpellB, "loom/y-branch", "y's own real, independent raise (spelling B)");
    enterMergeQuarantine(r, "loom/r-branch", "r's own real, UNRELATED raise");
    const yToken = randomUUID();
    const yTmpAtRsHash = plantTmpResidue(keyR, ySpellA, "loom/y-branch", "Y's own stray tmp, spelled differently (A), mismatched onto R's own hash", [yToken], "88897-cafed017");

    const clearResult = mod.clearMergeQuarantine(r);
    check("(probe-spelling) negative control: the two spellings are not literally identical strings", ySpellA !== ySpellB);
    check("(probe-spelling) Y's own stray tmp SURVIVES r's clear", fs.existsSync(yTmpAtRsHash));
    // `blockedCoOccupantForReferencer` (deliberately left at its reverted, raw-string-compare contract
    // per the ruling) still can't mint a WORKING `{id}` route for a spelling variant of its own entry --
    // only `classifyKeptRepoPath`'s own disposition (live vs content-kept) is what this MINOR fix
    // changes. Assert the DISPOSITION: a live blocked co-occupant (even sans a working id), never
    // content-kept with a `blockedBy` disclosure wrongly naming itself as "a DIFFERENT identity".
    const ySpellACoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === ySpellA);
    check("*** THE FIX (probe-spelling) *** the spelling-variant is reported as a genuine blocked co-occupant (Y's OWN entry), never content-kept with a blockedBy naming itself", !!ySpellACoOccupant && !clearResult.contentKeptRepoPaths?.includes(ySpellA) && !clearResult.contentKeptBlockedBy?.some((b) => b.repoPath === ySpellA));
    check("(probe-spelling) ...and Y itself is untouched by r's clear -- still genuinely, independently quarantined", !clearResult.liftedRepoPaths?.includes(ySpellB) && mod.assertRepoNotQuarantined(ySpellB).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MINOR2, Round 4 ruling) -- D1 and D2, two DISTINCT foreign identities co-located at r's own key K
  // (two separate torn tmps at the SAME hash), each content-distinct, each independently armable.
  // Whichever is processed first gets genuinely ARMED (its OWN entry); the OTHER was NEVER armed in its
  // own right, and -- per Round 4's corrected rule -- is reported CONTENT-KEPT with a `blockedBy`
  // disclosure naming the winner, NEVER as a routed co-occupant (Round 3's own fix wrongly routed it to
  // the winner's id -- a DEAD route on every clear-by-id path, per the final re-CR's own probe). Pins
  // the CR-measured convergence: following the reported routes frees BOTH identities in exactly 2
  // clears (clear D1's own route; D2 then re-arms from its own surviving tmp and reports its OWN real
  // route in THAT SAME result; clear D2's route too) -- in-process, with every step's own report
  // matching `assertRepoNotQuarantined`, and a reboot right after the FIRST clear independently
  // re-deriving the same blocked verdict for both (boot unions both tmps into ONE entry at the shared key).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("minor2-r");
    const key = canonicalRepoLockKey(r);
    const d1 = path.join(r, "ghost-subdir-d1"); // no own .git -- shares r's own key
    const d2 = path.join(r, "ghost-subdir-d2"); // no own .git -- ALSO shares r's own key
    const d1Token = randomUUID();
    const d2Token = randomUUID();
    const tmp1 = plantTmpResidue(key, d1, "loom/d1-branch", "D1's own real raise, never promoted (torn write)", [d1Token], "88893-cafed013");
    const tmp2 = plantTmpResidue(key, d2, "loom/d2-branch", "D2's own real raise, never promoted (torn write)", [d2Token], "88894-cafed014");
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true });

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const clearResult = mod.clearMergeQuarantine(r);
    check("(minor2) BOTH D1's and D2's foreign tmps SURVIVE r's clear", fs.existsSync(tmp1) && fs.existsSync(tmp2));

    const d1CoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d1);
    const d2CoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d2);
    // Whichever of D1/D2 was processed first in the per-hash loop wins the key; relabel so the rest of
    // this scenario reads identically regardless of `fs.readdirSync`'s own (unspecified) order.
    const [winner, winnerCoOccupant, loser, loserPath] = d1CoOccupant
      ? [d1, d1CoOccupant, d2, d2]
      : [d2, d2CoOccupant, d1, d1];
    check("*** THE FIX (minor2) *** the WINNER is reported as a blocked co-occupant, with a route id", !!winnerCoOccupant?.route?.id);
    check("(minor2) the winner is NOT in contentKeptRepoPaths", !clearResult.contentKeptRepoPaths?.includes(winner));
    const loserContentKept = !!clearResult.contentKeptRepoPaths?.includes(loser);
    check("*** THE FIX (minor2) *** the LOSER is CONTENT-KEPT, never a routed co-occupant (the Round 3 bug this closes)", loserContentKept && !clearResult.stillBlockedCoOccupants?.some((c) => c.repoPath === loser));
    const loserBlockedBy = clearResult.contentKeptBlockedBy?.find((b) => b.repoPath === loser);
    check("(minor2) ...and its blockedBy disclosure correctly names the WINNER, with a real id", loserBlockedBy?.blockedBy?.repoPath === winner && !!loserBlockedBy?.blockedBy?.id);
    check("(minor2) result-says-blocked === assertRepoNotQuarantined-refuses, for BOTH", !!winnerCoOccupant === (mod.assertRepoNotQuarantined(winner).ok === false) && loserContentKept === (mod.assertRepoNotQuarantined(loser).ok === false));
    check("(minor2) ...and BOTH actually refuse (the shared key K is genuinely occupied by the winner)", mod.assertRepoNotQuarantined(winner).ok === false && mod.assertRepoNotQuarantined(loser).ok === false);

    // *** THE CR-MEASURED CONVERGENCE *** -- clear #1 of 2: follow the WINNER's own reported route.
    check("(minor2 precondition) winner's route id is present before following it", !!winnerCoOccupant?.route?.id);
    const clearWinner = winnerCoOccupant?.route?.id ? mod.clearMergeQuarantineLatchFile(winnerCoOccupant.route.id) : { ok: false, stillBlockedCoOccupants: [] };
    check("(minor2) clearing the winner's own route succeeds (matches + processes the winner's OWN entry)", clearWinner.ok === true);
    // The winner's own PATH can still read quarantined right after this -- its canonical key is the SAME
    // shared key, and the loser's own tmp (never swept -- its token was never covered by the winner's
    // clear) immediately re-arms the instant that key frees, so the shared key stays occupied either
    // way (ancestor-key collapse) until the loser's OWN route is ALSO followed below. Asserting
    // "the winner reads unblocked" HERE would be wrong -- see the final convergence check instead.
    const loserNowCoOccupant = clearWinner.stillBlockedCoOccupants?.find((c) => c.repoPath === loserPath);
    check("*** THE CONVERGENCE *** (minor2) the loser is NOW reported LIVE, with its OWN real route, in this SAME result", !!loserNowCoOccupant?.route?.id);
    check("(minor2) ...and the loser's own path reads blocked, consistent with that report", mod.assertRepoNotQuarantined(loserPath).ok === false);

    // Clear #2 of 2: follow the loser's OWN newly-reported route.
    if (loserNowCoOccupant?.route?.id) {
      const clearLoser = mod.clearMergeQuarantineLatchFile(loserNowCoOccupant.route.id);
      check("(minor2) clearing the loser's own NEW route succeeds and genuinely lifts it", clearLoser.ok === true && clearLoser.liftedRepoPaths?.includes(loserPath));
      check("*** BOTH IDENTITIES ARE FREE AFTER EXACTLY 2 CLEARS *** (minor2)", mod.assertRepoNotQuarantined(winner).ok === true && mod.assertRepoNotQuarantined(loserPath).ok === true);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MINOR2-REBOOT, Round 4 ruling) -- the SAME D1/D2 shape, but checking convergence with a REAL boot
  // right after clearing R alone (before any follow-up clear): a fresh process, scanning disk from
  // scratch, UNIONS both of D1's/D2's own surviving tmps into ONE entry at their shared key (boot does
  // not distinguish "D1" vs "D2" as separate identities the way the in-process disclosure now does) --
  // so both are STILL reported blocked post-reboot, agreeing with the in-process verdict, even though
  // the INTERNAL representation differs (one union entry at boot vs. one live + one content-disclosed
  // in-process).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("minor2reboot-r");
    const key = canonicalRepoLockKey(r);
    const d1 = path.join(r, "ghost-subdir-d1-reboot");
    const d2 = path.join(r, "ghost-subdir-d2-reboot");
    const tmp1 = plantTmpResidue(key, d1, "loom/d1-branch", "D1's own real raise, never promoted (torn write)", [randomUUID()], "88897-cafed017");
    const tmp2 = plantTmpResidue(key, d2, "loom/d2-branch", "D2's own real raise, never promoted (torn write)", [randomUUID()], "88898-cafed018");
    fs.mkdirSync(d1, { recursive: true });
    fs.mkdirSync(d2, { recursive: true });

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    mod.clearMergeQuarantine(r);
    check("(minor2reboot precondition) BOTH tmps survive r's clear", fs.existsSync(tmp1) && fs.existsSync(tmp2));
    const beforeD1 = mod.assertRepoNotQuarantined(d1);
    const beforeD2 = mod.assertRepoNotQuarantined(d2);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([r]);
    const afterD1 = fresh.assertRepoNotQuarantined(d1);
    const afterD2 = fresh.assertRepoNotQuarantined(d2);
    check("*** THE CONVERGENCE (reboot) *** D1's in-process verdict === its post-reboot verdict", beforeD1.ok === afterD1.ok);
    check("*** THE CONVERGENCE (reboot) *** D2's in-process verdict === its post-reboot verdict", beforeD2.ok === afterD2.ok);
    check("(minor2reboot) both are BLOCKED, in-process and after reboot alike", beforeD1.ok === false && beforeD2.ok === false && afterD1.ok === false && afterD2.ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MINOR3-TMP, Round 3 ruling) -- ONE foreign identity E, behind TWO `.tmp-<pid>` residues at the SAME
  // hash (one ARMABLE, one missing `branch`). Once E is armed (via its one armable tmp), its non-armable
  // sibling must ALSO report BLOCKED -- reported ONCE for E, never dual-reported alongside a separate
  // contentKept entry for the same E (both files resolve to the SAME `stillBlockedEntryFor(E)` answer,
  // checked AFTER the arm phase, so they can never disagree with each other).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("minor3tmp-r");
    const key = canonicalRepoLockKey(r);
    const e = path.join(r, "ghost-subdir-minor3tmp"); // no own .git -- shares r's own key
    const eToken = randomUUID();
    const eTokenB = randomUUID();
    const armableTmp = plantTmpResidue(key, e, "loom/e-branch", "E's own real raise, never promoted (torn write)", [eToken], "88895-cafed015");
    const nonArmableTmp = plantTmpResidue(key, e, undefined, "E's own SECOND crashed raise, never promoted (missing branch)", [eTokenB], "88896-cafed016");
    fs.mkdirSync(e, { recursive: true }); // E "remounts" -- still no own .git, still shares r's key

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const clearResult = mod.clearMergeQuarantine(r);
    check("(minor3tmp) both of E's own tmp residues SURVIVE r's clear", fs.existsSync(armableTmp) && fs.existsSync(nonArmableTmp));

    const eCoOccupants = clearResult.stillBlockedCoOccupants?.filter((c) => c.repoPath === e) ?? [];
    // @decision 25d0d45b (Round 4, item b) -- a "reported exactly once" count can't fail (Map dedupe) --
    // the REAL discriminator is the NEXT check: E must not be dual-reported across the live/content-kept
    // boundary.
    check("(minor3tmp) E appears in stillBlockedCoOccupants (count is NOT the discriminator -- see below)", eCoOccupants.length === 1);
    check("(minor3tmp) ...with a working route id", !!eCoOccupants[0]?.route?.id);
    check("*** THE FIX (minor3tmp) *** E is NOT ALSO in contentKeptRepoPaths (no dual reporting alongside a content-kept entry)", !clearResult.contentKeptRepoPaths?.includes(e));
    check("(minor3tmp) result-says-blocked === assertRepoNotQuarantined-refuses", (eCoOccupants.length > 0) === (mod.assertRepoNotQuarantined(e).ok === false));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MINOR3-ORPHAN, Round 3 ruling) -- the SAME "reported once" invariant for the `.json` orphan path:
  // ONE foreign identity E2, referenced by TWO SEPARATE orphan files (both foreign, both armable, both
  // folded into r's own orphanLatchFiles). E2 must be reported as a blocked co-occupant EXACTLY ONCE,
  // never once per referencing file.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("minor3json-r");
    const key = canonicalRepoLockKey(r);
    const e2 = path.join(r, "ghost-subdir-minor3json");
    fs.mkdirSync(e2, { recursive: true });

    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");
    const activeR = mod.activeMergeQuarantineFor(r);
    const orphanBasename1 = `${createHash("sha256").update(`minor3json-orphan1-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    const orphanBasename2 = `${createHash("sha256").update(`minor3json-orphan2-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    mod.setActiveQuarantineTestOnly(key, { ...activeR, orphanLatchFiles: [...(activeR.orphanLatchFiles ?? []), orphanBasename1, orphanBasename2] });
    const orphanPath1 = writeOrphanContent(orphanBasename1, e2, "loom/e2-branch", "merge in progress for E2 (minor3json, orphan1)", [randomUUID()]);
    const orphanPath2 = writeOrphanContent(orphanBasename2, e2, "loom/e2-branch", "merge in progress for E2 (minor3json, orphan2)", [randomUUID()]);

    const clearResult = mod.clearMergeQuarantine(r);
    check("(minor3json) both of E2's own orphan files SURVIVE r's clear", fs.existsSync(orphanPath1) && fs.existsSync(orphanPath2));

    const e2CoOccupants = clearResult.stillBlockedCoOccupants?.filter((c) => c.repoPath === e2) ?? [];
    // @decision 25d0d45b (Round 4, item b) -- same Map-dedupe caveat as MINOR3-TMP's own count check.
    check("(minor3json) E2 appears in stillBlockedCoOccupants (count is NOT the discriminator -- see below)", e2CoOccupants.length === 1);
    check("(minor3json) ...with a working route id", !!e2CoOccupants[0]?.route?.id);
    check("*** THE FIX (minor3json) *** E2 is NOT ALSO in contentKeptRepoPaths", !clearResult.contentKeptRepoPaths?.includes(e2));
    check("(minor3json) result-says-blocked === assertRepoNotQuarantined-refuses", (e2CoOccupants.length > 0) === (mod.assertRepoNotQuarantined(e2).ok === false));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (REPORT-TMP, Code Review of this card, MAJOR 1) -- once armed, a kept `.tmp-residue` must report as
  // a genuine blocked co-occupant (a working `{id}` route), never as a mere content-kept disclosure --
  // `clearMergeQuarantine` (not the token route, which returns no result to inspect) is used here
  // specifically so there is a real `clearResult` to check this against.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("reporttmp-r");
    const key = canonicalRepoLockKey(r);
    const d = path.join(r, "ghost-subdir-reporttmp");
    const dToken = randomUUID();
    const strandedDTmp = plantTmpResidue(key, d, "loom/d-branch", "D's own real raise, never promoted (torn write)", [dToken], "88890-cafed010");
    fs.mkdirSync(d, { recursive: true }); // D remounts, still resolvable, still shares r's key
    enterMergeQuarantine(r, "loom/r-branch", "r's own real raise");

    const clearResult = mod.clearMergeQuarantine(r);
    check("(reportTmp) D's foreign tmp residue SURVIVES r's clear", fs.existsSync(strandedDTmp));
    check("(reportTmp) D is NOT in contentKeptRepoPaths (it is now a genuine live entry)", !clearResult.contentKeptRepoPaths?.includes(d));
    const dCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
    check("*** THE FIX IS CORRECTLY REPORTED (reportTmp, .tmp path) *** D IS in stillBlockedCoOccupants, with a route id", !!dCoOccupant?.route?.id);
    check("(reportTmp) result-says-blocked === assertRepoNotQuarantined-refuses", !!dCoOccupant === (mod.assertRepoNotQuarantined(d).ok === false));
    // @decision 25d0d45b (Round 3, NIT 7) — guarded: a RED run (route.id missing) reports a FAIL here,
    // never a TypeError that aborts the process and hides every scenario after this one.
    const dClearById = dCoOccupant?.route?.id ? mod.clearMergeQuarantineLatchFile(dCoOccupant.route.id) : { ok: false, liftedRepoPaths: [] };
    check("(reportTmp) D's own {id} route is a REAL, WORKING clear route", dClearById.ok === true && dClearById.liftedRepoPaths.includes(d));
    check("(reportTmp) ...and D now reads unblocked after clearing it by that id", mod.assertRepoNotQuarantined(d).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (REPORT-JSON, Code Review of this card, MAJOR 1) -- the SAME fix, for the `.json` orphan path this
  // card shares `armForeignOrphanContentInMemoryIfUnenforced`/`classifyKeptRepoPath` with
  // (`sweepOrphanLatchFileIfUnreferenced`, owned by card 1dd00dca). That card's own test file never
  // exercises a `clearResult` object (it only ever uses the token route), so this scenario is this
  // card's own regression coverage for the shared reporting path on the `.json` side.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const a = makeRepo("reportjson-a");
    enterMergeQuarantine(a, "loom/a-branch", "a's own real raise");
    const orphanBasename = foldOrphanRefIntoOwnFinal(a);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([a]);
    check("(reportJson precondition) a is armed after boot, carrying the orphan reference",
      (fresh.activeMergeQuarantineFor(a)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const t = makeRepo("reportjson-t");
    const tToken = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, t, "loom/t-branch", "merge in progress for T (reportJson)", [tToken], fresh);
    check("(reportJson precondition) O exists before a's clear", fs.existsSync(orphanPath));

    const clearResult = fresh.clearMergeQuarantine(a);
    check("(reportJson) O (holding T's foreign token) SURVIVES a's clear", fs.existsSync(orphanPath));
    check("(reportJson) T is NOT in contentKeptRepoPaths (it is now a genuine live entry)", !clearResult.contentKeptRepoPaths?.includes(t));
    const tCoOccupant = clearResult.stillBlockedCoOccupants?.find((c) => c.repoPath === t);
    check("*** THE FIX IS CORRECTLY REPORTED (reportJson, .json path) *** T IS in stillBlockedCoOccupants, with a route id", !!tCoOccupant?.route?.id);
    check("(reportJson) result-says-blocked === assertRepoNotQuarantined-refuses", !!tCoOccupant === (fresh.assertRepoNotQuarantined(t).ok === false));
    // @decision 25d0d45b (Round 3, NIT 7) — guarded: a RED run (route.id missing) reports a FAIL here,
    // never a TypeError that aborts the process and hides every scenario after this one.
    const tClearById = tCoOccupant?.route?.id ? fresh.clearMergeQuarantineLatchFile(tCoOccupant.route.id) : { ok: false, liftedRepoPaths: [] };
    check("(reportJson) T's own {id} route is a REAL, WORKING clear route", tClearById.ok === true && tClearById.liftedRepoPaths.includes(t));
    check("(reportJson) ...and T now reads unblocked after clearing it by that id", fresh.assertRepoNotQuarantined(t).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (STALE DOC COMMENT) sweepTmpResidueForHashIfUnreferenced's own doc now names FIVE call sites, not
  // four -- a plain source-text pin so a future edit that drops one back to four is caught.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "git", "merge-quarantine.ts"), "utf8");
    check("(doc) sweepTmpResidueForHashIfUnreferenced's own doc comment names FIVE call sites", src.includes("FIVE, not four"));
  }
} finally {
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

if (failures > 0) {
  console.log(`\n❌ ${failures} FAILURE(S) — reproduces (or regresses the fix for) board card 25d0d45b.`);
  process.exit(1);
} else {
  console.log("\n✅ all checks passed.");
}
