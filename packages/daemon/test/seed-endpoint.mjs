import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The test-only internal seed endpoint (card 32fd6f4c, extended by card 0954ed9c) — POST
// /internal/test/seed. Closes the e2e seeding gap: `session_usage_samples` (written ONLY by the
// internal usage sampler), `runs` (filled ONLY via the real-spawn-triggering POST /api/runs), and a
// companion's config/session/memory/reminders (writable in prod ONLY via `/api/companion/provision` —
// spawns a real assistant session — or `/api/companion/config` — ARMS the runtime via reconcile()) had
// no path an isolated e2e spec could seed. This endpoint inserts rows directly via deps.db (+ the
// companion memory FILE store), bypassing SessionService.startRun/PTY and companion reconcile entirely.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject). Proves the contract:
//   (a) in NORMAL (non-test) mode the route is entirely ABSENT (404) — zero prod surface;
//   (b) under LOOM_TEST=1 the route is PRESENT, loopback-gated (403 otherwise), inserts a usage sample,
//       a run row, and a companion session/config/memory/reminder that round-trip through the Db's own
//       readers (and the companion's own REST reads), and 400s on a malformed payload.
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

    // --- Companion seed kinds (card 0954ed9c: the Companion Manage e2e spec's no-real-claude fixture) ---

    // Malformed companionSessions entry (missing agentId) -> 400, no row inserted.
    const badCompanionSession = await testApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "127.0.0.1",
      payload: { companionSessions: [{ projectId: "proj-1" }] },
    });
    check("(b) malformed companionSessions entry -> 400", badCompanionSession.statusCode === 400);

    // A companion-role agent to bind the seeded session to.
    db.insertAgent({
      id: "companion-agent-1", projectId: "proj-1", name: "seed-test-companion", startupPrompt: "",
      position: 1, profileId: null, endpoint: false, ioSchema: null,
    });

    // Seed a full companion in one call: a NOT-LIVE assistant session, a config row (with a bot token —
    // proving the masked read-back), a memory entry, and a reminder.
    const companionSeed = await testApp.inject({
      method: "POST", url: "/internal/test/seed", remoteAddress: "127.0.0.1",
      payload: {
        companionSessions: [{ id: "companion-sess-1", projectId: "proj-1", agentId: "companion-agent-1" }],
        companionConfigs: [{
          sessionId: "companion-sess-1", enabled: true, name: "Ada", botToken: "123456:test-token",
          allowedChatId: "999",
        }],
        companionMemories: [{
          sessionId: "companion-sess-1", name: "user-preferences",
          content: "---\ndescription: seeded test memory\n---\nLikes concise answers.",
        }],
        companionReminders: [{ sessionId: "companion-sess-1", label: "Morning check-in", prompt: "Anything worth surfacing?" }],
      },
    });
    check("(b) seeding a companion session + config + memory + reminder -> 201", companionSeed.statusCode === 201);
    const companionSeedBody = companionSeed.json();
    check("(b) response echoes the companion session/config/memory/reminder ids",
      companionSeedBody.companionSessionIds.length === 1 && companionSeedBody.companionConfigSessionIds.length === 1 &&
      companionSeedBody.companionMemoryNames.length === 1 && companionSeedBody.companionReminderIds.length === 1);

    // Round-trip #1: the session is a real, NOT-LIVE assistant-role row (never armed a real pty).
    const companionSession = db.getSession("companion-sess-1");
    check("(b) seeded companion session round-trips as a NOT-LIVE assistant-role row",
      companionSession?.role === "assistant" && companionSession?.processState === "exited" && companionSession?.busy === false);

    // Round-trip #2: the config is readable (masked) over the SAME REST the Manage tab reads, with the
    // token masked (never plaintext) and the name surfaced.
    const configRead = await testApp.inject({ method: "GET", url: "/api/companion/config" });
    const configRow = configRead.json().find((c) => c.sessionId === "companion-sess-1");
    check("(b) seeded companion config round-trips masked (tokenConfigured, last-4, name, no plaintext token)",
      !!configRow && configRow.tokenConfigured === true && configRow.tokenLast4 === "oken" &&
      configRow.name === "Ada" && configRow.enabled === true && !("botToken" in configRow) && !("botTokenBlob" in configRow));

    // Round-trip #3: the memory is readable over the Manage → Memory REST (proves the FILE store write +
    // resolveCompanionAgent's session/agent resolution both worked — no DB table involved).
    const memoryRead = await testApp.inject({ method: "GET", url: "/api/companion/memory/companion-sess-1" });
    check("(b) seeded companion memory round-trips over GET /api/companion/memory/:sessionId",
      memoryRead.json().memories.some((m) => m.name === "user-preferences"));

    // Round-trip #4: the reminder is readable over the Manage → Reminders REST.
    const remindersRead = await testApp.inject({ method: "GET", url: "/api/companion/reminders/companion-sess-1" });
    check("(b) seeded companion reminder round-trips over GET /api/companion/reminders/:sessionId",
      remindersRead.json().reminders.some((r) => r.label === "Morning check-in"));
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
