import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The CSRF / DNS-rebind backstop — a single Fastify onRequest hook on the whole gateway instance. The
// daemon binds 127.0.0.1 only, but a loopback bind ALONE lets (a) any cross-origin page the user visits
// fire no-cors side-effect POSTs and (b) a DNS-rebinding page reach the host-RCE POST /api/terminals. The
// hook refuses a PRESENT non-loopback Origin and any non-loopback Host (403), while an ABSENT Origin is the
// fail-safe ALLOW path (CLI / Run-API-key / server-to-server send none).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject). Proves:
//   1. cross-origin Origin → 403 (and the side-effect handler is NOT reached);
//   2. loopback Origin — BOTH http://127.0.0.1:PORT and http://localhost:PORT — → allowed;
//   3. ABSENT Origin → allowed;
//   4. a non-allowlisted Host → 403 (the DNS-rebind control), incl. with the bound port present;
//   5. a Run-API-key-shaped client (no Origin, loopback Host, an Authorization header) still succeeds;
//   6. uniform coverage — the hook guards a real side-effect POST route, not just reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-csrf-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45337";
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Spy `killAllWorkers` so we can prove a CROSS-ORIGIN side-effect POST never reaches the handler (the hook
// short-circuits it) while a loopback one does.
let killCalls = 0;
const stub = {};
const sessions = { killAllWorkers: () => { killCalls++; return 7; } };
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({
  db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
});

// A dependency-free, idempotent read route to exercise the Origin/Host matrix without side effects.
const READ = "/api/version";
const get = (headers) => app.inject({ method: "GET", url: READ, headers });

try {
  // (1) cross-origin Origin → 403, on a READ route too (the hook is uniform, not POST-only).
  const ext = await get({ origin: "https://evil.example.com" });
  check("(1) cross-origin Origin (https://evil.example.com) → 403", ext.statusCode === 403);

  // (2) loopback Origin — both forms, with a matching bound-port loopback Host → allowed (200).
  const o1 = await get({ origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` });
  check("(2a) loopback Origin http://127.0.0.1:PORT → allowed (200)", o1.statusCode === 200);
  const o2 = await get({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` });
  check("(2b) loopback Origin http://localhost:PORT → allowed (200)", o2.statusCode === 200);
  // Dev-proxy reality: the UI runs on a DIFFERENT loopback port (:5317) and forwards here; the browser's
  // Origin stays the UI's, so a loopback origin on another port must also pass.
  const oDev = await get({ origin: "http://localhost:5317", host: `127.0.0.1:${PORT}` });
  check("(2c) dev-proxy loopback Origin http://localhost:5317 → allowed (200)", oDev.statusCode === 200);

  // (3) ABSENT Origin → allowed (fail-safe). inject's default Host is `localhost:80` (loopback) and no Origin.
  const noOrigin = await get({});
  check("(3) ABSENT Origin → allowed (200)", noOrigin.statusCode === 200);

  // (4) non-allowlisted Host → 403, incl. when it carries the bound port (rebind sends the attacker host).
  const badHost = await get({ host: "attacker.example.com" });
  check("(4a) non-loopback Host (attacker.example.com) → 403", badHost.statusCode === 403);
  const badHostPort = await get({ host: `attacker.example.com:${PORT}` });
  check("(4b) non-loopback Host WITH the bound port → 403", badHostPort.statusCode === 403);

  // (5) a Run-API-key-shaped client: no Origin, loopback Host, an Authorization header → still succeeds.
  const runClient = await get({ host: `127.0.0.1:${PORT}`, authorization: "Bearer lk_test_key" });
  check("(5) Run-API-key client (no Origin, loopback Host) → allowed (200)", runClient.statusCode === 200);

  // (6a) a CROSS-ORIGIN side-effect POST is refused BEFORE the handler — killAllWorkers is never called.
  const killCross = await app.inject({
    method: "POST", url: "/api/orchestration/kill", headers: { origin: "https://evil.example.com" },
  });
  check("(6a) cross-origin POST /api/orchestration/kill → 403", killCross.statusCode === 403);
  check("(6a) the side-effect (killAllWorkers) was NOT reached", killCalls === 0);

  // (6b) the SAME POST from a loopback origin runs the handler — proving the hook isn't simply blocking all POSTs.
  const killOk = await app.inject({
    method: "POST", url: "/api/orchestration/kill",
    headers: { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` },
  });
  check("(6b) loopback-origin POST /api/orchestration/kill → 200", killOk.statusCode === 200);
  check("(6b) the handler ran (killAllWorkers called once)", killCalls === 1);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — the onRequest hook refuses cross-origin Origins + non-loopback Hosts (403), allows loopback origins (incl. the dev cross-port proxy) and absent-Origin clients, and short-circuits cross-origin side-effect POSTs before the handler."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
