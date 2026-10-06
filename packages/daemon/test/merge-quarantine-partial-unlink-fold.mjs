import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 8a1bc2ef (from Code Reviewer 638ee0bc's review of 188b145f, item 2) — N-FILE PARTIAL UNLINK.
//
// `consumeMatchedPendingsIntoArmedEntry`'s SUCCESS branch (git/merge-quarantine.ts) deletes every matched
// pending entry's own stale `sourceFile` via `deleteSourceLatchIfSuperseded` — but that call swallowed
// unlink errors (EBUSY) silently. If it failed on 1-of-N files during graduation, that stale file was
// left on disk, UNTRACKED by anything (not folded into the armed entry's own `orphanLatchFiles` — only
// the WHOLE-WRITE failure branch did that folding). A human `clear-by-id` on the real/fresh hash reports
// success but never sweeps it (nothing names it); the NEXT boot then finds this still-cleanly-parsing
// leftover file and RE-ARMS the quarantine the human just cleared — fail-closed, same class be79f4d5/
// 9cabd143 exist to close, reached through a FOURTH shape (a per-file unlink failure on an otherwise-
// successful write, rather than a whole-write failure).
//
// THE FIX: `deleteSourceLatchIfSuperseded` now reports success/failure (ENOENT counts as success — a
// file already gone is not a problem). Any genuine failure is folded into the armed entry's own
// `orphanLatchFiles` and the entry is RE-PERSISTED, exactly mirroring the whole-write failure branch's
// own fold — so a clear-by-id on an UNRELATED stale hash now correctly KEEPS the surviving file (it's
// referenced), while clearing the REAL entry now correctly SWEEPS it away too — closing the fail-closed
// reboot directly, rather than leaving it to resurrect the quarantine a human just cleared.
//
// SCENARIO 1 (THE BUG, N=2, one unlink injected to fail) proves the fold+re-persist fix: the surviving
// tmp is folded into `orphanLatchFiles`; a clear-by-id on an UNRELATED stale hash KEEPS it (reports
// `latchKept`); clearing the REAL entry sweeps it away too; and a fresh-module restart after that
// legitimate clear finds NOTHING (no resurrection).
// SCENARIO 2 is a NEGATIVE CONTROL: the SAME N=2 shape with NO injected failure must behave exactly as
// before — both stale files deleted, nothing folded, a legitimate clear leaves nothing behind.
//
// See docs/decisions/8a1bc2ef-cross-tier-sibling-pending-absorb.md and
// docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md (the sibling single-failure-branch
// ownership rule this generalizes to a per-file SUCCESS-branch failure).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-partial-unlink-fold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqpuf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineLatchFile, activeMergeQuarantineFor,
  reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqpuf@loom -c user.name=mqpuf";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeSubdirRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqpuf-repo-${tag}-${freshSfx()}`);
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-partial-unlink-fold (${tag})\n`);
  execSync(`git init -q && git config user.email mqpuf@loom && git config user.name mqpuf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return subdir;
}

function moveRepoRootAway(subdir, parkedRoot) { fs.renameSync(subdir.replace(/[\\/]teamA$/, ""), parkedRoot); }
function moveRepoRootBack(subdir, parkedRoot) { fs.renameSync(parkedRoot, subdir.replace(/[\\/]teamA$/, "")); }

// Injects an EBUSY failure on exactly ONE named tmp file's own unlink — every other unlinkSync call
// (including the OTHER matched tmp's own, legitimate delete) passes through untouched.
function injectPartialUnlinkFailure(targetBasename) {
  const realUnlinkSync = fs.unlinkSync;
  const counter = { hitCount: 0 };
  fs.unlinkSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(targetBasename)) {
      counter.hitCount++;
      throw Object.assign(new Error("EBUSY: simulated partial-unlink failure"), { code: "EBUSY" });
    }
    return realUnlinkSync(p, ...rest);
  };
  return { counter, restore: () => { fs.unlinkSync = realUnlinkSync; } };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 (THE BUG) — two same-hash pending tmps for ONE repo. The graduation WRITE succeeds, but
  // the unlink for ONE of the two (tmp2) is injected to fail (EBUSY). THE FIX: tmp2 must be folded into
  // the armed entry's own `orphanLatchFiles` and the entry re-persisted — a clear-by-id on the fresh hash
  // must KEEP tmp2 (never silently miss it), and a restart must recover the SAME quarantine from it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s1");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-616161`;
  const tmp2Name = `${staleHash}.json.tmp-626262`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s1-tmp1-branch", reason: "s1 tmp1 — its own unlink succeeds normally",
    enteredAt: Date.now() - 60_000, tokens: ["s1-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s1-tmp2-branch", reason: "s1 tmp2 — its own unlink is injected to FAIL (EBUSY)",
    enteredAt: Date.now(), tokens: ["s1-tmp2-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqpuf-parked-s1-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const inject = injectPartialUnlinkFailure(tmp2Name);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY — write succeeds, ONE unlink fails
  } finally {
    inject.restore();
  }
  check("(s1 graduation) the injected unlink was actually hit exactly once", inject.counter.hitCount === 1);
  check("(s1 graduation) the fresh write succeeded (write and per-file unlink are independent steps)", fs.existsSync(freshLatchPath));
  check("(s1 graduation) both tokens are present on the graduated entry", (activeAfterGraduation?.tokens ?? []).includes("s1-tmp1-token") && (activeAfterGraduation?.tokens ?? []).includes("s1-tmp2-token"));
  check("(s1 graduation) tmp1 (unlink succeeded) is gone", !fs.existsSync(tmp1Path));
  check("(s1 graduation) tmp2 (unlink FAILED) is still on disk right after graduation", fs.existsSync(tmp2Path));
  check("(s1 graduation) THE FIX: tmp2 is folded into the graduated entry's own orphanLatchFiles", (activeAfterGraduation?.orphanLatchFiles ?? []).includes(tmp2Name));
  const persistedAfterGraduation = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s1 graduation) THE FIX: the PERSISTED file also lists tmp2 (re-persisted, not just in-memory)", (persistedAfterGraduation.orphanLatchFiles ?? []).includes(tmp2Name));

  // A clear-by-id on the STALE hash (NOT the real entry's own current key) must KEEP tmp2 — it's still
  // referenced by the real, surviving entry's own orphanLatchFiles, so this id-mismatched clear must
  // never delete out from under the entry that still needs it.
  const staleClearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s1 clear-by-id on STALE hash) call succeeds", staleClearResult.ok === true);
  check("(s1 clear-by-id on STALE hash) wasQuarantined===false — the stale hash matches no entry of its own any more", staleClearResult.wasQuarantined === false);
  check("(s1 clear-by-id on STALE hash) THE FIX: tmp2 is reported KEPT (still referenced by the real entry)", staleClearResult.latchKept === true);
  check("(s1 clear-by-id on STALE hash) tmp2 survives this id-mismatched clear", fs.existsSync(tmp2Path));

  // THE ACTUAL BUG / FIX TARGET: a human clear-by-id on the REAL, FRESH hash — the ordinary, LEGITIMATE
  // clear a human would actually issue once they see this repo quarantined — must now SWEEP tmp2 away as
  // part of clearing the real entry (now that it's tracked in that entry's own orphanLatchFiles), rather
  // than silently leaving it behind for the next boot to resurrect from. THE BUG THIS PREVENTS: pre-fix,
  // tmp2 was never tracked anywhere, so this exact clear left it untouched, and the next boot found it
  // still cleanly parsing and RE-ARMED the quarantine this human clear just lifted — fail-closed.
  const clearResult = clearMergeQuarantineLatchFile(freshHash);
  check("(s1 human clear on fresh hash) call succeeds", clearResult.ok === true);
  check("(s1 human clear on fresh hash) wasQuarantined===true — the real entry WAS cleared", clearResult.wasQuarantined === true);
  check("(s1 human clear on fresh hash) THE FIX: tmp2 is swept away as part of clearing the entry that owns it", !fs.existsSync(tmp2Path));
  check("(s1 human clear on fresh hash) the fresh final is also gone", !fs.existsSync(freshLatchPath));

  // RESTART ASSERTION — THE REGRESSION THIS PREVENTS: a fresh boot must find NOTHING for this repo. Pre-
  // fix, tmp2 would still be sitting on disk here (never swept by the clear above), and this exact boot
  // would re-arm the quarantine the human just cleared.
  const fresh1 = await freshBootModule();
  fresh1.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s1 restart) THE REGRESSION THIS PREVENTS: no resurrection after a legitimate clear", !fresh1.activeMergeQuarantineFor(subdir));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — NEGATIVE CONTROL: the SAME N=2 shape, but with NO injected unlink failure. Both stale
  // tmps must be deleted exactly as before (nothing folded, nothing kept) — proves scenario 1's own
  // assertions are not vacuously satisfied by an instrument that would ALSO fire on ordinary success.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s2");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-636363`;
  const tmp2Name = `${staleHash}.json.tmp-646464`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s2-tmp1-branch", reason: "s2 tmp1 — no injected failure, ordinary success",
    enteredAt: Date.now() - 60_000, tokens: ["s2-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s2-tmp2-branch", reason: "s2 tmp2 — no injected failure, ordinary success",
    enteredAt: Date.now(), tokens: ["s2-tmp2-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqpuf-parked-s2-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const activeAfterGraduation = activeMergeQuarantineFor(subdir); // NO fault injected this time
  check("(s2 negative control) the repo reads as quarantined with both tokens", (activeAfterGraduation?.tokens ?? []).includes("s2-tmp1-token") && (activeAfterGraduation?.tokens ?? []).includes("s2-tmp2-token"));
  check("(s2 negative control) BOTH tmps were deleted — no injected failure, nothing to fold", !fs.existsSync(tmp1Path) && !fs.existsSync(tmp2Path));
  check("(s2 negative control) NOTHING is folded into orphanLatchFiles", !(activeAfterGraduation?.orphanLatchFiles ?? []).length);
  check("(s2 negative control) a fresh latch was durably written", fs.existsSync(freshLatchPath));

  const clearResult = clearMergeQuarantineLatchFile(freshHash);
  check("(s2 negative control) clear-by-id succeeds and reports nothing kept", clearResult.ok === true && !clearResult.latchKept);

  const fresh2 = await freshBootModule();
  fresh2.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s2 negative control, restart) NO RESURRECTION after a genuine clear", !fresh2.activeMergeQuarantineFor(subdir));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 (round 2, Code Review MINOR) — scenario 1's own restart assertion was WEAKENED by its own
  // earlier stale-hash clear: that clear already deletes tmp2 as a side effect of a DIFFERENT assertion
  // (the id-mismatched-clear-KEEPS-it check runs, but scenario 1 never re-creates tmp2 afterward), so by
  // the time scenario 1 clears the FRESH hash and restarts, tmp2 is ALREADY gone — the restart assertion
  // there passes regardless of whether the fix's fold-and-sweep logic ever ran. This scenario isolates the
  // exact sequence the card's own fail-closed narrative describes: graduate (one unlink injected to fail),
  // clear the FRESH hash DIRECTLY — no stale-hash clear in between — then restart. On the pre-fix code,
  // this must go RED (tmp2 untracked, clear never sweeps it, a restart re-arms the just-cleared quarantine).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s3");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-656565`;
  const tmp2Name = `${staleHash}.json.tmp-666666`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s3-tmp1-branch", reason: "s3 tmp1 — its own unlink succeeds normally",
    enteredAt: Date.now() - 60_000, tokens: ["s3-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s3-tmp2-branch", reason: "s3 tmp2 — its own unlink is injected to FAIL (EBUSY)",
    enteredAt: Date.now(), tokens: ["s3-tmp2-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqpuf-parked-s3-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const inject = injectPartialUnlinkFailure(tmp2Name);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY — write succeeds, ONE unlink fails
  } finally {
    inject.restore();
  }
  check("(s3 graduation) the injected unlink was actually hit exactly once", inject.counter.hitCount === 1);
  check("(s3 graduation) tmp2 (unlink FAILED) is still on disk right after graduation", fs.existsSync(tmp2Path));
  check("(s3 graduation) both tokens are present on the graduated entry", (activeAfterGraduation?.tokens ?? []).includes("s3-tmp1-token") && (activeAfterGraduation?.tokens ?? []).includes("s3-tmp2-token"));

  // NO stale-hash clear here — go STRAIGHT to clearing the real, fresh hash, exactly as a human would.
  const clearResult = clearMergeQuarantineLatchFile(freshHash);
  check("(s3 human clear on fresh hash, no prior stale clear) call succeeds", clearResult.ok === true);
  check("(s3 human clear on fresh hash, no prior stale clear) wasQuarantined===true", clearResult.wasQuarantined === true);
  check("(s3 human clear on fresh hash, no prior stale clear) THE FIX: tmp2 is swept away too", !fs.existsSync(tmp2Path));
  check("(s3 human clear on fresh hash, no prior stale clear) the fresh final is also gone", !fs.existsSync(freshLatchPath));

  // RESTART ASSERTION — THE REGRESSION THIS PREVENTS, isolated from scenario 1's own earlier stale-hash
  // clear: a fresh boot must find NOTHING for this repo.
  const fresh3 = await freshBootModule();
  fresh3.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s3 restart) THE REGRESSION THIS PREVENTS: no resurrection after a legitimate clear, no prior stale clear involved", !fresh3.activeMergeQuarantineFor(subdir));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — consumeMatchedPendingsIntoArmedEntry's SUCCESS branch now folds any per-file unlink "
    + "failure into the graduated entry's own orphanLatchFiles and re-persists it, exactly like the "
    + "whole-write FAILURE branch already did — a clear-by-id on an UNRELATED stale hash correctly KEEPS "
    + "the surviving file (still referenced), while clearing the REAL entry now correctly SWEEPS it away "
    + "too, closing the fail-closed resurrection a legitimate clear used to leave behind."
  : `\n❌ ${failures} FAILURE(S) — reproduces board card 8a1bc2ef, item 2.`);
process.exit(failures === 0 ? 0 : 1);
