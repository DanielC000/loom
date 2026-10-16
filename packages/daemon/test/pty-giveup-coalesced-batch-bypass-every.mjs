// Regression test for card 844ca34e round 4 MINOR ("the origin.some check for a coalesced batch is now
// .every, mirroring lineageEverGaveUp's own fa27d262 discipline" — host.ts ~11577,
// `bypassOwnershipGateOnce`). Round 4's own CR (b9ddeaa5) measured 32/32 passing with `.every` already in
// place, but no existing test actually constructs a COALESCED batch (>1 `origin` member) where only SOME
// members carry `bypassOwnershipGateOnce:true` — every existing bypass scenario
// (pty-giveup-resend-bypass-unsuppressed-park.mjs) exercises a single-message dispatch, where `.every`
// and `.some` are indistinguishable (both reduce to "does the one member have the flag").
//
// THE DISCRIMINATING SHAPE: a 2-member `origin` where ONE member carries `bypassOwnershipGateOnce:true`
// and the OTHER does not, with BOTH lineages already marked (`lineageEverGaveUp` true for the whole
// batch) and the composer owned by a genuinely UNRELATED lineage (ownership mismatch). Direct `submit()`
// call (same discipline as pty-giveup-round3-minors.mjs's own MINOR 5 direct-call pattern), isolating
// this exact branch decision from give-up/hold/timing plumbing.
//
//   `.every` (correct): NOT every member is flagged -> `bypassOwnershipGateOnce` is false -> the
//   ownership-mismatch check still runs, finds no match, and writes NOTHING (`giveUpWithoutWriting`).
//   `.some` (the bug this guards against): AT LEAST ONE member is flagged -> `bypassOwnershipGateOnce`
//   wrongly reads true -> the ownership-mismatch check is skipped entirely -> the batch's body is written
//   in full via the ordinary clear+repaste branch, even though the unflagged member never earned a bypass.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon,
//   pnpm build && node test/pty-giveup-coalesced-batch-bypass-every.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };

const tmpHome = path.join(os.tmpdir(), `loom-coalesced-bypass-every-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "150";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";

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

try {
  const host = new TestPtyHost(events);
  const SID = "sess-coalesced-bypass-every";
  const BODY_TEXT = "COALESCED_BATCH_BODY_MUST_NOT_LAND_WITHOUT_A_FULL_BYPASS_XXXXXXXXXXXXXXXXXXXX";
  const fake = spawnReady(host, SID);
  const live = host.live.get(SID);

  // Both members' lineages already gave up (lineageEverGaveUp must read true for the WHOLE batch).
  live.giveUpLineages.add("batch-flagged-member");
  live.giveUpLineages.add("batch-unflagged-member");
  check("(setup) both members are marked in giveUpLineages",
    live.giveUpLineages.has("batch-flagged-member") && live.giveUpLineages.has("batch-unflagged-member"));

  // The composer is dirty and owned by a genuinely UNRELATED lineage — neither batch member — so WITHOUT
  // a bypass this must hit the ownership-mismatch branch (no write at all).
  live.composerDirtyLen = 40;
  live.composerOwnerLineage = new Set(["some-other-unrelated-lineage"]);
  check("(setup) composer is dirty, owned by an UNRELATED lineage (neither batch member)",
    live.composerDirtyLen > 0 && live.composerLen === 0
    && !live.composerOwnerLineage.has("batch-flagged-member")
    && !live.composerOwnerLineage.has("batch-unflagged-member"));

  const coalescedOrigin = [
    { logicalId: "batch-flagged-member", id: "batch-flagged-member", text: BODY_TEXT, bypassOwnershipGateOnce: true },
    { logicalId: "batch-unflagged-member", id: "batch-unflagged-member", text: BODY_TEXT, bypassOwnershipGateOnce: false },
  ];

  const writesBefore = fake.writes.length;
  submitLog.length = 0;
  // THE CONTROLLED WRITE: a direct submit() call with a 2-member coalesced `origin`, mirroring
  // pty-giveup-round3-minors.mjs's own MINOR 5 direct-call pattern.
  host["submit"](SID, BODY_TEXT, undefined, undefined, undefined, undefined, "test-coalesced-bypass-every", coalescedOrigin);

  const burst = fake.writes.slice(writesBefore).join("");
  check("(THE FIX, THE ASSERTION THAT GOES RED WITH `.some` INSTEAD OF `.every`): the mixed batch (one "
    + "flagged member, one unflagged) got NO bypass at all — its body was NOT written, because the "
    + "unflagged member never earned one and `.every` requires the WHOLE batch to carry the flag",
    !burst.includes(BODY_TEXT));
  check("(sanity) the ownership-mismatch give-up fired instead (the real reason nothing was written, not "
    + "some unrelated no-op)",
    submitLog.some((l) => l.includes("GIVE-UP (composer ownership mismatch")));

  try { host.stop(SID, "hard"); } catch { /* ignore */ }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 844ca34e round 4: `bypassOwnershipGateOnce`'s coalesced-batch check uses `.every`, "
    + "not `.some` — a batch mixing one bypass-flagged member with one unflagged member gets NO bypass at "
    + "all, matching `lineageEverGaveUp`'s own fa27d262 discipline, instead of letting a single flagged "
    + "member smuggle the whole batch's body past the ownership-mismatch check."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
