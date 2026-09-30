import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — TOKEN SET (round 7, card 24c0bdba, Code Review M1).
//
// THE BUG (round 6 review of f7ddc8e1): the quarantine map held ONE token per repo — a second raise on an
// ALREADY-quarantined repo OVERWROTE the first raise's own token. A LATER raiser's confirmed-dead auto-clear
// then lifted the WHOLE repo while an EARLIER raiser's own orphan was STILL genuinely unconfirmed — silently
// un-protecting a repo that was still dangerous. Reachable in practice: `merge_batch`'s own assembly runs
// UNLOCKED and only checks quarantine at its own entry (never inside `withCanonicalIndexLock`), so it can
// raise its own quarantine on a repo whose solo-merge quarantine is ALREADY live, landing exactly this race.
//
// THE FIX: the entry holds a SET of outstanding tokens (`MergeQuarantineEntry.tokens: string[]`).
// `enterMergeQuarantine` APPENDS to that set rather than overwriting it. `clearMergeQuarantineByToken`
// removes ONLY its own token; the repo is lifted ONLY once the set is EMPTY.
//
// THIS FILE drives the EXACT primitive repro the round-7 review specified, directly against
// git/merge-quarantine.ts — no git, no worktrees, no daemon:
//   ta = enter(A); tb = enter(B); clearByToken(ta) → KEEPS the quarantine (correct, always was);
//   clearByToken(tb) → LIFTS the quarantine (correct after the fix; WRONG — lifted too — before it).
// Verified RED against the pre-round-7 `merge-quarantine.ts` (commit f7ddc8e1) and GREEN after the fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-token-set.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqts-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const {
  enterMergeQuarantine, clearMergeQuarantineByToken, clearMergeQuarantine, activeMergeQuarantineFor,
} = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE EXACT PRIMITIVE REPRO, verbatim from the round-7 review
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    // A fake repo path — this module never touches git or the filesystem for the repoPath itself (only
    // for ITS OWN latch file under LOOM_HOME), so a real repo checkout is unnecessary for this primitive.
    const repo = path.join(os.tmpdir(), `loom-mqts-fake-repo-${sfx}`);

    const ta = enterMergeQuarantine(repo, "branch-A", "raise A — a solo merge's own unconfirmed kill");
    check("precondition: repo reads as quarantined after the FIRST raise", !!activeMergeQuarantineFor(repo));
    check("enterMergeQuarantine returns a real token string", typeof ta === "string" && ta.length > 0);

    const tb = enterMergeQuarantine(repo, "branch-B", "raise B — an UNRELATED batch assembly's own unconfirmed kill, landing while A is still live");
    check("precondition: repo STILL reads as quarantined after the SECOND raise", !!activeMergeQuarantineFor(repo));
    check("the two raises minted DIFFERENT tokens", ta !== tb);
    check("M1 FIX: the entry's token SET holds BOTH outstanding tokens (not just the latest)", activeMergeQuarantineFor(repo)?.tokens?.includes(ta) && activeMergeQuarantineFor(repo)?.tokens?.includes(tb));

    // Step 1: A's own confirmed-dead settlement arrives FIRST (the common case — A raised first, so its
    // own eventual confirmation is not guaranteed to arrive first, but this exercises that ordering).
    clearMergeQuarantineByToken(repo, ta);
    check(
      "clearByToken(ta) KEEPS the quarantine — B's own raise is STILL a live, unconfirmed threat (this was ALWAYS correct, both before and after the fix)",
      !!activeMergeQuarantineFor(repo),
    );
    check("after clearByToken(ta), the set no longer contains ta but STILL contains tb", !activeMergeQuarantineFor(repo)?.tokens?.includes(ta) && activeMergeQuarantineFor(repo)?.tokens?.includes(tb));

    // Step 2: THE BUG ITSELF. B's own confirmed-dead settlement arrives.
    clearMergeQuarantineByToken(repo, tb);
    check(
      "M1 FIX: clearByToken(tb) LIFTS the quarantine — it was the LAST outstanding token, so both raises are now genuinely resolved",
      !activeMergeQuarantineFor(repo),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // NEGATIVE CONTROL — the REVERSE clear order must ALSO only lift once BOTH are cleared (proves the fix
  // is genuinely SET-based, not merely "the second call always wins" by some other accident of ordering).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = path.join(os.tmpdir(), `loom-mqts-fake-repo-reverse-${sfx}`);
    const ta = enterMergeQuarantine(repo, "branch-A", "raise A");
    const tb = enterMergeQuarantine(repo, "branch-B", "raise B");

    clearMergeQuarantineByToken(repo, tb); // clear the SECOND raise's token FIRST this time
    check("(reverse order) clearByToken(tb) FIRST keeps the quarantine — ta is still outstanding", !!activeMergeQuarantineFor(repo));
    clearMergeQuarantineByToken(repo, ta); // now clear the FIRST raise's token
    check("(reverse order) clearByToken(ta) SECOND lifts it — order of clearing does not matter, only completeness", !activeMergeQuarantineFor(repo));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // A token NOT in the set is a silent no-op, regardless of set size — an unrelated/forged/already-used
  // token must never clear (or otherwise disturb) a real outstanding quarantine.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = path.join(os.tmpdir(), `loom-mqts-fake-repo-noise-${sfx}`);
    const ta = enterMergeQuarantine(repo, "branch-A", "raise A");
    clearMergeQuarantineByToken(repo, "not-a-real-token-" + sfx);
    check("an unrecognized token is a silent no-op (still quarantined)", !!activeMergeQuarantineFor(repo));
    check("the real token's own entry is UNCHANGED by the bogus clear attempt", activeMergeQuarantineFor(repo)?.tokens?.length === 1 && activeMergeQuarantineFor(repo)?.tokens?.[0] === ta);
    clearMergeQuarantine(repo); // cleanup via the unconditional human route
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Idempotence: clearing the SAME token twice is a silent no-op the second time (the set no longer
  // contains it), never a crash and never a spurious re-lift of an already-cleared repo.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = path.join(os.tmpdir(), `loom-mqts-fake-repo-idempotent-${sfx}`);
    const ta = enterMergeQuarantine(repo, "branch-A", "raise A");
    clearMergeQuarantineByToken(repo, ta);
    check("(idempotent) single-raise clear lifts it", !activeMergeQuarantineFor(repo));
    clearMergeQuarantineByToken(repo, ta); // same token again, now stale
    check("(idempotent) clearing the SAME (now-stale) token again is a silent no-op, not a crash", !activeMergeQuarantineFor(repo));
  }
} finally {
  // No filesystem fixtures of our own beyond LOOM_HOME's own quarantine-latch dir (owned by
  // useOwnLoomHome's cleanup) — this primitive never creates a real repo checkout.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the outstanding-token SET correctly requires EVERY raise on a repo to be individually " +
    "cleared before the quarantine lifts (M1 closed): a later raiser's own confirmed-dead settlement can " +
    "no longer prematurely lift an earlier, still-unconfirmed raiser's protection."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
