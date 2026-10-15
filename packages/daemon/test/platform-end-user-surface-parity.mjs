import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Epic f437d4e9 C6 (the verification card) — DoD-1 SURFACE PARITY. §5 C6 / §3e of
// docs/decisions/f437d4e9-end-user-platform-lead.md: "on a non-dev build, the end-user Lead's registered
// tools == the dev Lead's, minus exactly the documented exclusions (daemon_restart)."
//
// Per project memory (derive-a-wiring-test-client-list-never-hand-write-it) and this card's own kickoff:
// DERIVE both tool-name lists from the REAL PlatformMcpRouter registration in each LOOM_DEV state — never
// hand-write either list. `buildServer()` reads `isLoomDev()` at CALL TIME (only `daemon_restart`'s
// `registerTool` is gated behind `if (isLoomDev())` — verified at source, mcp/platform.ts), so toggling the
// env and re-calling `buildServer()` on the SAME router instance yields the two real surfaces directly.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a real Db + SessionService (fake pty) + a real
// PlatformMcpRouter, each surface read back over a real in-memory MCP client (tools/list).
//
// Proves:
//   (1) the non-dev tool-name set is EXACTLY the dev tool-name set minus {"daemon_restart"} — both
//       directions (nothing else excluded, nothing added).
//   (2) daemon_restart is present on the dev surface and ABSENT (not merely refusing) on the non-dev one.
//   (3) sanity: the surfaces are non-trivial (guards against a vacuous pass from a broken fixture).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-end-user-surface-parity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-eu-parity-${Date.now()}-${process.pid}`);
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class SeamHost extends createSeamHost(PtyHost) {}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const db = new Db();
const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
const router = new PlatformMcpRouter(db, svc); // 2-arg: GitWriter falls back to its bounded module-const defaults

async function toolNames() {
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "eu-surface-parity-test", version: "0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  await server.close();
  return names;
}

try {
  const savedLoomDev = process.env.LOOM_DEV;

  process.env.LOOM_DEV = "1";
  const devTools = await toolNames();

  delete process.env.LOOM_DEV;
  const nonDevTools = await toolNames();

  if (savedLoomDev === undefined) delete process.env.LOOM_DEV; else process.env.LOOM_DEV = savedLoomDev;

  check("(3 sanity) the dev surface is non-trivial (guards against a vacuous pass)", devTools.length > 10);
  check("(3 sanity) the non-dev surface is non-trivial too", nonDevTools.length > 10);

  check("(2) daemon_restart IS registered on the dev surface", devTools.includes("daemon_restart"));
  check("(2) daemon_restart is ABSENT from the non-dev surface (omitted, never present-but-refusing)", !nonDevTools.includes("daemon_restart"));

  const devSet = new Set(devTools);
  const nonDevSet = new Set(nonDevTools);
  const expectedNonDev = new Set(devTools.filter((n) => n !== "daemon_restart"));

  const missingFromNonDev = [...expectedNonDev].filter((n) => !nonDevSet.has(n));
  const extraOnNonDev = [...nonDevSet].filter((n) => !expectedNonDev.has(n));

  check(`(1) non-dev surface has EVERY dev tool except daemon_restart (missing: ${missingFromNonDev.join(", ") || "none"})`, missingFromNonDev.length === 0);
  check(`(1) non-dev surface has NO extra tools beyond dev-minus-daemon_restart (extra: ${extraOnNonDev.join(", ") || "none"})`, extraOnNonDev.length === 0);
  check(`(1) non-dev tool count == dev tool count - 1 (dev:${devTools.length}, non-dev:${nonDevTools.length})`, nonDevTools.length === devTools.length - 1);

  // Symmetric-diff cross-check against the live sets directly (belt-and-braces on the two checks above).
  const symmetricDiff = [...devSet].filter((n) => !nonDevSet.has(n) && n !== "daemon_restart")
    .concat([...nonDevSet].filter((n) => !devSet.has(n)));
  check(`(1) symmetric diff (dev vs non-dev, ignoring daemon_restart) is empty (found: ${symmetricDiff.join(", ") || "none"})`, symmetricDiff.length === 0);
} finally {
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the non-dev end-user Lead's registered PlatformMcpRouter tool surface is byte-identical to the dev Lead's, minus exactly daemon_restart (omitted from tools/list entirely, never present-but-refusing) — derived directly from two real buildServer() calls on the same router, never a hand-written list."
  : `\n🛑 ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
