import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e1572b69. Found by the Code Review of card 5332762e (reviewer a958d2ca).
//
// `rewriteOrphanLatchFilesAfterPartialClear`'s own per-orphan-file write (merge-quarantine.ts) calls
// `writePendingDivertFile(orphanFile, ...)` directly with `orphanFile` as the target — and `orphanFile`
// can ALREADY be `.tmp-`-shaped (tracked there by card 8d80b736/5332762e's own pattern, e.g. after an
// earlier triple-fault raise or a failed clear-time narrowing write). `writePendingDivertFile`'s own
// staging tmp name used to be `${final}.tmp-<pid>-<hex>` unconditionally — appending that onto an
// ALREADY `.tmp-`-shaped `final` nests a SECOND suffix onto the first
// (`pending-<hash>.json.tmp-<pid1>-<hex1>.tmp-<pid2>-<hex2>`) whenever THIS write's own rename then also
// fails. That nested name matches none of this module's residue regexes (`PENDING_DIVERT_TMP_RE`,
// `TMP_RESIDUE_FILENAME_RE`, `SAFETY_TMP_RE`, all anchored on the suffix immediately following `.json`),
// so it was NEVER tracked anywhere, NEVER swept, and NEVER recovered at boot — permanent, unrecognized
// disk debris, contradicting the site's own (now-corrected) inline comment claiming boot's recovery pass
// "re-arms it as a duplicate."
//
// @decision e1572b69 — the fix combines (a) tracking the orphan-rewrite's own newly-stranded tmp into
// `orphanLatchFiles` (mirroring 5332762e, over a SNAPSHOT of that field) with (b) staging onto a clean
// `.json` base so a stranded tmp is never nested. See the decision record for the full investigation.
//
// Per decision 59e758e5's own "Do not" list: never call a resolve-aware query (`activeMergeQuarantineFor`/
// `resolveQuarantineFor`) between an injected write failure/clear and a later durable assertion. Every
// check below reads either the quarantine dir's own on-disk CONTENT directly, or
// `listActiveMergeQuarantines()`/`stillBlockedEntryFor` (a pure peek, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-e1572b69-nested-orphan-tmp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqe1572b69-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, clearMergeQuarantineByToken, listActiveMergeQuarantines, stillBlockedEntryFor, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function injectRenameFaultAt(targetPath) {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (b === targetPath) {
      hits++;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return realRename(a, b);
  };
  return { restore: () => { fs.renameSync = realRename; }, hits: () => hits };
}

function injectHostWideRenameFault() {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (path.dirname(b) === MERGE_QUARANTINE_DIR) {
      hits++;
      throw Object.assign(new Error("EPERM: simulated host-wide rename failure (every rename into the quarantine dir)"), { code: "EPERM" });
    }
    return realRename(a, b);
  };
  return { restore: () => { fs.renameSync = realRename; }, hits: () => hits };
}

function readTokensOnDisk(basename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, basename), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : undefined;
  } catch {
    return undefined;
  }
}
const sameTokenSet = (a, b) => a !== undefined && b !== undefined && a.length === b.length && new Set(a).size === a.length && a.every((t) => b.includes(t));
// A residue name is "nested" when it carries MORE THAN ONE `.tmp-` suffix occurrence — the exact shape
// this card's defect produces and the fix must prevent.
const tmpSuffixCount = (basename) => (basename.match(/\.tmp-/g) ?? []).length;

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?be1572b69=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A ("e1572b69-a-isolated-orphan-rewrite-fault") — ISOLATES this card's own site: the OUTER
// primary write for t2 succeeds cleanly; only the orphan-rewrite's own write (on the already-tracked,
// already-tmp-shaped orphan file from t1's own failure) fails.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqe1572b69-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/e1572b69-a-1", "e1572b69-a: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/e1572b69-a-2", "e1572b69-a: raise 2 (t2)");
  const t3 = enterMergeQuarantine(d, "loom/e1572b69-a-3", "e1572b69-a: raise 3 (t3)");

  const filesBefore = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const sourceFile = filesBefore.find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2, t3]));
  check("(a precondition) found the primary pending-divert file on disk holding t1,t2,t3", typeof sourceFile === "string");
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  // Clear t1 with the PRIMARY rename forced to fail (the 5332762e/8d80b736 precondition): strands a
  // TRACKED, single-suffixed orphan tmp holding [t2,t3].
  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(d, t1); } finally { injectT1.restore(); }
  check("(a precondition) the primary rename was forced to fail exactly once", injectT1.hits() === 1);

  const filesAfterT1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const orphanTmp = filesAfterT1.find((f) => f !== sourceFile);
  check("(a precondition) a tracked orphan tmp exists after t1's failed primary write", typeof orphanTmp === "string");
  check("(a precondition, by content) the orphan tmp holds [t2,t3]", sameTokenSet(readTokensOnDisk(orphanTmp), [t2, t3]));
  const entryAfterT1 = listActiveMergeQuarantines().find((e) => e.repoPath === d);
  check("(a precondition) the orphan tmp is tracked in orphanLatchFiles", (entryAfterT1?.orphanLatchFiles ?? []).includes(orphanTmp));

  // Clear t2 with ONLY the orphan-rewrite's own target (the tracked orphan tmp) faulted — the OUTER
  // primary write for t2 succeeds cleanly, durably narrowing the primary to [t3]. This is this card's
  // OWN named site, isolated from the (already-fixed) 5332762e site.
  const orphanPath = path.join(MERGE_QUARANTINE_DIR, orphanTmp);
  const injectT2 = injectRenameFaultAt(orphanPath);
  try { clearMergeQuarantineByToken(d, t2); } finally { injectT2.restore(); }
  check("(a precondition) the orphan-rewrite's own rename was forced to fail exactly once", injectT2.hits() === 1);
  check("(a precondition, by content) the primary's own OUTER write succeeded — durably narrowed to [t3]", sameTokenSet(readTokensOnDisk(sourceFile), [t3]));
  check("(a precondition, by content) the ORIGINAL orphan tmp is untouched — still stale, holding [t2,t3]", sameTokenSet(readTokensOnDisk(orphanTmp), [t2, t3]));

  const filesAfterT2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const newStrandedTmp = filesAfterT2.find((f) => !filesAfterT1.includes(f));
  check("*** THE DEFECT, REPRODUCED *** a NEW stranded tmp exists from the orphan-rewrite's own failed write", typeof newStrandedTmp === "string");
  check("*** THE FIX (b), BY CONTENT *** the new stranded tmp is NOT nested — exactly one `.tmp-` suffix", newStrandedTmp !== undefined && tmpSuffixCount(newStrandedTmp) === 1);
  check("(by content) the new stranded tmp holds the correctly-narrowed [t3] (the content this write attempted)", sameTokenSet(readTokensOnDisk(newStrandedTmp), [t3]));
  const entryAfterT2 = listActiveMergeQuarantines().find((e) => e.repoPath === d);
  check("*** THE FIX (a) *** the new stranded tmp IS tracked in orphanLatchFiles right now", newStrandedTmp !== undefined && (entryAfterT2?.orphanLatchFiles ?? []).includes(newStrandedTmp));
  check("(sanity) the ORIGINAL orphan tmp is STILL tracked too — tracking the new one must never drop the old one", (entryAfterT2?.orphanLatchFiles ?? []).includes(orphanTmp));

  // @decision e1572b69 — a mid-lift reboot is deliberately NOT continued through here (that lands on a
  // SEPARATE, pre-existing mechanic this card's fix neither makes nor breaks). See the decision record
  // for the confirmed-by-TRACE finding on what it reports.

  // Clear t3 cleanly (the last remaining token), in-process, with NO reboot in between — a genuine full
  // lift, mirroring 5332762e's own Scenario A structure exactly.
  clearMergeQuarantineByToken(d, t3);
  check("(a precondition) in-process, d is NOT reported blocked after the full lift", stillBlockedEntryFor(d) === undefined);

  const filesAfterFullLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX, FULL-LIFT SWEEP *** no debris for this identity survives the full lift — primary, original orphan tmp, AND the new stranded tmp are all gone", !filesAfterFullLift.includes(sourceFile) && !filesAfterFullLift.includes(orphanTmp) && !filesAfterFullLift.includes(newStrandedTmp));

  const rbFinal = await rebootSim();
  rbFinal.reenterMergeQuarantinesAtBoot([]);
  const afterFinal = rbFinal.stillBlockedEntryFor(d);
  console.log(`    -> after the FINAL reboot (post full lift), stillBlockedEntryFor(d) = ${afterFinal ? JSON.stringify(afterFinal.tokens) : "undefined"}`);
  check("*** THE CARD'S OWN REPRO, CLOSED *** d is genuinely unblocked after the final reboot — no resurrection, no permanent debris", afterFinal === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B ("e1572b69-b-compound-all-renames-fault") — the manager-approved test plan's own named
// shape: EVERY rename into the quarantine dir fails during t2's clear, hitting BOTH the OUTER primary
// write (the already-fixed 5332762e site) AND the orphan-rewrite's own write (THIS card's site) in the
// SAME call. Confirms the two fixes compose: no nesting, no permanent debris, either way.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mqe1572b69-b-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/e1572b69-b-1", "e1572b69-b: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/e1572b69-b-2", "e1572b69-b: raise 2 (t2)");
  const t3 = enterMergeQuarantine(d, "loom/e1572b69-b-3", "e1572b69-b: raise 3 (t3)");

  const sourceFile = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2, t3]));
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);
  const injectT1 = injectRenameFaultAt(sourcePath);
  try { clearMergeQuarantineByToken(d, t1); } finally { injectT1.restore(); }

  const filesBeforeT2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const injectAll = injectHostWideRenameFault();
  try { clearMergeQuarantineByToken(d, t2); } finally { injectAll.restore(); }
  check("(b precondition) every rename into the quarantine dir was actually hit during t2's clear", injectAll.hits() > 0);

  const filesAfterT2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const newFiles = filesAfterT2.filter((f) => !filesBeforeT2.includes(f));
  check("(b precondition) at least one new stranded tmp exists from the compound failure", newFiles.length >= 1);
  check("*** THE FIX (b), BY CONTENT *** NONE of the newly-stranded tmps are nested — every one carries exactly one `.tmp-` suffix", newFiles.every((f) => tmpSuffixCount(f) === 1));
  const entryAfterT2b = listActiveMergeQuarantines().find((e) => e.repoPath === d);
  check("*** THE FIX (a) *** EVERY newly-stranded tmp is tracked in orphanLatchFiles", newFiles.every((f) => (entryAfterT2b?.orphanLatchFiles ?? []).includes(f)));
  // @decision 5332762e — EXACTLY 2 (outer + orphan-rewrite failures); a 3rd means a redundant
  // re-process of a tmp THIS SAME call just minted. Catches the reorder mutant the nesting/debris
  // checks above no longer catch, now that fix (b) stops that redundant attempt from nesting.
  check("*** THE 5332762e ORDERING RULE *** exactly 2 new stranded tmps — the orphan-rewrite never redundantly re-processed a tmp this same call just minted", newFiles.length === 2);

  // Clear t3 cleanly — full lift.
  clearMergeQuarantineByToken(d, t3);
  check("(b precondition) in-process, d is NOT reported blocked after the full lift", stillBlockedEntryFor(d) === undefined);
  const filesAfterFullLiftB = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX, FULL-LIFT SWEEP (compound case) *** no debris for this identity survives — including every newly-stranded tmp from the compound failure", [sourceFile, ...newFiles].every((f) => !filesAfterFullLiftB.includes(f)));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const after = rb.stillBlockedEntryFor(d);
  console.log(`    -> after reboot (compound case), stillBlockedEntryFor(d) = ${after ? JSON.stringify(after.tokens) : "undefined"}`);
  check("*** THE CARD'S OWN REPRO, CLOSED (compound case) *** d is genuinely unblocked after reboot — no resurrection, no permanent debris", after === undefined);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — the orphan-rewrite's own newly-stranded tmp is never nested and is tracked in orphanLatchFiles, so a later clear durably narrows or sweeps it, and it never resurrects a cleared token nor leaks forever at the next boot."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
