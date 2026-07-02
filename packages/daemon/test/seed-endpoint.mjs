import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The test-only internal seed endpoint (card 32fd6f4c) — POST /internal/test/seed. Closes the e2e
// seeding gap: `session_usage_samples` (written ONLY by the internal usage sampler) and `runs` (filled
// ONLY via the real-spawn-triggering POST /api/runs) had no path an isolated e2e spec could seed. This
// endpoint inserts rows directly via deps.db, bypassing SessionService.startRun/PTY entirely.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject). Proves the contract:
//   (a) in NORMAL (non-test) mode the route is entirely ABSENT (404) — zero prod surface;
//   (b) under LOOM_TEST=1 the route is PRESENT, loopback-gated (403 otherwise), inserts a usage sample
//       and a run row that round-trip through the Db's own readers, and 400s on a malformed payload.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-seed-ep-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45332";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
const baseDeps = {
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
};

try {
  // (a) NORMAL mode: no LOOM_TEST / NODE_ENV=test marker → the route must not exist at all (404, not 403 —
  // proving it was never registered, not merely gated shut).
  const savedLoomTest = process.env.LOOM_TEST;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.LOOM_TEST;
  delete process.env.NODE_ENV;
  const normalApp = await buildServer(baseDeps);
  try {
    const res = await normalApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "127.0.0.1",
      payload: { usageSamples: [{ projectId: "p1", sessionId: "s1" }] },
    });
    check("(a) POST /internal/test/seed in NORMAL mode -> 404 (route absent)", res.statusCode === 404);
  } finally {
    await normalApp.close();
    if (savedLoomTest === undefined) delete process.env.LOOM_TEST; else process.env.LOOM_TEST = savedLoomTest;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  }

  // (b) TEST mode (LOOM_TEST=1, the e2e fixture's own marker): the route is present.
  process.env.LOOM_TEST = "1";
  const testApp = await buildServer(baseDeps);
  try {
    // Non-loopback caller -> 403 (same trust posture as /internal/hook and /internal/shutdown).
    const forbidden = await testApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "203.0.113.7", payload: {},
    });
    check("(b) POST /internal/test/seed from a non-loopback IP -> 403", forbidden.statusCode === 403);

    // Malformed payload (missing sessionId) -> 400, no row inserted.
    const bad = await testApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "127.0.0.1",
      payload: { usageSamples: [{ projectId: "p1" }] },
    });
    check("(b) malformed usageSamples entry -> 400", bad.statusCode === 400);

    // A real project + agent row (the runs table FKs to both) so the seeded run isn't an orphan.
    db.insertProject({
      id: "proj-1", name: "seed-test-project", repoPath: TMP, vaultPath: TMP, config: {},
      createdAt: new Date().toISOString(), archivedAt: null, reserved: false,
    });
    db.insertAgent({
      id: "agent-1", projectId: "proj-1", name: "seed-test-agent", startupPrompt: "",
      position: 0, profileId: null, endpoint: false, ioSchema: null,
    });

    // Seed one usage sample + one run in a single call.
    const seed = await testApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "127.0.0.1",
      payload: {
        usageSamples: [{
          projectId: "proj-1", sessionId: "sess-1", model: "claude-sonnet-5",
          inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 1.23,
        }],
        runs: [{ projectId: "proj-1", agentId: "agent-1", status: "completed" }],
      },
    });
    check("(b) seeding a usage sample + a run -> 201", seed.statusCode === 201);
    const seedBody = seed.json();
    check("(b) response echoes one usageSampleId + one runId", seedBody.usageSampleIds.length === 1 && seedBody.runIds.length === 1);

    // Round-trip: the usage sample is readable via the Db's own aggregator.
    const agg = db.aggregateSessionUsage({ sinceIso: new Date(0).toISOString(), projectId: "proj-1" });
    check("(b) seeded usage sample is aggregated back (1 sample, 1000 input tok)",
      agg.totals.samples === 1 && agg.totals.inputTokens === 1000 && agg.totals.costUsd === 1.23);

    // Round-trip: the run row is readable via Db.getRun.
    const run = db.getRun(seedBody.runIds[0]);
    check("(b) seeded run round-trips with the given projectId/agentId/status",
      run?.projectId === "proj-1" && run?.agentId === "agent-1" && run?.status === "completed");
  } finally {
    await testApp.close();
  }
} finally {
  db.close();
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /internal/test/seed is ABSENT in normal mode, and under LOOM_TEST=1 is loopback-gated, validates its payload, and seeds usage samples + run rows that round-trip through the Db."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
