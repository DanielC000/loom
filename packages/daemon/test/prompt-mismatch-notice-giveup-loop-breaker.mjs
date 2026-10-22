// Card 84a0b357 — the `intendedIsOwnMismatchNotice` loop-breaker (card 87d2dc95, pty/host.ts) recognizes a
// notice's own intended text only via a RAW `startsWith(<tag>)` test. When a `[loom:prompt-mismatch]`
// notice's own delivery gives up (GIVE-UP RECOVERY) and gets requeued, `annotatedMessageText`/
// `framePossibleDuplicate` PREPENDS `[loom:possible-duplicate root:…]` ahead of the notice's own tag before
// it becomes `live.lastPrompt` for the redelivery generation — so the raw `startsWith` check silently
// misses it, the loop-breaker never fires, and the redelivered notice can itself mismatch and mint a FRESH
// notice. Under a degraded-confirmation session (the observed case: post-crash-recovery, card 84a0b357's
// own session `e56c4e44`), that fresh notice can itself give up, get re-tagged, bypass the guard again, and
// so on — a self-sustaining loop of content-free notices.
//
// THE FIX: strip a leading possible-duplicate tag (`stripPossibleDuplicateFrame`) before testing `intended`
// against the three notice tags — same shape as the ALREADY-FIXED sibling at this chokepoint (card
// 78e4b3f2's `submittedText` strip, host.ts ~line 10285).
//
// This suite proves, against a fake pty that never emits output (so the notice's own give-up is a genuine
// drop, mirroring pty-giveup-hold-until-confirmed.mjs's own convention):
//   RED-FIRST: mint an ordinary `[loom:prompt-mismatch]` notice, let its own delivery give up and redrain
//   tagged `[loom:possible-duplicate root:…]`, then feed it a mismatching `UserPromptSubmit` for that
//   redelivery generation. Pre-fix this mints a SECOND notice (the loop). Post-fix it is recognized as the
//   notice's own redelivery and silently self-exempted — no second notice, ever.
//
// RUN (no daemon needed): node test/prompt-mismatch-notice-giveup-loop-breaker.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mismatch-notice-giveup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// Same shrink-to-fast-and-deterministic env-var set pty-giveup-hold-until-confirmed.mjs already
// establishes for this exact family of timing constant — read BEFORE host.js is imported (module-level
// `Number(process.env.X) || default` reads).
const ENTER_DELAY = 20;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 150; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 2;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 5;
const SETTLE_MAX_POLLS = 3;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 15;
const HOLD_MS = 300;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
// The notice itself only needs to give up ONCE to reach the redelivered/tagged state under test.
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakesById = new Map();
const busyLog = {};
const events = {
  onEngineSessionId() {},
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
  onPromptMismatchUnmatched() {},
};

/** A fake pty that never emits output — every give-up this drives is a genuine drop, never the
 *  false-negative/SUPPRESSED case (pty-giveup-false-negative.mjs's own job). */
class SilentTestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakesById.set(opts.sessionId, fake);
    return fake;
  }
}
const host = new SilentTestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = (predicate, timeoutMs = 10_000, intervalMs = 5) =>
  sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "prompt-mismatch-notice-giveup-loop-breaker: predicate" });

const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));
const BRACKET_PASTE_END_MARKER = "\x1b[201~";
const waitForChunkedWriteDone = (writesArr, fromIndex) =>
  sharedWaitUntil(() => writesArr.slice(fromIndex).join("").includes(BRACKET_PASTE_END_MARKER), { timeoutMs: 10_000, intervalMs: 5, label: "prompt-mismatch-notice-giveup-loop-breaker: chunked write" });

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

function captureLinesMatching(substr, fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes(substr)) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

try {
  const SID = newSession("giveup-loop-breaker");
  const fake = fakesById.get(SID);

  // ===== STEP 1: mint an ordinary [loom:prompt-mismatch] notice (gen=1's own mismatch) =====
  const intended1 = "the message this turn actually intended to submit, long enough to stay clearly above the small-bucket bound";
  const stranded1 = "completely unrelated content that shares nothing at all with what this turn intended to submit — a wholly different string";
  host.enqueueStdin(SID, intended1); // gen=1, live.lastPrompt = intended1
  check("setup: gen=1 delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: stranded1 }); // gen=1 mismatches -> mints a notice
  const enqueuedNotice = await waitUntil(() => hasPendingMismatchNotice(SID));
  check("setup: the ordinary mismatch notice actually enqueues", enqueuedNotice);
  check("setup: exactly one notice pending so far", host.getPendingEntries(SID).filter((e) => e.text.includes("[loom:prompt-mismatch]")).length === 1);

  // ===== STEP 2: drain the notice as its OWN turn (gen=2) by ending gen=1's turn =====
  const writesBeforeNoticeTurn = fake.writes.length;
  host.deliverHook(SID, { hook_event_name: "Stop" }); // ends gen=1's turn, drains the notice as gen=2
  check("setup: the notice's own turn (gen=2) is now in flight, busy armed", await waitUntil(() => busyLog[SID]?.at(-1) === true));
  await waitForChunkedWriteDone(fake.writes, writesBeforeNoticeTurn);
  check("setup: pending is empty once the notice itself was drained", host.getPendingEntries(SID).length === 0);

  // ===== STEP 3: let the notice's OWN delivery give up (no confirming hook ever arrives for gen=2) =====
  const gaveUp = await waitUntil(() => busyLog[SID]?.at(-1) === false);
  check("RED-SETUP: the notice's own gen=2 delivery genuinely gave up", gaveUp);
  const heldEntries = host.getPendingEntries(SID);
  check("RED-SETUP: the given-up notice was requeued, tagged giveUpGen, text still PRISTINE (untagged)",
    heldEntries.length === 1 && heldEntries[0].giveUpGen === 2 && heldEntries[0].text.includes("[loom:prompt-mismatch]") && !heldEntries[0].text.includes("[loom:possible-duplicate"));

  // ===== STEP 4: let the hold expire so it redrains — THIS time wrapped in the possible-duplicate tag =====
  // TIMING-GUARD-SAFE: non-gating-settle-pause — this sleep only lets the known-fixed GIVE_UP_HOLD_MS
  // precondition elapse before reconcile() is even allowed to act; the check() below is anchored to a
  // SEPARATE poll (waitUntil(() => busyLog...)), never to this sleep's own duration.
  await sleep(HOLD_MS + 100);
  host.reconcile();
  check("RED-SETUP: the redelivery (gen=3) is now in flight, busy re-armed", await waitUntil(() => busyLog[SID]?.at(-1) === true));
  // Card 844ca34e: a redelivery of an already-attempted message that the composer still physically holds
  // retries ONLY the Enter (no re-paste), so the PHYSICAL pty write never carries the full tagged text —
  // `live.lastPrompt` (read directly, same convention scenario 14 in pty-prompt-mismatch.mjs already uses
  // for `host.live.get(sid)`) is the chokepoint that is unconditionally set to the tagged text at every
  // submit() call (host.ts:11933, BEFORE the Enter-only-vs-repaste branch), regardless of which physical
  // write shape follows — so it, not the pty bytes, is what actually proves the setup reached the code
  // path under test.
  const intendedGen3 = host.live.get(SID)?.lastPrompt ?? "";
  const dupTagIdx = intendedGen3.indexOf("[loom:possible-duplicate root:");
  const noticeTagIdx = intendedGen3.indexOf("[loom:prompt-mismatch]");
  check("RED-SETUP: gen=3's own live.lastPrompt actually carries the possible-duplicate tag PREPENDED ahead of the notice's own tag — proves the setup reaches the exact code path under test",
    dupTagIdx === 0 && noticeTagIdx > dupTagIdx);

  // ===== THE ACTUAL TEST: feed gen=3 (the tagged redelivery) a mismatching UserPromptSubmit =====
  const stranded2 = "an entirely separate turn's worth of content that matches nothing of what gen 3 actually carried, deliberately unrelated";
  const pendingBeforeTest = host.getPendingEntries(SID).filter((e) => e.text.includes("[loom:prompt-mismatch]")).length;
  check("THE SAFETY CASE setup: no notice pending yet (gen=3's own entry has already been drained, not queued)", pendingBeforeTest === 0);

  const selfExemptLines = captureLinesMatching("[prompt-mismatch-notice-self-exempt]", () => {
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: stranded2 });
  });
  // The notice-minting side effect is scheduled via setTimeout(0) (host.ts @decision 0f9268cc) — one
  // macrotask tick is the known-sufficient, proven bound (same reasoning pty-prompt-mismatch.mjs's own
  // scenario 8/14 use for this exact shape; FIFO macrotask ordering guarantees anything scheduled by the
  // deliverHook call above has already run by the time this later-registered setTimeout(_, 0) resolves).
  // TIMING-GUARD-SAFE: sync-probe-no-macrotask.
  await new Promise((r) => setTimeout(r, 0));

  check("THE SAFETY CASE: no SECOND [loom:prompt-mismatch] notice was ever enqueued for the redelivery's own mismatch",
    host.getPendingEntries(SID).filter((e) => e.text.includes("[loom:prompt-mismatch]")).length === 0);
  check("THE SAFETY CASE: the loop-breaker's own self-exempt log line fired for gen=3 instead of minting a notice",
    selfExemptLines.length === 1 && /gen=3\b/.test(selfExemptLines[0] ?? ""));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
