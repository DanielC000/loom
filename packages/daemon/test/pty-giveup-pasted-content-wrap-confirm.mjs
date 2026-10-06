// Card 0658d6d8 — from the round-2 Code Review of dc92f4b6: `purgeConfirmedGiveUpRequeueCore` (host.ts)
// matches the RAW `textSignature(reportedPrompt)` against `live.ambiguousDispatches`/
// `live.retiredGiveUpSignatures`, with no awareness of the engine's own `<pasted_content id="X">…
// </pasted_content id="X">` composer wrap (the same framing `isRecognizedPastedContentWrap`/
// `findRecognizedPastedContentWrapOfPriorWrite` recognize for the UNRELATED prompt-mismatch-
// classification path — see dc92f4b6's own record). So a WRAPPED late confirmation of a given-up
// generation K never purges K's still-queued give-up re-mint, even though the content fully arrived —
// the exact dc92f4b6 specimen shape, but hitting the GIVE-UP PURGE instead of the mismatch classifier.
//
// WHY THE FIFO-POSITION FALLBACK DOESN'T SAVE THIS: that fallback is content-blind, but it only fires
// when generation K is STILL the current generation (or still in the ambiguous queue) — see
// `purgeConfirmedGiveUpRequeueCore`'s own "FALLBACK" comment. The moment a FRESH, unrelated generation
// becomes current in between (exactly dc92f4b6's own shape: give-up, re-mint, confirm elsewhere), the
// fallback correctly declines rather than guess, leaving ONLY the content-match tier able to resolve the
// wrapped late echo — and that tier is what this card's bug defeats.
//
// THIS FILE IS THE STEP-1 CHECKPOINT REPRO (worker_report blocked, per kickoff) — scenario 1 below is
// EXPECTED TO FAIL (RED) on the pre-fix tree, proving the bug is real and reachable. Scenario 2 is the
// DoD's negative control (an unrelated wrapped body must NOT falsely purge).
//
// Mirrors pty-giveup-content-match-attribution.mjs's own harness (real PtyHost + a silent fake pty that
// never confirms, so a give-up is genuine) and borrows pty-prompt-mismatch-pasted-content-wrap-replay.mjs's
// `pastedContentWrap` builder for the engine's own composer-wrap shape.
// RUN (no daemon needed): node test/pty-giveup-pasted-content-wrap-confirm.mjs (build first: from
// packages/daemon, run `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-wrap-confirm-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "60000"; // generous — this test resolves (or deliberately fails to resolve) the ambiguity itself, never relies on the hold expiring

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = {};
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
};
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes[opts.sessionId] = fake;
    return fake;
  }
}
const host = new SilentTestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({ sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

/** Submit `text` as a fresh idle-immediate turn and confirm it NORMALLY (no give-up at all) — mirrors an
 *  ordinary healthy turn taking place while an EARLIER generation's give-up ambiguity is still open
 *  (exactly pty-giveup-content-match-attribution.mjs's own `confirmNormally` helper). */
function confirmNormally(sessionId, text) {
  const r = host.enqueueStdin(sessionId, text, "system", undefined, undefined, "agent");
  host.deliverHook(sessionId, { hook_event_name: "UserPromptSubmit", prompt: text });
  host.deliverHook(sessionId, { hook_event_name: "Stop" });
  return r;
}

// Builds the engine's own paste-composer wrap exactly as `PASTED_CONTENT_WRAP_RE` requires it
// (host.ts): `\n\n<pasted_content id="ID">\n<inner>\n</pasted_content id="ID">\n`.
const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

const SIDS = [];

try {
  // ===== 1. THE BUG (positive case): gen 1 gives up genuinely (silent pty never confirms); its requeued
  // duplicate sits ambiguous. A fresh, unrelated generation (2) then becomes current — exactly dc92f4b6's
  // own shape — so the content-blind FIFO-position fallback correctly declines to touch gen 1's entry
  // (see this file's own header). Gen 1's OWN late confirmation then finally arrives, but WRAPPED in the
  // engine's own pasted-content composer framing. Must purge gen 1's still-queued duplicate. =====
  {
    const sid = "sess-wrap-confirm-positive"; SIDS.push(sid);
    const TEXT1 = "GEN1_WRAPPED_LATE_CONFIRMATION_AFTER_AN_UNRELATED_CURRENT_GENERATION";
    spawnReady(sid);

    const r1 = host.enqueueStdin(sid, TEXT1);
    check("(setup) gen 1 delivered immediately, busy armed", r1.delivered === true && busyLog[sid]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[sid]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: "pty-giveup-pasted-content-wrap-confirm: gen1 give-up" });
    check("(setup) gen 1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
    check("(setup) gen 1's TEXT1 is requeued, sitting ambiguous in pending", host.getPendingEntries(sid).some((m) => m.text === TEXT1));

    // A fresh, unrelated, healthy generation (2) becomes current — gen 1 is no longer the front/current
    // generation the content-blind FIFO fallback would still cover.
    const before = host.getPendingEntries(sid).length;
    const r2 = confirmNormally(sid, "HEALTHY_UNRELATED_GEN_2");
    check("(setup) gen 2 confirmed normally without disturbing gen 1's still-ambiguous requeue",
      r2.delivered === true && host.getPendingEntries(sid).length === before && host.getPendingEntries(sid).some((m) => m.text === TEXT1));

    // Gen 1's own late confirmation finally arrives — but wrapped in the engine's own composer framing,
    // never the raw text `ambiguousDispatches` actually stored a signature for.
    submitLog.length = 0;
    const wrapped = pastedContentWrap("gw01", TEXT1);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: wrapped });

    check("1: THE FIX — a CONTENT-MATCHED CONFIRMED log was emitted for gen 1's own logicalId",
      submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("1: THE FIX — gen 1's requeued duplicate is purged — no longer sitting in pending",
      !host.getPendingEntries(sid).some((m) => m.text === TEXT1));

    // (b) the fix adds NO new console.log/warn/error call (it only widens the existing signature check
    // with a second {len,hash} computed via the same `textSignature` already used throughout this file)
    // — assert directly that the CONFIRMED log this scenario just produced carries only ids/lengths/gens,
    // never raw TEXT1 content itself (captured now, before a later scenario clears submitLog).
    const confirmedLine = submitLog.find((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched"));
    check("(b) the CONFIRMED log line does not leak raw message content",
      typeof confirmedLine === "string" && !confirmedLine.includes(TEXT1));
  }

  // ===== 2. NEGATIVE CONTROL — an UNRELATED wrapped body must NOT falsely purge gen 1's still-queued
  // duplicate: it carries none of gen 1's content, so it must leave the duplicate sitting in pending
  // exactly as before (free to redrive once its hold eventually clears), never be silently absorbed by an
  // over-wide unwrap. =====
  {
    const sid = "sess-wrap-confirm-negative"; SIDS.push(sid);
    const TEXT1 = "GEN1_UNRELATED_WRAPPED_BODY_MUST_NOT_FALSELY_PURGE_THIS";
    spawnReady(sid);

    const r1 = host.enqueueStdin(sid, TEXT1);
    check("(setup 2) gen 1 delivered immediately, busy armed", r1.delivered === true && busyLog[sid]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[sid]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: "pty-giveup-pasted-content-wrap-confirm: gen1 give-up (negative)" });
    check("(setup 2) gen 1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
    check("(setup 2) gen 1's TEXT1 is requeued, sitting ambiguous in pending", host.getPendingEntries(sid).some((m) => m.text === TEXT1));

    const before = host.getPendingEntries(sid).length;
    confirmNormally(sid, "HEALTHY_UNRELATED_GEN_2_NEGATIVE");

    submitLog.length = 0;
    const unrelatedWrapped = pastedContentWrap("gw02", "SOMETHING_ENTIRELY_UNRELATED_TO_GEN_1");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: unrelatedWrapped });

    check("2: NEGATIVE CONTROL — no CONTENT-MATCHED CONFIRMED log for an unrelated wrapped body",
      !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("2: NEGATIVE CONTROL — gen 1's requeued duplicate STILL sits in pending (still redrives, not falsely purged)",
      host.getPendingEntries(sid).length === before && host.getPendingEntries(sid).some((m) => m.text === TEXT1));
  }

  // ===== 3. NEGATIVE CONTROL — a SUPERSET: the wrap's inner is gen 1's own recorded text PLUS extra,
  // unrelated trailing content. "Exact whole-inner equality only" means this must NOT purge — the inner
  // group's own signature (length+hash over the WHOLE captured group, extra chars included) can never
  // equal the archived entry's signature, so this is really just proving the fix didn't accidentally widen
  // to a prefix/substring match. =====
  {
    const sid = "sess-wrap-confirm-superset"; SIDS.push(sid);
    const TEXT1 = "GEN1_SUPERSET_WRAPPED_BODY_MUST_NOT_PURGE_EXACT_WHOLE_INNER_ONLY";
    spawnReady(sid);

    const r1 = host.enqueueStdin(sid, TEXT1);
    check("(setup 3) gen 1 delivered immediately, busy armed", r1.delivered === true && busyLog[sid]?.at(-1) === true);
    await sharedWaitUntil(() => busyLog[sid]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: "pty-giveup-pasted-content-wrap-confirm: gen1 give-up (superset)" });
    check("(setup 3) gen 1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
    check("(setup 3) gen 1's TEXT1 is requeued, sitting ambiguous in pending", host.getPendingEntries(sid).some((m) => m.text === TEXT1));

    const before = host.getPendingEntries(sid).length;
    confirmNormally(sid, "HEALTHY_UNRELATED_GEN_2_SUPERSET");

    submitLog.length = 0;
    const supersetContent = `${TEXT1}EXTRA-UNRELATED-TAIL-CONTENT`;
    const supersetWrapped = pastedContentWrap("gw03", supersetContent);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: supersetWrapped });

    check("3: NEGATIVE CONTROL — a SUPERSET (gen 1's text + extra content) does NOT content-match-confirm",
      !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("3: NEGATIVE CONTROL — gen 1's requeued duplicate STILL sits in pending (not purged by a superset)",
      host.getPendingEntries(sid).length === before && host.getPendingEntries(sid).some((m) => m.text === TEXT1));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a wrapped late confirmation of a given-up generation is recognized by unwrapping the engine's pasted-content composer framing before the content-match signature check, purging that generation's still-queued give-up re-mint; an unrelated wrapped body, and a superset (exact-whole-inner, not substring) wrapped body, both still leave an unrelated/unresolved duplicate untouched (still redrives, never falsely purged); and the CONFIRMED log line this fix's match can now produce still carries no raw message content."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
