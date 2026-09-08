// Card 02e42746 — `submitCodex` (pty/host.ts) used to hand a large kickoff/message to the pty via ONE
// `live.pty.write(...)` call, unlike the claude path (`writeChunked`), which chunks large writes because a
// single large `pty.write` is TRUNCATED by Windows ConPTY's input buffer. Reading node-pty@1.1.0's own
// `terminal.js`/`windowsTerminal.js` shows `write()` -> `_write()` -> `this._agent.inSocket.write(data)` with
// no per-harness branching, and both `createPty` (claude) and `createCodexPty` spawn through the identical
// `IPty` — so the same truncation risk reaches codex's single write too. The fix: `submitCodex` now routes
// `text` through a new `writeChunkedCodex` helper (mirrors `writeChunked`, against `CodexLive` instead of
// `Live`) before the delayed Enter write.
//
// THIS TEST asserts the WRITE BEHAVIOUR itself — that a large payload arrives at the (fake) pty split into
// multiple bounded chunks that reassemble to the exact original text — not merely that a chunking helper was
// called. It also proves the Enter ("\r") always lands strictly after every text chunk, and exactly once.
//
// TECHNIQUE (mirrors `codex-submit-confirmation-gap.mjs`/`codex-queue-state-machine.mjs`): a fake
// `createCodexPty()` override drives the REAL `spawnCodexProcess`/`submitCodex`/`enqueueStdinCodex` code
// under a scripted fake pty — no real process, no real ConPTY. `LOOM_PTY_WRITE_CHUNK_BYTES` (small) and
// `LOOM_PTY_WRITE_CHUNK_DELAY_MS`/`LOOM_CODEX_SUBMIT_ENTER_DELAY_MS` (small) keep this fast and deterministic
// while still exercising the real chunk-boundary math (`surrogateSafeChunkEnd`) at a size a hermetic test can
// actually reach without a multi-KB fixture.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-submit-chunked-write.mjs
process.env.LOOM_PTY_WRITE_CHUNK_BYTES = "64"; // small chunk size so a few-hundred-char payload spans several chunks
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "1";
process.env.LOOM_CODEX_SUBMIT_ENTER_DELAY_MS = "5";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-chunked-write-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** Same fake, fully-scripted codex pty as the sibling codex fake-pty tests — no real process, no OS I/O;
 *  every "chunk" of output is pushed by this test calling `fakePty.push(text)` directly. */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  const writes = [];
  return {
    pid: 6161,
    write(data) { writes.push(data); },
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
    writes,
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy() {}, onExit() {}, onCodexSubmitUnconfirmed() {},
};
const host = new FakeCodexHost(events);

const SESSION_ID = "codex-chunked-write-test";
host.spawn({
  sessionId: SESSION_ID, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const fakePty = host.fakeCodexPtys.get(SESSION_ID);
const live = () => host.liveCodex.get(SESSION_ID);

// Get past boot-ready (mirrors the sibling fake-pty tests' own preamble) before any submitCodex call.
fakePty.push("OpenAI Codex (v1.2.3)\n│ model:     gpt-6-astra medium                          │\n›  Ask Codex to do anything\n");
await waitUntil(() => live().bootReady === true, { label: "(preamble) boot readiness latched" });
check("(preamble) nothing written by the boot-ready transition itself (empty queue)", fakePty.writes.length === 0);

// A large-ish, plain-ASCII payload (codexAsciiFold is a no-op on pure ASCII) with a distinguishing head and
// a distinguishing tail — if the write silently truncated the way the card describes, the tail marker would
// never arrive, exactly the "kickoff missing its DoD/fleet note/standing lines" failure mode the card names.
const HEAD_MARKER = "KICKOFF-HEAD-MARKER-";
const TAIL_MARKER = "-KICKOFF-TAIL-MARKER";
const bigText = HEAD_MARKER + "x".repeat(2000) + TAIL_MARKER; // several multiples of the 64-unit test chunk size

const enq = host.enqueueStdin(SESSION_ID, bigText, "system", undefined, undefined, "agent");
check("large payload delivers immediately (idle at enqueue time)", enq.delivered === true);
check("submitCodex armed busy synchronously", host.isBusy(SESSION_ID) === true);

await waitUntil(() => live().enterPending === false, { label: "the turn's own Enter write has actually happened" });

const textWrites = fakePty.writes.filter((w) => w !== "\r");
const enterWrites = fakePty.writes.filter((w) => w === "\r");

check("🔴 CORE ASSERTION: reassembled text is byte-identical to the original payload (nothing truncated, nothing duplicated)",
  textWrites.join("") === bigText);
check("the head marker survived", textWrites.join("").startsWith(HEAD_MARKER));
check("the tail marker survived (this is what a silent truncation would drop)", textWrites.join("").endsWith(TAIL_MARKER));

check("the write was actually CHUNKED, not one single write (proves writeChunkedCodex ran, not just codexAsciiFold)",
  textWrites.length > 1);
check("every individual chunk stayed at or under the configured chunk-size bound (64 units)",
  textWrites.every((w) => w.length <= 64));
check("chunk lengths sum exactly to the original payload length (no char lost or duplicated across the split)",
  textWrites.reduce((n, w) => n + w.length, 0) === bigText.length);

check("exactly one Enter (\"\\r\") was written for this turn", enterWrites.length === 1);
const lastTextWriteIdx = fakePty.writes.lastIndexOf(textWrites.at(-1));
const enterIdx = fakePty.writes.indexOf("\r");
check("the Enter landed strictly AFTER every text chunk (never interleaved ahead of the last one)",
  enterIdx > lastTextWriteIdx);

// A keystroke-sized write must still go in ONE chunk (no behavior change for the common small-message case
// — mirrors writeChunked's own documented invariant). Feed the busy marker so this turn settles cleanly,
// then send a small message and confirm it is NOT split.
fakePty.push("Working (1s • esc to interrupt)\n");
await waitUntil(() => host.isBusy(SESSION_ID) === false, { label: "the large turn settles idle once its marker is seen" });

const writesBeforeSmall = fakePty.writes.length;
const SMALL = "ok";
const enqSmall = host.enqueueStdin(SESSION_ID, SMALL, "system", undefined, undefined, "agent");
check("small payload delivers immediately (idle at enqueue time)", enqSmall.delivered === true);
await waitUntil(() => live().enterPending === false, { label: "the small turn's own Enter write has happened" });
const smallTextWrites = fakePty.writes.slice(writesBeforeSmall).filter((w) => w !== "\r");
check("a keystroke-sized write still goes in exactly ONE chunk (no behavior change for the common case)",
  smallTextWrites.length === 1 && smallTextWrites[0] === SMALL);

console.log(failures === 0
  ? "\n✅ ALL PASS — submitCodex now chunks a large write exactly like the claude path's writeChunked: byte-identical reassembly, bounded per-chunk size, and the Enter always lands after every chunk."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
