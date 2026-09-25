import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dc13bcf1 — `worker_revive`: fork a MERGED worker's engine conversation onto a FRESH worktree/branch
// bound to a follow-up card. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// restricted-tools-spawn.mjs: isolated LOOM_HOME + sandboxed HOME, a REAL Db + SessionService driven against
// a FAKE pty injected via PtyHost's createPty() seam (captures the exact SpawnOpts the real host would turn
// into argv), and a REAL temp git repo backing createWorktree.
//
// What this covers (and does NOT): it proves the daemon hands the pty exactly the fork recipe
// (resumeId = source engine id, fork:true, a FRESH pre-assigned forkSessionId, cwd = the NEW worktree) and
// that every refusal fires BEFORE any side effect. That the real engine actually continues the conversation
// from a new cwd was proved separately by a real-interactive-claude spike (card dc13bcf1's spike report);
// buildSpawnArgs' translation of resumeId+fork+forkSessionId into `--resume … --fork-session --session-id`
// is pinned by the (A) block here against the REAL buildSpawnArgs.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-revive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrv-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildSpawnArgs } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { composeReviveKickoff } = await import("../dist/sessions/worker-revive.js");
const { ALL_ORCHESTRATION_EVENT_KINDS } = await import("@loom/shared");

const repo = path.join(os.tmpdir(), `loom-wrv-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-revive test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=wrv@loom -c user.name=wrv");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 } }, createdAt: now, archivedAt: null });
db.insertProject({ id: "pCap", name: "Cap", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 1 } }, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: "claude-test-model", icon: null });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_BASE_BRIEF_SENTINEL", position: 1, profileId: "profDev" });
db.insertAgent({ id: "agentPlainCap", projectId: "pCap", name: "PlainCap", startupPrompt: "PLAIN_PROMPT", position: 0, profileId: null });
db.insertAgent({ id: "agentDevCap", projectId: "pCap", name: "DevCap", startupPrompt: "DEV_BASE_BRIEF_SENTINEL", position: 1, profileId: "profDev" });
const mgrRow = (id, projectId, agentId) => ({ id, projectId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession(mgrRow("mgr1", "pP", "agentPlain"));
db.insertSession(mgrRow("mgr2", "pP", "agentPlain"));
db.insertSession(mgrRow("mgrCap", "pCap", "agentPlainCap"));

const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const task = (id, title, extra = {}) => db.insertTask({ id, projectId: "pP", title, body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now, ...extra });
const T_ORIG = uuid(1), T_FIX = uuid(2), T_FIX2 = uuid(3), T_TERM = uuid(4), T_LIVE = uuid(5), T_UNMERGED = uuid(6), T_CAP_FIX = uuid(7);
task(T_ORIG, "feat(x): the original landed card", { columnKey: "done" });
db.updateTask(T_ORIG, { mergedSha: "abc1234def" }); // written by finalizeMerge in real life
task(T_FIX, "fix(x): repair the landed commit", { body: "FIX_BODY_SENTINEL: the off-by-one in the landed commit." });
task(T_FIX2, "fix(x): second follow-up");
task(T_TERM, "fix(x): terminal card", { columnKey: "done" });
task(T_LIVE, "fix(x): card already held by a live worker");
task(T_UNMERGED, "feat(x): card whose worker never merged");
db.insertTask({ id: T_CAP_FIX, projectId: "pCap", title: "fix(x): cap follow-up", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// --- the MERGED source worker: its cwd/worktree is GONE (never created on disk) but its transcript survives. ---
const OLD_CWD = path.join(os.tmpdir(), `loom-wrv-gone-${process.pid}`, "old-worktree");
const ENG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tpath = engineTranscriptPath(OLD_CWD, ENG);
fs.mkdirSync(path.dirname(tpath), { recursive: true });
const TRANSCRIPT_BYTES = JSON.stringify({ type: "user", message: { content: "remember PLUM-7431" } }) + "\n";
fs.writeFileSync(tpath, TRANSCRIPT_BYTES);
const workerRow = (id, over = {}) => ({
  id, projectId: "pP", agentId: "agentDev", engineSessionId: ENG, title: null, cwd: OLD_CWD, processState: "exited",
  resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "mgr1", taskId: T_ORIG, worktreePath: OLD_CWD, branch: "loom/old", ...over,
});
db.insertSession(workerRow("src"));
const mergeDone = (workerSessionId, taskId) => db.appendEvent({ id: `ev-${workerSessionId}`, ts: now, managerSessionId: "mgr1", workerSessionId, taskId, kind: "merge_done", detail: { branch: "loom/old" } });
mergeDone("src", T_ORIG);

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; this.alive = new Set(); }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  // A codex-harness spawn goes through createCodexPty (NOT createPty): fake it too so a wrongly re-resolved
  // codex revive is CAPTURED (and fails the harness-pin asserts) instead of launching a real codex.
  createCodexPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive(id) { return this.alive.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const worktrees = [];

// Every refusal must throw with a recognisable message AND create nothing (no pty spawn, no new worker row).
const refuse = async (label, fn, re) => {
  const before = host.capture.length;
  const workersBefore = db.listWorkers("mgr1").length + db.listWorkers("mgrCap").length;
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(`(refuse) ${label}: throws /${re.source}/  (got ${err ? JSON.stringify(err.message.slice(0, 90)) : "NO THROW"})`, !!err && re.test(err.message));
  check(`(refuse) ${label}: NO pty spawned and NO worker row created`, host.capture.length === before && db.listWorkers("mgr1").length + db.listWorkers("mgrCap").length === workersBefore);
};

try {
  // ============ (0) the new event kind is a real registered kind ============
  check("(0) 'worker_revived' is a registered OrchestrationEventKind", ALL_ORCHESTRATION_EVENT_KINDS.includes("worker_revived"));

  // ============ (1) HAPPY PATH ============
  const revived = await svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: T_FIX, note: "NOTE_SENTINEL" });
  worktrees.push(revived.worktreePath);
  const o = host.capture.find((c) => c.sessionId === revived.id);
  check("(1) a pty was spawned for the revived worker", !!o);
  check("(1) resumeId = the SOURCE engine id", o?.resumeId === ENG);
  check("(1) fork:true (source transcript left pristine)", o?.fork === true);
  check("(1) forkSessionId is a FRESH id, not the source's", typeof o?.forkSessionId === "string" && o.forkSessionId.length > 0 && o.forkSessionId !== ENG);
  check("(1) spawn cwd = the NEW worktree, which exists on disk, and is NOT the vanished old cwd", o?.cwd === revived.worktreePath && fs.existsSync(revived.worktreePath) && o.cwd !== OLD_CWD);
  check("(1) role worker; profile model NOT passed (--fork-session inherits the transcript's model)", o?.role === "worker" && o?.model === undefined);
  check("(1) no sessionName on a fork (untested `-n` + --fork-session combination)", o?.sessionName === undefined);
  const kick = o?.startupPrompt ?? "";
  check("(1) kickoff says REVIVED, names the landed commit sha, the original card, and the stale-paths warning",
    /REVIVED/.test(kick) && kick.includes("abc1234def") && kick.includes(T_ORIG) && /STALE/.test(kick) && kick.includes(OLD_CWD));
  check("(1) kickoff carries the follow-up card's title, body, id and the manager note", kick.includes("fix(x): repair the landed commit") && kick.includes("FIX_BODY_SENTINEL") && kick.includes(T_FIX) && kick.includes("NOTE_SENTINEL"));
  check("(1) kickoff names the NEW worktree as the edit dir and drops the agent's base brief (the fork already carries it)", kick.includes(revived.worktreePath) && !kick.includes("DEV_BASE_BRIEF_SENTINEL"));
  const row = db.getSession(revived.id);
  check("(1) new row: fresh Loom id, parent = the manager, bound to the FOLLOW-UP task, new branch (not the old one)",
    revived.id !== "src" && row.parentSessionId === "mgr1" && row.taskId === T_FIX && !!row.branch && row.branch !== "loom/old" && row.worktreePath === revived.worktreePath);
  check("(1) new row persists the fork's pre-assigned engine id up front (== forkSessionId)", row.engineSessionId === o.forkSessionId);
  check("(1) the follow-up card moved to the active lane", db.getTask(T_FIX).columnKey !== "backlog");
  const ev = db.listEventsForWorker(revived.id).find((e) => e.kind === "worker_revived");
  check("(1) worker_revived event: {fromSessionId,toSessionId,taskId,commitSha}",
    !!ev && ev.detail?.fromSessionId === "src" && ev.detail?.toSessionId === revived.id && ev.detail?.taskId === T_FIX && ev.detail?.commitSha === "abc1234def");
  const src = db.getSession("src");
  check("(1) the OLD row is untouched: still exited, same engine id, same task, not marked recycled (hasSuccessor false)",
    src.processState === "exited" && src.engineSessionId === ENG && src.taskId === T_ORIG && db.hasSuccessor("src") === false);
  check("(1) the source transcript file is byte-identical (a fork never writes to it)", fs.readFileSync(tpath, "utf8") === TRANSCRIPT_BYTES);
  check("(1) result carries revivedFrom + commitSha + capacity", revived.revivedFrom === "src" && revived.commitSha === "abc1234def" && !!revived.capacity);

  // ============ (A) the REAL buildSpawnArgs turns that spawn into the engine fork recipe ============
  {
    const args = buildSpawnArgs({ resumeId: o.resumeId, fork: o.fork, forkSessionId: o.forkSessionId, settingsPath: "S", mode: "acceptEdits", mcpServers: {} });
    const i = args.indexOf("--resume");
    check("(A) argv = --resume <source id> --fork-session --session-id <fresh id>",
      i === 0 && args[1] === ENG && args[2] === "--fork-session" && args[3] === "--session-id" && args[4] === o.forkSessionId);
  }

  // ============ (2) an ORDINARY spawnWorker is byte-identical: no fork, no resume, the base brief present ============
  const plain = await svc.spawnWorker("mgr1", { taskId: T_FIX2, agentId: "agentDev", kickoffPrompt: "ORDINARY_KICKOFF" });
  worktrees.push(plain.worktreePath);
  const po = host.capture.find((c) => c.sessionId === plain.id);
  check("(2) ordinary spawn: NO resumeId/fork/forkSessionId keys, model still passed, base brief present, engine id null",
    po && !("resumeId" in po) && !("fork" in po) && !("forkSessionId" in po) && po.model === "claude-test-model" && po.startupPrompt.includes("DEV_BASE_BRIEF_SENTINEL") && db.getSession(plain.id).engineSessionId === null);
  check("(2) ordinary spawn files NO worker_revived event", !db.listEventsForWorker(plain.id).some((e) => e.kind === "worker_revived"));

  // ============ (3) REFUSAL MATRIX (each: throws + nothing created) ============
  await refuse("caller is not a manager", () => svc.reviveWorker("src", { workerSessionId: "src", taskId: T_FIX2 }), /not a manager/);
  await refuse("unknown source session", () => svc.reviveWorker("mgr1", { workerSessionId: "nope", taskId: T_FIX2 }), /does not resolve to a session/);
  db.insertSession(workerRow("srcOther", { parentSessionId: "mgr2" })); mergeDone("srcOther", T_ORIG);
  await refuse("another manager's worker", () => svc.reviveWorker("mgr1", { workerSessionId: "srcOther", taskId: T_FIX2 }), /not your worker/);
  db.insertSession(workerRow("srcNotWorker", { role: "auditor" })); mergeDone("srcNotWorker", T_ORIG);
  await refuse("source is not a worker-role session", () => svc.reviveWorker("mgr1", { workerSessionId: "srcNotWorker", taskId: T_FIX2 }), /not a worker/);
  db.insertSession(workerRow("srcCodex", { harness: "codex" })); mergeDone("srcCodex", T_ORIG);
  await refuse("codex source", () => svc.reviveWorker("mgr1", { workerSessionId: "srcCodex", taskId: T_FIX2 }), /codex has no fork/);
  host.alive.add("src");
  await refuse("source pty still live", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: T_FIX2 }), /still live/);
  host.alive.delete("src");
  // NEGATIVE CONTROL for the "merged" signal: a worker whose card sits in the terminal column but that has NO
  // merge_done event must be refused — proves merge_done (not the column, resumability or archive flags) is the gate.
  db.insertSession(workerRow("srcUnmerged", { taskId: T_UNMERGED }));
  db.updateTask(T_UNMERGED, { columnKey: "done" });
  await refuse("no merge_done event (card even in the terminal column)", () => svc.reviveWorker("mgr1", { workerSessionId: "srcUnmerged", taskId: T_FIX2 }), /no merge_done/);
  db.insertSession(workerRow("srcTaskless", { taskId: null })); mergeDone("srcTaskless", null);
  await refuse("taskless source", () => svc.reviveWorker("mgr1", { workerSessionId: "srcTaskless", taskId: T_FIX2 }), /no task/);
  db.insertSession(workerRow("srcNoEng", { engineSessionId: null })); mergeDone("srcNoEng", T_ORIG);
  await refuse("source never started (no engine id)", () => svc.reviveWorker("mgr1", { workerSessionId: "srcNoEng", taskId: T_FIX2 }), /never started/);
  db.insertSession(workerRow("srcNoTx", { engineSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })); mergeDone("srcNoTx", T_ORIG);
  await refuse("source transcript missing (rotated/deleted)", () => svc.reviveWorker("mgr1", { workerSessionId: "srcNoTx", taskId: T_FIX2 }), /transcript is missing/);
  await refuse("taskId omitted/blank", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: "  " }), /requires the follow-up card's taskId/);
  await refuse("taskId is the ORIGINAL merged card", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: T_ORIG }), /own MERGED card/);
  await refuse("taskId does not resolve", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: "zzzzzzzz-not-a-task" }), /does not resolve to an existing task/);
  await refuse("follow-up card already has a live worker (the one-live-worker guard)", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: T_FIX }), /already has a live worker/);
  await refuse("follow-up card is in the terminal column", () => svc.reviveWorker("mgr1", { workerSessionId: "src", taskId: T_TERM }), /terminal column/);
  // Cap: mgrCap's project allows ONE worker and it already has one live → the revive is refused with a
  // plain error (never cap-QUEUED — a queued replay would be a fresh, memory-less spawn).
  db.insertSession(workerRow("srcCap", { projectId: "pCap", agentId: "agentDevCap", parentSessionId: "mgrCap", taskId: T_ORIG })); mergeDone("srcCap", T_ORIG);
  db.insertSession(workerRow("capHolder", { projectId: "pCap", agentId: "agentDevCap", parentSessionId: "mgrCap", processState: "live", taskId: null, engineSessionId: null }));
  await refuse("concurrency cap reached (counts against the cap, never queued)", () => svc.reviveWorker("mgrCap", { workerSessionId: "srcCap", taskId: T_CAP_FIX }), /cap reached.*not queued/);

  // ============ (5) HARNESS PIN: a revive never re-resolves its harness from the profile / default-harness config ============
  const T_H1 = uuid(8), T_H2 = uuid(9), T_H3 = uuid(1) .replace(/1/g, "a");
  task(T_H1, "fix(x): harness pin via platform default"); task(T_H2, "fix(x): harness pin via profile"); task(T_H3, "fix(x): positive control");
  db.insertProfile({ id: "profCodex", name: "DevCodex", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
  db.insertAgent({ id: "agentDevCodex", projectId: "pP", name: "DevCodex", startupPrompt: "CODEX_BRIEF", position: 2, profileId: "profCodex" });
  db.setPlatformConfig({ harness: { default: "codex", scope: "workers" } });
  const h1src = "srcH1"; db.insertSession(workerRow(h1src)); mergeDone(h1src, T_ORIG);
  const h1 = await svc.reviveWorker("mgr1", { workerSessionId: h1src, taskId: T_H1 });
  worktrees.push(h1.worktreePath);
  const oh1 = host.capture.find((c) => c.sessionId === h1.id);
  check("(5) platform default=codex: the revive STILL forks on claude (opts.harness undefined, resumeId + fork present)", !!oh1 && oh1.harness === undefined && oh1.resumeId === ENG && oh1.fork === true);
  check("(5) platform default=codex: the revived row is NOT stamped codex", (db.getSession(h1.id).harness ?? null) === null);
  const h2src = "srcH2"; db.insertSession(workerRow(h2src, { agentId: "agentDevCodex" })); mergeDone(h2src, T_ORIG);
  const h2 = await svc.reviveWorker("mgr1", { workerSessionId: h2src, taskId: T_H2 });
  worktrees.push(h2.worktreePath);
  const oh2 = host.capture.find((c) => c.sessionId === h2.id);
  check("(5) the agent's profile now says codex: the revive STILL forks on claude", !!oh2 && oh2.harness === undefined && oh2.resumeId === ENG && oh2.fork === true && (db.getSession(h2.id).harness ?? null) === null);
  // POSITIVE CONTROL: under the SAME config an ORDINARY worker spawn on that codex-profile agent really does go codex,
  // so the two results above are the pin, not a broken codex path.
  const ctl = await svc.spawnWorker("mgr1", { taskId: T_H3, agentId: "agentDevCodex", kickoffPrompt: "CTL" });
  worktrees.push(ctl.worktreePath);
  check("(5) POSITIVE CONTROL: an ordinary spawn on the codex-profile agent goes codex", host.capture.find((c) => c.sessionId === ctl.id)?.harness === "codex");
  db.setPlatformConfig({});

  // ============ (6) SHARED spawn:<taskId> pending-op key: a revive never reports a PLAIN spawn as its own ============
  const T_C1 = uuid(7).replace(/7/g, "b"), T_C2 = uuid(7).replace(/7/g, "c");
  task(T_C1, "fix(x): retained plain-spawn collision"); task(T_C2, "fix(x): in-flight plain-spawn collision");
  const plainC1 = await svc.spawnWorkerTracked("mgr1", { taskId: T_C1, agentId: "agentDev", kickoffPrompt: "PLAIN" });
  if (plainC1.settled && plainC1.ok) worktrees.push(plainC1.value.worktreePath);
  db.setProcessState(plainC1.value.id, "live");
  const rc1 = await svc.reviveWorkerTracked("mgr1", { workerSessionId: "src", taskId: T_C1 });
  check("(6) a RETAINED plain-spawn result on the card is NOT reported as a revive (settled error naming the collision)", plainC1.settled && plainC1.ok && rc1.settled && rc1.ok === false && /different spawn/.test(String(rc1.error?.message)));
  const before = host.capture.length;
  const inflight = svc.pendingOps.attach("spawn:" + T_C2, "spawn", "mgr1", 10, () => new Promise(() => {}));
  await inflight; // settles as {settled:false} after the 10ms sync budget; the op itself never resolves (stays running)
  const rc2 = await svc.reviveWorkerTracked("mgr1", { workerSessionId: "src", taskId: T_C2 });
  check("(6) an IN-FLIGHT plain spawn on the card is NOT attached to: settled error, nothing spawned", rc2.settled && rc2.ok === false && /different spawn/.test(String(rc2.error?.message)) && host.capture.length === before);
  void inflight;
  // POSITIVE CONTROL: a genuine tracked revive on a clean card settles OK with revivedFrom === the source.
  const T_C3 = uuid(7).replace(/7/g, "d"); task(T_C3, "fix(x): genuine tracked revive");
  const rc3 = await svc.reviveWorkerTracked("mgr1", { workerSessionId: "src", taskId: T_C3 });
  if (rc3.settled && rc3.ok) worktrees.push(rc3.value.worktreePath);
  check("(6) POSITIVE CONTROL: a genuine tracked revive settles ok with revivedFrom === the source", rc3.settled && rc3.ok === true && rc3.value.revivedFrom === "src");

  // ============ (4) the pure kickoff composer ============
  const k = composeReviveKickoff({ originalTaskId: "O", originalTaskTitle: "T", commitSha: null, oldWorktreePath: null, followUpTaskId: "F", followUpTitle: "FT", followUpBody: "", branch: "loom/f" });
  check("(4) kickoff with no sha / no body / no note degrades gracefully (says the sha was not recorded, no empty Manager-note section)",
    /sha was not recorded/.test(k) && /no body/.test(k) && !/Manager note/.test(k));
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(path.dirname(OLD_CWD), { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_revive forks the merged source's conversation (resumeId + fork + fresh forkSessionId) into a NEW worktree bound to the follow-up card, files worker_revived, leaves the source row/transcript untouched, counts against the cap, and refuses (with nothing created) every non-eligible source/task — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
