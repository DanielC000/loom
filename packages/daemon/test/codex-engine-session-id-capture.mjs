import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ec60d9c DoD-1 (multi-harness epic df1f94b0) — hermetic coverage for
// `PtyHost#captureCodexEngineSessionId` / `pty/codex-transcript.ts#findConversationIdForSpawn`: codex has
// no SessionStart-hook equivalent to REPORT its own conversation id the way claude's engine does, so this
// discovers it instead by scanning for a rollout file whose `session_meta.payload.cwd` matches the spawn's
// cwd, created at/after the spawn's own `startedAt`.
//
// TECHNIQUE: a fake `createCodexPty()` override (mirrors `codex-queue-state-machine.mjs`'s established
// pattern) drives the REAL `spawnCodexProcess` onData handler with SCRIPTED chunks — no real codex process.
// `LOOM_CODEX_ENGINE_ID_RETRY_MS` shrinks the bounded-retry constant (mirrors that file's own
// `LOOM_CODEX_BUSY_STALE_MS` shrink convention) so the retry scenario stays fast; the genuine async retry
// timer is observed via `waitUntil` (poll for the real `onEngineSessionId` event), never a blind sleep.
// `LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS` similarly shrinks the retry COUNT so scenario D below (exhausting the
// whole ladder) doesn't need to wait through the real 40-attempt default.
//
// Card ece98bd8: scenarios D/E/F cover `CodexLive.engineSessionIdCaptureEndReason` — the three ways this
// chain can end WITHOUT ever finding an id ("exhausted", "died-mid-capture", "capture-not-attempted"),
// previously indistinguishable from each other (and from success) by anything downstream.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-engine-session-id-capture.mjs
process.env.LOOM_CODEX_ENGINE_ID_RETRY_MS = "40"; // read once at module load below — must be set BEFORE the dynamic import
process.env.LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS = "3"; // ditto — keeps scenario D's exhaustion fast
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
// `diag` (card cc1b4328) is an OPTIONAL pre-computed string, printed ONLY when `cond` is false — it never
// affects PASS/FAIL itself (existing call sites that omit it are byte-identical in behaviour). Callers
// compute it EAGERLY (see mtimeDiagLine below), not lazily inside this function, so its correctness never
// depends on the failure path actually being reached — a passing run computes and discards the exact same
// value a failing one would have printed.
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (diag) console.log(`      ${diag}`);
  }
};

/** Card cc1b4328: the residual ~4%-vs-~50% rate gap on `findConversationIdForSpawn`'s `mtimeMs < sinceMs -
 *  MTIME_SKEW_TOLERANCE_MS` filter (see codex-transcript.ts's own doc on that constant) has never been
 *  observed directly from a real failing gate — only reproduced in a standalone microbenchmark. This
 *  captures the SAME pair `findConversationIdForSpawn` itself compares, so the next natural failure of a
 *  scenario that depends on that scan (A, B below) prints exactly what it saw, no re-run required. Never
 *  throws — a missing file/session (e.g. a DIFFERENT bug shape entirely) reports `null` rather than masking
 *  the real failure with a diagnostic-code crash. */
function safeMtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}
function mtimeDiagLine(label, mtimeMs, sinceMs) {
  const delta = mtimeMs !== null && sinceMs !== null ? mtimeMs - sinceMs : null;
  const deltaStr = delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${delta}ms`;
  return `${label}: mtimeMs=${mtimeMs} sinceMs=${sinceMs} delta=${deltaStr} (MTIME_SKEW_TOLERANCE_MS=${MTIME_SKEW_TOLERANCE_MS}ms)`;
}

const tmpCodexHome = mkdtempManaged("loom-codex-engine-id-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
process.env.LOOM_HOME = mkdtempManaged("loom-codex-engine-id-loomhome-");

const { PtyHost } = await import("../dist/pty/host.js");
const { MTIME_SKEW_TOLERANCE_MS } = await import("../dist/pty/codex-transcript.js");

const READY = "> Ask Codex to do anything";

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 5150,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
    writes,
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const engineSessionIdEvents = [];
const exitEvents = [];
const events = {
  onEngineSessionId(sessionId, engineId, previousEngineId) { engineSessionIdEvents.push({ sessionId, engineId, previousEngineId }); },
  onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit(sessionId, code, info) { exitEvents.push({ sessionId, code, info }); },
};
const host = new FakeCodexHost(events);

/** Write a real rollout file (session_meta first line, mirrors codex-transcript-parse.mjs's fixture shape)
 *  under `CODEX_HOME/sessions/<dayDir>` so `findConversationIdForSpawn`'s recursive walk finds it. */
function writeRollout(conversationId, cwd) {
  const dayDir = path.join(tmpCodexHome, "sessions", "2026", "09", "07");
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-09-07T00-00-00-${conversationId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { session_id: conversationId, cwd, originator: "codex-tui" } }) + "\n");
  return file;
}

// --- Scenario A: IMMEDIATE hit — the rollout file already exists before the ready marker ever renders ---
{
  const sessionId = "engine-id-a";
  const cwd = "/fake/codex/cwd-a";
  const conversationId = "engine-id-fixture-a";

  // Real ordering: codex writes session_meta as part of ITS OWN process start, which only happens AFTER
  // this spawn (`live.startedAt`) — so the fixture file's mtime must land AT/AFTER spawn, never before it.
  // (`findConversationIdForSpawn`'s own `mtimeMs >= sinceMs` filter deliberately rejects anything older —
  // that's what stops a stale SIBLING session's rollout file, sharing this cwd from an earlier run, from
  // being wrongly claimed by a later spawn; writing the fixture before spawn() would trip that same guard
  // for the wrong reason and not test what this scenario intends.)
  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  // Captured EAGERLY, right where they're accurate — `sinceMs` is the exact `live.startedAt` value the
  // real scan compares against, `mtimeMs` is the rollout file's real on-disk mtime once written; neither
  // changes for the rest of this scenario, so both are correct whether this check ends up passing or not.
  const sinceMsA = host.liveCodex.get(sessionId)?.startedAt ?? null;
  const rolloutFileA = writeRollout(conversationId, cwd); // lands AFTER spawn, BEFORE the ready marker is ever pushed below
  const mtimeMsA = safeMtimeMs(rolloutFileA);
  check("(A) no onEngineSessionId fired before the ready marker ever appears", engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 0);
  fakePty.push(`codex TUI booted\n${READY}\n`);
  check("(A) onEngineSessionId fired exactly once, with the correct id, on the FIRST attempt (file already existed)",
    engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 1 &&
    engineSessionIdEvents.find((e) => e.sessionId === sessionId)?.engineId === conversationId,
    mtimeDiagLine("(A)", mtimeMsA, sinceMsA));
  check("(A) previousEngineId is null (codex has no rotation concept)",
    engineSessionIdEvents.find((e) => e.sessionId === sessionId)?.previousEngineId === null);

  // A further ready-marker sighting must NOT re-fire the capture (engineSessionIdCaptureAttempted latches,
  // and captureCodexEngineSessionId's own `live.engineSessionId` guard is a second, independent backstop).
  fakePty.push(`${READY}\n`);
  fakePty.push(`${READY}\n`);
  check("(A) a repeated ready-marker sighting does NOT re-fire onEngineSessionId (latched, not re-scanned)",
    engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 1);
}

// --- Scenario B: RETRY hit — the ready marker renders BEFORE the rollout file lands; the bounded retry
// (LOOM_CODEX_ENGINE_ID_RETRY_MS=40ms above) must still capture it once it does. ---
{
  const sessionId = "engine-id-b";
  const cwd = "/fake/codex/cwd-b";
  const conversationId = "engine-id-fixture-b";

  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  const sinceMsB = host.liveCodex.get(sessionId)?.startedAt ?? null; // same value the real scan compares against, on every attempt
  fakePty.push(`codex TUI booted\n${READY}\n`); // first attempt MISSES — no rollout file exists yet
  check("(B) the FIRST attempt misses (no rollout file yet) — no event fired synchronously", engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 0);

  const rolloutFileB = writeRollout(conversationId, cwd); // the file lands AFTER the first miss, BEFORE the retry fires
  const mtimeMsB = safeMtimeMs(rolloutFileB); // stable from here on — mtime never changes across retries, which is exactly why a rejection here is PERMANENT
  try {
    await waitUntil(
      () => engineSessionIdEvents.some((e) => e.sessionId === sessionId),
      { label: "(B) the bounded retry captures the id once the rollout file lands" },
    );
  } catch (err) {
    // A permanent mtime-skew rejection (codex-transcript.ts's `mtimeMs < sinceMs - MTIME_SKEW_TOLERANCE_MS`)
    // manifests HERE as a timeout, never as a normal check() FAIL — the retry ladder exhausts silently.
    console.log(`      ${mtimeDiagLine("(B)", mtimeMsB, sinceMsB)}`);
    throw err; // never swallowed — pass/fail is unchanged, this only adds a diagnostic line before the same crash
  }
  check("(B) the retry's captured id is correct",
    engineSessionIdEvents.find((e) => e.sessionId === sessionId)?.engineId === conversationId,
    mtimeDiagLine("(B)", mtimeMsB, sinceMsB));
  check("(B) exactly one event fired for this session (the retry doesn't double-fire alongside a phantom first success)",
    engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 1);
}

// --- Scenario C: NEGATIVE CONTROL — a rollout file exists, but for a DIFFERENT cwd. Neither the immediate
// attempt nor the bounded retry may ever capture it; this proves the cwd match is a real filter, not
// vacuously "whatever's newest". Anchored to an OBSERVABLE event, never a fixed sleep (a raw
// `setTimeout`-then-negative-check is unfalsifiable in one trial — see fixed-wait-negative-guard.mjs):
// session C's own retry is scheduled via `setTimeout(fn, CODEX_ENGINE_ID_RETRY_MS)` at the instant its
// ready marker is pushed below; a SIBLING session D's ready marker is pushed strictly AFTER that, with the
// SAME delay, so D's retry is scheduled to fire strictly later than C's (Node fires equal-delay timers in
// scheduling order) — `waitUntil`ing D's own real `onEngineSessionId` event (a genuine completion, not a
// guessed duration) therefore PROVES C's earlier-scheduled retry has already had its one chance to fire by
// the time this check runs, whether it found anything or not. ---
{
  const sessionId = "engine-id-c";
  const cwd = "/fake/codex/cwd-c";
  const wrongCwd = "/fake/codex/cwd-c-DIFFERENT";
  const conversationId = "engine-id-fixture-c-wrong-cwd";
  writeRollout(conversationId, wrongCwd);

  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  fakePty.push(`codex TUI booted\n${READY}\n`); // schedules C's own bounded retry NOW

  // The canary: scheduled AFTER C's retry, same delay — its real completion event is the observable proof
  // that C's own retry window has elapsed too.
  const canarySessionId = "engine-id-c-canary";
  const canaryCwd = "/fake/codex/cwd-c-canary";
  const canaryConversationId = "engine-id-fixture-c-canary";
  host.spawn({ sessionId: canarySessionId, cwd: canaryCwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const canaryPty = host.fakeCodexPtys.get(canarySessionId);
  canaryPty.push(`codex TUI booted\n${READY}\n`); // first attempt misses (no rollout file yet) — schedules the canary's own retry
  writeRollout(canaryConversationId, canaryCwd); // lands before the canary's retry fires
  await waitUntil(
    () => engineSessionIdEvents.some((e) => e.sessionId === canarySessionId),
    { label: "(C) canary retry fires — proves C's own earlier-scheduled retry has also already had its chance" },
  );

  check("(C) NEGATIVE CONTROL: a rollout file for a DIFFERENT cwd is never captured, even after the retry window elapses",
    engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 0);
}

// --- Scenario D: EXHAUSTED — no rollout file ever appears while the pty stays alive; card ece98bd8's
// genuinely-surprising case (the doc says the file lands around first-turn time, well inside the retry
// window) must give up after LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS(=3 here) attempts and RECORD why, rather
// than retrying forever with nothing to show for it. ---
{
  const sessionId = "engine-id-d-exhausted";
  const cwd = "/fake/codex/cwd-d-exhausted";

  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  fakePty.push(`codex TUI booted\n${READY}\n`); // schedules the retry chain; no rollout file is ever written for this cwd

  await waitUntil(
    () => host.liveCodex.get(sessionId)?.engineSessionIdCaptureEndReason !== null,
    { label: "(D) the capture chain records an end reason once every attempt has run out" },
  );
  check("(D) engineSessionIdCaptureEndReason is \"exhausted\"", host.liveCodex.get(sessionId)?.engineSessionIdCaptureEndReason === "exhausted");
  check("(D) no onEngineSessionId ever fired (nothing was ever found)", engineSessionIdEvents.filter((e) => e.sessionId === sessionId).length === 0);
  check("(D) NEGATIVE CONTROL: the pty is still alive — exhaustion is not a pty-death outcome (contrast with E below)", host.liveCodex.get(sessionId)?.alive === true);
}

// --- Scenario E: DIED-MID-CAPTURE — the ready marker renders (an attempt fires, at least once) but the pty
// exits before any attempt ever finds the rollout file. Must be recorded by `pty.onExit` ITSELF, not by
// waiting for the already-scheduled-but-now-stale retry tick to notice `!live.alive` on its own. ---
{
  const sessionId = "engine-id-e-died";
  const cwd = "/fake/codex/cwd-e-died";

  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  fakePty.push(`codex TUI booted\n${READY}\n`); // first attempt misses (no rollout file) — capture IS attempted
  check("(E) capture was attempted before death", host.liveCodex.get(sessionId)?.engineSessionIdCaptureAttempted === true);

  fakePty.kill(); // pty dies mid-window — synchronous, so onExit has already run by the time this returns
  const exit = exitEvents.find((e) => e.sessionId === sessionId);
  check("(E) onExit fired", exit !== undefined);
  check("(E) engineSessionIdCaptureEndReason is \"died-mid-capture\"", exit?.info.codexStopDiag?.engineSessionIdCaptureEndReason === "died-mid-capture");
}

// --- Scenario F: CAPTURE-NOT-ATTEMPTED — the pty dies before the ready marker ever renders, so the retry
// chain never even starts (the outer `engineSessionIdCaptureAttempted` latch never fires). ---
{
  const sessionId = "engine-id-f-never";
  const cwd = "/fake/codex/cwd-f-never";

  host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  fakePty.push(`codex TUI booting...\n`); // no ready marker ever rendered
  check("(F) capture was never attempted", host.liveCodex.get(sessionId)?.engineSessionIdCaptureAttempted === false);

  fakePty.kill();
  const exit = exitEvents.find((e) => e.sessionId === sessionId);
  check("(F) onExit fired", exit !== undefined);
  check("(F) engineSessionIdCaptureEndReason is \"capture-not-attempted\"", exit?.info.codexStopDiag?.engineSessionIdCaptureEndReason === "capture-not-attempted");
}

await finishAndExit(failures === 0 ? 0 : 1);
