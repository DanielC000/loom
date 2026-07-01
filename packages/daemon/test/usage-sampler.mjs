import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Session usage telemetry — the COLLECTION ENGINE (epic c9924bcd, card B): the daemon-side background
// sampler (sessions/usage-sampler.ts) that fills card A's session_usage_samples table by reading the
// transcript JSONL the engine already writes to disk. HERMETIC + CLAUDE-FREE + NETWORK-FREE: the whole
// test is PURE FILE IO — it hand-writes fake transcript JSONL on disk, points DB session rows at it, and
// drives the sampler's tick()/onSessionExit()/backfillOnce() DIRECTLY (no real claude, no model call, no
// agent turn, no wait). This is the proof the collection engine costs ZERO agent tokens.
//
// Covers the card's DoD:
//   • tick writes a delta sample matching the transcript's cumulative (first sight → full cumulative).
//   • a second tick after appending transcript usage writes the INCREMENTAL delta (not the full cumulative).
//   • a zero-change tick writes NOTHING.
//   • a simulated RESET (new engine id → new transcript, smaller cumulative) emits the new value, NEVER a
//     negative (delta = the fresh cumulative, not a subtraction).
//   • teardown (onSessionExit) writes a final tail sample.
//   • pruneUsageSamples (driven by the tick) drops rows older than retention.
//   • boot backfill seeds ONE coarse historical sample per session at last_activity, is a no-op the 2nd
//     run (app_meta marker), skips a zero-usage transcript, and seeds lastSeen so a still-live session's
//     first live tick is INCREMENTAL (no double count).
//   • RESTART double-count regression: a FRESH sampler (lastSeen wiped) with the backfill marker already
//     set + the SAME transcript (plain --resume reuses the engine id + transcript) does NOT re-emit the
//     whole cumulative — DB-aware first-sight delta = cumulative − already-persisted sum, so the total
//     stays == the true cumulative (gap-window usage included exactly), while a genuinely-new session
//     still counts its full cumulative.
//   • the one-shot corrective reset clears the inflated samples + re-arms the backfill, runs EXACTLY once
//     (marker), and does not clobber rows written after it.
// Run: 1) build (turbo builds shared first), 2) node test/usage-sampler.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME + sandboxed HOME set BEFORE importing dist (paths.ts reads LOOM_HOME at import;
// the transcript path is derived from os.homedir(), so HOME/USERPROFILE must point into the sandbox).
const tmpHome = path.join(os.tmpdir(), `loom-usampler-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45404";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { UsageSampler } = await import("../dist/sessions/usage-sampler.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { computeRunCostUsd } = await import("../dist/sessions/pricing.js");
const { IncrementalRunUsageReader, readRunUsageFromFile } = await import("../dist/sessions/context.js");

const nowIso = new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const dayOf = (iso) => iso.slice(0, 10);
const MODEL = "claude-opus-4-8";

// Write a transcript JSONL of assistant turns at the engine path for (cwd, engineId). Each turn is one
// assistant line with a DISTINCT message id (so readRunUsageFromFile counts it once) — the file's
// cumulative is the SUM of every turn's usage. Mirrors the real engine JSONL shape.
const turnLine = (engineId, i, t) => JSON.stringify({
  type: "assistant",
  message: {
    id: `${engineId}-m${i}`,
    model: t.model ?? MODEL,
    usage: {
      input_tokens: t.in, output_tokens: t.out,
      cache_creation_input_tokens: t.cc, cache_read_input_tokens: t.cr,
    },
  },
});
const writeTranscript = (cwd, engineId, turns) => {
  const file = engineTranscriptPath(cwd, engineId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turns.map((t, i) => turnLine(engineId, i, t)).join("\n") + "\n");
};
const appendTurn = (cwd, engineId, i, t) => {
  fs.appendFileSync(engineTranscriptPath(cwd, engineId), turnLine(engineId, i, t) + "\n");
};

// Totals for one project over an all-history window (the sampler's rows are per-interval deltas → a plain SUM).
const totalsFor = (db, projectId) => db.aggregateSessionUsage({ sinceIso: isoAgo(400 * DAY), projectId }).totals;

const mkProject = (db, id, cwd) => db.insertProject({ id, name: id, repoPath: cwd, vaultPath: cwd, config: {}, createdAt: nowIso, archivedAt: null });
const mkAgent = (db, id, projectId) => db.insertAgent({ id, projectId, name: id, startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
const mkSession = (db, s) => db.insertSession({
  title: null, processState: "live", resumability: "resumable", busy: false,
  createdAt: nowIso, lastActivity: nowIso, lastError: null, role: "manager", ...s,
});

try {
  // ===================================================================================================
  // PART 1 — live tick / incremental / zero / reset / teardown / prune (db1).
  // ===================================================================================================
  const db1 = new Db(path.join(tmpHome, "sampler1.db"));
  const cwd1 = path.join(tmpHome, "repo1");
  mkProject(db1, "p1", cwd1);
  mkAgent(db1, "a1", "p1");
  mkSession(db1, { id: "sess1", projectId: "p1", agentId: "a1", engineSessionId: "eng-1", cwd: cwd1 });

  const sampler1 = new UsageSampler({ db: db1, intervalMs: 3_600_000, retentionDays: 90 });

  // -- 1) first-sight tick → delta == the transcript's full cumulative -------------------------------
  const C1 = { in: 1000, out: 400, cc: 200, cr: 100 };
  writeTranscript(cwd1, "eng-1", [{ in: 600, out: 250, cc: 120, cr: 60 }, { in: 400, out: 150, cc: 80, cr: 40 }]); // sums to C1
  await sampler1.tick(new Date());
  let t = totalsFor(db1, "p1");
  check("1 first tick writes exactly one sample", t.samples === 1);
  check("1 delta == full cumulative (in 1000 / out 400 / cc 200 / cr 100)",
    t.inputTokens === 1000 && t.outputTokens === 400 && t.cacheCreationTokens === 200 && t.cacheReadTokens === 100);
  const expectedCost1 = computeRunCostUsd({ inputTokens: 1000, outputTokens: 400, cacheCreationTokens: 200, cacheReadTokens: 100, model: MODEL });
  check("1 stored cost == computeRunCostUsd(delta) (cache-aware billed cost, > 0)", expectedCost1 > 0 && approx(t.costUsd, expectedCost1));

  // -- 2) append more usage, tick again → INCREMENTAL delta (not the full new cumulative) -------------
  appendTurn(cwd1, "eng-1", 2, { in: 300, out: 120, cc: 60, cr: 30 }); // cumulative now {1300,520,260,130}
  await sampler1.tick(new Date());
  t = totalsFor(db1, "p1");
  check("2 second tick adds one sample (samples 2)", t.samples === 2);
  // Sum of the two deltas == the new cumulative (1300), proving the 2nd row was the 300 increment — NOT 1300 again.
  check("2 delta sum == new cumulative 1300 (incremental 300, not 1300)", t.inputTokens === 1300 && t.outputTokens === 520);

  // -- 3) zero-change tick → no row ------------------------------------------------------------------
  await sampler1.tick(new Date());
  t = totalsFor(db1, "p1");
  check("3 a zero-change tick writes nothing (samples still 2)", t.samples === 2);

  // -- 4) RESET: new engine id → new transcript, SMALLER cumulative → emits the new value, never negative
  db1.setEngineSessionId("sess1", "eng-2"); // session resumed → new transcript
  const C3 = { in: 500, out: 200, cc: 100, cr: 50 }; // smaller than the prior 1300 cumulative
  writeTranscript(cwd1, "eng-2", [{ in: C3.in, out: C3.out, cc: C3.cc, cr: C3.cr }]);
  const beforeReset = totalsFor(db1, "p1").inputTokens; // 1300
  await sampler1.tick(new Date());
  t = totalsFor(db1, "p1");
  check("4 reset tick adds one sample (samples 3)", t.samples === 3);
  check("4 reset delta == the fresh cumulative 500 (never subtracted → never negative)",
    t.inputTokens === beforeReset + 500 && t.inputTokens > beforeReset);

  // -- 5) teardown (onSessionExit) → a final tail sample ---------------------------------------------
  appendTurn(cwd1, "eng-2", 1, { in: 200, out: 80, cc: 40, cr: 20 }); // cumulative now {700,...} on eng-2
  await sampler1.onSessionExit(db1.getSession("sess1"), new Date());
  db1.setProcessState("sess1", "exited"); // mirror reality: the exited session leaves the live set
  t = totalsFor(db1, "p1");
  check("5 teardown writes the final tail delta (samples 4, +200 incremental)",
    t.samples === 4 && t.inputTokens === beforeReset + 500 + 200);

  // -- 6) pruning (driven by the tick) drops rows older than retention -------------------------------
  db1.insertUsageSample({ id: "old-row", sessionId: "sess1", projectId: "p1", agentId: "a1", model: MODEL,
    ts: isoAgo(100 * DAY), inputTokens: 9999, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 1, costUsd: 9 });
  check("6 pre-prune: the 100d-old row is present in a wide window (samples 5)", totalsFor(db1, "p1").samples === 5);
  await sampler1.tick(new Date()); // sess1 is exited now → no new sample; the tick's pruner drops the >90d row
  t = totalsFor(db1, "p1");
  check("6 tick pruned the >90d row (samples back to 4, the recent rows survive)",
    t.samples === 4 && t.inputTokens === beforeReset + 500 + 200);

  db1.close();

  // ===================================================================================================
  // PART 2 — boot backfill: seed-once + marker + zero-skip + lastSeen-seeding (fresh db2).
  // ===================================================================================================
  const db2 = new Db(path.join(tmpHome, "sampler2.db"));
  const cwd2 = path.join(tmpHome, "repo2");
  mkProject(db2, "p2", cwd2);
  mkAgent(db2, "a2", "p2");
  const lastAct = isoAgo(2 * DAY); // the coarse backfill ts comes from the session's last_activity
  mkSession(db2, { id: "sessB", projectId: "p2", agentId: "a2", engineSessionId: "engB-1", cwd: cwd2, lastActivity: lastAct });
  // A second session whose transcript carries an all-ZERO usage block → backfill must skip it (no row).
  mkSession(db2, { id: "sessZero", projectId: "p2", agentId: "a2", engineSessionId: "engZ-1", cwd: cwd2, lastActivity: lastAct });

  writeTranscript(cwd2, "engB-1", [{ in: 500, out: 200, cc: 100, cr: 50 }, { in: 300, out: 100, cc: 50, cr: 25 }]); // cumulative {800,300,150,75}
  writeTranscript(cwd2, "engZ-1", [{ in: 0, out: 0, cc: 0, cr: 0 }]); // zero-usage transcript

  const sampler2 = new UsageSampler({ db: db2, intervalMs: 3_600_000, retentionDays: 90 });

  const seeded = sampler2.backfillOnce(new Date());
  check("7 backfill seeds exactly ONE sample (sessB; the zero-usage sessZero is skipped)", seeded === 1);
  check("7 backfill set the app_meta one-time marker", db2.getMeta("usage_backfill_done") !== undefined);
  let agg = db2.aggregateSessionUsage({ sinceIso: isoAgo(400 * DAY), projectId: "p2" });
  check("7 backfilled sample == the whole transcript cumulative (in 800 / out 300)",
    agg.totals.samples === 1 && agg.totals.inputTokens === 800 && agg.totals.outputTokens === 300);
  check("7 backfilled sample's ts bucket == the session's last_activity day",
    agg.byDay.length === 1 && agg.byDay[0].day === dayOf(lastAct));

  // -- 8) second backfill is a no-op (marker) --------------------------------------------------------
  const seeded2 = sampler2.backfillOnce(new Date());
  check("8 second backfill is a no-op (returns 0, marker guard)", seeded2 === 0);
  check("8 no extra row from the second backfill (samples still 1)", totalsFor(db2, "p2").samples === 1);

  // -- 9) backfill seeded lastSeen → a still-live session's first live tick is INCREMENTAL ------------
  appendTurn(cwd2, "engB-1", 2, { in: 200, out: 100, cc: 50, cr: 25 }); // cumulative now {1000,...}
  await sampler2.tick(new Date()); // sessB is still 'live' → ticks; delta must be the 200 increment, NOT 1000 again
  agg = db2.aggregateSessionUsage({ sinceIso: isoAgo(400 * DAY), projectId: "p2" });
  check("9 live tick after backfill is incremental (samples 2; +200, total 1000 — no double count)",
    agg.totals.samples === 2 && agg.totals.inputTokens === 1000);

  db2.close();

  // ===================================================================================================
  // PART 3 — RESTART double-count regression (the bug this fix closes) + gap-window + new-session-full.
  // Simulate a daemon restart: a FRESH UsageSampler (lastSeen WIPED) with the backfill marker ALREADY set
  // and the SAME transcript (a plain --resume reuses the engine id + transcript file, which still holds the
  // full pre-restart cumulative) must NOT re-emit the whole cumulative. With the DB-aware first-sight
  // baseline the total persisted stays == the true cumulative, not ~2×.
  // ===================================================================================================
  const db3 = new Db(path.join(tmpHome, "sampler3.db"));
  const cwd3 = path.join(tmpHome, "repo3");
  mkProject(db3, "p3", cwd3);
  mkAgent(db3, "a3", "p3");
  mkSession(db3, { id: "sessR", projectId: "p3", agentId: "a3", engineSessionId: "engR-1", cwd: cwd3 });
  // NOT the first boot ever: the backfill marker is already stamped, so backfillOnce is a no-op and does
  // NOT prime lastSeen — exactly the post-restart condition that produced the double-count.
  db3.setMeta("usage_backfill_done", nowIso);
  writeTranscript(cwd3, "engR-1", [{ in: 600, out: 250, cc: 120, cr: 60 }, { in: 400, out: 150, cc: 80, cr: 40 }]); // cumulative {1000,400,200,100}

  // -- pre-restart: a sampler records the cumulative so far (the "before the restart" recording) --------
  const sampler3a = new UsageSampler({ db: db3, intervalMs: 3_600_000, retentionDays: 90 });
  sampler3a.backfillOnce(new Date()); // marker set → no-op, primes nothing
  await sampler3a.tick(new Date());
  let t3 = totalsFor(db3, "p3");
  check("10 pre-restart tick records the full cumulative once (samples 1, in 1000)", t3.samples === 1 && t3.inputTokens === 1000);

  // -- gap-window: more usage accrues AFTER the last sample but BEFORE the restart (no tick captures it) --
  appendTurn(cwd3, "engR-1", 2, { in: 300, out: 120, cc: 60, cr: 30 }); // cumulative now {1300,520,260,130}

  // -- RESTART: a brand-new sampler (lastSeen WIPED), backfill marker still set, SAME transcript ---------
  const sampler3b = new UsageSampler({ db: db3, intervalMs: 3_600_000, retentionDays: 90 });
  sampler3b.backfillOnce(new Date()); // still a no-op (marker)
  await sampler3b.tick(new Date());
  t3 = totalsFor(db3, "p3");
  // OLD BUG: first-sight re-emitted the WHOLE 1300 cumulative → total 1000 + 1300 = 2300 (~2× double count).
  // FIXED: first-sight delta = 1300 − persisted(1000) = 300 (the gap remainder) → total == 1300 (EXACT).
  check("10 RESTART does NOT double-count: total == true cumulative 1300 (not ~2300)",
    t3.inputTokens === 1300 && t3.outputTokens === 520);
  check("10 restart tick wrote exactly the gap remainder (samples 2, +300 — not the full 1300)", t3.samples === 2);

  // -- new-session-still-counts-full: a brand-new live session (no prior rows) counts its whole cumulative
  mkSession(db3, { id: "sessNew", projectId: "p3", agentId: "a3", engineSessionId: "engN-1", cwd: cwd3 });
  writeTranscript(cwd3, "engN-1", [{ in: 700, out: 250, cc: 150, cr: 75 }]);
  await sampler3b.tick(new Date()); // sessR unchanged → delta 0; sessNew first-sight, baseline 0 → full 700
  check("11 a genuinely-new session still counts its FULL cumulative (total 1300 + 700 = 2000)",
    totalsFor(db3, "p3").inputTokens === 2000);

  db3.close();

  // ===================================================================================================
  // PART 4 — the one-shot CORRECTIVE RESET: clears the inflated samples + re-arms backfill, runs EXACTLY
  // once, touches ONLY the derived table + its two markers.
  // ===================================================================================================
  const db4 = new Db(path.join(tmpHome, "sampler4.db"));
  const cwd4 = path.join(tmpHome, "repo4");
  mkProject(db4, "p4", cwd4);
  mkAgent(db4, "a4", "p4");
  mkSession(db4, { id: "sess4", projectId: "p4", agentId: "a4", engineSessionId: "eng4-1", cwd: cwd4, lastActivity: isoAgo(DAY) });
  writeTranscript(cwd4, "eng4-1", [{ in: 800, out: 300, cc: 150, cr: 75 }]); // true cumulative {800,...}
  // Simulate the inflated pre-fix state: a backfill already ran (marker set) AND double-counted rows exist.
  db4.setMeta("usage_backfill_done", nowIso);
  for (const id of ["inflate-1", "inflate-2"]) db4.insertUsageSample({ id, sessionId: "sess4", projectId: "p4",
    agentId: "a4", model: MODEL, ts: nowIso, inputTokens: 800, outputTokens: 300, cacheCreationTokens: 150, cacheReadTokens: 75, costUsd: 1 });
  check("12 pre-reset state is inflated (samples 2, in 1600 == 2× the true 800)",
    totalsFor(db4, "p4").samples === 2 && totalsFor(db4, "p4").inputTokens === 1600);

  const sampler4 = new UsageSampler({ db: db4, intervalMs: 3_600_000, retentionDays: 90 });
  const cleared = sampler4.correctiveResetOnce(new Date());
  check("12 reset cleared the inflated rows (2 removed)", cleared === 2);
  check("12 reset emptied the samples table", totalsFor(db4, "p4").samples === 0);
  check("12 reset cleared the backfill marker (re-armed)", db4.getMeta("usage_backfill_done") === undefined);
  check("12 reset stamped its own one-shot marker", db4.getMeta("usage_samples_reset_v1") !== undefined);

  // -- second reset is a no-op (marker): a row inserted AFTER the first reset must SURVIVE a second call --
  db4.insertUsageSample({ id: "survivor", sessionId: "sess4", projectId: "p4", agentId: "a4", model: MODEL,
    ts: nowIso, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 5, cacheReadTokens: 5, costUsd: 0 });
  const cleared2 = sampler4.correctiveResetOnce(new Date());
  check("13 second reset is a no-op (returns 0, marker guard)", cleared2 === 0);
  check("13 a row added after the first reset is NOT clobbered by the second call", totalsFor(db4, "p4").inputTokens === 5);

  // -- after the reset the corrected backfill repopulates clean from the transcript (true cumulative, once) -
  db4.clearUsageSamples(); // also exercises the helper — drop the survivor before the clean rebuild
  const reseeded = sampler4.backfillOnce(new Date()); // backfill marker was cleared by the reset → it re-runs
  check("13 corrected backfill repopulates clean from the transcript (1 row == true cumulative 800)",
    reseeded === 1 && totalsFor(db4, "p4").inputTokens === 800);

  db4.close();

  // ===================================================================================================
  // PART 5 — LAYER 1: the INCREMENTAL reader (IncrementalRunUsageReader) in isolation. Proves it returns a
  // cumulative BYTE-IDENTICAL to a full readRunUsageFromFile while parsing only appended bytes per "tick".
  // These are the load-bearing correctness traps: chunk-boundary equality, the straddling-duplicate dedup,
  // partial (no-newline) buffering, rotation reset, and truncation reset. Pure file IO on raw JSONL bytes.
  // ===================================================================================================
  const cwd5 = path.join(tmpHome, "repo5");
  // Build one raw assistant JSONL line (same shape as the engine writes) — used to control BYTE boundaries.
  const rawLine = (id, u, model = MODEL) => JSON.stringify({
    type: "assistant",
    message: { id, model, usage: { input_tokens: u.in, output_tokens: u.out, cache_creation_input_tokens: u.cc, cache_read_input_tokens: u.cr } },
  });
  const fileFor = (engineId) => { const f = engineTranscriptPath(cwd5, engineId); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
  const eqStats = (a, b) => a && b && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens && a.cacheReadTokens === b.cacheReadTokens && a.turns === b.turns;

  // -- (a) PROPERTY: incremental cumulative over ≥3 appended chunks == full parse of the complete file ------
  {
    const reader = new IncrementalRunUsageReader();
    const eng = "engP-1"; const f = fileFor(eng);
    const L = [
      rawLine(`${eng}-m0`, { in: 100, out: 40, cc: 20, cr: 10 }),
      rawLine(`${eng}-m1`, { in: 200, out: 80, cc: 40, cr: 20 }),
      rawLine(`${eng}-m2`, { in: 300, out: 120, cc: 60, cr: 30 }),
      rawLine(`${eng}-m3`, { in: 400, out: 160, cc: 80, cr: 40 }),
    ];
    fs.writeFileSync(f, L[0] + "\n");                       // chunk 1
    await reader.read("sP", cwd5, eng);
    fs.appendFileSync(f, L[1] + "\n");                      // chunk 2
    await reader.read("sP", cwd5, eng);
    fs.appendFileSync(f, L[2] + "\n" + L[3] + "\n");        // chunk 3 (two lines at once)
    const inc = await reader.read("sP", cwd5, eng);
    const full = readRunUsageFromFile(f);
    check("14a incremental cumulative over 3 chunks == full parse (all 4 token fields + turns)", eqStats(inc, full));
    check("14a full-parse baseline is the summed cumulative (in 1000, turns 4)", full.inputTokens === 1000 && full.turns === 4);
  }

  // -- (b) STRADDLE (the load-bearing trap): a duplicate message.id line-group split ACROSS the tick offset
  //        boundary must NOT be double-counted — seenIds persists across ticks. -----------------------------
  {
    const reader = new IncrementalRunUsageReader();
    const eng = "engS-1"; const f = fileFor(eng);
    const dup = { in: 500, out: 200, cc: 100, cr: 50 };
    const A1 = rawLine("dup-1", dup);   // the engine emits ONE message as two lines repeating the same id+usage
    const A2 = rawLine("dup-1", dup);   // ← identical message.id "dup-1" (the double-count hazard)
    const B = rawLine("uniq-1", { in: 70, out: 30, cc: 10, cr: 5 });
    // Force the boundary BETWEEN the two duplicate lines: tick 1 sees only A1, tick 2 sees A2 + B.
    fs.writeFileSync(f, A1 + "\n");
    await reader.read("sS", cwd5, eng);
    fs.appendFileSync(f, A2 + "\n" + B + "\n");
    const inc = await reader.read("sS", cwd5, eng);
    const full = readRunUsageFromFile(f); // full parse dedups dup-1 → counts it once (+ uniq-1)
    check("14b straddling duplicate id counted ONCE across the boundary (== full parse)", eqStats(inc, full));
    check("14b straddle total is dup-once + unique (in 570, turns 2 — not 1070/3)", inc.inputTokens === 570 && inc.turns === 2);
  }

  // -- (c) PARTIAL LINE: a tick that ends mid-line (no trailing \n) buffers the remainder; the next tick
  //        completing the line counts it EXACTLY once (not lost, not double). ---------------------------------
  {
    const reader = new IncrementalRunUsageReader();
    const eng = "engC-1"; const f = fileFor(eng);
    const L0 = rawLine("c-m0", { in: 100, out: 40, cc: 20, cr: 10 });
    const L1 = rawLine("c-m1", { in: 200, out: 80, cc: 40, cr: 20 });
    fs.writeFileSync(f, L0 + "\n");
    let inc = await reader.read("sC", cwd5, eng);
    check("14c after the first complete line: in 100, turns 1", inc.inputTokens === 100 && inc.turns === 1);
    const half = Math.floor(L1.length / 2);
    fs.appendFileSync(f, L1.slice(0, half));               // append HALF of L1 — no newline yet
    inc = await reader.read("sC", cwd5, eng);
    check("14c a mid-line partial is buffered, NOT counted (still in 100, turns 1)", inc.inputTokens === 100 && inc.turns === 1);
    fs.appendFileSync(f, L1.slice(half) + "\n");           // complete the line
    inc = await reader.read("sC", cwd5, eng);
    check("14c completing the line counts it once (in 300, turns 2) == full parse", inc.inputTokens === 300 && inc.turns === 2 && eqStats(inc, readRunUsageFromFile(f)));
  }

  // -- (d) ROTATION: the engineSessionId changes (fork/recycle → new transcript) → the parse cache RESETS and
  //        the new file is counted from 0 (feeds the sampler's rotation delta path correctly). --------------
  {
    const reader = new IncrementalRunUsageReader();
    const eng1 = "engD-1"; const f1 = fileFor(eng1);
    fs.writeFileSync(f1, rawLine("d1-m0", { in: 600, out: 200, cc: 100, cr: 50 }) + "\n");
    let inc = await reader.read("sD", cwd5, eng1);
    check("14d pre-rotation cumulative on the first transcript (in 600)", inc.inputTokens === 600 && inc.turns === 1);
    const eng2 = "engD-2"; const f2 = fileFor(eng2); // SAME session id, NEW engine id → a fresh transcript
    fs.writeFileSync(f2, rawLine("d2-m0", { in: 150, out: 60, cc: 30, cr: 15 }) + "\n");
    inc = await reader.read("sD", cwd5, eng2);
    check("14d rotation resets the cache → new file counted from 0 (in 150, turns 1 — not 750)",
      inc.inputTokens === 150 && inc.turns === 1);
  }

  // -- (e) TRUNCATION/shrink: size < the cached offset → the cache resets and the (smaller) file is re-read
  //        from 0 (guards against a rewritten/rotated-in-place file feeding stale offsets). -----------------
  {
    const reader = new IncrementalRunUsageReader();
    const eng = "engE-1"; const f = fileFor(eng);
    fs.writeFileSync(f, [rawLine("e-m0", { in: 100, out: 40, cc: 20, cr: 10 }), rawLine("e-m1", { in: 200, out: 80, cc: 40, cr: 20 })].join("\n") + "\n");
    let inc = await reader.read("sE", cwd5, eng);
    check("14e pre-truncation cumulative (in 300, turns 2)", inc.inputTokens === 300 && inc.turns === 2);
    fs.writeFileSync(f, rawLine("e-m2", { in: 50, out: 20, cc: 10, cr: 5 }) + "\n"); // shrink to a smaller file
    inc = await reader.read("sE", cwd5, eng);
    check("14e truncation (size < offset) resets + full re-reads (in 50, turns 1 — not 300/350)",
      inc.inputTokens === 50 && inc.turns === 1 && eqStats(inc, readRunUsageFromFile(f)));
  }

  // -- (f) SHORT READ: a POSIX short pread (fewer bytes than requested) must be looped until fully consumed
  //        — nothing lost, no zero-fill JSON corruption; the cumulative still == a full parse. ------------
  {
    const reader = new IncrementalRunUsageReader();
    const eng = "engSR-1"; const f = fileFor(eng);
    const L = [
      rawLine("sr-m0", { in: 111, out: 40, cc: 22, cr: 11 }),
      rawLine("sr-m1", { in: 222, out: 80, cc: 44, cr: 22 }),
      rawLine("sr-m2", { in: 333, out: 120, cc: 66, cr: 33 }),
    ];
    fs.writeFileSync(f, L.join("\n") + "\n");
    const expected = readRunUsageFromFile(f);
    // Force every fh.read to return at most 8 bytes — a truncating read the loop must stitch back together.
    const realOpen = fs.promises.open;
    fs.promises.open = async (...a) => {
      const fh = await realOpen(...a);
      const realRead = fh.read.bind(fh);
      fh.read = (buf, off, length, pos) => realRead(buf, off, Math.min(8, length), pos);
      return fh;
    };
    let inc;
    try { inc = await reader.read("sSR", cwd5, eng); }
    finally { fs.promises.open = realOpen; }
    check("14f short preads (≤8 bytes/read) are fully consumed via the read loop (== full parse, in 666, turns 3)",
      eqStats(inc, expected) && inc.inputTokens === 666 && inc.turns === 3);
  }

  // ===================================================================================================
  // PART 6 — END-TO-END delta equivalence: several async ticks over a GROWING transcript yield the SAME
  // recorded rows (deltas) as the pre-refactor sync path would — i.e. the running SUM of the per-tick deltas
  // equals the full-parse cumulative at each stage. This is the whole point: Layer 1 changed, Layer 2 didn't.
  // ===================================================================================================
  const db6 = new Db(path.join(tmpHome, "sampler6.db"));
  const cwd6 = path.join(tmpHome, "repo6");
  mkProject(db6, "p6", cwd6);
  mkAgent(db6, "a6", "p6");
  mkSession(db6, { id: "sess6", projectId: "p6", agentId: "a6", engineSessionId: "eng6-1", cwd: cwd6 });
  const sampler6 = new UsageSampler({ db: db6, intervalMs: 3_600_000, retentionDays: 90 });
  const engE2E = "eng6-1";
  const e2eFile = engineTranscriptPath(cwd6, engE2E);

  writeTranscript(cwd6, engE2E, [{ in: 600, out: 250, cc: 120, cr: 60 }]); // stage 1
  await sampler6.tick(new Date());
  let exp = readRunUsageFromFile(e2eFile); let got = totalsFor(db6, "p6");
  check("15 stage-1 running delta sum == full-parse cumulative (in 600)", got.inputTokens === exp.inputTokens && got.inputTokens === 600 && got.samples === 1);

  appendTurn(cwd6, engE2E, 1, { in: 400, out: 150, cc: 80, cr: 40 }); // stage 2
  await sampler6.tick(new Date());
  exp = readRunUsageFromFile(e2eFile); got = totalsFor(db6, "p6");
  check("15 stage-2 running delta sum == full-parse cumulative (in 1000, incremental +400)", got.inputTokens === exp.inputTokens && got.inputTokens === 1000 && got.samples === 2);

  appendTurn(cwd6, engE2E, 2, { in: 300, out: 120, cc: 60, cr: 30 }); // stage 3
  await sampler6.tick(new Date());
  exp = readRunUsageFromFile(e2eFile); got = totalsFor(db6, "p6");
  check("15 stage-3 running delta sum == full-parse cumulative (in 1300, incremental +300) + output matches",
    got.inputTokens === exp.inputTokens && got.outputTokens === exp.outputTokens && got.inputTokens === 1300 && got.samples === 3);

  await sampler6.tick(new Date()); // no growth → zero-delta → no new row (async path still skips cleanly)
  check("15 a no-growth async tick writes nothing (samples still 3)", totalsFor(db6, "p6").samples === 3);

  db6.close();

  // ===================================================================================================
  // PART 7 — CONCURRENCY: onSessionExit requested WHILE a tick is mid-await on the SAME session must NOT
  // double-count. The two ops are serialized on the sampler's op-chain, so the tick's read→recordDelta can
  // never interleave with the exit's tail delta. We force the worst interleave deterministically: a one-shot
  // delay inside the tick's transcript read holds the tick suspended AFTER its read; without serialization
  // the exit would run to completion (delete lastSeen) and both the exit AND the resumed tick would emit the
  // whole cumulative (2×). With the op-chain the exit simply waits its turn → the cumulative is counted ONCE.
  // ===================================================================================================
  const db7 = new Db(path.join(tmpHome, "sampler7.db"));
  const cwd7 = path.join(tmpHome, "repo7");
  mkProject(db7, "p7", cwd7);
  mkAgent(db7, "a7", "p7");
  mkSession(db7, { id: "sess7", projectId: "p7", agentId: "a7", engineSessionId: "eng7-1", cwd: cwd7 });
  writeTranscript(cwd7, "eng7-1", [{ in: 600, out: 250, cc: 120, cr: 60 }, { in: 400, out: 150, cc: 80, cr: 40 }]); // cumulative {1000,400,200,100}
  const cumFull = readRunUsageFromFile(engineTranscriptPath(cwd7, "eng7-1"));

  const sampler7 = new UsageSampler({ db: db7, intervalMs: 3_600_000, retentionDays: 90 });
  // One-shot delay after the FIRST read (the tick's) so the exit is REQUESTED while the tick is suspended.
  const realRead = sampler7.incrementalReader.read.bind(sampler7.incrementalReader);
  let delayedOnce = false;
  sampler7.incrementalReader.read = async (...a) => {
    const r = await realRead(...a);
    if (!delayedOnce) { delayedOnce = true; await sleep(30); } // hold the tick suspended post-read
    return r;
  };
  const pTick = sampler7.tick(new Date());               // enters the read, then suspends on the delay
  const pExit = sampler7.onSessionExit(db7.getSession("sess7"), new Date()); // requested mid-tick
  await Promise.all([pTick, pExit]);

  const t7 = totalsFor(db7, "p7");
  check("16 exit-during-tick does NOT double-count: total == true cumulative 1000 (not ~2000)",
    t7.inputTokens === cumFull.inputTokens && t7.inputTokens === 1000 && t7.outputTokens === 400);
  check("16 the tail is accounted exactly once (no phantom second full-cumulative row)", t7.inputTokens === 1000);

  db7.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session usage COLLECTION ENGINE: tick delta (first-sight/incremental/zero) + reset (never negative) + teardown tail + tick-driven prune + one-time boot backfill (seed-once marker + zero-skip + lastSeen no-double-count) + RESTART double-count regression (DB-aware first-sight baseline: gap-window exact, new-session counts full) + one-shot corrective reset (runs once, re-arms backfill) + LAYER-1 incremental reader (chunk-boundary == full parse, straddling-duplicate dedup, partial-line buffering, rotation/truncation reset) + end-to-end async-tick delta equivalence — pure file IO, ZERO agent tokens."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
