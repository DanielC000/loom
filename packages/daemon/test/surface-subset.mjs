import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SUBSET INVARIANT — the dev Platform Lead's `loom-platform` MCP surface must be a STRICT SUPERSET of
// the end-user operator's `loom-setup` surface: EVERY tool registered on loom-setup is ALSO registered
// on loom-platform (one-directional — NOT equality; the Lead legitimately has many tools the operator
// lacks). So a future end-user-surface addition NOT mirrored to the Lead FAILS this gate. Pairs with
// setup-surface.mjs / platform-mgmt-surface.mjs (the per-surface proofs); this is the cross-surface gate.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService against a FAKE pty
// (PtyHost createPty() seam), the REAL routers driven over an in-process MCP InMemoryTransport. We only
// LIST tools (never call them), so no fs/skill state is needed.
//
// Run: 1) build (turbo builds shared first), 2) node test/surface-subset.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-subset-${Date.now()}-${process.pid}`);
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
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// Fake pty: the routers' constructors need a SessionService; no real claude is ever spawned (we only
// list tools). createPty is never reached.
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const db = new Db();
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

// Connect a REAL MCP client to a router's buildServer() over an in-memory transport, return its tool names.
const listTools = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "subset-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
};

// `a` tools missing from `b` (empty ⇒ a ⊆ b).
const missingFrom = (a, b) => a.filter((t) => !b.includes(t));

try {
  const setupTools = await listTools(new SetupMcpRouter(db, svc).buildServer());
  const platformTools = await listTools(new PlatformMcpRouter(db, svc).buildServer());

  check("both surfaces registered tools", setupTools.length > 0 && platformTools.length > 0);

  // ============ THE INVARIANT — setup ⊆ platform ============
  const missing = missingFrom(setupTools, platformTools);
  check(`loom-setup (${setupTools.length} tools) is a STRICT SUBSET of loom-platform (${platformTools.length} tools) — missing from platform: ${missing.join(",") || "none"}`,
    missing.length === 0);

  // The verified gap THIS card closes: skill_list + skill_write now exist on the Lead's surface.
  check("loom-platform includes skill_list (the closed gap)", platformTools.includes("skill_list"));
  check("loom-platform includes skill_write (the closed gap)", platformTools.includes("skill_write"));

  // ONE-DIRECTIONAL, NOT equality: the Lead legitimately carries elevated tools the operator must NEVER
  // get (git/vault writers, session_message/stop, schedules). Asserting strict-superset (not ==) keeps a
  // future author from accidentally tightening this gate to equality.
  const platformOnly = missingFrom(platformTools, setupTools);
  check(`invariant is one-directional (platform has ${platformOnly.length} tools setup lacks, e.g. ${platformOnly.slice(0, 3).join(",")})`,
    platformOnly.length > 0);
  check("the elevated tools stay platform-ONLY (never on the operator surface)",
    ["git_commit", "git_push", "vault_write", "session_message", "session_stop"].every((t) => platformOnly.includes(t)));

  // ============ NEGATIVE CONTROL — prove the gate HAS TEETH ============
  // Inject a phantom end-user tool not mirrored to the Lead and confirm the SAME subset check WOULD fail.
  // This is how we prove a future loom-setup addition left off loom-platform would be caught.
  const phantomSetup = [...setupTools, "__phantom_end_user_tool__"];
  const wouldMiss = missingFrom(phantomSetup, platformTools);
  check("negative control: a setup tool ABSENT from platform WOULD fail the gate (proves teeth)",
    wouldMiss.length === 1 && wouldMiss[0] === "__phantom_end_user_tool__");
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — loom-setup ⊆ loom-platform (strict, one-directional superset): every operator tool is mirrored to the Lead (incl. the newly-added skill_list/skill_write), the elevated tools stay platform-only, and the gate provably fails if a setup tool were missing from platform — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
