import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P0 CRITICAL DATA-LOSS regression test (board card 9e77050f, found by Code Review taskless session
// 71463b1f 2026-07-23, auditing efeddcd+b0e567b).
//
// THE BUG (verified against real, unmodified pre-fix code before this test existed — the reviewer replayed
// mergeBranchLocked's decision sequence against real git in a temp repo, command-for-command):
// mergeBranchLocked's residue-clear at entry only fires on an AFFIRMATIVE `ls-files --unmerged` /
// `MERGE_HEAD` signal. A `git merge --squash` that stages a diff and then never reaches its commit step —
// e.g. the daemon dying between stage and commit, which this repo's own operational history shows happens
// routinely via daemon_restart/supervisor kill/crash — sets NEITHER signal. So the residue-clear does not
// fire, the next op's OWN `git merge --squash` (for a totally different, disjoint-path branch) exits 0 with
// no error (git does not refuse a dirty index on disjoint paths), and the old code blindly committed BOTH
// branches' files under the SECOND branch's subject + Loom-Worker-Branch trailer.
//
// REPRODUCED WITH ZERO CONCURRENCY — no Promise.all, no timing, no mutex interaction. This is a SEPARATE
// trigger from board card e076d2a2 (closed by the per-repo mutex in merge-repo-mutex.mjs): that mutex is
// in-process and cannot help here, because this residue outlives the process entirely.
//
// THE FIX: mergeBranchLocked now probes `git status --porcelain --untracked-files=no` (staged AND
// unstaged tracked state) right before the `--squash`, AFTER the existing MERGE_HEAD/unmerged clear. Any
// residue that survives that clear is either (a) exactly this dead-squash leftover, or (b) a human's own
// uncommitted work in the same canonical checkout — indistinguishable from git state alone, so instead of
// guessing (and possibly `reset --hard`-ing away a human's real work) it REFUSES LOUDLY: `ok:false`, same
// as every other ambiguous case in this function. A false NOT-merged is a safe, idempotent retry; the old
// silent-absorption behavior was the actual data-loss bug.
//
// This test proves BOTH halves:
//   (1) RED-equivalent documentation: replays the exact mechanism (raw `git merge --squash A`, no commit,
//       simulating the dead process) and shows what the SECOND merge call does under the fix — must REFUSE
//       (ok:false), never silently commit.
//   (2) The canonical repo is left UNTOUCHED by the refusal — branch A's staged residue is still sitting
//       there afterward (nothing lost, nothing silently absorbed) and branch B's own content never landed.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-staged-residue-refuses.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=msr@loom -c user.name=msr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-msr-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email msr@loom && git config user.name msr && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-msr-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  const repo = makeRepo();
  makeWorktree(repo, "loom/branch-a", "file-a.txt", `a-content-${sfx}\n`);
  makeWorktree(repo, "loom/branch-b", "file-b.txt", `b-content-${sfx}\n`);

  // ── Simulate op A dying between stage and commit: a raw `git merge --squash` against the CANONICAL
  // repo, with NO follow-up commit. This is exactly what mergeBranchLocked itself does internally, just
  // stopped short — reproducing "the daemon died right here" with no daemon involved at all.
  execSync("git merge --squash loom/branch-a", { cwd: repo });
  const stagedBeforeB = git(repo, "diff --cached --name-only");
  check("setup: branch A's squash is staged (simulating a dead process mid-merge)", stagedBeforeB === "file-a.txt");
  check("setup: no MERGE_HEAD after a --squash (the signal the old code relied on)", (() => {
    try { execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: repo }); return false; } catch { return true; }
  })());
  check("setup: no unmerged entries after a --squash (the OTHER signal the old code relied on)", git(repo, "ls-files --unmerged") === "");

  // ── The second, unrelated op: merge branch B (disjoint path from A) into the SAME canonical repo.
  const resB = await mergeBranch(repo, "loom/branch-b", "Card B title");

  // ── (1) Must REFUSE — never silently commit A's residue under B's trailer.
  check("op B REFUSES rather than silently absorbing A's residue (ok:false)", resB.ok === false);
  check("op B's refusal reason names the staged/dirty state", typeof resB.reason === "string" && resB.reason.includes("file-a.txt"));
  // The reason is the ONLY thing a caller who never read card 9e77050f actually sees — it must make the
  // required action unmistakable: not the branch's fault, a human must act, and the refusal is deliberate.
  const reason = resB.reason ?? "";
  check("reason says this is NOT a problem with the branch (retrying won't help)", /not a problem with/i.test(reason));
  check("reason says a HUMAN must resolve it", /human/i.test(reason));
  check("reason says the refusal is deliberate, not a bug", /deliberate/i.test(reason));

  // ── (2) The canonical repo must be UNTOUCHED: no new commit, A's residue still sitting there exactly as
  // it was (nothing silently landed, nothing silently reset away).
  const headAfter = git(repo, "rev-parse HEAD");
  const initSha = git(repo, "log --format=%H --grep=^init$ -1");
  check("canonical repo HEAD did not move (no commit landed from the refusal)", headAfter === initSha);
  const stagedAfterB = git(repo, "diff --cached --name-only");
  check("branch A's staged residue is STILL PRESENT (refusal did not silently reset it away either)", stagedAfterB === "file-a.txt");
  const finalTree = git(repo, "ls-tree -r --name-only HEAD");
  check("branch B's content did NOT land in HEAD's tree", !finalTree.includes("file-b.txt"));
  const log = git(repo, "--no-pager log --format=%B");
  check("no commit anywhere carries branch B's trailer (nothing landed under a false label)", !log.includes("Loom-Worker-Branch: loom/branch-b"));

  // ── A human resolving the canonical repo by hand (commit or reset the residue) unblocks the NEXT
  // attempt — the refusal is a safe, idempotent retry, not a dead end.
  execSync("git reset --hard HEAD", { cwd: repo });
  const resBRetry = await mergeBranch(repo, "loom/branch-b", "Card B title");
  check("RETRY after a human clears the canonical repo succeeds normally", resBRetry.ok === true && !!resBRetry.sha);
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — staged-but-not-unmerged residue from a dead squash now makes the NEXT merge refuse loudly (safe, idempotent) instead of silently committing under the wrong branch's trailer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
