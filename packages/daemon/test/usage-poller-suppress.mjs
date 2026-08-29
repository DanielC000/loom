import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0ba27250 — LOOM_SUPPRESS_USAGE_POLLER=1 (paths.ts isUsagePollerSuppressed) keeps a throwaway/e2e/
// demo daemon from ever reading or serving the HOST's real Claude plan-usage. HERMETIC + CLAUDE-FREE +
// NETWORK-FREE (fetchImpl is a spy, never a real network call). Proves:
//   (a) isUsagePollerSuppressed() env truth table — unset/"0" → false, "1" → true (mirrors
//       setup-first-run.mjs's LOOM_SUPPRESS_FIRST_RUN_LAUNCH cases 8/9);
//   (b) the poller is actually OFF: replaying index.ts's boot gate (`if (!suppressed) poller.start()`)
//       with the flag SET never invokes the poller's fetchImpl — no network/credentials read happens —
//       while the flag UNSET does invoke it (the gate is real, not a no-op either way);
//   (c) GET /api/usage/limits (buildServer + app.inject) reflects a suppressed poller's cache
//       (constructor default) as {available:false}, and an unsuppressed/already-polled poller's cache
//       passes through unmodified — proving the fix is boot-gating alone, no route-level override needed.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-usage-poller-suppress-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { UsageStatusPoller } = await import("../dist/orchestration/usage-status.js");
const { isUsagePollerSuppressed } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A valid-looking credentials file so pollOnce() gets past readOAuthToken and would actually reach
// fetchImpl if invoked — otherwise a missing-creds short-circuit would pass (b) for the wrong reason.
const credentialsPath = path.join(TMP, "fake-credentials.json");
fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "fake-token", expiresAt: Date.now() + 3_600_000 } }));
const fakePayload = { five_hour: { utilization: 0.27, resets_at: null }, seven_day: { utilization: 0.85, resets_at: null } };

// (a) env truth table.
{
  delete process.env.LOOM_SUPPRESS_USAGE_POLLER;
  check("(a) unset → not suppressed (default OFF)", isUsagePollerSuppressed() === false);
  process.env.LOOM_SUPPRESS_USAGE_POLLER = "0";
  check("(a) '0' → not suppressed", isUsagePollerSuppressed() === false);
  process.env.LOOM_SUPPRESS_USAGE_POLLER = "1";
  check("(a) '1' → suppressed", isUsagePollerSuppressed() === true);
  delete process.env.LOOM_SUPPRESS_USAGE_POLLER;
}

// (b) replay index.ts's boot gate: `if (!isUsagePollerSuppressed()) poller.start();`
async function bootGate() {
  let calls = 0;
  const poller = new UsageStatusPoller({
    credentialsPath,
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => fakePayload }; },
  });
  const started = !isUsagePollerSuppressed();
  if (started) poller.start();
  // Only wait when start() actually ran — it primes pollOnce() immediately (void call), so poll for
  // the poll's own completion instead of a blind sleep. When suppressed, start() was never invoked at
  // all, so there is nothing async to wait for: calls===0 is already the final answer, not a race to
  // bound. NOTE: poll on `getStatus().available`, not on `calls` — `calls` increments synchronously as
  // soon as fetchImpl is INVOKED (inside pollOnce, before its own `await res.json()` and before
  // `this.cache` is actually assigned), so it settles before the poll has genuinely finished; `available`
  // only flips once pollOnce has fully run and written the cache, which is the state these checks need.
  if (started) {
    const deadline = Date.now() + 2_000;
    while (poller.getStatus().available !== true && Date.now() < deadline) await sleep(5);
  }
  poller.stop();
  return { poller, calls };
}

{
  delete process.env.LOOM_SUPPRESS_USAGE_POLLER;
  const { calls, poller } = await bootGate();
  check("(b) flag unset → the boot gate DOES start the poller → fetchImpl invoked", calls === 1);
  check("(b) flag unset → cache reflects the real (mocked) poll", poller.getStatus().available === true);
}
{
  process.env.LOOM_SUPPRESS_USAGE_POLLER = "1";
  const { calls, poller } = await bootGate();
  check("(b) flag=1 → the boot gate SKIPS start() entirely → fetchImpl NEVER invoked (no creds read either)", calls === 0);
  check("(b) flag=1 → poller is OFF: cache stays the constructor default (available:false, never polled)",
    poller.getStatus().available === false && poller.getStatus().reason === "not polled yet" && poller.getStatus().fetchedAt === null);
  delete process.env.LOOM_SUPPRESS_USAGE_POLLER;
}

// (c) GET /api/usage/limits reflects whatever deps.usageStatus.getStatus() returns — a suppressed
// (never-started) poller → available:false; an unsuppressed/already-polled poller → passes through
// unmodified. Proves the endpoint needed NO code change — boot-gating alone is the whole fix.
{
  const db = new Db(path.join(TMP, "loom.db"));
  const stub = {};
  try {
    process.env.LOOM_SUPPRESS_USAGE_POLLER = "1";
    const { poller: suppressedPoller } = await bootGate();
    const appSuppressed = await buildServer({
      db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      runMcp: stub, control: stub, usageStatus: suppressedPoller,
    });
    try {
      const res = await appSuppressed.inject({ method: "GET", url: "/api/usage/limits" });
      check("(c) suppressed → GET /api/usage/limits → 200", res.statusCode === 200);
      check("(c) suppressed → available:false (never reads/serves real account usage)", res.json().available === false);
    } finally {
      await appSuppressed.close();
    }

    delete process.env.LOOM_SUPPRESS_USAGE_POLLER;
    const { poller: livePoller } = await bootGate();
    const appLive = await buildServer({
      db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      runMcp: stub, control: stub, usageStatus: livePoller,
    });
    try {
      const res = await appLive.inject({ method: "GET", url: "/api/usage/limits" });
      check("(c) unsuppressed → available:true, endpoint passes the poller's real cache through unmodified", res.json().available === true);
    } finally {
      await appLive.close();
    }
  } finally {
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — LOOM_SUPPRESS_USAGE_POLLER=1 keeps the plan-usage poller from ever starting (no credentials read, no fetch), and GET /api/usage/limits correctly serves available:false as a result."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
