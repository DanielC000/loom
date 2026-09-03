import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P0 CRITICAL DATA-LOSS regression test (board card e076d2a2, incident: commit fb1dbb2, 2026-07-23).
// REAL git on temp repos, NO claude and NO live daemon — calls mergeBranch() directly, concurrently,
// against the SAME canonical repo, exactly mirroring what two overlapping worker_merge_confirm ops do
// once BOTH have passed their build gate and reach the squash-merge step (reachable in production once
// `orchestration.maxConcurrentGates` >= 2).
//
// THE BUG (verified against the real unmodified pre-fix code before this test was written — see the
// investigation's throwaway repro scripts, not checked in): mergeBranch stages + commits directly against
// the canonical repo's SHARED git index at `repoPath`, with zero mutual exclusion between concurrent
// calls. Two concurrent mergeBranch() calls for two DIFFERENT branches of the SAME repo can produce a
// commit bearing ONE branch's subject + Loom-Worker-Branch trailer while its tree contains ONLY the
// OTHER branch's content — reproduced on the FIRST unguarded attempt, no artificial delays needed. The
// trigger: mergeBranch's up-front residue-clear only fires on an affirmative `ls-files --unmerged` /
// `MERGE_HEAD` signal, neither of which a normal concurrent `--squash` sets — so when one op's OWN
// `git merge --squash` fails (e.g. `.git/index.lock` contention with the other op's concurrent squash),
// the old code had no way to distinguish "my squash never touched anything" from "my squash landed
// cleanly": it just checked whether ANYTHING was staged and, if so, blindly committed it under its own
// subject/trailer — even when that staged content belonged to the OTHER op entirely.
//
// THE FIX: a per-canonical-repo-path async mutex now serializes mergeBranch's WHOLE
// residue-clear→squash→conflict-check→commit sequence, so two concurrent calls for the same repo can
// never interleave on its shared index — and (defense in depth) mergeBranch now fails loud UNCONDITIONALLY
// on its own squash raw error, never falling through to "something's staged, ship it" regardless of
// whether the mutex is what prevented that leftover stage from existing.
//
// Proves, over MANY trials (the original incident needed real production timing to trigger — a small
// fixed trial count could pass by luck even on genuinely racy code):
//   (1) BOTH concurrent ops succeed, each producing its OWN correctly-labeled commit (no more silent
//       swallowing of one op under "ALREADY_MERGED"/rejection because of index contention).
//   (2) Content integrity, checked the STRONGEST way available: for EVERY commit in the resulting history
//       that carries a `Loom-Worker-Branch: <branch>` trailer, that branch's own changed file is ACTUALLY
//       present with the CORRECT content in that exact commit's tree — i.e. it is IMPOSSIBLE for a
//       trailer to point at content that isn't really its own. This is the DoD's "asserts BOTH-ops-report-
//       merged is impossible [with cross-corrupted content]" requirement, verified structurally rather
//       than by re-deriving one specific interleaving.
//   (3) No content is ever lost: both branches' files are present SOMEWHERE in the final tree.
// Run: 1) build daemon (pnpm build), 2) node test/merge-repo-mutex.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mrm@loom -c user.name=mrm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

// ── Integrity-sweep exec hardening (board escalation, gate loss 2026-07-25 on card 45585896's merge):
//    the sweep below calls several read-only git subprocesses against an already-quiescent repo. A
//    TRANSIENT exec death (non-zero exit, EMPTY stderr — the git *process* itself failed to run, not a
//    bad object) used to raw-throw and abort the whole file, which reads exactly like a merge-repo-mutex
//    defect when it is really host-load flakiness. A GENUINE git error (non-empty stderr, e.g.
//    `fatal: bad object`) is a REAL signal and must never be retried or swallowed.
//    The backoff is deliberately measured in SECONDS, not milliseconds: what's being absorbed is a git
//    subprocess failing to SPAWN under the gate's own sustained cap=2 concurrent-suite host load, which
//    persists for seconds to minutes — not an unloaded-host blip. A tight ~100ms budget just resamples
//    the SAME congested instant a few times and still goes red; the escalating delays below are sized to
//    span past a real congestion spike instead. This is the same class of budget-sized-for-an-unloaded-
//    host mistake sibling card 40e3c88f fixes elsewhere — don't re-tighten this back down.
const GIT_TRANSIENT_RETRY_DELAYS_MS = [300, 800, 1500]; // ~2.6s total span across the 3 gaps between 4 attempts
const GIT_TRANSIENT_RETRIES = GIT_TRANSIENT_RETRY_DELAYS_MS.length + 1;

class GitIntegrityError extends Error {
  constructor(message, { transient, label }) {
    super(message);
    this.transient = transient;
    this.label = label;
  }
}

function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Every git subprocess call the integrity sweep makes goes through here. `execImpl` is injectable so the
// self-test below can prove both the retry path and the fail-loud path without needing a real flaky git.
function execGitIntegrity(cwd, args, label, execImpl = (c, a) => execSync(`git ${a}`, { cwd: c }).toString()) {
  let lastErr;
  for (let attempt = 1; attempt <= GIT_TRANSIENT_RETRIES; attempt++) {
    try {
      return execImpl(cwd, args);
    } catch (e) {
      const stderr = (e.stderr ? e.stderr.toString() : "").trim();
      if (stderr) {
        throw new GitIntegrityError(`git subprocess reported an error at "${label}": ${stderr}`, { transient: false, label });
      }
      lastErr = e;
      if (attempt < GIT_TRANSIENT_RETRIES) sleepSyncMs(GIT_TRANSIENT_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw new GitIntegrityError(
    `git subprocess flaked (transient, empty stderr, exit ${lastErr?.status ?? "?"}) after ${GIT_TRANSIENT_RETRIES} attempts at "${label}"`,
    { transient: true, label },
  );
}

// ── Self-test: INJECT both failure shapes to prove the retry / clean-report / fail-loud paths actually
//    work, before spending time on the real TRIALS below — a regression here fails fast with a clear label.
{
  const makeFlakyExec = (failCount) => {
    let calls = 0;
    return () => {
      calls++;
      if (calls <= failCount) {
        const err = new Error("Command failed");
        err.status = 1;
        err.stderr = Buffer.from(""); // transient: the process died, no git-level error text
        throw err;
      }
      return "injected-success-output";
    };
  };

  const recovered = execGitIntegrity(".", "self-test-a", "self-test: transient-recovers", makeFlakyExec(GIT_TRANSIENT_RETRIES - 1));
  check("[self-test] transient exec failure within the retry budget recovers", recovered === "injected-success-output");

  let bExc = null;
  try { execGitIntegrity(".", "self-test-b", "self-test: transient-exhausts", makeFlakyExec(GIT_TRANSIENT_RETRIES + 5)); }
  catch (e) { bExc = e; }
  check("[self-test] persistent transient failure throws GitIntegrityError, not a raw execSync stack", bExc instanceof GitIntegrityError);
  check("[self-test] persistent transient failure is labeled transient:true", bExc?.transient === true);
  check("[self-test] persistent transient failure names the subprocess + label in its message", typeof bExc?.message === "string" && bExc.message.includes("self-test: transient-exhausts"));

  let cCalls = 0;
  const genuineExec = () => {
    cCalls++;
    const err = new Error("Command failed");
    err.status = 128;
    err.stderr = Buffer.from("fatal: bad object deadbeef\n"); // genuine git-level error
    throw err;
  };
  let cExc = null;
  try { execGitIntegrity(".", "self-test-c", "self-test: genuine-error", genuineExec); }
  catch (e) { cExc = e; }
  check("[self-test] genuine git error (fatal: on stderr) throws GitIntegrityError immediately", cExc instanceof GitIntegrityError);
  check("[self-test] genuine git error is labeled transient:false (never retried, never swallowed)", cExc?.transient === false);
  check("[self-test] genuine git error is NOT retried — fails on the first attempt", cCalls === 1);
  check("[self-test] genuine git error message carries the real git stderr", typeof cExc?.message === "string" && cExc.message.includes("bad object deadbeef"));
}

const TRIALS = 15;
const tmpDirs = [];

function makeTrialRepo(sfx) {
  const repo = path.join(os.tmpdir(), `loom-mrm-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mrm@loom && git config user.name mrm && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, sfx) {
  const wt = path.join(os.tmpdir(), `loom-mrm-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  for (let t = 0; t < TRIALS; t++) {
    const sfx = `${Date.now()}-${t}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeTrialRepo(sfx);
    const mainlineBase = git(repo, "rev-parse HEAD"); // pre-merge tip both branches forked from — this test
    // never advances main mid-trial, so this coincides with each landed commit's own sha^ (the LANDED base
    // the Loom-Worker-PathSet digest is actually computed from post-756a2cd8 — see the confinement check
    // below, which reasons from the branch's OWN diff, not from the trailer's recorded base).
    makeWorktree(repo, "loom/branch-a", "file-a.txt", `a-content-${sfx}\n`, sfx);
    makeWorktree(repo, "loom/branch-b", "file-b.txt", `b-content-${sfx}\n`, sfx);

    const [resA, resB] = await Promise.all([
      mergeBranch(repo, "loom/branch-a", "Card A title"),
      mergeBranch(repo, "loom/branch-b", "Card B title"),
    ]);

    check(`[trial ${t}] op A succeeded (mutex: no more losing to index contention)`, resA.ok === true);
    check(`[trial ${t}] op B succeeded (mutex: no more losing to index contention)`, resB.ok === true);

    // ── (2) Content-integrity sweep over the WHOLE resulting history: for every Loom-Worker-Branch
    //    trailer commit, the trailer's own branch content must be genuinely present in THAT commit's tree.
    //    This is the structural "impossible to cross-corrupt" proof, not a re-check of one interleaving.
    const log = git(repo, `--no-pager log --format=%H`);
    const shas = log.split("\n").filter(Boolean);
    let trailerCommitsChecked = 0;
    for (const sha of shas) {
      let msg;
      try {
        msg = execGitIntegrity(repo, `--no-pager log -1 --format=%B ${sha}`, `git log -1 --format=%B ${sha.slice(0, 7)} (:97)`);
      } catch (e) {
        if (e instanceof GitIntegrityError && e.transient) {
          check(`[trial ${t}] commit ${sha.slice(0, 7)}: ${e.message}`, false);
          continue;
        }
        throw e; // genuine git error (e.g. fatal:/bad object) — fail loudly, never swallowed.
      }
      const m = msg.match(/^Loom-Worker-Branch:\s*(\S+)/m);
      if (!m) continue;
      trailerCommitsChecked++;
      const branch = m[1];
      const expectedFile = branch === "loom/branch-a" ? "file-a.txt" : "file-b.txt";

      let ownContent;
      try {
        ownContent = execGitIntegrity(repo, `show ${sha}:${expectedFile}`, `git show ${sha.slice(0, 7)}:${expectedFile} (:104)`);
      } catch (e) {
        if (e instanceof GitIntegrityError && e.transient) {
          check(`[trial ${t}] commit ${sha.slice(0, 7)}: ${e.message}`, false);
          continue;
        }
        ownContent = null; // genuine error (e.g. path does not exist in this commit) — a real integrity signal; the check below fails loudly on it.
      }
      check(`[trial ${t}] commit ${sha.slice(0, 7)} (trailer ${branch}) contains ITS OWN file ${expectedFile}`, ownContent !== null);

      let branchTipContent;
      try {
        branchTipContent = execGitIntegrity(repo, `show ${branch}:${expectedFile}`, `git show ${branch}:${expectedFile} (:108)`);
      } catch (e) {
        if (e instanceof GitIntegrityError && e.transient) {
          check(`[trial ${t}] commit ${sha.slice(0, 7)}: ${e.message}`, false);
          continue;
        }
        throw e;
      }
      // The corruption's exact shape: the trailer's file is present, but the content is the WRONG branch's
      // — so compare directly against that branch's own tip content, not just presence of the path.
      check(`[trial ${t}] commit ${sha.slice(0, 7)}'s ${expectedFile} content MATCHES branch ${branch}'s own tip (not swapped)`, ownContent === branchTipContent);

      // ── CONFINEMENT (card 9f776570): the two checks above only assert the trailer's OWN file is present
      //    and correct — a commit carrying its own file AND a FOREIGN one (the zero-concurrency corruption
      //    reproduced in card 9e77050f) passes both of them. Assert the landed commit's diff path set is
      //    EXACTLY the branch's own changed-file set, checked here against the commit's own diffstat —
      //    independent of (and not asserting anything about) whatever base Loom-Worker-PathSet itself was
      //    stamped from; `mainlineBase` is used here only because it equals `sha^` in this test's no-main-
      //    advance shape, not because it's what the trailer records.
      let statOut;
      try {
        statOut = execGitIntegrity(repo, `show --stat --format= ${sha}`, `git show --stat ${sha.slice(0, 7)} (:115)`);
      } catch (e) {
        if (e instanceof GitIntegrityError && e.transient) {
          check(`[trial ${t}] commit ${sha.slice(0, 7)}: ${e.message}`, false);
          continue;
        }
        throw e;
      }
      const commitPaths = statOut
        .split("\n")
        .map((line) => { const m = line.match(/^\s*(.+?)\s*\|\s*\d/); return m ? m[1] : null; })
        .filter(Boolean)
        .sort();

      let diffOut;
      try {
        diffOut = execGitIntegrity(repo, `diff --name-only --no-renames ${mainlineBase}..${branch}`, `git diff ${mainlineBase.slice(0, 7)}..${branch} (:120)`);
      } catch (e) {
        if (e instanceof GitIntegrityError && e.transient) {
          check(`[trial ${t}] commit ${sha.slice(0, 7)}: ${e.message}`, false);
          continue;
        }
        throw e;
      }
      const branchPaths = diffOut.split("\n").map((s) => s.trim()).filter(Boolean).sort();

      check(`[trial ${t}] commit ${sha.slice(0, 7)}'s diff is CONFINED to ${branch}'s own path set ` +
        `${JSON.stringify(branchPaths)} (got ${JSON.stringify(commitPaths)}, no foreign file)`,
        JSON.stringify(commitPaths) === JSON.stringify(branchPaths));
    }
    check(`[trial ${t}] both trailer commits were found and checked`, trailerCommitsChecked === 2);

    // ── (3) No content lost: both files present somewhere in final HEAD tree.
    const finalTree = git(repo, "ls-tree -r --name-only HEAD");
    check(`[trial ${t}] file-a.txt present in final tree`, finalTree.includes("file-a.txt"));
    check(`[trial ${t}] file-b.txt present in final tree`, finalTree.includes("file-b.txt"));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — ${TRIALS} concurrent-merge trials produced zero cross-branch content corruption; the per-repo mutex closes the incident's silent-data-loss race.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
