// Hermetic regression test for card 3e76ecad — the manager-facing SUBMIT-ONLY/flush affordance
// (PtyHost.flushComposer / SessionService.flushWorkerComposer / MCP `worker_flush`).
//
// THE GAP THIS CLOSES (parent card b9b8f8db, DoD-3 carve-out): for a stranded composer — text already
// written but never submitted/confirmed — the correct remedy is to submit what is already there. A
// manager's only prior options were worker_message (APPENDS — compounding an already-oversized buffer)
// or worker_stop+respawn (DISCARDS whatever the worker had accumulated); neither is a submit.
// flushComposer is the third option: press Enter, write nothing new.
//
// Proves, against the REAL failure shape (a composer holding an unconfirmed payload after a genuine
// give-up — the SAME scenario pty-giveup-clear.mjs / pty-giveup-clear-single-attempt.mjs drive):
//   (1) NO-OP on a genuinely clean/empty composer (DoD-3) — {ok:false, reason:"composer-empty"}, and a
//       NEGATIVE CONTROL proving ZERO bytes were written to the pty (a broken "always try" implementation
//       would write here, and this positive-count assertion would catch it).
//   (2) GENUINELY NON-WRITING (DoD-1/DoD-2): once the composer IS stranded, flushComposer writes ONLY the
//       zero-body reassert pair + Enter — the stranded TEXT's own byte count in what's been written to the
//       pty is IDENTICAL before and after (still pasted exactly once, never re-typed) — and once a
//       confirming hook lands, `confirmed:true` is reported and composerDirtyLen clears through the SAME
//       gated path submit() itself uses (composerDirtyLenClearedByGen).
//   (3) HONEST FAILURE (DoD-4): when the Enter does NOT confirm (mirrors "fails to confirm exactly as it
//       did originally"), flushComposer reports confirmed:false rather than claiming success, and does NOT
//       double-count composerDirtyLen on its own internal give-up — the existing composerDirtyMarkedGens
//       guard (card a6c1d413's per-generation map, formerly a single composerDirtyMarkedForGen scalar)
//       applies to a manager-triggered flush exactly as it does to an automatic redelivery.
//
// RUN (no daemon needed): node test/worker-flush-composer.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-flushcomposer-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 733e1403 audit of this file's TWO `windowMs` sites (both feed `_timing-guard.mjs`, not a bare
// sleep): injection-tested by delaying every production verify-timeout `setTimeout` (host.ts's
// `sendEnterAndVerify`, the `ms === SUBMIT_VERIFY_TIMEOUT_MS` calls — here pinned to 150) by 8x, confirmed
// real and consequential by wall-clock (this file's own run: ~4.2s unmodified -> ~6.3s injected, matching
// the 4 give-up cycles across scenarios (2)/(3) each paying (1200-150)ms of extra delay).
// (1) Line ~163's `windowMs: 20` inside the positive control's own `observeOnce`: proven safe by
// construction — it observes a SYNCHRONOUS array push (`fakes[SID].writes.push(TEXT)`) the line above it,
// never a delayed callback, so it is not "at risk" in the sense this audit tests for at all.
// (2) Line ~170's real `assertNeverWithControl` (`windowMs: VERIFY_TIMEOUT + SETTLE_MAX_POLLS *
// SETTLE_POLL`, ~200ms unscaled — well short of the give-up chain's injected ~1200ms): proven safe under
// 8x anyway, because the checked invariant (the stranded body's byte count in the pty writes) cannot
// change on give-up regardless of when give-up fires — MAX_ATTEMPTS=1's give-up path only calls
// `setBusy(false)` + `requeueGiveUpOrigin`, no further pty write at all (confirmed directly by scenario
// (3)'s own assertion "the stranded body was still never re-pasted", exercised under this same file's real
// give-up path). Not converted (converting would be symmetry, not a fix — see 1aabf969's identical finding
// on codescape-health-probe.mjs).
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 1;
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;          // bound 50ms
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;  // bound 50ms
const HOLD_MS = 30_000;              // keep any requeued duplicate held, out of this test's own window
const FLUSH_POLL = 10;
const FLUSH_MAX_POLLS = 200;         // bound 2000ms — comfortably past this file's own shrunk ladder
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_FLUSH_CONFIRM_POLL_MS = String(FLUSH_POLL);
process.env.LOOM_FLUSH_CONFIRM_MAX_POLLS = String(FLUSH_MAX_POLLS);

// Card 259c15fa (see pty-giveup-clear.mjs's own doc): give-up's real completion is a chain of setTimeout
// hops that routinely overshoots a hand-computed sum — every wait below polls for the OBSERVED
// busy===false transition instead of a fixed sleep.
const GIVE_UP_POLL_MS = 10;
const GIVE_UP_POLL_TIMEOUT_MS = 10_000;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { pollUntil, assertNeverWithControl, observeOnce } = await import("./_timing-guard.mjs");

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

const fakes = {};
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes }; // never emits output — every give-up here is a GENUINE drop
    fakes[opts.sessionId] = fake;
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  // ===================== (1) NO-OP on a genuinely clean composer (DoD-3) ================================
  {
    const SID = "sess-flush-empty";
    spawnReady(SID);
    const before = fakes[SID].writes.length;
    const r = await host.flushComposer(SID);
    check("(1) fresh/never-submitted session: flushComposer reports composer-empty, not an attempt",
      r.ok === false && r.reason === "composer-empty");
    check("(1) NEGATIVE CONTROL: zero bytes written to the pty for a clean composer — no stray bare Enter",
      fakes[SID].writes.length === before);
  }

  // ===================== (2) THE REAL FAILURE SHAPE: a composer stranded by a genuine give-up — =========
  // ===================== flushComposer writes NOTHING but the reassert+Enter, and honestly reports =======
  // ===================== confirmed:true once a confirming hook actually lands (DoD-1/DoD-2) ==============
  {
    const SID = "sess-flush-confirms";
    const TEXT = "STRANDED_PAYLOAD_THAT_LATER_CONFIRMS";
    spawnReady(SID);
    const r0 = host.enqueueStdin(SID, TEXT);
    check("(2) setup: idle-submit delivered, busy armed", r0.delivered === true && busyLog[SID].at(-1) === true);

    // Wait for busy to have FALLEN — the give-up's own completion.
    {
      const t0 = Date.now();
      while (busyLog[SID].at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
    }
    check("(2) setup: GIVE-UP RECOVERY landed — busy fell back to false", busyLog[SID].at(-1) === false);
    check("(2) setup: composerDirtyLen marked dirty, exactly the stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);

    const writesBeforeFlush = fakes[SID].writes.length;
    const bodyCountBeforeFlush = fakes[SID].writes.join("").split(TEXT).length - 1;
    check("(2) sanity: the stranded body was pasted exactly once so far", bodyCountBeforeFlush === 1);

    // Call flushComposer WITHOUT awaiting yet — a confirming hook needs to arrive mid-flight to observe
    // confirmed:true, mirroring "a stranded turn just needed its Enter re-confirmed".
    const flushPromise = host.flushComposer(SID);

    // POSITIVE: wait for flushComposer's own writes to actually land (reassert pair, then Enter = 2 new
    // pty writes) before delivering the confirming hook — a real OBSERVED condition (pollUntil,
    // _timing-guard.mjs), not a guessed sleep length; an engine can only confirm a keystroke it actually
    // received.
    const landed = await pollUntil(() => fakes[SID].writes.length >= writesBeforeFlush + 2, { timeoutMs: 10_000 });
    check("(2) flushComposer's writes actually landed (reassert pair, then Enter)", landed);
    check("(2) the two entries ARE the reassert pair, then Enter, in order",
      fakes[SID].writes[writesBeforeFlush] === BRACKET_PASTE_START + BRACKET_PASTE_END &&
      fakes[SID].writes[writesBeforeFlush + 1] === "\r");

    // NEGATIVE, WITH A MANDATORY POSITIVE CONTROL (card 1addef27 / _timing-guard.mjs): a bare fixed wait
    // here would pass even against a flushComposer that wrote NOTHING at all, or one that quietly repastes
    // the body on a later tick. assertNeverWithControl REFUSES to run the real assertion until it has first
    // proven — on this exact check, via a genuine armed violation — that a real repaste WOULD be caught;
    // only then does it prove the real run never triggers it. THE BYTE-COUNT-UNCHANGED PROOF (DoD-2): the
    // stranded body's own byte count in what's been written to the pty is IDENTICAL before and after
    // flushComposer's write — still pasted exactly once.
    const bodyNeverRewritten = await assertNeverWithControl({
      label: "(2) THE PROOF: flushComposer never re-pastes the stranded body",
      check: () => fakes[SID].writes.join("").split(TEXT).length - 1 > bodyCountBeforeFlush,
      positiveControl: async () => {
        fakes[SID].writes.push(TEXT); // arm a genuine violation of the SAME invariant this checks
        const caught = await observeOnce({
          check: () => fakes[SID].writes.join("").split(TEXT).length - 1 > bodyCountBeforeFlush,
          windowMs: 20,
        });
        fakes[SID].writes.pop(); // undo the arm before the real run below
        return caught;
      },
      // Derived from this file's own shrunk ladder constants — long enough to cover a (buggy) extra retry
      // attempt firing, given MAX_ATTEMPTS=1's own verify-timeout + settle bounds.
      windowMs: VERIFY_TIMEOUT + SETTLE_MAX_POLLS * SETTLE_POLL,
    });
    check("(2) THE PROOF: the stranded body's byte count is UNCHANGED pre/post flushComposer (still pasted exactly once, never re-typed)",
      bodyNeverRewritten);

    // The confirming hook arrives — content-matches the stranded text, proving the composer's own Enter
    // (not a repaste) is what finally landed.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT });

    const result = await flushPromise;
    check("(2) flushComposer reports ok:true, confirmed:true once the hook lands",
      result.ok === true && result.confirmed === true);
    check("(2) composerDirtyLen clears to 0 through the SAME gated path submit() uses",
      host.getComposerDirtyLen(SID) === 0);
    // Card ac7884e3 — THE MARKED ARM: the confirming hook fired while flushComposer's own marker was
    // still live for this exact generation, so both the call's own return AND the sticky getter must
    // report attributable:true.
    check("(2) THE FIX: flushComposer's own return reports attributable:true (resolved within its own window)",
      result.attributable === true);
    const attr2 = host.getLastFlushAttribution(SID);
    check("(2) THE FIX: lastFlushAttribution records CONFIRMED-BY-FLUSH for this generation",
      attr2 != null && attr2.attributable === true && attr2.reason === "confirmed-while-flush-marker-live");
  }

  // ===================== (3) HONEST FAILURE (DoD-4): the Enter never confirms — flushComposer reports ====
  // ===================== confirmed:false, and does NOT double-count composerDirtyLen on its own give-up ==
  {
    const SID = "sess-flush-never-confirms";
    const TEXT = "STRANDED_PAYLOAD_THAT_NEVER_CONFIRMS";
    spawnReady(SID);
    const r0 = host.enqueueStdin(SID, TEXT);
    check("(3) setup: idle-submit delivered, busy armed", r0.delivered === true && busyLog[SID].at(-1) === true);

    {
      const t0 = Date.now();
      while (busyLog[SID].at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
    }
    check("(3) setup: GIVE-UP RECOVERY landed — busy fell back to false", busyLog[SID].at(-1) === false);
    check("(3) setup: composerDirtyLen marked dirty, exactly the stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);

    const busyLenBeforeFlush = busyLog[SID].length;
    const result = await host.flushComposer(SID); // no confirming hook ever delivered — the fake pty emits nothing
    check("(3) flushComposer honestly reports confirmed:false — a remedy TRIED, not guaranteed (DoD-4)",
      result.ok === true && result.confirmed === false);
    check("(3) flushComposer's own attempt also gave up — a further busy transition was observed",
      busyLog[SID].length > busyLenBeforeFlush && busyLog[SID].at(-1) === false);
    check("(3) composerDirtyLen is NOT double-counted on flushComposer's own give-up — still exactly the stranded length",
      host.getComposerDirtyLen(SID) === TEXT.length);
    check("(3) the stranded body was still never re-pasted",
      fakes[SID].writes.join("").split(TEXT).length - 1 === 1);
    // Card 29b3c396 (CR follow-up): THIS is exactly the false-positive shape a reviewer traced from the
    // diff — `stranded` above (host.ts) is satisfied by `composerDirtyLen > 0` alone, with `busy` already
    // false (matches the /orchestrate doctrine's own documented shape: a SUPPRESSED mark stuck non-zero
    // against an already-idle, healthy session) — so a bare `!busy` read at settle time would read
    // `recovered:true` here even though THIS call fixed nothing (busy was never true to begin with).
    // `recovered` is gated on a captured `wasBusy` precisely to keep this false.
    check("(3) recovered correctly reads NOT true — busy was ALREADY false before this flush, so this call "
      + "cannot claim credit for clearing it (state, not transition)",
      result.recovered !== true);
  }

  // ===================== (4) TRUE POSITIVE for `recovered` (CR follow-up, card 29b3c396): busy IS true =====
  // ===================== at flush time, and a genuine true->false transition happens during this call =====
  {
    const SID = "sess-flush-was-busy";
    const TEXT = "STRANDED_PAYLOAD_BUSY_AT_FLUSH_TIME";
    spawnReady(SID);
    const r0 = host.enqueueStdin(SID, TEXT);
    check("(4) setup: idle-submit delivered, busy armed", r0.delivered === true && busyLog[SID].at(-1) === true);

    // Call flushComposer WHILE busy is still true (no confirming hook is ever delivered in this SID) — this
    // call's own re-entered ladder (racing the original submit's own, still in flight) is what genuinely
    // clears busy; `recovered` must reflect that real transition.
    const result = await host.flushComposer(SID);
    check("(4) flushComposer honestly reports confirmed:false (no hook ever arrives)",
      result.ok === true && result.confirmed === false);
    check("(4) THE FIX: recovered:true — busy genuinely transitioned true->false during this call's own lifetime",
      result.recovered === true);
    check("(4) busy is in fact false now (the transition recovered claims actually happened)",
      busyLog[SID].at(-1) === false);
  }

  // ===================== (5) THE OTHER POLARITY (card ac7884e3): a flush marker that goes STALE because ===
  // ===================== its OWN targeted generation is superseded before ever confirming — must resolve ==
  // ===================== attributable:false, not be left silently ambiguous or wrongly credited to a ======
  // ===================== later, unrelated confirmation =======================================================
  {
    const SID = "sess-flush-marker-stale";
    const TEXT1 = "STRANDED_PAYLOAD_MARKER_GOES_STALE";
    const TEXT2 = "A_LATER_UNRELATED_MESSAGE";
    spawnReady(SID);
    const r0 = host.enqueueStdin(SID, TEXT1);
    check("(5) setup: idle-submit delivered, busy armed", r0.delivered === true && busyLog[SID].at(-1) === true);

    {
      const t0 = Date.now();
      // TIMING-GUARD-SAFE: this is the SAME observed-condition polling loop scenarios (2)/(3)/(4) above
      // use (card 259c15fa) — it polls for the OBSERVED busy===false transition, bounded by
      // GIVE_UP_POLL_TIMEOUT_MS, never a fixed sleep asserting completion; give-up's real completion is a
      // chain of setTimeout hops that routinely overshoots a hand-computed sum, which is exactly why this
      // polls the real signal instead of guessing a duration.
      while (busyLog[SID].at(-1) !== false && Date.now() - t0 < GIVE_UP_POLL_TIMEOUT_MS) await sleep(GIVE_UP_POLL_MS);
    }
    check("(5) setup: GIVE-UP RECOVERY landed — busy fell back to false", busyLog[SID].at(-1) === false);

    // flushComposer's own attempt for THIS (already-given-up) generation also never confirms — leaves its
    // marker outstanding (flushMarkerGen set, unresolved), exactly like scenario (3).
    const flushResult = await host.flushComposer(SID);
    check("(5) setup: flushComposer honestly reports confirmed:false, leaving its marker outstanding",
      flushResult.ok === true && flushResult.confirmed === false);
    check("(5) setup: no attribution has resolved yet — the marker is outstanding, not yet superseded",
      host.getLastFlushAttribution(SID) === null);

    // Something ELSE now bumps the generation: a fresh, unrelated message delivers as a new turn (the
    // idle-submit gate only checks THIS call's own giveUpHeldUntil, not whether anything else is pending —
    // see enqueueStdin's own gate), superseding the flush's own targeted generation before it ever got a
    // confirming hook of its own.
    const r1 = host.enqueueStdin(SID, TEXT2);
    check("(5) a fresh, unrelated message delivers as a NEW turn, superseding the flush's own target generation",
      r1.delivered === true);

    // Deliver a confirming hook for THIS new turn — this is what proves the OLD marker is now stale.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT2 });

    const attribution = host.getLastFlushAttribution(SID);
    check("(5) THE OTHER ARM: the stale marker resolves to attributable:false, reason "
      + "marker-superseded-before-confirm — a definitive verdict, not silent ambiguity, and not wrongly "
      + "credited to the new, unrelated confirmation",
      attribution != null && attribution.attributable === false && attribution.reason === "marker-superseded-before-confirm");
  }
} finally {
  for (const sid of ["sess-flush-empty", "sess-flush-confirms", "sess-flush-never-confirms", "sess-flush-was-busy", "sess-flush-marker-stale"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_flush (PtyHost.flushComposer) is a genuine no-op on a clean composer, writes " +
    "nothing but a zero-body reassert+Enter on a stranded one (never repasting the body), honestly reports " +
    "confirmed:false when the Enter doesn't land, and never double-counts composerDirtyLen on its own " +
    "internal give-up."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
