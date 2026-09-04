import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card badba5a8 — OBSERVABILITY ONLY: record whether the codescape discovery block (card 0e4a859a) was
// injected at spawn, without touching the injection behavior/gate conditions/block text (all of that
// stays exactly as codescape-prompt-block.mjs already proves).
//
// Proves the DoD:
//   (1) `readCodescapePromptBlockAsset` (paths.ts) — the pure asset-read half — correctly classifies a
//       missing/unreadable path, a present-but-empty(-after-trim) file, and real content, as THREE
//       distinct outcomes never collapsed, against a fully CONTROLLED fixture path (never the real,
//       shared, tracked CODESCAPE_PROMPT_BLOCK_ASSET file — mutating that mid-test would race every
//       other codescape test in this repo's gate).
//   (2) `composeCodescapeInjectionStatus` (sessions/service.ts) — the pure composer — is proven, with
//       literal info/asset fixtures, to reproduce the EXACT text (or null) for all SEVEN outcomes: the
//       four graph-gate failures, the two asset failures (kept DISTINCT per Ruling 1), and BOTH injected
//       shapes (stamped / unstamped) — the Ruling 2 equivalence proof that the refactor consolidating
//       resolveCodescapeBlockText into a delegator over resolveCodescapeInjectionStatus did not change
//       the rendered text, asserted with `===` (not `.includes`) so a null-vs-empty-string regression
//       would be caught.
//   (3) END-TO-END: the daemon-wide "discovery_block_injection" OrchestrationEventKind (never present in
//       EVENT_TRIGGER_EVENT_KINDS/GATE_HISTORY_KINDS — an observability-only kind, and deliberately named
//       WITHOUT the private feature's name — see (0) below and codescape-privacy-guard.mjs: @loom/shared
//       ships in full to every end user, unlike the daemon package) is appended, with the right
//       {injected, reason, stamped} detail and the right managerSessionId/workerSessionId/taskId wiring,
//       at all FIVE real injection call sites — startNew (manager-role branch), startManager (plain AND
//       scheduler-fired), spawnWorker, recycleWorker, recycleManager — covering a POSITIVE control
//       (injected, both stamped and unstamped) and a NEGATIVE control per graph-gate reason
//       (no-supervisor / not-enabled / no-port / no-project-id). The event NEVER carries the block's own
//       prose (DoD-4) — only the three fields.
//   (4) NEGATIVE CONTROL: a role that never reaches the codescape branch (a plain/companion startNew
//       spawn) records NO "discovery_block_injection" event at all — proving (3) isn't vacuously passing
//       because every spawn gets one regardless of role.
//
// SCOPE, STATED NOT PAPERED OVER: the asset-unreadable/asset-empty REASONS are proven at the pure-
// function level (1)+(2) only, never end-to-end through a real spawn — doing that would require making
// the real, shared, tracked CODESCAPE_PROMPT_BLOCK_ASSET file unreadable/empty mid-test, which risks
// racing any concurrently-running codescape test in this repo's gate. The WIRING from
// `resolveCodescapeInjectionStatus` into that real path is a single-line call (`readCodescapePromptBlockAsset(CODESCAPE_PROMPT_BLOCK_ASSET)`)
// verified by direct code reading, not a second, independently-testable branch.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like codescape-prompt-block.mjs: isolated LOOM_HOME + a
// sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty (PtyHost's createPty() seam) and
// a FAKE CodescapeSupervisor injected via SessionService's `opts.codescape` — no real supervisor/serve
// process, no real claude spawn.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-injection-event.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist) ---
const tmpHome = path.join(os.tmpdir(), `loom-csinjevt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_BIN;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, composeCodescapeInjectionStatus } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");
const { readCodescapePromptBlockAsset } = await import("../dist/paths.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");
const { EVENT_TRIGGER_EVENT_KINDS, ALL_ORCHESTRATION_EVENT_KINDS } = await import("@loom/shared");

function writeManifest(homeDir, entries) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, projects: entries }));
}

// ===================== (0) the new kind exists + is correctly excluded from the trigger/gate-history allowlists =====================
{
  check("(0) 'discovery_block_injection' is a real, registered OrchestrationEventKind (build-time Record<K,true> already enforces this; this is the runtime confirmation)", ALL_ORCHESTRATION_EVENT_KINDS.includes("discovery_block_injection"));
  check("(0) 'discovery_block_injection' is NOT in EVENT_TRIGGER_EVENT_KINDS (observability-only, never a user-automation trigger)", !EVENT_TRIGGER_EVENT_KINDS.includes("discovery_block_injection"));
  check("(0) the kind name itself avoids the private feature's name (this file is a TEST, not shipped — but the real @loom/shared kind must, per codescape-privacy-guard.mjs; this just double-checks the constant used below)", !ALL_ORCHESTRATION_EVENT_KINDS.some((k) => /codescape/i.test(k)));
}

// ===================== (1) readCodescapePromptBlockAsset — pure, against a CONTROLLED fixture path only =====================
{
  const fixtureDir = path.join(tmpHome, "asset-fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const missingPath = path.join(fixtureDir, "does-not-exist.md");
  const emptyPath = path.join(fixtureDir, "empty.md");
  fs.writeFileSync(emptyPath, "   \n\t\n  "); // whitespace-only ⇒ empty AFTER TRIM
  const realPath = path.join(fixtureDir, "real.md");
  fs.writeFileSync(realPath, "  \nCodescape is available for this project.\n  ");

  const missingResult = readCodescapePromptBlockAsset(missingPath);
  check("(1a) missing file ⇒ {error:'unreadable'}", "error" in missingResult && missingResult.error === "unreadable");

  const emptyResult = readCodescapePromptBlockAsset(emptyPath);
  check("(1b) whitespace-only file ⇒ {error:'empty'} — DISTINCT from 'unreadable', never collapsed", "error" in emptyResult && emptyResult.error === "empty");
  check("(1b) negative control: 'unreadable' and 'empty' are genuinely DIFFERENT reason strings (proves they're not silently the same bucket)", missingResult.error !== emptyResult.error);

  const realResult = readCodescapePromptBlockAsset(realPath);
  check("(1c positive control) real content ⇒ no error, exact trimmed text", !("error" in realResult) && realResult.text === "Codescape is available for this project.");
}

// ===================== (2) composeCodescapeInjectionStatus — pure equivalence over ALL SEVEN outcomes =====================
{
  const okStamped = { ok: true, lastIngestedAt: "2026-08-01T09:30:00.000Z" };
  const okUnstamped = { ok: true, lastIngestedAt: null };
  const asset = { text: "Codescape is available for this project." };

  // --- the four graph-gate failures: text MUST be null (not ""), stamped MUST be null (not false) ---
  for (const reason of ["no-supervisor", "not-enabled", "no-port", "no-project-id"]) {
    const r = composeCodescapeInjectionStatus({ ok: false, reason }, undefined);
    check(`(2-${reason}) injected:false`, r.injected === false);
    check(`(2-${reason}) reason carries through EXACTLY`, r.reason === reason);
    check(`(2-${reason}) stamped is null (not false — never asked, not answered-false)`, r.stamped === null);
    check(`(2-${reason}) text is null (not '' — the null-vs-empty-string distinction Ruling 2 named)`, r.text === null);
  }

  // --- the two asset failures: DISTINCT reasons, same null/null shape ---
  const unreadable = composeCodescapeInjectionStatus(okStamped, { error: "unreadable" });
  check("(2-asset-unreadable) injected:false, reason:'asset-unreadable', stamped:null, text:null", unreadable.injected === false && unreadable.reason === "asset-unreadable" && unreadable.stamped === null && unreadable.text === null);
  const empty = composeCodescapeInjectionStatus(okStamped, { error: "empty" });
  check("(2-asset-empty) injected:false, reason:'asset-empty', stamped:null, text:null", empty.injected === false && empty.reason === "asset-empty" && empty.stamped === null && empty.text === null);
  check("(2-asset negative control) 'asset-unreadable' and 'asset-empty' are genuinely DIFFERENT reason strings", unreadable.reason !== empty.reason);
  // the real wiring passes `asset: undefined` whenever info.ok is false (resolveCodescapeInjectionStatus
  // never reads the asset in that branch) — prove that shape independently degrades sanely too.
  const undefinedAssetButOk = composeCodescapeInjectionStatus(okStamped, undefined);
  check("(2-defensive) ok:true + asset:undefined (should never happen via the real wiring, but must not throw/misclassify) ⇒ falls back to 'asset-unreadable', never crashes", undefinedAssetButOk.injected === false && undefinedAssetButOk.reason === "asset-unreadable");

  // --- the two injected outcomes: EXACT text, including the stamp-append shape ---
  const stampedStatus = composeCodescapeInjectionStatus(okStamped, asset);
  check("(2-injected-stamped) injected:true, reason:null", stampedStatus.injected === true && stampedStatus.reason === null);
  check("(2-injected-stamped) stamped:true", stampedStatus.stamped === true);
  check("(2-injected-stamped) EXACT text: base + the stamp suffix, byte-identical to the pre-refactor `${base} Graph last indexed: ${lastIngestedAt}.` shape", stampedStatus.text === "Codescape is available for this project. Graph last indexed: 2026-08-01T09:30:00.000Z.");

  const unstampedStatus = composeCodescapeInjectionStatus(okUnstamped, asset);
  check("(2-injected-unstamped) injected:true, reason:null", unstampedStatus.injected === true && unstampedStatus.reason === null);
  check("(2-injected-unstamped) stamped:false (not null — it WAS asked, the manifest read just returned nothing) — the card's §NEW sixth state", unstampedStatus.stamped === false);
  check("(2-injected-unstamped) EXACT text: base ONLY, no stamp suffix appended", unstampedStatus.text === "Codescape is available for this project.");
  check("(2 negative control) stamped and unstamped texts actually DIFFER (proves the stamp branch is live, not dead code)", stampedStatus.text !== unstampedStatus.text);
}

// ===================== (3)+(4) END-TO-END: the event fires at all five real call sites =====================
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");
process.env.LOOM_CODESCAPE_BIN = fixtureCli;

const repo = path.join(os.tmpdir(), `loom-csinjevt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codescape-injection-event test\n");
execSync(`git init -q && git add . && git -c user.email=cie@loom -c user.name=cie commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();

const stamp = "2026-08-01T09:30:00.000Z";
const homeDir = path.join(tmpHome, "cs-home");
writeManifest(homeDir, [{ id: "proj-cie-live", name: "P", path: repo, lastIngested: stamp, graphPath: "/x/graph.json" }]);
const emptyHomeDir = path.join(tmpHome, "cs-home-empty"); // no manifest entry ⇒ unstamped when injected, or no-project-id when resolveProjectId is also wired off it
fs.mkdirSync(emptyHomeDir, { recursive: true });

db.insertProject({ id: "pLive", name: "Live", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrLive", projectId: "pLive", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentWorkerLive", projectId: "pLive", name: "Worker", startupPrompt: "WORKER_BRIEF", position: 1, profileId: null });
db.insertProfile({ id: "profMgr", name: "Orchestrator Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentMgrProfile", projectId: "pLive", name: "Profile Orchestrator", startupPrompt: "AGENT_MGR_PROFILE_DOCTRINE", position: 2, profileId: "profMgr" });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);

const liveSupervisor = {
  getHomeDir: () => homeDir,
  getPort: () => 6001,
  resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir),
  async registerWorktree() { return { ok: true }; },
  async reingestMain() { return { ok: true }; },
  async dropWorktree() { return { ok: true }; },
};
const svc = new SessionService(db, host, new OrchestrationControl(), { codescape: liveSupervisor });

const worktrees = [];
const liveIds = [];
try {
  process.env.LOOM_DEV = "1";

  const codescapeEventsFor = (sessionId) => db.listEventsForSession(sessionId).filter((e) => e.kind === "discovery_block_injection");

  // --- (3a) startManager (plain): POSITIVE control, STAMPED ---
  const mgr = svc.startManager("agentMgrLive");
  liveIds.push(mgr.id);
  {
    const evs = codescapeEventsFor(mgr.id);
    check("(3a) startManager (plain): exactly ONE codescape_injection event, filed under its OWN id", evs.length === 1 && evs[0].managerSessionId === mgr.id);
    check("(3a) startManager (plain): no workerSessionId/taskId (a manager-self event)", !evs[0].workerSessionId && !evs[0].taskId);
    check("(3a) startManager (plain): detail = {injected:true, reason:null, stamped:true}", evs[0].detail?.injected === true && evs[0].detail?.reason === null && evs[0].detail?.stamped === true);
    check("(3a) startManager (plain): NEVER carries the block's own prose", !JSON.stringify(evs[0].detail ?? {}).toLowerCase().includes("codescape is available"));
  }

  // --- (3b) startManager with opts.scheduled:true: same call site, confirm the event still fires with the same shape ---
  const mgrScheduled = svc.startManager("agentMgrLive", null, { scheduled: true });
  liveIds.push(mgrScheduled.id);
  {
    const evs = codescapeEventsFor(mgrScheduled.id);
    check("(3b) startManager (scheduled): exactly ONE codescape_injection event", evs.length === 1);
    check("(3b) startManager (scheduled): detail = {injected:true, reason:null, stamped:true} — same live supervisor, same shape", evs[0].detail?.injected === true && evs[0].detail?.stamped === true);
  }

  // --- (3c) startNew, profile-derived manager-role spawn: POSITIVE control, same site as PL Auditor finding #8's gap ---
  const mgrProfile = svc.startNew("agentMgrProfile");
  liveIds.push(mgrProfile.id);
  {
    const evs = codescapeEventsFor(mgrProfile.id);
    check("(3c) startNew (profile-derived manager): resolves role=manager", mgrProfile.role === "manager");
    check("(3c) startNew (profile-derived manager): exactly ONE codescape_injection event", evs.length === 1);
    check("(3c) startNew (profile-derived manager): detail.injected true", evs[0].detail?.injected === true);
  }

  // --- (3d) startNew, a PLAIN (role-undefined) spawn: NEGATIVE CONTROL — proves (3a-c) isn't vacuous ---
  db.insertAgent({ id: "agentPlain", projectId: "pLive", name: "Plain", startupPrompt: "PLAIN_DOCTRINE", position: 3, profileId: null });
  const plain = svc.startNew("agentPlain");
  liveIds.push(plain.id);
  {
    const evs = codescapeEventsFor(plain.id);
    check("(3d negative control) startNew (plain, role undefined): NO codescape_injection event at all — the branch that never computes codescapeStatus", evs.length === 0);
  }

  // --- (3e) spawnWorker: POSITIVE control, filed under the PARENT manager + the worker + the task ---
  const taskLive = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.insertTask({ id: taskLive, projectId: "pLive", title: "T", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const worker = await svc.spawnWorker(mgr.id, { taskId: taskLive, agentId: "agentWorkerLive", kickoffPrompt: "GO" });
  liveIds.push(worker.id);
  worktrees.push(worker.worktreePath);
  {
    const evsOnWorker = codescapeEventsFor(worker.id);
    check("(3e) spawnWorker: exactly ONE codescape_injection event, workerSessionId = the new worker", evsOnWorker.length === 1 && evsOnWorker[0].workerSessionId === worker.id);
    check("(3e) spawnWorker: managerSessionId = the PARENT (not the worker itself)", evsOnWorker[0].managerSessionId === mgr.id);
    check("(3e) spawnWorker: taskId carried", evsOnWorker[0].taskId === taskLive);
    check("(3e) spawnWorker: detail = {injected:true, reason:null, stamped:true}", evsOnWorker[0].detail?.injected === true && evsOnWorker[0].detail?.stamped === true);
  }

  // --- (3f) recycleManager: POSITIVE control, UNSTAMPED this time (varies the stamp axis) — filed under the SUCCESSOR's OWN id ---
  const svcNoStamp = new SessionService(db, host, new OrchestrationControl(), {
    codescape: { getHomeDir: () => emptyHomeDir, getPort: () => 6002, resolveProjectId: () => "proj-cie-nostamp" },
  });
  const mgrSuccessor = await svcNoStamp.recycleManager(mgr.id, "CONTINUE_THE_WORK");
  liveIds.push(mgrSuccessor.id);
  {
    const evs = codescapeEventsFor(mgrSuccessor.id);
    check("(3f) recycleManager: exactly ONE codescape_injection event, filed under the SUCCESSOR's OWN id (not the predecessor's)", evs.length === 1 && evs[0].managerSessionId === mgrSuccessor.id);
    check("(3f) recycleManager: detail = {injected:true, stamped:false} — a real 'serving but unstamped' state, distinct from stamped", evs[0].detail?.injected === true && evs[0].detail?.stamped === false);
  }

  // --- (3g) recycleWorker: POSITIVE control, STAMPED, back on the live supervisor. `worker` was
  // re-parented onto `mgrSuccessor` by recycleManager's reparentLiveWorkers above — recycle through ITS
  // current manager, not the now-retired `mgr` (mirrors codescape-prompt-block.mjs's identical sequencing).
  const workerSuccessor = await svc.recycleWorker(mgrSuccessor.id, worker.id, "HANDOFF_TEXT");
  liveIds.push(workerSuccessor.id);
  {
    const evs = codescapeEventsFor(workerSuccessor.id);
    check("(3g) recycleWorker: exactly ONE codescape_injection event, workerSessionId = the successor worker", evs.length === 1 && evs[0].workerSessionId === workerSuccessor.id);
    check("(3g) recycleWorker: managerSessionId = the (re-parented) manager", evs[0].managerSessionId === mgrSuccessor.id);
    check("(3g) recycleWorker: detail = {injected:true, stamped:true}", evs[0].detail?.injected === true && evs[0].detail?.stamped === true);
  }

  // ===================== NEGATIVE CONTROLS — one per graph-gate reason, end-to-end via startManager =====================

  // (3h) no-supervisor
  const svcNoSup = new SessionService(db, host, new OrchestrationControl());
  const mgrNoSup = svcNoSup.startManager("agentMgrLive");
  liveIds.push(mgrNoSup.id);
  {
    const evs = codescapeEventsFor(mgrNoSup.id);
    check("(3h) no-supervisor: injected:false, reason:'no-supervisor', stamped:null", evs.length === 1 && evs[0].detail?.injected === false && evs[0].detail?.reason === "no-supervisor" && evs[0].detail?.stamped === null);
  }

  // (3i) not-enabled (LOOM_DEV on, supervisor live, but the PROJECT itself opted out)
  db.insertProject({ id: "pOff", name: "Off", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: false } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrOff", projectId: "pOff", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrOff = svc.startManager("agentMgrOff");
  liveIds.push(mgrOff.id);
  {
    const evs = codescapeEventsFor(mgrOff.id);
    check("(3i) not-enabled: injected:false, reason:'not-enabled', stamped:null", evs.length === 1 && evs[0].detail?.injected === false && evs[0].detail?.reason === "not-enabled" && evs[0].detail?.stamped === null);
  }

  // (3j) no-port
  const svcDown = new SessionService(db, host, new OrchestrationControl(), {
    codescape: { getHomeDir: () => homeDir, getPort: () => null, resolveProjectId: (rp) => resolveCodescapeProjectId(rp, homeDir) },
  });
  db.insertProject({ id: "pDown", name: "Down", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrDown", projectId: "pDown", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrDown = svcDown.startManager("agentMgrDown");
  liveIds.push(mgrDown.id);
  {
    const evs = codescapeEventsFor(mgrDown.id);
    check("(3j) no-port: injected:false, reason:'no-port', stamped:null", evs.length === 1 && evs[0].detail?.injected === false && evs[0].detail?.reason === "no-port" && evs[0].detail?.stamped === null);
  }

  // (3k) no-project-id (serve up, project enabled, but this repo has no manifest entry under this homeDir)
  const svcNoGraph = new SessionService(db, host, new OrchestrationControl(), {
    codescape: { getHomeDir: () => emptyHomeDir, getPort: () => 6003, resolveProjectId: (rp) => resolveCodescapeProjectId(rp, emptyHomeDir) },
  });
  db.insertProject({ id: "pNoGraph", name: "NoGraph", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgrNoGraph", projectId: "pNoGraph", name: "Mgr", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
  const mgrNoGraph = svcNoGraph.startManager("agentMgrNoGraph");
  liveIds.push(mgrNoGraph.id);
  {
    const evs = codescapeEventsFor(mgrNoGraph.id);
    check("(3k) no-project-id: injected:false, reason:'no-project-id', stamped:null", evs.length === 1 && evs[0].detail?.injected === false && evs[0].detail?.reason === "no-project-id" && evs[0].detail?.stamped === null);
  }
} finally {
  for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  for (const id of liveIds) { try { svc.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
  db.close();
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_BIN;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card badba5a8: the codescape discovery block's injection status is now RECORDED (never PAPERED OVER a gap that used to cost hand-reading a transcript): the pure asset-read and status-compose helpers are proven byte-exact over all seven outcomes (never null-vs-empty-string confused, never a collapsed reason), a new observability-only 'codescape_injection' OrchestrationEventKind fires at all five real spawn/recycle call sites with the right {injected, reason, stamped} shape and the right manager/worker/task wiring, a role that never reaches the branch records nothing (not vacuous), and the block's own prose is never logged — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
