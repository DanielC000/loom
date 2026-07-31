// Card 7114838d — frame-splice detector: LOG-ONLY diagnostic instrumentation, fixes nothing (does not
// close 3ce3fa39). Compares the engine's own report of what was actually submitted (UserPromptSubmit's
// `prompt` field) against `live.lastPrompt` (what the daemon itself intended to write for that turn) —
// the one comparison that can distinguish "written and applied" from "written and dropped/spliced",
// because the two sides come from genuinely independent sources.
//
// POSITIVE-CONTROL (mandatory per the card): a detector never shown going red is not evidence. This file
// proves the detector can FIRE on a synthesized mismatch (and that the log is SELF-CLASSIFYING — a real
// splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a
// matching pair, is GATED on submitWasOutstanding (so a raw human-typed turn against a stale lastPrompt
// never misfires — the known false-positive class), and is SELF-DIAGNOSING when the engine never sends a
// `prompt` field at all.
//
// ⚠️ WHAT THIS SUITE DOES NOT PROVE: every scenario here SYNTHESIZES the hook payload. It proves the
// detector's comparison/gating/logging logic is correct GIVEN that `hook.prompt` exists and reports the
// engine's literal submitted text — it does NOT and cannot prove Claude Code actually sends that field, or
// that it reports the identical string byte-for-byte (no Ink-side trimming/normalization). That premise is
// answered only by the FIRST REAL hook after deploy: either the mismatch/match log fires as expected, or
// the `UNCONFIRMED` self-diagnostic line (scenario 4) fires instead, and only then is the question settled.
//
// Mirrors pty-owner-attestation.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty
// seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-${Date.now()}-${process.pid}`);
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

// Captures console.log lines matching the detector's [prompt-mismatch] tag for the duration of a block.
// The detector logs via console.log (stdout) deliberately — same stream as [pty-write]/[submit-write]/
// [stdin-write], so line order in the combined log stays meaningful alongside those records; see the
// comment above the detector in host.ts.
function captureMismatchWarnings(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes("[prompt-mismatch]")) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL: a synthesized mismatch (reported = stranded + intended) FIRES, and the log
  // names WHERE the divergence starts, not just that one exists =====
  {
    const sid = newSession("A"); SIDS.push(sid);
    const stranded = "leftover text from a prior turn";
    const intended = "the new message the user actually typed";
    host.enqueueStdin(sid, intended); // submit() outstanding -> live.lastPrompt = intended, enterConfirmed=false
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    });
    check("1: a synthesized splice (reported = stranded+intended) FIRES the detector", warnings.length === 1);
    check("1: the log names the divergence POINT (a char offset), not just a bare true/false", /divergesAtChar=\d+/.test(warnings[0] ?? ""));
    check("1: the log shows an excerpt around the divergence on BOTH sides", /reportedAround=/.test(warnings[0] ?? "") && /intendedAround=/.test(warnings[0] ?? ""));
    check("1: divergesAtChar is 0 — the specimens splice from the very start (stranded prefix precedes everything)", /divergesAtChar=0\b/.test(warnings[0] ?? ""));
    // Self-classifying fields (manager review): a real splice has a LARGE tail on both sides at the
    // divergence point (the rest of two genuinely different messages), unlike a trailing/normalization
    // artifact which would diverge near the very end with tiny tails on both sides.
    check("1: lenDelta + both tail lengths are present so the reader can tell a real splice from a benign trailing/normalization artifact without doing arithmetic",
      /lenDelta=-?\d+/.test(warnings[0] ?? "") && /tailReportedLen=\d+/.test(warnings[0] ?? "") && /tailIntendedLen=\d+/.test(warnings[0] ?? ""));
    {
      const tailReported = Number((/tailReportedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      const tailIntended = Number((/tailIntendedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      check("1: this specimen's tails are LARGE on both sides (a real splice shape, not a trailing artifact)",
        Number.isFinite(tailReported) && Number.isFinite(tailIntended) && tailReported > 20 && tailIntended > 20);
    }
  }

  // ===== 2. NEGATIVE: a matching pair (reported === intended) does NOT fire =====
  {
    const sid = newSession("B"); SIDS.push(sid);
    const text = "a perfectly normal message";
    host.enqueueStdin(sid, text);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text });
    });
    check("2: a matching (non-spliced) turn stays SILENT", warnings.length === 0);
  }

  // ===== 3. GATING (known false-positive class): a raw human-typed turn — submitWasOutstanding===false —
  // must NEVER misfire against a stale lastPrompt left over from an earlier Loom-originated turn =====
  {
    const sid = newSession("C"); SIDS.push(sid);
    // Turn 1: a Loom-originated submit sets live.lastPrompt, then completes (Stop) — enterConfirmed=true,
    // no submit outstanding afterward. lastPrompt is left stale (the field is never cleared at Stop).
    host.enqueueStdin(sid, "[loom:reminder] an earlier, unrelated Loom turn");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // Turn 2: a genuine raw-terminal Enter-submit (writeStdin), completely different text, with NO
    // submit() outstanding — enterConfirmed is already true, so submitWasOutstanding is false.
    const rawLine = "something the human typed directly into the raw terminal";
    host.writeStdin(sid, `${rawLine}\r`);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: rawLine });
    });
    check("3: a raw-terminal turn (submitWasOutstanding=false) never compares against a stale lastPrompt", warnings.length === 0);
  }

  // ===== 4. SELF-DIAGNOSING: the engine never sends a usable 'prompt' field at all — must log this
  // explicitly, once, rather than silently comparing undefined and never firing =====
  {
    const sid = newSession("D"); SIDS.push(sid);
    host.enqueueStdin(sid, "some outstanding turn"); // submit() outstanding
    const warnings1 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // NO prompt field at all
    });
    check("4: an absent prompt field is logged EXPLICITLY (not silently ignored)", warnings1.length === 1);
    check("4: the absent-field log names the premise as unconfirmed", /UNCONFIRMED/.test(warnings1[0] ?? ""));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // A SECOND turn on the same session, still missing the field, must NOT re-log — "once" per session.
    host.enqueueStdin(sid, "a second outstanding turn");
    const warnings2 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    });
    check("4: a repeat absence on the SAME session does not re-log (latched once, not once-per-turn)", warnings2.length === 0);
  }

  // ===== 5. A fresh session's own startup-prompt hook never fires the detector (no submit() is
  // outstanding for the CLI-arg startup turn — enterConfirmed is seeded true) =====
  {
    const sid = "sess-E";
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, startupPrompt: "kickoff text" });
    SIDS.push(sid);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: "kickoff text" });
    });
    check("5: the fresh-spawn startup-prompt hook (no submit outstanding) never fires the detector", warnings.length === 0);
  }

  // ===== 6. CONTRAST (manager review): a benign trailing-artifact-shaped mismatch (e.g. a lone trailing
  // character) reads DIFFERENTLY in the log than scenario 1's real-splice shape — small tails on both
  // sides at the divergence point, instead of scenario 1's large tails. This is what would let a reader
  // tell a systematic benign mismatch (framing/normalization) apart from an actual splice at a glance,
  // without the detector itself having to guess which one it is. =====
  {
    const sid = newSession("F"); SIDS.push(sid);
    const intended = "a normal short message";
    host.enqueueStdin(sid, intended);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: `${intended} ` }); // one trailing char
    });
    check("6: a single trailing-char difference still FIRES (it is a real, if small, mismatch)", warnings.length === 1);
    check("6: divergesAtChar sits at the END of the shorter string (near both lengths), not at 0", new RegExp(`divergesAtChar=${intended.length}\\b`).test(warnings[0] ?? ""));
    check("6: BOTH tails are tiny here (0 and 1) — visibly different from scenario 1's large-tail splice shape", /tailReportedLen=1\b/.test(warnings[0] ?? "") && /tailIntendedLen=0\b/.test(warnings[0] ?? ""));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the frame-splice detector (card 7114838d) FIRES on a synthesized mismatch and names the divergence point (self-classifying via lenDelta + both tail lengths — a real splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a matching pair, is correctly GATED on submitWasOutstanding (never misfires a raw human-typed turn against a stale lastPrompt), and is SELF-DIAGNOSING when the engine sends no usable prompt field (logs once per session, not once per turn). NOTE: this suite synthesizes every hook payload — it proves the detector's own logic, not that Claude Code actually sends `prompt` or reports it byte-identical; only the first real hook after deploy answers that."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
