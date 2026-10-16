// Regression tests for card 844ca34e round 3's MINOR findings (Code Review round 2, 53d2adb2) — two
// independent, low-level `PtyHost` mechanics, each exercised directly against real production code
// (never mocked), each with its own RED/GREEN discriminating assertion. (MINOR 2 — the `wroteNothing`/
// `giveUpConfirmQueue` fix — lives in its own file, pty-giveup-round3-minor2-wrotenothing.mjs: it needs
// the OPPOSITE hold-timing discipline this file's MINOR 4b uses, and one process can't vary a
// module-load-time env var mid-run.)
//
//   MINOR 4 — `Live.giveUpLineages` is now a true LRU (a re-touched id moves to the most-recently-used
//   end, not just insertion order) and REMOVES an id at the moment its own composer ownership is
//   decisively confirmed (no longer a permanent, lifetime-of-Live mark).
//
//   MINOR 5 — the plain/fused `else` branch in `submit()` (card ef78c885's own composerLen>0 shape) marks
//   `composerOwnerLineage` UNKNOWN (null) when the write FUSES with still-stranded content
//   (`composerDirtyLen>0` at write time), never attributing the fused composer to the fresh write's own
//   lineage.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-round3-minors.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-r3-minors-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 10; // short — MINOR2/MINOR4b both need a requeued entry's hold to actually expire so a
const HOLD_WAIT = HOLD_MS + 20; // deliberate reconcile() redrains it (mirrors pty-giveup-marked-resend-autojoin.mjs)
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1"; // production default

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};

function spawnReady(host, sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

async function waitForBusyFalseAfter(sid, sinceLen, label) {
  await waitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, label });
}

try {
  // ============================== MINOR 4a: giveUpLineages is a true LRU =================================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-minor4a-lru";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    // Seed two distinct marked lineages directly (bypassing a full give-up cycle per entry — this is
    // purely about Set iteration/eviction order, not the give-up state machine itself).
    live.giveUpLineages.add("lineage-X");
    live.giveUpLineages.add("lineage-Y");
    check("(MINOR4a) setup: insertion order is [X, Y]", [...live.giveUpLineages].join(",") === "lineage-X,lineage-Y");

    // Re-touch X via the REAL production call site: dispatch a message whose logicalId is "lineage-X",
    // drive it to a genuine give-up, and let `requeueGiveUpOrigin` re-mark it.
    let lenBefore = busyLog[SID]?.length ?? 0;
    host.enqueueStdin(SID, "MINOR4A_RETOUCH_X", "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, { logicalId: "lineage-X" });
    await waitForBusyFalseAfter(SID, lenBefore, "(MINOR4a) X's re-touch give-up");

    check("(MINOR4a) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: re-touching X moved it to the "
      + "MOST-RECENTLY-USED end — iteration order is now [Y, X], not [X, Y] (plain insertion order, "
      + "which is what a bare `.add()` on an existing Set key would have left unchanged)",
      [...live.giveUpLineages].join(",") === "lineage-Y,lineage-X");

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ============================== MINOR 4b: a decisive confirm REMOVES the lineage ========================
  {
    const host = new TestPtyHost(events);
    const SID = "sess-minor4b-decisive-removal";
    const TEXT_Z = "MINOR4B_Z_GIVES_UP_THEN_IS_DECISIVELY_CONFIRMED_ZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    let lenBefore = busyLog[SID]?.length ?? 0;
    const rZ = host.enqueueStdin(SID, TEXT_Z, "system", undefined, undefined, "agent");
    check("(MINOR4b) setup: Z delivered immediately", rZ.delivered === true);
    await waitForBusyFalseAfter(SID, lenBefore, "(MINOR4b) Z's own give-up");
    const zLogicalId = host.getPendingEntries(SID)[0]?.id;
    check("(MINOR4b) setup: Z is marked (giveUpLineages carries its logicalId) and requeued",
      zLogicalId !== undefined && live.giveUpLineages.has(zLogicalId));

    // Z's redelivery: no intervening message ever took the composer, so Z stays its own sole owner —
    // Enter-only fires and writes nothing new; a genuine confirming hook (UserPromptSubmit) then
    // DECISIVELY resolves this generation (composerDirtyLenClearedByGen must match — set by the
    // clear-prefix branch on Z's VERY FIRST attempt, still valid since nothing else has written since).
    await sleep(HOLD_WAIT);
    lenBefore = busyLog[SID].length;
    host.reconcile();
    await waitForBusyFalseAfter(SID, lenBefore, "(MINOR4b) Z's redelivery (Enter-only) settles its own give-up cycle");

    // Drive a genuine decisive confirm directly (mirrors pty-composerlen-else-no-clear-stamp.mjs's own
    // direct-call pattern) — isolates this exact resolution mechanism from hook/timing plumbing.
    // Card 844ca34e round 5: the release now gates on a POSITIVE content match (reusing
    // purgeConfirmedGiveUpRequeue's own normalized machinery), so this hook must carry Z's own `prompt`
    // echo (every real UserPromptSubmit does — a bare hook with no prompt field at all, as this test used
    // to send, can never content-resolve anything and would leave the mark un-released).
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT_Z });

    check("(MINOR4b) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: once Z's composer ownership is "
      + "DECISIVELY confirmed clean, its logicalId is REMOVED from giveUpLineages — a resolved chain's "
      + "give-up mark no longer lives for the rest of this Live's lifetime",
      !live.giveUpLineages.has(zLogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ============================== MINOR 5: fused composer -> UNKNOWN owner, not the fresh write's own ====
  // Direct `submit()` call (same discipline as pty-composerlen-else-no-clear-stamp.mjs's own direct
  // `clearComposerDirtyOnConfirm` call) with a CONTROLLED non-empty `origin` — the production
  // `resumeAfterRateLimit` caller that reaches this exact branch in practice always passes `origin:
  // undefined`, which would make this assertion pass VACUOUSLY under either round 2 or round 3's code
  // (both read as null when origin is absent); a controlled origin is required to actually discriminate.
  {
    const host = new TestPtyHost(events);
    const SID = "sess-minor5-fused-owner";
    const TEXT_A = "MINOR5_A_GIVES_UP_FIRST_LEAVES_COMPOSERDIRTYLEN_STRANDED_AAAAAAAAAAAAAAAAAAAA";
    const TEXT_B = "MINOR5_B_FUSES_WHILE_HUMAN_IS_MID_DRAFT_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const HUMAN_DRAFT = "human is typing something unrelated at the raw terminal, no Enter yet";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    let lenBefore = busyLog[SID]?.length ?? 0;
    host.enqueueStdin(SID, TEXT_A, "system", undefined, undefined, "agent");
    await waitForBusyFalseAfter(SID, lenBefore, "(MINOR5) A's own give-up");
    check("(MINOR5) setup: A's give-up left composerDirtyLen stranded", host.getComposerDirtyLen(SID) === TEXT_A.length);

    host.writeStdin(SID, HUMAN_DRAFT);
    check("(MINOR5) setup: composerLen>0 (human mid-draft) — this is what routes B's write to the plain "
      + "`else` branch instead of the clear-prefix branch (both dirty branches gate on composerLen===0)",
      live.composerLen === HUMAN_DRAFT.length);

    // THE CONTROLLED WRITE: a direct submit() call with a real, non-empty `origin` — origin.length>0 so
    // `origin ? new Set(...) : null` would (pre-fix) resolve to B's OWN lineage, not null.
    const bOrigin = [{ logicalId: "minor5-b-logical", id: "minor5-b-logical", text: TEXT_B }];
    host["submit"](SID, TEXT_B, undefined, undefined, undefined, undefined, "test-direct-minor5", bOrigin);

    check("(MINOR5) THE FIX, THE ASSERTION THAT GOES RED WITHOUT IT: B's write FUSES with A's still-"
      + "stranded content (composerDirtyLen was >0 at write time) — composerOwnerLineage reads UNKNOWN "
      + "(null), never attributed to B's own lineage despite a real, non-empty origin",
      live.composerOwnerLineage === null);

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 3 MINORs 4/5: giveUpLineages is a true LRU and releases a "
    + "lineage once its own composer ownership is decisively confirmed; and a write that fuses with "
    + "still-stranded content"
    + "marks the composer's owner UNKNOWN rather than attributing it to the fresh write's own lineage."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
