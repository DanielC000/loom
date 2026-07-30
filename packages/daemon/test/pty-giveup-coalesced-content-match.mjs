// Regression test for card 4a0af485, Code Review Major 4 — "the content-match mechanism is structurally
// INERT on a COALESCED drain."
//
// ROOT CAUSE: `drainPending` can coalesce SEVERAL pending entries into ONE physical turn
// (`drained.map(m => m.text).join(DRAIN_SEPARATOR)`) — the default behavior for `warning`-kind entries,
// and for EVERY `agent` message once the daemon-global `coalesceAgentMessages` setting is on. Pre-fix,
// `requeueGiveUpOrigin` seeded `Live.ambiguousDispatches` from each origin message's OWN individual
// `.text` — but the engine's actual echo (`hook.prompt`) reflects the JOINED text that was really written.
// No stored signature could EVER match a coalesced turn's real confirmation: content matching silently
// never fired for the default warning-kind drain path.
//
// THE FIX: `requeueGiveUpOrigin` now computes the JOINED text exactly the way `drainPending` itself does
// (`origin.map(m => m.text).join(DRAIN_SEPARATOR)`) and seeds EVERY origin member's map entry with THAT
// signature — so a single confirming hook for the coalesced turn resolves every member at once.
// `purgeConfirmedGiveUpRequeue` was also changed to resolve ALL matching signatures, not just the first,
// since a coalesced batch's members legitimately share one identical signature.
//
// This suite proves, against a fake pty that never emits output (a genuine drop):
//   (1) RED-FIRST: matching against either INDIVIDUAL member's own text alone does NOT resolve anything —
//       proving the fix isn't a no-op (the pre-fix seeding would have looked exactly like this on every
//       attempt, including the correct one).
//   (2) THE FIX: matching against the ACTUAL JOINED text (what the engine really echoes) resolves BOTH
//       coalesced members in one hook — both requeued duplicates purged, both durable considerations
//       satisfied (both share the same signature, by design, not a collision).
//
// RUN (no daemon needed): node test/pty-giveup-coalesced-content-match.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-coalesced-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeSilentFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
class SilentTestPtyHost extends PtyHost { createPty() { return makeSilentFakePty(); } }
const host = new SilentTestPtyHost(events);

const SID = "sess-coalesced-content-match";
const DRAIN_SEPARATOR = "\n\n────────\n\n"; // mirrors host.ts's own DRAIN_SEPARATOR literal
const TEXT_A = "COALESCED_MEMBER_A";
const TEXT_B = "COALESCED_MEMBER_B";
const JOINED_TEXT = TEXT_A + DRAIN_SEPARATOR + TEXT_B;

try {
  host.spawn({ sessionId: SID, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(SID, { hook_event_name: "SessionStart" });

  // ===== SETUP: arm busy with a kickstart turn, confirm it (so it never itself gives up), then enqueue TWO =====
  // ===== warning-kind entries WHILE busy — they queue FIFO, both HELD, ready to coalesce on the next drain ===
  host.enqueueStdin(SID, "KICKSTART_TURN", "system", undefined, undefined, "agent");
  check("(setup) kickstart delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "KICKSTART_TURN" }); // confirms cleanly, no give-up

  const rA = host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "warning");
  const rB = host.enqueueStdin(SID, TEXT_B, "system", undefined, undefined, "warning");
  check("(setup) both warning-kind entries HELD (busy) — queued for coalescing", rA.delivered === false && rB.delivered === false);

  // ===== end the kickstart turn — drainPending coalesces [TEXT_A, TEXT_B] (same empty route, same =====
  // ===== "warning" kind) into ONE joined submission ==========================================================
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(setup) the coalesced drain went out as ONE turn (busy re-armed)", busyLog[SID]?.at(-1) === true);
  const writtenSoFar = fakes.at(-1).writes.join("");
  check("(setup) the ACTUAL write contains the JOINED text (both members, separator included)", writtenSoFar.includes(JOINED_TEXT));

  // ===== let this coalesced generation give up (silent pty never confirms) — requeueGiveUpOrigin runs with =====
  // ===== origin=[entryA, entryB] ==============================================================================
  await waitUntil(() => busyLog[SID]?.at(-1) === false);
  check("(setup) the coalesced generation genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  const pendingAfterGiveUp = host.getPendingEntries(SID);
  check("(setup) BOTH coalesced members are requeued, sitting ambiguous",
    pendingAfterGiveUp.some((m) => m.text === TEXT_A) && pendingAfterGiveUp.some((m) => m.text === TEXT_B));

  // Introduce an intervening FRESH, non-ambiguous generation (gen 3) — WITHOUT this, the pre-existing
  // FIFO-position FALLBACK (unrelated to Major 4, already covered by pty-giveup-purge-cross-generation.mjs)
  // would ALSO resolve gen 2 via plain `giveUpGen` correlation regardless of content, since nothing else
  // would be current — masking whether content-matching itself is doing any real work. With gen 3 current
  // and unrelated, the fallback's own `genIsCurrentOrAlsoAmbiguous` check is false, so ONLY a genuine
  // content match (this card's fix) can resolve gen 2's coalesced pair from here on.
  const r3 = host.enqueueStdin(SID, "HEALTHY_UNRELATED_GEN_3", "system", undefined, undefined, "agent");
  check("(setup) gen 3 delivered, busy armed", r3.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "HEALTHY_UNRELATED_GEN_3" });
  check("(setup) gen 3 confirmed cleanly, current and unrelated — gen 2's coalesced pair still survives", host.getPendingEntries(SID).filter((m) => m.text === TEXT_A || m.text === TEXT_B).length === 2);

  // ===== (1) RED-FIRST: matching against EITHER individual member's own text alone must NOT resolve =====
  // ===== anything — this is exactly what the PRE-FIX seeding (individual text, not joined) would have =====
  // ===== produced on EVERY attempt, including the correct one. With gen 3 now current and unrelated, the =====
  // ===== FIFO-position fallback can't resolve it either — ONLY a genuine content match could ===============
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_A });
  check("(1) RED-FIRST: matching against TEXT_A alone (not joined) does NOT content-match — proves individual-text seeding would never fire",
    !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) RED-FIRST: both members STILL sit in pending, untouched by the non-matching attempt (the FIFO fallback can't reach it either — gen 3 is current and unrelated)",
    host.getPendingEntries(SID).filter((m) => m.text === TEXT_A || m.text === TEXT_B).length === 2);

  // ===== (2) THE FIX: matching against the REAL joined text (what the engine actually echoes) resolves =====
  // ===== BOTH coalesced members in ONE hook ===================================================================
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: JOINED_TEXT });
  const confirmedLines = submitLog.filter((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched"));
  check("(2) THE FIX: TWO distinct CONFIRMED logs fired — one per coalesced member's own logicalId", confirmedLines.length === 2);
  check("(2) THE FIX: BOTH coalesced members are purged from pending",
    !host.getPendingEntries(SID).some((m) => m.text === TEXT_A || m.text === TEXT_B));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a coalesced drain's content-match now seeds from the ACTUAL joined text (matching what the engine really echoes), not each member's own individual text, so a single confirming hook correctly resolves every coalesced member at once instead of silently never firing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
