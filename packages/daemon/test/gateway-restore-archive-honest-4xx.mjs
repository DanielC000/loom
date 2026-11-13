import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 98079101 — follow-up to gateway-spawn-resume-honest-4xx.mjs. Two more session routes answered a
// blanket 400 for refusals that are really a conflict with the session's state:
//   POST   /api/sessions/:id/restore  on a session that cannot be resumed        → 409 (resume()'s own reason)
//   DELETE /api/sessions/:id/archive  on a session that is not archived           → 409
// Unknown session ids stay 404 on both. Control: an unrelated error keeps its prior status (400 here,
// by design — only the named refusals are re-mapped).
// A REAL Db + SessionService against a fake pty seam; the REAL buildServer. Claude-free, network-free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-r4xx-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-r4xx-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# r4xx\n");
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

db.insertSession({
  id: "noEngine", projectId: "p1", agentId: "agent1", engineSessionId: null, title: null, cwd: repo,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: null, parentSessionId: null,
});

const stub = {};
const app = await buildServer({ db, pty: host, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const err = (r) => { try { return JSON.parse(r.body).error; } catch { return undefined; } };

try {
  const restUnknown = await app.inject({ method: "POST", url: "/api/sessions/nope/restore" });
  check("restore an unknown session ⇒ 404", restUnknown.statusCode === 404 && err(restUnknown) === "session not found");

  const restNoEng = await app.inject({ method: "POST", url: "/api/sessions/noEngine/restore" });
  check("restore a session with no engine id ⇒ 409", restNoEng.statusCode === 409);
  check("restore body carries resume()'s reason", err(restNoEng) === "session has no engine id to resume");

  const delUnknown = await app.inject({ method: "DELETE", url: "/api/sessions/nope/archive" });
  check("delete-archive an unknown session ⇒ 404", delUnknown.statusCode === 404);

  const delLive = await app.inject({ method: "DELETE", url: "/api/sessions/noEngine/archive" });
  check("delete-archive a non-archived session ⇒ 409", delLive.statusCode === 409);
  check("delete-archive body states why", err(delLive) === "only an archived session can be permanently deleted");

  // Control: an unrelated error keeps the route's prior 400 (not swallowed into 409, not a 500).
  const origResume = svc.resume.bind(svc);
  svc.resume = () => { throw new Error("kaboom"); };
  const boom = await app.inject({ method: "POST", url: "/api/sessions/noEngine/restore" });
  svc.resume = origResume;
  check("CONTROL: an unrelated restore error is not a 409", boom.statusCode === 400);
} finally {
  await app.close();
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
