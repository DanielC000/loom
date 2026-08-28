import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PL Auditor finding #4 — cross-project task boarding for the Platform Lead (mcp/platform.ts ›
// project_task_create). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// platform-mgmt-surface.mjs / surface-subset.mjs: a REAL Db + SessionService against a FAKE pty
// (PtyHost createPty() seam), the REAL routers driven over an in-process MCP InMemoryTransport (no
// HTTP, no external daemon).
//
// Proves the DoD:
//   (1) the platform tool boards a card on a DIFFERENT project's board — it lands on the TARGET board
//       (db.listTasks(target)) with the right title/priority/column; an explicit columnKey is honored
//       and an omitted one resolves to the project's defaultLanding ("backlog" on the default board);
//   (2) a bad/nonexistent projectId is rejected ("project not found") and creates NO card;
//   (3) TRUST GATE — project_task_create is PRESENT on loom-platform but ABSENT from the agent-facing
//       surfaces: loom-orchestration (manager AND worker) and loom-setup. A project orchestrator/
//       worker/setup-operator must NOT gain cross-project write.
//   (8) card ba04d607 — project_task_create's `resolvesEscalation` structurally links a new card to the
//       `platform_escalate` task it fixes (db.findEscalationTriage resolves it back), accepts an
//       unambiguous id-prefix, and REJECTS the whole create (nothing written) for an unknown escalation
//       id OR a real taskId that isn't actually on the Platform board (scoped, never a bare unscoped
//       lookup). escalation-status.mjs proves the READ side this link feeds.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-cross-project-task.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-xtask-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { listProjectTasks, updateProjectTask, DEFAULT_TASK_SUMMARY_CAP } = await import("../dist/mcp/tasks.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-xtask-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# cross-project task test repo\n");
execSync(`git init -q && git add . && git -c user.email=x@loom -c user.name=x commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home (where the Lead lives) + a DIFFERENT target project board.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pTarget", name: "Target", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentWork", projectId: "pTarget", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });

// Sessions for the role-gate fixtures (the agent-facing surfaces resolve role/project from these).
const seedSession = (id, projectId, role, parent) => db.insertSession({
  id, projectId, agentId: projectId === "pHome" ? "agentLead" : "agentWork", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: parent ?? null,
});
seedSession("PL", "pHome", "platform", null);
seedSession("M", "pTarget", "manager", null);
seedSession("W", "pTarget", "worker", "M");

class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only lists tools here

const parse = (res) => JSON.parse(res.content[0].text);
const listTools = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "xtask-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
};

try {
  // ===================== (1) the platform tool boards a card on a DIFFERENT project's board =====================
  const platServer = new PlatformMcpRouter(db, svc).buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await platServer.connect(serverT);
  const client = new Client({ name: "xtask-platform", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  check("loom-platform registers project_task_create",
    (await client.listTools()).tools.some((t) => t.name === "project_task_create"));

  const nBefore = db.listTasks("pTarget").length;
  const created = await call("project_task_create", {
    projectId: "pTarget", title: "fix(x): boarded cross-project", body: "from the Lead", priority: "p1", columnKey: "todo",
  });
  check("project_task_create returns a Task row (id, no error)", !!created.id && !created.error);
  check("the card belongs to the TARGET project (projectId=pTarget)", created.projectId === "pTarget");
  check("the card LANDED on the target board (visible via db.listTasks)",
    db.listTasks("pTarget").some((t) => t.id === created.id) && db.listTasks("pTarget").length === nBefore + 1);
  const stored = db.getTask(created.id);
  check("title/priority/column persisted identically",
    stored.title === "fix(x): boarded cross-project" && stored.body === "from the Lead" && stored.priority === "p1" && stored.columnKey === "todo");

  // Omitted columnKey lands on the project's role-resolved defaultLanding ("backlog" on the default board).
  const landed = await call("project_task_create", { projectId: "pTarget", title: "no-column card" });
  check("omitted columnKey resolves to the defaultLanding column (backlog)", landed.columnKey === "backlog" && !landed.error);
  check("omitted priority defaults to p2 (same as in-project tasks_create)", landed.priority === "p2");

  // The Lead's OWN home was NOT touched by a pTarget create (true cross-project isolation).
  check("the create did NOT leak onto the Lead's home board", db.listTasks("pHome").length === 0);

  // ===================== (1b) M1 (card 0ef0270b) — project_task_create runs the SAME cross-channel =====
  // duplicate check as the in-project tasks_create, checked against the TARGET (pTarget) board — NOT
  // the Lead's own pHome board. This closes the gap where a duplicate filed via project_task_create was
  // never caught (only the in-project tasks_create side was checked before this card).
  const M1_A_TITLE = "fix(orchestration): phantom session after spawn failure";
  const M1_A_BODY = "session e7f1a2b3-9c4d-4e5f-8a6b-1c2d3e4f5a6b on branch loom/1a2b3c4d5e6f never got an engine.";
  const M1_B_TITLE = "fix(orchestration): worker_stop lies about a phantom session";
  const M1_B_BODY = "same defect — session e7f1a2b3-9c4d-4e5f-8a6b-1c2d3e4f5a6b, branch loom/1a2b3c4d5e6f — worker_stop returned stopped:true anyway.";

  // Seed the FIRST card directly on pTarget's board (as if a peer manager had already filed it there via
  // its own in-project tasks_create) — createProjectTaskChecked/db.insertTask both work for this seed.
  const m1First = await call("project_task_create", { projectId: "pTarget", title: M1_A_TITLE, body: M1_A_BODY });
  check("(1b) M1 setup: the first card of the pair lands cleanly", !m1First.error && !!m1First.id);

  const nBeforeM1 = db.listTasks("pTarget").length;
  const m1Refused = await call("project_task_create", { projectId: "pTarget", title: M1_B_TITLE, body: M1_B_BODY });
  check("(1b) M1: project_task_create REFUSES a suspected duplicate, naming the counterpart id",
    typeof m1Refused.error === "string" && m1Refused.error.includes(m1First.id));
  check("(1b) M1: the refused create inserted NO card on the target board", db.listTasks("pTarget").length === nBeforeM1);

  // allowDuplicate:true overrides the refusal, same as the in-project tool.
  const m1Overridden = await call("project_task_create", { projectId: "pTarget", title: M1_B_TITLE, body: M1_B_BODY, allowDuplicate: true });
  check("(1b) M1: allowDuplicate:true creates it anyway", !m1Overridden.error && !!m1Overridden.id);
  check("(1b) M1: the board now has both cards", db.listTasks("pTarget").length === nBeforeM1 + 1);

  // m7 (card 0ef0270b): supersedes bypasses the refusal AND back-links BOTH cards, reached via the
  // Lead's cross-project channel — not just the in-project tasks_create channel (already covered in
  // task-dedupe.mjs).
  const m1Superseded = await call("project_task_create", { projectId: "pTarget", title: M1_B_TITLE, body: M1_B_BODY, supersedes: m1First.id });
  check("(1b/m7) M1: supersedes:<id> bypasses the refusal via project_task_create", !m1Superseded.error && !!m1Superseded.id);
  check("(1b/m7) M1: the NEW card's body records the relationship", db.getTask(m1Superseded.id).body.includes(`Supersedes: ${m1First.id}`));
  check("(1b/m7) M1: the SUPERSEDED (loser) card's body is back-noted with a pointer to the new card",
    db.getTask(m1First.id).body.includes(`Superseded by: ${m1Superseded.id}`));

  // ⚠️ Cross-project corpus check (card 0ef0270b): the duplicate check must run against the TARGET
  // project's board, never the Lead's OWN home board. Seed pHome with a card sharing the SAME rare
  // identifiers as a fresh candidate filed against pTarget (which has no such card) — if the checker
  // wrongly consulted pHome's corpus (or, worse, consulted nothing at all and silently no-op'd), this
  // candidate would either be wrongly refused (wrong board) or the whole check would be untestable
  // (silent no-op reads identically to "no duplicate"). Asserting it creates cleanly here, THEN checking
  // it against a genuine pTarget duplicate below, is what makes a wrong-board check observable rather than
  // looking like it's working.
  const M1_XPROJECT_TITLE = "fix(pty): a third, unrelated phantom-session repro";
  const M1_XPROJECT_BODY = "session cccccccc-dddd-eeee-ffff-000011112222 on branch loom/abcdefabcdef — distinct repro, home-board only.";
  const homeSeed = await call("project_task_create", { projectId: "pHome", title: M1_XPROJECT_TITLE, body: M1_XPROJECT_BODY });
  check("(1b) cross-project-corpus setup: seed card lands on pHome", !homeSeed.error && !!homeSeed.id);
  const xprojClean = await call("project_task_create", { projectId: "pTarget", title: "fix(pty): a fourth phantom-session repro (pTarget)", body: M1_XPROJECT_BODY });
  check("(1b) cross-project-corpus: a candidate sharing identifiers ONLY with a pHome (not pTarget) card creates CLEANLY on pTarget — proves the check consulted pTarget's board, not pHome's",
    !xprojClean.error && !!xprojClean.id);
  // Now the REAL positive control on the SAME target board: a second candidate sharing those same
  // identifiers with the one we just landed ON pTarget IS refused — proving the check is live (not a
  // silent no-op) and scoped to the right board.
  const xprojRefused = await call("project_task_create", { projectId: "pTarget", title: "fix(pty): a fifth phantom-session repro (pTarget)", body: M1_XPROJECT_BODY });
  check("(1b) cross-project-corpus: a candidate duplicating the pTarget card (not the pHome one) IS refused, naming the pTarget counterpart",
    typeof xprojRefused.error === "string" && xprojRefused.error.includes(xprojClean.id));

  // ===================== (2) bad/nonexistent projectId is rejected, nothing created =====================
  const nTargetNow = db.listTasks("pTarget").length;
  const nHomeNow = db.listTasks("pHome").length; // non-zero here: (1b)'s cross-project-corpus check seeded pHome deliberately
  const bad = await call("project_task_create", { projectId: "ghost", title: "should not exist" });
  check("(2) nonexistent projectId rejected ('project not found')", bad.error === "project not found" && !bad.id);
  check("(2) the rejected create boarded NO card anywhere",
    db.listTasks("pTarget").length === nTargetNow && db.listTasks("pHome").length === nHomeNow);

  // ===================== (4) cross-project task READ / UPDATE / LIST — the finish-the-surface tools ==========
  const platTools4 = (await client.listTools()).tools.map((t) => t.name);
  check("(4) loom-platform registers project_task_get + project_task_update + list_all_tasks",
    platTools4.includes("project_task_get") && platTools4.includes("project_task_update") && platTools4.includes("list_all_tasks"));

  // create → read → move → re-prioritize a card on ANOTHER project's board, end-to-end.
  const card = await call("project_task_create", { projectId: "pTarget", title: "feat(x): lifecycle card", body: "v1", priority: "p2", columnKey: "backlog" });
  check("(4) e2e create: card on pTarget (id, no error)", !!card.id && !card.error);
  const read1 = await call("project_task_get", { projectId: "pTarget", taskId: card.id });
  check("(4) e2e read: project_task_get returns the FULL card (body included)", read1.id === card.id && read1.body === "v1" && !read1.error);
  const moved = await call("project_task_update", { projectId: "pTarget", taskId: card.id, columnKey: "in_progress", priority: "p0" });
  check("(4) e2e move + re-prioritize: returns the patched row", moved.columnKey === "in_progress" && moved.priority === "p0" && !moved.error);
  check("(4) e2e move + re-prioritize persisted to the DB", db.getTask(card.id).columnKey === "in_progress" && db.getTask(card.id).priority === "p0");

  // Column-move guard: a move to a NON-EXISTENT column is rejected and the card is left unchanged.
  const badMove = await call("project_task_update", { projectId: "pTarget", taskId: card.id, columnKey: "no_such_col" });
  check("(4) move to an unknown column is rejected (column-existence guard)", /unknown column/.test(badMove.error || ""));
  check("(4) the rejected move left the card on its prior column", db.getTask(card.id).columnKey === "in_progress");

  // Cross-project guard: a taskId that belongs to a DIFFERENT project resolves to not-found (no leak/edit).
  const homeCard = await call("project_task_create", { projectId: "pHome", title: "home-only card" });
  check("(4) cross-project get: a pHome card is NOT readable as a pTarget card", /not found/.test((await call("project_task_get", { projectId: "pTarget", taskId: homeCard.id })).error || ""));
  const xUpd = await call("project_task_update", { projectId: "pTarget", taskId: homeCard.id, priority: "p0" });
  check("(4) cross-project update: a pHome card is NOT editable via pTarget", /not found/.test(xUpd.error || ""));
  check("(4) the cross-project update did NOT mutate the home card", db.getTask(homeCard.id).priority !== "p0");
  // Unknown project → 404 on both read + update.
  check("(4) project_task_get 404s an unknown project", (await call("project_task_get", { projectId: "ghost", taskId: card.id })).error === "project not found");
  check("(4) project_task_update 404s an unknown project", (await call("project_task_update", { projectId: "ghost", taskId: card.id, priority: "p1" })).error === "project not found");

  // The SHARED backing path is used by the in-project tasks_update too: column-existence guard applies there.
  const badIn = await updateProjectTask(db, "pTarget", card.id, { columnKey: "still_not_a_col" });
  check("(4) the in-project updateProjectTask ALSO rejects an unknown column (shared guard)", /unknown column/.test(badIn.error || ""));
  const goodIn = await updateProjectTask(db, "pTarget", card.id, { columnKey: "review" });
  check("(4) a valid in-project move is accepted (review exists on the default board)", goodIn.columnKey === "review" && !goodIn.error);

  // ===================== (4b) BATCH move + batch read (card 1105c2c8) =====================
  // agent_clone_batch's convention: independent per-id apply, non-transactional, one result per id
  // in the given order — {taskId, task} success / {taskId, error} failure, single-id path unchanged.
  const b1 = await call("project_task_create", { projectId: "pTarget", title: "batch card 1", body: "b1", columnKey: "backlog" });
  const b2 = await call("project_task_create", { projectId: "pTarget", title: "batch card 2", body: "b2", columnKey: "backlog" });
  const b3 = await call("project_task_create", { projectId: "pTarget", title: "batch card 3", body: "b3", columnKey: "backlog" });

  // Happy path: one call, one columnKey, three ids.
  const batchMove = await call("project_task_update", { projectId: "pTarget", taskIds: [b1.id, b2.id, b3.id], columnKey: "in_progress" });
  check("(4b) batch move returns one result per id, in order",
    Array.isArray(batchMove) && batchMove.length === 3 &&
    batchMove.every((r, i) => r.taskId === [b1.id, b2.id, b3.id][i] && !r.error && r.task.columnKey === "in_progress"));
  check("(4b) batch move actually persisted the column on all three",
    db.getTask(b1.id).columnKey === "in_progress" && db.getTask(b2.id).columnKey === "in_progress" && db.getTask(b3.id).columnKey === "in_progress");

  // Partial failure: a bad id (unknown, but long enough to prefix-resolve as "none") among good ones —
  // the good ones still apply, the bad one surfaces its own {taskId, error}; nothing is transactional.
  const ghostId = "00000000-0000-0000-0000-000000000000";
  const batchPartial = await call("project_task_update", { projectId: "pTarget", taskIds: [b1.id, ghostId, b2.id], priority: "p0" });
  check("(4b) batch partial-failure: good ids still applied",
    db.getTask(b1.id).priority === "p0" && db.getTask(b2.id).priority === "p0");
  check("(4b) batch partial-failure: the bad id surfaces its own {taskId, error}, doesn't block others",
    batchPartial.find((r) => r.taskId === ghostId)?.error !== undefined &&
    batchPartial.find((r) => r.taskId === b1.id)?.error === undefined &&
    batchPartial.find((r) => r.taskId === b2.id)?.error === undefined);

  // Prefix resolution works PER-ID inside a batch (mirrors the single-id path's id-prefix resolution).
  // deferredReason is REQUIRED alongside deferred:true here since card c90e9525 — this router has no
  // deferredUntilTaskId, so deferred:true always lands on the manual (reason-required) path.
  const b1Prefix = b1.id.slice(0, 8);
  const batchPrefix = await call("project_task_update", { projectId: "pTarget", taskIds: [b1Prefix], deferred: true, deferredReason: "cross-project batch test deferral" });
  check("(4b) batch move resolves an 8-char id-prefix per-id", batchPrefix[0].taskId === b1Prefix && !batchPrefix[0].error);
  check("(4b) the prefix-resolved batch move persisted", db.getTask(b1.id).deferred === true);

  // title/body are rejected alongside taskIds — whole call rejected, nothing written.
  const beforeTitle = db.getTask(b1.id).title;
  const batchTitleRejected = await call("project_task_update", { projectId: "pTarget", taskIds: [b1.id, b2.id], title: "same title for all" });
  check("(4b) taskIds + title is rejected", /title\/body/.test(batchTitleRejected.error || ""));
  check("(4b) the rejected batch title write touched nothing", db.getTask(b1.id).title === beforeTitle);
  const batchBodyRejected = await call("project_task_update", { projectId: "pTarget", taskIds: [b1.id, b2.id], body: "same body for all" });
  check("(4b) taskIds + body is rejected", /title\/body/.test(batchBodyRejected.error || ""));

  // exactly-one-of taskId/taskIds validation, on both update and get.
  check("(4b) project_task_update: neither taskId nor taskIds is an error",
    /taskId or taskIds/.test((await call("project_task_update", { projectId: "pTarget", priority: "p1" })).error || ""));
  check("(4b) project_task_update: both taskId and taskIds is an error",
    /not both/.test((await call("project_task_update", { projectId: "pTarget", taskId: b1.id, taskIds: [b2.id], priority: "p1" })).error || ""));

  // Batch READ happy path — full bodies back, one result per id, in order.
  const batchRead = await call("project_task_get", { projectId: "pTarget", taskIds: [b1.id, b2.id, b3.id] });
  check("(4b) batch read returns one full-body result per id, in order",
    Array.isArray(batchRead) && batchRead.length === 3 &&
    batchRead[0].taskId === b1.id && batchRead[0].task.body === "b1" &&
    batchRead[1].taskId === b2.id && batchRead[1].task.body === "b2" &&
    batchRead[2].taskId === b3.id && batchRead[2].task.body === "b3");

  // Batch read partial failure: good ids still return full bodies, the bad id surfaces its own error.
  const batchReadPartial = await call("project_task_get", { projectId: "pTarget", taskIds: [b1.id, ghostId] });
  check("(4b) batch read partial-failure: good id still returns its body",
    batchReadPartial.find((r) => r.taskId === b1.id)?.task?.body === "b1");
  check("(4b) batch read partial-failure: the bad id surfaces its own {taskId, error}",
    batchReadPartial.find((r) => r.taskId === ghostId)?.error !== undefined);

  // Prefix resolution works PER-ID inside a batch read too.
  const batchReadPrefix = await call("project_task_get", { projectId: "pTarget", taskIds: [b1Prefix] });
  check("(4b) batch read resolves an 8-char id-prefix per-id", batchReadPrefix[0].taskId === b1Prefix && batchReadPrefix[0].task.body === "b1");

  check("(4b) project_task_get: neither taskId nor taskIds is an error",
    /taskId or taskIds/.test((await call("project_task_get", { projectId: "pTarget" })).error || ""));
  check("(4b) project_task_get: both taskId and taskIds is an error",
    /not both/.test((await call("project_task_get", { projectId: "pTarget", taskId: b1.id, taskIds: [b2.id] })).error || ""));

  // Single-id path stays BYTE-IDENTICAL — bare row, not wrapped in a one-element array.
  const singleRead = await call("project_task_get", { projectId: "pTarget", taskId: b1.id });
  check("(4b) single-taskId project_task_get returns the bare row, not an array", !Array.isArray(singleRead) && singleRead.id === b1.id);
  const singleMove = await call("project_task_update", { projectId: "pTarget", taskId: b1.id, priority: "p3" });
  check("(4b) single-taskId project_task_update returns the bare ack/row, not an array", !Array.isArray(singleMove) && singleMove.priority === "p3");

  // list_all_tasks aggregates across projects; projectId narrows; done excluded; summary drops body.
  const doneCard = await call("project_task_create", { projectId: "pTarget", title: "done card", columnKey: "done" });
  const agg = await call("list_all_tasks", {});
  check("(4) list_all_tasks aggregates cross-project (sees both the pTarget + pHome cards)",
    Array.isArray(agg) && agg.some((t) => t.id === card.id) && agg.some((t) => t.id === homeCard.id));
  check("(4) list_all_tasks default is a SUMMARY (no body) and EXCLUDES done cards",
    agg.every((t) => t.body === undefined) && !agg.some((t) => t.id === doneCard.id));
  const targetFull = await call("list_all_tasks", { projectId: "pTarget", includeBody: true });
  check("(4) list_all_tasks projectId filter + includeBody returns full rows scoped to that project",
    targetFull.length > 0 && targetFull.every((t) => t.projectId === "pTarget" && typeof t.body === "string"));
  // An unknown/unresolvable projectId is an EXPLICIT error — never a silent [] (card 0c34189c bug #1).
  const ghostRes = await call("list_all_tasks", { projectId: "ghost" });
  check("(4) list_all_tasks errors clearly on an unknown project (no silent [])", ghostRes.error === "project not found");

  // 8-char id-PREFIX resolution — mirrors project_get/project_task_get (card 0c34189c bug #1): a Lead
  // pasting the displayed short id must resolve to the SAME board a full-id lookup would.
  db.insertProject({ id: "cafe1234-full-uuid-form", name: "Prefixed", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const prefixCard = await call("project_task_create", { projectId: "cafe1234-full-uuid-form", title: "prefix-resolved card" });
  check("(4) project_task_create accepted the full id", !!prefixCard.id && !prefixCard.error);
  const byPrefix = await call("list_all_tasks", { projectId: "cafe1234", includeBody: true });
  check("(4) list_all_tasks resolves an 8-char project-id PREFIX to the same board (no silent [])",
    Array.isArray(byPrefix) && byPrefix.some((t) => t.id === prefixCard.id));

  // includeDone — mirrors tasks_list's excludeDone/columns filter shape (card 0c34189c bug #2): a Lead can
  // confirm a dispatched batch landed (incl. terminal/done cards) without per-card polling.
  const noDone = await call("list_all_tasks", { projectId: "pTarget", includeBody: true });
  check("(4) default (includeDone omitted) still excludes the done card", !noDone.some((t) => t.id === doneCard.id));
  const withDone = await call("list_all_tasks", { projectId: "pTarget", includeDone: true, includeBody: true });
  check("(4) includeDone:true includes the terminal/done card", withDone.some((t) => t.id === doneCard.id));
  const onlyDoneCol = await call("list_all_tasks", { projectId: "pTarget", includeDone: true, columns: ["done"], includeBody: true });
  check("(4) columns filter narrows to just the named column",
    onlyDoneCol.length > 0 && onlyDoneCol.every((t) => t.columnKey === "done"));

  // A genuine no-match (a real project with zero qualifying cards) returns an EXPLICIT { tasks: [], message }
  // payload — never a bare [] that the harness renders as "(completed with no output)" (card 0c34189c bug #3).
  db.insertProject({ id: "pEmpty", name: "Empty", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const emptyRes = await call("list_all_tasks", { projectId: "pEmpty" });
  check("(4) a genuine no-match returns an explicit { tasks: [], total:0, nextOffset:null, message } payload",
    Array.isArray(emptyRes.tasks) && emptyRes.tasks.length === 0 && emptyRes.total === 0 &&
    emptyRes.nextOffset === null && typeof emptyRes.message === "string");

  // ===================== (5) bounded-read pagination + a measured cap =====================
  db.insertProject({ id: "pBulk", name: "Bulk", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const BULK = DEFAULT_TASK_SUMMARY_CAP + 5;
  // body is a short, non-empty filler — this section tests PAGINATION/capping, not the NDJSON
  // inline-vs-spill threshold (SPILL_INLINE_BUDGET_CHARS, spill.ts). It used to matter to stay clear of
  // that threshold (a heavier body would silently switch the in-project tasks_list response to the
  // spill-pointer shape); the `ndjson()` helper above is now spill-AWARE (follows `rowsFile` when
  // present), so this section's assertions hold either way — but the body stays short regardless, since
  // there's still no assertion on body CONTENT below and a short filler keeps this section's intent
  // (pagination, not payload size) legible.
  for (let i = 0; i < BULK; i++) {
    db.insertTask({ id: `bulk-${i}`, projectId: "pBulk", title: `b${i}`, body: "x", columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now });
  }
  // Unit: listProjectTasks honors offset/limit (pure slicing).
  const sliced = await listProjectTasks(db, "pBulk", { limit: 10, offset: 5 });
  check("(5) listProjectTasks honors limit/offset", sliced.length === 10 && sliced[0].id === "bulk-5");
  // Card 9798200c: list_all_tasks now ALSO proactively spills its `tasks` rows to an NDJSON scratch file
  // (mirrors tasks_list's okLinesSpillable) once they'd exceed SPILL_INLINE_BUDGET_CHARS — at BULK(105)
  // rows with includeBody:true this crosses that budget, same growth pattern that already pushed the
  // in-project tasks_list section below to follow a `rowsFile` pointer. Follow it here too so this
  // section's row-count assertions hold regardless of how close a given row count sits to that budget.
  const callTasks = async (args) => {
    const r = await call("list_all_tasks", args);
    if (r && typeof r === "object" && !Array.isArray(r) && typeof r.rowsFile === "string") {
      const rows = fs.readFileSync(r.rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const { rowsFile, rowsChars, rowCount, note, ...rest } = r;
      return { ...rest, tasks: rows };
    }
    return r;
  };
  // Card 57cb355d: list_all_tasks default is CAPPED, and — since this board's BULK(105) rows exceed the
  // cap — the default (no offset/limit passed) now returns the {tasks,total,returned,offset,nextOffset}
  // envelope instead of a bare capped array with no cap signal, mirroring session_transcript's own shape.
  const capped = await callTasks({ projectId: "pBulk", includeBody: true });
  check("(5) list_all_tasks default (capped) returns the pagination envelope, not a bare array",
    !Array.isArray(capped) && Array.isArray(capped.tasks));
  check(`(5) list_all_tasks default is capped at ${DEFAULT_TASK_SUMMARY_CAP} (got ${capped.tasks.length})`, capped.tasks.length === DEFAULT_TASK_SUMMARY_CAP);
  check("(5) list_all_tasks envelope reports the TRUE total + a non-null nextOffset",
    capped.total === BULK && capped.returned === DEFAULT_TASK_SUMMARY_CAP && capped.offset === 0 && capped.nextOffset === DEFAULT_TASK_SUMMARY_CAP);
  const pagedPast = await callTasks({ projectId: "pBulk", includeBody: true, limit: DEFAULT_TASK_SUMMARY_CAP + 50 });
  check("(5) list_all_tasks pages past the cap with an explicit limit (envelope, nextOffset:null — nothing left)",
    pagedPast.tasks.length === BULK && pagedPast.total === BULK && pagedPast.nextOffset === null);
  const aggOff = await callTasks({ projectId: "pBulk", limit: 10, offset: 5 });
  check("(5) list_all_tasks honors limit/offset (envelope, nextOffset:15 — more remains)",
    aggOff.tasks.length === 10 && aggOff.offset === 5 && aggOff.nextOffset === 15);
  // Paging to the true end: offset:nextOffset from `capped` walks the remaining rows, ending at nextOffset:null.
  const lastPage = await callTasks({ projectId: "pBulk", includeBody: true, offset: capped.nextOffset });
  check("(5) list_all_tasks offset:nextOffset walk reaches the end (nextOffset:null, no gaps/overlaps)",
    lastPage.tasks.length === BULK - DEFAULT_TASK_SUMMARY_CAP && lastPage.nextOffset === null &&
    lastPage.tasks[0].id === `bulk-${DEFAULT_TASK_SUMMARY_CAP}`);
  // A SMALL board (well under the cap, e.g. `noDone` above on pTarget) stays a BARE array — today's
  // shape, unchanged, since nothing is truncated.
  check("(5) list_all_tasks on a small/uncapped board returns a bare array (no envelope)", Array.isArray(noDone));
  // The in-project tasks_list surface caps its default read too.
  const inProjServer = new TaskMcpRouter(db, wakes).buildServer("pBulk", "S");
  const [ipT, ipS] = InMemoryTransport.createLinkedPair();
  await inProjServer.connect(ipS);
  const ipClient = new Client({ name: "xtask-inproj", version: "0" });
  await ipClient.connect(ipT);
  // tasks_list returns NEWLINE-DELIMITED JSON (one task per line, card dc647ae2 part A) — not a JSON
  // array — so it stays Read/grep-pageable even if a wide window spills to a file (okLinesSpillable,
  // mirrors tasks-list-ndjson-spill.mjs's own read convention): below SPILL_INLINE_BUDGET_CHARS the text
  // IS the bare NDJSON (only when the result is UNTRUNCATED — see card 84f6ac42 below); above it, the
  // text is a single `{rowsFile,...}` pointer object instead, and the real rows live at `rowsFile`.
  // Follow the pointer when present so this section's row-count assertions hold regardless of how close a
  // given row count sits to that budget (row size grows over time as the Task schema grows — card
  // 0d4bc3f0 added `deferredItems` and pushed the 100-105-row responses here from comfortably inline to
  // just over budget).
  //
  // Card 84f6ac42: tasks_list now ALSO carries the SAME {total,returned,offset,nextOffset} completeness
  // signal list_all_tasks already has (checked in section (5) above) — a capped/paged in-project read is
  // no longer indistinguishable from a complete one. `ndjsonPage` returns {rows, ...meta}; `ndjson` is the
  // pre-existing rows-only convenience the two checks below already use.
  const ndjsonPage = (res) => {
    const text = res.content[0].text;
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.rowsFile === "string") {
      const rows = fs.readFileSync(parsed.rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const { rowsFile, rowsChars, rowCount, note, ...meta } = parsed;
      return { rows, ...meta };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.rows)) {
      const { rows, ...meta } = parsed;
      return { rows, ...meta };
    }
    return { rows: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };
  const ndjson = (res) => ndjsonPage(res).rows;
  const ipListPage = ndjsonPage(await ipClient.callTool({ name: "tasks_list", arguments: { includeBody: true } }));
  const ipList = ipListPage.rows;
  check(`(5) in-project tasks_list default is capped at ${DEFAULT_TASK_SUMMARY_CAP} (got ${ipList.length})`, ipList.length === DEFAULT_TASK_SUMMARY_CAP);
  check("(5) in-project tasks_list default (capped, no explicit args) signals the TRUE total + a non-null nextOffset",
    ipListPage.total === BULK && ipListPage.returned === DEFAULT_TASK_SUMMARY_CAP && ipListPage.offset === 0 && ipListPage.nextOffset === DEFAULT_TASK_SUMMARY_CAP);
  const ipPagedPage = ndjsonPage(await ipClient.callTool({ name: "tasks_list", arguments: { includeBody: true, limit: DEFAULT_TASK_SUMMARY_CAP + 50 } }));
  const ipPaged = ipPagedPage.rows;
  check("(5) in-project tasks_list pages past the cap with an explicit limit", ipPaged.length === BULK);
  check("(5) in-project tasks_list explicit-limit page signals the TRUE total + nextOffset:null (nothing left, the n==limit-with-nothing-after boundary)",
    ipPagedPage.total === BULK && ipPagedPage.returned === BULK && ipPagedPage.offset === 0 && ipPagedPage.nextOffset === null);
  await ipClient.close();

  // ===================== (6) enumeration gaps — profiles + schedules =====================
  const enumTools = (await client.listTools()).tools.map((t) => t.name);
  check("(6) loom-platform registers list_all_profiles + list_all_schedules + schedule_get + schedule_delete",
    ["list_all_profiles", "list_all_schedules", "schedule_get", "schedule_delete"].every((n) => enumTools.includes(n)));
  const prof = await call("profile_create", { profile: { name: "Bulk Rig", role: "worker" } });
  check("(6) list_all_profiles enumerates a created profile", (await call("list_all_profiles", {})).some((p) => p.id === prof.id));
  const sched = await call("schedule_create", { agentId: "agentWork", cron: "0 9 * * *" });
  check("(6) schedule_create returns a schedule id", !!sched.id && !sched.error);
  check("(6) list_all_schedules (no filter) enumerates it", (await call("list_all_schedules", {})).some((s) => s.id === sched.id));
  check("(6) list_all_schedules narrows by project (agentWork is in pTarget)", (await call("list_all_schedules", { projectId: "pTarget" })).some((s) => s.id === sched.id));
  check("(6) list_all_schedules excludes other projects (pHome has no such schedule)", !(await call("list_all_schedules", { projectId: "pHome" })).some((s) => s.id === sched.id));
  check("(6) schedule_get reads it back", (await call("schedule_get", { scheduleId: sched.id })).id === sched.id);
  check("(6) schedule_delete retires it", (await call("schedule_delete", { scheduleId: sched.id })).deleted === true && !db.getSchedule(sched.id));
  check("(6) schedule_get 404s a retired/unknown id", (await call("schedule_get", { scheduleId: sched.id })).error === "schedule not found");
  check("(6) schedule_delete 404s an unknown id", (await call("schedule_delete", { scheduleId: "ghost" })).error === "schedule not found");

  // ===================== (7) project_configure unset / replace path =====================
  db.insertProject({ id: "pCfg", name: "Cfg", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
  await call("project_configure", { projectId: "pCfg", config: { docLint: true, obsidian: { autoStart: true }, orchestration: { maxConcurrentWorkers: 3 } } });
  check("(7) project_configure set several keys", db.getProject("pCfg").config.docLint === true && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", unset: ["docLint"] });
  check("(7) unset removes a top-level key, preserves the rest", db.getProject("pCfg").config.docLint === undefined && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", unset: ["orchestration.maxConcurrentWorkers"] });
  check("(7) unset removes a NESTED dot-path key", db.getProject("pCfg").config.orchestration?.maxConcurrentWorkers === undefined);
  check("(7) unset of an absent path is a harmless no-op (obsidian still set)", (await call("project_configure", { projectId: "pCfg", unset: ["nope.not.here"] })) && db.getProject("pCfg").config.obsidian.autoStart === true);
  await call("project_configure", { projectId: "pCfg", config: { docLint: false }, replace: true });
  check("(7) replace:true swaps the WHOLE override (obsidian gone, only docLint remains)",
    db.getProject("pCfg").config.docLint === false && db.getProject("pCfg").config.obsidian === undefined);

  // ===================== (8) resolvesEscalation — the structural triage link (card ba04d607) ============
  // File a real escalation from pTarget's manager onto the reserved pHome board, then link a NEW
  // project_task_create card to it via resolvesEscalation — the SAME param the Platform Lead uses when
  // filing an escalation's actual fix. This is the WRITE side of card ba04d607; escalation-status.mjs
  // proves the READ side (status deriving resolved/triaged off this link).
  const esc = svc.platformEscalate("M", { title: "resolvesEscalation test escalation", detail: "evidence", severity: "medium" });
  check("(8) setup: a real escalation was filed on the Platform board", !!esc.taskId && !esc.error);

  const fixCard = await call("project_task_create", {
    projectId: "pTarget", title: "fix(x): the actual fix for the escalation", body: "v1",
    resolvesEscalation: esc.taskId,
  });
  check("(8) resolvesEscalation: the create still succeeds and returns the destination Task row", !!fixCard.id && !fixCard.error);
  const link = db.findEscalationTriage(esc.taskId);
  check("(8) resolvesEscalation: db.findEscalationTriage resolves to the NEW destination card",
    link !== null && link.destinationProjectId === "pTarget" && link.destinationTaskId === fixCard.id);

  // An unambiguous 8-char id-prefix of the escalation resolves too (mirrors every other *_get id-prefix
  // convention on this surface).
  const escPrefix = esc.taskId.slice(0, 8);
  const fixCard2 = await call("project_task_create", { projectId: "pTarget", title: "fix via prefix", resolvesEscalation: escPrefix });
  check("(8) resolvesEscalation accepts an unambiguous 8-char id-prefix", !!fixCard2.id && !fixCard2.error);

  // An unknown escalation id is REJECTED — the WHOLE create fails, nothing is written (never an unlinked
  // card that silently drops the caller's stated intent).
  const nBefore8 = db.listTasks("pTarget").length;
  const badLink = await call("project_task_create", { projectId: "pTarget", title: "should not be created", resolvesEscalation: "not-a-real-task-id-at-all" });
  check("(8) resolvesEscalation: an unknown escalation id is REJECTED with {error}", typeof badLink.error === "string" && !badLink.id);
  check("(8) resolvesEscalation: the rejected create inserted NO card", db.listTasks("pTarget").length === nBefore8);

  // A taskId that IS real but lives on a DIFFERENT board (not the Platform home) must ALSO be rejected —
  // proves the resolver is scoped to pHome, never a bare unscoped db.getTask lookup that would silently
  // accept any task anywhere as an "escalation".
  const outOfScopeLink = await call("project_task_create", { projectId: "pTarget", title: "should not be created either", resolvesEscalation: fixCard.id });
  check("(8) resolvesEscalation: a taskId that exists but is NOT on the Platform board is rejected (scoped, no cross-board leak)",
    typeof outOfScopeLink.error === "string" && !outOfScopeLink.id);
  check("(8) resolvesEscalation: that rejected create ALSO inserted no card", db.listTasks("pTarget").length === nBefore8);

  await client.close();

  // ===================== (3) TRUST GATE — ABSENT from every agent-facing surface =====================
  const platformTools = await listTools(new PlatformMcpRouter(db, svc).buildServer("PL"));
  const setupTools = await listTools(new SetupMcpRouter(db, svc).buildServer());
  const orchRouter = new OrchestrationMcpRouter(db, svc);
  const mgrTools = await listTools(orchRouter.buildServer("M", "manager"));
  const workerTools = await listTools(orchRouter.buildServer("W", "worker"));
  const taskTools = await listTools(new TaskMcpRouter(db, wakes).buildServer("pTarget", "M"));

  check("(3) project_task_create IS on loom-platform (the only home)", platformTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-setup (operator surface)", !setupTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-orchestration MANAGER surface", !mgrTools.includes("project_task_create"));
  check("(3) project_task_create is ABSENT from loom-orchestration WORKER surface", !workerTools.includes("project_task_create"));
  // The new cross-project task read/update + aggregate are platform-only too (no agent surface gains them).
  for (const t of ["project_task_get", "project_task_update", "list_all_tasks"]) {
    check(`(3) ${t} IS on loom-platform and ABSENT from setup/manager/worker`,
      platformTools.includes(t) && !setupTools.includes(t) && !mgrTools.includes(t) && !workerTools.includes(t));
  }
  // Belt-and-suspenders: the in-project loom-tasks surface only carries the project-scoped tasks_create
  // (no projectId arg) — confirm the cross-project variant never leaked there either.
  check("(3) the in-project loom-tasks surface has NO cross-project create (only scoped tasks_create)",
    taskTools.includes("tasks_create") && !taskTools.includes("project_task_create"));

  // Negative control: prove the absence assertion has teeth (the gate would catch a leak).
  check("(3) negative control: a tool that DOES exist on orchestration is detected (proves teeth)",
    mgrTools.includes("worker_spawn"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Lead's cross-project task surface is complete: project_task_create boards a card on a DIFFERENT project's board, and project_task_get/update + list_all_tasks let the Lead read→move→re-prioritize it end-to-end (column-existence guard on move — shared with in-project tasks_update; cross-project + unknown-project guards; done-excluded summary aggregate). project_task_create ALSO runs the SAME cross-channel duplicate check as the in-project tasks_create (M1, card 0ef0270b) — checked against the TARGET project's board (not the Lead's own pHome), overridable via allowDuplicate/supersedes/relatedTo, and a supersedes override back-links the superseded card too (m7). resolvesEscalation (card ba04d607) structurally links a new card to the escalation it fixes (id-prefix accepted, unknown/out-of-scope ids rejected with nothing written) — the write side of escalation_status's derived resolved/triaged. tasks_list / list_all_tasks paginate (limit/offset) and cap the default read. Enumeration is filled (list_all_profiles/list_all_schedules + schedule_get/delete) and project_configure can unset (dot-path) / replace. All new tools are present ONLY on loom-platform — ABSENT from loom-setup, loom-orchestration (manager + worker), and the in-project loom-tasks surface — so no agent surface gains cross-project write."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
