import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The loopback POST /internal/shutdown control hook — the cross-platform stop path for `loom stop`
// (Windows has no real SIGTERM, so the CLI can't signal a detached daemon into the graceful path).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject; requestShutdown is a SPY, so
// nothing actually exits the test process). Proves the contract the CLI depends on:
//   (a) POST /internal/shutdown from loopback → 202 { ok, stopping } and INVOKES requestShutdown once
//       (which in the real daemon runs the SAME graceful path as SIGINT/SIGTERM, then exit 0);
//   (b) trust posture matches /internal/hook EXACTLY — a NON-loopback caller gets 403 and the shutdown
//       is NOT invoked (it is loopback-only and unreachable by any agent; never an MCP tool).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shutdown-ep-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45331";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shutdownCalls = 0;
const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
// SPY requestShutdown: the real wiring calls into index.ts's gracefulShutdown (process.exit(0)); here we
// only record the invocation so the test process survives and can assert.
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => { shutdownCalls++; },
});
try {
  // (a) loopback POST → 202 + ack, and the graceful path is triggered (deferred one tick after the ack)
  const res = await app.inject({ method: "POST", url: "/internal/shutdown", remoteAddress: "127.0.0.1" });
  check("(a) POST /internal/shutdown (loopback) → 202", res.statusCode === 202);
  const body = res.json();
  check("(a) body acks { ok:true, stopping:true }", body.ok === true && body.stopping === true);
  check("(a) ack returns BEFORE the exit fires (not yet invoked synchronously)", shutdownCalls === 0);
  await sleep(120); // > the endpoint's 50ms defer — the graceful path must have been invoked by now
  check("(a) requestShutdown invoked exactly once after the ack flushed", shutdownCalls === 1);

  // (b) NON-loopback caller → 403, and shutdown is NOT invoked (same posture as /internal/hook)
  const forbidden = await app.inject({ method: "POST", url: "/internal/shutdown", remoteAddress: "203.0.113.7" });
  check("(b) POST from a non-loopback IP → 403", forbidden.statusCode === 403);
  await sleep(80); // give any (erroneous) deferred call a chance to fire — it must not
  check("(b) requestShutdown NOT invoked by the rejected caller (still 1)", shutdownCalls === 1);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /internal/shutdown is loopback-only (403 otherwise), acks 202, and triggers the graceful shutdown path exactly once. Same trust boundary as /internal/hook; never an agent surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
