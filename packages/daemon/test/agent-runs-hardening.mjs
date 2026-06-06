import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs HARDENING (split from 0563a442 #3 + #6) — two follow-ups on the shipped R1–R4 stack.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, in the style of agent-runs-rest.mjs:
//
//   • PART A — endpoint-STALENESS re-check at the run-start CHOKE POINT (R3 auth hardening). A key
//     authorizes on its allowlist MEMBERSHIP (R1), which is captured at allowlist-edit time — so
//     un-endpointing an agent (PATCH {endpoint:false}) leaves that stale membership intact. startRun
//     now re-checks the LIVE endpoint flag and REFUSES a non-endpoint agent; the R3 route ALSO
//     pre-checks for a clean 403. Proven via a REAL SessionService (fake pty) + the REAL POST /api/runs.
//
//   • PART B — serve RETAINED transcripts for OLD runs (close the R4b gap). Runs retain a snapshot at
//     transcriptRef (R2 teardown), but the session-transcript route only snapshot-falls-back on
//     archivedAt (which run sessions never get) → old runs read "No transcript". The new run-scoped
//     route GET /api/projects/:id/runs/:runId/transcript serves the LIVE engine JSONL while it exists,
//     else the retained snapshot; project-scoped 404. Proven via the REAL buildServer + on-disk fixtures.
//
// Run after a build: pnpm --filter @loom/daemon build && node test/agent-runs-hardening.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-arh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45393";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath, archivedTranscriptPath } = await import("../dist/sessions/transcript.js");

const now = new Date().toISOString();

// A real temp git repo with a committed HEAD so the REAL startRun (allow case) can createRunSnapshot.
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs-hardening test\n");
execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: repo });

try {
  // =====================================================================================================
  // PART A — endpoint-staleness re-check at startRun (the choke point) + the R3 route 4xx
  // =====================================================================================================
  const dbA = new Db(path.join(tmpHome, "a.db"));
  dbA.insertProject({ id: "pMain", name: "Main", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbA.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
  dbA.insertAgent({ id: "aPlain", projectId: "pMain", name: "Plain", startupPrompt: "", position: 1, profileId: null }); // endpoint:false by default

  // A real SessionService against a fake pty (the createPty seam) — startRun's endpoint check runs BEFORE
  // any snapshot/spawn, so the refuse cases never touch the repo or pty.
  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.exitCbs = new Map(); }
    createPty(opts) {
      const self = this;
      return {
        pid: 4242, write() {}, onData() { return { dispose() {} }; },
        onExit(cb) { self.exitCbs.set(opts.sessionId, cb); return { dispose() {} }; },
        kill() { const cb = self.exitCbs.get(opts.sessionId); if (cb) cb({ exitCode: 0 }); },
        resize() {},
      };
    }
  }
  const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(dbA, host, new OrchestrationControl());

  // (A1) startRun on a non-endpoint agent → REFUSED (throws), no run row minted.
  const runsBefore = dbA.listRuns("pMain").length;
  let a1threw = false, a1msg = "";
  try { await svc.startRun({ agentId: "aPlain", input: {}, schema: null }); } catch (e) { a1threw = true; a1msg = String(e.message || e); }
  check("A1 startRun REFUSES a non-endpoint agent (throws)", a1threw && /not an endpoint/i.test(a1msg));
  check("A1 the refused start minted NO run row (rejected before snapshot/spawn)", dbA.listRuns("pMain").length === runsBefore);

  // (A2) THE STALENESS BUG: an agent that WAS an endpoint gets un-endpointed → startRun now refuses it,
  //      even though a key may still allowlist it. (Without the live re-check this would have proceeded.)
  dbA.updateAgent("aEndpoint", { endpoint: false });
  let a2threw = false;
  try { await svc.startRun({ agentId: "aEndpoint", input: {}, schema: null }); } catch { a2threw = true; }
  check("A2 un-endpointed (was true→false) agent → startRun REFUSES (gate is on the LIVE flag)", a2threw);

  // (A3) re-endpoint it → startRun gets PAST the gate and actually starts (real snapshot + fake pty).
  dbA.updateAgent("aEndpoint", { endpoint: true });
  let a3ok = false, a3err = "";
  try { const { run } = await svc.startRun({ agentId: "aEndpoint", input: { q: 1 }, schema: null }); a3ok = !!run?.id; }
  catch (e) { a3err = String(e.message || e); }
  check(`A3 an endpoint:true agent passes the gate and starts${a3ok ? "" : ` (err=${a3err})`}`, a3ok);

  // --- the R3 route surfaces the live re-check as a clean 403 (allowlist membership intact, flag false) ---
  const mk = (allow) => dbA.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: allow, caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  // aEndpoint is currently endpoint:true → allowlisting it is permitted; THEN we un-endpoint it.
  const K = mk(["aEndpoint"]);
  dbA.updateAgent("aEndpoint", { endpoint: false }); // stale membership: still on the key, but no longer an endpoint

  const startCalls = [];
  const fakeSessions = { startRun: async (opts) => { startCalls.push(opts); return { run: { id: "r-x" }, session: { id: "s-x" } }; }, cancelRun: () => ({ status: "cancelled" }) };
  const stub = {};
  const appA = await buildServer({ db: dbA, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const stale = await appA.inject({ method: "POST", url: "/api/runs", headers: bearer(K.plaintext), payload: { agent: "aEndpoint", input: {} } });
  check("A4 POST /api/runs on an allowlisted-but-un-endpointed agent → 403 (live re-check)", stale.statusCode === 403);
  check("A4 the 403 names the endpoint reason (distinct from 'not allowlisted')", /not an endpoint/i.test(stale.body));
  check("A4 the refused route call started NOTHING (startRun never reached)", startCalls.length === 0);
  // re-endpoint → the SAME request now starts a run (proves it was ONLY the live flag gating it).
  dbA.updateAgent("aEndpoint", { endpoint: true });
  const ok = await appA.inject({ method: "POST", url: "/api/runs", headers: bearer(K.plaintext), payload: { agent: "aEndpoint", input: {} } });
  check("A4 re-endpointing the agent → the same POST now starts (202) + startRun reached", ok.statusCode === 202 && startCalls.length === 1);
  await appA.close();
  dbA.close();

  // =====================================================================================================
  // PART B — the run-scoped transcript route: live JSONL > retained snapshot; project-scoped 404
  // =====================================================================================================
  const dbB = new Db(path.join(tmpHome, "b.db"));
  dbB.insertProject({ id: "pB", name: "B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbB.insertProject({ id: "pOther", name: "Other", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbB.insertAgent({ id: "agB", projectId: "pB", name: "A", startupPrompt: "x", position: 0, profileId: null, endpoint: true, ioSchema: null });
  const appB = await buildServer({ db: dbB, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  // Helpers to lay down a session row + its run row + on-disk transcript fixtures.
  const mkSession = (id, engineSessionId, cwd) => dbB.insertSession({
    id, projectId: "pB", agentId: "agB", engineSessionId, title: null, cwd,
    processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "run", browserTesting: false,
  });
  const mkRun = (id, sessionId, transcriptRef) => dbB.insertRun({
    id, projectId: "pB", agentId: "agB", sessionId, keyId: null, status: "completed",
    input: null, schema: null, result: null, usage: null, transcriptRef, error: null,
    webhookUrl: null, idempotencyKey: null, createdAt: now, startedAt: now, endedAt: now,
  });
  const writeJsonl = (file, turns) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  };
  const userTurn = (text) => ({ type: "user", message: { content: text } });
  const asstTurn = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

  // (B1) LIVE run — engine JSONL on disk. The route renders it.
  const cwd1 = path.join(tmpHome, "snap-live");
  mkSession("sLive", "eng-live", cwd1);
  mkRun("rLive", "sLive", null);
  writeJsonl(engineTranscriptPath(cwd1, "eng-live"), [userTurn("hello live"), asstTurn("hi from LIVE")]);
  const live = await appB.inject({ method: "GET", url: "/api/projects/pB/runs/rLive/transcript" });
  check("B1 live run → 200 renders the engine JSONL turns", live.statusCode === 200 && live.json().length === 2 && live.json()[1].text === "hi from LIVE");

  // (B2) OLD run — engine JSONL GONE, retained snapshot present. The route falls back to the snapshot.
  const cwd2 = path.join(tmpHome, "snap-old");
  mkSession("sOld", "eng-old", cwd2); // no JSONL written for eng-old
  const snapPath = archivedTranscriptPath("pB", "sOld");
  writeJsonl(snapPath, [asstTurn("from the RETAINED snapshot")]);
  mkRun("rOld", "sOld", snapPath);
  const old = await appB.inject({ method: "GET", url: "/api/projects/pB/runs/rOld/transcript" });
  check("B2 old run (JSONL gone) → 200 renders the RETAINED snapshot", old.statusCode === 200 && old.json().length === 1 && old.json()[0].text === "from the RETAINED snapshot");

  // (B3) live takes PRECEDENCE over snapshot when both exist.
  const cwd3 = path.join(tmpHome, "snap-both");
  mkSession("sBoth", "eng-both", cwd3);
  writeJsonl(engineTranscriptPath(cwd3, "eng-both"), [asstTurn("LIVE wins")]);
  writeJsonl(archivedTranscriptPath("pB", "sBoth"), [asstTurn("stale snapshot")]);
  mkRun("rBoth", "sBoth", archivedTranscriptPath("pB", "sBoth"));
  const both = await appB.inject({ method: "GET", url: "/api/projects/pB/runs/rBoth/transcript" });
  check("B3 both present → LIVE engine JSONL wins over the snapshot", both.statusCode === 200 && both.json()[0].text === "LIVE wins");

  // (B4) a run that never minted a session (snapshot-failed start) → [] (not a 500).
  mkRun("rNoSess", null, null);
  const noSess = await appB.inject({ method: "GET", url: "/api/projects/pB/runs/rNoSess/transcript" });
  check("B4 a session-less run → 200 with [] (no transcript, no crash)", noSess.statusCode === 200 && Array.isArray(noSess.json()) && noSess.json().length === 0);

  // (B5) project-scoping: the run exists but under pB, so pOther → 404; unknown run → 404.
  const crossProj = await appB.inject({ method: "GET", url: "/api/projects/pOther/runs/rLive/transcript" });
  check("B5 cross-project run id → 404 (project-scoped)", crossProj.statusCode === 404);
  const unknown = await appB.inject({ method: "GET", url: "/api/projects/pB/runs/does-not-exist/transcript" });
  check("B5 unknown run id → 404", unknown.statusCode === 404);

  await appB.close();
  dbB.close();
  await sleep(10);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs hardening: startRun + the R3 route re-check the LIVE endpoint flag (un-endpointing stops a stale-allowlisted key), and the new run-scoped transcript route serves live JSONL else the retained snapshot, project-scoped 404 — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
