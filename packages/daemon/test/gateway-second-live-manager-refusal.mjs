import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0368c784 — the realistic double-spawn race is two HTTP requests genuinely IN FLIGHT at once (a
// double click before the first response lands). This drives that race through a REAL listening gateway
// (a real `app.listen()`, real `fetch()` calls fired concurrently via Promise.all — never sequential
// `app.inject` calls, which wouldn't exercise real concurrent request dispatch) against the REAL
// POST /api/agents/:id/sessions route (gateway/server.ts), the REAL SessionService, and the REAL
// `refuseSecondLiveManager` guard — only the pty is faked (createPty seam), so no claude/network.
//
// Proves:
//   (1) two SIMULTANEOUS POST /api/agents/:id/sessions {role:"manager"} for the SAME agent resolve to
//       EXACTLY ONE 2xx (a minted session) and ONE 409 (refused) — never two 2xx.
//   (2) the 409 body names the holder (the id of the session that actually got minted), honest 4xx, not
//       a generic 500.
//   (3) exactly ONE session row exists afterward for that agent.
//
// RED on pre-fix code: reverting the service.ts/gateway/server.ts guard (see the card's own worker
// report for the exact revert-and-rebuild steps) makes this resolve to TWO 2xx and two distinct session
// rows instead.
//
// Run: 1) build (turbo builds shared first), 2) node test/gateway-second-live-manager-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-gw-2ndmgr-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true }); // so the fake pty's on-disk log stream has somewhere to write
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "0";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-gw-2ndmgr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# gateway-second-live-manager-refusal test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=gslm@loom -c user.name=gslm");

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  aliveIds = new Set();
  createPty(opts, hookToken, mcpToken) { this.aliveIds.add(opts.sessionId); return super.createPty(opts, hookToken, mcpToken); }
  stop(id) { this.aliveIds.delete(id); }
  isAlive(id) { return this.aliveIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pGw", name: "Gw Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentGw", projectId: "pGw", name: "Gw", startupPrompt: "MGR", position: 0, profileId: null });

const stub = { hasLiveGateForProject: () => false };
const app = await buildServer({ db, pty: host, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const BASE = `http://127.0.0.1:${port}`;

try {
  // ===== (1)-(3) two SIMULTANEOUS POSTs for the SAME agent, fired together via Promise.all =====
  const post = () => fetch(`${BASE}/api/agents/agentGw/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "manager" }),
  });
  const [r1, r2] = await Promise.all([post(), post()]);
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  const statuses = [r1.status, r2.status].sort();
  check("(1) exactly one 2xx and one 409 across the two simultaneous requests", statuses[0] === 200 && statuses[1] === 409);

  const okBody = r1.status === 200 ? b1 : b2;
  const refusedBody = r1.status === 409 ? b1 : b2;
  check("(1b) the 2xx response is a minted live manager session", okBody?.role === "manager" && okBody?.processState === "live");
  check("(2) the 409 body names the holder (the id of the session that actually got minted)",
    typeof refusedBody?.error === "string" && refusedBody.error.includes(okBody.id) && refusedBody?.holderSessionId === okBody.id);

  // (3) exactly ONE session row exists afterward for this agent — never two.
  check("(3) exactly ONE session row exists for agentGw after the race", db.listSessions("agentGw").length === 1);
} finally {
  await app.close();
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — two simultaneous real HTTP POST /api/agents/:id/sessions {role:manager} for the SAME agent resolve to exactly one 2xx + one honest 409 naming the holder, and exactly one session row survives."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
