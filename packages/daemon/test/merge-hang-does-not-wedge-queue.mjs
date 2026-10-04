import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 44c28799 — `mergeBranchLocked`'s git client was UNBOUNDED (`simpleGit(repoPath)`, no
// block-timeout, no `withTimeout` race) despite running INSIDE the per-repo merge mutex (card e076d2a2 /
// commit efeddcd). `withCanonicalIndexLock` sequences callers via `prior.then(fn, fn)`, which only advances once
// `fn`'s promise SETTLES — so a hung git child inside `mergeBranchLocked` (the card's own cited path: a
// wedged pre-commit/commit-msg hook) never settling meant the WHOLE per-repo merge queue wedged
// PERMANENTLY, not just the one op: every later merge attempt against that repo would await a promise
// chain rooted in a call that never returns, with no recovery short of a daemon restart.
//
// This induces a REAL hang — a genuine `git commit` child process blocked inside an actual pre-commit
// hook, not a mocked/injected promise — so the proof exercises the ACTUAL production code path (real
// `simple-git` spawn, real block-timeout kill, real repo state afterward), matching how a wedged hook
// would hang in production. The hook hangs ONLY when the staged commit carries branch-a's file
// (`file-a.txt`), so op1's commit hangs and op2's (branch-b, never `file-a.txt`) passes instantly — a
// CONTENT-keyed discriminator, letting the SECOND merge below be a real, un-hung commit.
//
// Card 755afc26 (this revision): 484e68f1 made every mutating canonical git call KILL-CONFIRMED
// (`killableCanonicalRaw`/`spawnCanonicalGitTree`, `git/bounded.ts`, @decision 24c0bdba) — a commit whose
// kill can't be POSITIVELY CONFIRMED dead now quarantines the canonical repo instead of releasing the lock
// optimistically. That changed what "op2 still succeeds" can mean: it depends on whether op1's OWN kill
// was confirmed. VERIFIED on this host (direct probing against the real dist build, see the worker's own
// report for the raw traces): a plain `sh`-invoked `sleep` hook — the ORIGINAL scenario below, no
// deliberate double-forking — is reproducibly UNCONFIRMABLE on Windows: `taskkill /pid <git.exe> /T /F`
// reports success and the reported PIDs it kills never include the actual `sleep.exe` descendant (an MSYS
// fork-emulation process-tree-tracking gap, not a timing race — raising the op's own timeout budget does
// NOT change the outcome, confirmed by direct measurement). That is NOT the contrived double-forked escape
// `test/merge-commit-kill-confirm.mjs`'s own scenario 5 already covers end-to-end (raise/quarantine/
// auto-clear/recovery) — it is the SAME accepted residual the decision record already documents ("a hook
// tail that... holds the stdio pipe open indefinitely gives no close signal on Windows at all... only a
// human... can clear it"), just reached by an ordinary hook shape, not a deliberately engineered one. So
// SCENARIO A below asserts the one thing this file is actually about — the QUEUE never wedges (op2 is
// always ADMITTED promptly, never left waiting on op1) — and treats op2's OWN outcome (succeed vs.
// refused-by-quarantine) as CONDITIONAL on what actually happened to op1's kill, logging both for
// diagnosis rather than hard-asserting a platform-specific outcome this file does not own proving.
// SCENARIO B (new) adds the unconditional positive case the card's own DoD calls for: a hook that hangs
// via a plain `node` child (a native executable on every platform — no MSYS/posix-fork-emulation escape)
// is RELIABLY kill-confirmed, so the repo is never quarantined and a subsequent merge for a different
// branch of the same repo STILL LANDS — the original, pre-quarantine contract this file was written to
// prove, still true for a hook whose death the tree-kill can actually confirm.
//
// RED PROOF (original defect, card 44c28799 — see the worker's own report for the exact observed output):
// reverting ONLY `git/worktrees.ts` and re-running this file's mutex-queue assertion shows op1 taking the
// hook's FULL sleep duration instead of settling near its configured bound, AND op2 never even starting
// within the guard window — the mutex genuinely wedged, exactly the defect that fix closes.
// RED PROOF (this revision, card 755afc26): on clean main 5e209f5a (484e68f1 landed, the test unchanged),
// scenario A's OLD unconditional "[op2] the subsequent merge actually SUCCEEDED" assertion failed — op1's
// kill was genuinely unconfirmed (verified directly, not inferred) and the canonical repo was correctly
// quarantined, refusing op2 for a reason this file's old assertions had no way to express as a PASS.
// Run: 1) build daemon (pnpm build), 2) node test/merge-hang-does-not-wedge-queue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df): this file calls the REAL mergeBranch() with a short timeoutMs on repos
// whose kill may go unconfirmed (see header above) — an unconfirmed kill raises a REAL
// enterMergeQuarantine(), which persists a durable latch file under LOOM_HOME. Running this file bare
// (no harness) with LOOM_HOME unset used to write that latch straight into the real ~/.loom — exactly the
// `loom-mhdwq-*-repo-*` / `loom/hang-a` latches found at a real boot (card 500fe2df). Isolate BEFORE the
// dist import below, same as every other hermetic test in this suite.
useOwnLoomHome("loom-mhdwq-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mhdwq@loom -c user.name=mhdwq";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const HOOK_SLEEP_S = 20; // long enough to be unambiguously distinct from BOUND_MS (card cc595ca7: a
                          // BOUND_MS=500 op reached 3013ms under the full suite's ~540-concurrent-git
                          // contention — a ~6x inflation over its own bound — so the REAL discriminator
                          // below, `op1ElapsedMs < HOOK_SLEEP_S * 1000`, needs generous headroom over that
                          // observed inflation, not just over BOUND_MS itself); short enough that an
                          // orphaned hook process (if the block-timeout kill fires mid-sleep) self-exits
                          // quickly rather than lingering — no PID-tracking cleanup needed. Raising this
                          // is FREE on the green path: op1 is still killed at its own real BOUND_MS
                          // regardless of how long the hook would sleep, and op2 never waits on the sleep
                          // at all (content-gated: op2's staged tree has no file-a.txt).
const BOUND_MS = 500; // this op's own configured timeout — comfortably < HOOK_SLEEP_S so the split is
                       // unambiguous, and comfortably > typical real-op latency so it isn't itself flaky.
                       // VERIFIED this revision: raising this does NOT make scenario A's kill confirmable
                       // (measured directly at 500 and 5000 — op1 settles at ~2x whatever this is, always
                       // via the give-up path, never via a real confirmation) — the escape is structural
                       // (an MSYS fork-emulation process-tree-tracking gap on Windows), not a timing race,
                       // so this value is sized only for "op1 doesn't wait out the full hook", same as ever.
const GUARD_MS = 30_000; // this TEST's own patience for "did the op ever settle" — deliberately ABOVE
                          // HOOK_SLEEP_S*1000 (unlike the old 3000ms, which sat BELOW the hook's own
                          // 5000ms duration and gave zero headroom for suite contention). Above the hook's
                          // envelope, a genuinely wedged-but-finite op (this test's hook always exits on
                          // its own) still settles for REAL instead of getting cut off into an opaque
                          // "guard fired" sentinel — so the actual regression check, the elapsed-vs-
                          // HOOK_SLEEP_S comparison below, is what fails (with real numbers), not a race
                          // artifact. GUARD_MS only exists as a backstop against a truly non-terminating
                          // promise (this test's own patience), not as the regression signal itself.

const tmpDirs = [];
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-mhdwq-${label}-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mhdwq@loom && git config user.name mhdwq && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, label, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-mhdwq-${label}-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// Installed ONLY after both worktrees' own setup commits are done — hooks are SHARED across a repo and
// its worktrees (the common git dir), so installing this any earlier would also hang the worktrees' own
// initial commits above (observed directly: a `touch`-into-a-gitlink-file "Not a directory" warning from
// inside a worktree, since a worktree's `.git` is a FILE, not a directory — confirmed by testing this
// exact ordering bug before finalizing this file). Written via plain fs calls (no bash chmod — Git for
// Windows invokes a shebang script via its bundled sh regardless of the exec bit; chmod is for POSIX hosts).
// A plain, un-engineered `sh`-invoked `sleep` — see this file's own header for why this specific shape is
// VERIFIED unconfirmable on Windows (an MSYS fork-emulation tree-tracking gap), not a contrived escape.
function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif git diff --cached --name-only | grep -q '^file-a.txt$'; then\n  sleep ${HOOK_SLEEP_S}\nfi\nexit 0\n`);
  fs.chmodSync(hookPath, 0o755);
}

// A hang via a plain `node` CHILD instead of an MSYS POSIX binary — VERIFIED this revision (direct
// probing, see the worker's own report) to be RELIABLY kill-confirmed by `taskkill /T /F` on Windows
// (node.exe is a native executable `sh.exe` CreateProcess's directly, no MSYS fork-emulation involved),
// and equally reliable on POSIX (a normal child in the same process group, killed by the group SIGKILL).
// The absolute `node` path is threaded in as a real Windows path (not MSYS-translated) via a plain
// double-quoted argv element — `sh` passes it straight through to CreateProcess without reinterpreting it.
function installConfirmableHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const nodePath = process.execPath.replace(/\\/g, "/");
  fs.writeFileSync(hookPath,
    `#!/bin/sh\nif git diff --cached --name-only | grep -q '^file-a.txt$'; then\n  "${nodePath}" -e "setTimeout(function(){},${HOOK_SLEEP_S * 1000})"\nfi\nexit 0\n`);
  fs.chmodSync(hookPath, 0o755);
}

// Races `promise` against a `ms`-bounded sentinel so this test's own runner can never hang forever even
// if the op under test genuinely never settles (the pre-fix behavior) — a fired guard reads as "not
// admitted within any reasonable window", not a real pass/fail ambiguity.
const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

try {
  // ===== SCENARIO A — an ordinary, un-engineered real hang. The QUEUE invariant (op2 is always admitted
  // promptly) is this file's actual subject and is asserted unconditionally; op2's OWN outcome depends on
  // whether op1's kill happened to be confirmable on this host, and is asserted conditionally + logged. =====
  const repoA = makeRepo("a");
  makeWorktree(repoA, "a", "loom/hang-a", "file-a.txt", `a-content-${sfx}\n`);
  makeWorktree(repoA, "a", "loom/hang-b", "file-b.txt", `b-content-${sfx}\n`);
  installHangingHook(repoA);

  // Op1: its own `git commit` (landing branch-a's squash) hits the REAL hung hook. Fired first so it
  // acquires the per-repo mutex first — this is the exact hang the card describes.
  const t0 = performance.now(); // MONOTONIC (survives an NTP/backward clock step; see test/worktrees.mjs)
  const op1 = mergeBranch(repoA, "loom/hang-a", "Card A title", { timeoutMs: BOUND_MS });

  // Op2: fired immediately after, for a DIFFERENT branch of the SAME repo — real git, default deps.
  // withCanonicalIndexLock queues this behind op1 (same canonical repo path). op2's staged tree never
  // contains file-a.txt, so its commit passes the hook instantly and is a normal, unhung merge whether or
  // not op1's hook got to run before op1's kill.
  const op2 = mergeBranch(repoA, "loom/hang-b", "Card B title");

  const op1Result = await Promise.race([op1, guard(GUARD_MS, "op1")]);
  const op1ElapsedMs = performance.now() - t0;
  check(`[A/op1] the op whose commit hit a REAL hung pre-commit hook settles on its own within its bounded timeout (${Math.round(op1ElapsedMs)}ms, cap ~${BOUND_MS}ms) — not left hanging for the hook's full ${HOOK_SLEEP_S}s`,
    op1Result?.__guardFired !== "op1" && op1ElapsedMs < HOOK_SLEEP_S * 1000);
  check("[A/op1] the hung op reports failure (never a false success)", op1Result?.ok === false);

  const t1 = performance.now();
  const op2Result = await Promise.race([op2, guard(GUARD_MS, "op2")]);
  const op2ElapsedMs = performance.now() - t1;
  check(`[A/op2] a SUBSEQUENT merge for a DIFFERENT branch of the SAME repo is still ADMITTED (settled in ${Math.round(op2ElapsedMs)}ms) — not wedged behind op1's hang`,
    op2Result?.__guardFired !== "op2");
  // DoD (card 755afc26): print op2's actual result/reason unconditionally — this is what tells a reader
  // (and a future maintainer) which branch of the conditional below actually fired on a given host.
  console.log(`[A/op2] info: ${JSON.stringify({ ok: op2Result?.ok, reason: op2Result?.reason })}`);
  const QUARANTINE_RE = /QUARANTINED/;
  if (op2Result?.ok === true) {
    // op1's kill WAS confirmed on this host — no quarantine was raised, so op2 landed normally. Verify
    // it's a REAL, correctly-labeled merge, not a vacuous pass.
    const finalTree = git(repoA, "ls-tree -r --name-only HEAD");
    check("[A/op2] (kill confirmed) branch-b's file landed in the canonical repo", finalTree.includes("file-b.txt"));
    check("[A/op2] (kill confirmed) branch-a's file did NOT land (its op failed/timed out, never silently committed)", !finalTree.includes("file-a.txt"));
    const log = git(repoA, "--no-pager log --format=%B");
    check("[A/op2] (kill confirmed) the landed commit carries branch-b's own trailer", log.includes("Loom-Worker-Branch: loom/hang-b"));
  } else {
    // op1's kill could NOT be confirmed — the canonical repo is correctly quarantined (@decision 24c0bdba)
    // and op2 is refused for THAT reason specifically, never a vacuous/unrelated failure.
    check("[A/op2] (kill unconfirmed) op2 is refused by the QUARANTINE specifically, not a generic/vacuous failure",
      QUARANTINE_RE.test(op2Result?.reason ?? ""));
    const finalTree = git(repoA, "ls-tree -r --name-only HEAD");
    check("[A/op2] (kill unconfirmed) neither branch's file landed — the canonical repo is untouched by the refused op",
      !finalTree.includes("file-a.txt") && !finalTree.includes("file-b.txt"));
  }
  check("[A/repo] no stale index.lock left behind by the killed hung commit", !fs.existsSync(path.join(repoA, ".git", "index.lock")));

  // ===== SCENARIO B — a hang whose tree-kill IS reliably confirmable (a `node` child, not an MSYS POSIX
  // binary). Proves the card's own DoD positive case: a well-behaved hook's kill being confirmed means the
  // repo is never quarantined and a subsequent merge for a different branch still lands, unconditionally. =====
  const repoB = makeRepo("b");
  makeWorktree(repoB, "b", "loom/hang-a", "file-a.txt", `a-content-${sfx}\n`);
  makeWorktree(repoB, "b", "loom/hang-b", "file-b.txt", `b-content-${sfx}\n`);
  installConfirmableHangingHook(repoB);

  const t2 = performance.now();
  const op1B = mergeBranch(repoB, "loom/hang-a", "Card A title", { timeoutMs: BOUND_MS });
  const op2B = mergeBranch(repoB, "loom/hang-b", "Card B title");

  const op1BResult = await Promise.race([op1B, guard(GUARD_MS, "op1B")]);
  const op1BElapsedMs = performance.now() - t2;
  check(`[B/op1] the op whose commit hit a CONFIRMABLE hung pre-commit hook settles within its bounded timeout (${Math.round(op1BElapsedMs)}ms, cap ~${BOUND_MS}ms)`,
    op1BResult?.__guardFired !== "op1B" && op1BElapsedMs < HOOK_SLEEP_S * 1000);
  check("[B/op1] the hung op reports failure (never a false success)", op1BResult?.ok === false);
  check("[B/op1] op1's kill was CONFIRMED — no quarantine wording in its own failure reason",
    !QUARANTINE_RE.test(op1BResult?.reason ?? ""));

  const t3 = performance.now();
  const op2BResult = await Promise.race([op2B, guard(GUARD_MS, "op2B")]);
  const op2BElapsedMs = performance.now() - t3;
  console.log(`[B/op2] info: ${JSON.stringify({ ok: op2BResult?.ok, reason: op2BResult?.reason })}`);
  check(`[B/op2] a SUBSEQUENT merge for a DIFFERENT branch of the SAME repo is still ADMITTED (settled in ${Math.round(op2BElapsedMs)}ms) — not wedged behind op1's hang`,
    op2BResult?.__guardFired !== "op2B");
  check("[B/op2] the subsequent merge actually SUCCEEDED — a confirmed kill never quarantines the repo", op2BResult?.ok === true);

  const finalTreeB = git(repoB, "ls-tree -r --name-only HEAD");
  check("[B/op2] branch-b's file landed in the canonical repo", finalTreeB.includes("file-b.txt"));
  check("[B/op2] branch-a's file did NOT land (its op failed/timed out, never silently committed)", !finalTreeB.includes("file-a.txt"));
  const logB = git(repoB, "--no-pager log --format=%B");
  check("[B/op2] the landed commit carries branch-b's own trailer", logB.includes("Loom-Worker-Branch: loom/hang-b"));
  check("[B/repo] no stale index.lock left behind by the killed hung commit", !fs.existsSync(path.join(repoB, ".git", "index.lock")));
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup (an orphaned
      hook process may still hold the dir briefly on Windows until its own bounded sleep elapses) */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL hung git commit inside mergeBranchLocked fails its OWN op within its bounded timeout; a subsequent merge for the same repo is always ADMITTED (never wedged behind it), landing when the kill is confirmed and refused by the quarantine specifically when it is not."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
