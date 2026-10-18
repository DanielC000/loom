// Board card 4783df46 — a direct follow-up to 8bff3cae/3a9e0027's PASS 1 migrate-branch fix (source (b):
// never trust a LEGACY-tier `hashToRepo` match's freshly-recomputed current key without re-verifying it
// still hashes to the file's own stale filename). This card covers the SAME shape at the TWO deferred
// corrupt-latch resolution sites (merge-quarantine.ts, search "@decision 4783df46") — `deferredCorruptJsons`
// (a corrupt/unparsable `.json` final) and `deferredCorruptTmps` (its `.json.tmp-<pid>` residue twin) —
// which 3a9e0027 never touched: those sites arm a placeholder at `canonicalRepoLockKey(matchedRepo)` for a
// LEGACY-tier match with NO re-verification at all, so a matchedRepo whose current canonical key no longer
// hashes to the file (walked up after its own `.git` was removed, OR a pre-7673d096 subdir binding that
// never had its own `.git`) gets its placeholder armed at that OTHER repo's key instead.
//
// CARD f118b475 (scenarios 6/7/8 below) — 4783df46's own record explicitly scoped the corrupt SAFETY-TMP
// recovery site (the `for (const f of safetyTmpFiles)` loop's own `catch` branch) OUT, since it diverts
// to pending instead of arming — "a different pre-existing gap... for the separate card." f118b475 is
// that card: the safety-tmp site now applies the SAME ruling (arm fail-closed at the walked-up key,
// provenanceUnknown via `legacyMatchStillResolvesToHash`, never divert) for its own `hashToRepo`/
// `unresolvedClaimantsByHash` tiers, mirroring `deferredCorruptJsons`/`deferredCorruptTmps` exactly; its
// ancestor-only tier stays an unconditional pending-divert, unchanged (f5c42043).
//
// INVESTIGATE-FIRST (before any source edit — see this card's own `worker_report` history) found that the
// OBVIOUS fix — divert the walked-up match to pending, mirroring f5c42043's ancestor tier — does NOT
// actually avoid blocking the ancestor: it only delays the SAME false positive to the first query, via
// `activeMergeQuarantineFor`'s own lazy-graduation path (which arms unconditionally at the query's own
// freshly-recomputed key, with no hash-verification of its own). See
// docs/decisions/4783df46-legacy-match-walked-up-still-arms-with-provenance-unknown.md for the full
// repro of that hazard and the Lead's ruling.
//
// THE FIX (Lead ruling): keep arming fail-closed at the mismatched key at both sites — but mark the
// placeholder `provenanceUnknown: true` so the EXISTING remediation machinery (82032b5c/9a55fb90) refuses
// a bare clear-by-id and names the affected repo(s), plus a loud console.warn and a reason string that
// says plainly the current key no longer hashes to the file. The hash-equality check itself
// (`legacyMatchStillResolvesToHash`, next to `quarantineHashForKey`/`legacyQuarantineHashFor`) is ONE
// shared helper — 3a9e0027's own PASS1-migrate source-(b) check was refactored to call it too, so there is
// only one copy of this verification across all three call sites.
//
// CODE REVIEW ROUND 2 additions (this file):
// - MAJOR fix verification: the `deferredCorruptTmps` branch now deletes its own superseded corrupt tmp
//   residue immediately after a successful write (mirroring the json site's existing cleanup) — scenarios
//   1/2 below reboot AFTER a successful clear-by-path and assert BOTH that the repo stays open AND that
//   the original corrupt file is actually gone from disk, which is exactly the shape that was broken
//   before this round (a surviving residue silently re-quarantined the repo on the very next boot).
// - Scenario 4 pins the verified-case twin of that same leak: a leftover tmp residue, re-read every boot
//   because a PLACEHOLDER final (unlike a real one) never marks its own key `cleanlyParsedKeys`, gets
//   UNIONED into the real entry at that key each time — growing its token set by one per boot. Fixed by
//   the same immediate-delete; pinned here as "tokens never exceed 1 across N reboots".
// - console.warn is now captured and asserted (both the warn text and the placeholder's own `reason`) to
//   confirm the actual wording, not just the arm/clear/provenanceUnknown outcome.
// - Scenario 5 (added one re-review later) exercises the unlink-FAILURE fallback the above fix's own
//   success path never reaches: a directory-shaped tmp residue forces a genuine, non-ENOENT unlink
//   failure, and the fold-into-orphanLatchFiles is pinned directly — see that scenario's own header for
//   why "stays open across a reboot" is deliberately NOT asserted (empirically false for this fixture).
//
// P/T/X shape (same naming as the reviewer's own probe5-r2.mjs and 8bff3cae's test's own
// "legacy-tier-match-never-blocks-unrelated-repo" scenario): P is a real repo; T = P/t starts as its OWN
// real repo (own `.git`); a quarantine latch is manufactured at hash(canonicalRepoLockKey(T)) — but
// CORRUPT/unparsable, never a clean raise (that's 8bff3cae's own PASS1-migrate branch's job; this card is
// about the CORRUPT-latch catch-block sites only). T then loses its own `.git` (collapsing onto P's key);
// X = T/sub gets its own `.git` instead.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-legacy-match-walked-up-4783df46.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
useOwnLoomHome("loom-mqlmwu4783df46-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined, listActiveMergeQuarantines,
  clearMergeQuarantineLatchFile, clearMergeQuarantineReporting, quarantineLatchFileIdsFor,
  clearMergeQuarantine, MERGE_QUARANTINE_DIR,
} = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqlmwu4783df46@loom -c user.name=mqlmwu4783df46";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Cache-busted re-import of the compiled module in THIS SAME process — a REBOOT-SIM, never an actual OS
// process restart (same convention as merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs).
let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mqHref}?b=${bootReimportCounter}`);
}

// Monkey-patches console.warn for the duration of `fn` (sync) and returns every captured call's joined
// args, newline-joined — so a scenario can assert the actual warning text a boot call emitted, not just
// its arm/clear/provenanceUnknown outcome.
function captureWarn(fn) {
  const captured = [];
  const orig = console.warn;
  console.warn = (...args) => { captured.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return captured.join("\n");
}

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlmwu4783df46-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function freshHashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

const WALKED_UP_WARN_RE = /current canonical key .* no longer hashes to this file \(walked up, or a pre-7673d096 subdir binding\)/;
const WALKED_UP_REASON_RE = /matched only by a legacy \(direct-path\) identity/;

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // walked-up-json-arms-ancestor-with-provenance-unknown — THE CORE repro for the `.json` corrupt-final
  // site (`deferredCorruptJsons`). Pins that P is armed WITH provenanceUnknown, that clear-by-id refuses,
  // that clear-by-path works, AND (round 2) that the clear survives a reboot with the corrupt file gone.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("json-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);
    const x = path.join(t, "sub");
    fs.mkdirSync(x, { recursive: true });
    check("(precondition) X collapses onto T's own key before X has its own .git", canonicalRepoLockKey(x) === kt);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json`);
    fs.writeFileSync(corruptPath, "{ torn"); // CORRUPT/unparsable — never a clean raise (that's 8bff3cae's job)

    // Restructure: T stops being its own repo; X becomes its own repo instead.
    fs.rmSync(path.join(t, ".git"), { recursive: true, force: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: x });
    check("(precondition) T now collapses onto P's own key", canonicalRepoLockKey(t) === canonicalRepoLockKey(p));
    check("(precondition) X now has its own, distinct key", canonicalRepoLockKey(x) !== canonicalRepoLockKey(t));

    const boot1 = await rebootSim();
    const warnText = captureWarn(() => boot1.reenterMergeQuarantinesAtBoot([p, t, x]));
    check("*** warn text names the current-key-no-longer-hashes mismatch ***", WALKED_UP_WARN_RE.test(warnText));
    check("warn text says provenanceUnknown is being marked", /marking provenanceUnknown/.test(warnText));

    check("*** RULING *** P is still armed fail-closed (never diverted/unblocked)", boot1.assertRepoNotQuarantined(p).ok === false);
    check("T is blocked too (same walked-up key as P)", boot1.assertRepoNotQuarantined(t).ok === false);
    check("X stays open — its true identity is unrecoverable from a corrupt latch either way", boot1.assertRepoNotQuarantined(x).ok === true);

    const pEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** THE FIX *** the armed placeholder carries provenanceUnknown:true", pEntry?.provenanceUnknown === true);
    check("the placeholder's own reason names the legacy-only match", WALKED_UP_REASON_RE.test(pEntry?.reason ?? ""));

    const latchId = boot1.quarantineLatchFileIdsFor(pEntry)[0];
    check("(precondition) a latch id was found for the armed entry", typeof latchId === "string");
    const clearByIdResult = boot1.clearMergeQuarantineLatchFile(latchId);
    check("*** THE FIX *** clear-by-id REFUSES (provenanceUnknown makes a bare id ambiguous)", clearByIdResult.ok === false);
    check("clear-by-id's refusal names the incomplete-provenance reason", /provenance is incomplete/.test(clearByIdResult.reason ?? ""));
    check("P is STILL blocked after the refused clear-by-id (nothing was lifted)", boot1.assertRepoNotQuarantined(p).ok === false);

    const clearByPathResult = boot1.clearMergeQuarantineReporting(p);
    check("*** clear-by-path WORKS *** reports wasQuarantined", clearByPathResult?.wasQuarantined === true);
    check("P is open after clear-by-path", boot1.assertRepoNotQuarantined(p).ok === true);

    // *** CR MAJOR regression pin *** — reboot BEFORE any directory reset below, and confirm the clear
    // actually survives: P must stay open, and the original corrupt file must be genuinely gone from
    // disk — pre-fix, the corrupt final (and, for scenario 2, the corrupt tmp) silently survived the
    // clear and re-quarantined P on the very next boot.
    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([p, t, x]);
    check("*** after reboot, P stays open (no re-quarantine) ***", reboot2.assertRepoNotQuarantined(p).ok === true);
    check("*** the corrupt file is actually gone from disk ***", !fs.existsSync(corruptPath));

    // Test-only reset: the quarantine dir is shared across every scenario in this one process (the
    // production LOOM_HOME const is frozen at this process's first module import — a per-scenario
    // useOwnLoomHome({fresh:true}) can't re-isolate it). Clear it so no leftover latch/residue file
    // bleeds into the NEXT scenario's own boot.
    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // walked-up-tmp-arms-ancestor-with-provenance-unknown — Site C's own twin, the `deferredCorruptTmps`
  // resolution loop (a `.json.tmp-<pid>` residue, never a final). Round 2: THIS is the scenario the MAJOR
  // fix is actually about — pre-fix, the corrupt tmp residue was never tracked or unlinked at all.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("tmp-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);
    const x = path.join(t, "sub");
    fs.mkdirSync(x, { recursive: true });

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-999999`);
    fs.writeFileSync(corruptTmpPath, "{ torn");

    fs.rmSync(path.join(t, ".git"), { recursive: true, force: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: x });

    const boot1 = await rebootSim();
    const warnText = captureWarn(() => boot1.reenterMergeQuarantinesAtBoot([p, t, x]));
    check("*** warn text (tmp shape) names the current-key-no-longer-hashes mismatch ***", WALKED_UP_WARN_RE.test(warnText));

    check("*** RULING (tmp shape) *** P is still armed fail-closed", boot1.assertRepoNotQuarantined(p).ok === false);
    check("X stays open (tmp shape)", boot1.assertRepoNotQuarantined(x).ok === true);

    const pEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** THE FIX (tmp shape) *** the armed placeholder carries provenanceUnknown:true", pEntry?.provenanceUnknown === true);
    check("the placeholder's own reason (tmp shape) names the legacy-only match", WALKED_UP_REASON_RE.test(pEntry?.reason ?? ""));

    const latchId = boot1.quarantineLatchFileIdsFor(pEntry)[0];
    const clearByIdResult = boot1.clearMergeQuarantineLatchFile(latchId);
    check("*** THE FIX (tmp shape) *** clear-by-id REFUSES", clearByIdResult.ok === false);

    const clearByPathResult = boot1.clearMergeQuarantineReporting(p);
    check("clear-by-path WORKS (tmp shape)", clearByPathResult?.wasQuarantined === true);
    check("P is open after clear-by-path (tmp shape)", boot1.assertRepoNotQuarantined(p).ok === true);

    // *** CR MAJOR regression pin (the actual bug site) *** — see scenario 1's own identical comment.
    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([p, t, x]);
    check("*** after reboot, P stays open (tmp shape — no re-quarantine) ***", reboot2.assertRepoNotQuarantined(p).ok === true);
    check("*** the corrupt tmp residue is actually gone from disk ***", !fs.existsSync(corruptTmpPath));

    // Test-only reset — see scenario 1's own identical comment for why this is needed here.
    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // non-walked-legacy-match-no-provenance-unknown — POSITIVE CONTROL + the helper's own negative control:
  // the SAME legacy-tier match, but T's own `.git` is NEVER removed, so `legacyMatchStillResolvesToHash`
  // must return true and the placeholder must NOT carry provenanceUnknown — proving the check actually
  // discriminates (scenario 1/2 above pin the TRUE-mismatch side; this pins the FALSE/verified side).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("control-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json`);
    fs.writeFileSync(corruptPath, "{ torn"); // CORRUPT — matches T's own LEGACY tier directly, T never moves

    const boot1 = await rebootSim();
    const warnText = captureWarn(() => boot1.reenterMergeQuarantinesAtBoot([p, t]));
    check("(control) NO walked-up warning fires — the key genuinely still verifies", !WALKED_UP_WARN_RE.test(warnText));
    check("(control) T is blocked by its OWN (still-verified) key", boot1.assertRepoNotQuarantined(t).ok === false);
    check("(control) P is NOT blocked — T never walked up to it", boot1.assertRepoNotQuarantined(p).ok === true);

    const tEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** POSITIVE CONTROL *** a NON-walked legacy match does NOT get provenanceUnknown", tEntry?.provenanceUnknown !== true);
    check("(control) the reason text does NOT claim a legacy-only mismatch", !WALKED_UP_REASON_RE.test(tEntry?.reason ?? ""));

    const latchId = boot1.quarantineLatchFileIdsFor(tEntry)[0];
    const clearByIdResult = boot1.clearMergeQuarantineLatchFile(latchId);
    check("(control) clear-by-id SUCCEEDS when provenance is verified (no ambiguity to refuse on)", clearByIdResult.ok === true);

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // verified-tmp-match-no-token-growth-across-reboots — CR round 2, MAJOR #1's verified-case twin: a
  // leftover corrupt tmp residue is re-read EVERY boot (a PLACEHOLDER final never marks its own key
  // `cleanlyParsedKeys`, so the "already covers, unlink" shortcut never fires for it) and, pre-fix, gets
  // UNIONED into the real entry at that key each time it's processed — growing the token set by one per
  // boot forever, even though the repo's own quarantine content never actually changes. The immediate
  // delete (same fix as scenarios 1/2) prevents the residue from ever surviving to the next boot at all.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const t = makeRepo("growth-t"); // its own real repo throughout — never walks up, never moves
    const kt = canonicalRepoLockKey(t);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-999999`);
    fs.writeFileSync(corruptTmpPath, "{ torn");

    let last = await rebootSim();
    last.reenterMergeQuarantinesAtBoot([t]);
    check("(growth, boot 1) T is blocked", last.assertRepoNotQuarantined(t).ok === false);
    check("(growth, boot 1) the corrupt tmp residue is gone immediately", !fs.existsSync(corruptTmpPath));
    let entry = last.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("(growth, boot 1) exactly 1 token", entry?.tokens?.length === 1);

    for (let i = 2; i <= 4; i++) {
      last = await rebootSim();
      last.reenterMergeQuarantinesAtBoot([t]);
      check(`(growth, boot ${i}) T is still blocked`, last.assertRepoNotQuarantined(t).ok === false);
      entry = last.listActiveMergeQuarantines().find((q) => q.repoPath === t);
      check(`*** NO GROWTH *** (growth, boot ${i}) tokens stay at exactly 1`, entry?.tokens?.length === 1);
    }

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // unlink-failure-folds-into-orphanlatchfiles — CR round 2's unlink-FAILURE fallback (merge-quarantine.ts,
  // the `if (!deleteSourceLatchIfSuperseded(f, armed, key))` branch), which nothing else in this file
  // exercises: every other scenario's own delete always succeeds. The fixture (cross-OS): make the
  // corrupt "tmp" a DIRECTORY named `<hash>.json.tmp-999999` — `fs.readFileSync` throws EISDIR, routing it
  // through the exact same CORRUPT-latch catch path a torn file does, and the later `fs.unlinkSync` then
  // genuinely fails (EPERM on win32, EISDIR on Linux — never ENOENT), so `deleteSourceLatchIfSuperseded`
  // returns `false` for a real reason, not a contrived one.
  //
  // EMPIRICALLY DETERMINED (a standalone probe script, before writing these assertions — see the worker
  // report): the fold DOES put `f` in `orphanLatchFiles`, the directory DOES survive on disk (confirming
  // the unlink genuinely failed), and clear-by-path DOES still report success with P reading open in the
  // SAME process. But P does NOT stay open across a reboot — an un-removable directory residue is
  // re-read, re-matched, and re-arms P again on every subsequent boot, same as before this fix; the fold
  // is bookkeeping (so the residue is never silently lost from tracking and a future clear still finds
  // it), never a promise that an un-deletable file will eventually disappear. Asserting "stays open
  // across a reboot" here would be asserting something false — see the worker report for why that half of
  // the suggested check doesn't hold for this specific (undeletable-by-construction) fixture.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("unlinkfail-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptTmpDirPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-999999`);
    fs.mkdirSync(corruptTmpDirPath); // a DIRECTORY, not a file — forces a genuine, non-ENOENT unlink failure

    fs.rmSync(path.join(t, ".git"), { recursive: true, force: true }); // T walks up to P (mismatched case)

    const boot1 = await rebootSim();
    boot1.reenterMergeQuarantinesAtBoot([p, t]);
    check("(unlink-failure) P is blocked", boot1.assertRepoNotQuarantined(p).ok === false);

    const pEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** THE FOLD *** the directory's own basename lands in orphanLatchFiles", (pEntry?.orphanLatchFiles ?? []).includes(path.basename(corruptTmpDirPath)));
    check("(precondition) the directory genuinely survived the unlink attempt", fs.existsSync(corruptTmpDirPath));

    const clearByPathResult = boot1.clearMergeQuarantineReporting(p);
    check("clear-by-path still reports wasQuarantined despite the earlier unlink failure", clearByPathResult?.wasQuarantined === true);
    check("P opens immediately after the clear (same process)", boot1.assertRepoNotQuarantined(p).ok === true);

    // NOT asserted: "P stays open across a reboot" — empirically false for THIS fixture (see the comment
    // block above). Instead, pin the actual, verified behavior: the undeletable residue outlives the
    // clear and re-arms P on the very next boot — expected, not a regression this card is responsible for.
    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([p, t]);
    check("(expected residual) P is RE-BLOCKED next boot — the directory residue could never be removed", reboot2.assertRepoNotQuarantined(p).ok === false);
    check("the directory is still there (nothing ever silently vanished or got misreported as cleared)", fs.existsSync(corruptTmpDirPath));

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // walked-up-safety-tmp-arms-ancestor-with-provenance-unknown — CARD f118b475. The corrupt SAFETY-TMP
  // recovery site's own twin of scenarios 1/2 (the `for (const f of safetyTmpFiles)` loop's `catch`
  // branch, named `.json.tmp-safety-<pid>-<hex>`, never `.json`/`.json.tmp-<pid>`). Pre-fix, this site
  // ALWAYS diverted a legacy-tier match to pending regardless of resolvability — 4783df46's own record
  // named this as "a different pre-existing gap... for the separate card." Same P/T/X shape as above.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("safetytmp-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);
    const x = path.join(t, "sub");
    fs.mkdirSync(x, { recursive: true });

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-safety-999999-abc123`);
    fs.writeFileSync(corruptSafetyTmpPath, "{ torn"); // CORRUPT/unreadable — matches SAFETY_TMP_RE, never the plain tmp pattern

    fs.rmSync(path.join(t, ".git"), { recursive: true, force: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: x });

    const boot1 = await rebootSim();
    const warnText = captureWarn(() => boot1.reenterMergeQuarantinesAtBoot([p, t, x]));
    check("*** warn text (safety-tmp shape) names the current-key-no-longer-hashes mismatch ***", WALKED_UP_WARN_RE.test(warnText));

    check("*** RULING (safety-tmp shape) *** P is still armed fail-closed (never diverted/unblocked)", boot1.assertRepoNotQuarantined(p).ok === false);
    check("X stays open (safety-tmp shape)", boot1.assertRepoNotQuarantined(x).ok === true);

    const pEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** THE FIX (safety-tmp shape) *** the armed placeholder carries provenanceUnknown:true", pEntry?.provenanceUnknown === true);
    check("the placeholder's own reason (safety-tmp shape) names the legacy-only match", WALKED_UP_REASON_RE.test(pEntry?.reason ?? ""));

    const latchId = boot1.quarantineLatchFileIdsFor(pEntry)[0];
    check("(precondition) a latch id was found for the armed entry (safety-tmp shape)", typeof latchId === "string");
    const clearByIdResult = boot1.clearMergeQuarantineLatchFile(latchId);
    check("*** THE FIX (safety-tmp shape) *** clear-by-id REFUSES (provenanceUnknown makes a bare id ambiguous)", clearByIdResult.ok === false);

    const clearByPathResult = boot1.clearMergeQuarantineReporting(p);
    check("clear-by-path WORKS (safety-tmp shape)", clearByPathResult?.wasQuarantined === true);
    check("P is open after clear-by-path (safety-tmp shape)", boot1.assertRepoNotQuarantined(p).ok === true);

    // *** regression pin, mirroring scenarios 1/2's own identical pin *** — a reboot must not resurrect
    // the cleared quarantine, and the corrupt safety-tmp residue must be genuinely gone from disk (the
    // end-of-boot `safetyTmpRecoveryByFile` write/unlink pass durably persisted the union and swept it).
    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([p, t, x]);
    check("*** after reboot, P stays open (safety-tmp shape — no re-quarantine) ***", reboot2.assertRepoNotQuarantined(p).ok === true);
    check("*** the corrupt safety-tmp residue is actually gone from disk ***", !fs.existsSync(corruptSafetyTmpPath));

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // non-walked-legacy-match-safety-tmp-no-provenance-unknown — CARD f118b475. The safety-tmp site's own
  // twin of scenario 3 (positive control): T's own `.git` is NEVER removed, so `legacyMatchStillResolvesToHash`
  // must return true and the armed placeholder must NOT carry provenanceUnknown, proving the check still
  // discriminates correctly at this THIRD call site too.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const p = makeRepo("safetytmp-control-p");
    const t = path.join(p, "t");
    fs.mkdirSync(t, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: t });
    fs.writeFileSync(path.join(t, "t.txt"), "t\n");
    commitAll(t, "init", GIT_ID);
    const kt = canonicalRepoLockKey(t);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-safety-999999-abc123`);
    fs.writeFileSync(corruptSafetyTmpPath, "{ torn"); // matches T's own LEGACY tier directly, T never moves

    const boot1 = await rebootSim();
    const warnText = captureWarn(() => boot1.reenterMergeQuarantinesAtBoot([p, t]));
    check("(control, safety-tmp shape) NO walked-up warning fires — the key genuinely still verifies", !WALKED_UP_WARN_RE.test(warnText));
    check("(control, safety-tmp shape) T is blocked by its OWN (still-verified) key", boot1.assertRepoNotQuarantined(t).ok === false);
    check("(control, safety-tmp shape) P is NOT blocked — T never walked up to it", boot1.assertRepoNotQuarantined(p).ok === true);

    const tEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** POSITIVE CONTROL (safety-tmp shape) *** a NON-walked legacy match does NOT get provenanceUnknown", tEntry?.provenanceUnknown !== true);

    const latchId = boot1.quarantineLatchFileIdsFor(tEntry)[0];
    const clearByIdResult = boot1.clearMergeQuarantineLatchFile(latchId);
    check("(control, safety-tmp shape) clear-by-id SUCCEEDS when provenance is verified (no ambiguity to refuse on)", clearByIdResult.ok === true);

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // safety-tmp-write-failure-leaves-residue-in-place — CARD f118b475, manager-requested addition: assert
  // the corrupt residue is STILL ON DISK (never unlinked) when the end-of-boot `safetyTmpRecoveryByFile`
  // write/unlink pass's own `bootWriteLatch` call fails (merge-quarantine.ts's own "else" branch, log
  // "...could NOT durably re-persist its union — the residue is left IN PLACE"). No production seam
  // exists for this; EMPIRICALLY VERIFIED via a scratch probe first (see worker report) that an EXISTING
  // technique works: planting a DIRECTORY at the key's own quarantine `final` path (`<hash>.json`) makes
  // `fs.renameSync(tmp, final)` fail (EPERM/EISDIR, never ENOENT) inside `writeMergeQuarantineLatch`,
  // exactly like the pre-existing scenario 5's directory-shaped-tmp trick forces a genuine unlink failure.
  // NOTE (disclosed, not hidden): because `final`'s own basename also ends in `.json`, PASS 1's own file
  // scan ALSO treats this same directory as T's OWN corrupt `.json` final (a pre-existing, already-tested
  // code path — 4783df46/882d6cff) and unions T's PASS-1-triggered placeholder with T's safety-tmp-
  // triggered placeholder (same identity, straightforward token union — no eviction logic since both
  // sides name T). This is unavoidable (every quarantine write target is, by construction, some `.json`
  // path PASS 1's own scan also reads) and does not undermine what this scenario actually proves: the
  // SAFETY-TMP residue specifically survives on disk, and the log line this scenario asserts on is the
  // one that fires ONLY from the new `safetyTmpRecoveryByFile` end-of-boot pass this card added.
  //
  // MEASURED AGAINST RED (negative-control, pre-fix code): the "T blocked" and "residue still on disk"
  // outcomes ALSO held pre-fix — pre-fix the corrupt safety-tmp always diverted to pending instead of
  // attempting this write at all, so the residue was never touched for a DIFFERENT, coincidental reason.
  // Only the "(precondition) the write failure actually fired for this key" check — which greps for THIS
  // card's own new log line — actually discriminates pre-fix from post-fix; it FAILED pre-fix (a
  // different log line fired instead) and is what proves this scenario is genuinely exercising the new
  // write/unlink pass's own failure branch, not merely restating an outcome old code already produced.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const t = makeRepo("writefail-t"); // its OWN real repo throughout — never walks, no legacy mismatch
    const kt = canonicalRepoLockKey(t);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const corruptSafetyTmpPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-safety-999999-abc123`);
    fs.writeFileSync(corruptSafetyTmpPath, "{ torn");
    const finalPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json`);
    fs.mkdirSync(finalPath); // a DIRECTORY at the write target — forces a genuine, non-ENOENT write failure

    const boot1 = await rebootSim();
    const errText = (() => {
      const captured = [];
      const orig = console.error;
      console.error = (...args) => { captured.push(args.map(String).join(" ")); };
      try { boot1.reenterMergeQuarantinesAtBoot([t]); } finally { console.error = orig; }
      return captured.join("\n");
    })();

    check("(precondition) the write failure actually fired for this key", /could NOT durably re-persist its union/.test(errText));
    check("*** THE FIX *** T is still blocked in-process despite the durable write failing", boot1.assertRepoNotQuarantined(t).ok === false);
    check("*** THE FIX *** the safety-tmp residue is STILL ON DISK — never unlinked on a failed write", fs.existsSync(corruptSafetyTmpPath));
    check("(precondition) the directory at the write target genuinely survived (proving the write really failed, not a no-op)", fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory());

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // safety-tmp-degraded-occupied-key-self-references — CARD f118b475, Code Review CRITICAL (reproduced
  // against the un-self-referencing first-round fix): a corrupt safety-tmp matched to a resolvable repo
  // (`sub`) whose current canonical key is DEGRADED-OCCUPIED by a DIFFERENT, currently-unresolvable
  // entry `X` (via X's own recorded `resolvedKey`) armed `sub`'s placeholder INTO X's own union with no
  // self-reference of its own — so clearing the wholly UNRELATED X let `sweepTmpResidueForHashIfUnreferenced`
  // treat the residue as unreferenced and durably UNBLOCK sub, across a reboot. This is the SAME shape
  // the clean-parse branch's own `@decision 97cff6db (round 3, finding E)` fix already closed a few
  // lines above in this same loop; the corrupt-residue branch needed the identical self-reference.
  // Modeled on `merge-quarantine-migrate-source-owner-durable.mjs`'s own `round3-E-degraded-occupied-
  // source-clobbered` scenario (CR-supplied repro, adapted to the CORRUPT-safety-tmp shape).
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("degraded-repo");
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    execSync(`git init -q && git config user.email mqlmwu4783df46@loom && git config user.name mqlmwu4783df46`, { cwd: sub });
    fs.writeFileSync(path.join(sub, "S.md"), "s\n");
    commitAll(sub, "init", GIT_ID);
    const ksub = canonicalRepoLockKey(sub);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const x = path.join(os.tmpdir(), `loom-mqlmwu4783df46-x-never-${freshSfx()}`);
    check("(precondition) X never exists at all", !fs.existsSync(x));
    fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(ksub)}.json`), JSON.stringify({
      repoPath: x, branch: "x-branch", reason: "X degraded-occupies sub's own key", enteredAt: Date.now() - 120_000, tokens: ["token-x"], resolvedKey: ksub,
    }) + "\n");
    const residue = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(ksub)}.json.tmp-safety-999999-abc123`);
    fs.writeFileSync(residue, "{ torn"); // CORRUPT/unreadable — matches sub's OWN resolvable fresh hash

    const boot1 = await rebootSim();
    // @decision 97cff6db (Follow-up 38032559, item 2) — this exact scenario is ALSO where the end-of-boot
    // safety-tmp recovery write-back's own allBootWriteTargets registration used to gate on the UNION's
    // winning repoPath (X's, unresolvable), under-registering sub's genuinely-resolvable write target and
    // tripping bootWriteLatch's generic "UNANTICIPATED...bug in the at-risk computation" refusal for what
    // is really an EXPECTED degraded refusal. Captured here so a regression is caught by TEXT, not just
    // by the (unaffected either way) blocked/unblocked outcome below.
    const errText = (() => {
      const captured = [];
      const orig = console.error;
      console.error = (...args) => { captured.push(args.map(String).join(" ")); };
      try { boot1.reenterMergeQuarantinesAtBoot([repo, sub, x]); } finally { console.error = orig; }
      return captured.join("\n");
    })();
    check("(precondition) sub is blocked immediately after boot", boot1.assertRepoNotQuarantined(sub).ok === false);
    check("*** THE FIX (item 2) *** the generic UNANTICIPATED refusal does NOT fire for this expected degraded refusal", !/UNANTICIPATED/.test(errText));
    check("*** THE FIX (item 2) *** the CORRECTLY-WORDED degraded-occupied refusal fires instead", /this key is occupied by a DIFFERENT, currently-unresolvable entry's own trusted resolvedKey/.test(errText));

    boot1.clearMergeQuarantine(x); // an ordinary clear of the UNRELATED degraded entry X — never sub
    check("*** THE FIX *** sub is STILL blocked (same process) after clearing the unrelated degraded X", boot1.assertRepoNotQuarantined(sub).ok === false);

    const reboot2 = await rebootSim();
    reboot2.reenterMergeQuarantinesAtBoot([repo, sub, x]);
    check("*** THE FIX, CONFIRMED *** sub is STILL blocked after a reboot — no durable over-unblock from clearing X", reboot2.assertRepoNotQuarantined(sub).ok === false);

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // claimants-tier-corrupt-safety-tmp-still-diverts — CARD f118b475, item 3: a cheap regression pin that
  // the UNRESOLVED-CLAIMANTS tier (two registered repos sharing one degraded ancestor hash, both
  // currently absent) still diverts a corrupt safety-tmp to pending for EACH claimant, never arms either
  // — `resolveAndArm`'s own `!isRepoPathCurrentlyResolvable` branch always fires for a claimant (true by
  // construction of `unresolvedClaimantsByHash`), so this tier's behavior is unchanged by this card.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const y = makeRepo("claimants-y"); // a real repo, deliberately NEVER itself registered
    const w1 = path.join(y, "a"); // never created — absent at boot; degraded walk lands on y's own key
    const w2 = path.join(y, "b"); // never created — absent at boot; shares the SAME degraded key as w1
    const ky = canonicalRepoLockKey(y);

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const residue = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(ky)}.json.tmp-safety-999999-abc123`);
    fs.writeFileSync(residue, "{ torn");

    const boot1 = await rebootSim();
    boot1.reenterMergeQuarantinesAtBoot([w1, w2]); // y itself is NOT registered — only its two claimants are
    check("(claimants tier) w1 is blocked (diverted to pending, not armed at y's own key)", boot1.assertRepoNotQuarantined(w1).ok === false);
    check("(claimants tier) w2 is blocked (diverted to pending, not armed at y's own key)", boot1.assertRepoNotQuarantined(w2).ok === false);

    const entries = boot1.listActiveMergeQuarantines();
    const w1Entry = entries.find((q) => q.repoPath === w1);
    const w2Entry = entries.find((q) => q.repoPath === w2);
    check("(claimants tier) w1's own entry names the divert reason (never armed under a walked-up key)", /not armed under any walked-up key/.test(w1Entry?.reason ?? ""));
    check("(claimants tier) w2's own entry names the divert reason (never armed under a walked-up key)", /not armed under any walked-up key/.test(w2Entry?.reason ?? ""));
    check("*** STILL DIVERTS *** no new quarantine final was written anywhere — only the original residue remains on disk", fs.readdirSync(MERGE_QUARANTINE_DIR).join(",") === path.basename(residue));

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // safety-tmp-undeletable-residue-folds-into-orphanlatchfiles — CARD f118b475, item 2 (MINOR): the
  // end-of-boot safety-tmp write/unlink pass now routes through `deleteSourceLatchIfSuperseded` (the
  // SAME protected delete the json/tmp sibling sites use) instead of a bare best-effort unlink, so a
  // GENUINE unlink failure folds the residue into `orphanLatchFiles` rather than losing it from this
  // entry's own bookkeeping. Same technique as the pre-existing `unlink-failure-folds-into-orphanlatchfiles`
  // scenario above: a DIRECTORY named like the safety-tmp residue forces a real EPERM/EISDIR, never ENOENT.
  // Per that scenario's own established honesty: NOT asserting "stays open across a reboot" — an
  // undeletable directory residue re-arms the repo every subsequent boot regardless of the fold.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const t = makeRepo("undeletable-t"); // its own real repo — never walks, matches via its own fresh hash

    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const kt = canonicalRepoLockKey(t);
    const residueDirPath = path.join(MERGE_QUARANTINE_DIR, `${freshHashForKey(kt)}.json.tmp-safety-999999-abc123`);
    fs.mkdirSync(residueDirPath); // a DIRECTORY, not a file — fails to READ (EISDIR), then fails to UNLINK too

    const boot1 = await rebootSim();
    boot1.reenterMergeQuarantinesAtBoot([t]);
    check("(undeletable, safety-tmp shape) t is blocked", boot1.assertRepoNotQuarantined(t).ok === false);

    const tEntry = boot1.listActiveMergeQuarantines().find((q) => q.repoPath === t);
    check("*** THE FOLD (safety-tmp shape) *** the directory's own basename lands in orphanLatchFiles", (tEntry?.orphanLatchFiles ?? []).includes(path.basename(residueDirPath)));
    check("(precondition) the directory genuinely survived the unlink attempt", fs.existsSync(residueDirPath));

    fs.rmSync(MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — a legacy-tier match whose current key no longer hashes to the file (walked "
      + "up, or a pre-7673d096 subdir binding) still arms fail-closed at that mismatched key (the Lead's "
      + "ruling — diverting to pending was investigated and found to only delay the same false positive "
      + "via lazy graduation, never avoid it), but now carries provenanceUnknown so clear-by-id correctly "
      + "refuses, with the actual warn/reason text pinned; a clear durably survives a reboot (the corrupt "
      + "source file is gone, never just in-memory); a NON-walked legacy match is unaffected; a "
      + "verified-case corrupt-tmp residue, once cleaned up immediately, never grows a placeholder's own "
      + "token set across repeated reboots; and when the delete itself genuinely fails (an undeletable "
      + "directory), the superseded source is folded into orphanLatchFiles rather than silently lost. "
      + "CARD f118b475: the SAME ruling now applies at the corrupt SAFETY-TMP recovery site too (scenarios "
      + "6/7), a failed durable write there leaves the residue in place rather than losing it (scenario 8), "
      + "a degraded-occupied key's own corrupt-residue placeholder self-references its source so clearing "
      + "an UNRELATED occupant can never durably over-unblock it (scenario 9, CR CRITICAL fix), the "
      + "unresolved-claimants tier still diverts rather than arming, unchanged (scenario 10), and the "
      + "end-of-boot recovery write now folds an undeletable residue into orphanLatchFiles too (scenario 11)."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces/regresses board card 4783df46.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
