import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7673d096, Code Review BLOCKING finding 1 — a subdir-bound path that is MISSING at boot (real
// case: an Obsidian vault on an unmounted or cloud drive) made `reenterMergeQuarantinesAtBoot`'s PASS 1
// FAIL OPEN. `resolveGitToplevelSync`/`canonicalRepoLockKey` computed a DIFFERENT key for a repoPath that
// does not currently resolve on disk (falling back to a literal/degenerate value rather than the real
// toplevel), so a CORRECT, toplevel-keyed latch read back a "stale key" mismatch against that degenerate
// key — and PASS 1 used to migrate unconditionally: it wrote the entry under the WRONG (degenerate) key
// and DELETED the correct, original file. Once the drive remounts, every later check computes the REAL
// toplevel key again, finds NOTHING at that key (the correct file is gone, the entry only lives under the
// wrong key from that one boot), and the quarantine is silently unenforced for the rest of that boot.
//
// THE FIX: PASS 1 now gates migration on `isRepoPathCurrentlyResolvable(entry.repoPath)` — never migrates
// (never deletes the original file) when the registered path itself can't currently be verified. It also
// records `resolvedKey` (the exact key the entry was raised under) in the latch's own content, and arms the
// in-memory map under BOTH the current (possibly degraded) key and `resolvedKey` — so enforcement holds
// before, during, AND after the path becomes resolvable again within the SAME boot.
//
// This file reproduces the real scenario: the registered repo is a SUBDIRECTORY with no `.git` of its own
// (so its latch is genuinely keyed on the TOPLEVEL). The entire physical repo (subdir AND toplevel) is
// temporarily moved away — the one shape that actually produces a degenerate/unverifiable key, since
// `resolveGitToplevelSync`'s own nearest-existing-ancestor walk already tolerates the LEAF alone being
// absent (see test/repo-lock-subdir-toplevel.mjs) — boot re-entry runs while it's gone, the repo is moved
// back, and BOTH the subdir path and the toplevel path must then read as refused.
//
// RED on a4198110 (verified manually during development: reverted repo-lock.ts/merge-quarantine.ts to that
// commit, rebuilt, re-ran this file — the original file was deleted at boot and `assertRepoNotQuarantined`
// for both paths wrongly returned `{ok:true}` once the repo was moved back) — GREEN once gated on
// `isRepoPathCurrentlyResolvable`.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-unresolvable-path.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqup-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  enterMergeQuarantine, activeMergeQuarantineFor, assertRepoNotQuarantined, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
} = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqup@loom -c user.name=mqup";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

try {
  const parkedRoot = path.join(os.tmpdir(), `loom-mqup-parked-${sfx}`);
  const repo = path.join(os.tmpdir(), `loom-mqup-repo-${sfx}`);
  const subdir = path.join(repo, "teamA"); // no .git of its own — a subdir-bound project specimen
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(subdir, "a.txt"), "team a\n");
  execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  // Raise a REAL quarantine via the real entry point — this is the "correct, toplevel-keyed latch" the
  // bug destroys. At this moment the repo is fully present, so this writes under the TRUE toplevel key.
  enterMergeQuarantine(subdir, "real-branch", "a genuine unconfirmed-kill raise, filed while the repo is fully present");
  check("(precondition) the subdir reads as quarantined while the repo is present", !!activeMergeQuarantineFor(subdir));

  const latchFiles = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json"));
  const latchPath = latchFiles
    .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
    .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === subdir; } catch { return false; } });
  check("(precondition) exactly one real latch file exists for the subdir", !!latchPath);
  const originalContent = fs.readFileSync(latchPath, "utf8");
  check("(precondition) the real latch carries a resolvedKey (the toplevel key it was raised under)", JSON.parse(originalContent).resolvedKey);

  // Move the ENTIRE physical repo away — simulating an unmounted/disconnected drive. This is the one shape
  // that genuinely produces a degenerate key: the nearest-existing-ancestor walk tolerates the SUBDIR alone
  // being missing (the toplevel's own .git would still be found), but here the toplevel is gone too.
  fs.renameSync(repo, parkedRoot);
  check("(moved away) the subdir no longer resolves on disk", !fs.existsSync(subdir));

  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(moved away) boot re-entry still reports this repo's quarantine", found.some((q) => q.repoPath === subdir));
  check("(moved away) THE BLOCKING BUG: the original latch file is NOT deleted (no destructive migration on an unverifiable key)", fs.existsSync(latchPath));
  check("(moved away) the preserved file's content is UNCHANGED (not rewritten under a degraded key)", fs.readFileSync(latchPath, "utf8") === originalContent);
  check("(moved away) enforcement still holds for the subdir path even while the repo is gone", !assertRepoNotQuarantined(subdir).ok);

  // Restore the repo to its original location — simulating the drive remounting, LATER in the SAME boot.
  fs.renameSync(parkedRoot, repo);
  check("(restored) the subdir resolves on disk again", fs.existsSync(subdir));

  const subdirCheck = assertRepoNotQuarantined(subdir);
  const rootCheck = assertRepoNotQuarantined(repo);
  check("(restored) THE BLOCKING BUG: the SUBDIR path is still refused once the repo is back (not silently unenforced)", !subdirCheck.ok);
  check("(restored) THE BLOCKING BUG: the TOPLEVEL/root path is ALSO refused (same physical repo, same quarantine)", !rootCheck.ok);
  check("(restored) the refusal still names the real reason (not a fabricated boot placeholder)", /genuine unconfirmed-kill raise/i.test(subdirCheck.reason ?? ""));
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a quarantine latch for a repo that is temporarily UNRESOLVABLE at boot (an unmounted " +
    "drive) is neither destroyed nor silently unenforced: the original file survives, and both the subdir " +
    "and the toplevel path read as refused once the repo is reachable again, within the same boot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
