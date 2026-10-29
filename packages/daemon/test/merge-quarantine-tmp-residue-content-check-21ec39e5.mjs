import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 21ec39e5 — a `.json.tmp-<pid>` residue is no longer deleted blind, in two separate places:
//
// (1) RUNTIME — `sweepTmpResidueForHashIfUnreferenced` (called from `writeMergeQuarantineLatch`'s
//     `sweepOtherTmpsOnSuccess` path, among others) used to unlink an unreferenced tmp with NO content
//     check at all. A foreign, currently-unresolvable repo's own stranded tmp sharing a key hash via an
//     ancestor-walk collision could be destroyed as pure collateral of a wholly unrelated sibling's own
//     successful write — no restart needed at all.
// (2) BOOT — `reenterMergeQuarantinesAtBootImpl`'s own PASS 1b "stale tmp beside a clean final" early
//     exit unconditionally `fs.unlinkSync`'d a tmp the instant its filename hash matched a repo whose
//     final already parsed cleanly — with NO content read. A renameSync failure AFTER a successful fsync
//     (a torn write) can strand the SUPERSEDING write's own tmp, holding a token `final` never received;
//     the old code deleted that tmp unread, permanently losing the token with no copy anywhere.
//
// THE FIX: both sites now read the tmp's own content first, via the SAME `orphanSweepSafeToDelete` helper
// a `.json` orphan sweep already used (never forked) — a provable SUBSET of what's already accounted for
// is still deleted exactly as before (same cost, same outcome); anything else is kept/diverted instead of
// destroyed. See docs/decisions/21ec39e5-tmp-residue-content-check-before-sweep.md for the full repro
// narrative and the three pre-existing tests this investigation found and corrected.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-tmp-residue-content-check-21ec39e5.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqtc21ec-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, listActiveMergeQuarantines,
  reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, clearMergeQuarantineByToken,
  clearMergeQuarantineLatchFile, quarantineLatchFileIdsFor, assertRepoNotQuarantined,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// A genuinely fresh ESM module instance per "boot" — Node's loader keys its module cache on the full URL
// including the query string, so each call gets its own `activeQuarantines`/`pendingUnresolvedQuarantines`.
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqtc21ec@loom -c user.name=mqtc21ec";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqtc21ec-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-tmp-residue-content-check-21ec39e5\n");
  execSync(`git init -q && git config user.email mqtc21ec@loom && git config user.name mqtc21ec`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO runtime-sweep-protects-foreign-unaccounted-tmp (repro 2) — a FOREIGN, currently-unresolvable
  // repo D's own stranded tmp, sharing R's own key hash via an ancestor-walk collision, must survive R's
  // own wholly unrelated, successful second raise (no restart at all).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("rt-protect-r");
    const d = path.join(r, "gone-subdir-does-not-exist"); // unresolvable; walks up to R's own key
    const key = canonicalRepoLockKey(r);
    check("(rt-protect) precondition: D's own key collides with R's (ancestor walk)", canonicalRepoLockKey(d) === key);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);

    const t1 = enterMergeQuarantine(r, "r-branch", "r's own real raise"); // R now has a live in-memory entry
    const dToken = "D-OWN-FOREIGN-TOKEN-rt-protect";
    const strandedDTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-99999-deadbeef`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(strandedDTmp, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own real raise, never promoted (torn write)",
      enteredAt: Date.now() - 1000, tokens: [dToken],
    }, null, 2) + "\n");
    check("(rt-protect) precondition: D's stranded tmp exists before R's second raise", fs.existsSync(strandedDTmp));

    const t2 = enterMergeQuarantine(r, "r-branch-2", "r's own second raise"); // same process, no restart
    check("*** THE FIX (rt-protect) *** D's foreign tmp residue SURVIVES R's own unrelated second raise", fs.existsSync(strandedDTmp));
    check("(rt-protect) R's own raise still succeeded normally (both tokens live)", !!t1 && !!t2 && activeMergeQuarantineFor(r)?.tokens?.length === 2);

    clearMergeQuarantine(r);
    try { fs.unlinkSync(strandedDTmp); } catch { /* best-effort cleanup — an orphan with no real repo behind it */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO runtime-sweep-still-deletes-pure-subset-tmp (positive control) — the common case is
  // unchanged: an unreferenced tmp whose own tokens are a PROVABLE SUBSET of the write's own superset is
  // still deleted, same as before this card.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("rt-control-r");
    const d = path.join(r, "gone-subdir-does-not-exist");
    const key = canonicalRepoLockKey(r);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);

    const t1 = enterMergeQuarantine(r, "r-branch", "r's own real raise");
    // D's tmp holds ONLY t1 — already fully accounted for by R's own fresh superset write below.
    const strandedDTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-11111-cafefeed`);
    fs.writeFileSync(strandedDTmp, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "a genuinely superseded leftover, already fully covered",
      enteredAt: Date.now() - 1000, tokens: [t1],
    }, null, 2) + "\n");
    check("(rt-control) precondition: the subset tmp exists before R's second raise", fs.existsSync(strandedDTmp));

    enterMergeQuarantine(r, "r-branch-2", "r's own second raise");
    check("(rt-control) the pure-subset tmp is STILL deleted (common case unchanged)", !fs.existsSync(strandedDTmp));

    clearMergeQuarantine(r);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO boot-pass1b-early-exit-protects-superset-tmp (repro 1) — a torn write (tmp fsync'd, rename
  // EPERM) strands a tmp holding a token `final` never received. A fresh boot with the repo REGISTERED
  // must NOT lose that token; the SAME scenario with the repo UNREGISTERED is the differential control
  // that isolates the early-exit shortcut (never registered ⇒ never reaches it at all).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const variant of ["registered", "unregistered"]) {
    const repo = makeRepo(`boot-${variant}`);
    const t1 = enterMergeQuarantine(repo, "branch-1", "first raise");
    const finalPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => p.endsWith(".json") && !p.includes(".tmp-") && (() => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } })());
    check(`(boot-${variant}) precondition: final exists after first raise`, !!finalPath && fs.existsSync(finalPath));

    const realRename = fs.renameSync;
    let intercepted = 0;
    fs.renameSync = (src, dest) => {
      if (dest === finalPath) { intercepted++; throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" }); }
      return realRename(src, dest);
    };
    const t2 = enterMergeQuarantine(repo, "branch-2", "second raise, rename fails");
    fs.renameSync = realRename;
    check(`(boot-${variant}) rename was intercepted exactly once`, intercepted === 1);

    const strandedTmp = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.includes(".json.tmp-") && !f.includes("tmp-safety-") && finalPath.endsWith(path.basename(finalPath)) && f.startsWith(path.basename(finalPath).replace(/\.json$/, "")));
    check(`(boot-${variant}) precondition: a stranded tmp holding both tokens exists`, !!strandedTmp && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, strandedTmp)));

    const bootMod = await freshBootModule();
    bootMod.reenterMergeQuarantinesAtBoot(variant === "registered" ? [repo] : []);
    const tokensAfterBoot = bootMod.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []);
    check(`*** THE FIX (boot-${variant}) *** both tokens survive the boot`, tokensAfterBoot.includes(t1) && tokensAfterBoot.includes(t2));

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO boot-pass1b-still-deletes-pure-subset-tmp (positive control) — the common case is unchanged:
  // a genuinely stale tmp beside an already-clean final, whose own token the final ALREADY covers, is
  // still deleted via the fast early-exit path, same as before this card.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("boot-control");
    const t1 = enterMergeQuarantine(repo, "stale-branch", "the REAL current reason");
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR)
      .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
      .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repo; } catch { return false; } });
    const staleTmpPath = `${latchPath}.tmp-111111`;
    fs.writeFileSync(staleTmpPath, JSON.stringify({ repoPath: repo, branch: "STALE-EARLIER-ATTEMPT", reason: "an earlier, now-superseded attempt", enteredAt: 1, tokens: [t1] }, null, 2) + "\n");
    check("(boot-control) precondition: both a real final latch and a stale (subset) tmp exist", fs.existsSync(latchPath) && fs.existsSync(staleTmpPath));

    const found = reenterMergeQuarantinesAtBoot([repo]);
    check("(boot-control) a CLEAN final parse still means the subset tmp is swept, with the REAL data surviving",
      found.filter((q) => q.repoPath === repo).length === 1 && activeMergeQuarantineFor(repo)?.reason === "the REAL current reason");
    check("(boot-control) the subset tmp is cleaned up as harmless residue (common case unchanged)", !fs.existsSync(staleTmpPath));
    check("(boot-control) the real final latch is untouched", fs.existsSync(latchPath));

    clearMergeQuarantine(repo);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO partial-clear-protects-foreign-unaccounted-tmp (round 2, item 2) — clearActiveEntryTokenAtKey's
  // own partial-clear write loop must keep an UNCOVERED, non-tombstoned foreign tmp sharing its key hash,
  // never delete it just because the partial clear's own write succeeded.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const r = makeRepo("partial-clear-r");
    const d = path.join(r, "gone-subdir-does-not-exist"); // unresolvable; walks up to R's own key
    const key = canonicalRepoLockKey(r);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);

    const tokenA = enterMergeQuarantine(r, "r-a", "token A");
    enterMergeQuarantine(r, "r-b", "token B"); // appended to the SAME entry — repo now holds [tokenA, tokenB]
    const dToken = "D-FOREIGN-TOKEN-partial-clear";
    const strandedDTmp = path.join(MERGE_QUARANTINE_DIR, `${hash}.json.tmp-77777-feedbead`);
    fs.writeFileSync(strandedDTmp, JSON.stringify({
      repoPath: d, branch: "d-branch", reason: "D's own real raise, never promoted (torn write)",
      enteredAt: Date.now() - 1000, tokens: [dToken],
    }, null, 2) + "\n");
    check("(partial-clear) precondition: D's stranded tmp exists before the partial clear", fs.existsSync(strandedDTmp));

    clearMergeQuarantineByToken(r, tokenA); // drops tokenA only — R stays quarantined via tokenB
    check("(partial-clear) precondition: R is STILL quarantined (a genuine partial clear, not a full one)", !!activeMergeQuarantineFor(r));
    check("*** THE FIX (partial-clear) *** D's foreign tmp residue SURVIVES the partial clear's own write", fs.existsSync(strandedDTmp));

    clearMergeQuarantine(r);
    try { fs.unlinkSync(strandedDTmp); } catch { /* best-effort cleanup — an orphan with no real repo behind it */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-by-id-matched-pending-protects-foreign-unaccounted-tmp (round 2, item 2) —
  // clearMergeQuarantineLatchFile's matched-PENDING branch must keep an UNCOVERED, non-tombstoned foreign
  // tmp sharing the resolved `id`'s own hash, and name it via `contentKeptRepoPaths`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const d = path.join(os.tmpdir(), `loom-mqtc21ec-pending-d-${sfx}`); // never mkdir'd — genuinely unresolvable
    const dToken = enterMergeQuarantine(d, "d-branch", "pending raise — never resolvable");
    const pendingEntry = listActiveMergeQuarantines().find((q) => q.repoPath === d);
    check("(clear-by-id-pending) precondition: D's own raise is PENDING (found via listActiveMergeQuarantines)", !!pendingEntry && pendingEntry.tokens.includes(dToken));
    const id = quarantineLatchFileIdsFor(pendingEntry)[0];

    const eToken = "E-FOREIGN-TOKEN-clear-by-id-pending";
    const eRepoPath = path.join(os.tmpdir(), `loom-mqtc21ec-pending-e-${sfx}`); // a wholly different, unrelated identity
    const strandedETmp = path.join(MERGE_QUARANTINE_DIR, `${id}.json.tmp-88888-deedbeef`);
    fs.writeFileSync(strandedETmp, JSON.stringify({
      repoPath: eRepoPath, branch: "e-branch", reason: "E's own real raise, never promoted (torn write)",
      enteredAt: Date.now() - 1000, tokens: [eToken],
    }, null, 2) + "\n");
    check("(clear-by-id-pending) precondition: E's stranded tmp exists before the clear-by-id", fs.existsSync(strandedETmp));

    const result = clearMergeQuarantineLatchFile(id);
    check("(clear-by-id-pending) the clear-by-id call succeeded and lifted D", result.ok === true && result.wasQuarantined === true);
    check("*** THE FIX (clear-by-id-pending) *** E's foreign tmp residue SURVIVES this clear-by-id", fs.existsSync(strandedETmp));
    // @decision 25d0d45b (Code Review, MAJOR 1) — E is unresolvable, now ARMED PENDING; report via
    // referencingRepoPaths, never contentKeptRepoPaths.
    check("(clear-by-id-pending, 25d0d45b) E is NOT in contentKeptRepoPaths (it is now a genuine live entry)", !result.contentKeptRepoPaths?.includes(eRepoPath));
    check("*** THE FIX IS CORRECTLY REPORTED (clear-by-id-pending, 25d0d45b) *** E IS in referencingRepoPaths", !!result.referencingRepoPaths?.includes(eRepoPath));
    check("(clear-by-id-pending, 25d0d45b) result-says-blocked === assertRepoNotQuarantined-refuses",
      !!result.stillBlockedCoOccupants?.some((c) => c.repoPath === eRepoPath) === (assertRepoNotQuarantined(eRepoPath).ok === false));
    // @decision 25d0d45b (Round 3, NIT 7) — route-id presence, not just referencingRepoPaths membership.
    const eCoOccupant = result.stillBlockedCoOccupants?.find((c) => c.repoPath === eRepoPath);
    check("(clear-by-id-pending, 25d0d45b) E's own stillBlockedCoOccupants entry carries a working route id", !!eCoOccupant?.route?.id);

    try { fs.unlinkSync(strandedETmp); } catch { /* best-effort cleanup — an orphan with no real repo behind it */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO clear-by-id-raw-fallback-protects-foreign-unaccounted-tmp (round 2, item 2) —
  // clearMergeQuarantineLatchFile's raw/unmatched-id fallback (nothing in memory matches `id` at all)
  // must keep an UNCOVERED, non-tombstoned foreign tmp sharing that hash, and name it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    // An `id` that matches NO active or pending entry at all — a repo that was never raised.
    const neverRaised = path.join(os.tmpdir(), `loom-mqtc21ec-never-raised-${sfx}`);
    const id = createHash("sha256").update(neverRaised).digest("hex").slice(0, 24);

    const fToken = "F-FOREIGN-TOKEN-clear-by-id-raw-fallback";
    const fRepoPath = path.join(os.tmpdir(), `loom-mqtc21ec-raw-fallback-f-${sfx}`);
    const strandedFTmp = path.join(MERGE_QUARANTINE_DIR, `${id}.json.tmp-99998-beefcafe`);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(strandedFTmp, JSON.stringify({
      repoPath: fRepoPath, branch: "f-branch", reason: "F's own real raise, never promoted (torn write)",
      enteredAt: Date.now() - 1000, tokens: [fToken],
    }, null, 2) + "\n");
    check("(clear-by-id-raw) precondition: F's stranded tmp exists before the clear-by-id", fs.existsSync(strandedFTmp));

    const result = clearMergeQuarantineLatchFile(id);
    check("(clear-by-id-raw) the clear-by-id call reports nothing was quarantined by this bare id", result.ok === true && result.wasQuarantined === false);
    check("*** THE FIX (clear-by-id-raw) *** F's foreign tmp residue SURVIVES this clear-by-id", fs.existsSync(strandedFTmp));
    // @decision 25d0d45b (Code Review, MAJOR 1) — F is unresolvable, now ARMED PENDING; report via
    // referencingRepoPaths, never contentKeptRepoPaths.
    check("(clear-by-id-raw, 25d0d45b) F is NOT in contentKeptRepoPaths (it is now a genuine live entry)", !result.contentKeptRepoPaths?.includes(fRepoPath));
    check("*** THE FIX IS CORRECTLY REPORTED (clear-by-id-raw, 25d0d45b) *** F IS in referencingRepoPaths", !!result.referencingRepoPaths?.includes(fRepoPath));
    check("(clear-by-id-raw, 25d0d45b) result-says-blocked === assertRepoNotQuarantined-refuses",
      !!result.stillBlockedCoOccupants?.some((c) => c.repoPath === fRepoPath) === (assertRepoNotQuarantined(fRepoPath).ok === false));
    // @decision 25d0d45b (Round 3, NIT 7) — route-id presence, not just referencingRepoPaths membership.
    const fCoOccupant = result.stillBlockedCoOccupants?.find((c) => c.repoPath === fRepoPath);
    check("(clear-by-id-raw, 25d0d45b) F's own stillBlockedCoOccupants entry carries a working route id", !!fCoOccupant?.route?.id);

    try { fs.unlinkSync(strandedFTmp); } catch { /* best-effort cleanup — an orphan with no real repo behind it */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a `.json.tmp-<pid>` residue with no in-memory owner is content-checked before being "
    + "swept (runtime) or deleted (boot PASS 1b's own early exit): a provable subset of what's already "
    + "accounted for is still removed exactly as before, while a foreign or superseding tmp holding an "
    + "unaccounted token now survives instead of being destroyed."
  : `\n❌ ${failures} FAILURE(S) — reproduces (or regresses the fix for) board card 21ec39e5.`);
process.exit(failures === 0 ? 0 : 1);
