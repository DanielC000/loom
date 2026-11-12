import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7eec7564 — the REST routes used to answer a generic 500 for three plain-Error refusals:
//   POST /api/agents/:id/sessions  on an unknown agent id            → now 404 "agent not found"
//   POST /api/sessions/:id/resume  on an unknown session             → now 404 "session not found"
//   POST /api/sessions/:id/resume  with no engine id / no transcript → now 409 with resume()'s own reason
//   POST /api/sessions/:id/fork    twin-path: unknown source → 404; nothing-to-fork refusals → 409
// A REAL Db + SessionService against a fake pty seam; the REAL buildServer. Claude-free, network-free.
// Control: a genuinely unexpected error still surfaces as a 500.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-h4xx-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
const { commitAll } = await import("./_git-commit.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");

const repo = path.join(os.tmpdir(), `loom-h4xx-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# h4xx\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=h@loom -c user.name=h");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "p1", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agent1", projectId: "p1", name: "A", startupPrompt: "X", position: 0, profileId: null });

const host = new (createSeamHost(PtyHost))({
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
});
const svc = new SessionService(db, host, new OrchestrationControl());

const seed = (id, eng) => db.insertSession({
  id, projectId: "p1", agentId: "agent1", engineSessionId: eng, title: null, cwd: repo,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null, parentSessionId: null,
});
seed("noEngine", null);          // no engine id at all
seed("noTranscript", "eng-gone"); // engine id, but no transcript file on disk

const stub = {};
const app = await buildServer({ db, pty: host, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const post = (url) => app.inject({ method: "POST", url });
const err = (r) => { try { return JSON.parse(r.body).error; } catch { return undefined; } };

try {
  const spawnUnknown = await post("/api/agents/nope/sessions");
  check("spawn on an unknown agent ⇒ 404", spawnUnknown.statusCode === 404);
  check("spawn unknown agent body names it", err(spawnUnknown) === "agent not found");
  const spawnUnknownMgr = await app.inject({ method: "POST", url: "/api/agents/nope/sessions", payload: { role: "manager" } });
  check("spawn unknown agent (role=manager) ⇒ 404", spawnUnknownMgr.statusCode === 404);

  const resUnknown = await post("/api/sessions/nope/resume");
  check("resume an unknown session ⇒ 404", resUnknown.statusCode === 404 && err(resUnknown) === "session not found");

  const resNoEng = await post("/api/sessions/noEngine/resume");
  check("resume with no engine id ⇒ 409", resNoEng.statusCode === 409 && err(resNoEng) === "session has no engine id to resume");

  const resNoTr = await post("/api/sessions/noTranscript/resume");
  check("resume with no engine transcript ⇒ 409", resNoTr.statusCode === 409);
  check("resume no-transcript body states why", /engine transcript missing/.test(err(resNoTr) ?? ""));

  const forkUnknown = await post("/api/sessions/nope/fork");
  check("fork an unknown session ⇒ 404", forkUnknown.statusCode === 404 && err(forkUnknown) === "session not found");
  const forkNoEng = await post("/api/sessions/noEngine/fork");
  check("fork with no engine context ⇒ 409", forkNoEng.statusCode === 409);
  const forkNoTr = await post("/api/sessions/noTranscript/fork");
  check("fork with transcript missing ⇒ 409", forkNoTr.statusCode === 409 && /transcript is missing/.test(err(forkNoTr) ?? ""));

  // Control: an unexpected error is still a 500, not swallowed into a 4xx.
  const origResume = svc.resume.bind(svc);
  svc.resume = () => { throw new Error("kaboom"); };
  const boom = await post("/api/sessions/noEngine/resume");
  svc.resume = origResume;
  check("CONTROL: an unrelated error still ⇒ 500", boom.statusCode === 500);
} finally {
  await app.close();
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
