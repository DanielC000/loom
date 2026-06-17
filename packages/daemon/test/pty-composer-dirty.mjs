// Claude-free regression guard for the COMPOSER-DIRTY delivery hold (pty/host.ts).
//
// THE BUG: the raw terminal (web/Terminal.tsx → writeStdin) writes straight into claude's TUI
// composer. A programmatic turn (worker report / nudge) delivered while the human has a half-typed
// raw draft was pasted ONTO that text — both messages mangled into one garbled submit. The old guard
// was only a 6s time-grace (humanActivelyTyping); once it lapsed, the queued turn still landed on the
// draft.
//
// THE FIX (this test locks it down): a per-session composer-dirty signal derived from the raw input
// bytes — set on a printable/editing keystroke, cleared by a box-freeing key (Enter/Ctrl-C/Esc/kill-
// line) or backspace-to-empty. Both drain paths (drainPending + enqueueStdin's immediate path) DEFER
// while dirty, and the box-free transition triggers a PROMPT drain. The human's bytes are NEVER
// touched. submit()'s write sequence + the M1 optimistic-busy invariant are unchanged.
//
// Exercises the real PtyHost state machine against a FAKE pty (createPty seam) — no real claude, no
// daemon, no network, no ~/.claude.json writes. Run: node test/pty-composer-dirty.mjs (after a build).
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()).
const tmpHome = path.join(os.tmpdir(), `loom-ptydirty-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, nextComposerLen } = await import("../dist/pty/host.js");

// ===================== PART A — nextComposerLen pure classification =====================
// The byte classifier the dirty signal is built on. Pure: no pty, no state.
const ESC = "\x1b";
check("nextComposerLen: printable adds one (0→1)", nextComposerLen(0, "a") === 1);
check("nextComposerLen: printable adds one (3→4)", nextComposerLen(3, "a") === 4);
check("nextComposerLen: multi-char chunk counts each", nextComposerLen(0, "hi") === 2);
check("nextComposerLen: backspace decrements (1→0)", nextComposerLen(1, "\x7f") === 0);
check("nextComposerLen: backspace floors at 0", nextComposerLen(0, "\x7f") === 0);
check("nextComposerLen: \\b also decrements", nextComposerLen(2, "\x08") === 1);
check("nextComposerLen: Enter frees the box → 0", nextComposerLen(5, "\r") === 0);
check("nextComposerLen: Ctrl-C frees the box → 0", nextComposerLen(5, "\x03") === 0);
check("nextComposerLen: lone Esc frees the box → 0", nextComposerLen(5, ESC) === 0);
check("nextComposerLen: Ctrl-U (kill line) frees the box → 0", nextComposerLen(5, "\x15") === 0);
// Navigation escape sequences are NOT freeing keys and add no draft length.
check("nextComposerLen: arrow key on EMPTY box stays 0 (not miscounted as printable)", nextComposerLen(0, "\x1b[D") === 0);
check("nextComposerLen: arrow key PRESERVES an existing draft (3→3)", nextComposerLen(3, "\x1b[D") === 3);
check("nextComposerLen: SS3 arrow (ESC O A) preserves draft", nextComposerLen(2, "\x1bOA") === 2);
// A bracketed paste's BODY counts; the \x1b[200~ / \x1b[201~ markers' param bytes do not.
check("nextComposerLen: bracketed-paste body counts, markers don't (0→5)", nextComposerLen(0, "\x1b[200~hello\x1b[201~") === 5);
// A MULTI-LINE paste body: the embedded \r/\n is draft CONTENT (counted), NOT a box-free — else a
// queued turn would drain onto the pasted text. "ab\ncd" inside the markers → 5 (a,b,\n,c,d).
check("nextComposerLen: multi-line paste body — embedded \\n counts, NOT freeing (0→5)", nextComposerLen(0, "\x1b[200~ab\ncd\x1b[201~") === 5);
check("nextComposerLen: multi-line paste with \\r\\n counts each (0→6)", nextComposerLen(0, "\x1b[200~ab\r\ncd\x1b[201~") === 6);
check("nextComposerLen: multi-line paste onto an EXISTING draft accumulates (2→7)", nextComposerLen(2, "\x1b[200~ab\ncd\x1b[201~") === 7);
// A bare Enter AFTER a multi-line paste lands (separate chunk) still frees the box.
check("nextComposerLen: bare Enter after a paste still frees → 0", nextComposerLen(5, "\r") === 0);
// A bare Enter OUTSIDE any paste span (within a larger chunk) still frees the box.
check("nextComposerLen: bare \\n following a closed paste frees → 0", nextComposerLen(0, "\x1b[200~ab\x1b[201~\n") === 0);
// A chunk that contains a BARE Enter anywhere is freeing (the human submitted).
check("nextComposerLen: 'abc\\r' is freeing → 0", nextComposerLen(0, "abc\r") === 0);

// ===================== PART B — the live state machine =====================
const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }

const busyLog = [];
const events = { onEngineSessionId() {}, onBusy(_id, b) { busyLog.push(b); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const lastBusy = () => busyLog[busyLog.length - 1];

// A helper to spin up a fresh READY session on a fake pty (no startup prompt → clean idle slate).
function freshSession(id) {
  host.spawn({ sessionId: id, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // startupModeCycles:0 → marks ready synchronously
  return fakes[fakes.length - 1];
}
const REPORT = "WORKER_REPORT_BODY";
const PASTE_START = "\x1b[200~";

try {
  // --- (c) CLEAN composer → immediate delivery, byte-identical to today (M1 path) ---
  {
    const SID = "sess-clean";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    const r = host.enqueueStdin(SID, REPORT);
    check("(c) clean composer: programmatic turn delivers IMMEDIATELY", r.delivered === true && r.position === undefined);
    check("(c) clean composer: REPORT written to the pty as a bracketed paste", written().includes(PASTE_START) && written().includes(REPORT));
    // (d) M1 invariant: submit() armed busy=true SYNCHRONOUSLY (so a concurrent enqueue queues).
    check("(d) M1: busy armed synchronously by submit()", lastBusy() === true);
    const r2 = host.enqueueStdin(SID, "SECOND");
    check("(d) M1: a concurrent enqueue QUEUES behind the synchronous busy", r2.delivered === false && r2.position === 1);
    check("(d) M1: the queued SECOND was NOT written to the pty", !written().includes("SECOND"));
    host.stop(SID, "hard");
  }

  // --- (a) HELD while dirty: a queued turn is not written while the human has a draft ---
  {
    const SID = "sess-held";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "ha");                 // human types a half-line → composer dirty
    check("(a) human's raw bytes pass straight through to the pty", written().includes("ha"));
    const r = host.enqueueStdin(SID, REPORT);   // a worker report arrives mid-compose
    check("(a) dirty composer: programmatic turn is HELD (queued, not delivered)", r.delivered === false && r.position === 1);
    check("(a) dirty composer: REPORT is NOT written to the pty", !written().includes(REPORT));
    check("(a) the held turn is visible in the queue (not silently dropped)", JSON.stringify(host.getPending(SID)) === JSON.stringify([REPORT]));
    // The reconcile safety-net must ALSO respect the dirty hold (it must not drain onto the draft).
    host.reconcile();
    check("(a) reconcile does NOT drain onto a dirty composer", !written().includes(REPORT) && host.getPending(SID).length === 1);

    // --- (b) box-free via Enter → human's line submits first, THEN the held turn delivers cleanly ---
    const beforeEnterLen = fake.writes.length;
    host.writeStdin(SID, "\r");                 // human presses Enter on their own line
    const idxEnter = fake.writes.indexOf("\r", beforeEnterLen);
    const idxPaste = fake.writes.indexOf(PASTE_START, beforeEnterLen);
    check("(b) Enter freed the box → the held REPORT now delivered", written().includes(REPORT) && host.getPending(SID).length === 0);
    check("(b) FIFO order preserved: human's Enter is written BEFORE the held turn's paste", idxEnter >= 0 && idxPaste >= 0 && idxEnter < idxPaste);
    host.stop(SID, "hard");
  }

  // --- (b) box-free via backspace-to-empty → releases the hold ---
  {
    const SID = "sess-backspace";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "ab");                 // draft length 2
    const r = host.enqueueStdin(SID, REPORT);
    check("(b/bksp) held while dirty", r.delivered === false);
    host.writeStdin(SID, "\x7f");               // delete one → length 1, STILL dirty
    check("(b/bksp) still held after one backspace (draft non-empty)", !written().includes(REPORT) && host.getPending(SID).length === 1);
    host.writeStdin(SID, "\x7f");               // delete the last → length 0 → box free
    check("(b/bksp) backspace-to-empty released the hold → REPORT delivered", written().includes(REPORT) && host.getPending(SID).length === 0);
    host.stop(SID, "hard");
  }

  // --- (b) box-free via Esc (dismiss) → releases the hold ---
  {
    const SID = "sess-esc";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "draft");
    host.enqueueStdin(SID, REPORT);
    check("(b/esc) held while dirty", !written().includes(REPORT));
    host.writeStdin(SID, ESC);                  // Esc dismisses/clears the box
    check("(b/esc) Esc released the hold → REPORT delivered", written().includes(REPORT) && host.getPending(SID).length === 0);
    host.stop(SID, "hard");
  }

  // --- a MULTI-LINE raw paste must HOLD: its embedded newline is draft content, not a box-free ---
  {
    const SID = "sess-mlpaste";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "\x1b[200~line one\nline two\x1b[201~"); // multi-line bracketed paste → composer dirty
    const r = host.enqueueStdin(SID, REPORT);                     // a worker report arrives over the pasted draft
    check("(mlpaste) multi-line paste leaves composer DIRTY → programmatic turn HELD", r.delivered === false && r.position === 1);
    check("(mlpaste) the held REPORT is NOT written onto the pasted draft", !written().includes(REPORT));
    host.reconcile();
    check("(mlpaste) reconcile does NOT drain onto the multi-line paste", !written().includes(REPORT) && host.getPending(SID).length === 1);
    host.writeStdin(SID, "\r");                                   // human presses Enter → submits the paste
    check("(mlpaste) a real Enter after the paste releases the hold → REPORT delivered", written().includes(REPORT) && host.getPending(SID).length === 0);
    host.stop(SID, "hard");
  }

  // --- a navigation key (arrow) must NOT release the hold (it's editing, not freeing) ---
  {
    const SID = "sess-arrow";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "edit");
    host.enqueueStdin(SID, REPORT);
    host.writeStdin(SID, "\x1b[D");             // left arrow — still editing
    host.reconcile();
    check("(arrow) an arrow key does NOT release the hold (still dirty)", !written().includes(REPORT) && host.getPending(SID).length === 1);
    host.stop(SID, "hard");
  }
} finally {
  for (const id of ["sess-clean", "sess-held", "sess-backspace", "sess-esc", "sess-mlpaste", "sess-arrow"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composer-dirty hold: held while dirty, drains on free/empty, clean delivers immediately, M1 intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
