import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 444cd8e2. Widened by the e1572b69 Code Review (reviewer bc7d387f, by trace only): TWO
// failure branches still don't track their stranded tmp in orphanLatchFiles — the same missing-tracking
// defect class card 5332762e fixed for clearTokenFromPendingIndices' primary write:
//   SITE A — the dual-tracked twin write in clearActiveEntryTokenAtKey (~L5211-5224)
//   SITE B — the tied-twin write in clearMergeQuarantineByKey's own reduce branch (~L6605-6617)
//
// Repro shape (per the card): raise t1,t2,t3 for a REAL, resolvable repo d, armed as a genuine
// 883e29bc-style dual-tracked twin (the SAME entry object referenced from BOTH activeQuarantines and
// pendingUnresolvedQuarantines, via setActiveQuarantineTestOnly/pushPendingQuarantineTestOnly — see that
// function's own doc comment for why this is the sanctioned way to construct this exact shape
// hermetically). Fail the twin's own rename while clearing t1 (leaves an untracked stranded tmp holding
// [t2,t3]); clear t2 and t3 cleanly (narrows/sweeps only the tracked twin sourceFile + the active key's
// own latch, never the untracked tmp before the fix); reboot — the untracked tmp used to resurrect t2,t3
// as a duplicate. Site B mirrors this with a STRUCTURALLY-tied (not same-object) pending twin P sharing
// W's own identity and armed key (card 64119847's own precondition shape), reduced rather than removed.
//
// @decision 444cd8e2 — the fix mirrors 5332762e: track the failed write's own `strandedTmp` basename into
// `orphanLatchFiles` AFTER that branch's own `rewriteOrphanLatchFilesAfterPartialClear` call. See the
// decision record for the full investigation.
//
// Per decision 59e758e5's own "Do not" list: never call a resolve-aware query (`activeMergeQuarantineFor`/
// `resolveQuarantineFor`) between an injected write failure/clear and a later durable assertion — that
// chokepoint's own "lazy re-resolve on first query" self-heal can mask the exact loss/resurrection this
// test exists to prove. Every check below reads either the quarantine dir's own on-disk CONTENT directly,
// or `listActiveMergeQuarantines()`/`stillBlockedEntryFor` (a pure peek, never self-healing).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-444cd8e2-twin-write-tracking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq444cd8e2-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, clearMergeQuarantineByToken, clearMergeQuarantineByKey,
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly,
  listActiveMergeQuarantines, stillBlockedEntryFor,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const GIT_ID = "-c user.email=mq444cd8e2@loom -c user.name=mq444cd8e2";

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq444cd8e2-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execSync("git init -q && git config user.email mq444cd8e2@loom && git config user.name mq444cd8e2", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function quarantineHashForKeyTest(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function injectRenameFaultAt(targetPath) {
  const realRename = fs.renameSync;
  let hits = 0;
  fs.renameSync = (a, b) => {
    if (b === targetPath) { hits++; throw Object.assign(new Error("EPERM: simulated twin-write rename failure"), { code: "EPERM" }); }
    return realRename(a, b);
  };
  return { restore: () => { fs.renameSync = realRename; }, hits: () => hits };
}
function readTokensOnDisk(basename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, basename), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : undefined;
  } catch { return undefined; }
}
const sameTokenSet = (a, b) => a !== undefined && b !== undefined && a.length === b.length && new Set(a).size === a.length && a.every((t) => b.includes(t));

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b444cd8e2=${bootReimportCounter}`);
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SITE A — clearActiveEntryTokenAtKey's dual-tracked pending-twin write.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = makeToplevelRepo("a");
  const Kd = canonicalRepoLockKey(d);
  const twinSourceFile = "pending-444cd8e2a-twin-fixture.json";
  const t1 = "tok-444cd8e2a-t1", t2 = "tok-444cd8e2a-t2", t3 = "tok-444cd8e2a-t3";
  const twin = { repoPath: d, branch: "d-branch", reason: "444cd8e2 site A precondition", enteredAt: Date.now(), tokens: [t1, t2, t3], resolvedKey: Kd, armedKeys: [Kd] };
  setActiveQuarantineTestOnly(Kd, twin);
  pushPendingQuarantineTestOnly(twin, twinSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twinSourceFile), JSON.stringify({ repoPath: d, branch: twin.branch, reason: twin.reason, tokens: twin.tokens, enteredAt: twin.enteredAt }, null, 2) + "\n");

  const twinPath = path.join(MERGE_QUARANTINE_DIR, twinSourceFile);
  const inject = injectRenameFaultAt(twinPath);
  try { clearMergeQuarantineByToken(d, t1); } finally { inject.restore(); }
  check("(A precondition) the twin's own rename was forced to fail at least once", inject.hits() >= 1);

  const filesAfterClear1 = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmp = filesAfterClear1.find((f) => f.includes(".tmp-") && f !== twinSourceFile && f.startsWith("pending-444cd8e2a"));
  check("(A precondition) a stranded tmp residue exists on disk after the failed twin write", typeof strandedTmp === "string");
  check("(A precondition, by content) the stranded tmp holds [t2,t3] (the narrowed, pre-rename-fail snapshot)", strandedTmp !== undefined && sameTokenSet(readTokensOnDisk(strandedTmp), [t2, t3]));
  const entryAfterClear1 = listActiveMergeQuarantines().find((e) => e.repoPath === d);
  check("*** THE FIX (A) *** the stranded tmp's own basename IS tracked in the entry's orphanLatchFiles right now", strandedTmp !== undefined && (entryAfterClear1?.orphanLatchFiles ?? []).includes(strandedTmp));
  check("(A precondition, by content) the twin's own sourceFile is untouched (still holds t1,t2,t3 — rename never landed)", sameTokenSet(readTokensOnDisk(twinSourceFile), [t1, t2, t3]));

  // Clear t2 cleanly — d must still read correctly BLOCKED by the one remaining outstanding token (t3),
  // never falsely lifted and never still showing the already-cleared t1/t2 — the fix must not under- or
  // over-block between clears.
  clearMergeQuarantineByToken(d, t2);
  const blockedAfterT2 = stillBlockedEntryFor(d);
  check("(A precondition) in-process, d is still correctly blocked by ONLY t3 after clearing t2", !!blockedAfterT2 && blockedAfterT2.tokens.includes(t3) && !blockedAfterT2.tokens.includes(t1) && !blockedAfterT2.tokens.includes(t2));
  check("*** THE FIX (A), BY CONTENT *** the tracked tmp is durably narrowed to [t3] ONLY on the t2 clear", sameTokenSet(readTokensOnDisk(strandedTmp), [t3]));

  // Clear t3 (the last remaining token) cleanly — a genuine full lift.
  clearMergeQuarantineByToken(d, t3);
  check("(A precondition) in-process, d is NOT reported blocked after both remaining tokens are cleared", stillBlockedEntryFor(d) === undefined);

  const filesAfterFullClearA = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (A), FULL-LIFT SWEEP *** the tracked tmp is DELETED (not merely left stale) once its last token is cleared", strandedTmp !== undefined && !filesAfterFullClearA.includes(strandedTmp));

  const rbA = await rebootSim();
  rbA.reenterMergeQuarantinesAtBoot([]);
  const afterA = rbA.stillBlockedEntryFor(d);
  console.log(`    -> SITE A after reboot, stillBlockedEntryFor(d) = ${afterA ? JSON.stringify(afterA.tokens) : "undefined"}`);
  check("*** THE FIX (A), THE CARD'S OWN REPRO, CLOSED *** d is genuinely unblocked after reboot — never again resurrected by a durably-cleared token", afterA === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SITE B — clearMergeQuarantineByKey's own reduce-branch tied-twin write.
// Constructed via a STRUCTURALLY-tied (not same-object) pending twin: P shares W's own identity and armed
// key (card 64119847's own precondition: "W active at key K, tokens {s}; P pending, SAME identity, tokens
// {s,v}, armedKeys [K]"), so P is REDUCED (keeps its own private token v) rather than removed outright —
// the "reduce" branch clearMergeQuarantineByKey's own pendingPlan drives this write through.
// Note: clearMergeQuarantineByKey's own pendingPlan loop requires `directPathIdentity(p.entry.repoPath)
// === identity` — a tied twin here must share the SAME repoPath as the entry being cleared, never merely
// an armed key under a DIFFERENT identity (that shape is handled elsewhere, by foreign-occupant
// protection, not this reduce-vs-remove plan).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = makeToplevelRepo("b");
  const Kw = canonicalRepoLockKey(w);
  const s = "tok-444cd8e2b-s"; // W's own token, lifted when W is fully cleared
  const v = "tok-444cd8e2b-v"; // P's own PRIVATE token, must survive W's own full clear
  const wEntry = { repoPath: w, branch: "w-branch", reason: "444cd8e2 site B — W", enteredAt: Date.now(), tokens: [s], resolvedKey: Kw, armedKeys: [Kw] };
  setActiveQuarantineTestOnly(Kw, wEntry);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${quarantineHashForKeyTest(Kw)}.json`), JSON.stringify({ repoPath: w, branch: wEntry.branch, reason: wEntry.reason, tokens: wEntry.tokens, enteredAt: wEntry.enteredAt }, null, 2) + "\n");

  const pSourceFile = "pending-444cd8e2b-twin-fixture.json";
  const pEntry = { repoPath: w, branch: "p-branch", reason: "444cd8e2 site B — P (tied via armedKeys)", enteredAt: Date.now(), tokens: [s, v], armedKeys: [Kw] };
  pushPendingQuarantineTestOnly(pEntry, pSourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, pSourceFile), JSON.stringify({ repoPath: w, branch: pEntry.branch, reason: pEntry.reason, tokens: pEntry.tokens, enteredAt: pEntry.enteredAt }, null, 2) + "\n");

  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);
  const injectB = injectRenameFaultAt(pPath);
  // The manager-approved reduce path: a full clear at W's own key, identity-wide (the human-route shape).
  try { clearMergeQuarantineByKey(Kw, w, undefined, true); } finally { injectB.restore(); }
  check("(B precondition) P's own twin rename was forced to fail at least once", injectB.hits() >= 1);

  const filesAfterClearB = fs.readdirSync(MERGE_QUARANTINE_DIR);
  const strandedTmpB = filesAfterClearB.find((f) => f.includes(".tmp-") && f !== pSourceFile && f.startsWith("pending-444cd8e2b"));
  check("(B precondition) a stranded tmp residue exists on disk after P's failed reduce-write", typeof strandedTmpB === "string");
  check("(B precondition, by content) the stranded tmp holds [v] (the narrowed, pre-rename-fail snapshot)", strandedTmpB !== undefined && sameTokenSet(readTokensOnDisk(strandedTmpB), [v]));
  check("(B precondition, by content) P's own sourceFile is untouched (still holds s,v — rename never landed)", sameTokenSet(readTokensOnDisk(pSourceFile), [s, v]));

  // W itself is fully lifted (its only token was s) but P (same identity) was only REDUCED, keeping its
  // own private token v — w must still read correctly blocked, by v alone, via P (never falsely lifted,
  // never still showing s).
  const blockedAfterW = stillBlockedEntryFor(w);
  check("(B precondition) in-process, w IS still correctly blocked by ONLY P's own surviving private token v", !!blockedAfterW && blockedAfterW.tokens.includes(v) && !blockedAfterW.tokens.includes(s));

  // Confirm, by reading rather than assuming, WHICH live record the later full-lift sweep will actually
  // consult: W is gone (fully lifted), so the only live record for this identity must be P itself — and
  // it must be the one carrying the tracked tmp reference, not some separate/stale object.
  const liveForW = listActiveMergeQuarantines().filter((e) => e.repoPath === w);
  check("(B, by inspection) exactly ONE live record remains for w — W was fully removed, P survives alone", liveForW.length === 1);
  const theLiveRecord = liveForW[0];
  check("(B, by inspection) that one live record IS P — its own tokens are [v] alone (the reduced twin, never W's stale [s])", !!theLiveRecord && sameTokenSet(theLiveRecord.tokens, [v]));
  check("*** THE FIX (B) *** the stranded tmp's own basename IS tracked on THAT SAME record's orphanLatchFiles", strandedTmpB !== undefined && !!theLiveRecord && (theLiveRecord.orphanLatchFiles ?? []).includes(strandedTmpB));

  // Clear v (P's last remaining token) cleanly — the genuine full lift for this identity, consulting
  // exactly the record just inspected above.
  clearMergeQuarantineByToken(w, v);
  check("(B precondition) in-process, w is NOT reported blocked after v is also cleared", stillBlockedEntryFor(w) === undefined);
  const filesAfterVClearB = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check("*** THE FIX (B), FULL-LIFT SWEEP *** the tracked tmp is DELETED (not merely left stale) once its last token (v) is cleared", strandedTmpB !== undefined && !filesAfterVClearB.includes(strandedTmpB));

  const rbB = await rebootSim();
  rbB.reenterMergeQuarantinesAtBoot([]);
  const afterB = rbB.stillBlockedEntryFor(w);
  console.log(`    -> SITE B after reboot, stillBlockedEntryFor(w) = ${afterB ? JSON.stringify(afterB.tokens) : "undefined"}`);
  check("*** THE FIX (B), THE CARD'S OWN REPRO, CLOSED *** w is genuinely unblocked after reboot — never again resurrected by a durably-cleared token", afterB === undefined);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a stranded tmp from either failed twin write is tracked in orphanLatchFiles, so a later clear durably narrows (by content) or sweeps (deletes) it, and it never resurrects a cleared token at the next boot."
  : `\n❌ ${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
