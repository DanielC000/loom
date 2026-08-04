// Card c2c750a9 — the sum+hash composer-accumulation detector. CONSUMES fields `[prompt-echo]` already
// logs on every submission (reportedLen/writtenLen/reportedHash/writtenHash) — this file proves the two
// stages built on top of them (see host.ts's `detectComposerAccumulation` for the full design doc):
//   TRIGGER      — reportedLen == the SUM of the current write's length plus one-or-more IMMEDIATELY-
//                  PRECEDING writes' lengths.
//   CONFIRMATION — fnv1a32 of those same payloads' TEXT, concatenated in gen order, bare, equals
//                  reportedHash.
//
// POSITIVE CONTROL, BOTH POLARITIES (card c2c750a9's own load-bearing DoD item):
//   1. A specimen shaped exactly like the hash-confirmed real one (card 736de9c0: writtenLens
//      2084/3856/5165 summing to reportedLen 11105) MUST fire [composer-accumulation] CONFIRMED.
//   2. A clean gen sequence (matching writtenLen==reportedLen, byteIdentical — the real specimen's own
//      "CLEARED" gen, 5378/5378) MUST stay silent.
//   3. The SAME three specimen texts, but with the engine reporting them back in a DIFFERENT order
//      (same total length 11105, so the SUM trigger still fires) MUST have the hash CONFIRMATION refuse
//      it — proving the two stages do different jobs, not just that the detector can be silenced.
//
// ⚠️ SCOPE: this suite constructs its own literal texts of the real specimen's exact byte lengths
// (2084/3856/5165) for realism, but the actual PRODUCTION incident's byte content was never captured
// anywhere retrievable — so scenario 1's "reportedHash" is this suite's OWN fnv1a32 over ITS OWN
// synthetic text (computed by the detector itself from the literal `hook.prompt` this test supplies),
// never the historical digest `1136780e`. This proves the detector's sum+hash MECHANISM against a
// specimen of the real shape; it does not and cannot reproduce that literal historical digest, which
// would require bytes this test has no access to.
//
// Mirrors pty-prompt-mismatch.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty
// seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-composer-accumulation.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-composer-accum-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    return { ...base, write: (d) => { writes.push(d); }, writes };
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Captures console.log lines matching a given tag prefix for the duration of a block. Mirrors
// pty-prompt-mismatch.mjs's captureMismatchWarnings — the detector logs via console.log (stdout)
// deliberately, same stream as [pty-write]/[submit-write]/[prompt-echo].
function captureTag(tag, fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes(tag)) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

// A clean one-turn submit+confirm+Stop cycle — advances gen by exactly one, pushes exactly one entry
// onto the session's composer-accumulation window, and leaves NO mismatch (byteIdentical).
function cleanTurn(sid, text) {
  host.enqueueStdin(sid, text);
  host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text });
  host.deliverHook(sid, { hook_event_name: "Stop" });
}

const SIDS = [];

// Real specimen's exact byte lengths (card 736de9c0: 2084 + 3856 + 5165 = 11105, gen order A,B,C).
// Distinct fill characters per segment so a reader can tell them apart in any excerpt; content itself
// is otherwise arbitrary (see the file-header scope note — the real bytes were never captured).
const A = "a".repeat(2084);
const B = "b".repeat(3856);
const C = "c".repeat(5165);

try {
  // ===== 1. POSITIVE CONTROL: the real specimen's shape (2084/3856/5165 -> 11105, gen order) FIRES
  // [composer-accumulation] CONFIRMED, spanning all three generations, in gen order =====
  {
    const sid = newSession("Specimen"); SIDS.push(sid);
    cleanTurn(sid, A); // gen=1, clean
    cleanTurn(sid, B); // gen=2, clean
    // gen=3: Loom writes C, but the engine reports back the WHOLE accumulated composer (A+B+C) — the
    // real specimen's peak (its own gen=20).
    host.enqueueStdin(sid, C);
    const allAccumLines = captureTag("[composer-accumulation", () => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: A + B + C });
    });
    const confirmed = allAccumLines.filter((l) => !l.includes("-candidate")); // exclude the distinct -candidate tag (scenario 3's own)
    check("1: the real specimen's shape (2084/3856/5165 -> 11105) FIRES exactly one CONFIRMED accumulation", confirmed.length === 1);
    check("1: CONFIRMED and spans all three generations in gen order", /CONFIRMED/.test(confirmed[0] ?? "") && /spanGens=\[1,2,3\]/.test(confirmed[0] ?? ""));
    check("1: sumOfWrittenLens equals the real specimen's own total (11105)", /sumOfWrittenLens=11105\b/.test(confirmed[0] ?? ""));
    check("1: reportedLen matches too (2084+3856+5165=11105, exact)", /reportedLen=11105\b/.test(confirmed[0] ?? ""));
  }

  // ===== 2. NEGATIVE / CLEAN CONTROL: a clean gen sequence — matching writtenLen==reportedLen
  // (byteIdentical), the real specimen's own "CLEARED" gen shape (5378/5378) — stays SILENT: no
  // [composer-accumulation] and no [composer-accumulation-candidate] at all =====
  {
    const sid = newSession("Clean"); SIDS.push(sid);
    const text = "d".repeat(5378);
    const lines = captureTag("[composer-accumulation", () => {
      cleanTurn(sid, text); // gen=1
      cleanTurn(sid, text); // gen=2 — same length as gen=1, still byteIdentical, not an accumulation
    });
    check("2: a clean gen sequence (5378/5378, byteIdentical both times) triggers NEITHER the detector NOR its candidate diagnostic", lines.length === 0);
  }

  // ===== 3. THE COUNTEREXAMPLE THAT PROVES THE TWO STAGES DO DIFFERENT JOBS: the SAME three specimen
  // texts, SAME total length 11105 (so the SUM trigger still fires), but the engine reports them back
  // in a DIFFERENT order (C+A+B instead of A+B+C) — the HASH confirmation must REFUSE it. A detector
  // that only checked the sum would wrongly confirm this as the same accumulation as scenario 1. =====
  {
    const sid = newSession("Reorder"); SIDS.push(sid);
    cleanTurn(sid, A); // gen=1
    cleanTurn(sid, B); // gen=2
    host.enqueueStdin(sid, C); // gen=3
    const allAccumLines = captureTag("[composer-accumulation", () => {
      // Reordered: C+A+B — same combined length (11105) as scenario 1's A+B+C, different byte order.
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: C + A + B });
    });
    const candidateLines = allAccumLines.filter((l) => l.includes("-candidate"));
    const confirmedOnly = allAccumLines.filter((l) => !l.includes("-candidate"));
    check("3: the reordered specimen (same total length 11105, different byte order) does NOT fire a CONFIRMED accumulation", confirmedOnly.length === 0);
    check("3: the SUM trigger still recognizes it as a CANDIDATE (same length as a real accumulation span)", candidateLines.length === 1);
    check("3: the candidate line explicitly says the hash confirmation REFUSED it", /REFUSED/.test(candidateLines[0] ?? ""));
    check("3: the candidate's sumOfWrittenLens still matches (11105) — only the hash differs", /sumOfWrittenLens=11105\b/.test(candidateLines[0] ?? ""));
    {
      const concatHash = (/concatenatedHash=([0-9a-f]{8})/.exec(candidateLines[0] ?? "") ?? [])[1];
      const reportedHash = (/reportedHash=([0-9a-f]{8})/.exec(candidateLines[0] ?? "") ?? [])[1];
      check("3: concatenatedHash (gen-order A+B+C) and reportedHash (C+A+B as actually reported) are DIFFERENT, despite identical length — this is the ordering proof", !!concatHash && !!reportedHash && concatHash !== reportedHash);
    }
  }

  // ===== 4. A gen=1 session (a single submission, nothing preceding it) can never trigger the
  // detector — there is no "immediately preceding" write to sum against. Not tested as a "clean
  // control" (card 736de9c0's own limit: a censored zero, not evidence of correctness) — just confirms
  // the detector doesn't crash or misfire on the degenerate one-entry window. =====
  {
    const sid = newSession("SingleGen"); SIDS.push(sid);
    host.enqueueStdin(sid, "only one turn ever submitted on this session");
    const lines = captureTag("[composer-accumulation", () => {
      // Report back something LONGER than what was written — a real splice/garbage report, not an
      // accumulation (there's nothing preceding to accumulate FROM).
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: "garbage report unrelated to what was written, and longer" });
    });
    check("4: a gen=1 session (no preceding write to sum against) never fires the detector or its candidate diagnostic, even on an unrelated mismatch", lines.length === 0);
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the sum+hash composer-accumulation detector (card c2c750a9) FIRES [composer-accumulation] CONFIRMED on the real specimen's exact shape (2084/3856/5165 -> 11105, gen order), stays SILENT on a clean gen sequence (5378/5378, byteIdentical), and — the load-bearing proof that its two stages do different jobs — recognizes a same-length REORDERED specimen as a SUM candidate while its hash confirmation correctly REFUSES to report it as a real accumulation. NOTE: scenario 1 uses this suite's own synthetic text of the real specimen's byte lengths, not the historical incident's actual bytes (never captured/retrievable) — it proves the mechanism against a specimen of the real shape, not a literal replay of the historical digest."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
