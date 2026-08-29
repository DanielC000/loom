// Hermetic regression test for card ef78c885 — "don't stamp composerBodyWrittenForGen when no
// clear-prefix ran" (pty/host.ts submit()). Split from card 2a7f8040 (limb A, comment-only, closed) —
// this is limb B, the behaviour half.
//
// THE GAP (card body): both dirty branches in submit() are gated `live.composerLen === 0`. A submit at
// gen N with `composerDirtyLen = X > 0` while a human is typing at the worker's raw terminal
// (`composerLen > 0`) falls to the plain `else` — it skips the clear-prefix entirely (X is never
// cleared) yet still stamped `composerBodyWrittenForGen = gen`. That stamp is what lets gen N later
// acquire its OWN entry in `composerDirtyMarkedGens` (via its own give-up mark, or `healIfStuck`'s
// backstop — both gated on `composerBodyWrittenForGen === gen`), and once it has one, a subsequent
// DECISIVE (content-matched) confirmation for gen N resolves every `g <= N` in one shot — including X,
// which gen N's own write never attempted to clear. FALSE ZERO.
//
// REACHABILITY (real production path, not a test artifice): submit() itself has no composerLen gate —
// only its CALLERS do. `drainPending`/`enqueueStdin`'s immediate path both refuse to run while
// `deferForHumanDraft(live)` is true (composerLen>0) — see CLAUDE.md's "Preserve user draft" invariant.
// But `resumeAfterRateLimit`'s direct `submit(..., "rate-limit-replay")` call is one of the two
// documented DIRECT-WRITE BYPASSES (submit()'s own doc, card 1f74080a) that skip that gate entirely — a
// turn parked by a usage-cap kill can resume and hit the plain `else` branch while the human is mid-draft
// on the raw terminal, exactly this gap's precondition.
//
// SCENARIO:
//   1. A (gen1) genuinely gives up (RECOVERY — the fake pty below never emits output) while nothing is
//      dirty yet (composerDirtyLen was 0 at gen1's own dispatch, so gen1's plain-else stamp is correct
//      either way) — leaves composerDirtyLen=A.len, composerDirtyMarkedGens={1: A.len}, A held/requeued.
//   2. The human starts typing a raw draft at the worker's terminal (no Enter yet) — composerLen>0.
//   3. B (gen2), a DIFFERENT message queued earlier and killed by a usage-cap rate limit, resumes via
//      `resumeAfterRateLimit` — a direct submit() bypass, reachable with composerLen>0. composerDirtyLen
//      is still A.len>0, composerLen>0 -> the plain `else` branch: no clear-prefix, B's own body pasted.
//   4. The human finishes/clears their draft (Esc) — composerLen back to 0.
//   5. B (gen2) also genuinely gives up (RECOVERY) — its own give-up mark is gated on
//      `composerBodyWrittenForGen === gen`. Pre-fix that reads true (step 3's stamp) so gen2 acquires ITS
//      OWN entry in composerDirtyMarkedGens; post-fix it was never stamped, so this mark is skipped.
//   6. gen2's own DECISIVE (content-matched) confirmation arrives (`clearComposerDirtyOnConfirm`, driven
//      directly here — the same call `deliverHook`'s hook handlers make — to isolate this exact
//      resolution mechanism from hook plumbing/timing, mirroring
//      pty-composerdirtymarkedgens-per-generation.mjs's own direct-call pattern).
//
// THE ASSERTION THAT MATTERS (must go RED against pre-fix code): after step 6, composerDirtyLen must
// still read EXACTLY A's still-unresolved length — gen2's own decisive confirmation proves only that
// gen2's OWN text landed, never that gen2's write cleared A's stray text (it didn't attempt to). Pre-fix
// code wrongly reads 0 here (composerDirtyMarkedGens acquired an entry for gen2 that it should never
// have gotten, so the decisive resolve sweeps up gen1's entry too).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-composerlen-else-no-clear-stamp.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-composerlen-else-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 50;     // mirrors LOOM_SUBMIT_ENTER_DELAY_MS
const VERIFY_TIMEOUT = 600; // mirrors LOOM_SUBMIT_VERIFY_TIMEOUT_MS
const MAX_ATTEMPTS = 3;     // mirrors LOOM_SUBMIT_MAX_ATTEMPTS
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
// Pinned large — mirrors pty-composerdirtymarkedgens-per-generation.mjs: A's own requeued hold must
// still be outstanding (untouched by any background redrain) when this test finishes with it.
const HOLD_MS = 30_000;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default

const GIVE_UP_POLL_MS = 20;
const GIVE_UP_POLL_TIMEOUT_MS = 15_000;
// Card 259c15fa (see pty-giveup-clear.mjs's own doc): give-up's real completion is a chain of setTimeout
// hops that routinely overshoots a hand-computed sum — poll for the OBSERVED busy=false transition, keyed
// to a specific point in the log so a SECOND give-up on the same session can't match A's own stale entry.
async function waitForBusyFalseAfter(busyLog, sessionId, sinceLen, label) {
  await sharedWaitUntil(
    () => (busyLog[sessionId]?.length ?? 0) > sinceLen && busyLog[sessionId]?.at(-1) === false,
    { timeoutMs: GIVE_UP_POLL_TIMEOUT_MS, intervalMs: GIVE_UP_POLL_MS, label },
  );
}

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const fake = { ...base, write: () => {} }; // never emits output — every give-up here is a GENUINE drop
    fakes.push(fake);
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
  const SID = "sess-composerlen-else-no-clear";
  const TEXT_A = "MESSAGE_A_GIVES_UP_FIRST_LEAVES_COMPOSERDIRTYLEN_STRANDED_AAAAAAAAAAAAAAAAAAAA";
  const TEXT_B = "MESSAGE_B_RATE_LIMIT_REPLAY_WHILE_HUMAN_IS_MID_DRAFT_BBBBBBBBBBBBBBBBBBBBBBBBB";
  const HUMAN_DRAFT = "human is typing something unrelated at the raw terminal, no Enter yet";
  spawnReady(SID);
  const live = host.live.get(SID);

  // ===== 1) A (gen1) genuinely gives up — composerDirtyLen was 0 at ITS OWN dispatch, so its own stamp ===
  // ===== is correct either way; this just seeds a genuinely-stranded, still-unresolved contribution =====
  let sinceLen = busyLog[SID]?.length ?? 0;
  const rA = host.enqueueStdin(SID, TEXT_A);
  check("setup: A delivered immediately, busy armed", rA.delivered === true && busyLog[SID]?.at(-1) === true);
  await waitForBusyFalseAfter(busyLog, SID, sinceLen, "A's own give-up (RECOVERY)");
  check("setup: A's give-up marked composerDirtyLen exactly A's own length",
    host.getComposerDirtyLen(SID) === TEXT_A.length);
  check("setup: composerDirtyMarkedGens holds exactly {1: A.len}",
    live.composerDirtyMarkedGens.size === 1 && live.composerDirtyMarkedGens.get(1) === TEXT_A.length);
  check("setup: composerBodyWrittenForGen stamped 1 (correct — dirtyLen was 0 at gen1's own dispatch)",
    live.composerBodyWrittenForGen === 1);
  check("setup: A is requeued (held) — pending holds exactly A",
    host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_A);

  // ===== 2) The human starts typing a raw draft — composerLen>0, nothing submitted yet =====================
  host.writeStdin(SID, HUMAN_DRAFT);
  check("setup: composerLen is now >0 (human mid-draft)", live.composerLen === HUMAN_DRAFT.length);
  check("setup: A's requeued hold is untouched by the human's own typing (still pending, dirtyLen unchanged)",
    host.getPendingEntries(SID).length === 1 && host.getComposerDirtyLen(SID) === TEXT_A.length);

  // ===== 3) B (gen2), a DIFFERENT already-queued message, resumes via resumeAfterRateLimit — a direct ======
  // ===== submit() bypass (card 1f74080a) that does NOT check deferForHumanDraft/composerLen at all =========
  live.rateLimited = true;
  live.lastPrompt = TEXT_B;
  sinceLen = busyLog[SID]?.length ?? 0;
  const resumed = host.resumeAfterRateLimit(SID);
  check("THE SETUP: resumeAfterRateLimit fired a direct submit() while composerLen>0 and composerDirtyLen>0",
    resumed === true && busyLog[SID]?.at(-1) === true);
  check("THE GAP: composerDirtyLen is UNCHANGED by B's write — the plain else branch skipped the clear-prefix "
    + "entirely (composerLen>0), so A's stranded length is still there, untouched, in the accounting",
    host.getComposerDirtyLen(SID) === TEXT_A.length);
  check("THE BUG SITE, DIRECT: composerBodyWrittenForGen must NOT be stamped to gen2 — no clear-prefix ever "
    + "ran for gen2 (composerLen>0 skipped it), so gen2 must not acquire a stamp it never earned. This is "
    + "the exact assertion that goes RED against pre-fix code (which stamps it unconditionally)",
    live.composerBodyWrittenForGen === 1);

  // ===== 4) The human finishes/clears their raw draft (Esc) — composerLen back to 0 ========================
  host.writeStdin(SID, "\x1b");
  check("setup: composerLen is back to 0 (human cleared/finished their draft)", live.composerLen === 0);

  // ===== 5) B (gen2) also genuinely gives up — its own give-up mark is gated on `composerBodyWrittenForGen ==
  // ===== gen`, which is exactly the stamp under test =========================================================
  sinceLen = busyLog[SID]?.length ?? 0;
  await waitForBusyFalseAfter(busyLog, SID, sinceLen, "B's own give-up (RECOVERY)");
  check("setup: B's own give-up settled (busy false)", busyLog[SID]?.at(-1) === false);

  // ===== 6) gen2's own DECISIVE (content-matched) confirmation arrives — driven directly, isolating this ====
  // ===== exact resolution mechanism from hook plumbing/timing (mirrors the per-generation test's own =========
  // ===== direct-call pattern for the SAME private method) ====================================================
  host["clearComposerDirtyOnConfirm"](SID, live, 2, true);

  check("THE FIX — the assertion that MUST go RED against pre-fix code: gen2's own decisive confirmation "
    + "proves only that gen2's OWN text landed, never that gen2's write cleared A's stray text (it never "
    + "attempted to — the clear-prefix was skipped in step 3) — composerDirtyLen must still read EXACTLY "
    + "A's still-unresolved length, not 0",
    host.getComposerDirtyLen(SID) === TEXT_A.length);
  check("THE FIX: composerDirtyMarkedGens still carries gen1's own, never-actually-cleared entry",
    live.composerDirtyMarkedGens.has(1) && live.composerDirtyMarkedGens.get(1) === TEXT_A.length);
  check("THE FIX: A's requeued duplicate is still pending — it was never a confirmed give-up, so it must "
    + "not be silently purged by gen2's unrelated confirmation",
    host.getPendingEntries(SID).length === 1 && host.getPendingEntries(SID)[0].text === TEXT_A);
} finally {
  try { host.stop("sess-composerlen-else-no-clear", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the plain (no-clear-prefix) else branch in submit() no longer stamps "
    + "composerBodyWrittenForGen when composerDirtyLen>0: a generation that never attempted to clear an "
    + "earlier, still-stranded contribution can no longer acquire its own composerDirtyMarkedGens entry, "
    + "so its later decisive confirmation can never wrongly resolve that earlier, genuinely-unresolved mark."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
