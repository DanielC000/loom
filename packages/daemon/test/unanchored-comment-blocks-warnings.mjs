import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// UNANCHORED-COMMENT-BLOCK advisory, both surfaces (card 9d0c004e). REAL git on temp repos, NO claude and
// NO live daemon — drives SessionService.workerReport() and SessionService.reviewWorkerMerge() directly
// against an isolated LOOM_HOME (mirrors merge-deny-glob.mjs's / worker-noop-done.mjs's in-process style).
// See unanchored-comment-blocks-detect.mjs for unit-level coverage of the shared detector itself, and
// unanchored-comment-blocks-safety.mjs for hang-proofing/import-failure/truncation.
//
// THE GAP IT GUARDS: comment-anchor-lint.mjs's own PostToolUse hook only ever sees ONE file at a time, at
// EDIT time — nothing re-checks the whole branch's diff at the two points a manager/worker actually acts
// on it. This wires the SAME diff-scoped detector into worker_report(done) (primary, worker-facing) and
// worker_merge's review step (backstop, manager-facing) as an ADVISORY-ONLY nudge — never a refusal. The
// detector imports its OWN daemon-packaged copy of comment-anchor-lint.mjs (never anything from the test
// repos below), so these fixture repos need no seeded copy of that script at all.
//
// Proves, for BOTH surfaces:
//   (A) a branch that ADDS a long unanchored comment block -> the advisory fires, naming file:line and
//       "class A"/"class B".
//   (B) the SAME shape but anchored -> no comment-block text in the result.
//   (C) a branch that only touches an UNRELATED line in a file with a pre-existing (legacy, unchanged)
//       long unanchored block -> no comment-block text — diff-scoped, never the whole corpus.
// Plus, worker_report only:
//   (D) a legitimate no-op done (noChanges:true, 0 commits ahead) -> no comment-block text. NOTE: this
//       does NOT prove the `!report.noChanges` gate itself discriminates — it can't, via this public API
//       (see service.ts's own comment at that gate): the nochanges-with-commits refusal already makes
//       "noChanges:true + a non-empty diff" unreachable, so 0-ahead here means an empty diff regardless of
//       the gate. This proves the REACHABLE no-op path stays clean (no advisory, still auto-retires).
// Run: 1) build daemon (pnpm build), 2) node test/unanchored-comment-blocks-warnings.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ucbw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ucbw@loom -c user.name=ucbw";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { enqueueStdin() { return { delivered: true }; }, isAlive() { return true; }, isBusy() { return false; }, stop() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function longUnanchoredComment(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`// line ${i} of the block, deliberately generic filler text`);
  return lines.join("\n");
}

function seed(p) {
  db.insertProject({ id: p.projId, name: "UCBW", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "UCBW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo, seedFiles = {}) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ucbw\n");
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "ucbw@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "ucbw"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => ({
  projId: `ucbw-${tag}-proj-${sfx}`, agentId: `ucbw-${tag}-ag-${sfx}`, taskId: `ucbw-${tag}-task-${sfx}`,
  mgrId: `ucbw-${tag}-mgr-${sfx}`, workerId: `ucbw-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ucbw-${tag}-${sfx}`),
});

const RA = mk("ra"); // worker_report, added unanchored -> warned
const RB = mk("rb"); // worker_report, added anchored -> not warned
const RC = mk("rc"); // worker_report, legacy unchanged -> not warned
const RD = mk("rd"); // worker_report, noChanges:true, 0-ahead -> not warned
const MA = mk("ma"); // worker_merge review, added unanchored -> warned
const MB = mk("mb"); // worker_merge review, added anchored -> not warned
const MC = mk("mc"); // worker_merge review, legacy unchanged -> not warned
const all = [RA, RB, RC, RD, MA, MB, MC];

const relPath = path.join("packages", "daemon", "src", "example.ts");

async function cutWorktree(p, seedFiles = {}) {
  initRepo(p.repo, seedFiles);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
  return worktreePath;
}

try {
  // ══ worker_report(done) surface ══════════════════════════════════════════════════════════════════
  // ── (RA) branch ADDS a long unanchored block -> the advisory fires ──────────────────────────────
  {
    const wt = await cutWorktree(RA);
    fs.mkdirSync(path.join(wt, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, relPath), `${longUnanchoredComment(16)}\nexport const a = 1;\n`);
    commitAll(wt, "add long unanchored block", GIT_ID);

    const r = await sessions.workerReport(RA.workerId, { status: "done", summary: "implemented" });
    check("(RA) worker_report: reported:true, not refused", r.reported === true && !r.refused);
    check("(RA) worker_report: advisory fires", typeof r.warning === "string" && r.warning.includes("NEW UNANCHORED COMMENT BLOCK"));
    check("(RA) worker_report: names the file:line", r.warning.includes(`${relPath.replace(/\\/g, "/")}:1-16`));
    check("(RA) worker_report: worker-audience phrasing (re-report, not confirming)", r.warning.includes("then re-report"));
  }

  // ── (RB) branch ADDS the SAME shape, but anchored -> no comment-block text ──────────────────────
  {
    const wt = await cutWorktree(RB);
    fs.mkdirSync(path.join(wt, "packages", "daemon", "src"), { recursive: true });
    const lines = longUnanchoredComment(16).split("\n");
    lines.splice(3, 0, "// @decision sha:deadbeef — kept for a real reason, see the record");
    fs.writeFileSync(path.join(wt, relPath), `${lines.join("\n")}\nexport const b = 1;\n`);
    commitAll(wt, "add long anchored block", GIT_ID);

    const r = await sessions.workerReport(RB.workerId, { status: "done", summary: "implemented" });
    check("(RB) worker_report: reported:true, not refused", r.reported === true && !r.refused);
    check("(RB) worker_report: no comment-block advisory (anchored)", r.warning === undefined);
  }

  // ── (RC) branch only touches an UNRELATED line — legacy block untouched -> no comment-block text ─
  {
    const wt = await cutWorktree(RC, { [relPath]: `${longUnanchoredComment(20)}\nexport const c = 1;\nexport const untouched = 2;\n` });
    const filePath = path.join(wt, relPath);
    const content = fs.readFileSync(filePath, "utf8").replace("export const untouched = 2;", "export const touched = 3;");
    fs.writeFileSync(filePath, content);
    commitAll(wt, "tweak an unrelated line", GIT_ID);

    const r = await sessions.workerReport(RC.workerId, { status: "done", summary: "implemented" });
    check("(RC) worker_report: reported:true, not refused", r.reported === true && !r.refused);
    check("(RC) worker_report: no comment-block advisory (legacy, unchanged — diff-scoped)", r.warning === undefined);
  }

  // ── (RD) legitimate no-op done (noChanges:true, 0 commits ahead) -> the REACHABLE no-op path stays
  //        clean. Does NOT prove the `!report.noChanges` gate itself discriminates — see this file's own
  //        header note and service.ts's comment at that gate for why that can't be observed here.
  {
    await cutWorktree(RD);
    const r = await sessions.workerReport(RD.workerId, { status: "done", summary: "investigated — nothing to change", noChanges: true });
    check("(RD) worker_report: reported:true, not refused", r.reported === true && !r.refused);
    check("(RD) worker_report: no comment-block advisory on the reachable no-op path", r.warning === undefined);
    check("(RD) worker_report: still auto-retires as before (unaffected by this card)", r.autoRetired === true);
  }

  // ══ worker_merge's reviewWorkerMerge() surface ═══════════════════════════════════════════════════
  // ── (MA) branch ADDS a long unanchored block -> the advisory fires ──────────────────────────────
  {
    const wt = await cutWorktree(MA);
    fs.mkdirSync(path.join(wt, "packages", "daemon", "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, relPath), `${longUnanchoredComment(16)}\nexport const a = 1;\n`);
    commitAll(wt, "add long unanchored block", GIT_ID);

    const review = await sessions.reviewWorkerMerge(MA.mgrId, MA.workerId);
    check("(MA) worker_merge review: advisory fires", typeof review.warning === "string" && review.warning.includes("NEW UNANCHORED COMMENT BLOCK"));
    check("(MA) worker_merge review: names the file:line", review.warning.includes(`${relPath.replace(/\\/g, "/")}:1-16`));
    check("(MA) worker_merge review: manager-audience phrasing (before confirming)", review.warning.includes("before confirming"));
    check("(MA) worker_merge review: diff fields unaffected", review.filesChanged === 1);
  }

  // ── (MB) branch ADDS the SAME shape, but anchored -> no comment-block text ─────────────────────
  {
    const wt = await cutWorktree(MB);
    fs.mkdirSync(path.join(wt, "packages", "daemon", "src"), { recursive: true });
    const lines = longUnanchoredComment(16).split("\n");
    lines.splice(3, 0, "// @decision sha:deadbeef — kept for a real reason, see the record");
    fs.writeFileSync(path.join(wt, relPath), `${lines.join("\n")}\nexport const b = 1;\n`);
    commitAll(wt, "add long anchored block", GIT_ID);

    const review = await sessions.reviewWorkerMerge(MB.mgrId, MB.workerId);
    check("(MB) worker_merge review: no comment-block advisory (anchored)", review.warning === undefined);
  }

  // ── (MC) branch only touches an UNRELATED line — legacy block untouched -> no comment-block text ─
  {
    const wt = await cutWorktree(MC, { [relPath]: `${longUnanchoredComment(20)}\nexport const c = 1;\nexport const untouched = 2;\n` });
    const filePath = path.join(wt, relPath);
    const content = fs.readFileSync(filePath, "utf8").replace("export const untouched = 2;", "export const touched = 3;");
    fs.writeFileSync(filePath, content);
    commitAll(wt, "tweak an unrelated line", GIT_ID);

    const review = await sessions.reviewWorkerMerge(MC.mgrId, MC.workerId);
    check("(MC) worker_merge review: no comment-block advisory (legacy, unchanged — diff-scoped)", review.warning === undefined);
  }
} finally {
  db.close();
  for (const p of all) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report(done) and worker_merge's review step both surface the SAME diff-scoped unanchored-comment-block advisory (never a refusal): fires on a branch-added long unanchored block, stays silent when anchored, stays silent on an unchanged legacy block, and never fires on a noChanges done."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
