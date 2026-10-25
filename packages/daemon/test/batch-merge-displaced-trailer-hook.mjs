import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 45036494 — in a repo whose commit-msg hook appends a paragraph after whatever message git was
// about to commit (e.g. a DCO `Signed-off-by:` hook), `landBranchCommitsIndividually`'s two tip-trailer
// checks (git/batch-merge.ts) used to fold BOTH "displaced" and "unreadable" into `headMoved:true`, and
// `assembleBatchBranches` aborts the WHOLE batch on the FIRST `headMoved` — so every batch in such a repo
// hard-failed, permanently, reporting a "may have been tampered with" cause that was actively wrong.
//
// THE FIX: only a genuine "forged" namespace mismatch still aborts. "displaced"/"unreadable" land kept
// VERIFIED, with `BatchLandedBranch.trailerAdvisory` set — mirroring f224632d's own solo-path M1 ruling —
// and `mergeBatchTracked` files ONE deduped, low-severity `landing_trailer_displaced` event via the SAME
// `fileTrailerDisplacedAdvisory` method the solo path already uses.
//
// (A) single-commit branch, a real DCO hook (displaced) — lands, trailerAdvisory set, one advisory event,
//     zero batch_merge_head_moved events.
// (B) multi-commit branch, SAME hook — lands, Base/PathSet trailers still stamp (the hook re-fires on the
//     Base/PathSet amend too, from Loom's own clean rebuilt message, so this still resolves "displaced").
// (C) a hook that folds foreign text INTO Loom's own final paragraph (no blank-line boundary) —
//     "unreadable" — same kept-VERIFIED treatment, trailerAdvisory "unreadable".
// (D) NEGATIVE CONTROL — a hook that duplicates `Loom-Worker-Branch:` with a WRONG value, inside the same
//     paragraph — a genuine "forged" mismatch — still aborts the whole batch with batchHeadMoved:true.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-displaced-trailer-hook.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-bmdth-home-");

requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmdth", GIT_AUTHOR_EMAIL: "bmdth@loom", GIT_COMMITTER_NAME: "bmdth", GIT_COMMITTER_EMAIL: "bmdth@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmdth@loom -c user.name=bmdth";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-bmdth-repo-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmdth\n");
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "bmdth@loom"); git(repo, "config", "user.name", "bmdth");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// A realistic DCO-style hook: appends a trailer-SHAPED paragraph after whatever message git was about to
// commit — fires on every commit in the repo (worktrees share .git/hooks), including a worker's own
// in-worktree commit, exactly like a real repo-wide hook would.
function installDcoHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf '\\nSigned-off-by: CI Bot <ci@example.com>\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}

// A hook that joins a foreign line INTO Loom's own final paragraph, no blank-line separator — the
// "unreadable" shape (verifyLoomNamespaceExact still sees the exact reserved set; parseLoomTrailerBlock's
// structural per-line reader fails because the appended line breaks the final paragraph's shape).
function installUnreadableHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf '[skip ci]\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}

// NEGATIVE CONTROL: a hook that forges a genuine value mismatch — a DUPLICATE `Loom-Worker-Branch:` line,
// naming the WRONG branch, folded into the same final paragraph (no blank line) — a real namespace
// forgery, not an honest hook side effect. Must still abort the whole batch.
function installForgingHook(repo) {
  fs.writeFileSync(path.join(repo, ".git", "hooks", "commit-msg"), "#!/bin/sh\nprintf 'Loom-Worker-Branch: loom/evil0000\\n' >> \"$1\"\n");
  fs.chmodSync(path.join(repo, ".git", "hooks", "commit-msg"), 0o755);
}

function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, gateOpRetainMs: 0, reapWorktreeProcesses: noReap, runGate: async () => ({ passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }) });
  return { db, sessions };
}

let seq = 0;
async function addWorker(d, repo, projId, agentId, mgrId, tag, commits) {
  const n = `${tag}${++seq}`;
  const taskId = `bmdth-${n}-task`, workerId = `bmdth-${n}-wkr`;
  d.db.insertTask({ id: taskId, projectId: projId, title: `feat(x): ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  for (const { file, content, message } of commits) {
    fs.writeFileSync(path.join(worktreePath, file), content);
    commitAll(worktreePath, message, GIT_ID);
  }
  d.db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `bmdth-proj-${sfx}`, agentId = `bmdth-agent-${sfx}`, mgrId = `bmdth-mgr-${sfx}`;
  const d = boot();
  d.db.insertProject({ id: projId, name: `BMDTH-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  d.db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  d.db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return { ...d, projId, agentId, mgrId, repo };
}

const advisoryEventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "landing_trailer_displaced" && e.detail?.projectId === projId);
const headMovedEventsFor = (db, projId) => db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_head_moved" && e.detail?.projectId === projId);

try {
  // ── (A) TWO single-commit branches, DCO hook — mergeBatchTracked needs >=2 live candidates to actually
  //     run the real batch assembly path (`liveChosen.length < 2` falls back to per-candidate solo) ──────
  {
    const repo = makeRepo("a");
    const ctx = newProject("a", repo);
    const w1 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "a1", [{ file: "a1.ts", content: "export const a1 = 1;\n", message: "feat(test): single-commit under a DCO hook" }]);
    const w2 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "a2", [{ file: "a2.ts", content: "export const a2 = 1;\n", message: "feat(test): second single-commit under the same DCO hook" }]);
    // Installed AFTER the workers' own commits — a hook installed earlier also fires on a worker's OWN
    // in-worktree commit (worktrees share .git/hooks), double-appending Signed-off-by before it ever
    // reaches the batch's own commit/amend. Realistic either way (the hook represents ambient repo
    // policy on whatever commits happen from here); this ordering just isolates what we're testing.
    installDcoHook(repo);

    const r = await awaitTrackedSettle(() => ctx.sessions.mergeBatchTracked(ctx.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (A)", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
    const v = r.ok ? r.value : { __unsettled: r };
    check("(A) EVERY candidate commit is entirely legitimate — this is purely a hook side effect", true);
    check("(A) THE FIX: batch reports ok:true (never batchHeadMoved for an honest hook)", v.ok === true);
    check("(A) BOTH branches landed", Array.isArray(v.landed) && v.landed.length === 2);
    check("(A) both landed entries carry trailerAdvisory \"displaced\" (the hook fires on every tip)", v.landed.every((lb) => lb.trailerAdvisory === "displaced"));
    const body = git(repo, "log", "-1", "--format=%B", v.landed[1].sha);
    check("(A) setup control: the FINAL landed commit's trailer really IS displaced (a trailing Signed-off-by paragraph)", /Signed-off-by:/.test(body) && body.trim().split(/\n\n+/).pop().startsWith("Signed-off-by:"));
    check("(A) exactly ONE landing_trailer_displaced advisory event (deduped per repo per process, despite 2 candidates)", advisoryEventsFor(ctx.db, ctx.projId).length === 1 && advisoryEventsFor(ctx.db, ctx.projId)[0].detail.kind === "displaced");
    check("(A) ZERO batch_merge_head_moved events", headMovedEventsFor(ctx.db, ctx.projId).length === 0);
    check("(A) the task reached its terminal column (a real finalize, not a stuck retry)", ctx.db.getTask(w1.taskId)?.columnKey !== "in_progress" && ctx.db.getTask(w2.taskId)?.columnKey !== "in_progress");
    ctx.db.close();
  }

  // ── (B) a multi-commit branch alongside a filler single-commit branch, SAME hook — Base/PathSet still
  //     stamp on the multi-commit branch's own tip despite the hook re-firing on the amend ──────────────
  {
    const repo = makeRepo("b");
    const ctx = newProject("b", repo);
    const w1 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "b1", [
      { file: "b1a.ts", content: "export const b1a = 1;\n", message: "feat(test): multi-commit 1" },
      { file: "b1b.ts", content: "export const b1b = 1;\n", message: "feat(test): multi-commit 2" },
    ]);
    const w2 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "b2", [{ file: "b2.ts", content: "export const b2 = 1;\n", message: "feat(test): filler single-commit" }]);
    installDcoHook(repo); // AFTER the workers' own commits — see scenario (A)'s own comment for why

    const r = await awaitTrackedSettle(() => ctx.sessions.mergeBatchTracked(ctx.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (B)", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
    const v = r.ok ? r.value : { __unsettled: r };
    check("(B) THE FIX: batch reports ok:true", v.ok === true);
    check("(B) BOTH branches landed, both carry trailerAdvisory \"displaced\"", v.landed?.length === 2 && v.landed.every((lb) => lb.trailerAdvisory === "displaced"));
    const multi = v.landed.find((lb) => lb.branch === w1.branch);
    const body = git(repo, "log", "-1", "--format=%B", multi.sha);
    check("(B) the Base/PathSet amend still landed on the multi-commit branch (re-built from Loom's own clean message, re-displaced by the SAME hook)", /Loom-Worker-Base:/.test(body) && /Loom-Worker-PathSet:/.test(body) && /Signed-off-by:/.test(body));
    // Note: `BatchLandedBranch.pathSetStamped` itself is never copied into the settled response's
    // `landed[]` entries (a pre-existing gap, unrelated to this card) — `mergedVerification` (derived
    // from it) IS persisted onto the task, so check the real outcome there instead.
    check("(B) mergedVerification persisted as \"pathset\" on the task (the amend succeeded)", ctx.db.getTask(w1.taskId)?.mergedVerification === "pathset");
    check("(B) exactly ONE advisory event (a DIFFERENT project from (A), so its own first)", advisoryEventsFor(ctx.db, ctx.projId).length === 1);
    check("(B) ZERO batch_merge_head_moved events", headMovedEventsFor(ctx.db, ctx.projId).length === 0);
    ctx.db.close();
  }

  // ── (C) "unreadable" hook — same kept-VERIFIED treatment, different advisory kind ──────────────────────
  {
    const repo = makeRepo("c");
    const ctx = newProject("c", repo);
    const w1 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "c1", [{ file: "c1.ts", content: "export const c1 = 1;\n", message: "feat(test): single-commit under an unreadable hook" }]);
    const w2 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "c2", [{ file: "c2.ts", content: "export const c2 = 1;\n", message: "feat(test): second single-commit under the same unreadable hook" }]);
    installUnreadableHook(repo); // AFTER the workers' own commits — see scenario (A)'s own comment for why

    const r = await awaitTrackedSettle(() => ctx.sessions.mergeBatchTracked(ctx.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (C)", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
    const v = r.ok ? r.value : { __unsettled: r };
    check("(C) THE FIX: batch reports ok:true for the unreadable kind too", v.ok === true);
    check("(C) BOTH branches land with trailerAdvisory \"unreadable\"", v.landed?.length === 2 && v.landed.every((lb) => lb.trailerAdvisory === "unreadable"));
    check("(C) exactly ONE advisory event, kind \"unreadable\"", advisoryEventsFor(ctx.db, ctx.projId).length === 1 && advisoryEventsFor(ctx.db, ctx.projId)[0].detail.kind === "unreadable");
    check("(C) ZERO batch_merge_head_moved events", headMovedEventsFor(ctx.db, ctx.projId).length === 0);
    ctx.db.close();
  }

  // ── (D) NEGATIVE CONTROL — a genuine "forged" namespace mismatch still aborts the whole batch ─────────
  {
    const repo = makeRepo("d");
    const ctx = newProject("d", repo);
    const w1 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "d1", [{ file: "d1.ts", content: "export const d1 = 1;\n", message: "feat(test): single-commit under a FORGING hook" }]);
    const w2 = await addWorker(ctx, repo, ctx.projId, ctx.agentId, ctx.mgrId, "d2", [{ file: "d2.ts", content: "export const d2 = 1;\n", message: "feat(test): second single-commit under the same FORGING hook" }]);
    installForgingHook(repo); // AFTER the workers' own commits — see scenario (A)'s own comment for why

    const r = await awaitTrackedSettle(() => ctx.sessions.mergeBatchTracked(ctx.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked (D)", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
    const v = r.ok ? r.value : { __unsettled: r };
    check("(D) NEGATIVE CONTROL: a real namespace forgery STILL aborts the whole batch", v.ok === false && v.batchHeadMoved === true);
    check("(D) NO per-candidate fallback was started — both candidates report started:false", Array.isArray(v.fallback) && v.fallback.length === 2 && v.fallback.every((f) => f.started === false));
    check("(D) exactly ONE batch_merge_head_moved event", headMovedEventsFor(ctx.db, ctx.projId).length === 1);
    check("(D) ZERO advisory events (a forgery is never an advisory)", advisoryEventsFor(ctx.db, ctx.projId).length === 0);
    check("(D) nothing landed on main", git(repo, "log", "-1", "--format=%s") === "init");
    ctx.db.close();
  }
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — a batch landing under a legitimate commit-msg hook (displaced/unreadable) lands kept VERIFIED with an advisory, never aborting the whole batch; a genuine forged namespace mismatch still aborts."
    : `\n❌ ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}
