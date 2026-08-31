// Regression test for card 099f3560 — `requeueGiveUpOrigin`'s `joinSubmittedText(origin, gen - 1)` had
// ZERO regression coverage: a Code Reviewer (card 40b41fef, on 4af5aefa's branch) mutated `dist` to use
// `gen` instead of `gen - 1` and re-ran the suite — the entire give-up test family, including the new
// coalesced-content-match block, still reported ALL PASS. Cited grep at the time:
//   grep -rn "mintedAtGen" packages/daemon/test/  ->  0 hits
//
// WHY `gen - 1` IS CORRECT (do NOT "simplify" it to `gen` — that is the exact mutation this test guards
// against): `submit()` does `const gen = ++live.submitGeneration` — the POST-increment value threaded
// through the whole retry chain (fireEnterAndVerify) and captured by healIfStuck's own out-of-band bump.
// But the text that was ACTUALLY WRITTEN was assembled by `drainPending`/`enqueueStdin`'s immediate path
// via `joinSubmittedText(drained, live.submitGeneration)` BEFORE that increment — i.e. at `gen - 1`. When
// `requeueGiveUpOrigin` reconstructs the failing attempt's text to seed `Live.ambiguousDispatches`, it
// must reproduce THAT SAME pre-increment generation, or a message carrying a paste-recovery age
// annotation (`annotatePasteRecoveryAge`, card 4af5aefa) gets a DIFFERENT annotation baked into the
// reconstructed signature than what the engine actually echoes back. The failure is SILENT: content
// matching just stops firing for that message and nothing goes red — exactly the "seeded from pristine,
// not from what was written" class `78e4b3f2`/`8be92f3f` already fixed once for the possible-duplicate tag.
//
// THE DISCRIMINATING SHAPE: pick `mintedAtGen` to sit EXACTLY at the boundary
// `annotatePasteRecoveryAge`'s own guard checks (`currentGen <= mintedAtGen` => no annotation yet). With
// `gen - 1` (correct), the reconstructed `currentGen` equals the generation the text was ACTUALLY
// assembled under, landing exactly ON that boundary -> UNANNOTATED, matching the real write byte-for-byte.
// With the `gen` mutation, the reconstructed `currentGen` is one PAST that boundary -> ANNOTATED — a
// wholly different string. So the byte-exact content-match mechanism (`purgeConfirmedGiveUpRequeue`) either
// resolves (correct code) or silently never resolves again (mutated code) for the exact same engine echo.
//
// Covers BOTH call sites (card 099f3560 DoD-3), which reach the same `gen -> gen - 1` relation differently:
//   (A) fireEnterAndVerify's own GIVE-UP RECOVERY branch — passes submit()'s own captured `gen` straight
//       through (verified at `host.ts` around the `GIVE-UP RECOVERY after ${attempt} Enter attempts` log).
//   (B) healIfStuck's out-of-band busy-stuck path — captures `gen = live.submitGeneration` BEFORE ITS OWN
//       `live.submitGeneration++` bump, which (verified in source) lands on the SAME value submit() itself
//       captured for that turn — reached via an entirely different code path than (A).
//
// MUTATION-VERIFIED (card 099f3560 DoD-1): this file was run once with `host.ts`'s
// `joinSubmittedText(origin, gen - 1)` hand-edited to `joinSubmittedText(origin, gen)` (rebuilt, both
// scenarios' final "THE CHECK" assertions went RED — the CONFIRMED/content-matched log never fired, the
// message stayed stuck in `pending`), then reverted and re-run GREEN. See the worker's `worker_report` for
// the raw command + output of both runs.
//
// RUN (no daemon needed): node test/pty-giveup-mintedatgen-signature.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card ba4eebc1: the local `waitUntil(predicate, timeoutMs = 10_000)` poll loop that used to sit here was
// deleted — canonical-compatible (throw-on-timeout, positional predicate + timeout), so the call below now
// goes straight to the shared `_wait.mjs` helper with an explicit options object (same timeoutMs:10_000/
// intervalMs:2 this file's own defaults used — values unchanged).
async function sleepUntil(t0, targetMs) {
  const remaining = targetMs - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);
}

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
console.warn = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleWarn(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-giveup-mintedatgen-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Shared by both scenarios below (module-level constants in host.ts, read once at import) — small values
// so both the SUBMIT_MAX_ATTEMPTS-exhaustion give-up (A) and the timed false-suppress (B) run fast.
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const SETTLE_BOUND = SETTLE_POLL * SETTLE_MAX_POLLS;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "5000";
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
const writeAt = (k) => ENTER_DELAY + (k - 1) * VERIFY_TIMEOUT + (k === MAX_ATTEMPTS && k > 1 ? SETTLE_BOUND : 0);
const giveUpAt = () => writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { PASTE_RECOVERY_TAG } = await import("../dist/orchestration/paste-tripwire.js");

// Reconstructs exactly what `annotatePasteRecoveryAge` (host.ts) produces — used ONLY to build the
// deliberately-WRONG candidate text a RED-FIRST check probes with (the shape the `gen` mutation would
// have actually written into `Live.ambiguousDispatches`), never as a stand-in for calling the real
// function (which is unexported/private — this test drives the real code exclusively through the public
// PtyHost surface; this helper only predicts a string to feed back in as a hook's reported prompt).
function annotatedVariant(tag, rest, mintedAtGen, currentGen, mintedAtWallClock) {
  const gensSince = currentGen - mintedAtGen;
  const sentAt = ` Originally sent at ${new Date(mintedAtWallClock).toISOString()}.`;
  const note = `[this refers to an EARLIER message (${gensSince} submit generation${gensSince === 1 ? "" : "s"} ago), not your most recent one.${sentAt}]`;
  return `${tag} ${note} ${rest}`;
}

// ============================================================================================================
// (A) requeueGiveUpOrigin reached via fireEnterAndVerify's own GIVE-UP RECOVERY branch (SUBMIT_MAX_ATTEMPTS
//     exhausted against a silent fake pty that never emits output — a genuine drop, no suppression).
// ============================================================================================================
{
  const fakes = [];
  const busyLog = {};
  const eventsA = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
  class SilentTestPtyHost extends createSeamHost(PtyHost) {
    createPty(opts) {
      const base = super.createPty(opts);
      const writes = [];
      const fake = { ...base, write: (d) => { writes.push(d); }, writes };
      fakes.push(fake);
      return fake;
    }
  }
  const host = new SilentTestPtyHost(eventsA);
  const SID = "sess-mintedatgen-fireenter";
  const REST = "the original body text";
  const RECOVERY_TEXT = `${PASTE_RECOVERY_TAG} ${REST}`;

  try {
    host.spawn({ sessionId: SID, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(SID, { hook_event_name: "SessionStart" });

    // ===== SETUP: kickstart (gen 1), confirm cleanly but do NOT end the turn yet (Stop still pending) =====
    host.enqueueStdin(SID, "KICKSTART_TURN", "system", undefined, undefined, "agent");
    check("(A setup) kickstart delivered immediately, busy armed", busyLog[SID]?.at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "KICKSTART_TURN" });

    // At this instant live.submitGeneration === 1 (kickstart's own gen, untouched since). Enqueue the
    // paste-recovery notice WHILE BUSY (held) with mintedAtGen === that same value — the "no generations
    // have passed since mint" boundary, so the eventual real write must come out UNANNOTATED.
    const MINTED_AT_GEN = 1;
    const MINTED_AT_WALLCLOCK = Date.now();
    const rRec = host.enqueueStdin(SID, RECOVERY_TEXT, "system", undefined, undefined, "warning", undefined, undefined, undefined, undefined, { mintedAtGen: MINTED_AT_GEN, mintedAtWallClock: MINTED_AT_WALLCLOCK });
    check("(A setup) recovery notice HELD (busy) — queued to drain as kickstart's Stop fires", rRec.delivered === false);

    // ===== End the kickstart turn — drainPending writes the recovery notice as its OWN turn (gen 2) =====
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A setup) the recovery notice's own turn went out (busy re-armed)", busyLog[SID]?.at(-1) === true);
    const written = fakes.at(-1).writes.join("");
    check("(A setup) the ACTUAL write is byte-identical to the pristine text — no annotation baked in yet (currentGen === mintedAtGen at write time)", written.includes(RECOVERY_TEXT));

    // ===== Let this generation (gen 2) genuinely give up — the silent pty never emits output =====
    await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000, intervalMs: 2 });
    check("(A) the recovery notice's generation genuinely gave up (GIVE-UP RECOVERY fired)", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after")));
    check("(A setup) the recovery notice is requeued, sitting ambiguous", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

    // ===== Intervening fresh, unrelated, non-ambiguous generation (gen 3) — disables the content-BLIND =====
    // ===== FIFO-position fallback, so ONLY a genuine content match can resolve gen 2 from here on ==========
    const r3 = host.enqueueStdin(SID, "HEALTHY_UNRELATED_GEN_3", "system", undefined, undefined, "agent");
    check("(A setup) gen 3 delivered, busy armed", r3.delivered === true && busyLog[SID]?.at(-1) === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "HEALTHY_UNRELATED_GEN_3" });
    check("(A setup) gen 3 confirmed, current and unrelated — the recovery notice still sits unresolved", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

    // ===== (1) RED-FIRST: the ANNOTATED variant a `gen` (not `gen - 1`) mutation would have reconstructed =====
    // ===== must NOT content-match — proves the mechanism isn't loose enough to match ANY superset text ======
    submitLog.length = 0;
    const wrongCandidate = annotatedVariant(PASTE_RECOVERY_TAG, REST, MINTED_AT_GEN, /* mutated gen */ 2, MINTED_AT_WALLCLOCK);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: wrongCandidate });
    check("(A.1) RED-FIRST: the mutation-shaped (annotated) candidate does NOT content-match", !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(A.1) RED-FIRST: the recovery notice is still unresolved", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

    // ===== (2) THE CHECK — this is the assertion that flips RED under the `gen - 1` -> `gen` mutation: =====
    // ===== matching against the text ACTUALLY WRITTEN (pristine, unannotated) resolves it ==================
    submitLog.length = 0;
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: RECOVERY_TEXT });
    check("(A.2) THE CHECK: the ACTUAL written text content-matches and resolves the give-up", submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
    check("(A.2) THE CHECK: the recovery notice is purged from pending", !host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  } finally {
    // nothing per-scenario to clean up — tmpHome is removed once, at the very end
  }
}

// ============================================================================================================
// (B) requeueGiveUpOrigin reached via healIfStuck's out-of-band busy-stuck path (a FALSE-SUPPRESS forced
//     deterministically via a synthetic post-Enter output chunk — mirrors pty-healifstuck-clear.mjs).
// ============================================================================================================
{
  const fakes = [];
  const busyLog = {};
  const eventsB = { onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
  class EmitDataTestPtyHost extends createSeamHost(PtyHost) {
    createPty(opts) {
      const base = super.createPty(opts);
      const writes = [];
      let onDataCb = null;
      const fake = {
        ...base,
        write: (d) => { writes.push(d); },
        onData: (cb) => { onDataCb = cb; return { dispose() {} }; },
        writes,
        emitData: (d) => { if (onDataCb) onDataCb(d); },
      };
      fakes.push(fake);
      return fake;
    }
  }
  const BUSY_STALE_MS = 500; // small override for the SECOND-turn (busySince) heal path, via constructor opt
  const host = new EmitDataTestPtyHost(eventsB, { busyStaleMs: BUSY_STALE_MS });
  const SID = "sess-mintedatgen-healifstuck";
  const REST = "the second-turn stranded body text";
  const RECOVERY_TEXT = `${PASTE_RECOVERY_TAG} ${REST}`;

  host.spawn({ sessionId: SID, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];

  // ===== Turn 1: confirm+end normally so firstTurnStarted flips true (healIfStuck now uses the =====
  // ===== constructor-injected busyStaleMs above, not FIRST_TURN_STALE_MS, for the rest of this session ====
  const r1 = host.enqueueStdin(SID, "FIRST_TURN_CONFIRMED_NORMALLY");
  check("(B setup) turn 1 delivered", r1.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(B setup) turn 1 confirmed+ended normally", busyLog[SID]?.at(-1) === false);

  // At this instant live.submitGeneration === 1 (turn 1's own gen, untouched since). Enqueue the
  // paste-recovery notice as turn 2's ENTIRE content (delivered immediately — session is idle) with
  // mintedAtGen === that same value, same boundary reasoning as scenario (A).
  const MINTED_AT_GEN = 1;
  const MINTED_AT_WALLCLOCK = Date.now();
  const t0 = Date.now();
  const r2 = host.enqueueStdin(SID, RECOVERY_TEXT, "system", undefined, undefined, "warning", undefined, undefined, undefined, undefined, { mintedAtGen: MINTED_AT_GEN, mintedAtWallClock: MINTED_AT_WALLCLOCK });
  check("(B setup) turn 2 (the recovery notice) delivered, busy armed", r2.delivered === true && busyLog[SID]?.at(-1) === true);
  const written2 = fake.writes.join("");
  check("(B setup) the ACTUAL write is byte-identical to the pristine text — no annotation baked in yet", written2.includes(RECOVERY_TEXT));

  // ===== Force the false-suppress: synthesize engine output shortly after the FINAL Enter write, but =====
  // ===== before that attempt's own verify-timeout elapses — lastOutputAt > enterWrittenAt, WITHOUT any ====
  // ===== turn ever actually confirming (identical mechanic to pty-healifstuck-clear.mjs scenario 1/2) =====
  await sleepUntil(t0, writeAt(MAX_ATTEMPTS) + VERIFY_TIMEOUT / 3);
  fake.emitData("\x1b[<u\x1b[>1u\x1b[>4;2m");
  await sleepUntil(t0, giveUpAt() + VERIFY_TIMEOUT / 2);
  check("(B) GIVE-UP SUPPRESSED: busy is still true past the normal give-up point (suppression fired, not a genuine drop)", busyLog[SID]?.at(-1) === true);

  // ===== Let healIfStuck's stale-busy window (busyStaleMs, small override) elapse, then drive the heal =====
  // ===== directly — this is the OTHER requeueGiveUpOrigin call site, reached via a completely different ====
  // ===== path than scenario (A)'s SUBMIT_MAX_ATTEMPTS exhaustion =============================================
  await sleepUntil(t0, giveUpAt() + BUSY_STALE_MS + BUSY_STALE_MS / 2);
  host.reconcile();
  check("(B) healIfStuck's give-up restore fired (the OTHER requeueGiveUpOrigin call site)", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY: re-queued")));
  check("(B setup) the recovery notice is requeued, sitting ambiguous", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

  // ===== Intervening fresh, unrelated, non-ambiguous generation — disables the FIFO-position fallback =====
  const r4 = host.enqueueStdin(SID, "HEALTHY_UNRELATED_GEN_4", "system", undefined, undefined, "agent");
  check("(B setup) the unrelated generation delivered, busy armed", r4.delivered === true && busyLog[SID]?.at(-1) === true);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "HEALTHY_UNRELATED_GEN_4" });
  check("(B setup) the unrelated generation confirmed, current — the recovery notice still sits unresolved", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

  // ===== (1) RED-FIRST: the ANNOTATED variant a `gen` (not `gen - 1`) mutation would have reconstructed =====
  submitLog.length = 0;
  const wrongCandidate = annotatedVariant(PASTE_RECOVERY_TAG, REST, MINTED_AT_GEN, /* mutated gen */ 2, MINTED_AT_WALLCLOCK);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: wrongCandidate });
  check("(B.1) RED-FIRST: the mutation-shaped (annotated) candidate does NOT content-match", !submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(B.1) RED-FIRST: the recovery notice is still unresolved", host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

  // ===== (2) THE CHECK — flips RED under the `gen - 1` -> `gen` mutation, via THIS call site =====
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: RECOVERY_TEXT });
  check("(B.2) THE CHECK: the ACTUAL written text content-matches and resolves the give-up (healIfStuck path)", submitLog.some((l) => l.includes("CONFIRMED logicalId=") && l.includes("content-matched")));
  check("(B.2) THE CHECK: the recovery notice is purged from pending", !host.getPendingEntries(SID).some((m) => m.text === RECOVERY_TEXT));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — requeueGiveUpOrigin's `gen - 1` reconstructs the paste-recovery age annotation exactly as it was ACTUALLY written (not the post-increment `gen`), for both call sites (fireEnterAndVerify's own give-up branch and healIfStuck's out-of-band path), so a genuine confirming hook's content match keeps firing instead of silently going dark."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
