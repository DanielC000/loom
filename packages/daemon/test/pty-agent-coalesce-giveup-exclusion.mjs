// Regression guard for card eac3464d correction 2 — a give-up/re-mint (`giveUpGen`-tagged, framed
// `[loom:possible-duplicate root:...]`) entry must NEVER be folded into the new same-sender coalescing
// (pty-agent-sender-coalesce.mjs's own suite). Card eac3464d's own DoD-0 measured these arriving 10-40s
// AFTER the original attempt already drained or parked — nothing is ever actually adjacent to coalesce
// them with — and the manager's correction 2 is explicit: coalescing them buys nothing and stacks a
// bigger write onto exactly the unconfirmed-write path that produced them (cards c23e2869/3ce3fa39,
// 8af2b9bd). This suite proves the exclusion against a REAL give-up (not a synthesized flag), reusing
// pty-giveup-requeue.mjs's own proven fast-timeout recipe against a SILENT fake pty (every submit here
// is a genuine drop, never the false-negative/SUPPRESSED case).
//
//   (1) a giveUpGen-tagged HEAD drains ALONE — even with fresh, same-sender, non-giveUpGen messages
//       queued right behind it (proves drainPending's `head.giveUpGen === undefined` gate);
//   (2) those fresh same-sender messages, enqueued WHILE the giveUpGen entry already occupies the queue,
//       do NOT reorder onto/around it — they land normally, behind it, in FIFO order (proves
//       enqueueStdin's reorder scan correctly skips a giveUpGen candidate rather than anchoring on it);
//   (3) once the giveUpGen entry is finally gone (its own requeue budget exhausted — dropped for real,
//       not requeued forever), the fresh same-sender messages behind it DO coalesce normally on the next
//       drain — proving the exclusion is scoped to the giveUpGen entry itself, not a general breakage of
//       this sender's coalescing going forward.
//
// RUN (no daemon needed): node test/pty-agent-coalesce-giveup-exclusion.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs = 10_000)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout), so calls below now go
// straight to the shared `_wait.mjs` helper with an explicit options object (same timeoutMs:10_000/
// intervalMs:2 this file's own defaults used — values unchanged).

const tmpHome = path.join(os.tmpdir(), `loom-agent-coalesce-giveup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// Fast, deterministic give-up timing — mirrors pty-giveup-requeue.mjs's own proven values exactly.
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = "5";
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = "3";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = "10";
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = "15";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
const HOLD_MS = 10;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
const HOLD_WAIT = HOLD_MS + 20;
// Pinned so this suite's own AGENT_COALESCE_MAX_COUNT/_MAX_BYTES don't matter — well above anything used here.
process.env.LOOM_AGENT_COALESCE_MAX_COUNT = "10";
process.env.LOOM_AGENT_COALESCE_MAX_BYTES = "5000";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

/** Never emits output — every give-up this drives is a genuine drop, never the false-negative case. */
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { fake, written: () => fake.writes.join("") };
}

try {
  const SID = "sess-giveup-exclusion";
  const GIVEUP_TEXT = "GIVEUP_ORIGINAL_MESSAGE";
  const FRESH1 = "FRESH_SAME_SENDER_ONE";
  const FRESH2 = "FRESH_SAME_SENDER_TWO";
  const SENDER = "worker-giveup-x";
  const { written } = spawnReady(SID);

  // Trigger a genuine give-up: enqueue while idle (delivered immediately, busy armed for GIVEUP_TEXT's
  // OWN in-flight turn). WHILE it's still genuinely busy with that turn (before it gives up), two FRESH
  // same-sender messages arrive and are HELD normally — this is the real production shape (a give-up is
  // only DISCOVERED after the fact; nothing arrives "already knowing" a message ahead of it will fail).
  const r0 = host.enqueueStdin(SID, GIVEUP_TEXT, "system", undefined, undefined, "agent", undefined, undefined, false, SENDER);
  check("setup: GIVEUP_TEXT delivered immediately, busy armed", r0.delivered === true && busyLog[SID].at(-1) === true);
  host.enqueueStdin(SID, FRESH1, "system", undefined, undefined, "agent", undefined, undefined, false, SENDER);
  host.enqueueStdin(SID, FRESH2, "system", undefined, undefined, "agent", undefined, undefined, false, SENDER);
  check("setup: FRESH1/FRESH2 held behind GIVEUP_TEXT's own still-in-flight turn",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([FRESH1, FRESH2]));

  // GIVEUP_TEXT never confirms (silent pty) — wait for its give-up. Per the existing (pre-eac3464d)
  // mechanism, it's restored to the FRONT of pending, ahead of FRESH1/FRESH2.
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  const beforeDrain = host.getPending(SID);
  check("(1) setup: the give-up requeued GIVEUP_TEXT to the FRONT — pending is [GIVEUP_TEXT, FRESH1, FRESH2]",
    JSON.stringify(beforeDrain) === JSON.stringify([GIVEUP_TEXT, FRESH1, FRESH2]));
  check("(2) NO REORDER onto the giveUpGen entry: FRESH1/FRESH2 never anchored onto GIVEUP_TEXT while it was still queued",
    host.getPendingEntries(SID)[0].giveUpGen !== undefined && host.getPendingEntries(SID)[0].text === GIVEUP_TEXT);

  // Let the hold expire, then drain (reconcile). The giveUpGen-tagged HEAD must drain ALONE — FRESH1/
  // FRESH2 must NOT be folded into its redelivery turn even though they're same-sender and adjacent.
  // TIMING-GUARD-SAFE: this sleep only waits for the KNOWN, PINNED hold precondition to expire
  // (GIVEUP_TEXT's requeued entry is structurally ineligible to drain before HOLD_MS elapses — pinned
  // via LOOM_GIVE_UP_HOLD_MS above — and HOLD_WAIT is a fixed +20ms margin past that pinned value, so
  // it can only ever wait LONGER than required, never shorter, since a setTimeout-based sleep never
  // fires early). Every assertion below runs SYNCHRONOUSLY right after `host.reconcile()`, with no
  // further await in between — drainPending's same-sender-run selection (the `head.giveUpGen ===
  // undefined` gate this test exists to cover) and submit()'s own write decision both happen
  // synchronously inside that one reconcile() call, so nothing any of these checks observe (busyLog,
  // the write stream, `getPending`) can change as a result of anything started AFTER this point. Same
  // reasoning, same pinned constants, as pty-giveup-requeue.mjs's own identical `sleep(HOLD_WAIT);
  // host.reconcile();` site (scenario 2).
  await sleep(HOLD_WAIT);
  const busyLenBeforeRedrain = busyLog[SID].length;
  host.reconcile();
  check("(1) EXCLUSION: the redrain re-armed busy (GIVEUP_TEXT alone went out)",
    busyLog[SID].length > busyLenBeforeRedrain && busyLog[SID].at(-1) === true);
  check("(1) EXCLUSION: neither FRESH1 nor FRESH2 appear in the giveUpGen redrain's write stream",
    !written().includes(FRESH1) && !written().includes(FRESH2));
  check("(1) EXCLUSION: FRESH1/FRESH2 are untouched, still queued behind the (now redraining) original",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([FRESH1, FRESH2]));

  // GIVEUP_TEXT's redrain ALSO never confirms (silent pty) — its SECOND failure exceeds
  // LOOM_GIVE_UP_REQUEUE_LIMIT=1, so this time it is dropped for real (no infinite requeue).
  await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
  check("(3) setup: GIVEUP_TEXT is finally gone from pending — requeue budget exhausted",
    !host.getPendingEntries(SID).some((m) => m.text === GIVEUP_TEXT));
  check("(3) setup: FRESH1/FRESH2 are now the WHOLE queue, head-to-tail, still same-sender/adjacent",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([FRESH1, FRESH2]));

  // With the giveUpGen entry gone, the next drain should coalesce FRESH1+FRESH2 normally — the exclusion
  // is scoped to the giveUpGen entry, not a lasting breakage of this sender's coalescing.
  host.reconcile();
  check("(3) RECOVERY: FRESH1 and FRESH2 coalesce into ONE turn now that nothing giveUpGen-tagged blocks them",
    written().includes(FRESH1) && written().includes(FRESH2) && host.getPending(SID).length === 0);
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a give-up/re-mint entry is excluded from same-sender coalescing/reordering both ways, and the exclusion is scoped to that entry alone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
