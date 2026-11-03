import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 8d80b736, found by the 59e758e5 CR round 2 (reviewer 6aee1d61, probe9 L2). The 3 raise
// callers' own triple-fault "keep the stranded tmp" branches (card 59e758e5, B1: mintPendingDivert,
// divertRaiseEntry, mergeTokenIntoPendingEntries) kept a stranded `pending-<hash>.json.tmp-<pid>-<hex>`
// on disk but never referenced it anywhere — so an in-process clear only ever narrowed/swept whatever
// `sourceFile` named, leaving the untracked tmp's own stale (pre-clear) content to resurrect the
// just-cleared token at the next boot's tmp-recovery pass.
//
// @decision 8d80b736 — the fix tracks `path.basename(written.strandedTmp)` in the kept entry's own
// `orphanLatchFiles`, at those same 3 branches only — this is a pure cross-reference write at the exact
// call that minted the tmp, never a `orphanLatchFiles`-based MATCH (forbidden by decision 9cabd143).
//
// Per decision 59e758e5's own "Do not" list: never call `activeMergeQuarantineFor`/`resolveQuarantineFor`
// (or `resolveQuarantineForTestOnly`, its own test-only mirror) between an injected failure/clear and a
// later durable assertion — that chokepoint's own "lazy re-resolve on first query" self-heal can mask
// the exact loss/resurrection this test exists to prove. Every polarity check below reads either the
// quarantine dir's own on-disk CONTENT directly, or `listActiveMergeQuarantines()`/`stillBlockedEntryFor`
// (a pure peek, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-8d80b736-stranded-tmp-orphan-tracking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq8d80b736-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine, clearMergeQuarantineByToken, listActiveMergeQuarantines, stillBlockedEntryFor, MERGE_QUARANTINE_DIR } = mod;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const GIT_ID = "-c user.email=mq8d80b736@loom -c user.name=mq8d80b736";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Forces BOTH the primary rename AND the safety-tmp fallback's own write to fail — the triple fault that
// lands in each raise caller's own "keep the stranded tmp" branch. Mirrors
// merge-quarantine-59e758e5-triple-fault-no-loss.mjs's own helper exactly.
function injectTripleFault({ onlyRenameTarget } = {}) {
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let renameHits = 0;
  let openHits = 0;
  fs.renameSync = (a, b) => {
    if (onlyRenameTarget !== undefined && b !== onlyRenameTarget) return realRename(a, b);
    renameHits++;
    throw Object.assign(new Error("EPERM: simulated triple-fault rename failure"), { code: "EPERM" });
  };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(".tmp-safety-")) {
      openHits++;
      throw Object.assign(new Error("ENOSPC: simulated triple-fault safety-tmp open failure"), { code: "ENOSPC" });
    }
    return realOpen(p, ...rest);
  };
  return {
    restore: () => { fs.renameSync = realRename; fs.openSync = realOpen; },
    hits: () => [renameHits, openHits],
  };
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b8d80b736=${bootReimportCounter}`);
}

// Reads a quarantine-dir basename's own on-disk CONTENT directly (never through the module's own
// resolve-aware queries) and returns its raw `tokens` array, or undefined if unreadable/missing.
function readTokensOnDisk(basename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, basename), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : undefined;
  } catch {
    return undefined;
  }
}
const sameTokenSet = (a, b) => a !== undefined && b !== undefined && a.length === b.length && new Set(a).size === a.length && a.every((t) => b.includes(t));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO A ("8d80b736-a-mergeTokenIntoPendingEntries") — a SECOND raise on an always-unresolvable
// identity, triple-faulted (exactly card 8d80b736's own measured shape). Covers: the tmp is tracked
// immediately; a PARTIAL clear narrows its on-disk content in place; a reboot does not resurrect the
// cleared token; a FOLLOW-UP full clear sweeps (deletes) both files via the full-lift path; a second
// reboot shows the identity genuinely unblocked — never "still blocked by" a resurrected token.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq8d80b736-a-never-exists-${freshSfx()}`);
  const t1 = enterMergeQuarantine(d, "loom/8d80b736-a-1", "8d80b736-a: first raise (t1)");

  const inject = injectTripleFault();
  let t2;
  try {
    t2 = enterMergeQuarantine(d, "loom/8d80b736-a-2", "8d80b736-a: second raise (t2), triple fault");
  } finally {
    inject.restore();
  }
  check("(a precondition) both the rename AND the safety-tmp fallback's own write were forced to fail", JSON.stringify(inject.hits()) === JSON.stringify([1, 1]));

  const filesAfterRaise = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpA = filesAfterRaise.find((f) => f.includes(".tmp-") && !f.includes(".tmp-safety-"));
  check("(a precondition) a stranded tmp residue exists on disk after the triple fault", typeof strandedTmpA === "string");
  check("*** THE FIX (a) *** the stranded tmp's own basename is tracked in the entry's orphanLatchFiles right now", (listActiveMergeQuarantines().find((e) => e.repoPath === d)?.orphanLatchFiles ?? []).includes(strandedTmpA));
  check("(a precondition, by content) the stranded tmp's own on-disk bytes hold BOTH t1 and t2", sameTokenSet(readTokensOnDisk(strandedTmpA), [t1, t2]));

  // Partial clear: narrows the merged record down to just t1. Per decision 59e758e5's own Do-not list,
  // never call a resolve-aware query between this and the later assertions below.
  clearMergeQuarantineByToken(d, t2);

  check("*** THE FIX (a) *** the stranded tmp SURVIVES on disk after the partial clear (narrowed, not orphaned-and-ignored)", fs.existsSync(path.join(MERGE_QUARANTINE_DIR, strandedTmpA)));
  check("*** THE FIX (a), BY CONTENT *** the stranded tmp's own on-disk bytes are durably narrowed to ONLY t1 — t2 is gone from this file too, not just in-memory", sameTokenSet(readTokensOnDisk(strandedTmpA), [t1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const tokensForDAfterReboot = new Set(rb.listActiveMergeQuarantines().filter((e) => e.repoPath === d).flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (a) *** t1 still blocks d after the reboot", tokensForDAfterReboot.has(t1));
  check("*** THE FIX (a), THE BUG'S OWN SHAPE, CLOSED *** t2 (cleared in-process BEFORE the reboot) does NOT come back armed", !tokensForDAfterReboot.has(t2));
  check("*** THE FIX (a) *** stillBlockedEntryFor (pure peek) still reports d blocked after the reboot", rb.stillBlockedEntryFor(d) !== undefined);

  // Second leg, matching the card's own "after clearing t1 and rebooting, d was still blocked by t2":
  // clear the remaining token (t1) too — this is the FULL-LIFT sweep path (both the original .json and
  // the now-single-token-holding tmp get deleted outright).
  rb.clearMergeQuarantineByToken(d, t1);
  const filesAfterFullClear = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (a), FULL-LIFT SWEEP *** the stranded tmp is DELETED (not merely left stale) once its last token is cleared", !filesAfterFullClear.includes(strandedTmpA));

  const rb2 = await rebootSim();
  rb2.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (a), SECOND LEG, THE CARD'S OWN REPRO, CLOSED *** d is genuinely unblocked after a second reboot — never again \"still blocked by t2\"", rb2.stillBlockedEntryFor(d) === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO B ("8d80b736-b-mintPendingDivert") — a FIRST-EVER raise on an always-unresolvable identity,
// triple-faulted. Single token, so clearing it is directly a FULL-LIFT sweep with no prior narrowing —
// covers mintPendingDivert's own triple-fault branch specifically.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = path.join(os.tmpdir(), `loom-mq8d80b736-b-never-exists-${freshSfx()}`);

  const inject = injectTripleFault();
  let t1;
  try {
    t1 = enterMergeQuarantine(d, "loom/8d80b736-b-1", "8d80b736-b: first-ever raise, triple fault");
  } finally {
    inject.restore();
  }
  check("(b precondition) both the rename AND the safety-tmp fallback's own write were forced to fail", JSON.stringify(inject.hits()) === JSON.stringify([1, 1]));

  const filesAfterRaise = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpB = filesAfterRaise.find((f) => f.includes(".tmp-") && !f.includes(".tmp-safety-") && readTokensOnDisk(f)?.includes(t1));
  check("(b precondition) a stranded tmp residue exists on disk after the triple fault", typeof strandedTmpB === "string");
  check("*** THE FIX (b) *** the stranded tmp's own basename is tracked in the entry's orphanLatchFiles right now", (listActiveMergeQuarantines().find((e) => e.repoPath === d)?.orphanLatchFiles ?? []).includes(strandedTmpB));

  clearMergeQuarantineByToken(d, t1);
  check("*** THE FIX (b), FULL-LIFT SWEEP *** the stranded tmp is DELETED outright on the first-ever raise's own full clear (no prior narrowing needed)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, strandedTmpB)));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (b), THE BUG'S OWN SHAPE, CLOSED *** d is NOT resurrected as a stray duplicate after the reboot", rb.stillBlockedEntryFor(d) === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO C ("8d80b736-c-divertRaiseEntry") — a VERIFIED (resolvable) repo whose every raise is forced
// to divert, triple-faulted on its SECOND raise's own matched-indices rewrite — covers divertRaiseEntry's
// own triple-fault branch specifically. Mirrors merge-quarantine-59e758e5-triple-fault-no-loss.mjs's own
// scenario C construction.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = path.join(os.tmpdir(), `loom-mq8d80b736-c-y-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  fs.writeFileSync(path.join(y, "README.md"), "# 8d80b736-c\n");
  execSync("git init -q && git config user.email mq8d80b736c@loom && git config user.name mq8d80b736c", { cwd: y });
  commitAll(y, "init", GIT_ID);

  const Ky = canonicalRepoLockKey(y);
  const yFinalPath = path.join(MERGE_QUARANTINE_DIR, `${createHash("sha256").update(Ky).digest("hex").slice(0, 24)}.json`);

  const realReadFileSync = fs.readFileSync;
  const withForcedUnreadableFinal = (fn) => {
    fs.readFileSync = (p, ...rest) => {
      if (p === yFinalPath) throw Object.assign(new Error("EACCES: simulated read failure"), { code: "EACCES" });
      return realReadFileSync(p, ...rest);
    };
    try { return fn(); } finally { fs.readFileSync = realReadFileSync; }
  };

  const findSourceFileForY = () => fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === y; } catch { return false; }
  });

  const t1 = withForcedUnreadableFinal(() => enterMergeQuarantine(y, "loom/8d80b736-c-1", "8d80b736-c: first raise, verified but forced to divert"));
  const base1 = findSourceFileForY();
  check("(c precondition) y's first diverted raise minted its own pending-divert record", typeof base1 === "string");
  const base1Path = path.join(MERGE_QUARANTINE_DIR, base1);

  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let renameHits2 = 0, safetyHits2 = 0;
  fs.renameSync = (a, b) => { if (b === base1Path) { renameHits2++; throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" }); } return realRename(a, b); };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(".tmp-safety-")) { safetyHits2++; throw Object.assign(new Error("ENOSPC: simulated safety-tmp open failure"), { code: "ENOSPC" }); }
    return realOpen(p, ...rest);
  };
  let t2;
  try {
    t2 = withForcedUnreadableFinal(() => enterMergeQuarantine(y, "loom/8d80b736-c-2", "8d80b736-c: second raise, verified but forced to divert, triple fault"));
  } finally {
    fs.renameSync = realRename;
    fs.openSync = realOpen;
  }
  check("(c precondition) the matched-branch rewrite's own rename AND its safety-tmp fallback were both forced to fail", renameHits2 >= 1 && safetyHits2 >= 1);

  const filesAfterRaise2 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpC = filesAfterRaise2.find((f) => f.startsWith(base1) && f.includes(".tmp-") && !f.includes(".tmp-safety-"));
  check("(c precondition) a stranded tmp residue exists on disk for y after the triple fault", typeof strandedTmpC === "string");
  check("*** THE FIX (c) *** the stranded tmp's own basename is tracked in the entry's orphanLatchFiles right now", (listActiveMergeQuarantines().find((e) => e.repoPath === y)?.orphanLatchFiles ?? []).includes(strandedTmpC));
  check("(c precondition, by content) the stranded tmp's own on-disk bytes hold BOTH t1 and t2", sameTokenSet(readTokensOnDisk(strandedTmpC), [t1, t2]));

  // @decision 59e758e5 (round 3) — deliberately NOT calling activeMergeQuarantineFor here; see that
  // decision's own Do-not list.
  clearMergeQuarantineByToken(y, t2);
  check("*** THE FIX (c), BY CONTENT *** the stranded tmp's own on-disk bytes are durably narrowed to ONLY t1", sameTokenSet(readTokensOnDisk(strandedTmpC), [t1]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([]);
  const tokensForYAfterReboot = new Set(rb.listActiveMergeQuarantines().filter((e) => e.repoPath === y).flatMap((e) => e.tokens ?? []));
  check("*** THE FIX (c) *** t1 still blocks y after the reboot", tokensForYAfterReboot.has(t1));
  check("*** THE FIX (c), THE BUG'S OWN SHAPE, CLOSED *** t2 does NOT come back armed after the reboot", !tokensForYAfterReboot.has(t2));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a stranded, triple-fault-kept pending tmp is tracked in orphanLatchFiles, so an in-process clear durably narrows (by content) or sweeps (deletes) it, and it never resurrects a cleared token at the next boot, across mintPendingDivert, divertRaiseEntry and mergeTokenIntoPendingEntries."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
