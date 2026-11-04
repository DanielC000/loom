import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ff7321 (part C of 8c7dfc65) — integration test for checkContextExhaustion/the bounded
// tail-reader (orchestration/context-exhaustion.ts). Drives the REAL fs read against a REAL file at
// the path resolveTranscriptFile/engineTranscriptPath actually resolve to (never a hand-constructed
// path — see pty/claude-transcript.ts's own "Do not construct a ~/.claude/projects/... literal
// anywhere outside this file" decision record).
//
// engineTranscriptPath resolves under os.homedir(), which this file sandboxes to a managed temp dir
// (card 668bc52c), never the owner's real ~/.claude/projects — every id here is also suffixed with a
// run-unique RUN_SUFFIX so a leftover from a skipped cleanup (a SIGKILL, an EPERM/EBUSY) can never
// collide with a later run, and the fixture directory is removed in a `finally` block.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/context-exhaustion-tail-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const RUN_SUFFIX = `${Date.now()}-${process.pid}`;

// @decision 668bc52c — sandbox HOME/USERPROFILE to a managed temp dir BEFORE importing dist; never
// write a transcript fixture under the real os.homedir(), and never import dist after the sandbox is
// set but let a module-load-time os.homedir() read slip in before it.
const sandboxHome = path.join(os.tmpdir(), `loom-ctxexh-home-${RUN_SUFFIX}`);
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// @decision a92a0913 — also delete an ambient CLAUDE_CONFIG_DIR: claudeConfigHome() reads it ahead of
// os.homedir(), so an inherited value would bypass the HOME/USERPROFILE override above entirely.
delete process.env.CLAUDE_CONFIG_DIR;

const { checkContextExhaustion, CONTEXT_EXHAUSTION_TAIL_BYTES } = await import("../dist/orchestration/context-exhaustion.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const cwd = path.join(os.tmpdir(), `loom-ctxexh-${RUN_SUFFIX}`);
const engineId = `eng-ctxexh-${RUN_SUFFIX}`;
const file = engineTranscriptPath(cwd, engineId);

const REAL_EXHAUSTION_RECORD = {
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
};
const REAL_MODEL_RECORD = (text) => ({
  type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text }] },
});

try {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // ===== (1) missing file entirely ⇒ null, never throws =====
  {
    const result = checkContextExhaustion(cwd, engineId, "claude");
    check("(1) a not-yet-existing transcript file returns null, never throws", result === null);
  }

  // ===== (2) no engineSessionId at all ⇒ null (never attempts a resolve/read) =====
  {
    check("(2) a null engineSessionId returns null", checkContextExhaustion(cwd, null, "claude") === null);
    check("(2) an undefined engineSessionId returns null", checkContextExhaustion(cwd, undefined, "claude") === null);
  }

  // ===== (3) the real marker, written as the ONLY (small) line ⇒ detected =====
  {
    fs.writeFileSync(file, `${JSON.stringify(REAL_EXHAUSTION_RECORD)}\n`);
    const result = checkContextExhaustion(cwd, engineId, "claude");
    check("(3) a small file carrying only the real marker IS detected", result !== null);
    check("(3) matchedText round-trips correctly", result?.matchedText === "Prompt is too long");
  }

  // ===== (4) BOUNDED READ: a file far larger than CONTEXT_EXHAUSTION_TAIL_BYTES, with the marker as
  // the LAST line, is still detected — proves the read is a genuine bounded TAIL, not a full read that
  // happens to work on a small fixture. =====
  {
    const padLine = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(500) } });
    const paddingBytesNeeded = CONTEXT_EXHAUSTION_TAIL_BYTES * 3; // far past the bound
    const lines = [];
    let written = 0;
    while (written < paddingBytesNeeded) { lines.push(padLine); written += padLine.length + 1; }
    lines.push(JSON.stringify(REAL_EXHAUSTION_RECORD));
    const content = lines.join("\n") + "\n";
    fs.writeFileSync(file, content);
    check("(4) precondition: the fixture file is genuinely larger than the tail-byte bound",
      fs.statSync(file).size > CONTEXT_EXHAUSTION_TAIL_BYTES);
    const result = checkContextExhaustion(cwd, engineId, "claude");
    check("(4) the marker at the END of an oversized file IS still detected (bounded tail read works)", result !== null);
  }

  // ===== (4b) negative control for the bound itself: the marker placed ONLY in the DISCARDED head of
  // an oversized file (never in the last CONTEXT_EXHAUSTION_TAIL_BYTES) is correctly NOT detected —
  // proves the read is genuinely bounded, not silently reading the whole file regardless. =====
  {
    const padLine = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(500) } });
    const paddingBytesNeeded = CONTEXT_EXHAUSTION_TAIL_BYTES * 3;
    const lines = [JSON.stringify(REAL_EXHAUSTION_RECORD)]; // marker FIRST, in the part the tail read discards
    let written = 0;
    while (written < paddingBytesNeeded) { lines.push(padLine); written += padLine.length + 1; }
    lines.push(JSON.stringify(REAL_MODEL_RECORD("trailing real content, not the marker")));
    const content = lines.join("\n") + "\n";
    fs.writeFileSync(file, content);
    const result = checkContextExhaustion(cwd, engineId, "claude");
    check("(4b) a marker ONLY in the discarded head of an oversized file is NOT detected (genuinely bounded, not a full read)",
      result === null);
  }

  // ===== (5) a codex-harness session's transcript (out of scope) — a claude-shaped marker at a codex
  // path is never reached, since the path resolution itself differs; sanity only, never throws. =====
  {
    let threw = false;
    let result;
    try { result = checkContextExhaustion(cwd, engineId, "codex"); } catch { threw = true; }
    check("(5) a codex-harness call never throws (different transcript format/path, not this detector's concern)", !threw);
    check("(5) a codex-harness call returns null (no matching rollout file at the claude-encoded path)", result === null);
  }
} finally {
  // Cleanup the sandboxed-home fixture directory this run created (card 7c1fc117's own established
  // pattern) — never the whole projects root, only this run's own uniquely-suffixed dir.
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — checkContextExhaustion resolves the REAL transcript path (never a hand-constructed one), reads a genuinely BOUNDED tail (proven both directions: a marker inside the bound is found, a marker outside it is not), and never throws on a missing file/engineSessionId or an out-of-scope codex harness."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
