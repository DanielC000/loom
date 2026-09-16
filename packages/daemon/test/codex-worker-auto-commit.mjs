import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CODEX WORKER AUTO-COMMIT test (board card 00a6cdd6, owner-approved via request 54aba8b2; Code Review
// amendments B1/B2/S1/S2/S3/S4). REAL git on temp repos, real subprocess (no mocked exec — see memory
// `real-spawn-smoke-for-subprocess-features`), NO claude/codex CLI and NO live daemon — drives
// SessionService.workerReport() (and, where a scenario needs a lower-level seam, attemptCodexAutoCommit
// directly) mirroring worker-report-precheck.mjs's in-process style.
//
// Proves (through workerReport):
//   (K1) ELIGIBLE codex worker, real dirty files (+ daemon `.claude/` noise) → auto-committed onto its
//        OWN branch, task → review, the FINAL worker_report event AND a DEDICATED codex_auto_commit
//        event both carry {sha,fileCount,subject}, the noise is NOT staged, and the subject comes from
//        the card TITLE with the summary in the body.
//   (K2) INELIGIBLE (claude-harness, the default) worker with the SAME dirty files → UNCHANGED behavior.
//   (K3) HEAD MISMATCH → refused with reason codex-head-mismatch, branch tip UNCHANGED.
//   (K4) ORDERING: eligible worker with BOTH queued manager direction AND dirty real files → refused via
//        the EXISTING pending-direction precheck, branch tip UNCHANGED.
//   (K5) ANOMALY — nested `sub/.gitattributes` → skipped, falls through to the uncommitted refusal.
//   (K6) ANOMALY — symlink escaping the worktree → same shape as K5. SKIPPED (never a false PASS) where
//        the host can't create symlinks without privilege.
//   (K7) HOOKS (B2 fix) — `core.hooksPath` points at `os.devNull`, a non-directory: a real hook planted
//        in the repo's own `.git/hooks/post-commit` does not fire, add/commit still succeed, and a
//        PLANTER (a gitFactory that writes a REAL, 0o755-executable hook AT the configured hooksPath
//        location between `add` and `commit`, checking presence IMMEDIATELY — before `commit` runs and
//        long before any cleanup — so a silently-skipped plant can't make this pass vacuously) cannot
//        land anything there. THIS PATH IS PLATFORM-PROVEN TWICE, independently: Windows (this test,
//        this repo) and POSIX (a second Code Reviewer, WSL Ubuntu, real git 2.34.1 — `add`/`commit` both
//        return 0 and neither a `post-commit` nor a `reference-transaction` hook fires; their own
//        control fired both). The plant attempt itself fails, because you
//        cannot create a file "under" a device path.
//   (K8) fsmonitor — every WORKING-TREE-SCANNING git.raw call carries `-c core.fsmonitor=false` (the
//        one call that does NOT need it, the final plain `rev-parse HEAD`, correctly lacks it).
//   (K9) NOCHANGES (B1 fix) — `report.noChanges:true` with real dirty files present → auto-commit is
//        SKIPPED entirely (never even attempted), the ordinary uncommitted refusal fires instead, branch
//        tip UNCHANGED.
//  (K10) THROW-AFTER-COMMIT (B1 fix) — `db.updateTask` is made to throw AFTER a successful auto-commit
//        (the manager's "or an updateTask/appendEvent throw" alternative to reproducing the race by
//        timing): workerReport propagates the throw, the final worker_report event is NEVER written,
//        but the DEDICATED codex_auto_commit event — appended immediately, before updateTask runs —
//        already durably exists, proving "no daemon-authored commit exists without an event naming it"
//        holds even when something downstream blows up.
//  (K11) RACE (attemptCodexAutoCommit + precheckWorkerDone boundary, deterministic via an injected
//        gitFactory — no real timing dependency): a file appears on disk DURING attemptCodexAutoCommit's
//        own status read (simulating a concurrent background process), so it's absent from what gets
//        staged; the function still reports committed:true for the file it DID see, and a SEPARATE
//        precheckWorkerDone call against the SAME worktree afterward correctly still finds the tree
//        dirty — the exact shape that would make workerReport's `precheck.uncommitted` refusal fire
//        AFTER a successful commit, which is why that refusal's own appendEvent (service.ts) folds
//        `codexAutoCommit` into its detail too (see K1's dedicated-event check for the primary proof;
//        this is the underlying mechanism, proven at the two functions' own boundary since reproducing
//        the exact end-to-end timing through workerReport itself would be a flaky, real-clock race).
//  (K12) B1 RESIDUAL (i) — `commit` succeeds but the post-commit `rev-parse HEAD` rejects: recovered as
//        `committed:true` with the REAL sha (via a fresh HEAD re-read against the pre-commit baseline),
//        never silently reported as `committed:false` (which on the prior commit would have let
//        workerReport's fall-through precheck see a clean tree and accept the done with no audit trail).
//  (K13) B1 RESIDUAL (ii) — `commit` itself fails AND the recovery re-read is ALSO unreadable:
//        `commitStateUnknown:true`, fail CLOSED — never a plain `committed:false` a caller could read
//        as safe to fall through on. Both K12 and K13's injected gitFactories target "the first bare
//        `rev-parse HEAD` call issued AFTER `commit` was attempted" — never a hardcoded call-COUNT.
//        That distinction is itself load-bearing, found the hard way: a first draft counted occurrences
//        from the start and rejected "the 2nd one", which happened to be correct against the FIXED
//        code (which has an extra pre-commit rev-parse call ahead of the target) but silently never
//        fired at all against 79b3e65a's shape (no pre-commit call, so every later index shifts by
//        one) — a vacuous, wrongly-"passing" negative control, the exact defect class this whole round
//        is about. Confirmed BOTH ways locally: reverted this function's commit/recovery block to
//        79b3e65a's shape (temporarily, via Edit + a from-backup restore, never committed) and reran —
//        with the count-based factories that FIRST version of K12 falsely stayed green; with these
//        occurred-after-commit-attempt factories, BOTH K12 and K13 correctly go red. Restored, rebuilt
//        (clearing tsconfig.tsbuildinfo each time — see project memory on that cache's own gotcha),
//        and reconfirmed green against the real fix before this file was committed.
//   (gitlink) an untracked directory carrying its OWN `.git` (a nested repo) is refused, never staged —
//        `git add` on it would record a gitlink (a tree entry pointing at the nested repo's own commit),
//        never real, reviewable content.
//   (gitmv) a REAL, STAGED `git mv` (both halves already in the index) is the only shape that produces
//        `parseAutoCommitStatusZ`'s combined `R`/`C` two-field record — the S1 rename test below is a
//        plain filesystem move instead, which arrives as two independent `D`/`??` records.
//
// Proves (through attemptCodexAutoCommit / boundConventionalSubject directly, lower-level seams):
//  (S1) non-ASCII (`café.txt`), a space in a name, a name containing the literal substring `" -> "`, and
//       a real filesystem RENAME are all staged and committed correctly (git status --porcelain -z).
//  (S2) a candidate literally named `*` is staged as ITSELF, never glob-expanded (`--literal-pathspecs`).
//       SKIPPED where the filesystem refuses a file named `*` (Windows/NTFS).
//  (S3) a DANGLING symlink (target doesn't exist) whose link TEXT points outside the worktree is still
//       refused — `realpathSync`'s ENOENT for the missing TARGET must never be read as "nothing to
//       check" (that's the ENOENT for the CANDIDATE PATH ITSELF, a genuine deletion, a different case).
//       SKIPPED where the host can't create symlinks without privilege.
//  (S4) `boundedSimpleGit`'s shared `unsafe` allowlist is UNCHANGED for a caller that doesn't opt in:
//       a plain call (no `extraUnsafe`) still gets simple-git's OWN refusal for `-c core.hooksPath=…`;
//       only a caller that explicitly passes `extraUnsafe` (as attemptCodexAutoCommit's own factory
//       does) gets it allowed — proving the fix is scoped, not a global widening.
// Run: 1) build daemon (pnpm build), 2) node test/codex-worker-auto-commit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cac-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, attemptCodexAutoCommit, boundConventionalSubject, precheckWorkerDone } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
let skipped = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const skip = (label, reason) => { console.log(`SKIP  ${label} — ${reason}`); skipped++; };
const GIT_ID = "-c user.email=cac@loom -c user.name=cac";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p) {
  db.insertProject({ id: p.projId, name: "CAC", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: p.taskTitle ?? "CAC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({
    id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath,
    processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch,
    harness: p.harness,
  });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# cac\n");
  execSync(`git init -q && git config user.email cac@loom && git config user.name cac`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function headSha(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}

function canCreateSymlinks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cac-symprobe-"));
  try {
    fs.writeFileSync(path.join(dir, "target.txt"), "x");
    fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function canCreateFileNamed(dir, name) {
  try {
    fs.writeFileSync(path.join(dir, name), "x");
    return true;
  } catch {
    return false;
  }
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag, extra = {}) => ({
  projId: `cac-${tag}-proj-${sfx}`, agentId: `cac-${tag}-ag-${sfx}`, taskId: `cac-${tag}-task-${sfx}`,
  mgrId: `cac-${tag}-mgr-${sfx}`, workerId: `cac-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cac-${tag}-${sfx}`), ...extra,
});
const K1 = mk("k1", { file: "real-work.txt", harness: "codex", taskTitle: "fix(daemon): repro card K1 title" });
const K2 = mk("k2", { file: "real-work.txt", harness: undefined });
const K3 = mk("k3", { harness: "codex" });
const K4 = mk("k4", { file: "real-work.txt", harness: "codex" });
const K5 = mk("k5", { harness: "codex" });
const K6 = mk("k6", { harness: "codex" });
const K9 = mk("k9", { file: "real-work.txt", harness: "codex" });
const K10 = mk("k10", { file: "real-work.txt", harness: "codex" });
const all = [K1, K2, K3, K4, K5, K6, K9, K10];

try {
  // ── (K1) ELIGIBLE codex worker, real + noise dirty files → AUTO-COMMITTED, task→review ────────────
  initRepo(K1.repo);
  { const { worktreePath, branch } = await createWorktree(K1.repo, K1.projId, K1.taskId); K1.worktreePath = worktreePath; K1.branch = branch; }
  const preCommitSha = headSha(K1.worktreePath);
  fs.writeFileSync(path.join(K1.worktreePath, K1.file), "real codex-authored change\n");
  fs.mkdirSync(path.join(K1.worktreePath, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(K1.worktreePath, ".claude", "skills", "noise.md"), "injected\n");
  seed(K1);
  const rK1 = await sessions.workerReport(K1.workerId, { status: "done", summary: "did the real work\nsecond line of detail" });
  check("(K1) workerReport → reported:true, NOT refused", rK1.reported === true && !rK1.refused);
  check("(K1) task moved to review", db.getTask(K1.taskId).columnKey === "review");
  const postCommitSha = headSha(K1.worktreePath);
  check("(K1) a NEW commit landed on the worktree", postCommitSha !== preCommitSha);
  const k1Committed = execFileSync("git", ["show", "--stat", "--format=", postCommitSha], { cwd: K1.worktreePath }).toString();
  check("(K1) the real file is in the auto-commit", k1Committed.includes(K1.file));
  check("(K1) the .claude/ noise is NOT in the auto-commit", !k1Committed.includes(".claude"));
  const k1Subject = execFileSync("git", ["log", "-1", "--format=%s", postCommitSha], { cwd: K1.worktreePath }).toString().trim();
  check("(K1) subject is the CARD TITLE, not a chore:-prefixed summary derivation", k1Subject === K1.taskTitle);
  const k1Body = execFileSync("git", ["log", "-1", "--format=%b", postCommitSha], { cwd: K1.worktreePath }).toString();
  check("(K1) body carries the full worker summary", k1Body.includes("did the real work") && k1Body.includes("second line of detail"));
  const k1Event = db.listEvents(K1.mgrId).find((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done");
  check("(K1) worker_report event carries codexAutoCommit{sha,fileCount,subject}",
    !!k1Event?.detail?.codexAutoCommit && k1Event.detail.codexAutoCommit.sha === postCommitSha
    && k1Event.detail.codexAutoCommit.fileCount === 1 && k1Event.detail.codexAutoCommit.subject === K1.taskTitle);
  const k1AuditEvent = db.listEvents(K1.mgrId).find((e) => e.kind === "codex_auto_commit");
  check("(K1) a DEDICATED codex_auto_commit audit event exists (Code Review B1)",
    !!k1AuditEvent && k1AuditEvent.detail?.sha === postCommitSha && k1AuditEvent.detail?.fileCount === 1);
  check("(K1) NO worker_report_rejected event (nothing was refused)",
    !db.listEvents(K1.mgrId).some((e) => e.kind === "worker_report_rejected"));

  // ── (K2) INELIGIBLE (claude-harness, default) worker → UNCHANGED: refused, nothing committed ───────
  initRepo(K2.repo);
  { const { worktreePath, branch } = await createWorktree(K2.repo, K2.projId, K2.taskId); K2.worktreePath = worktreePath; K2.branch = branch; }
  const k2PreSha = headSha(K2.worktreePath);
  fs.writeFileSync(path.join(K2.worktreePath, K2.file), "claude worker forgot to commit\n");
  seed(K2);
  const rK2 = await sessions.workerReport(K2.workerId, { status: "done", summary: "I think I'm done" });
  check("(K2) claude-harness worker → refused uncommitted (byte-identical to pre-card behavior)", rK2.reported === false && rK2.refused === true);
  check("(K2) branch tip UNCHANGED — the new code path never touched this worktree", headSha(K2.worktreePath) === k2PreSha);

  // ── (K3) HEAD MISMATCH → refused, branch tip unchanged, no commit attempted ─────────────────────────
  initRepo(K3.repo);
  { const { worktreePath, branch } = await createWorktree(K3.repo, K3.projId, K3.taskId); K3.worktreePath = worktreePath; K3.branch = branch; }
  execFileSync("git", ["checkout", "-b", "not-the-assigned-branch"], { cwd: K3.worktreePath });
  fs.writeFileSync(path.join(K3.worktreePath, "stray.txt"), "codex can't have done this — simulating a Loom-side bug\n");
  const k3PreSha = headSha(K3.worktreePath);
  seed(K3);
  const rK3 = await sessions.workerReport(K3.workerId, { status: "done", summary: "done" });
  check("(K3) refused with reason codex-head-mismatch", rK3.reported === false && rK3.refused === true && /HEAD|branch/i.test(rK3.error));
  check("(K3) a worker_report_rejected(reason:codex-head-mismatch) event recorded",
    db.listEvents(K3.mgrId).some((e) => e.kind === "worker_report_rejected" && e.detail?.reason === "codex-head-mismatch"));
  check("(K3) branch tip UNCHANGED", headSha(K3.worktreePath) === k3PreSha);

  // ── (K4) ORDERING: pending manager direction + dirty real files → refused via the EXISTING ─────────
  //        pending-direction precheck, never reaching auto-commit at all.
  initRepo(K4.repo);
  { const { worktreePath, branch } = await createWorktree(K4.repo, K4.projId, K4.taskId); K4.worktreePath = worktreePath; K4.branch = branch; }
  fs.writeFileSync(path.join(K4.worktreePath, K4.file), "real work, but a redirect is queued\n");
  const k4PreSha = headSha(K4.worktreePath);
  seed(K4);
  db.appendEvent({
    id: "cac-k4-queued-msg", ts: now, managerSessionId: K4.mgrId, workerSessionId: K4.workerId, taskId: K4.taskId,
    kind: "session_message_queued", detail: { sender: K4.mgrId, text: "redirect: stop, do X instead", msgId: "cac-k4-msgid", resolved: false },
  });
  const rK4 = await sessions.workerReport(K4.workerId, { status: "done", summary: "done with the old plan" });
  check("(K4) refused via the PENDING-DIRECTION precheck (not codex-head-mismatch, not uncommitted)",
    rK4.reported === false && rK4.refused === true && /UNRESOLVED instruction/i.test(rK4.error));
  check("(K4) branch tip UNCHANGED — auto-commit never ran (it sits strictly after this precheck)", headSha(K4.worktreePath) === k4PreSha);
  check("(K4) NO codex_auto_commit event was ever written", !db.listEvents(K4.mgrId).some((e) => e.kind === "codex_auto_commit"));

  // ── (K5) ANOMALY — nested sub/.gitattributes (basename at ANY depth) → skipped ─────────────────────
  initRepo(K5.repo);
  { const { worktreePath, branch } = await createWorktree(K5.repo, K5.projId, K5.taskId); K5.worktreePath = worktreePath; K5.branch = branch; }
  const k5PreSha = headSha(K5.worktreePath);
  fs.mkdirSync(path.join(K5.worktreePath, "sub"), { recursive: true });
  fs.writeFileSync(path.join(K5.worktreePath, "sub", ".gitattributes"), "*.bin filter=evil\n");
  seed(K5);
  const rK5 = await sessions.workerReport(K5.workerId, { status: "done", summary: "done" });
  check("(K5) refused (uncommitted) with the auto-commit skip reason folded in", rK5.reported === false && rK5.refused === true && /human review/i.test(rK5.error));
  check("(K5) branch tip UNCHANGED — nothing was staged or committed", headSha(K5.worktreePath) === k5PreSha);

  // ── (K6) ANOMALY — symlink escaping the worktree → skipped (or SKIPPED the test, never a false PASS) ─
  initRepo(K6.repo);
  { const { worktreePath, branch } = await createWorktree(K6.repo, K6.projId, K6.taskId); K6.worktreePath = worktreePath; K6.branch = branch; }
  if (!canCreateSymlinks()) {
    skip("(K6) symlink-escape anomaly", "this host cannot create symlinks without elevated privilege (Windows without Developer Mode/admin)");
  } else {
    const k6PreSha = headSha(K6.worktreePath);
    const outsideTarget = path.join(os.tmpdir(), `loom-cac-outside-${sfx}.txt`);
    fs.writeFileSync(outsideTarget, "outside the worktree\n");
    fs.symlinkSync(outsideTarget, path.join(K6.worktreePath, "escape-link.txt"));
    seed(K6);
    const rK6 = await sessions.workerReport(K6.workerId, { status: "done", summary: "done" });
    check("(K6) refused (uncommitted) with the auto-commit skip reason folded in", rK6.reported === false && rK6.refused === true && /human review/i.test(rK6.error));
    check("(K6) branch tip UNCHANGED", headSha(K6.worktreePath) === k6PreSha);
    fs.rmSync(outsideTarget, { force: true });
  }

  // ── (K7) HOOKS (Code Review B2): core.hooksPath = os.devNull, never a real (plantable) directory ────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-k7-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-k7-proj-${sfx}`, `cac-k7-task-${sfx}`);
    const marker = path.join(os.tmpdir(), `loom-cac-k7-marker-${sfx}`);
    const hooksDirReal = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: worktreePath }).toString().trim();
    fs.mkdirSync(hooksDirReal, { recursive: true });
    fs.writeFileSync(path.join(hooksDirReal, "post-commit"), `#!/bin/sh\necho fired > "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 });

    fs.writeFileSync(path.join(worktreePath, "hook-test.txt"), "real work\n");
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "hook test" });
    check("(K7) auto-commit succeeded with the devNull hooksPath (add/commit both still work)", ac.committed === true);
    check("(K7) the repo's OWN real post-commit hook did NOT fire", !fs.existsSync(marker));

    // PLANTER (Code Review B2's explicit ask, TIGHTENED after a real reviewer finding — see below): a
    // gitFactory that, right BETWEEN the `add` and `commit` calls, tries to write an EXECUTABLE
    // (mode 0o755 — a non-executable hook is silently ignored by git on POSIX regardless of anything
    // this feature does, which is exactly what made an earlier version of this test vacuous) hook AT the
    // configured hooksPath location, and checks — IMMEDIATELY, inside the `.then()`, before `commit`
    // even runs and long before any cleanup — whether the write actually materialized a real file at
    // that exact path. Checking only AFTER the whole function returns was the second vacuousness bug:
    // the OLD (pre-B2) mkdtemp implementation deleted its own temp dir in a `finally`, so a check made
    // after return would find nothing there EITHER WAY, old code or new, proving nothing.
    fs.writeFileSync(path.join(worktreePath, "hook-test-2.txt"), "real work 2\n");
    const marker2 = path.join(os.tmpdir(), `loom-cac-k7-marker2-${sfx}`);
    let plantedPath;
    let plantAttempted = false;
    let plantLandedImmediately; // checked INSIDE the wrapper, before commit/cleanup — never after return
    const planterFactory = (repoPath, ms) => {
      const real = boundedSimpleGit(repoPath, ms, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true });
      return {
        raw: (args) => {
          const p = real.raw(args);
          if (Array.isArray(args) && args.includes("add")) {
            return p.then((v) => {
              plantAttempted = true;
              const hp = args.find((a) => typeof a === "string" && a.startsWith("core.hooksPath="))?.slice("core.hooksPath=".length);
              plantedPath = path.join(hp, "post-commit");
              try {
                fs.mkdirSync(hp, { recursive: true });
                fs.writeFileSync(plantedPath, `#!/bin/sh\necho fired > "${marker2.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
              } catch { /* POSIX: ENOTDIR — cannot create a file "under" a device path */ }
              // Checked NOW, synchronously, before commit runs and long before any cleanup exists.
              plantLandedImmediately = fs.existsSync(plantedPath);
              return v;
            });
          }
          return p;
        },
      };
    };
    const acPlant = await attemptCodexAutoCommit(worktreePath, branch, { summary: "planter test" }, { gitFactory: planterFactory });
    check("(K7 planter) the plant attempt genuinely ran (not a silently-skipped no-op)", plantAttempted === true);
    check("(K7 planter) auto-commit still succeeded despite the plant attempt", acPlant.committed === true);
    check("(K7 planter) nothing landed at the planted location, checked IMMEDIATELY (not after cleanup)", plantLandedImmediately === false);
    check("(K7 planter) the planted hook did NOT fire", !fs.existsSync(marker2));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (K8) fsmonitor: every WORKING-TREE-SCANNING git.raw call carries -c core.fsmonitor=false ────────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-k8-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-k8-proj-${sfx}`, `cac-k8-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "fsmonitor-test.txt"), "real work\n");
    const calls = [];
    const spyFactory = (repoPath, ms) => {
      const real = boundedSimpleGit(repoPath, ms, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true });
      return { raw: (args) => { calls.push(args); return real.raw(args); } };
    };
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "fsmonitor test" }, { gitFactory: spyFactory });
    check("(K8) auto-commit succeeded", ac.committed === true);
    // Two bare `rev-parse HEAD` calls exist by design (Code Review "B1 residual"): the pre-commit
    // baseline capture, and the post-commit recovery read — NEITHER scans the working tree, so neither
    // needs (or carries) the fsmonitor override.
    const bareShaReads = calls.filter((a) => a[0] === "rev-parse" && a[1] === "HEAD");
    const workingTreeCalls = calls.filter((a) => !(a[0] === "rev-parse" && a[1] === "HEAD"));
    check("(K8) every WORKING-TREE-SCANNING call carries -c core.fsmonitor=false",
      workingTreeCalls.length > 0 && workingTreeCalls.every((a) => a.includes("core.fsmonitor=false")));
    check("(K8) both bare `rev-parse HEAD` calls (pre- and post-commit) correctly lack it (nothing to scan)",
      bareShaReads.length === 2 && bareShaReads.every((a) => !a.includes("core.fsmonitor=false")));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (K9) NOCHANGES (Code Review B1): noChanges:true + real dirty files → auto-commit SKIPPED ───────
  //        entirely, ordinary uncommitted refusal fires instead, branch tip UNCHANGED.
  initRepo(K9.repo);
  { const { worktreePath, branch } = await createWorktree(K9.repo, K9.projId, K9.taskId); K9.worktreePath = worktreePath; K9.branch = branch; }
  const k9PreSha = headSha(K9.worktreePath);
  fs.writeFileSync(path.join(K9.worktreePath, K9.file), "real dirty file, but the report lies about it\n");
  seed(K9);
  const rK9 = await sessions.workerReport(K9.workerId, { status: "done", summary: "nothing to see here", noChanges: true });
  check("(K9) refused (uncommitted), NOT auto-committed", rK9.reported === false && rK9.refused === true
    && Array.isArray(rK9.uncommittedFiles) && rK9.uncommittedFiles.includes(K9.file));
  check("(K9) branch tip UNCHANGED — auto-commit was never attempted", headSha(K9.worktreePath) === k9PreSha);
  check("(K9) NO codex_auto_commit event was ever written", !db.listEvents(K9.mgrId).some((e) => e.kind === "codex_auto_commit"));

  // ── (K10) THROW-AFTER-COMMIT (Code Review B1): db.updateTask throws AFTER a successful auto-commit ──
  //         → workerReport propagates the throw, the final worker_report event never lands, but the
  //         DEDICATED codex_auto_commit event (appended earlier, unconditionally) already exists.
  initRepo(K10.repo);
  { const { worktreePath, branch } = await createWorktree(K10.repo, K10.projId, K10.taskId); K10.worktreePath = worktreePath; K10.branch = branch; }
  fs.writeFileSync(path.join(K10.worktreePath, K10.file), "real work, about to hit a downstream throw\n");
  seed(K10);
  const realUpdateTask = db.updateTask.bind(db);
  let updateTaskCalled = false;
  db.updateTask = (...args) => {
    if (args[0] === K10.taskId) { updateTaskCalled = true; throw new Error("SIMULATED updateTask throw (Code Review B1 test)"); }
    return realUpdateTask(...args);
  };
  let threwK10 = false;
  try {
    await sessions.workerReport(K10.workerId, { status: "done", summary: "should audit before the throw" });
  } catch {
    threwK10 = true;
  } finally {
    db.updateTask = realUpdateTask;
  }
  check("(K10) updateTask was actually reached (the injected throw fired)", updateTaskCalled === true);
  check("(K10) workerReport propagated the throw (uncaught)", threwK10 === true);
  const k10Audit = db.listEvents(K10.mgrId).find((e) => e.kind === "codex_auto_commit");
  check("(K10) the DEDICATED codex_auto_commit event exists DESPITE the downstream throw", !!k10Audit && typeof k10Audit.detail?.sha === "string");
  check("(K10) the commit itself really landed on the branch (the event isn't describing a phantom)",
    !!k10Audit && headSha(K10.worktreePath) === k10Audit.detail.sha);
  check("(K10) the FINAL worker_report event was NEVER written (the throw happened before it)",
    !db.listEvents(K10.mgrId).some((e) => e.kind === "worker_report" && e.detail?.status === "done"));

  // ── (K11) RACE, at the attemptCodexAutoCommit / precheckWorkerDone boundary (deterministic) ─────────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-k11-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-k11-proj-${sfx}`, `cac-k11-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "seen-file.txt"), "the file our OWN status read will see\n");
    const raceFactory = (repoPath, ms) => {
      const real = boundedSimpleGit(repoPath, ms, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true });
      return {
        raw: (args) => {
          const p = real.raw(args);
          if (Array.isArray(args) && args.includes("status")) {
            // Simulate a concurrent background write landing AFTER our own status snapshot was already
            // captured (in the .then(), not before the call) — deterministic (no real clock dependency):
            // writing BEFORE the subprocess even runs would very likely have the git child see it too
            // (a synchronous fs write is far faster than spawning + scheduling a subprocess), which
            // would prove nothing about the race. Writing once the status PROMISE resolves guarantees
            // the new file is strictly absent from what was already parsed.
            return p.then((v) => {
              fs.writeFileSync(path.join(worktreePath, "unseen-file.txt"), "a concurrent write our status read never saw\n");
              return v;
            });
          }
          return p;
        },
      };
    };
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "race test" }, { gitFactory: raceFactory });
    check("(K11) the commit still succeeded for the file our status read actually saw", ac.committed === true && ac.fileCount === 1);
    const committedFiles = execFileSync("git", ["show", "--stat", "--format=", ac.sha], { cwd: worktreePath }).toString();
    check("(K11) the committed tree contains ONLY seen-file.txt", committedFiles.includes("seen-file.txt") && !committedFiles.includes("unseen-file.txt"));
    const precheckAfterRace = await precheckWorkerDone(repo, worktreePath, branch);
    check("(K11) precheckWorkerDone STILL finds the tree dirty afterward — the exact race B1's fix covers",
      precheckAfterRace.uncommitted === true && precheckAfterRace.files.includes("unseen-file.txt"));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (K12) B1 RESIDUAL (i): commit succeeds, the post-commit rev-parse rejects → still recovered ────
  //         as committed:true with the REAL sha (not silently lost as committed:false).
  {
    const repo = path.join(os.tmpdir(), `loom-cac-k12-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-k12-proj-${sfx}`, `cac-k12-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "real work\n");
    // Keyed off "has commit been ATTEMPTED yet", never a hardcoded call-count: a count would silently
    // target the WRONG call (or nothing at all) against a differently-shaped implementation — exactly
    // what happened during this test's own development, where a count-based version accidentally never
    // fired against 79b3e65a at all (that version has no pre-commit rev-parse call, shifting every
    // later occurrence's index by one) and vacuously "passed" there for the wrong reason. This form
    // rejects the FIRST bare rev-parse HEAD call issued AFTER commit was attempted, in EITHER shape.
    let commitAttempted = false;
    let postCommitRevParseCount = 0;
    const factory = (repoPath, ms) => {
      const real = boundedSimpleGit(repoPath, ms, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true });
      return {
        raw: (args) => {
          if (Array.isArray(args) && args.includes("commit") && args.includes("--no-verify")) commitAttempted = true;
          if (commitAttempted && Array.isArray(args) && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
            postCommitRevParseCount++;
            // Reject only the FIRST post-commit read — a fixed implementation's own single retry (the
            // second post-commit occurrence) must be left to succeed and recover.
            if (postCommitRevParseCount === 1) return Promise.reject(new Error("SIMULATED post-commit rev-parse rejection (B1 residual test i)"));
          }
          return real.raw(args);
        },
      };
    };
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "k12 test" }, { gitFactory: factory });
    check("(K12) recovered committed:true despite the post-commit rev-parse rejecting (this FAILS on 79b3e65a: it returned committed:false there)",
      ac.committed === true && typeof ac.sha === "string");
    const realHead = headSha(worktreePath);
    check("(K12) the recovered sha matches the REAL branch tip (not a phantom/guessed value)", ac.sha === realHead);
    check("(K12) commitStateUnknown is NOT set — this is a clean recovery, not a fail-closed case", !ac.commitStateUnknown);

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (K13) B1 RESIDUAL (ii): commit itself fails AND the recovery HEAD re-read is also unreadable ────
  //         → commitStateUnknown:true, fail CLOSED (never a plain committed:false that a caller could
  //         silently treat as "safe to fall through to the ordinary uncommitted check").
  {
    const repo = path.join(os.tmpdir(), `loom-cac-k13-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-k13-proj-${sfx}`, `cac-k13-task-${sfx}`);
    const k13PreSha = headSha(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "real-work.txt"), "real work\n");
    // Same "after commit was attempted" targeting as K12 (see its own comment for why a hardcoded
    // call-count is unsafe across differently-shaped implementations). Rejects EVERY bare rev-parse
    // HEAD call issued after commit was attempted — a fixed implementation's retry (a second such call)
    // must ALSO fail to reach commitStateUnknown; an old, non-retrying implementation has only ONE such
    // call, and rejecting it is exactly what reproduces the bug this test guards against.
    let commitAttempted = false;
    const factory = (repoPath, ms) => {
      const real = boundedSimpleGit(repoPath, ms, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true });
      return {
        raw: (args) => {
          if (Array.isArray(args) && args.includes("commit") && args.includes("--no-verify")) {
            commitAttempted = true;
            return Promise.reject(new Error("SIMULATED commit failure (B1 residual test ii)"));
          }
          if (commitAttempted && Array.isArray(args) && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
            return Promise.reject(new Error("SIMULATED HEAD unreadable after failure (B1 residual test ii)"));
          }
          return real.raw(args);
        },
      };
    };
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "k13 test" }, { gitFactory: factory });
    check("(K13) commitStateUnknown:true — fail CLOSED, never a plain committed:false (this FAILS on 79b3e65a: it silently returned committed:false there, and workerReport would have accepted the done)",
      ac.committed === false && ac.commitStateUnknown === true);
    check("(K13) the worktree's HEAD genuinely did not move (this specimen's commit really never landed, unlike K12's)",
      headSha(worktreePath) === k13PreSha);

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (should-fix 1) NESTED REPO / GITLINK: an untracked dir carrying its own .git is refused, ────────
  //         never staged as a gitlink (a tree entry pointing at the nested repo's own commit, not
  //         reviewable content).
  {
    const repo = path.join(os.tmpdir(), `loom-cac-gitlink-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-gitlink-proj-${sfx}`, `cac-gitlink-task-${sfx}`);
    const nestedRepo = path.join(worktreePath, "nested-repo");
    fs.mkdirSync(nestedRepo, { recursive: true });
    execSync(`git init -q && git config user.email n@n && git config user.name n`, { cwd: nestedRepo });
    fs.writeFileSync(path.join(nestedRepo, "inner.txt"), "content inside the nested repo\n");
    commitAll(nestedRepo, "nested init", "-c user.email=n@n -c user.name=n");
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "gitlink test" });
    check("(gitlink) refused (skippedReason), not committed — never stages a gitlink",
      ac.committed === false && typeof ac.skippedReason === "string" && /gitlink/i.test(ac.skippedReason));
    const tracked = execFileSync("git", ["ls-files"], { cwd: worktreePath }).toString();
    check("(gitlink) nothing from the nested repo was staged", !tracked.includes("nested-repo"));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (should-fix 2) STAGED git mv: exercises parseAutoCommitStatusZ's combined R/C two-field branch ──
  //         (the filesystem-move rename in S1 below exercises the D+?? UNSTAGED shape instead — a
  //         combined record only ever arises from a PARTIALLY-staged index, e.g. a real `git mv` or a
  //         prior add that landed before a commit failed).
  {
    const repo = path.join(os.tmpdir(), `loom-cac-gitmv-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-gitmv-proj-${sfx}`, `cac-gitmv-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "gitmv-orig.txt"), "will be renamed via a REAL git mv (staged)\n");
    commitAll(worktreePath, "pre-rename commit", GIT_ID);
    execFileSync("git", ["mv", "gitmv-orig.txt", "gitmv-new.txt"], { cwd: worktreePath }); // STAGES both halves
    const statusZ = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: worktreePath }).toString();
    check("(gitmv) sanity: git status DOES report a combined R record for a staged git mv", /^R/.test(statusZ));
    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "gitmv test" });
    // fileCount is 1, not 2: the OLD half of an already-staged rename is never a real `git add` target
    // (see parseAutoCommitStatusZ's own doc) — only the NEW path is staged; the rename itself still
    // lands correctly because git detects it from the commit's own tree diff, independent of what we
    // explicitly staged (checked below via `git ls-files`, not assumed).
    check("(gitmv) committed successfully via the combined R/C two-field parse branch", ac.committed === true && ac.fileCount === 1);
    const trackedFiles = execFileSync("git", ["ls-files"], { cwd: worktreePath }).toString();
    check("(gitmv) old path gone, new path tracked", !trackedFiles.includes("gitmv-orig.txt") && trackedFiles.includes("gitmv-new.txt"));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (S1) non-ASCII / space / literal " -> " / rename, all via git status --porcelain -z ────────────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-s1-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-s1-proj-${sfx}`, `cac-s1-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "café.txt"), "non-ascii name\n");
    fs.writeFileSync(path.join(worktreePath, "has space.txt"), "space in name\n");
    const canDoArrow = canCreateFileNamed(worktreePath, "weird -> name.txt");
    if (!canDoArrow) skip("(S1) literal \" -> \" in a filename", "this filesystem rejects '>' in a filename (Windows/NTFS)");
    fs.writeFileSync(path.join(worktreePath, "to-rename-orig.txt"), "will be renamed by a plain fs move\n");
    const ac1 = await attemptCodexAutoCommit(worktreePath, branch, { summary: "s1 first pass" });
    check("(S1) café.txt / space / (if creatable) arrow-name all committed in one pass",
      ac1.committed === true && ac1.fileCount === (canDoArrow ? 4 : 3));
    const s1Files = execFileSync("git", ["show", "--stat", "--format=", ac1.sha], { cwd: worktreePath }).toString();
    check("(S1) café.txt is in the commit", s1Files.includes("caf"));
    check("(S1) has space.txt is in the commit", s1Files.includes("has space.txt"));
    if (canDoArrow) check("(S1) the arrow-named file is in the commit, not misparsed as a rename separator", s1Files.includes("weird"));

    // Real filesystem RENAME (no `git mv` — codex can't run git at all), fully unstaged.
    fs.renameSync(path.join(worktreePath, "to-rename-orig.txt"), path.join(worktreePath, "to-rename-new.txt"));
    const ac2 = await attemptCodexAutoCommit(worktreePath, branch, { summary: "s1 rename pass" });
    check("(S1 rename) committed both halves of the rename", ac2.committed === true && ac2.fileCount === 2);
    const renameTracked = execFileSync("git", ["ls-files"], { cwd: worktreePath }).toString();
    check("(S1 rename) the OLD path is gone from the tree", !renameTracked.includes("to-rename-orig.txt"));
    check("(S1 rename) the NEW path is tracked", renameTracked.includes("to-rename-new.txt"));

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (S2) --literal-pathspecs: a candidate literally named `*` is never glob-expanded ────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-s2-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-s2-proj-${sfx}`, `cac-s2-task-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "innocent-bystander.txt"), "must NOT be staged by a glob expansion\n");
    if (!canCreateFileNamed(worktreePath, "*")) {
      skip("(S2) a file literally named *", "this filesystem rejects '*' in a filename (Windows/NTFS)");
    } else {
      const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "s2 glob test" });
      check("(S2) auto-commit succeeded", ac.committed === true);
      check("(S2) stages exactly 2 files (the star file + the bystander, each as themselves — not a glob explosion)", ac.fileCount === 2);
      const tracked = execFileSync("git", ["ls-files"], { cwd: worktreePath }).toString();
      check("(S2) the literal * file is tracked", tracked.split("\n").includes("*"));
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (S3) a DANGLING symlink whose link TEXT points outside the worktree is still refused ───────────
  {
    const repo = path.join(os.tmpdir(), `loom-cac-s3-${sfx}`);
    initRepo(repo);
    const { worktreePath, branch } = await createWorktree(repo, `cac-s3-proj-${sfx}`, `cac-s3-task-${sfx}`);
    if (!canCreateSymlinks()) {
      skip("(S3) dangling symlink escape", "this host cannot create symlinks without elevated privilege (Windows without Developer Mode/admin)");
    } else {
      const outsideNeverCreated = path.join(os.tmpdir(), `loom-cac-s3-never-exists-${sfx}.txt`);
      fs.symlinkSync(outsideNeverCreated, path.join(worktreePath, "dangling-link.txt")); // target never created — DANGLING
      const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "s3 dangling test" });
      check("(S3) refused (skippedReason), not committed — a dangling escape must still be caught",
        ac.committed === false && typeof ac.skippedReason === "string" && /human review/i.test(ac.skippedReason));
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // ── (S4) boundedSimpleGit's shared unsafe allowlist is UNCHANGED for a caller that doesn't opt in ───
  {
    const repo = path.join(os.tmpdir(), `loom-cac-s4-${sfx}`);
    initRepo(repo);
    const plain = boundedSimpleGit(repo, 5000, nonInteractiveEnv());
    let plainThrew = false;
    try {
      await plain.raw(["-c", "core.hooksPath=/dev/null", "status"]);
    } catch {
      plainThrew = true;
    }
    check("(S4) a PLAIN boundedSimpleGit call (no extraUnsafe) still gets refused for -c core.hooksPath",
      plainThrew === true);
    const optedIn = boundedSimpleGit(repo, 5000, nonInteractiveEnv(), undefined, { allowUnsafeHooksPath: true });
    let optedInThrew = false;
    try {
      await optedIn.raw(["-c", "core.hooksPath=/dev/null", "status"]);
    } catch {
      optedInThrew = true;
    }
    check("(S4) a call that DOES pass extraUnsafe:{allowUnsafeHooksPath:true} is allowed", optedInThrew === false);
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // ── UNIT: boundConventionalSubject truncation ────────────────────────────────────────────────────
  {
    const longTitle = "feat(daemon): " + "x".repeat(100);
    const bounded = boundConventionalSubject(longTitle);
    check("(unit) boundConventionalSubject caps length to 72", bounded.length <= 72);
    check("(unit) boundConventionalSubject preserves the type(scope) prefix", bounded.startsWith("feat(daemon): "));
    check("(unit) an already-short conventional subject is returned unchanged", boundConventionalSubject("fix(daemon): short one") === "fix(daemon): short one");
    check("(unit) bare prose is coerced AND bounded", boundConventionalSubject("x".repeat(100)).startsWith("chore: "));
  }
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(`\n${skipped} case(s) skipped (see SKIP reasons above — a SKIP proves NOTHING about that specific case on this run; only ubuntu CI, where symlinks need no privilege and '*'/'>' are legal filename characters, actually exercises them).`);
console.log(failures === 0
  ? "\n✅ ALL PASS (of the cases that actually RAN — see the skip count above for what didn't) — codex auto-commit: eligible worker committed exactly its real files with the card title as subject and the summary as body, audited by BOTH the final worker_report event and a dedicated codex_auto_commit event; ineligible (claude) worker unaffected; HEAD mismatch and the unknown-commit-state fail-closed path both refused with no commit; ordering proven against the pending-direction precheck; noChanges:true skips auto-commit entirely; a downstream throw after a successful commit, and a post-commit rev-parse rejecting after a successful commit, both still leave the real commit correctly audited/recovered rather than silently lost; a nested-repo/gitlink candidate and nested .gitattributes are both refused with no commit; a staged git mv exercises the combined rename-record parser; hooks never fire against os.devNull (proven independently on Windows here and on POSIX/WSL by a second reviewer) and a real, executable, immediately-verified plant attempt still lands nothing; and the shared unsafe-config allowlist stays scoped to the one caller that opts in. Cases requiring symlink privilege or a '*'/'>' filename ran only if this host actually supports them (see skip count)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
