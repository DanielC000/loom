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
  MERGE_QUARANTINE_DIR,
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

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — a legacy-tier match whose current key no longer hashes to the file (walked "
      + "up, or a pre-7673d096 subdir binding) still arms fail-closed at that mismatched key (the Lead's "
      + "ruling — diverting to pending was investigated and found to only delay the same false positive "
      + "via lazy graduation, never avoid it), but now carries provenanceUnknown so clear-by-id correctly "
      + "refuses, with the actual warn/reason text pinned; a clear durably survives a reboot (the corrupt "
      + "source file is gone, never just in-memory); a NON-walked legacy match is unaffected; a "
      + "verified-case corrupt-tmp residue, once cleaned up immediately, never grows a placeholder's own "
      + "token set across repeated reboots; and when the delete itself genuinely fails (an undeletable "
      + "directory), the superseded source is folded into orphanLatchFiles rather than silently lost."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces/regresses board card 4783df46.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
