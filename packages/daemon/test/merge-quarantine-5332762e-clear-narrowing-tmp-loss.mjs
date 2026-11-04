import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 5332762e. Found by the Code Review of card 8d80b736 (reviewer session 75c92d8c).
// `clearTokenFromPendingIndices`'s own reduce-branch write-failure branch (merge-quarantine.ts, the
// `else` branch right after `writePendingDivertFile(live.sourceFile, ...)`) used to leave an UNTRACKED
// stranded tmp holding the pre-fail (narrowed) token set when its own primary rename fails — unlike the
// 3 raise callers' own triple-fault "keep" branches (card 8d80b736), which DO track
// `path.basename(written.strandedTmp)` in the kept entry's own `orphanLatchFiles`.
//
// Repro (per the card): raise t1, t2, t3 for an unresolvable X. Clear t1 with the rename forced to EPERM,
// so the tmp holds [t2,t3] and is untracked. Clear t2 and t3 cleanly, so pending-*.json is swept and the
// in-process stillBlocked is none. Reboot => stillBlocked = [t2,t3]: two durably-cleared tokens resurrect.
//
// @decision 5332762e — the fix: track `path.basename(written.strandedTmp)` into orphanLatchFiles, Set-
// deduped, via replaceEntryEverywhere, AFTER (never before) this same call's own
// rewriteOrphanLatchFilesAfterPartialClear. See the decision record for why that ordering matters.
//
// Card 5332762e's own checkpoint also investigated the sibling write-failure site,
// `rewriteOrphanLatchFilesAfterPartialClear`'s own per-orphan-file rewrite — it DOES reproduce a real,
// confirmed defect, but a DIFFERENT shape (a permanently-unrecognized, never-swept nested-tmp disk leak,
// not a resurrection). That is now its own card, e1572b69, deliberately NOT fixed here — see this card's
// own decision record for the full investigation.
//
// Per decision 59e758e5's own "Do not" list: never call a resolve-aware query (`activeMergeQuarantineFor`/
// `resolveQuarantineFor`) between an injected write failure/clear and a later durable assertion — that
// chokepoint's own "lazy re-resolve on first query" self-heal can mask the exact loss/resurrection this
// test exists to prove. Every check below reads either the quarantine dir's own on-disk CONTENT directly,
// or `listActiveMergeQuarantines()`/`stillBlockedEntryFor` (a pure peek, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-5332762e-clear-narrowing-tmp-loss.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq5332762e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, clearMergeQuarantineByToken, listActiveMergeQuarantines, stillBlockedEntryFor, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function injectRenameFault(targetPath) {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (b === targetPath) {
      hits++;
      throw Object.assign(new Error("EPERM: simulated clear-time narrowing rename failure"), { code: "EPERM" });
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

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b5332762e=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A ("5332762e-a-reduce-primary-write-failure") — the card's own named site:
// clearTokenFromPendingIndices' reduce branch, primary writePendingDivertFile call, rename forced EPERM.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq5332762e-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/5332762e-a-1", "5332762e-a: raise 1 (t1)");
  const t2 = enterMergeQuarantine(d, "loom/5332762e-a-2", "5332762e-a: raise 2 (t2)");
  const t3 = enterMergeQuarantine(d, "loom/5332762e-a-3", "5332762e-a: raise 3 (t3)");

  const filesBefore = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const sourceFile = filesBefore.find((f) => f.endsWith(".json") && sameTokenSet(readTokensOnDisk(f), [t1, t2, t3]));
  check("(a precondition) found the primary pending-divert file on disk holding t1,t2,t3", typeof sourceFile === "string");
  const sourcePath = path.join(MERGE_QUARANTINE_DIR, sourceFile);

  const inject = injectRenameFault(sourcePath);
  try {
    clearMergeQuarantineByToken(d, t1);
  } finally {
    inject.restore();
  }
  check("(a precondition) the primary rename was forced to fail exactly once", inject.hits() === 1);

  const filesAfterClear1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpA = filesAfterClear1.find((f) => f.includes(".tmp-") && !filesBefore.includes(f));
  check("(a precondition) a stranded tmp residue exists on disk after the failed narrowing write", typeof strandedTmpA === "string");
  check("(a precondition, by content) the stranded tmp holds [t2,t3] (the narrowed, pre-rename-fail snapshot)", sameTokenSet(readTokensOnDisk(strandedTmpA), [t2, t3]));
  const entryAfterClear1 = listActiveMergeQuarantines().find((e) => e.repoPath === d);
  check("*** THE FIX (a) *** the stranded tmp's own basename IS tracked in the entry's orphanLatchFiles right now", (entryAfterClear1?.orphanLatchFiles ?? []).includes(strandedTmpA));
  check("(a precondition, by content) the primary file is untouched (still holds t1,t2,t3 — rename never landed)", sameTokenSet(readTokensOnDisk(sourceFile), [t1, t2, t3]));

  // Clear t2 cleanly (no injected fault) — this is the LATER clear whose own
  // rewriteOrphanLatchFilesAfterPartialClear must now reach the tracked tmp and durably narrow it.
  clearMergeQuarantineByToken(d, t2);
  check("*** THE FIX (a), BY CONTENT *** the tracked tmp is durably narrowed to [t3] ONLY on the t2 clear — t1 and t2 are both gone from this file too, not just in-memory", sameTokenSet(readTokensOnDisk(strandedTmpA), [t3]));
  check("(a precondition) the tracked tmp still SURVIVES the t2 clear (narrowed, not swept yet — t3 is still outstanding; this alone also holds with tracking disabled, so it is not itself proof of the fix)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, strandedTmpA)));

  // Clear t3 (the last remaining token) cleanly — the card's own "cleared cleanly" leg, now a full lift.
  clearMergeQuarantineByToken(d, t3);

  check("(a precondition) in-process, d is NOT reported blocked after both remaining tokens are cleared", stillBlockedEntryFor(d) === undefined);
  const filesAfterFullClear = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("(a precondition) the primary pending-divert file is gone (swept on full lift)", !filesAfterFullClear.includes(sourceFile));
  check("*** THE FIX (a), FULL-LIFT SWEEP *** the tracked tmp is DELETED (not merely left stale) once its last token is cleared", !filesAfterFullClear.includes(strandedTmpA));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const after = rb.stillBlockedEntryFor(d);
  console.log(`    -> after reboot, stillBlockedEntryFor(d) = ${after ? JSON.stringify(after.tokens) : "undefined"}`);
  check("*** THE FIX (a), THE CARD'S OWN REPRO, CLOSED *** d is genuinely unblocked after reboot — never again resurrected by a durably-cleared token", after === undefined);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a stranded tmp from a failed clear-time narrowing write is tracked in orphanLatchFiles, so a later clear durably narrows (by content) or sweeps (deletes) it, and it never resurrects a cleared token at the next boot."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
