// Regression tests for card 844ca34e round 5 (Code Review round 4, b9ddeaa5) — the giveUpLineages release
// at UserPromptSubmit/Stop must gate on a POSITIVE CONTENT MATCH (reusing purgeConfirmedGiveUpRequeue's
// own normalized, wrapper-unwrapping machinery — 0658d6d8/7c1487c8), never the round-4 raw
// `hook.prompt !== live.lastPrompt` comparison, which is DEAD in production: a real echo carries the
// engine's own `<pasted_content>` composer wrap, so it never matches byte-for-byte and the release never
// fired for the wrapped case this card's own production specimens showed (191/253 byteIdentical=false,
// 180 of them exactly +58 — the wrapper's own overhead).
//
//   (1) THE FIX, THE POSITIVE CASE: a lineage gives up once, its Enter-only redelivery decisively confirms
//       via a hook whose `prompt` is the engine's own WRAPPED echo of the exact same body — content-
//       matches once unwrapped, and the lineage's giveUpLineages mark IS released. RED on cfb9b7ff (round
//       4): the raw comparison never equals the wrapped prompt, so the mark would stay forever.
//   (2) NEGATIVE CONTROL: identical setup, but the wrapped echo's INNER text is a DIFFERENT body — no
//       content match, the mark STAYS. Proves (1)'s release is about genuine content identity, not merely
//       "the hook carried a <pasted_content> wrapper".
//   (3) THE STOP-SITE FIX: identical setup to (1), but the confirming hook is Stop (no `prompt` field at
//       all — Stop/StopFailure structurally carries none). The mark STAYS marked: Stop can never prove a
//       positive content match, so it must never release. RED on cfb9b7ff (where the Stop-site release was
//       UNCONDITIONAL, with no content check whatsoever).
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-lineage-release-content-match.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-giveup-release-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 20;
const VERIFY_TIMEOUT = 150;
const MAX_ATTEMPTS = 2;
const HOLD_MS = 10;
const HOLD_WAIT = HOLD_MS + 20;
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
  await sharedWaitUntil(() => busyLog[sid]?.length > sinceLen && busyLog[sid]?.at(-1) === false,
    { timeoutMs: 10_000, intervalMs: 2, label });
}

// Builds the engine's own paste-composer wrap exactly as `PASTED_CONTENT_WRAP_RE` requires it (host.ts):
// `\n\n<pasted_content id="ID">\n<inner>\n</pasted_content id="ID">\n` — same helper
// pty-giveup-pasted-content-wrap-confirm.mjs uses.
const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

/** Drives a fresh message through ONE give-up cycle, then its own Enter-only redelivery — the SAME
 *  scaffold pty-giveup-round3-minors.mjs's MINOR 4b uses — leaving `composerDirtyLenClearedByGen` set to
 *  the redelivery's own fresh generation and the lineage marked in `giveUpLineages`, ready for a
 *  confirming hook to decide whether to release it. */
async function setupGiveUpThenRedeliver(host, SID, TEXT) {
  let lenBefore = busyLog[SID]?.length ?? 0;
  const r = host.enqueueStdin(SID, TEXT, "system", undefined, undefined, "agent");
  if (!r.delivered) throw new Error("setup: not delivered immediately");
  await waitForBusyFalseAfter(SID, lenBefore, "setup: own give-up");
  const logicalId = host.getPendingEntries(SID)[0]?.id;
  if (logicalId === undefined) throw new Error("setup: no pending entry after give-up");

  await sleep(HOLD_WAIT);
  lenBefore = busyLog[SID].length;
  host.reconcile();
  await waitForBusyFalseAfter(SID, lenBefore, "setup: Enter-only redelivery settles");
  return logicalId;
}

try {
  // ===== (1) THE FIX: a wrapped echo of the OWNER'S own body releases the mark =====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-release-wrapped-match";
    const TEXT_Z = "RELEASE_WRAPPED_MATCH_Z_GIVES_UP_THEN_IS_CONFIRMED_VIA_A_WRAPPED_ECHO_ZZZZZZ";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const zLogicalId = await setupGiveUpThenRedeliver(host, SID, TEXT_Z);
    check("(1) setup: Z is marked after its own give-up", live.giveUpLineages.has(zLogicalId));

    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: pastedContentWrap("w1", TEXT_Z) });

    check("(1) THE FIX, THE ASSERTION THAT GOES RED ON cfb9b7ff: a WRAPPED echo of Z's own exact body "
      + "content-matches once unwrapped, and Z's giveUpLineages mark IS released",
      !live.giveUpLineages.has(zLogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (2) NEGATIVE CONTROL: a wrapped echo of DIFFERENT content never releases =====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-release-wrapped-mismatch";
    const TEXT_Z = "RELEASE_WRAPPED_MISMATCH_Z_GIVES_UP_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const zLogicalId = await setupGiveUpThenRedeliver(host, SID, TEXT_Z);
    check("(2) setup: Z is marked after its own give-up", live.giveUpLineages.has(zLogicalId));

    // Wraps a GENUINELY DIFFERENT body — proves (1)'s release is about content identity, not merely the
    // presence of a <pasted_content> wrapper.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: pastedContentWrap("w2", "SOME_COMPLETELY_UNRELATED_BODY") });

    check("(2) NEGATIVE CONTROL: a wrapped echo of UNRELATED content does NOT content-match — Z's mark "
      + "STAYS",
      live.giveUpLineages.has(zLogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }

  // ===== (3) THE STOP-SITE FIX: Stop/StopFailure can never release (no prompt field at all) =====
  {
    const host = new TestPtyHost(events);
    const SID = "sess-release-stop-never";
    const TEXT_Z = "RELEASE_STOP_NEVER_Z_GIVES_UP_THEN_STOP_FIRES_WITH_NO_PROMPT_ZZZZZZZZZZZZZZZZ";
    spawnReady(host, SID);
    const live = host.live.get(SID);

    const zLogicalId = await setupGiveUpThenRedeliver(host, SID, TEXT_Z);
    check("(3) setup: Z is marked after its own give-up", live.giveUpLineages.has(zLogicalId));

    // A genuine Stop/StopFailure hook carries NO `prompt` field at all — structurally incapable of
    // proving a positive content match (see purgeConfirmedGiveUpRequeueCore's own doc).
    host.deliverHook(SID, { hook_event_name: "Stop" });

    check("(3) THE FIX, THE ASSERTION THAT GOES RED ON cfb9b7ff (where the Stop-site release was "
      + "UNCONDITIONAL): Stop can never content-match, so Z's giveUpLineages mark STAYS marked",
      live.giveUpLineages.has(zLogicalId));

    try { host.stop(SID, "hard"); } catch { /* ignore */ }
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 5: the giveUpLineages release at UserPromptSubmit now gates on a "
    + "POSITIVE CONTENT MATCH (reusing purgeConfirmedGiveUpRequeue's own wrapper-unwrapping machinery), "
    + "releasing a wrapped echo of the owner's own body (1) but never an unrelated wrapped body (2); and "
    + "the Stop/StopFailure site — which structurally never carries a `prompt` field — never releases at "
    + "all (3), closing the round-4 gap where it released unconditionally."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
