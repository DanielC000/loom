import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 60d706f4 (a09b81a0 round-4 Code Review, Minor 2): VaultVersioner.commit() used to `return` when
// the advisory pause lease (card 614dfbef) is held, WITHOUT re-scheduling — only a LATER, UNRELATED fs
// event (or an explicit schedule() call) would ever retry. A write that lands WHILE the lease is held
// already fired its OWN fs event inside the lease window, so it got no further nudge and stayed
// uncommitted until some future, unrelated edit happened to touch the same vault. a09b81a0 reworded the
// vault_write tool descriptions to "committed on the next change" to reflect that weaker (pre-fix)
// behavior.
//
// Fixed: commit() now re-arms schedule() itself when it skips a tick on a held lease, so a LATER tick
// retries once the lease lifts — with NO further edit required. The lease's own TTL is bounded
// (MAX_VAULT_PAUSE_MS), so this is a bounded retry: schedule() always clears any existing timer before
// setting a new one, so there is never more than the ONE timer `this.timer` already holds (no pile-up),
// and a repeatedly-renewed lease only extends how LONG this retries, never how TIGHT (each retry is still
// paced by the normal debounce interval).
//
// Proves, with REAL git + a REAL chokidar watcher (no mocked commit()/schedule(), and no manual commit()
// call or further edit after the initial write in either scenario):
//   (1) a write that lands while the lease is held is committed automatically, with NO further edit, once
//       the lease lifts on its own — the re-arm is what makes this happen; pre-fix nothing would ever
//       nudge it, since the only fs event this edit could have produced already fired inside the lease.
//   (2) the re-arm survives the lease being RENEWED twice mid-retry (simulating a second/third overlapping
//       git-surgery op re-pausing before the previous lease would have expired) — the edit still commits,
//       automatically, once the lease is genuinely free for good.
//
// Waits on the real observable (the commit count actually rising), bounded — never a fixed sleep guarding
// a negative claim (fixed-wait-witness-guard.mjs / fixed-wait-negative-guard.mjs); every `check()` here is
// evaluated at (or immediately after) the exact moment its own condition was independently proven true by
// a bounded poll, never inferred from elapsed wall-clock time alone.
//
// Run after build: node test/vault-pause-lease-rearm.mjs
// Negative control (RED against pre-fix code, GREEN restored) — --ref names b9e6b479, the commit
// immediately BEFORE this fix landed (this fix's own parent), not a floating HEAD that drifts the
// moment a later commit lands on this branch:
//   pnpm --filter @loom/daemon negative-control \
//     --file packages/daemon/src/vault/versioner.ts \
//     --test packages/daemon/test/vault-pause-lease-rearm.mjs \
//     --ref b9e6b479
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VaultVersioner, pauseVaultAutoCommit } from "../dist/vault/versioner.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Retrofitted onto the shared _wait.mjs waitUntil (same idiom as vault-versioner-wiring.mjs): a thrown
// predicate (e.g. a transient git-lock race) is treated as "not yet observed" within the same budget,
// never silently swallowed if it's actually a persistent throw.
async function waitFor(fn, timeoutMs = 5000) {
  try {
    return await sharedWaitUntil(fn, { timeoutMs, intervalMs: 20, label: "vault-pause-lease-rearm: fn" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
}

const root = fs.realpathSync(mkdtempManaged("loom-vault-pause-rearm-"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
const commitCount = () => parseInt(git("rev-list", "--all", "--count").trim() || "0", 10);

git("init", "-q");
git("config", "user.email", "loom-pause-rearm-test@example.com");
git("config", "user.name", "loom-pause-rearm-test");
fs.writeFileSync(path.join(root, "base.md"), "# base\n");
git("add", ".");
git("commit", "-q", "-m", "base");

// Short debounce so the real chokidar -> debounce -> commit tick fires quickly in a test (same value
// vault-versioner-wiring.mjs already uses for its own real-watcher scenarios).
const DEBOUNCE_MS = 150;
const versioner = new VaultVersioner(root, DEBOUNCE_MS);
await versioner.start();
await versioner.whenReady();

try {
  // ===================== (1) a write landed WHILE the lease is held commits once it lifts, with NO further edit =====================
  {
    const baseCount = commitCount();
    pauseVaultAutoCommit(root, 3 * DEBOUNCE_MS);
    fs.writeFileSync(path.join(root, "doc-held.md"), "# written while the lease is held\n");

    // No further write, no explicit commit() call from here on — ONLY the re-arm can bring this home.
    const landed = await waitFor(() => commitCount() === baseCount + 1, 5000);
    check("(1) the held-lease edit committed automatically once the lease lifted, via the re-arm alone", landed);
    check("(1) exactly one new commit landed", commitCount() === baseCount + 1);
    check("(1) the working tree is clean afterward", git("status", "--porcelain").trim() === "");
  }

  // ===================== (2) the re-arm survives the lease being RENEWED twice mid-retry =====================
  {
    const baseCount = commitCount();
    pauseVaultAutoCommit(root, 2 * DEBOUNCE_MS);
    fs.writeFileSync(path.join(root, "doc-renewed.md"), "# written, then the lease gets renewed twice\n");

    // Renew the lease twice, each renewal arriving (by construction: DEBOUNCE_MS < the held duration)
    // before the previous one would have expired — simulating two further overlapping git-surgery ops
    // re-pausing on top of the first. Plain pacing sleeps (not guarding any assertion of their own).
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
    pauseVaultAutoCommit(root, 2 * DEBOUNCE_MS);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
    pauseVaultAutoCommit(root, DEBOUNCE_MS); // final, short lease — the last one allowed to actually expire

    const landed = await waitFor(() => commitCount() === baseCount + 1, 5000);
    check("(2) the edit committed automatically once the RENEWED lease genuinely lifted, via the re-arm alone", landed);
    check("(2) exactly one commit landed despite the lease being renewed twice mid-retry", commitCount() === baseCount + 1);
  }
} finally {
  await versioner.stop();
}

console.log(failures === 0
  ? "\nALL PASS — a held-lease edit commits automatically once the lease lifts (including across a renewed lease), via VaultVersioner's own re-arm, with no further edit required."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
