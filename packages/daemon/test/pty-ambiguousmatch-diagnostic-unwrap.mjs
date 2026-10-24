// Card 3c8db740 — from the round-2 Code Review of aeb62a82 (reviewer 2c8a4321). The read-only
// `ambiguousMatch` diagnostic (host.ts, `[prompt-echo]` log line, UserPromptSubmit handler) used to
// compare only the RAW hook signature against `live.ambiguousDispatches`/`live.retiredGiveUpSignatures` —
// it never unwrapped the engine's own pasted-content composer wrap and never checked `escapedSig`, unlike
// `purgeConfirmedGiveUpRequeueCore`'s own `matchesSig` (which has done all three arms since aeb62a82). So
// a wrapped late echo whose content only matches via the unwrap/escapedSig arms could report
// `ambiguousMatch=false` right next to a genuine `CONFIRMED` log for that same hook — the exact
// contradiction class the dbc7ffea comment at that call site was written to prevent for the RAW case.
//
// THE SCENARIO: a give-up's archived signature (L1, containing a nested `<pasted_content>` tag, the kind
// of body the CLI itself forward-escapes on echo — card 691d02e1/aeb62a82) is moved out of
// `live.ambiguousDispatches` into `live.retiredGiveUpSignatures` — exactly what `archiveAmbiguousDispatch`
// plus a real redrive do together on a genuine redrive (card dbc7ffea), reproduced directly here (white-
// box) so this test does not depend on GIVE_UP_HOLD_MS's real timing. With `ambiguousDispatches` now
// EMPTY, `hadNoAmbiguityBeforeThisHook` reads true for the NEXT hook. A fresh, distinct dispatch (G3,
// never itself given up) is enqueued with the SAME text as L1, then its own confirming hook arrives
// WRAPPED and CLI-escaped — exactly how the real engine echoes a submission whose body quotes this tag
// syntax. `purgeConfirmedGiveUpRequeueCore` correctly DECLINES to attribute this to L1 (G3 is a different,
// unrelated identity — card 7a64f16b), via `declinedButCurrentGeneration:true`, which — combined with
// `hadNoAmbiguityBeforeThisHook:true` — also fires the ALWAYS-ON `[submit] ... CONFIRMED gen=...` log
// (card 4a0af485) for this same hook. L1's retired entry is NOT deleted by a decline, so it is still
// sitting there for the diagnostic to (dis)agree with.
//
// RUN (no daemon needed): node test/pty-ambiguousmatch-diagnostic-unwrap.mjs (build first: from
// packages/daemon, run `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const promptEchoLog = [];
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]);
  if (typeof args[0] === "string" && args[0].startsWith("[prompt-echo]")) promptEchoLog.push(args[0]);
  realConsoleLog(...args);
};

const tmpHome = path.join(os.tmpdir(), `loom-ambiguousmatch-unwrap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "60000"; // generous — this test resolves the give-up itself, never relies on the hold expiring

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = {};
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
  onGiveUpConfirmed() {},
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

// Builds the engine's own paste-composer wrap exactly as `PASTED_CONTENT_WRAP_RE` requires it
// (host.ts): `\n\n<pasted_content id="ID">\n<inner>\n</pasted_content id="ID">\n`.
const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

// Extracts the `ambiguousMatch=` value from the LAST [prompt-echo] line captured so far.
const lastAmbiguousMatch = () => {
  const line = promptEchoLog.at(-1);
  if (typeof line !== "string") return undefined;
  const m = /ambiguousMatch=(true|false)/.exec(line);
  return m ? m[1] === "true" : undefined;
};

const SIDS = [];

try {
  const sid = "sess-ambiguousmatch-unwrap"; SIDS.push(sid);
  const COLLISION_TEXT = "continue discussing `<pasted_content id=\"zz99\">...</pasted_content id=\"zz99\">` please.";
  spawnReady(sid);
  const live = host.live.get(sid);

  // L1 gives up genuinely (silent pty never confirms).
  const rL1 = host.enqueueStdin(sid, COLLISION_TEXT, "system", undefined, undefined, "agent");
  check("(setup) L1 delivered immediately, busy armed", rL1.delivered === true && busyLog[sid]?.at(-1) === true);
  await sharedWaitUntil(() => busyLog[sid]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2, label: "pty-ambiguousmatch-diagnostic-unwrap: L1 give-up" });
  check("(setup) L1 genuinely gave up (RECOVERY)", submitLog.some((l) => l.includes("GIVE-UP RECOVERY")));
  const l1LogicalId = host.getPendingEntries(sid)[0]?.id;
  check("(setup) L1 has a requeued duplicate sitting ambiguous in pending", l1LogicalId !== undefined);
  check("(setup) L1's entry is current (ambiguousDispatches)", live.ambiguousDispatches.has(l1LogicalId));

  // White-box: move L1's current entry into `retiredGiveUpSignatures`, vacating `ambiguousDispatches` —
  // exactly what `archiveAmbiguousDispatch` plus a real redrive do together (card dbc7ffea), reproduced
  // directly so this scenario does not depend on GIVE_UP_HOLD_MS's real timing (see header).
  const l1Entry = live.ambiguousDispatches.get(l1LogicalId);
  live.ambiguousDispatches.delete(l1LogicalId);
  live.retiredGiveUpSignatures.set(l1LogicalId, [l1Entry]);
  check("(setup) ambiguousDispatches is now EMPTY (hadNoAmbiguityBeforeThisHook will read true)", live.ambiguousDispatches.size === 0);
  check("(setup) retiredGiveUpSignatures carries L1's archived entry", live.retiredGiveUpSignatures.get(l1LogicalId)?.length === 1);

  // G3: a FRESH, never-given-up dispatch whose own text is byte-identical to L1's archived signature.
  submitLog.length = 0;
  promptEchoLog.length = 0;
  const rG3 = host.enqueueStdin(sid, COLLISION_TEXT, "system", undefined, undefined, "agent");
  check("(setup) G3 delivered immediately, busy armed", rG3.delivered === true && busyLog[sid]?.at(-1) === true);
  const escapedCollision = COLLISION_TEXT.replace(/<(\/?)pasted_content/g, "<\\$1pasted_content");
  check("(fixture sanity) the escape actually added characters", escapedCollision.length > COLLISION_TEXT.length);
  const g3Wrapped = pastedContentWrap("gw99", escapedCollision);
  host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: g3Wrapped }); // G3's own, legitimate, expected confirmation

  check("1: a [submit] CONFIRMED log fired for this hook (card 4a0af485's always-on gen-latency diagnostic)",
    submitLog.some((l) => l.includes("CONFIRMED gen=")));
  check("1: a DECLINED content match log also fired, naming L1's logicalId (purge correctly did not attribute G3's hook to L1)",
    submitLog.some((l) => l.includes("DECLINED content match") && l.includes(l1LogicalId)));
  check("1: THE FIX — the [prompt-echo] diagnostic on this SAME hook agrees: ambiguousMatch=true (L1's archived entry IS a genuine match, just correctly not attributed)",
    lastAmbiguousMatch() === true);

  // DIAGNOSTIC-ONLY, per the DoD: the purge/requeue OUTCOME must be unchanged by this fix. L1's retired
  // entry survives untouched (a decline never deletes), its pending duplicate survives, and no
  // onGiveUpConfirmed fired for it — identical to what the unfixed diagnostic's own code path would have
  // left behind, since `ambiguousMatch` has exactly one consumer (the [prompt-echo] log line) and is never
  // read by any purge/requeue/confirm/resolve decision.
  check("2: diagnostic-only — L1's retired entry is UNCHANGED (still archived, not purged)",
    live.retiredGiveUpSignatures.get(l1LogicalId)?.length === 1 && live.ambiguousDispatches.size === 0);
  check("2: diagnostic-only — L1's requeued duplicate SURVIVES in pending",
    host.getPendingEntries(sid).some((m) => m.id === l1LogicalId));

  // End G3's turn so the next enqueueStdin below delivers immediately rather than queueing behind busy.
  host.deliverHook(sid, { hook_event_name: "Stop" });

  // NEGATIVE CONTROL — an UNRELATED wrapped body (no nested tag, no shared content with L1 at all) must
  // still report ambiguousMatch=false: the fix must not widen matching into a false positive.
  submitLog.length = 0;
  promptEchoLog.length = 0;
  const rG4 = host.enqueueStdin(sid, "SOMETHING_ENTIRELY_UNRELATED", "system", undefined, undefined, "agent");
  check("(setup negative) G4 delivered immediately, busy armed", rG4.delivered === true && busyLog[sid]?.at(-1) === true);
  host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: "SOMETHING_ENTIRELY_UNRELATED" });
  check("3: NEGATIVE CONTROL — an unrelated confirmation still reports ambiguousMatch=false",
    lastAmbiguousMatch() === false);
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the read-only ambiguousMatch diagnostic now unwraps the engine's pasted-content composer wrap and checks escapedSig exactly like purgeConfirmedGiveUpRequeueCore's own matchesSig, agreeing with a genuine (declined) content match on the same hook instead of contradicting it; an unrelated confirmation still correctly reports no match; and the purge/requeue outcome (the archived entry, the still-queued duplicate) is unchanged by this diagnostic-only fix."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
