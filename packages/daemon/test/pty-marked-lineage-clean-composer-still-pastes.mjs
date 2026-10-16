// Regression test for card 844ca34e round 2, ruling (d) (Code Review 8555d247): a lineage already marked
// in `Live.giveUpLineages` must still take a PLAIN FULL PASTE once the composer reads genuinely CLEAN
// (`composerDirtyLen === 0`) — `lineageEverGaveUp` is gated behind `composerDirtyLen > 0` in submit()'s
// branch decision, so a clean composer never even reaches the Enter-only/ownership-mismatch logic at all.
// This is the fall-through that PREVENTS LOSS: if a marked lineage were instead silently skipped (e.g. a
// bare Enter against an empty composer, submitting nothing), a genuinely fresh re-mint could vanish.
//
// This suite proves, against the REAL PtyHost, via a fake pty that echoes a GENUINE confirming hook for
// the first cycle (clearing composerDirtyLen back to a real, decisively-confirmed zero via
// purgeConfirmedGiveUpRequeue's content-matched CONFIRMED path — not a hand-set test seam) and then NEVER
// confirms the second cycle:
//   (1) a message gives up once (marked in giveUpLineages), then its own late confirming hook arrives and
//       content-matches, bringing composerDirtyLen back to a genuine, decisively-proven 0.
//   (2) a SECOND message, sharing the SAME logicalId (the re-mint shape), is submitted while the composer
//       reads clean. Despite its lineage already being marked, it takes the PLAIN branch and writes its
//       REAL BODY in full — never a silent Enter-only skip.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-marked-lineage-clean-composer-still-pastes.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-clean-composer-repaste-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_HOLD_MS = "200";
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
const busyLog = {};
const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); }, onContextStats() {}, onRateLimited() {}, onExit() {},
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
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  return fakes[fakes.length - 1];
}

try {
  const SID = "sess-clean-composer-repaste";
  const LID = "clean-composer-shared-lineage";
  const TEXT1 = "FIRST_CYCLE_BODY_ITS_OWN_LOGICALID_GETS_MARKED_AAAAAAAAAA";
  const fake = spawnReady(SID);

  // Cycle 1: plain paste (composer starts clean), explicit shared logicalId.
  let lenBefore = busyLog[SID]?.length ?? 0;
  const r1 = host.enqueueStdin(SID, TEXT1, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, undefined, undefined, LID);
  check("(1) setup: cycle 1 delivered immediately, busy armed", r1.delivered === true && busyLog[SID].at(-1) === true);
  await sharedWaitUntil(() => busyLog[SID]?.length > lenBefore && busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000 });
  check("(1) setup: cycle 1 gave up — composerDirtyLen marks the stranded body",
    host.getComposerDirtyLen(SID) === TEXT1.length);
  check("(1) setup: the lineage is now marked", host.getPendingEntries(SID).length === 1);

  // A GENUINE confirming hook arrives, content-matching cycle 1's own write — resolves via
  // purgeConfirmedGiveUpRequeue's real CONFIRMED path (never a hand-set test seam), decisively proving
  // the composer is now clean.
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: TEXT1 });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  await sharedWaitUntil(() => busyLog[SID]?.at(-1) === false, { timeoutMs: 10_000 });
  check("(1) THE SETUP'S OWN PRECONDITION: composerDirtyLen is back to a genuinely, decisively confirmed 0",
    host.getComposerDirtyLen(SID) === 0);
  check("(1) sanity: the re-queued entry was purged by the confirming match, not merely timed out",
    host.getPendingEntries(SID).length === 0);

  // Cycle 2: a DIFFERENT message object, sharing the SAME logicalId (the re-mint shape) — its lineage is
  // ALREADY marked in giveUpLineages from cycle 1. Submitted while the composer reads clean.
  const TEXT2 = framePossibleDuplicate("SECOND_CYCLE_BODY_SAME_LOGICALID_ALREADY_MARKED_BBBBBBBBBB", "root-for-test");
  const writesBefore = fake.writes.length;
  const r2 = host.enqueueStdin(SID, TEXT2, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, undefined, undefined, LID);
  check("(2) setup: cycle 2 delivered immediately (composer was clean, nothing held it)", r2.delivered === true);
  const burst = fake.writes.slice(writesBefore).join("");
  check("(2) THE FIX, RULING (d): a marked lineage (LID already in giveUpLineages from cycle 1) on a " +
    "genuinely CLEAN composer still takes the PLAIN FULL PASTE — its real body is written, not silently " +
    "skipped via a no-op Enter-only against nothing",
    burst.includes(TEXT2));
  check("(2) sanity: lineageEverGaveUp is never even consulted here — no backspace was written (nothing " +
    "to clear)",
    !burst.includes("\x7f"));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 2, ruling (d): submit()'s plain-paste branch is reached whenever " +
    "composerDirtyLen reads 0, REGARDLESS of whether this write's own lineage is already marked in " +
    "giveUpLineages — the ownership-mismatch check is gated behind composerDirtyLen>0 and is never even " +
    "consulted on a clean composer, so a marked lineage's later re-mint still lands in full instead of " +
    "being silently swallowed by a no-op Enter."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
