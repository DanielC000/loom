import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 2dd97aaa item 3 (RE-SCOPED per the card's own triage note, after 21ec39e5 landed) — the
// PENDING-DIVERT safety-tmp angle, construction 1: a second raise on an always-unresolvable identity
// takes enterMergeQuarantine's `!verified` + existing-pending-match branch, mergeTokenIntoPendingEntries
// (merge-quarantine.ts), which calls writePendingDivertFile(base.sourceFile, merged) to durably persist
// the UNIONED token set. Unlike divertRaiseEntry (see the sibling test, -divert-double-fault.mjs), this
// function has NO safety-tmp fallback of its own: if the write's own renameSync fails (EPERM) after its
// tmp was already written and fsynced, it just logs and leaves base.sourceFile's own STALE bytes
// (holding only the original token) untouched on disk, right next to the STRANDED tmp residue (never
// cleaned up, never tracked in orphanLatchFiles) holding the FULL, correct merged set. This test checks
// whether a fresh boot, with no in-memory state at all, still correctly recovers the full token set from
// the stranded tmp alone, or loses the freshly-added token.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq2dd97aaa-i3-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// @decision 2dd97aaa (round 2, CR Minor 3) — an implementation-detail observation (which on-disk file
// shape a recovery path happened to leave behind) is NOT the card's own claim under test (whether a
// token is lost) and must never fail the suite on its own; log it informationally only.
const diagnose = (label, cond) => { console.log(`${cond ? "DIAG-TRUE " : "DIAG-FALSE"}  ${label}`); };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function freshNeverExists(tag) {
  return path.join(os.tmpdir(), `loom-mq2dd97aaa-i3-${tag}-never-exists-${freshSfx()}`);
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function listDirFiles() {
  return fs.readdirSync(MERGE_QUARANTINE_DIR);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// Monkeypatches fs.renameSync to throw EPERM for exactly ONE target path (the first call whose `dest`
// equals `targetPath`), then restores itself automatically on that one trip.
function injectOneShotRenameFailure(targetPath) {
  const real = fs.renameSync;
  let tripped = false;
  fs.renameSync = (src, dest) => {
    if (!tripped && dest === targetPath) {
      tripped = true;
      fs.renameSync = real;
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }
    return real(src, dest);
  };
  return { restore: () => { fs.renameSync = real; }, tripped: () => tripped };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("2dd97aaa-item3-pending-divert-safety-tmp-reboot-recovery") — a pre-existing pending entry
// (token t1) + a second raise (token t2, mergeTokenIntoPendingEntries's own union-into-existing branch)
// whose own writePendingDivertFile rename fails after its tmp is written. Confirms whether the safety-tmp fallback
// + the stranded tmp residue it leaves behind both survive a fresh boot with the full {t1,t2} set, or
// whether t2 (or t1) is lost.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshNeverExists("s1");

  const t1 = enterMergeQuarantine(y, "loom/i3-branch-1", "2dd97aaa-i3: first raise (t1)");
  check("(precondition) t1 raised, y pending with exactly {t1}", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === t1));

  const filesBefore = listDirFiles();
  check("(precondition) exactly one real latch file exists for y before the second raise", filesBefore.filter((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === y).length === 1);
  const baseSourceFile = filesBefore.find((f) => readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f))?.repoPath === y);
  const baseSourcePath = path.join(MERGE_QUARANTINE_DIR, baseSourceFile);

  const inject = injectOneShotRenameFailure(baseSourcePath);
  let t2;
  try {
    t2 = enterMergeQuarantine(y, "loom/i3-branch-2", "2dd97aaa-i3: second raise (t2), rename forced to fail");
  } finally {
    inject.restore();
  }
  check("(precondition) the injected rename failure actually tripped", inject.tripped());
  check("(precondition) t2 raised, y active+pending in-memory with BOTH {t1,t2} right now", listActiveMergeQuarantines().some((e) => e.tokens.includes(t1) && e.tokens.includes(t2)));

  const filesAfter = listDirFiles();
  const yFiles = filesAfter.filter((f) => {
    const parsed = readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f));
    return parsed?.repoPath === y;
  });
  console.log(`(diagnostic) files on disk naming y's repoPath after the forced failure: ${JSON.stringify(yFiles)}`);
  console.log(`(diagnostic) ALL files in MERGE_QUARANTINE_DIR after the forced failure: ${JSON.stringify(filesAfter)}`);
  for (const f of filesAfter) {
    const parsed = readJsonSafe(path.join(MERGE_QUARANTINE_DIR, f));
    console.log(`(diagnostic)   ${f} -> ${parsed ? JSON.stringify({ repoPath: parsed.repoPath, tokens: parsed.tokens }) : "(unparsable/corrupt/not JSON)"}`);
  }
  // `mergeTokenIntoPendingEntries` (unlike `divertRaiseEntry`) has NO safety-tmp fallback of its own on a
  // write failure — it just logs and leaves the pending entry pointed at `base.sourceFile` unchanged, so
  // `base.sourceFile`'s own STALE bytes (still holding only {t1}) are left on disk, untouched, next to the
  // stranded tmp. This is the ACTUAL, observed behavior of this code path — not swept, unlike
  // `divertRaiseEntry`'s own double-fault branch (see the sibling test).
  diagnose("base.sourceFile is left stale on disk (mergeTokenIntoPendingEntries has no safety-tmp fallback to sweep it toward) — informational only, not the item-3 claim under test", fs.existsSync(baseSourcePath) && JSON.stringify(readJsonSafe(baseSourcePath)?.tokens) === JSON.stringify([t1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]); // y never exists on disk — nothing registered/resolvable
  const yAfterReboot = rb.listActiveMergeQuarantines().filter((e) => e.repoPath === y || e.tokens.includes(t1) || e.tokens.includes(t2));
  console.log(`(diagnostic) y's entries after reboot: ${JSON.stringify(yAfterReboot.map((e) => ({ repoPath: e.repoPath, tokens: e.tokens })))}`);

  check("*** THE CLAIM *** t1 survives the reboot", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t1)));
  check("*** THE CLAIM *** t2 ALSO survives the reboot (this is what item 3 claims is lost)", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes(t2)));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — t2 survives a reboot via the stranded tmp residue alone (mergeTokenIntoPendingEntries has no safety-tmp fallback of its own); item 3's premise does NOT reproduce in this construction."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
