import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card `6e6b342d` round 2, follow-up item 6: pins that `GitWriter.checkout`/`createBranch`/`commit`'s own
// vault-pause lease is taken at LOCK ADMISSION, not at call time — the SAME property
// `vault-pause-lease-admission-timing.mjs` already proves for `mergeBranch`, applied here to the THIRD
// bracket-moved site this card touches.
//
// Each scenario holds the canonical lock itself (via the real `withCanonicalIndexLock`), then calls the
// GitWriter method under test — which queues behind that hold. A sample strictly inside the hold window
// (LOCK_HOLD_MS/2, well before the hold's own LOCK_HOLD_MS timer fires) proves the lease has NOT been
// taken yet while still queued; pre-`6e6b342d`, pause ran at call time regardless of the lock, so this
// same sample would already find the lease present. After the hold releases and the call completes, the
// lease must be gone (resumed).
//
// Run: 1) build daemon (pnpm build), 2) node test/git-writer-pause-admission-timing.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWriter } from "../dist/git/writer.js";
import { withCanonicalIndexLock } from "../dist/git/repo-lock.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const LOCK_HOLD_MS = 1_200; // comfortably above scheduling jitter (tens of ms); same sizing rationale as
                             // batch-merge-vault-auto-commit-pause.mjs's own equivalent constant

const root = fs.realpathSync(mkdtempManaged("loom-gw-admit-"));

function makeRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init");
  git("config", "user.email", "loom-test@example.com");
  git("config", "user.name", "loom-test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return { repo, git };
}

async function holdLockThenSample(repo, leasePath, fire) {
  const holdPromise = withCanonicalIndexLock(repo, () => new Promise((r) => setTimeout(r, LOCK_HOLD_MS)));
  const callPromise = fire();

  await new Promise((r) => setTimeout(r, LOCK_HOLD_MS / 2)); // sample strictly inside the hold window
  const leaseExistedWhileQueued = fs.existsSync(leasePath);

  await holdPromise;
  const result = await callPromise;
  return { leaseExistedWhileQueued, result };
}

{
  const { repo, git } = makeRepo("checkout");
  const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  git("branch", "other-branch");
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  const w = new GitWriter(repo);

  const { leaseExistedWhileQueued, result } = await holdLockThenSample(repo, leasePath, () => w.checkout("other-branch"));
  check(
    "[checkout] precondition: while a DIFFERENT op still holds the canonical lock, checkout()'s own lease has NOT been taken yet",
    !leaseExistedWhileQueued,
  );
  check("[checkout] the checkout itself succeeds once admitted", result.ok === true && result.branch === "other-branch");
  check("[checkout] after it returns, no lease is left stuck", !fs.existsSync(leasePath));
  git("checkout", baseBranch); // restore for tidiness (not strictly required, the repo is throwaway)
}

{
  const { repo, git } = makeRepo("createbranch");
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  const w = new GitWriter(repo);

  const { leaseExistedWhileQueued, result } = await holdLockThenSample(repo, leasePath, () => w.createBranch("feature/admit-test"));
  check(
    "[createBranch] precondition: while a DIFFERENT op still holds the canonical lock, createBranch()'s own lease has NOT been taken yet",
    !leaseExistedWhileQueued,
  );
  check("[createBranch] the createBranch itself succeeds once admitted", result.ok === true && result.branch === "feature/admit-test");
  check("[createBranch] after it returns, no lease is left stuck", !fs.existsSync(leasePath));
}

{
  const { repo, git } = makeRepo("commit");
  const leasePath = path.join(repo, ".git", "loom-vault-pause.json");
  const w = new GitWriter(repo);
  fs.writeFileSync(path.join(repo, "new.txt"), "added\n");

  const { leaseExistedWhileQueued, result } = await holdLockThenSample(repo, leasePath, () => w.commit("add new.txt"));
  check(
    "[commit] precondition: while a DIFFERENT op still holds the canonical lock, commit()'s own lease has NOT been taken yet",
    !leaseExistedWhileQueued,
  );
  check("[commit] the commit itself succeeds once admitted", result.ok === true && typeof result.hash === "string");
  check("[commit] after it returns, no lease is left stuck", !fs.existsSync(leasePath));
  check("[commit] the commit actually landed", git("log", "--pretty=%s").includes("add new.txt"));
}

console.log(failures === 0
  ? "\nALL PASS — GitWriter.checkout/createBranch/commit's own vault-pause lease is taken at LOCK ADMISSION, not at call time (card 6e6b342d)."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
