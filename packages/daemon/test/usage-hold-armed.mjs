// Card 3221d0d9 — `usageHoldArmed` on GET /api/usage/limits: whether the GLOBAL usage-hold latch
// (<LOOM_HOME>/tmp/claude-usage.json) is armed. HERMETIC + CLAUDE-FREE + NETWORK-FREE (usageStatus is a
// stub). Proves:
//   (a) isUsageHoldArmed: no file → false; fresh hit → true; recency window elapsed → false; known
//       future reset → true; known reset already passed → false (the SAME truth table as the predicate
//       worker_spawn refuses on, isLikelyNearClaudeUsageLimit — asserted equal on every non-corrupt case);
//   (b) a latch file that exists but is CORRUPT (garbage, or JSON that is not an object) reads ARMED —
//       fail VISIBLE, because the web hides the Clear button on false and clearing is what removes it;
//   (c) the route returns the status UNCHANGED plus exactly one extra key, a boolean — no timestamp, no path;
//   (d) the route honours the live platform recencyWindowMs (a hit older than a shrunk window is not armed).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-hold-armed-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { isUsageHoldArmed, isLikelyNearClaudeUsageLimit, recordClaudeRateLimit, clearClaudeRateLimit } =
  await import("../dist/orchestration/usage-awareness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const STATE = path.join(TMP, "tmp", "claude-usage.json");
const write = (text) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, text, "utf-8"); };
const NOW = new Date("2026-07-07T08:00:00.000Z");
const WINDOW = 6 * 60 * 60_000;
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();

// (a) truth table, each row cross-checked against the worker_spawn predicate.
const rows = [
  ["no file", null, false],
  ["fresh hit, no reset known", { lastRateLimitAt: iso(-60_000) }, true],
  ["hit older than the recency window, no reset known", { lastRateLimitAt: iso(-WINDOW - 60_000) }, false],
  ["known reset still in the future (beyond the window)", { lastRateLimitAt: iso(-WINDOW - 60_000), lastResetsAt: iso(3_600_000) }, true],
  ["known reset already passed", { lastRateLimitAt: iso(-60_000), lastResetsAt: iso(-1_000) }, false],
  ["empty object", {}, false],
];
for (const [label, state, expected] of rows) {
  clearClaudeRateLimit();
  if (state) write(JSON.stringify(state));
  const armed = isUsageHoldArmed(NOW, WINDOW);
  check(`(a) ${label} → ${expected}`, armed === expected);
  check(`(a) ${label} → same answer as isLikelyNearClaudeUsageLimit`, armed === isLikelyNearClaudeUsageLimit(NOW, WINDOW));
}

// (b) corrupt latch → ARMED (fail visible). The worker_spawn predicate is false here by design.
for (const [label, text] of [["garbage text", "{not json"], ["empty file", ""], ["JSON array", "[1,2]"], ["JSON null", "null"], ["JSON number", "42"]]) {
  clearClaudeRateLimit();
  write(text);
  const wrongForArray = label === "JSON array"; // typeof [] === "object": parses to an object-shaped value, not corrupt
  const armed = isUsageHoldArmed(NOW, WINDOW);
  if (wrongForArray) check(`(b) ${label} is object-shaped → follows the predicate (${isLikelyNearClaudeUsageLimit(NOW, WINDOW)})`, armed === isLikelyNearClaudeUsageLimit(NOW, WINDOW));
  else check(`(b) corrupt latch (${label}) → armed, so the Clear button stays reachable`, armed === true);
  check(`(b) corrupt latch (${label}) is NOT what worker_spawn refuses on`, isLikelyNearClaudeUsageLimit(NOW, WINDOW) === false);
}
clearClaudeRateLimit();
check("(b) after clearClaudeRateLimit the corrupt-file arm is gone → false", isUsageHoldArmed(NOW, WINDOW) === false);

// (c)+(d) the route.
const db = new Db(path.join(TMP, "loom.db"));
const stub = {};
const status = { available: false, reason: "stub", fetchedAt: null };
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  runMcp: stub, control: stub, usageStatus: { getStatus: () => status },
});
try {
  const get = async () => (await app.inject({ method: "GET", url: "/api/usage/limits" })).json();

  clearClaudeRateLimit();
  let body = await get();
  check("(c) nothing armed → usageHoldArmed === false", body.usageHoldArmed === false);
  check("(c) the status passes through unchanged plus exactly one boolean key",
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["available", "fetchedAt", "reason", "usageHoldArmed"]));

  recordClaudeRateLimit();
  body = await get();
  check("(c) latch armed → usageHoldArmed === true", body.usageHoldArmed === true);
  const text = JSON.stringify(body);
  check("(c) response carries no timestamp, path or file content", !/lastRateLimitAt|lastResetsAt|claude-usage|\d{4}-\d{2}-\d{2}T/.test(text) && !text.includes(TMP));

  write("{corrupt");
  check("(c) corrupt latch → usageHoldArmed === true over the route", (await get()).usageHoldArmed === true);

  // (d) shrink the platform window below the hit's age: not armed any more.
  write(JSON.stringify({ lastRateLimitAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
  check("(d) default window: a 10 min old hit is armed", (await get()).usageHoldArmed === true);
  db.setPlatformConfig({ rateLimit: { recencyWindowMs: 60_000 } });
  check("(d) recencyWindowMs shrunk to 1 min: the same hit is no longer armed", (await get()).usageHoldArmed === false);
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — usageHoldArmed follows the worker_spawn predicate and fails visible on a corrupt latch." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
