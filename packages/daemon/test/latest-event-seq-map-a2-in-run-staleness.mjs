import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dd494a9b, Code Review c8a2a24d item 2: a reviewer control (M5) removed Pass A2's own inline
// `a2MergeDoneSeqMap.set(...)` update (sessions/service.ts, right after A2's `appendEvent` call) and
// EVERY existing test stayed green — there was no coverage proving THAT specific line matters. This file
// is that coverage: two Pass-A2-eligible rows sharing the SAME branch + repoKey, NEITHER with a
// pre-existing terminal event (merge_done/merge_rejected) — Pass A2 must finalize the first-processed
// row's dangling merge_request LIVE, and the second-processed row (sharing the branch) must see that
// LIVE append — via A2's own freshly-rebuilt map, updated in place by the line under test — and defer,
// never filing a SECOND reconciling merge_done.
//
// Mirrors worktree-recycle-alias-protection.mjs's `setupRetaskStaleAlert` fixture (DB-event-only, no real
// git needed — Pass A2 never touches git) but with TWO INDEPENDENT rows (no recycledFrom link needed —
// A2's own logic keys on branch+repoKey, not lineage) instead of one already-finalized + one pending.
//
// listAllSessionsIncludingArchived orders by `last_activity DESC`, so ROW_P (later lastActivity) is
// visited BEFORE ROW_Q (earlier lastActivity) in A2's own loop — same convention as every other fixture
// in this file family.
//
// RED-PROOFED (see the header note at the bottom of this file for the exact repro) against a build with
// the inline `a2MergeDoneSeqMap.set(...)` line removed: ROW_Q wrongly got its OWN reconciling merge_done
// too (2 total instead of 1), and `staleMergesResolved` read 2 instead of 1.
// Run: 1) build daemon, 2) node test/latest-event-seq-map-a2-in-run-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-lesm-a2-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=lesm-a2@loom -c user.name=lesm-a2";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

// A real (but squash-free) git repo — Pass A still runs its own repoKey-resolution + squash lookup for
// every worker row before A2 ever sees it; with no Loom-Worker-Branch trailer anywhere, that lookup
// resolves landedSha=null for both rows, so Pass A cleanly skips them (same as setupRetaskStaleAlert).
const repo = path.join(os.tmpdir(), `loom-lesm-a2-repo-${sfx}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# lesm-a2\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", GIT_ID);
execSync(`git branch -M main`, { cwd: repo });

const projId = `lesm-a2-proj-${sfx}`, agentId = `lesm-a2-agent-${sfx}`, taskId = `lesm-a2-task-${sfx}`, mgrId = `lesm-a2-mgr-${sfx}`;
const rowPId = `lesm-a2-p-${sfx}`, rowQId = `lesm-a2-q-${sfx}`;
const SHARED_BRANCH = `loom/lesm-a2-${sfx}`;
const SHARED_REPO_KEY = null; // primary scope — shared by both rows

db.insertProject({ id: projId, name: "LESM-A2", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
// Terminal column from the START (card 1d10aea9's own A2 gate: terminalKey === task.columnKey) — this is
// the demonstrably-landed signal A2 requires; neither row ever requests a REAL finalize through Pass A.
db.insertTask({ id: taskId, projectId: projId, title: "LESM-A2", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// ROW_P: visited FIRST (later lastActivity) — A2 finalizes its dangling merge_request LIVE.
const rowPLastActivity = new Date(Date.parse(now) + 2000).toISOString();
db.insertSession({ id: rowPId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: path.join(repo, "never-on-disk-p"), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: rowPLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-p"), branch: SHARED_BRANCH });
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: rowPId, taskId, kind: "merge_request", detail: { branch: SHARED_BRANCH, filesChanged: 1, tip: SHARED_BRANCH, repoKey: SHARED_REPO_KEY } });

// ROW_Q: visited SECOND (earlier/`now` lastActivity), SAME branch + repoKey, its OWN merge_request (so
// Pass A's unrelated "never requested a merge" early-out can't short-circuit past the check under test),
// but deliberately NO merge_done of its own — it must come from seeing ROW_P's LIVE append.
db.insertSession({ id: rowQId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: path.join(repo, "never-on-disk-q"), processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: path.join(repo, "never-on-disk-q"), branch: SHARED_BRANCH });
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: rowQId, taskId, kind: "merge_request", detail: { branch: SHARED_BRANCH, filesChanged: 1, tip: SHARED_BRANCH, repoKey: SHARED_REPO_KEY } });

// --- pre-sanity ---
check("(pre) ROW_P has its own merge_request, no terminal event", db.listEventsForWorker(rowPId).some((e) => e.kind === "merge_request") && db.listEventsForWorker(rowPId).every((e) => e.kind !== "merge_done" && e.kind !== "merge_rejected"));
check("(pre) ROW_Q has its own merge_request, no terminal event", db.listEventsForWorker(rowQId).some((e) => e.kind === "merge_request") && db.listEventsForWorker(rowQId).every((e) => e.kind !== "merge_done" && e.kind !== "merge_rejected"));
check("(pre) task is already terminal (the signal A2 gates on)", db.getTask(taskId).columnKey === "done");

// --- THE RECONCILE ---
const r = await sessions.reconcileOrchestrationOnBoot();

check("ROW_P now has a reconciling merge_done (A2 finalized it LIVE)", db.listEventsForWorker(rowPId).some((e) => e.kind === "merge_done" && e.detail?.reconciled === true));
check(
  "ROW_Q has NO merge_done of its own — THE REGRESSION-SENSITIVE ASSERTION: without A2's own inline live-map update, Q would wrongly see no prior merge_done for this branch and file a SECOND one",
  db.listEventsForWorker(rowQId).every((e) => e.kind !== "merge_done"),
);
check(
  "exactly ONE reconciled merge_done total across both rows for this shared branch+repoKey",
  [...db.listEventsForWorker(rowPId), ...db.listEventsForWorker(rowQId)].filter((e) => e.kind === "merge_done" && e.detail?.reconciled === true).length === 1,
);
check("reconcile's own result reports exactly one stale merge resolved (P's), not two", r.staleMergesResolved === 1);

db.close();
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — Pass A2's own inline mergeDoneSeqMap update keeps its freshly-rebuilt map live within A2's own loop: a first-processed row's dangling merge_request is finalized LIVE, and a second-processed row sharing the same branch+repoKey correctly sees that live append and defers, instead of filing a duplicate reconciling merge_done."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);

// ════════ RED-PROOF REPRO (for the record, not executed by this file) ════════
// 1. In sessions/service.ts, inside Pass A2's loop, comment out:
//      if (s.branch) a2MergeDoneSeqMap.set(latestEventSeqMapKey(s.branch, repoScope), reconciledSeq);
// 2. pnpm --filter @loom/daemon build
// 3. node test/latest-event-seq-map-a2-in-run-staleness.mjs
// Result (measured): "ROW_Q has NO merge_done of its own" FAILS, the exactly-ONE-total count reads 2,
// and r.staleMergesResolved reads 2 — restore the line and rebuild to get back to green.
