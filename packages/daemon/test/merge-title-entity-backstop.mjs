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
// DESIGN DECISION under test: the merge boundary refuses UNCONDITIONALLY. `checkTitleHtmlEntities`'s
// `allow` is a PER-CALL argument — nothing about a card's write-time `allowHtmlEntities:true` is ever
// PERSISTED (no such field on Task, no such column on the tasks table), so there is no create-time
// override for a merge-time call to honor OR ignore; `worker_merge_confirm` simply never threads one
// through. Scenario (C) proves this concretely: a task created via the write boundary's own
// `allowHtmlEntities:true` (which only ever affects that ONE create call) still carries an entity title
// on the board afterward, and still gets refused at merge.
//
// Code Review follow-up (card f324e8fa): the FIRST version of this guard lived ONLY in
// sessions/service.ts, as a pre-gate snapshot read of the task's title. That is an early advisory, not
// an unbypassable last line of defense — `POST /api/tasks/:id` (gateway/server.ts) writes `title` with
// no entity check at all, so a title can change between the pre-gate read and the squash. The
// AUTHORITATIVE enforcement now lives in git/worktrees.ts, at the exact point `subject` (the string
// `git commit -m` will use) is constructed — downstream of every subject source, inside the canonical
// index lock. Scenario (D) exercises THAT check directly, independent of the pre-gate one.
//
// Proves:
//   (A) ENTITY — task title carries an HTML entity: confirmWorkerMerge REFUSES (merged:false, reason
//       names the entity guard) WITHOUT running the squash (canonical repo untouched, branch not
//       deleted, task NOT moved to done, a merge_rejected(reason:title_html_entity) event recorded).
//   (B) CLEAN — a normal, entity-free title: confirmWorkerMerge merges exactly as before (unchanged
//       path — the guard is a true no-op on the common case).
//   (C) WRITE-BOUNDARY allow:true DOES NOT PERSIST — a task created via the write boundary's
//       `allowHtmlEntities:true` override still gets refused at merge, with the SAME reason/event as (A)
//       — proving there is no stored flag for the merge path to read.
//   (D) AUTHORITATIVE CHECK AT THE CONSTRUCTION SITE — calling `mergeBranch` (git/worktrees.ts) directly
//       with an entity-bearing task title, bypassing confirmWorkerMerge's pre-gate check entirely,
//       still refuses: canonical HEAD unchanged AND the working tree is left clean (no staged residue —
//       proves the reset-on-refuse cleanup ran).
//   (E) A PRIOR (OUT-OF-BAND) LANDING IS NOT OVER-REFUSED — the tension the pre-gate check's own doc
//       names: a re-confirm of a branch whose content is ALREADY on main (an out-of-band squash, the
//       worktree/task rows never updated) must NOT be refused for its entity title, because
//       mergeBranchLocked's own noop path returns before any subject is ever built — so no entity could
//       ever land. Proves the pre-gate check's `findLandedSquashCommit` short-circuit works: the
//       re-confirm finalizes idempotently (merged:true) instead of refusing.
//
// NOT PROVEN HERE (Code Review nit, card f324e8fa follow-up): every fixture project below leaves
// `gateCommand` empty, so confirmWorkerMerge never runs a real build/DoD gate — this suite cannot
// demonstrate the pre-gate check's OWN reason for existing (refusing BEFORE a gate lane is spent, not
// merely before the squash). That ordering claim is about gate-vs-check timing, not about correctness,
// and is left unverified by this file rather than chased with a gate-timing test.
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
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");
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
const Dc = { taskId: `mteb-d-task-${sfx}`, repo: path.join(os.tmpdir(), `loom-mteb-direct-${sfx}`), file: "direct.txt" };
const Pl = { projId: `mteb-p-proj-${sfx}`, agentId: `mteb-p-top-${sfx}`, taskId: `mteb-p-task-${sfx}`, mgrId: `mteb-p-mgr-${sfx}`, workerId: `mteb-p-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mteb-priorlanded-${sfx}`), file: "priorlanded.txt" };

try {
  seedProject(E);
  seedProject(Cn);
  seedProject(O);
  seedProject(Pl);

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

  // ── (C) WRITE-BOUNDARY allow:true DOES NOT PERSIST ───────────────────────────────────────────
  // A task created via the write boundary's own allowHtmlEntities:true override (a PER-CALL argument —
  // see checkTitleHtmlEntities's own doc) still carries an entity-bearing title on the board afterward,
  // because that call only ever affected the ONE create it was passed to. The merge boundary refuses it
  // exactly like (A) — same reason text, same event — proving there is no stored "I meant it" flag for
  // it to read (there is nothing on Task/the tasks table that could carry one).
  const overrideTask = createProjectTaskChecked(db, O.projId, { title: 'Release list shows literal &quot;X&quot;' }, undefined, true);
  check("(write-boundary-allow) fixture task created despite entity (per-call allow succeeded)", !overrideTask.error);
  O.taskId = overrideTask.id;
  await setupWorker(O);

  const mainBeforeO = git(O.repo, "rev-parse HEAD");
  const confirmO = await sessions.confirmWorkerMerge(O.mgrId, O.workerId);
  check("(write-boundary-allow) confirmWorkerMerge → merged:false (no persisted flag for the merge path to read)", confirmO.merged === false);
  check("(write-boundary-allow) refusal reason names the entity", typeof confirmO.reason === "string" && confirmO.reason.includes("HTML entity"));
  check("(write-boundary-allow) canonical HEAD UNCHANGED", git(O.repo, "rev-parse HEAD") === mainBeforeO);
  check("(write-boundary-allow) task NOT moved to done", db.getTask(O.taskId).columnKey !== "done");
  const evO = rejectedEvent(O.mgrId);
  check("(write-boundary-allow) a merge_rejected(reason:title_html_entity) event recorded", !!evO && evO.detail?.reason === "title_html_entity");

  // ── (D) AUTHORITATIVE CHECK AT THE SUBJECT-CONSTRUCTION SITE ─────────────────────────────────
  // Calls mergeBranch (git/worktrees.ts) DIRECTLY with an entity-bearing task title — bypassing
  // confirmWorkerMerge's pre-gate snapshot check entirely (no SessionService, no DB rows at all beyond
  // a plain git repo). Proves the check at the actual point `subject` is built refuses independently,
  // and that the reset-on-refuse cleanup leaves the working tree clean (no staged residue from the
  // `git merge --squash` this refusal aborted).
  initRepo(Dc.repo);
  const { worktreePath: dWorktreePath, branch: dBranch } = await createWorktree(Dc.repo, "mteb-d-proj", Dc.taskId);
  fs.writeFileSync(path.join(dWorktreePath, Dc.file), "direct worker change\n");
  commitAll(dWorktreePath, `${Dc.file}`, GIT_ID);
  const mainBeforeD = git(Dc.repo, "rev-parse HEAD");
  const directMerge = await mergeBranch(Dc.repo, dBranch, "add &lt;id&gt; param to question_ask");
  check("(direct) mergeBranch → ok:false", directMerge.ok === false);
  check("(direct) refusal reason names the entity", typeof directMerge.reason === "string" && directMerge.reason.includes("HTML entity"));
  check("(direct) canonical HEAD UNCHANGED (no squash committed)", git(Dc.repo, "rev-parse HEAD") === mainBeforeD);
  check("(direct) canonical working tree left CLEAN (reset-on-refuse cleanup ran)", git(Dc.repo, "status --porcelain") === "");
  Dc.worktreePath = dWorktreePath;

  // ── (E) A PRIOR (OUT-OF-BAND) LANDING IS NOT OVER-REFUSED ────────────────────────────────────
  // The tension the pre-gate check's own doc names: fabricate an OUT-OF-BAND landing — the SAME file
  // content the worker's branch carries, committed directly on canonical main with a real
  // Loom-Worker-Branch trailer, WITHOUT ever calling confirmWorkerMerge — so findLandedSquashCommit
  // genuinely reports this branch as already landed, while the worktree/task rows are untouched (still
  // in_progress, worktree still present) — exactly the shape merge-reject-notify-suppress.mjs scenario B
  // describes. A re-confirm of this entity-titled task must NOT be refused: mergeBranchLocked's own noop
  // path returns before any subject is ever built, so no entity could ever actually land.
  seedTaskRaw(Pl, "add &lt;id&gt; param to question_ask");
  await setupWorker(Pl);
  fs.writeFileSync(path.join(Pl.repo, Pl.file), "worker change\n");
  commitAll(Pl.repo, [`chore: out-of-band land`, `Loom-Worker-Branch: ${Pl.branch}`], GIT_ID);

  const confirmPl = await sessions.confirmWorkerMerge(Pl.mgrId, Pl.workerId);
  check("(prior-landed) confirmWorkerMerge → merged:true (NOT refused for the entity title)", confirmPl.merged === true);
  check("(prior-landed) task moved to done (finalized idempotently)", db.getTask(Pl.taskId).columnKey === "done");
  check("(prior-landed) NO merge_rejected(reason:title_html_entity) event recorded",
    !db.listEvents(Pl.mgrId).some((e) => e.kind === "merge_rejected" && e.detail?.reason === "title_html_entity"));
} finally {
  db.close();
  for (const p of [E, Cn, O, Dc, Pl]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a task title carrying an HTML entity is refused both pre-gate (sessions/service.ts) and at the authoritative subject-construction site (git/worktrees.ts), regardless of a write-boundary allow that never persists; a clean title merges unchanged; and a genuine re-confirm of already-landed work is never over-refused."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
