import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card d6670822 — a LEAD-only, unverified suspicion from Code Review 972343bd of d2582692:
// does `clearActiveEntryTokenAtKey`'s PARTIAL-token-clear write loop (merge-quarantine.ts, inside
// `clearMergeQuarantineByToken`'s multi-token branch — it calls `writeMergeQuarantineLatch` directly
// at each of D's own `armedKeysForEntry`) overwrite a DIFFERENT, foreign repo R's own final latch
// file, when R was previously evicted to `pendingUnresolvedQuarantines` with that exact file as its
// own INFERRED `sourceFile` (the `armKeyUnlessDegradedCollision` zero-remaining-keys branch's own
// `quarantinePathForKey(key)`-basename inference — see card d163aef5 round 3/6)?
//
// INVESTIGATED, NOT REPRODUCED. Two independent hermetic repros (own temp LOOM_HOME, no daemon boot,
// single lane) found the write is correctly REFUSED, both against the real
// `round3-degraded-walkup-to-resolvable-key` boot fixture (merge-quarantine-pass1-degraded-union-
// guard.mjs) widened to a multi-token D, and against the EXACT state the card describes, built
// directly via the TestOnly seams (`setActiveQuarantineTestOnly`/`pushPendingQuarantineTestOnly`) —
// this file keeps only the second, since the first never actually reaches
// `clearActiveEntryTokenAtKey` at all (D's degraded tmp-residue entry, whose `resolvedKey` is exactly
// its own tautological `currentKey` with no OTHER informative key, is deferred to a lazy re-resolve
// on first query rather than evicting R at boot — a different, already-covered mechanism; see
// `activeMergeQuarantineFor`'s own cross-tier-sibling absorb, card 8a1bc2ef).
//
// THE REASON IT'S REFUSED: `writeMergeQuarantineLatch` (called with `skipDegradedOccupantGuard:
// false` at this exact call site, never skipped) runs `wouldOverwriteDifferentUnresolvableOccupant`
// -> `differentUnresolvableOccupantRepoPathAt` unconditionally. That function is NOT a bare
// resolvability check — its own "0dc514dc Follow-up" comment (merge-quarantine.ts, just above the
// resolvable-skip branch) added a CONTENT-based override: when the on-disk occupant IS resolvable
// (R, here), it still protects the file whenever `survivingTokenHolderRepoPaths` finds a SURVIVING
// OTHER holder of one of the file's own on-disk tokens — and that scan covers BOTH
// `activeQuarantines` AND `pendingUnresolvedQuarantines` (merge-quarantine.ts ~:1179-1193). R's own
// evicted-to-pending record is exactly such a holder, so the write is refused, R's file survives
// byte-for-byte, and D's own reduced token set is simply left undurable at that key — the SAME
// already-documented, non-destructive "left PRE-EXISTING durable state UNTOUCHED... delays the
// eventual full lift; never a false lift" fallback this function's own `else` branch already logs.
//
// PINNED PER LEAD RULING (not closed outright): nothing in this repo's test corpus previously
// exercised this exact call site's guard — a future refactor that passes
// `skipDegradedOccupantGuard: true` here, or narrows `survivingTokenHolderRepoPaths` to the ACTIVE
// tier only (dropping the `pendingUnresolvedQuarantines` scan), would silently reopen exactly this
// shape with nothing to catch it. This file is that regression guard.
//
// SRC IS UNCHANGED BY THIS CARD — this is a TEST-ONLY commit; see the worker's own `done` report for
// the manual (uncommitted, reverted) RED/GREEN proof that flipped `skipDegradedOccupantGuard` to
// `true` at this one call site to confirm these assertions are not vacuous.
//
// NAMED RESIDUAL, NOT TESTED HERE: this guard's protection depends on R's own
// `pendingUnresolvedQuarantines` record's `tokens` field still matching what is physically on R's
// own final file. If some OTHER code path ever let those two diverge (R's in-memory pending tokens
// losing a token the file still carries durably, or vice versa), `survivingTokenHolderRepoPaths`
// would miss it and this same write could still destroy R's file. No such divergence mechanism was
// identified or attempted in this investigation — this is a named gap, not a reproduced one.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-d6670822-partial-clear-evicted-final-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqd6670822-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  listActiveMergeQuarantines, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
  clearMergeQuarantineByToken, assertRepoNotQuarantined,
  setActiveQuarantineTestOnly, pushPendingQuarantineTestOnly,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqd6670822@loom -c user.name=mqd6670822";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// A genuinely fresh ESM module instance per boot check — Node's loader keys its module cache on the
// full URL including the query string, so each call here gets its own instance of the SAME file,
// never reused (same technique as merge-quarantine-protect-write-failure.mjs's own freshBootModule).
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  // ---- positive control: prove this test's "did the file change" instrument can actually detect an
  // overwrite, before trusting any "unchanged" assertion below ----
  {
    const ctrlDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mqd6670822-ctrl-"));
    tmpDirs.push(ctrlDir);
    const ctrlFile = path.join(ctrlDir, "f.json");
    fs.writeFileSync(ctrlFile, JSON.stringify({ repoPath: "ctrl-before" }, null, 2) + "\n");
    const before = fs.readFileSync(ctrlFile, "utf8");
    fs.writeFileSync(ctrlFile, JSON.stringify({ repoPath: "ctrl-after" }, null, 2) + "\n");
    const after = fs.readFileSync(ctrlFile, "utf8");
    check("(positive control) instrument detects a direct overwrite of a file's content", before !== after && after.includes("ctrl-after"));
  }

  // ---- R: a real, resolvable, UNREGISTERED repo ----
  const r = path.join(os.tmpdir(), `loom-mqd6670822-r-${freshSfx()}`);
  fs.mkdirSync(r, { recursive: true });
  tmpDirs.push(r);
  fs.writeFileSync(path.join(r, "README.md"), "# merge-quarantine-d6670822 — R\n");
  execSync(`git init -q && git config user.email mqd6670822@loom && git config user.name mqd6670822`, { cwd: r });
  commitAll(r, "init", GIT_ID);

  const Kr = canonicalRepoLockKey(r);
  const KrHash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir"); // D's own repoPath — NEVER created
  check("(precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFinalPath = path.join(MERGE_QUARANTINE_DIR, `${KrHash}.json`);
  const rFinalBasename = path.basename(rFinalPath);
  const rEnteredAt = Date.now() - 30_000;
  const rOriginalContent = JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: rEnteredAt, tokens: ["r-token"],
  }, null, 2) + "\n";
  fs.writeFileSync(rFinalPath, rOriginalContent);

  // R's own in-memory record, evicted-to-pending — the EXACT shape `armKeyUnlessDegradedCollision`'s
  // zero-remaining-keys branch produces for a `prior` with NO tracked pending reference of its own:
  // pushed AS-IS, with its own real tokens, `sourceFile` INFERRED as `quarantinePathForKey(key)`'s
  // own basename (never a distinct, newly-written pending-divert file) — card d163aef5 round 3/6.
  const rEntry = {
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: rEnteredAt, tokens: ["r-token"],
  };
  pushPendingQuarantineTestOnly(rEntry, rFinalBasename);

  // D: active at K(R), MULTI-TOKEN — a partial clear of ONE token must route through
  // `clearActiveEntryTokenAtKey`'s multi-token `armedKeysForEntry` write loop, never the full-lift
  // `deleteMergeQuarantineLatchByKey` path (already hardened by d163aef5 rounds 4-6).
  const dEntry = {
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-1", "d-token-2"], resolvedKey: Kr, armedKeys: [Kr],
  };
  setActiveQuarantineTestOnly(Kr, dEntry);

  check("(precondition) assertRepoNotQuarantined(r) is BLOCKED before the clear", assertRepoNotQuarantined(r).ok === false);
  const contentBeforeClear = fs.readFileSync(rFinalPath, "utf8");
  check("(precondition) K(R)'s final file, right before the clear, still names R", JSON.parse(contentBeforeClear).repoPath === r);

  // ---- THE ACT UNDER TEST: a PARTIAL token clear of D — one of D's two tokens remains outstanding
  // afterward, so this must reach clearActiveEntryTokenAtKey's write loop, never the full-lift path.
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); realError(...args); };
  try {
    clearMergeQuarantineByToken(d, "d-token-1");
  } finally {
    console.error = realError;
  }

  // (a) the refusal log fires
  check("(a) the write-side refusal log names R's own path as the protected occupant",
    lines.some((l) => l.includes("refusing to write") && l.includes(r) && l.includes("exclusive backing")));
  // (d), first half — the "left UNTOUCHED / never a false lift" fallback also fired
  check("(d, part 1) the 'could not durably persist... never a false lift' fallback log fired",
    lines.some((l) => l.includes("could not durably persist the reduced token set") && l.includes("never a false lift")));

  // (b) K(R)'s file is byte-identical before/after
  const contentAfterClear = fs.readFileSync(rFinalPath, "utf8");
  check("(b) K(R)'s final file is byte-identical before and after the partial clear", contentAfterClear === contentBeforeClear);
  check("(b, sanity) K(R)'s final file still names R, never D", JSON.parse(contentAfterClear).repoPath === r);

  // (c) assertRepoNotQuarantined(R) still blocks, in-process AND after a fresh boot reconcile
  check("(c, in-process) assertRepoNotQuarantined(r) still BLOCKS right after the partial clear", assertRepoNotQuarantined(r).ok === false);
  const freshMod = await freshBootModule();
  freshMod.reenterMergeQuarantinesAtBoot([]);
  const tokensAfterReboot = new Set(freshMod.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? []));
  check("(c, reboot) r-token survives a fresh boot reconcile", tokensAfterReboot.has("r-token"));
  check("(c, reboot) assertRepoNotQuarantined(r) still BLOCKS after a fresh boot reconcile", freshMod.assertRepoNotQuarantined(r).ok === false);

  // (d), second half — D's own in-memory set is reduced to [d-token-2] (the in-memory
  // `replaceEntryEverywhere` already ran before the write loop, independent of the write's own
  // success/failure at K(R)) even though the durable write for it failed.
  const dListing = listActiveMergeQuarantines().find((q) => {
    try { return canonicalRepoLockKey(q.repoPath) === Kr && q.repoPath === d; } catch { return false; }
  });
  check("(d, part 2) D's own in-memory token set is reduced to exactly [d-token-2]",
    !!dListing && Array.isArray(dListing.tokens) && dListing.tokens.length === 1 && dListing.tokens[0] === "d-token-2");
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — clearActiveEntryTokenAtKey's partial-clear write loop is correctly REFUSED by " +
    "writeMergeQuarantineLatch's own content-based occupant guard when it would overwrite a " +
    "different, evicted-to-pending repo's own final latch file; that repo's enforcement survives " +
    "in-process and across a fresh boot reconcile, and the clearing entry's own in-memory token set " +
    "is still reduced even though the durable write was refused."
  : `\n❌ ${failures} FAILURE(S) — reproduces board card d6670822.`);
process.exit(failures === 0 ? 0 : 1);
