// Card fc58ae55 — `writeChunked` (pty/host.ts) used `text.slice(i, i + PTY_WRITE_CHUNK_UNITS)`, and
// PTY_WRITE_CHUNK_UNITS (formerly misleadingly named `..._BYTES`) counts UTF-16 CODE UNITS, not bytes.
// An astral (non-BMP) character — any emoji outside the BMP — is a 2-code-unit surrogate pair. When one
// straddles a chunk boundary, the high half ends one chunk and the low half starts the next; each chunk
// is written to the pty (and UTF-8-encoded) INDEPENDENTLY, so each lone surrogate becomes U+FFFD.
// ⇒ one astral char (2 units) in → two U+FFFD (2 units) out. SAME LENGTH, corrupted content, no error.
//
// THE FIX: `surrogateSafeChunkEnd` (host.ts) shrinks a chunk by one unit whenever its last unit is a
// high surrogate (0xD800-0xDBFF) immediately followed (in the next chunk) by a low surrogate
// (0xDC00-0xDFFF) — so the pair always lands whole in the same chunk. The loop advances `i` by the
// ACTUAL slice end, not the constant, so a shift never desynchronizes what follows.
//
// METHODOLOGY (mirrors mgr #127's plain-Node repro on the card): we don't need a real pty or real
// ConPTY to observe this corruption — `writeChunked`'s fake-pty `write()` seam captures the exact
// string each chunk call receives, and independently UTF-8-encoding + concatenating + re-decoding those
// captured chunks (`Buffer.from(chunk, "utf8")` per chunk, then `Buffer.concat(...).toString("utf8")`)
// reproduces exactly what a real pty backend does to each write() call: the same corruption, or its
// absence, shows up in that reassembled string.
//
// RED-PROOF (validated by hand during development of this fix, per the DoD): reverting ONLY the
// `surrogateSafeChunkEnd` shrink (i.e. slicing at the raw `i + PTY_WRITE_CHUNK_UNITS` boundary, the
// pre-fix code) makes the "(1) astral char AT the boundary" and "(3)/(4) real specimen" cases below FAIL
// (reassembled text != original, with U+FFFD exactly at the predicted offset) while the "(2) OFF-boundary
// positive control" case still PASSES both before and after — proving the test is sensitive to the
// boundary specifically, not to something incidental about astral characters in general.
//
// Chunk size is left at PRODUCTION DEFAULT (1024, no LOOM_PTY_WRITE_CHUNK_BYTES override) so the two
// real-specimen offsets (8191, 16383 — both literal `divergesAtChar` values from the card, both
// ≡ 1023 mod 1024) land exactly where the incident data says they did; only the inter-chunk delay is
// shrunk, which is orthogonal to chunk-boundary math and just speeds up the test.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-write-chunk-surrogate-boundary.mjs`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-writechunk-surrogate-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Deliberately NOT setting LOOM_PTY_WRITE_CHUNK_BYTES — this test needs the real 1024-unit production
// boundary so the real-specimen offsets (8191, 16383) below land exactly where the incident found them.
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "1"; // orthogonal to boundary math; just speeds up the test

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// createPty() isn't itself exposed post-spawn, so capture each session's fake pty (with its own
// per-call write() log) at spawn time, keyed by session id — mirrors pty-write-seq-log.mjs's pattern of
// keying captured records off the session id.
const fakesBySession = new Map();
class RecordingPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakesBySession.set(opts.sessionId, fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {} };
const recordingHost = new RecordingPtyHost(events);

function spawnReady(sessionId) {
  recordingHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  recordingHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

// Independently UTF-8-encodes + reassembles each captured chunk, exactly like a real pty backend
// processing each write() call on its own (the actual corruption mechanism — see file header).
function simulateIndependentUtf8Roundtrip(chunks) {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, "utf8"))).toString("utf8");
}

async function runWriteChunked(sessionId, text) {
  spawnReady(sessionId);
  const fake = fakesBySession.get(sessionId);
  await new Promise((resolve) => recordingHost.writeChunked(sessionId, text, resolve));
  const chunks = fake.writes.slice();
  return { chunks, roundtripped: simulateIndependentUtf8Roundtrip(chunks) };
}

function countUFFFD(s) {
  let n = 0;
  for (const ch of s) if (ch === "�") n++;
  return n;
}

const ASTRAL = "\u{1F4CC}"; // 📌 U+1F4CC — a real specimen character from the card (§2)

try {
  // ===== (1) RED case: astral char's high surrogate is the LAST unit of the first chunk (offset 1023) =====
  {
    const text = "a".repeat(1023) + ASTRAL + "b".repeat(100);
    const { chunks, roundtripped } = await runWriteChunked("red-1023", text);
    check("(1) same length in vs out (the silent-corruption signature)", roundtripped.length === text.length);
    check("(1) FIXED: reassembled text is byte-identical to the input", roundtripped === text);
    check("(1) FIXED: zero U+FFFD in the reassembled text", countUFFFD(roundtripped) === 0);
    check("(1) no chars lost or duplicated across the chunk split (lengths sum correctly)",
      chunks.reduce((n, c) => n + c.length, 0) === text.length);
  }

  // ===== (2) POSITIVE CONTROL: same string, astral char shifted OFF the boundary (offset 1022) =====
  // Must pass both before and after the fix — proves case (1) is sensitive to the boundary specifically.
  {
    const text = "a".repeat(1022) + ASTRAL + "b".repeat(101); // same total length as case (1)
    const { roundtripped } = await runWriteChunked("control-1022", text);
    check("(2) CONTROL: off-boundary astral char round-trips correctly", roundtripped === text);
    check("(2) CONTROL: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (3) REAL SPECIMEN — §2b: divergesAtChar=8191 (8×1024−1), character 🔴 U+1F534 =====
  {
    const specimenChar = "\u{1F534}"; // 🔴
    const text = "x".repeat(8191) + specimenChar + "y".repeat(500);
    const { roundtripped } = await runWriteChunked("specimen-8191", text);
    check("(3) §2b specimen (offset 8191): byte-identical reassembly", roundtripped === text);
    check("(3) §2b specimen: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (4) REAL SPECIMEN — §2: divergesAtChar=16383 (16×1024−1), the "📌 SCOPE" corruption =====
  {
    const text = "x".repeat(16383) + ASTRAL + " SCOPE" + "y".repeat(500);
    const { roundtripped } = await runWriteChunked("specimen-16383", text);
    check("(4) §2 specimen (offset 16383): byte-identical reassembly", roundtripped === text);
    check("(4) §2 specimen: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (5) astral char spanning the FINAL chunk boundary (nothing follows the pair) =====
  {
    const text = "a".repeat(1023) + ASTRAL; // length 1025 — the pair is the entire tail
    const { roundtripped } = await runWriteChunked("final-boundary", text);
    check("(5) final-chunk-boundary case: byte-identical reassembly", roundtripped === text);
    check("(5) final-chunk-boundary case: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (6) several astral chars scattered across many chunks, including cascading boundary shifts =====
  // Some land naturally ≡ 1023 (mod 1024) in the ORIGINAL text; once the first shrink fires, later
  // absolute chunk boundaries shift too — this exercises that the fix's own shift doesn't desynchronize
  // subsequent boundary decisions (the loop must advance by the ACTUAL slice end, not the constant).
  {
    let text = "";
    const emojis = ["\u{1F4CC}", "\u{1F534}", "\u{2B50}\u{FE0F}", "\u{1F600}", "\u{26D4}"];
    // Deliberately irregular spacing (not a clean multiple of 1024) so some emoji land on a boundary and
    // some don't, and so the SECOND emoji's position depends on whether the first one shifted anything.
    const gaps = [1023, 511, 1024, 2000, 777];
    for (let i = 0; i < emojis.length; i++) {
      text += "z".repeat(gaps[i]) + emojis[i];
    }
    text += "z".repeat(3000);
    const { roundtripped } = await runWriteChunked("cascading-scatter", text);
    check("(6) cascading multi-emoji scatter: byte-identical reassembly", roundtripped === text);
    check("(6) cascading multi-emoji scatter: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (7) a chunk that is ENTIRELY astral characters, spanning multiple chunks =====
  {
    // A leading single-unit filler forces an odd unit-offset into the run of pairs, so a chunk boundary
    // (1024, 2048, ...) provably falls INSIDE a pair rather than conveniently between two of them.
    const text = "z" + ASTRAL.repeat(1500); // 1 + 3000 = 3001 units, spans 3 chunks
    const { roundtripped } = await runWriteChunked("all-astral-chunk", text);
    check("(7) all-astral chunk: byte-identical reassembly", roundtripped === text);
    check("(7) all-astral chunk: zero U+FFFD", countUFFFD(roundtripped) === 0);
  }

  // ===== (8) ZWJ sequence: splitting BETWEEN code points (right after a ZWJ) is NOT the bug and must =====
  // ===== NOT be "fixed" — the chunk boundary must stay exactly where the constant puts it (1024). =====
  {
    // Family emoji: 👨(2 units) ZWJ(1) 👩(2) ZWJ(1) 👧(2) ZWJ(1) 👦(2) = 11 units. ZWJ spelled out via
    // explicit \u{200D} escapes (not a literal invisible character in source) so the sequence is
    // unambiguous on any editor/encoding.
    const ZWJ = "\u{200D}";
    const family = "\u{1F468}" + ZWJ + "\u{1F469}" + ZWJ + "\u{1F467}" + ZWJ + "\u{1F466}";
    // Positioned so the FIRST ZWJ (relative unit index 2) lands exactly at absolute index 1023 — the
    // last unit of chunk 1 — with 👩's high surrogate as the first unit of chunk 2. A ZWJ is U+200D, a
    // single BMP code unit, never a high surrogate — so surrogateSafeChunkEnd must leave this boundary
    // untouched even though a multi-codepoint grapheme cluster is split across the chunk.
    const prefixLen = 1021; // 1021 + 2 (👨) = 1023 → next unit (the ZWJ) is index 1023
    const text = "a".repeat(prefixLen) + family + "b".repeat(50);
    const { chunks, roundtripped } = await runWriteChunked("zwj-not-fixed", text);
    check("(8) ZWJ split-between-codepoints: byte-identical reassembly (splitting here was never corruption)",
      roundtripped === text);
    check("(8) ZWJ split-between-codepoints: zero U+FFFD", countUFFFD(roundtripped) === 0);
    check("(8) ZWJ split-between-codepoints: boundary was NOT artificially shrunk (chunk 1 is the full 1024 units)",
      chunks[0].length === 1024);
  }
} finally {
  for (const id of fakesBySession.keys()) {
    try { recordingHost.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — writeChunked never splits a UTF-16 surrogate pair across a chunk boundary: synthetic boundary + off-boundary control + both real incident specimens (8191, 16383) + final-boundary + cascading-scatter + all-astral-chunk + ZWJ-non-regression all reassemble byte-identical with zero U+FFFD."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
