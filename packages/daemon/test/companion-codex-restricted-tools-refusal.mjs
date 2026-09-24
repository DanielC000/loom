import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b94fcb72 — codex ignores `restrictedTools` (its only consumer is the claude createPty disallow list), so a
// codex-pinned session row flagged restrictedTools:true would resume UNrestricted while reading as restricted.
// Proves, fully hermetic (temp LOOM_HOME, REAL Db, fake pty seam, NO real codex/claude, nonexistent LOOM_CODEX_BIN):
//   1. PUT /api/companion/restricted-tools/:sessionId refuses `true` on a codex-pinned row (409, the shared
//      codex-compat reason, row unchanged) but still allows `false`, and still allows `true` on a claude row.
//   2. SessionService.upgradeCompanionCapabilities refuses to re-pin a profile's restrictedTools:true onto a codex
//      row (throws the shared reason BEFORE any row write / pty spawn), and still upgrades a claude row.
//   3. Defence in depth: createCodexPty's spawn-time onCodexUnsupportedCapability report lists `restrictedTools`
//      (with the shared reason) when the spawn opts carry it, and does NOT when they don't.
// Run: 1) build, 2) node test/companion-codex-restricted-tools-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-codex-restricted-refusal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "definitely-not-a-real-codex-binary");

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { CODEX_RESTRICTED_TOOLS_REASON } = await import("../dist/profiles/codex-compat.js");

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
  createCodexPty(opts) { this.spawned.push(opts); return super.createPty(opts); } // never a real codex
}
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
};

const now = new Date().toISOString();
const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const projId = randomUUID();
db.insertProject({ id: projId, name: "Codex Restricted Refusal", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
const profileId = randomUUID();
db.insertProfile({ id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: true, noCommit: false, connections: [], capabilities: [] });
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });

const mkSession = (harness) => {
  const id = randomUUID();
  const eng = `eng-${id}`;
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: eng, title: null, cwd, processState: "exited", resumability: "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant", restrictedTools: false, harness,
  });
  const tp = engineTranscriptPath(cwd, eng);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  return id;
};
const codexSess = mkSession("codex");
const claudeSess = mkSession(undefined);

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

try {
  // ============ 1. REST ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${codexSess}`, payload: { restrictedTools: true } });
    check("(1) PUT true on a codex-pinned row → 409", res.statusCode === 409);
    check("(1) the error is the shared codex-compat reason (not a copy)", JSON.parse(res.payload).error === CODEX_RESTRICTED_TOOLS_REASON);
    check("(1) the codex row is UNCHANGED (still false)", db.getSession(codexSess).restrictedTools === false);

    const off = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${codexSess}`, payload: { restrictedTools: false } });
    check("(1) PUT false on a codex-pinned row is still allowed (200)", off.statusCode === 200);

    const claude = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${claudeSess}`, payload: { restrictedTools: true } });
    check("(1) PUT true on a claude row still works (200) and persists", claude.statusCode === 200 && db.getSession(claudeSess).restrictedTools === true);
  }

  // ============ 2. upgradeCompanionCapabilities ============
  {
    let err = null;
    try { await svc.upgradeCompanionCapabilities(codexSess); } catch (e) { err = e; }
    check("(2) upgrade on a codex row whose profile has restrictedTools:true throws the shared reason", err?.message === CODEX_RESTRICTED_TOOLS_REASON);
    check("(2) the codex row was NOT re-pinned to restrictedTools:true", db.getSession(codexSess).restrictedTools === false);
    check("(2) no pty was spawned for the refused upgrade", host.spawned.length === 0);

    let claudeErr = null;
    try { await svc.upgradeCompanionCapabilities(claudeSess); } catch (e) { claudeErr = e; }
    check("(2) control: upgrade on a claude row with the SAME profile still succeeds", claudeErr === null);
    check("(2) control: the claude row is re-pinned restrictedTools:true and a pty spawned", db.getSession(claudeSess).restrictedTools === true && host.spawned.length === 1);
  }

  // ============ 3. spawn-time report ============
  {
    const reports = [];
    const h = new PtyHost({ ...events, onCodexUnsupportedCapability: (sid, info) => reports.push({ sid, info }) });
    const base = { cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, projectId: projId };
    const spawnIgnoringBin = (o) => { try { h.createCodexPty(o); } catch { /* the fake binary cannot spawn — the report fires BEFORE that */ } };
    spawnIgnoringBin({ ...base, sessionId: "r-on", restrictedTools: true });
    const on = reports.find((r) => r.sid === "r-on");
    const item = on?.info.items.find((i) => i.id === "restrictedTools");
    check("(3) restrictedTools:true → the report lists restrictedTools", !!item);
    check("(3) …with the shared codex-compat reason", item?.reason === CODEX_RESTRICTED_TOOLS_REASON);
    spawnIgnoringBin({ ...base, sessionId: "r-off", restrictedTools: false });
    check("(3) control: restrictedTools:false → no restrictedTools item", !reports.find((r) => r.sid === "r-off")?.info.items.some((i) => i.id === "restrictedTools"));
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a codex-pinned row can no longer be paired with restrictedTools:true (REST + upgrade), and codex's spawn-time report names it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
