// Card `6e6b342d` (finding b, single-token clobber): the vault-pause lease used to be ONE overwritable
// `{token, until}` file — a second concurrent pauser silently clobbered the first's entry, so op A's
// resume (or a later clobbering pause) could end up leaving op B with no protection even though B is
// still mid-surgery. The fix makes the lease a multi-holder SET: each pause adds its own entry, and a
// resume removes ONLY the entry carrying its own token.
//
// This test proves the multi-holder property BOTH ways: data-level (reading the lease file directly, to
// prove a foreign holder's own entry survives byte-for-byte — not just "isPaused stayed true by
// coincidence") AND behaviorally (a real VaultVersioner's commit() tick still skips), on the CARD'S OWN
// literal clobber sequence — the LATER pauser resuming FIRST (round 2, Code Review Minor 2: the earlier
// version of this file's own "reverse order" block didn't actually reverse the pause/resume order
// relative to the first block above, so it re-tested the SAME 237d1899 property under a different name;
// vault-pause-lease.mjs's own test 8 already covers that direction — earlier pauser resumes first, later
// survives).
//
// NEGATIVE CONTROL (per CLAUDE.md's `negative-control` tool): reverting versioner.ts's
// pauseVaultAutoCommit/resumeVaultAutoCommit to the pre-`6e6b342d` single-overwrite shape makes this test
// fail RED — op B's pause would overwrite op A's entry entirely (no multi-entry array to survive in), so
// "A's entry survives B's resume" has nothing left to find.
//
// Run: 1) build daemon (pnpm build), 2) node test/vault-pause-lease-multi-holder.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VaultVersioner, pauseVaultAutoCommit, resumeVaultAutoCommit } from "../dist/vault/versioner.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(mkdtempManaged("loom-vpl-multi-"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
git("init");
git("config", "user.email", "loom-test@example.com");
git("config", "user.name", "loom-test");
git("commit", "--allow-empty", "-m", "init");

const leasePath = path.join(root, ".git", "loom-vault-pause.json");

// Two concurrent holders, same repo — op A, then op B "arrives" while A's lease is still held.
const tokenA = pauseVaultAutoCommit(root, 60_000);
const tokenB = pauseVaultAutoCommit(root, 60_000);

const afterBothPaused = JSON.parse(fs.readFileSync(leasePath, "utf8"));
check(
  "both holders' own entries are present after both have paused (never overwritten each other)",
  Array.isArray(afterBothPaused?.leases) &&
    afterBothPaused.leases.length === 2 &&
    afterBothPaused.leases.some((e) => e.token === tokenA) &&
    afterBothPaused.leases.some((e) => e.token === tokenB),
);

// A finishes first — its resume must remove ONLY its own entry, never B's.
resumeVaultAutoCommit(root, tokenA);
check("the lease file still exists after A's resume (B's entry survives)", fs.existsSync(leasePath));
const afterAResumed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
check(
  "A's own entry is gone, B's own entry survives BYTE-FOR-BYTE (same token, same until) after A's resume",
  Array.isArray(afterAResumed?.leases) &&
    afterAResumed.leases.length === 1 &&
    !afterAResumed.leases.some((e) => e.token === tokenA) &&
    afterAResumed.leases.some((e) => e.token === tokenB && e.until === afterBothPaused.leases.find((x) => x.token === tokenB).until),
);

// B finishes — its own resume clears the whole set (nothing left).
resumeVaultAutoCommit(root, tokenB);
check("after B's own resume, the lease file is gone entirely (no holders left)", !fs.existsSync(leasePath));

// THE CARD'S OWN CLOBBER SEQUENCE, exactly (finding b's literal scenario): M pauses first (the merge),
// P pauses LATER while M's lease is still held (the push) — overwriting the file under the pre-6e6b342d
// single-entry design — and P (the LATER pauser) resumes FIRST, finishing before M does. Pre-fix, P's
// resume matched the file's then-current (P's own) token and deleted it outright, wiping out M's
// protection even though M was still mid-surgery. Post-fix, M's entry must survive P's resume.
const tokenM = pauseVaultAutoCommit(root, 60_000);
const tokenP = pauseVaultAutoCommit(root, 60_000); // P arrives LATER, while M's lease is still held
resumeVaultAutoCommit(root, tokenP); // P (the LATER pauser) finishes FIRST
const afterPResumed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
check(
  "the clobber sequence (M pauses, P pauses later, P resumes first): M's (the EARLIER pauser's) entry survives P's resume — the exact scenario finding (b) described",
  Array.isArray(afterPResumed?.leases) &&
    afterPResumed.leases.length === 1 &&
    afterPResumed.leases.some((e) => e.token === tokenM),
);

// BEHAVIORAL corroboration, not just a file read: a real VaultVersioner tick must still treat the repo
// as paused — M's survived entry alone must still gate it.
const versioner = new VaultVersioner(root, 5000);
await versioner.start();
fs.writeFileSync(path.join(root, "edit-during-clobber-sequence.md"), "# edit\n");
await versioner.commit();
check(
  "behaviorally: VaultVersioner.commit() STILL skips after P's resume — M's surviving entry alone gates the tick (still only the init commit)",
  git("log", "--oneline").trim().split("\n").length === 1,
);

// M finishes — its own resume clears the whole set (nothing left).
resumeVaultAutoCommit(root, tokenM);
check("cleanup: no lease left after M's own resume", !fs.existsSync(leasePath));
await versioner.commit();
check("after M's resume lifts the pause, the pending edit now commits", git("log", "--oneline").trim().split("\n").length === 2);
await versioner.stop();

console.log(failures === 0
  ? "\nALL PASS — the vault-pause lease is a multi-holder set: a concurrent pauser's own entry survives another holder's resume, in both pause orders, verified behaviorally (card 6e6b342d)."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
