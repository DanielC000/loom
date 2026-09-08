import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate TITLE-HTML-ENTITY backstop test (card f324e8fa). REAL git on temp repos, NO claude and NO
// live daemon — drives SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME
// (mirrors merge-stranded-backstop.mjs's in-process style).
//
// THE BUG THIS GUARDS (card 267fd215's DoD-3 deferred half): a SOLO `worker_merge_confirm` uses the
// card's `title` VERBATIM as the squash commit subject (mergeBranchLocked, git/worktrees.ts). A title
// carrying an HTML entity (`&lt;id&gt;` typed where the author meant the literal `<id>`) has already
// shipped this way once (commit fe2c1c6b) — permanent, unrewritable mainline history. The write
// boundary (`checkTitleHtmlEntities`, mcp/tasks.ts, card 267fd215) makes an entity title hard to
// CREATE; this is the LAST LINE OF DEFENSE that makes it impossible to LAND.
//
// DESIGN DECISION under test: the merge boundary refuses UNCONDITIONALLY — it does NOT honor a card's
// create-time `allowHtmlEntities` override (see the reasoning left in sessions/service.ts at the guard
// site). So even a task explicitly created WITH `allowHtmlEntities:true` still gets refused at merge —
// proven by scenario (C) below.
//
// Proves:
//   (A) ENTITY — task title carries an HTML entity: confirmWorkerMerge REFUSES (merged:false, reason
//       names the entity guard) WITHOUT running the squash (canonical repo untouched, branch not
//       deleted, task NOT moved to done, a merge_rejected(reason:title_html_entity) event recorded).
//   (B) CLEAN — a normal, entity-free title: confirmWorkerMerge merges exactly as before (unchanged
//       path — the guard is a true no-op on the common case).
//   (C) OVERRIDE-AT-CREATE-STILL-REFUSED — a task created with the write-boundary's own
//       `allowHtmlEntities` override (so it exists on the board with an entity-bearing title) STILL gets
//       refused at merge — proving the merge boundary does not read/honor that create-time flag.
// Run: 1) build daemon (pnpm build), 2) node test/merge-title-entity-backstop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mteb-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { createProjectTaskChecked } = await import("../dist/mcp/tasks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mteb@loom -c user.name=mteb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// These paths only touch pty.stop / pty.isAlive / pty.enqueueStdin; a no-pty (exited) worker row makes
// isAlive false, so a stub keeps it hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;
const rejectedEvent = (mgrId) => db.listEvents(mgrId).find((e) => e.kind === "merge_rejected");

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mteb\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email mteb@loom && git config user.name mteb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// gateCommand left EMPTY so confirmWorkerMerge skips the build gate and goes straight to the title
// guard / merge — keeping the test claude-free and cwd-independent.
function seedProject(p) {
  db.insertProject({ id: p.projId, name: "MTEB", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}

function seedWorker(p) {
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Seeds the task via db.insertTask DIRECTLY — bypassing createProjectTaskChecked's write-boundary
// entity guard entirely, on purpose: this backstop must catch an entity-bearing title regardless of
// HOW it landed on the board (a raw db.insertTask caller, a legacy pre-267fd215 row, or the human REST
// edit route that also bypasses updateProjectTask — all enumerated as uncovered paths on card
// f324e8fa). Using the checked create path here would only prove the write boundary works, which
// 267fd215 already covers — this test is about the LAST line of defense, independent of origin.
function seedTaskRaw(p, title) {
  db.insertTask({ id: p.taskId, projectId: p.projId, title, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
}

async function setupWorker(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  commitAll(worktreePath, `${p.file}`, GIT_ID);
  p.worktreePath = worktreePath; p.branch = branch;
  seedWorker(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const E = { projId: `mteb-e-proj-${sfx}`, agentId: `mteb-e-top-${sfx}`, taskId: `mteb-e-task-${sfx}`, mgrId: `mteb-e-mgr-${sfx}`, workerId: `mteb-e-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mteb-entity-${sfx}`), file: "entity.txt" };
const Cn = { projId: `mteb-c-proj-${sfx}`, agentId: `mteb-c-top-${sfx}`, mgrId: `mteb-c-mgr-${sfx}`, workerId: `mteb-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mteb-clean-${sfx}`), file: "clean.txt" };
const O = { projId: `mteb-o-proj-${sfx}`, agentId: `mteb-o-top-${sfx}`, mgrId: `mteb-o-mgr-${sfx}`, workerId: `mteb-o-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mteb-override-${sfx}`), file: "override.txt" };

try {
  seedProject(E);
  seedProject(Cn);
  seedProject(O);

  // ── (A) ENTITY — refused at merge ─────────────────────────────────────────────────────────────
  // Seeded via db.insertTask directly (seedTaskRaw) — see that helper's own doc for why this must NOT
  // go through the (already-covered) checked create path.
  seedTaskRaw(E, "add &lt;id&gt; param to question_ask");
  await setupWorker(E);

  const mainBeforeE = git(E.repo, "rev-parse HEAD");
  const confirmE = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
  check("(entity) confirmWorkerMerge → merged:false", confirmE.merged === false);
  check("(entity) refusal reason names the entity", typeof confirmE.reason === "string" && confirmE.reason.includes("HTML entity"));
  check("(entity) canonical HEAD UNCHANGED (no squash committed)", git(E.repo, "rev-parse HEAD") === mainBeforeE);
  check("(entity) worker branch NOT deleted (worktree retained for recovery)", git(E.repo, `branch --list ${E.branch}`) !== "");
  check("(entity) task NOT moved to done", db.getTask(E.taskId).columnKey !== "done");
  check("(entity) merge_done NOT recorded", mergeDoneCount(E.mgrId) === 0);
  const evE = rejectedEvent(E.mgrId);
  check("(entity) a merge_rejected(reason:title_html_entity) event recorded", !!evE && evE.detail?.reason === "title_html_entity");

  // ── (B) CLEAN — unchanged path ────────────────────────────────────────────────────────────────
  const cleanTask = createProjectTaskChecked(db, Cn.projId, { title: "add id param to question_ask" });
  check("(clean) fixture task created", !cleanTask.error);
  Cn.taskId = cleanTask.id;
  await setupWorker(Cn);

  const headBeforeCn = git(Cn.repo, "rev-parse HEAD");
  const confirmCn = await sessions.confirmWorkerMerge(Cn.mgrId, Cn.workerId);
  check("(clean) confirmWorkerMerge → merged:true", confirmCn.merged === true);
  check("(clean) file landed on canonical repo", fs.existsSync(path.join(Cn.repo, Cn.file)));
  check("(clean) exactly ONE non-merge commit landed (squash, no `Merge branch` noise)",
    git(Cn.repo, `rev-list --count ${headBeforeCn}..HEAD`) === "1" &&
    git(Cn.repo, "rev-list --parents -n 1 HEAD").trim().split(/\s+/).length === 2);
  check("(clean) worker branch deleted after merge", git(Cn.repo, `branch --list ${Cn.branch}`) === "");
  check("(clean) task moved to done", db.getTask(Cn.taskId).columnKey === "done");
  check("(clean) merge_done recorded (exactly 1)", mergeDoneCount(Cn.mgrId) === 1);

  // ── (C) OVERRIDE-AT-CREATE-STILL-REFUSED — the design decision under test ────────────────────
  // A task explicitly created WITH the write-boundary's own allowHtmlEntities:true override still
  // carries an entity-bearing title on the board. The merge boundary must refuse it exactly like (A)
  // — proving it does NOT read/honor that create-time "I meant it" flag (see the design reasoning at
  // the guard site in sessions/service.ts for why: neither known specimen was a genuine
  // about-escaping title, and a manager can retitle in seconds before re-confirming).
  const overrideTask = createProjectTaskChecked(db, O.projId, { title: 'Release list shows literal &quot;X&quot;' }, undefined, true);
  check("(override) fixture task created despite entity (create-time override honored)", !overrideTask.error);
  O.taskId = overrideTask.id;
  await setupWorker(O);

  const mainBeforeO = git(O.repo, "rev-parse HEAD");
  const confirmO = await sessions.confirmWorkerMerge(O.mgrId, O.workerId);
  check("(override) confirmWorkerMerge → merged:false (merge boundary does NOT honor create-time override)", confirmO.merged === false);
  check("(override) canonical HEAD UNCHANGED", git(O.repo, "rev-parse HEAD") === mainBeforeO);
  check("(override) task NOT moved to done", db.getTask(O.taskId).columnKey !== "done");
} finally {
  db.close();
  for (const p of [E, Cn, O]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a task title carrying an HTML entity is refused at the merge boundary (no squash lands, work preserved) regardless of a create-time override; a clean title merges unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
