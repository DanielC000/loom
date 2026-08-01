// Regression test for card 78e4b3f2 — `PtyHost.purgeQueuedWorkerIdleNudges` must still recognize a
// `[loom:worker-idle]` / `[loom:worker-spawn-broken]` nudge once it carries a leading possible-duplicate
// tag, not just its own bare `[loom:*]` prefix.
//
// WHY THIS IS REACHABLE: both nudges are dispatched via `enqueueDurableMessage` (sessions/service.ts), so
// either can exhaust its in-session give-up budget and get RE-MINTED — `handleGiveUpExhausted`'s remint
// call frames the text with `[loom:possible-duplicate root:...]` AHEAD of the nudge's own prefix, at the
// moment the re-mint is CREATED (not merely once redelivered — see framePossibleDuplicate's own doc for
// why a cross-remint's tag is baked in immediately, unlike a plain in-session requeue). A re-minted
// `[loom:worker-spawn-broken]` nudge escaping this purge is not cosmetic: that notice's own advice
// (worker_stop + fresh worker_spawn) is destructive if acted on against a healthy worker — see project
// memory `worker-spawn-broken-notice-false-positive`.
//
// Constructed directly against PtyHost (not via a full give-up cycle — the give-up-family suite already
// covers HOW a message gets marked): this isolates the ONE thing in question — does the purge itself
// recognize a marked nudge.
//
// RUN (no daemon needed): node test/pty-giveup-marked-idle-nudge-purge.mjs
//   Requires the daemon built first (reads ../dist/pty/host.js): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-marked-idle-purge-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} };
  }
}
const host = new TestPtyHost({
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
});

const MGR = "mgr-marked-idle-purge";
const WKR = "wkr-marked-idle-purge";
host.spawn({
  sessionId: MGR, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
host.deliverHook(MGR, { hook_event_name: "SessionStart" });

try {
  // Hold the manager busy so a fresh enqueueStdin call QUEUES instead of delivering immediately — this is
  // what lets us construct a specific pending-queue shape to purge against. The freshly-spawned session is
  // still idle at this exact instant, so THIS call itself delivers immediately (goes straight out as a real
  // turn, never touching `pending`) — it's what ARMS busy for every enqueue after it, not itself an entry
  // to check against later.
  host.enqueueStdin(MGR, "[loom:test] keep-manager-busy", "system", undefined, undefined, "agent");
  check("setup: the busy-arming turn delivered immediately (not queued)", host.getPendingEntries(MGR).length === 0);

  const idleNudge = `[loom:worker-idle] worker ${WKR} has been idle for a while, awaiting your reply.`;
  const spawnBrokenNudge = `[loom:worker-spawn-broken] worker ${WKR}'s turn-1 kickoff could not be confirmed delivered.`;
  const unrelatedNudge = `[loom:worker-idle] worker some-other-worker-id has been idle for a while.`;

  // Each nudge is enqueued as it would ACTUALLY look after a real cross-remint (card 78e4b3f2) — tag
  // baked in ahead of the nudge's own `[loom:*]` prefix.
  const markedIdle = framePossibleDuplicate(idleNudge, "aaaaaaaa-fake-root-1");
  const markedSpawnBroken = framePossibleDuplicate(spawnBrokenNudge, "bbbbbbbb-fake-root-2");
  const markedUnrelated = framePossibleDuplicate(unrelatedNudge, "cccccccc-fake-root-3");

  check("setup: a marked idle nudge genuinely carries the tag ahead of its own prefix",
    markedIdle.startsWith("[loom:possible-duplicate root:") && !markedIdle.startsWith("[loom:worker-idle]"));

  host.enqueueStdin(MGR, markedIdle, "system", undefined, undefined, "warning");
  host.enqueueStdin(MGR, markedSpawnBroken, "system", undefined, undefined, "warning");
  host.enqueueStdin(MGR, markedUnrelated, "system", undefined, undefined, "warning");
  // A control case (positive control for "the purge only touches ITS worker"): an UNMARKED nudge for the
  // SAME worker must still be purged too (byte-identical to before this card — the fix is additive).
  const unmarkedIdle = `[loom:worker-idle] worker ${WKR} another unmarked one for the same worker.`;
  host.enqueueStdin(MGR, unmarkedIdle, "system", undefined, undefined, "warning");

  check("setup: 4 entries queued (busy manager holds them all)", host.getPendingEntries(MGR).length === 4);

  const removed = host.purgeQueuedWorkerIdleNudges(MGR, WKR);
  check("(1) THE FIX: the MARKED worker-idle nudge was purged", removed.some((m) => m.text === markedIdle));
  check("(1) THE FIX: the MARKED worker-spawn-broken nudge was purged", removed.some((m) => m.text === markedSpawnBroken));
  check("(2) UNCHANGED: the unmarked worker-idle nudge for the same worker is STILL purged (additive, not a regression)",
    removed.some((m) => m.text === unmarkedIdle));
  check("(2) exactly 3 entries were purged (the two marked ones + the one unmarked one for THIS worker)", removed.length === 3);

  const remaining = host.getPendingEntries(MGR);
  check("POSITIVE CONTROL: the marked nudge for a DIFFERENT worker SURVIVES — the purge is worker-scoped, not tag-blind",
    remaining.some((m) => m.text === markedUnrelated));
  check("sanity: nothing else survives (exactly the 1 expected entry remains)", remaining.length === 1);

  try { host.stop(MGR, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — purgeQueuedWorkerIdleNudges recognizes a possible-duplicate-tagged worker-idle/worker-spawn-broken nudge (card 78e4b3f2's marking feature does not defeat card 2e3a8e6f's staleness purge), stays worker-scoped, and the pre-existing unmarked-nudge purge is unregressed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
