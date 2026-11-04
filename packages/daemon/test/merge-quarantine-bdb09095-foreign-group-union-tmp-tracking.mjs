import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bdb09095 (from the 444cd8e2 Code Review, by trace only). `consumeMatchedPendingsIntoArmedEntry`'s
// own `foreignGroups` `group.length > 1` arm (merge-quarantine.ts, the
// `writePendingDivertFile(base.sourceFile, foreignUnion, new Set())` call inside the raise-divert branch)
// kept its own stranded tmp on a write failure (correct, per 59e758e5's "never unlink without proof the
// content is secured elsewhere") but never referenced it in `foreignUnion.orphanLatchFiles` — the same
// missing-tracking defect class 5332762e/444cd8e2/8d80b736 already fixed at five OTHER sites.
//
// THE FIX: when `written.strandedTmp` is truthy, add `path.basename(written.strandedTmp)` to
// `foreignUnion.orphanLatchFiles` (Set-deduped, never the absolute path, never an unlink) and
// `replaceEntryEverywhere` the group onto the updated object before the push — see
// docs/decisions/bdb09095-foreign-group-union-tracks-stranded-tmp.md.
//
// SCENARIO "hash" — the group's `base` (earliest `enteredAt`) happens to share a canonicalRepoLockKey-
// derived hash with something a later full lift separately deletes at that SAME hash — an unrelated,
// hash-keyed sweep (`sweepTmpResidueForHashIfUnreferenced`) already incidentally removed the stray even
// pre-fix. Included as a regression-safety sanity check: the fix must not change this already-working
// case (both orderings share identical end-state assertions for "no stray"/"unblocked after reboot").
//
// SCENARIO "legacy" — `base` is instead a label-named pending record with no identity-hash tie (a prior
// raise's own "legacy-...json" fallback name — realistic, since `base` is picked purely by oldest
// `enteredAt`, never by name shape). Pre-fix, the stranded tmp survives the full lift and a real reboot;
// PASS 1b's tmp-recovery pass re-arms it, wrongly RE-BLOCKING the repo by tokens already fully cleared.
// It also interacts with d2592cd5: the untracked stray's physical bytes make the full-identity-clear
// path's own `identityHasAnyPhysicalRecordOnDisk` (merge-quarantine.ts ~L856) withhold the durable
// tombstone for the WHOLE identity — even `fb`, a token never physically present in the stray at all —
// so a reboot used to resurrect every token for the identity, not only the ones the stray itself carried.
// *** THIS is the scenario the negative control turns RED. ***
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-bdb09095-foreign-group-union-tmp-tracking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-bdb09095-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bdb09095@loom -c user.name=bdb09095";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bdb09095-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# bdb09095 (${tag})\n`);
  execSync(`git init -q && git config user.email bdb09095@loom && git config user.name bdb09095`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

function injectReadFailureAtCalls(targetPath, indices, code = "EACCES") {
  const real = fs.readFileSync;
  const idxSet = new Set(indices);
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (idxSet.has(callCount)) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

// Fails every renameSync EXCEPT one whose destination basename === `exceptBasename` (the raiser's own
// divert write, which must succeed normally so this test isolates ONLY the foreign-group's own write
// failure).
function injectRenameFailsExcept(exceptBasename, code = "EPERM") {
  const real = fs.renameSync;
  let hits = 0;
  fs.renameSync = (src, dest) => {
    const destBase = path.basename(String(dest));
    if (destBase === exceptBasename) return real(src, dest);
    hits++;
    throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
  };
  return { restore: () => { fs.renameSync = real; }, hits: () => hits };
}

let moduleImportCounter = 0;
async function freshMergeQuarantineModule() {
  moduleImportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleImportCounter}`);
}
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// `extraEnteredAtOffsetMs` controls which pending entry becomes `base` (earliest `enteredAt`) in the
// foreignGroups loop: a LARGE negative offset (older than the dual-tracked twin, ~now-100000) makes the
// LABEL-NAMED extra entry `base` ("legacy" ordering); a SMALL negative offset (younger than the twin)
// leaves the TWIN (hash-tied to the identity's own final file) as `base` ("hash" ordering).
async function runScenario(tag, extraEnteredAtOffsetMs) {
  const sF = makeToplevelRepo(`${tag}-sf`);
  const KsF = canonicalRepoLockKey(sF);
  const KsFhash = createHash("sha256").update(KsF).digest("hex").slice(0, 24);

  const top = path.join(os.tmpdir(), `loom-bdb09095-top-nonexistent-${tag}-${freshSfx()}`);
  const f = path.join(top, "subdir"); // F: becomes a SUBDIRECTORY of TOP, no .git of its own

  const mod = await freshMergeQuarantineModule();
  const {
    activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, reenterMergeQuarantinesAtBootTestOnly,
    MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  } = mod;
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const KsFFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KsFhash}.json`);
  fs.writeFileSync(KsFFinalPath, JSON.stringify({
    repoPath: f, branch: "f-branch-boot-a", reason: `${tag}: F degraded, walked up to S_F's own key (A)`,
    enteredAt: Date.now(), tokens: [`${tag}-tok-fb`], resolvedKey: KsF,
  }, null, 2) + "\n");
  const fPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(f));
  fs.writeFileSync(fPendingPath, JSON.stringify({
    repoPath: f, branch: "f-branch-boot-b", reason: `${tag}: F's own earlier record, also resolvedKey=S_F's key (B)`,
    enteredAt: Date.now() - 100000, tokens: [`${tag}-tok-fc`], resolvedKey: KsF,
  }, null, 2) + "\n");

  // A wholly separate, LATER raise of F while still unresolvable — never unioned with the twin above
  // until the raise this test is about to trigger.
  const extraSourceFile = `legacy-${createHash("sha256").update(`${tag}-extra`).digest("hex").slice(0, 24)}.json`;
  const extraEntry = {
    repoPath: f, branch: "f-branch-separate-later-raise", reason: `${tag}: F's own separate, later raise while still unresolvable (C)`,
    enteredAt: Date.now() + extraEnteredAtOffsetMs, tokens: [`${tag}-tok-fd`],
  };
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, extraSourceFile), JSON.stringify(extraEntry, null, 2) + "\n");
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: extraEntry, sourceFile: extraSourceFile }]);

  check(`(${tag} precondition) F's own TWIN exists: armed at S_F's own key with both boot tokens unioned`,
    (() => {
      const direct = activeMergeQuarantineFor(sF);
      return !!direct && direct.repoPath === f && new Set(direct.tokens).has(`${tag}-tok-fb`) && new Set(direct.tokens).has(`${tag}-tok-fc`);
    })());

  fs.mkdirSync(top, { recursive: true });
  execSync(`git init -q && git config user.email bdb09095@loom && git config user.name bdb09095`, { cwd: top });
  fs.writeFileSync(path.join(top, "README.md"), `# ${tag} top (now real)\n`);
  commitAll(top, "init", GIT_ID);
  fs.mkdirSync(f, { recursive: true }); // F: plain subdirectory, no .git of its own

  const Kd = canonicalRepoLockKey(top);
  check(`(${tag} setup) F's own fresh canonical key now equals TOP's key (toplevel walk)`, canonicalRepoLockKey(f) === Kd);
  check(`(${tag} setup) TOP's key differs from S_F's key`, Kd !== KsF);
  const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
  const KdFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);

  // Junk, SELF-identity content at Kd's own final — needed only so `resolveRaiseOverwrite`'s own
  // identity check returns "proceed" (same mechanism as the 67136b71 test's own "E" setup; the raise
  // itself never touches this file — it diverts instead). It is pure test scaffolding, deliberately
  // deleted below before the full-lift/reboot assertions so it can never be confused with this card's
  // own bug (the real final file for F's identity lives at KsFFinalPath, not here).
  const selfJunkBytes = JSON.stringify({
    repoPath: top, branch: "junk", reason: `${tag}: junk self-identity content at TOP's own fresh final`,
    enteredAt: Date.now(), tokens: [`${tag}-junk-tok-self`],
  }, null, 2) + "\n";
  fs.writeFileSync(KdFinalPath, selfJunkBytes);

  const topPendingFilename = pendingDivertFilenameForTest(top);
  const readInject = injectReadFailureAtCalls(KdFinalPath, [1, 3]);
  const renameInject = injectRenameFailsExcept(topPendingFilename);
  let topToken;
  try {
    topToken = enterMergeQuarantine(top, "top-branch-raise", `${tag}: TOP raises for the first time, absorbing F as a cross-tier sibling`);
  } finally {
    readInject.restore();
    renameInject.restore();
  }
  check(`(${tag} precondition) exactly 3 reads of Kd's own final were observed (matches the injection plan)`, readInject.count() === 3);
  check(`(${tag} precondition) at least one rename was forced to fail (F's own foreign-group write)`, renameInject.hits() >= 1);
  check(`*** WITNESS (${tag}) *** TOP's own divert write succeeded (its pending file exists, carrying its own token)`,
    (() => {
      const p = readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, topPendingFilename));
      return !!p && p.repoPath === top && new Set(p.tokens ?? []).has(topToken);
    })());

  const strandedTmps = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.includes(".json.tmp-"));
  check(`(${tag} precondition) a stranded tmp for F's foreign-group write exists on disk`, strandedTmps.length >= 1);
  let fTmpName = null;
  for (const n of strandedTmps) {
    const c = readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, n));
    if (c && c.repoPath === f) { fTmpName = n; break; }
  }
  check(`(${tag} precondition) the stranded tmp's content matches F, holding the union of fc+fd`,
    !!fTmpName && (() => {
      const c = readJsonIfExists(path.join(MERGE_QUARANTINE_DIR, fTmpName));
      return new Set(c.tokens ?? []).has(`${tag}-tok-fc`) && new Set(c.tokens ?? []).has(`${tag}-tok-fd`);
    })());

  const fLiveNow = activeMergeQuarantineFor(sF);
  check(`*** THE FIX (${tag}) *** the in-memory record now TRACKS the stranded tmp's basename in orphanLatchFiles`,
    !!fLiveNow && fTmpName !== null && (fLiveNow.orphanLatchFiles ?? []).includes(fTmpName));

  check(`(${tag} in-process) F is still blocked by fb/fc/fd right now (pre-clear)`, !!activeMergeQuarantineFor(f));

  // Full lift: clear every one of F's own tokens, PLUS TOP's own fresh raise token — F and TOP are
  // genuine cross-tier siblings (same physical repo, card 8a1bc2ef), so a query folds them together
  // (mirrors the 67136b71 test's own "sanity" clear, same reason).
  clearMergeQuarantineByToken(f, `${tag}-tok-fb`);
  clearMergeQuarantineByToken(f, `${tag}-tok-fc`);
  clearMergeQuarantineByToken(f, `${tag}-tok-fd`);
  clearMergeQuarantineByToken(top, topToken);
  try { fs.unlinkSync(KdFinalPath); } catch { /* pure scaffolding; best-effort */ }
  check(`(${tag} in-process) F is fully unblocked after clearing every known token`, !activeMergeQuarantineFor(f));

  // DoD item 1: no stray tmp remains on disk after the full lift, for EITHER ordering.
  const dirAfterLift = fs.readdirSync(MERGE_QUARANTINE_DIR);
  check(`*** THE FIX (${tag}) *** no stray tmp remains on disk after the full lift`,
    !dirAfterLift.some((n) => n.includes(".json.tmp-")));

  // DoD item 2 (the d2592cd5 interaction): only asserted for the "legacy" ordering — the one shape where
  // the stray genuinely withheld the tombstone pre-fix. The "hash" ordering's own LAST clear reaches the
  // tombstone decision through a different internal path (the stray there was already incidentally swept
  // by the UNRELATED hash-keyed sweeper even pre-fix, both before and after this card) and is not this
  // card's own claim to make either way — it is covered by the shared "unblocked after reboot" check below.
  const tombstonePath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
  const tombstoneContent = readJsonIfExists(tombstonePath);
  const tombstonedTokens = new Set(tombstoneContent && typeof tombstoneContent === "object" ? Object.keys(tombstoneContent) : []);
  if (tag === "legacy") {
    check(`*** THE FIX (${tag}) *** fb (never physically present in the stray tmp) IS durably tombstoned`,
      tombstonedTokens.has(`${tag}-tok-fb`));
    check(`*** THE FIX (${tag}) *** fc IS durably tombstoned`, tombstonedTokens.has(`${tag}-tok-fc`));
    check(`*** THE FIX (${tag}) *** fd IS durably tombstoned`, tombstonedTokens.has(`${tag}-tok-fd`));
  }

  const rebooted = await freshMergeQuarantineModule();
  rebooted.reenterMergeQuarantinesAtBoot([]);
  const fAfterBoot = rebooted.activeMergeQuarantineFor(f);
  check(`(${tag}) F is NOT fail-open after reboot (if blocked at all, it must be a real outstanding token)`,
    !fAfterBoot || (fAfterBoot.tokens ?? []).length > 0);
  check(`*** THE FIX (${tag}) *** F stays UNBLOCKED after a real reboot (never resurrected by the stray)`,
    !fAfterBoot);

  // Cleanup: leave nothing blocked past this scenario.
  if (fAfterBoot) for (const t of fAfterBoot.tokens ?? []) rebooted.clearMergeQuarantineByToken(f, t);
}

try {
  // SCENARIO "hash" — base = the dual-tracked twin (hash-tied to the identity's own final file); the
  // extra entry is YOUNGER (a small negative offset) so it never wins the `base` tie-break.
  await runScenario("hash", -50000);
  // SCENARIO "legacy" — base = the label-named extra entry (NOT hash-tied to anything a later clear
  // revisits); a large negative offset makes it OLDER than the twin's own effective enteredAt (~-100000).
  await runScenario("legacy", -200000);
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
