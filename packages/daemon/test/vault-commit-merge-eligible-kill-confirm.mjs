import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bf11ac3f — see docs/decisions/bf11ac3f-vault-commit-kill-confirm-merge-eligible.md for the full
// background. In short: when `commitVault`'s (vault/versioner.ts) confirmed governing root is ALSO a
// registered project's own `repoPath` (the shared-vault-is-also-a-repo shape `a09b81a0` round 3's own
// vault-root exemption lets through), `commitVault` takes the SAME `withCanonicalIndexLock` a real
// `mergeBranchLocked`/`GitWriter` write on that repo would — but its own `git add .`/`git commit` calls
// ran on a plain `withTimeout` (card 8e75ee20's own documented hazard: it settles independent of the real
// git child), not the kill-confirmed `killableCanonicalRaw` every OTHER mutating canonical call already
// uses (card 24c0bdba). This file proves the fix: those two calls now route through `killableCanonicalRaw`
// with `VAULT_GIT_SAFETY_ARGS` as an additive `extraConfigArgs`, and an unconfirmed kill raises the SAME
// `enterMergeQuarantine` every other canonical-mutating call site does.
//
// SCENARIO (a) is a REAL, end-to-end run (no test-seam git factory) — it proves the hook/fsmonitor/gpgsign
// neutralisation (`VAULT_GIT_SAFETY_ARGS`) actually survives the switch to `killableCanonicalRaw`'s own
// `extraConfigArgs` threading. Round 2 (Code Review `0b5b1a50`, MAJOR): a PRE-COMMIT-only hook can never
// go red here — `commitVault` always passes `--no-verify` on every commit regardless of
// `extraConfigArgs`, which alone already blocks pre-commit (and commit-msg); dropping
// `VAULT_GIT_SAFETY_ARGS` entirely still left that one check green. `prepare-commit-msg` and
// `post-commit` are NOT blocked by `--no-verify` — only `core.hooksPath` (part of
// `VAULT_GIT_SAFETY_ARGS`) stops them — so this scenario now plants all three and asserts none ran;
// `prepare-commit-msg`/`post-commit` are the ones that actually discriminate the fix.
//
// NEGATIVE CONTROL for THIS scenario specifically (proven by hand, not re-run automatically — same
// one-time-historical-proof posture merge-commit-kill-confirm.mjs's own header documents): with both
// `killableCanonicalRaw` calls in `commitVault`'s merge-eligible branch temporarily edited to pass
// `undefined` instead of `VAULT_GIT_SAFETY_ARGS` (rebuild, re-run this file), scenario (a)'s
// `prepare-commit-msg`/`post-commit` checks below went RED by name while the `pre-commit` check (blocked
// by `--no-verify` alone, independent of `extraConfigArgs`) stayed GREEN — exactly the false-green shape
// the review caught. Restoring `VAULT_GIT_SAFETY_ARGS` returned all three to GREEN.
//
// SCENARIO (b) proves commitVault's own WIRING on an unconfirmed kill — not the tree-kill mechanism
// itself, which `bounded-git-kill-on-timeout.mjs` / `merge-commit-kill-confirm.mjs` already prove directly
// against a real, slow child. Mirrors `treeDeathConfirmed`'s own doc precedent (a test-seam gitFactory
// manufacturing a confirmed/unconfirmed-kill-shaped MESSAGE directly, exercised by
// merge-confirm-verdict-cache-solo-merge-transient.mjs): the vault's own commit path NEUTRALISES real git
// hooks by design (hooksPath=devNull + --no-verify), so the hanging-pre-commit-hook idiom every OTHER
// kill-confirm test in this suite uses cannot simulate a hang HERE at all — there is no hook left to hang.
// The injected `gitFactory` shells out for REAL on every call except the one commit call it simulates as
// an unconfirmed kill, so the rest of commitVault's own logic (status/identity/residue) sees honest,
// real git state; only the ONE call under test is faked.
//
// NEGATIVE CONTROL (card bf11ac3f's own standing verification posture — prove this check can go RED):
//   pnpm --filter @loom/daemon negative-control \
//     --file packages/daemon/src/git/bounded.ts \
//     --file packages/daemon/src/vault/versioner.ts \
//     --test packages/daemon/test/vault-commit-merge-eligible-kill-confirm.mjs
//   (default --ref HEAD: HEAD predates this card's fix, since the fix is this card's own uncommitted
//   working-tree edit — see the tool's own --help). Expected: scenario (b)'s "repo is left QUARANTINED"
//   check goes RED on HEAD (the prior code never called enterMergeQuarantine on this path at all — the
//   same simulated rejection still propagates on HEAD via the old bare withTimeout, just with no
//   quarantine raised for it) and GREEN on the working tree.
//
// Run after build: node test/vault-commit-merge-eligible-kill-confirm.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df shape, same as vault-tick-merge-toctou.mjs / merge-commit-kill-confirm.mjs):
// scenario (b) below raises a REAL enterMergeQuarantine() latch under LOOM_HOME. Isolate BEFORE the dist
// import, never after.
useOwnLoomHome("loom-vmekc-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distVaultDir = path.join(__dirname, "..", "dist", "vault");
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { commitVault, setCodeRepoGuardProvider } = await import(pathToFileURL(path.join(distVaultDir, "versioner.js")).href);
const { activeMergeQuarantineFor, listActiveMergeQuarantines } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID_ARGV = ["-c", "user.email=vmekc@loom", "-c", "user.name=vmekc"];
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const commitCount = (dir) => parseInt(git(dir, ["rev-list", "--all", "--count"]).trim() || "0", 10);

const root = fs.realpathSync(mkdtempManaged("loom-vmekc-"));

// Same merge-eligible shape vault-tick-merge-toctou.mjs already uses: a vaultOnly project whose own
// repoPath === vaultPath, so isCommitPathMergeEligible(vaultPath) is true (exact match) while
// checkCodeRepoCollision exempts it (the vaultOnly-per-candidate exemption — the project's OWN repoPath).
function makeMergeEligibleVaultRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "vmekc@loom"]);
  git(repo, ["config", "user.name", "vmekc"]);
  git(repo, [...GIT_ID_ARGV, "commit", "-q", "--allow-empty", "-m", "init"]);
  setCodeRepoGuardProvider({
    snapshot: () => [{ id: `p-vmekc-${tag}`, repoPath: repo, repos: [], vaultOnly: true, vaultPath: repo }],
    recordEvent: () => {},
  });
  return repo;
}

// ===================== (a) real end-to-end: VAULT_GIT_SAFETY_ARGS survive killableCanonicalRaw =====================
{
  const repo = makeMergeEligibleVaultRepo("a");
  // Three distinct hooks, three distinct markers. `--no-verify` (applied unconditionally by commitVault,
  // independent of VAULT_GIT_SAFETY_ARGS) ALONE already blocks pre-commit/commit-msg — so a pre-commit-
  // only check here would stay green even with the fix's own config dropped (the exact false-green the
  // review caught). prepare-commit-msg and post-commit are blocked ONLY by VAULT_GIT_SAFETY_ARGS's
  // `core.hooksPath` — they are the two that actually discriminate.
  const markers = {
    "pre-commit": path.join(repo, "pre-commit-ran.marker"),
    "prepare-commit-msg": path.join(repo, "prepare-commit-msg-ran.marker"),
    "post-commit": path.join(repo, "post-commit-ran.marker"),
  };
  for (const [hookName, markerPath] of Object.entries(markers)) {
    const hookPath = path.join(repo, ".git", "hooks", hookName);
    fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${markerPath.replace(/\\/g, "/")}"\n`);
    fs.chmodSync(hookPath, 0o755);
  }

  fs.writeFileSync(path.join(repo, "note.md"), "# real content\n");
  const before = commitCount(repo);
  const result = await commitVault(repo, "loom: auto-commit (merge-eligible, real hook-neutralisation check)");
  check("(a) a merge-eligible commitVault still commits for real (no deps override)", result.committed === true);
  check("(a) ...and a new commit actually landed", commitCount(repo) === before + 1);
  for (const [hookName, markerPath] of Object.entries(markers)) {
    check(
      `(a) ...and the planted ${hookName} hook did NOT run — VAULT_GIT_SAFETY_ARGS survived the switch to killableCanonicalRaw`,
      !fs.existsSync(markerPath),
    );
  }
}

// ===================== (b) an unconfirmed kill on the merge-eligible commit quarantines the repo =====================
{
  const repo = makeMergeEligibleVaultRepo("b");
  fs.writeFileSync(path.join(repo, "note.md"), "# content that must never land via a phantom commit\n");

  const giveUpError = (label) =>
    new Error(`${label} exceeded 1ms, killed, but did not die within 1ms — giving up (hung git child?)`);

  // Shells out for REAL on every call except "commit" raw(), which it simulates as an unconfirmed kill —
  // see this file's own header for why a real hanging hook can't be used here.
  const gitFactory = (repoPath) => ({
    checkIsRepo: async () => true,
    revparse: async (args) => {
      const argv = Array.isArray(args) ? args : [args];
      if (argv.includes("--show-toplevel")) return `${repoPath}\n`;
      throw new Error(`unsupported revparse args in test fake: ${JSON.stringify(argv)}`);
    },
    status: async () => {
      const out = execFileSync("git", ["-C", repoPath, "status", "--porcelain"], { encoding: "utf8" });
      const files = out.split("\n").filter(Boolean).map((line) => ({
        path: line.slice(3), index: line[0], working_dir: line[1],
      }));
      return { files, isClean: () => files.length === 0 };
    },
    raw: async (args) => {
      const argv = Array.isArray(args) ? args : [args];
      if (argv[0] === "commit") throw giveUpError("git commit");
      return execFileSync("git", argv, { cwd: repoPath, encoding: "utf8" });
    },
    add: async () => { throw new Error("unexpected .add() method call — the merge-eligible path must route add through raw()"); },
    init: async () => { throw new Error("unexpected .init() method call — this repo is already initialised"); },
    commit: async () => { throw new Error("unexpected .commit() method call — the merge-eligible path must route commit through raw()"); },
  });

  let firstErr;
  try {
    await commitVault(repo, "loom: auto-commit (should quarantine, never commit)", { deps: { gitFactory } });
  } catch (e) {
    firstErr = e;
  }
  check("(b) the simulated unconfirmed kill propagates as a rejection (commitVault never swallows it)", !!firstErr);

  const q = activeMergeQuarantineFor(repo);
  check("(b) the repo is left QUARANTINED after the unconfirmed kill", !!q);
  check("(b) ...the quarantine names the vault commit unambiguously (branch label)", q?.branch === "(vault commit)");
  check(
    "(b) ...and the reason names the unconfirmed kill, not a generic failure",
    typeof q?.reason === "string" && /could not be confirmed dead after a kill/.test(q.reason),
  );
  check(
    "(b) the quarantine shows up on the SAME list/clear surface as any other quarantine (no new store)",
    listActiveMergeQuarantines().includes(q),
  );
  check("(b) no phantom commit ever landed despite the real pending edit", commitCount(repo) === 1); // just "init"

  // A SECOND call on the now-quarantined repo must be refused outright, never race whatever the first
  // call's (possibly still-live) orphan might still be doing — this is the pre-lock quarantine check at
  // the TOP of commitVault, so it needs no deps override to prove.
  const second = await commitVault(repo, "loom: auto-commit (should be refused — quarantined)");
  check("(b) a subsequent commitVault call on the SAME repo is refused by the quarantine", second.committed === false);
  check("(b) ...still exactly one commit after the refused second attempt", commitCount(repo) === 1);
}

setCodeRepoGuardProvider(undefined);
await finishAndExit(failures === 0 ? 0 : 1);
