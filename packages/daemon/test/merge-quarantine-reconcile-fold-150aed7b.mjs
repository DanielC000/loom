import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 150aed7b — `reconcileMarkedBasenameBeforeWrite` (merge-quarantine.ts) used to fold ONLY `tokens`
// from a kept-unreadable on-disk latch, silently dropping the on-disk record's own scalar `resolvedKey`
// and plural `resolvedKeys`. Found by 43cf3b26's Code Review (46c5c492, gen 418), not probed until now.
//
// THE BUG (confirmed by this card's own hermetic investigate-first repro before any fix was written):
// Y is dual-armed at two secondary keys (W1, W2 — mirrors a cross-repo dual-arm, same fixture shape as
// `merge-quarantine-dual-key-persistence-43cf3b26.mjs`'s own "raise-after-boot-multi-key" scenario).
// Y's own final gets a READ FAILURE during a clear (a transient EACCES, same fault-injection technique
// as `merge-quarantine-protect-read-failure.mjs`) — the clear deletes Y's in-memory entry UNCONDITIONALLY
// before any protect call runs (per `63e49ee2`'s own documented ordering), the read failure means the
// physical file is kept on disk untouched and its basename is marked `keptUnreadableLatchFiles`. A FRESH
// raise on Y then reaches `writeMergeQuarantineLatch`'s own chokepoint for that marked basename, reads
// `final` successfully this time (no more injection), and — pre-fix — unions `tokens` only, discarding
// the file's own `resolvedKey`/`resolvedKeys` entirely. CONSEQUENCE: a reboot after this leaves W1 AND
// W2 both UNBLOCKED, even though they were genuinely, durably armed before the read failure — a fail-open.
//
// THE FIX: `reconcileMarkedBasenameBeforeWrite` now also folds the on-disk record's own
// `informativeKeysFor` (scalar ∪ plural, card 43cf3b26's own helper) into `entry.resolvedKeys` via the
// SAME `unionResolvedKeysRetaining` retention/cap/eviction-log every other writer in this module already
// uses — see docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md's own
// "Follow-up 150aed7b" section for the full design and why it cannot arm a key for a repo that was never
// quarantined (the function's pre-existing same-identity gate already restricts the fold to the SAME
// repoPath identity as the entry being written).
//
// SCENARIO "fold-survives-reboot" — the repro above, now asserting the FIXED behavior: W1 and W2 both
// stay blocked after the reboot that follows the read-failure-then-fresh-raise sequence.
// SCENARIO "human-clear-lifts-all" — continuing from scenario 1's own post-fold state (Y dual-armed again
// via the fold), a SUCCESSFUL human clear of Y (no injection) must lift Y, W1, AND W2 TOGETHER — no
// orphaned W1/W2 entry left armed, immediately and after a further reboot.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-reconcile-fold-150aed7b.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqrf150-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, activeMergeQuarantineFor, MERGE_QUARANTINE_DIR,
  enterMergeQuarantine, clearMergeQuarantineReporting,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqrf150@loom -c user.name=mqrf150";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqrf150-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "R.md"), `# merge-quarantine-reconcile-fold-150aed7b (${tag})\n`);
  execSync(`git init -q && git config user.email mqrf150@loom && git config user.name mqrf150`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}
function hashForKey(key) { return createHash("sha256").update(key).digest("hex").slice(0, 24); }
function writeLatchJson(hash, content) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hash}.json`), JSON.stringify(content, null, 2) + "\n");
}
function injectReadFailureOnce(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let count = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      count++;
      throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => count };
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

try {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO fold-survives-reboot
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  let y, finalPath, k1, k2, w1, w2, fresh;
  {
    y = makeRepo("y");
    const ky = canonicalRepoLockKey(y);
    const kyHash = hashForKey(ky);
    w1 = path.join(os.tmpdir(), `loom-mqrf150-w1-never-${freshSfx()}`);
    w2 = path.join(os.tmpdir(), `loom-mqrf150-w2-never-${freshSfx()}`);
    k1 = canonicalRepoLockKey(w1);
    k2 = canonicalRepoLockKey(w2);
    finalPath = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`);

    writeLatchJson(kyHash, {
      repoPath: y, branch: "y-branch-orig", reason: "Y's own genuine raise, dual-armed at W1 and W2",
      enteredAt: Date.now() - 60_000, tokens: ["y-token-orig"],
      resolvedKey: k1, resolvedKeys: [k1, k2], provenanceTracked: true,
    });

    reenterMergeQuarantinesAtBoot([]);
    check("(precondition) Y itself is blocked after boot", !!activeMergeQuarantineFor(y));
    check("(precondition) W1 is blocked after boot (via resolvedKeys)", !!activeMergeQuarantineFor(w1));
    check("(precondition) W2 is blocked after boot (via resolvedKeys)", !!activeMergeQuarantineFor(w2));

    const inject = injectReadFailureOnce(finalPath);
    let clearResult;
    try {
      clearResult = clearMergeQuarantineReporting(y);
    } finally {
      inject.restore();
    }
    check("(precondition) the read of Y's own final was actually attempted (and injected to fail)", inject.count() >= 1);
    check("(precondition) clear still reports wasQuarantined:true", clearResult?.wasQuarantined === true);
    check("(precondition) Y's own file survives the failed clear (kept, not deleted)", fs.existsSync(finalPath));
    check("(precondition) Y's own in-memory entry is gone immediately after the clear", !activeMergeQuarantineFor(y));

    const freshToken = enterMergeQuarantine(y, "y-branch-fresh", "fresh raise after the failed clear");
    check("(precondition) fresh raise reports Y blocked in-memory", !!activeMergeQuarantineFor(y));

    const onDiskAfterRaise = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    check("(precondition) old token survived the fold", (onDiskAfterRaise.tokens ?? []).includes("y-token-orig"));
    check("(precondition) fresh token present too", (onDiskAfterRaise.tokens ?? []).includes(freshToken));

    check("*** THE FIX *** on-disk resolvedKeys now carries BOTH secondary keys forward", Array.isArray(onDiskAfterRaise.resolvedKeys) && onDiskAfterRaise.resolvedKeys.includes(k1) && onDiskAfterRaise.resolvedKeys.includes(k2));

    fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([]);
    check("(fix) Y itself still blocked after reboot", !!fresh.activeMergeQuarantineFor(y));
    check("*** THE FIX *** W1 STAYS BLOCKED after reboot (was the fail-open)", !!fresh.activeMergeQuarantineFor(w1));
    check("*** THE FIX *** W2 STAYS BLOCKED after reboot (was the fail-open)", !!fresh.activeMergeQuarantineFor(w2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO human-clear-lifts-all — CR follow-up (150aed7b): this MUST clear on the POST-REBOOT module
  // (`fresh`, from scenario 1 above), where W1/W2 are GENUINELY armed via the fold-preserved resolvedKeys
  // (confirmed immediately below). Clearing on the ORIGINAL module instead (scenario 1's own
  // `enterMergeQuarantine(y)` call only ever arms Y's OWN key there, never W1/W2) made the "W1/W2 ALSO
  // unblocked" assertions vacuously true — they were never armed in that module to begin with, so the
  // scenario stayed green even with hunk (a) reverted. Driving it through `fresh` instead means W1/W2 are
  // asserted BLOCKED before the clear and UNBLOCKED after — a real armed-to-unarmed transition — so a
  // revert of (a) now correctly fails this scenario's own precondition (W1/W2 were never re-armed after
  // the reboot in the first place), not just the post-clear assertion.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    check("(precondition) Y is genuinely blocked on the post-reboot module", !!fresh.activeMergeQuarantineFor(y));
    check("(precondition) W1 is genuinely blocked on the post-reboot module", !!fresh.activeMergeQuarantineFor(w1));
    check("(precondition) W2 is genuinely blocked on the post-reboot module", !!fresh.activeMergeQuarantineFor(w2));

    const clearResult = fresh.clearMergeQuarantineReporting(y);
    check("(human clear) reports wasQuarantined:true", clearResult?.wasQuarantined === true);
    check("*** THE FIX *** Y itself is unblocked immediately", !fresh.activeMergeQuarantineFor(y));
    check("*** THE FIX *** W1 is ALSO unblocked immediately (no orphan)", !fresh.activeMergeQuarantineFor(w1));
    check("*** THE FIX *** W2 is ALSO unblocked immediately (no orphan)", !fresh.activeMergeQuarantineFor(w2));
    check("*** THE FIX *** Y's own final is gone too", !fs.existsSync(finalPath));
    check("*** THE FIX *** no orphaned physical file remains at W1's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k1)}.json`)));
    check("*** THE FIX *** no orphaned physical file remains at W2's own key", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`)));

    const fresh2 = await freshBootModule();
    fresh2.reenterMergeQuarantinesAtBoot([]);
    check("(human clear, reboot) Y does not resurrect", !fresh2.activeMergeQuarantineFor(y));
    check("(human clear, reboot) W1 does not resurrect", !fresh2.activeMergeQuarantineFor(w1));
    check("(human clear, reboot) W2 does not resurrect", !fresh2.activeMergeQuarantineFor(w2));
  }

  console.log(failures === 0
    ? "\n✅ ALL CHECKS PASS — card 150aed7b's own fix (fold on-disk informative keys, not just tokens) holds."
    : `\n❌ ${failures} CHECK(S) FAILED.`);
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
}

process.exit(failures === 0 ? 0 : 1);
