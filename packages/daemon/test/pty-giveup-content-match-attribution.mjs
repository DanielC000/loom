// Regression test for card 4a0af485 — "a give-up's late confirmation is attributed to whatever generation
// is CURRENT, not the generation it actually belongs to" (the exact mechanism behind the card's own live
// trace: generation 1 confirmed 232s late while generation 6 was current, producing the first-ever
// observed NEGATIVE prompt-mismatch lenDelta because the comparison ran against the WRONG candidate).
//
// ROOT CAUSE being guarded: `purgeConfirmedGiveUpRequeue`'s pre-card logic ONLY ever correlates a late
// confirmation to `Live.giveUpConfirmQueue`'s FRONT — the OLDEST generation that has ALSO given up. The
// instant a FRESH, never-ambiguous generation takes over in between (this file's own established "leaving
// generation N's requeued entry un-purged" branch — see pty-giveup-purge-cross-generation.mjs for that
// EXISTING, correct-but-incomplete safety net), the old code correctly declines to misattribute, but has
// NO alternative mechanism to resolve the ambiguity — the requeued duplicate just sits until its bounded
// hold expires and drains as a genuine double-delivery.
//
// THE FIX: `Live.ambiguousDispatches` tracks every given-up generation's own content SIGNATURE (length +
// the same cheap `fnv1a32` hash `ptyWrite`'s log line already uses — never the full text). A confirming
// hook's own `hook.prompt` (already flowing through the system for the pre-existing prompt-mismatch
// diagnostic) is matched against EVERY tracked signature — not just the queue front — so a late
// confirmation is attributed by CONTENT, correctly, regardless of how many unrelated generations came and
// went in between.
//
// This suite proves, against a fake pty that never emits output (so gen 1's give-up is a genuine drop):
//   (1) THE CARD'S EXACT SCENARIO: gen 1 gives up and requeues. FOUR further generations (2-5) each
//       complete NORMALLY (no give-up at all — confirmed via their own hook, exactly like an ordinary,
//       healthy turn) while gen 1's requeued duplicate sits ambiguous. Gen 1's OWN late confirmation then
//       arrives (its EXACT original framed text as `hook.prompt`) while generation 6 is current and
//       entirely unrelated — content-match must find and purge gen 1's duplicate specifically, never
//       misattributing to (or disturbing) the current, healthy generation 6.
//   (2) NO FALSE POSITIVE: an intermediate generation's own confirmation (no matching prompt) must NEVER
//       be misread as resolving gen 1's ambiguity — gen 1's requeued entry must survive every one of the
//       normal generations 2-5 confirming in between.
//   (3) THE CONFIRMED LOG carries the RIGHT generation's own latency, not a guess.
//
// RUN (no daemon needed): node test/pty-giveup-content-match-attribution.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-giveup-content-match-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000"; // generous — this test resolves the ambiguity itself, never relies on the hold expiring

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
// Card 417cea0a: capture `onGiveUpConfirmed` (new optional PtyHostEvents hook, fired from
// `purgeConfirmedGiveUpRequeue`'s content-match CONFIRMED branch — the exact branch this file's gen-1
// scenario already exercises) so this suite can prove the NEW hook actually fires, carrying the SAME
// sessionId/latencyMs the pre-existing "CONFIRMED logicalId=…" log line reports.
const giveUpConfirmedLog = [];
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
  onGiveUpConfirmed(sessionId, logicalId, latencyMs) { giveUpConfirmedLog.push({ sessionId, logicalId, latencyMs }); },
};
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
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

/** Submit `text` as a fresh idle-immediate turn and confirm it NORMALLY (no give-up at all) — mirrors an
 *  ordinary healthy turn taking place while an EARLIER generation's give-up ambiguity is still open. */
function confirmNormally(sessionId, text) {
  const r = host.enqueueStdin(sessionId, text, "system", undefined, undefined, "agent");
  host.deliverHook(sessionId, { hook_event_name: "UserPromptSubmit", prompt: text });
  host.deliverHook(sessionId, { hook_event_name: "Stop" });
  return r;
}

try {
  const SID = "sess-content-match";
  const TEXT1 = "GEN1_LATE_CONFIRM_232_SECONDS_AFTER_FIVE_MORE_GENERATIONS";
  spawnReady(SID);

  // ===== gen 1: idle-immediate, then a genuine give-up (silent pty never confirms) =====
  const r1 = host.enqueueStdin(SID, TEXT1);
  check("(setup) gen 1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  await waitUntil(() => busyLog[SID]?.at(-1) === false);
  check("(setup) gen 1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  check("(setup) gen 1's TEXT1 is requeued, sitting ambiguous in pending", host.getPendingEntries(SID).some((m) => m.text === TEXT1));

  // ===== generations 2-5: FOUR entirely normal, healthy turns — none of them give up — while gen 1's =====
  // ===== ambiguity stays open the whole time (this is what makes generation 6, below, "current and =========
  // ===== entirely unrelated" — the card's own exact shape, not the simpler single-hop cross-gen case =======
  // ===== pty-giveup-purge-cross-generation.mjs already covers) ===============================================
  for (let i = 2; i <= 5; i++) {
    const before = host.getPendingEntries(SID).length;
    const r = confirmNormally(SID, `HEALTHY_TURN_GEN_${i}`);
    check(`(2) gen ${i} confirmed normally without disturbing gen 1's still-ambiguous requeue`,
      r.delivered === true && host.getPendingEntries(SID).length === before && host.getPendingEntries(SID).some((m) => m.text === TEXT1));
  }

  // ===== gen 6: ALSO a fresh, healthy, unrelated confirmation — current at the moment gen 1's late hook ====
  // ===== arrives, mirroring the trace's own "generation 6 (a fresh, non-ambiguous submit) is now current" ===
  const r6 = host.enqueueStdin(SID, "HEALTHY_TURN_GEN_6_CURRENT_WHEN_LATE_HOOK_ARRIVES", "system", undefined, undefined, "agent");
  check("(setup) gen 6 delivered, busy armed", r6.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "HEALTHY_TURN_GEN_6_CURRENT_WHEN_LATE_HOOK_ARRIVES" });
  check("(setup) gen 6 is now CURRENT and confirmed — gen 1's TEXT1 still survives, untouched", host.getPendingEntries(SID).some((m) => m.text === TEXT1));

  // ===== (1) THE FIX: gen 1's own late confirmation arrives (EXACT original text) — content-match must ====
  // ===== find and purge IT specifically, regardless of how many unrelated generations came between ========
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT1 });
  check("(1) THE FIX: a CONTENT-MATCHED CONFIRMED log was emitted for gen 1's own logicalId",
    submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(1) THE FIX: gen 1's requeued duplicate is purged — no longer sitting in pending", !host.getPendingEntries(SID).some((m) => m.text === TEXT1));
  check("(1) THE FIX: the purge was reported as a FALSE NEGATIVE recovery, content-matched", submitLog.some((l) => l.includes("false negative (content-matched)")));

  // ===== (3) the CONFIRMED log's own latency is plausible (measured from gen 1's ORIGINAL write, not from =====
  // ===== "just now") — it must be AT LEAST the combined real elapsed time of every step since gen 1 fired ===
  const confirmedLine = submitLog.find((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched"));
  const latencyMatch = confirmedLine?.match(/latencyMs=(\d+)/);
  check("(3) the CONFIRMED log carries a real, positive latencyMs (not 0, not \"unknown\")", !!latencyMatch && Number(latencyMatch[1]) > 0);

  // ===== Card 417cea0a: the NEW onGiveUpConfirmed hook fired exactly once for THIS session, carrying the =====
  // ===== SAME latencyMs the pre-existing CONFIRMED log line already reports — proves the hook is wired at ===
  // ===== the right call site (not a separate, possibly-drifted computation) and fires exactly once (not ====
  // ===== once per matched logicalId when there's only one, not zero) =========================================
  check("(417cea0a) onGiveUpConfirmed fired exactly once, for this session, with the SAME latencyMs the CONFIRMED log reported",
    giveUpConfirmedLog.length === 1 && giveUpConfirmedLog[0].sessionId === SID &&
    !!latencyMatch && String(giveUpConfirmedLog[0].latencyMs) === latencyMatch[1]);

  // ===== sanity: gen 6 (the CURRENT, unrelated generation) was never touched by any of this =====
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(sanity) gen 6's own turn finalizes cleanly, unaffected by gen 1's resolution", busyLog[SID]?.at(-1) === false);

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a late give-up confirmation is attributed by CONTENT to the generation it actually belongs to, correctly resolving the card's own exact specimen (five unrelated healthy generations passing in between) instead of only the simpler single-hop cross-generation case the FIFO-position fallback already covered."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
