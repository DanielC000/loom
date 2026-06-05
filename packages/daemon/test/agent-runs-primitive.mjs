import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs R2 — the AgentRun primitive + submit_result. DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE
// (same style as profile-spawn.mjs): isolated LOOM_HOME, a REAL Db + SessionService driven against a
// FAKE pty injected via PtyHost's createPty() seam, a REAL temp git repo so createRunSnapshot's git
// plumbing runs — the only thing faked is the claude pty. Proves the R2 DoD:
//   1. run-spawn assembly: NO worktree; cwd is a disposable HEAD snapshot ISOLATED from the real repo;
//      composed startupPrompt = doctrine+input+schema; ONLY the run MCP mounted (not even loom-tasks).
//   2. submit_result: schema-validate → error-back-to-agent → retry → accept → record+complete; AND a
//      no-schema run accepts freeform.
//   3. teardown: a terminal run + transcript retention + snapshot-dir GC on session exit.
//   4. restart-mid-run → the run is marked FAILED (no resume), the session is exited (no zombie), and
//      orphaned snapshots are swept; a live run is excluded from the restart resume set.
//   5. the run MCP (submit_result) is reachable ONLY for a kind==="run" session.
//   + existing spawns stay byte-identical (buildMcpServers for non-run roles is unchanged).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-primitive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-runs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { RunMcpRouter } = await import("../dist/mcp/run.js");
const { composeRunStartupPrompt } = await import("../dist/runs/prompt.js");
const { runSnapshotDir } = await import("../dist/runs/snapshot.js");
const { archivedTranscriptPath } = await import("../dist/sessions/transcript.js");

// --- a real temp git repo with a committed file, so createRunSnapshot (git read-tree/checkout-index)
//     has a HEAD to extract and we can verify the snapshot carries committed content ---
const repo = path.join(os.tmpdir(), `loom-runs-repo-${Date.now()}`);
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs test\n");
fs.writeFileSync(path.join(repo, "src", "code.js"), "export const TRACKED = 1;\n");
execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const PROJECT_ID = "pRun";
const db = new Db();
db.insertProject({ id: PROJECT_ID, name: "RunProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// An endpoint agent (the run is spawned in it); R2 starts runs internally so endpoint isn't enforced,
// but flag it true to mirror real usage. A plain agent gives a NON-run session for the role-gate test.
db.insertAgent({ id: "agentEndpoint", projectId: PROJECT_ID, name: "Analyst", startupPrompt: "AGENT_DOCTRINE_PROMPT", position: 0, profileId: null, endpoint: true, ioSchema: null });
db.insertAgent({ id: "agentPlain", projectId: PROJECT_ID, name: "Plain", startupPrompt: "PLAIN", position: 1, profileId: null });

// --- fake pty + a PtyHost subclass capturing every SpawnOpts via createPty(); fireExit triggers the
//     captured onExit so teardown (events.onExit → onRunSessionExit) runs deterministically ---
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; this.exitCbs = new Map(); }
  createPty(opts) {
    this.capture.push(opts);
    const self = this;
    return {
      pid: 4242,
      write() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { self.exitCbs.set(opts.sessionId, cb); return { dispose() {} }; },
      kill() { const cb = self.exitCbs.get(opts.sessionId); if (cb) cb({ exitCode: 0 }); },
      resize() {},
    };
  }
  fireExit(sessionId, code = 0) { const cb = this.exitCbs.get(sessionId); if (cb) cb({ exitCode: code }); }
}

// events sink wired like index.ts: onExit OWNS live→exited AND finalizes a run session's teardown.
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats(id, s) { db.setContextCounters(id, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns, model: s.model }); },
  onRateLimited() {},
  onExit(id) {
    db.setProcessState(id, "exited"); db.setBusy(id, false);
    const s = db.getSession(id);
    if (s?.role === "run") svc.onRunSessionExit(id);
  },
};

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

try {
  // ===================== 1. RUN SPAWN ASSEMBLY =====================
  const schema = { type: "object", required: ["answer"], additionalProperties: true, properties: { answer: { type: "string" } } };
  const input = { question: "what is the answer?" };
  const { run, session } = await svc.startRun({ agentId: "agentEndpoint", input, schema });
  const o = optsFor(session.id);

  check("1 session role is 'run' (returned + persisted)", session.role === "run" && db.getSession(session.id).role === "run");
  check("1 spawn opts.role === 'run' (drives the loom-run-only MCP surface)", o?.role === "run");
  check("1 run row links to its session (1:1) + is in-flight 'running'", run.sessionId === session.id && db.getRun(run.id).status === "running");

  // cwd ISOLATION: a disposable snapshot under runs/<sid>/, NOT the live repoPath; carries committed HEAD; no .git.
  check("1 cwd is the disposable run snapshot, NOT the live repo", o?.cwd === runSnapshotDir(session.id) && o?.cwd !== repo);
  check("1 snapshot exists + carries committed HEAD content (tracked file copied)", fs.existsSync(path.join(o.cwd, "src", "code.js")));
  check("1 snapshot has NO .git (no branch/worktree registration — sidesteps worktree-GC)", !fs.existsSync(path.join(o.cwd, ".git")));
  // writing into the snapshot must NOT touch the real repo (acceptEdits is gate-free): prove they're distinct trees.
  fs.writeFileSync(path.join(o.cwd, "scratch.txt"), "run wrote this");
  check("1 a write in the snapshot does NOT appear in the live repo", !fs.existsSync(path.join(repo, "scratch.txt")));
  // NO git worktree created for this run (the worker machinery is SUBTRACTED).
  check("1 NO git worktree was registered for the run", !fs.existsSync(path.join(tmpHome, "worktrees", PROJECT_ID)));

  // composed startupPrompt = doctrine + input + schema (one injection).
  check("1 startupPrompt equals composeRunStartupPrompt(doctrine, input, schema)",
    o?.startupPrompt === composeRunStartupPrompt("AGENT_DOCTRINE_PROMPT", input, schema));
  check("1 startupPrompt contains the agent doctrine, the input JSON, and the schema + submit_result contract",
    o.startupPrompt.includes("AGENT_DOCTRINE_PROMPT")
    && o.startupPrompt.includes('"question"')
    && o.startupPrompt.includes('"answer"')
    && o.startupPrompt.includes("submit_result"));

  // ONLY the run MCP mounted — not even loom-tasks.
  const runServers = buildMcpServers({ sessionId: session.id, port: 4317, role: "run" });
  check("1 ONLY loom-run is mounted for a run (no loom-tasks/orch/platform/audit)",
    Object.keys(runServers).length === 1 && !!runServers["loom-run"] && !runServers["loom-tasks"]);
  // byte-identical for existing roles: non-run spawns still mount loom-tasks (+ role surface), never loom-run.
  const mgrServers = buildMcpServers({ sessionId: "m1", port: 4317, role: "manager" });
  const plainServers = buildMcpServers({ sessionId: "p1", port: 4317, role: undefined });
  check("1 existing spawns byte-identical: manager keeps loom-tasks + loom-orchestration, NO loom-run",
    !!mgrServers["loom-tasks"] && !!mgrServers["loom-orchestration"] && !mgrServers["loom-run"]);
  check("1 existing spawns byte-identical: a plain session keeps ONLY loom-tasks, NO loom-run",
    Object.keys(plainServers).length === 1 && !!plainServers["loom-tasks"] && !plainServers["loom-run"]);

  // ===================== 2. submit_result — validate → error → retry → accept → record =====================
  const bad = svc.submitRunResult(session.id, { wrong: true }); // missing required "answer"
  check("2 a schema-mismatch returns a STRUCTURED error to the agent (ok:false + errors[])",
    bad.ok === false && Array.isArray(bad.errors) && bad.errors.length > 0);
  check("2 after a mismatch the run is STILL in-flight (the agent can self-correct + retry)",
    db.getRun(run.id).status === "running" && db.getRun(run.id).result === null);

  const good = svc.submitRunResult(session.id, { answer: "42" }); // valid → accept
  check("2 a schema-valid payload is accepted (ok:true)", good.ok === true);
  const recorded = db.getRun(run.id);
  check("2 the result is recorded + the run marked completed (terminal, endedAt stamped)",
    recorded.status === "completed" && recorded.result?.answer === "42" && !!recorded.endedAt);

  const again = svc.submitRunResult(session.id, { answer: "x" }); // a terminal run rejects a 2nd submit
  check("2 a completed run rejects a second submit_result", again.ok === false);

  // no-schema run → freeform accept
  const { run: run2, session: s2 } = await svc.startRun({ agentId: "agentEndpoint", input: { q: 1 }, schema: null });
  check("2 a no-schema run injects the freeform submit_result contract (no schema block)",
    optsFor(s2.id).startupPrompt.includes("freeform") && optsFor(s2.id).startupPrompt.includes("submit_result"));
  const free = svc.submitRunResult(s2.id, { anything: [1, 2, 3], note: "freeform-ok" });
  check("2 a no-schema run accepts freeform JSON and completes",
    free.ok === true && db.getRun(run2.id).status === "completed" && db.getRun(run2.id).result?.note === "freeform-ok");

  // ===================== 3. TEARDOWN — terminal run + transcript retention + snapshot GC on exit =====================
  // Pre-stage a fake archived transcript so onRunSessionExit can retain a transcriptRef (no real engine JSONL in a hermetic test).
  const archPath = archivedTranscriptPath(PROJECT_ID, session.id);
  fs.mkdirSync(path.dirname(archPath), { recursive: true });
  fs.writeFileSync(archPath, '{"type":"assistant","message":{"content":"done"}}\n');
  host.fireExit(session.id); // graceful-stop already issued by submit; this delivers the pty exit
  check("3 the run SESSION is exited after teardown (no zombie)", db.getSession(session.id).processState === "exited");
  check("3 the completed run stays completed through teardown (not re-failed)", db.getRun(run.id).status === "completed");
  check("3 teardown retains the transcript pointer on the run row", db.getRun(run.id).transcriptRef === archPath);
  // the disposable snapshot cwd is GC'd (async best-effort — poll briefly).
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { if (!fs.existsSync(runSnapshotDir(session.id))) gone = true; else await sleep(25); }
  check("3 the disposable snapshot dir is GC'd on teardown", gone);

  // a run session that EXITS WITHOUT submitting is terminally FAILED (never left dangling).
  const { run: run4, session: s4 } = await svc.startRun({ agentId: "agentEndpoint", input: {}, schema: null });
  host.fireExit(s4.id); // pty dies before any submit_result
  check("3 a run whose session exits before submit_result is marked FAILED", db.getRun(run4.id).status === "failed" && !!db.getRun(run4.id).error);

  // ===================== 4. RESTART MID-RUN → FAIL CLEAN (no resume, no zombie) =====================
  const { run: run3, session: s3 } = await svc.startRun({ agentId: "agentEndpoint", input: {}, schema: null });
  check("4 a LIVE run is EXCLUDED from the restart resume set (runs do not resume)",
    !svc.liveFleetResumeSet().some((e) => e.sessionId === s3.id));
  // simulate a daemon restart: recoverStaleSessions exits prior-run sessions; reconcileRunsOnBoot fails interrupted runs.
  db.recoverStaleSessions();
  const recon = svc.reconcileRunsOnBoot();
  check("4 reconcileRunsOnBoot failed the interrupted run", recon.failed >= 1 && db.getRun(run3.id).status === "failed" && !!db.getRun(run3.id).error);
  check("4 the interrupted run's session is exited (no zombie)", db.getSession(s3.id).processState === "exited");
  check("4 the interrupted run's snapshot dir was swept", !fs.existsSync(runSnapshotDir(s3.id)));

  // ===================== 5. run MCP reachable ONLY for kind==="run" =====================
  const runRouter = new RunMcpRouter(db, svc);
  const plain = svc.startNew("agentPlain"); // a NON-run session
  check("5 RunMcpRouter.resolveRole is NON-null for a run session", runRouter.resolveRole(s3.id) !== null);
  check("5 RunMcpRouter.resolveRole is null for a non-run (plain) session", runRouter.resolveRole(plain.id) === null);
  check("5 RunMcpRouter.resolveRole is null for an unknown session", runRouter.resolveRole("does-not-exist") === null);
} finally {
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the AgentRun primitive: snapshot-isolated cwd (no worktree), doctrine+input+schema prompt, loom-run-only MCP, submit_result validate→retry→accept, freeform accept, terminal teardown + GC, restart→fail-clean, and the run MCP gated to kind==='run' — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
