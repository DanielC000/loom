import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a7de9d88 — closes the TOCTOU 87a3c87e's own Code Review named as a gap its pause bracket alone
// does NOT close: `mergeBranch` (git/worktrees.ts) pauses the vault auto-commit lease and takes the
// canonical index lock BEFORE staging its own squash — but a debounce tick (or a direct vault/writer.ts
// UI write) that had ALREADY passed its OWN early, unlocked pause check a moment earlier has no way to
// see a lease raised AFTER that check ran. If the tick's own `commitVault()` call then ran its
// `git add .` + `git commit` while the merge's squash sat STAGED-but-not-yet-committed in the SAME
// working tree/index, it would sweep the merge's own staged diff into a "loom: auto-commit", exactly the
// corruption 87a3c87e's bracket was meant to prevent.
//
// What ACTUALLY closes this is NOT 87a3c87e's pause bracket (an advisory, checked-once lease) — it's card
// `a09b81a0` round 3's own, separate fix: `commitVault()` now takes `withCanonicalIndexLock` around its
// ENTIRE add+commit sequence whenever its commitPath is merge-eligible — the SAME canonical lock
// `mergeBranch` itself takes. So a tick's own git-mutating sequence and a merge's own squash+commit can
// never interleave on the same repo, regardless of how the pause-lease timing falls out. This test
// exercises exactly that seam, directly, rather than trusting the reasoning:
//
// SCENARIO A — `commitVault()` called DIRECTLY (not via `VaultVersioner.commit()`, which would
//   short-circuit on its OWN early, unlocked pause check — the whole point here is to skip that early
//   check, simulating the exact window where it already returned "not paused" moments before the merge
//   raised its lease) while a real `mergeBranch()` call is mid-flight: paused, lock held, squash STAGED
//   but blocked uncommitted in a hanging pre-commit hook (same idiom as merge-vault-auto-commit-pause.mjs
//   / merge-writer-index-lock.mjs).
// SCENARIO B — `vault/writer.ts`'s `writeVaultFile()` (the REAL UI/MCP write path named as "point 2" in
//   card a7de9d88's own body) racing the SAME kind of in-flight merge. `writeVaultFile` never does ANY
//   early pause check at all — every real call exercises this window, not just an unlucky tick.
//
// Both must NOT sweep the merge's squash into the tick's/writer's own commit, and the pending edit must
// never be lost — either it lands in its own, separate commit, or it is still sitting pending on disk.
//
// Negative control (RED on 1596199a^, the commit immediately BEFORE a09b81a0 round 3 gave commitVault()
// its own canonical-lock wrap — restoring the fix returns both scenarios to GREEN):
//   pnpm --filter @loom/daemon negative-control \
//     --file packages/daemon/src/vault/versioner.ts \
//     --test packages/daemon/test/vault-tick-merge-toctou.mjs \
//     --ref 1596199a^
//
// Run after build: node test/vault-tick-merge-toctou.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df shape): mergeBranch below calls real withCanonicalIndexLock/quarantine
// machinery under LOOM_HOME. Isolate BEFORE the dist import, same as merge-vault-auto-commit-pause.mjs.
useOwnLoomHome("loom-vtmt-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const distVaultDir = path.join(__dirname, "..", "dist", "vault");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { commitVault, setCodeRepoGuardProvider } = await import(pathToFileURL(path.join(distVaultDir, "versioner.js")).href);
const { writeVaultFile } = await import(pathToFileURL(path.join(distVaultDir, "writer.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=vtmt@loom -c user.name=vtmt";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
function filesInCommit(cwd, sha) {
  return git(cwd, `show --name-only --format= ${sha}`).split("\n").map((s) => s.trim()).filter(Boolean);
}

// Same hanging-pre-commit-hook idiom as merge-vault-auto-commit-pause.mjs / merge-writer-index-lock.mjs:
// only the FIRST `git commit` against a given repo ever blocks, so the merge's own squash commit hangs
// (staged, not yet committed) for HOOK_SLEEP_S while everything else proceeds instantly.
const HOOK_SLEEP_S = 3;
const RACE_FIRE_DELAY_MS = 600; // fired well after the squash has staged but well before the hook wakes.
const GUARD_MS = 25_000; // this TEST's own patience — same sizing rationale as its siblings.

const root = fs.realpathSync(mkdtempManaged("loom-vtmt-"));

function makeRepo(tag) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email vtmt@loom && git config user.name vtmt && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, tag) {
  const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}-${tag}`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

// TIMING-GUARD-SAFE: fully-awaited-completion — this fixed window is raced against the REAL mergeBranch()
// promise via Promise.race, never used to "wait long enough, then assume it finished": the content checks
// that follow (mergeResult?.ok, the squash's own file list) all read the GENUINE resolved value the race
// produced, and if the window wins instead, mergeResult.__guardFired === "merge" makes the very next
// check ("not wedged") fail loudly — a timeout can never be mistaken for a successful completion.
const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

async function scenarioDirectCommitVaultRacesMergeSquash(tag) {
  const repo = makeRepo(tag);
  const branch = `loom/toctou-direct-${tag}`;
  makeWorktree(repo, branch, "file-a.txt", `branch-content-${tag}\n`, tag);
  installHangingHook(repo);

  // Register this repo as merge-eligible (its own repoPath === the commitPath commitVault resolves) so
  // commitVault() takes the SAME canonical lock a real merge would (@decision a09b81a0 round 3).
  setCodeRepoGuardProvider({
    snapshot: () => [{ id: `p-vtmt-a-${tag}`, repoPath: repo, repos: [], vaultOnly: true, vaultPath: repo }],
    recordEvent: () => {},
  });

  try {
    // The tick's own pending edit — something genuinely uncommitted, exactly what a real debounce tick
    // would be racing to commit.
    fs.writeFileSync(path.join(repo, "tick-edit.md"), `# tick edit ${tag}\n`);

    // Fire the merge: pauses, takes the canonical lock, stages the squash, then blocks mid-commit in the
    // hanging hook with the squash STAGED but not yet committed.
    const mergePromise = mergeBranch(repo, branch, "TOCTOU Direct Card");

    // Fire the "tick" — calling commitVault() DIRECTLY, skipping VaultVersioner.commit()'s own early
    // pause check entirely, simulating the window where that check already returned "not paused" a
    // moment before the merge raised its lease.
    // TIMING-GUARD-SAFE: fully-awaited-completion — this fixed delay only PACES when the tick fires
    // relative to the merge; it has no bearing on whether the merge completes. The "[guard] ... not
    // wedged" check a few lines below is gated on a SEPARATE, later Promise.race against the real
    // mergeBranch() promise (see the `guard` helper's own doc above) — that race's genuinely-resolved
    // value, not this delay's duration, is what the check reads.
    await new Promise((r) => setTimeout(r, RACE_FIRE_DELAY_MS));
    const tickResult = await commitVault(repo, "loom: auto-commit (tick, post-early-check)");

    const mergeResult = await Promise.race([mergePromise, guard(GUARD_MS, "merge")]);
    check("[A] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
    check("[A] the merge itself succeeds", mergeResult?.ok === true);

    // Whatever the tick decided (committed now, or backed off because the lease was still held at the
    // exact instant its in-lock check ran), the pending edit must not be stuck forever — simulate the
    // NEXT tick landing it, so the assertions below can check its content unconditionally.
    if (tickResult.committed !== true) {
      const followUp = await commitVault(repo, "loom: auto-commit (next tick, after lease lifted)");
      check("[A] if the first tick backed off (still-paused at lock-acquisition), a follow-up tick lands the pending edit", followUp.committed === true);
    }

    const allShas = git(repo, "log --format=%H").split("\n").map((s) => s.trim()).filter(Boolean);
    const squashSha = allShas.find((sha) => filesInCommit(repo, sha).includes("file-a.txt"));
    check("[A] the merge's own squash commit exists", !!squashSha);
    check(
      "[A] the squash commit contains ONLY the branch's own file — the tick's pending edit was never swept into it",
      !!squashSha && filesInCommit(repo, squashSha).length === 1 && filesInCommit(repo, squashSha)[0] === "file-a.txt",
    );

    const tickCommitSha = allShas.find((sha) => filesInCommit(repo, sha).includes("tick-edit.md"));
    const tickStillPending = git(repo, "status --porcelain").includes("tick-edit.md");
    check("[A] the tick's own pending edit is never lost — either committed on its own, or still pending on disk", !!tickCommitSha || tickStillPending);
    if (tickCommitSha) {
      check(
        "[A] if committed, the tick's own commit contains ONLY its own file — never mixed with the squash's file",
        filesInCommit(repo, tickCommitSha).length === 1 && filesInCommit(repo, tickCommitSha)[0] === "tick-edit.md",
      );
    }
  } finally {
    setCodeRepoGuardProvider(undefined);
  }
}

async function scenarioWriterUiWriteRacesMergeSquash(tag) {
  const repo = makeRepo(tag);
  const branch = `loom/toctou-writer-${tag}`;
  makeWorktree(repo, branch, "file-b.txt", `branch-content-${tag}\n`, tag);
  installHangingHook(repo);

  setCodeRepoGuardProvider({
    snapshot: () => [{ id: `p-vtmt-b-${tag}`, repoPath: repo, repos: [], vaultOnly: true, vaultPath: repo }],
    recordEvent: () => {},
  });

  try {
    const mergePromise = mergeBranch(repo, branch, "TOCTOU Writer Card");
    await new Promise((r) => setTimeout(r, RACE_FIRE_DELAY_MS));

    // vault/writer.ts's writeVaultFile() never does ANY early pause check of its own — every real
    // REST/MCP write exercises this exact window, every time, not just an unlucky tick.
    const writeResult = await writeVaultFile(repo, "writer-edit.md", `# UI write during merge ${tag}\n`);
    check("[B] the UI write itself always succeeds — the file lands on disk regardless of the commit race", writeResult.ok === true);

    const mergeResult = await Promise.race([mergePromise, guard(GUARD_MS, "merge")]);
    check("[B] [guard] the merge settled within the test's patience window (not wedged)", mergeResult?.__guardFired !== "merge");
    check("[B] the merge itself succeeds", mergeResult?.ok === true);

    if (writeResult.committed !== true) {
      const followUp = await commitVault(repo, "loom: auto-commit (next tick, after lease lifted)");
      check("[B] if the UI write's own commit backed off, a follow-up tick lands the pending edit", followUp.committed === true);
    }

    const allShas = git(repo, "log --format=%H").split("\n").map((s) => s.trim()).filter(Boolean);
    const squashSha = allShas.find((sha) => filesInCommit(repo, sha).includes("file-b.txt"));
    check("[B] the merge's own squash commit exists", !!squashSha);
    check(
      "[B] the squash commit contains ONLY the branch's own file — the UI write was never swept into it",
      !!squashSha && filesInCommit(repo, squashSha).length === 1 && filesInCommit(repo, squashSha)[0] === "file-b.txt",
    );

    const writeCommitSha = allShas.find((sha) => filesInCommit(repo, sha).includes("writer-edit.md"));
    const writeStillPending = git(repo, "status --porcelain").includes("writer-edit.md");
    check("[B] the UI write is never lost — either committed on its own, or still pending on disk", !!writeCommitSha || writeStillPending);
    if (writeCommitSha) {
      check(
        "[B] if committed, the UI write's own commit contains ONLY its own file — never mixed with the squash's file",
        filesInCommit(repo, writeCommitSha).length === 1 && filesInCommit(repo, writeCommitSha)[0] === "writer-edit.md",
      );
    }
  } finally {
    setCodeRepoGuardProvider(undefined);
  }
}

try {
  await scenarioDirectCommitVaultRacesMergeSquash(`${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await scenarioWriterUiWriteRacesMergeSquash(`${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — commitVault()'s canonical-lock wrap (card a09b81a0 round 3) serializes a tick's/UI-write's own add+commit against a real merge's staged-but-uncommitted squash, closing the TOCTOU 87a3c87e's pause bracket alone left open."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
