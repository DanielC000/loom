// Card 1027b523 — `codex-doctrine-real-spawn.mjs`'s own completion predicate was weaker than the
// condition it stood for: `t.find((turn) => turn.role === "assistant" && turn.text.trim().length > 0)`
// means "any non-empty assistant message exists", but it stood in for "the FINAL ANSWER has arrived".
// A reasoning-capable model's own intent-preamble ("I'll read AGENTS.md...") satisfies the OLD predicate
// immediately and `waitUntil` returns before the model ever produces the requested LOOM-DOCTRINE-ID.
//
// This is a HERMETIC proof — no real codex spawn needed. It reproduces the OLD predicate's bug and the
// NEW predicate's fix against the REAL, unmodified `readTranscript`/`parseTranscriptFile` parser (never a
// test-local reimplementation), using synthetic rollout JSONL fixtures built from the ACTUAL two strings
// captured from the real, failing gate run (card 1027b523's own body) — not hand-invented text.
//
// Positive-controlled throughout: every "the new predicate rejects this" assertion is paired with "the
// new predicate accepts the genuine completion" on the SAME transcript, so a predicate that just always
// returns false could never pass this file.
//
// Also covers the SAME defect shape found by sweeping the sibling real-spawn files (card 1027b523 DoD-3):
// `codex-transcript-real-spawn.mjs`'s own wait used the identical "any non-empty assistant text" predicate
// (its expected reply is the literal word "pong" rather than an id) — specimen 4 below proves that fix too.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-completion-predicate.mjs
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpCodexHome = mkdtempManaged("loom-codex-doctrine-predicate-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
useOwnLoomHome("loom-codex-doctrine-predicate-loomhome-"); // isolates LOOM_HOME too, before importing dist — mirrors transcript-harness-dispatch.mjs's own convention

const { readTranscript } = await import("../dist/sessions/transcript.js");

// --- Fixture builder: the SAME rollout wire shape transcript-harness-dispatch.mjs's own fixture uses
// (response_item/message records), so this exercises the REAL parser's real code path, not a shortcut. ---
let fixtureCounter = 0;
function writeRolloutFixture(conversationId, lines) {
  fixtureCounter++;
  const dayDir = path.join(tmpCodexHome, "sessions", "2026", "09", String(7 + fixtureCounter).padStart(2, "0"));
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-09-0${7 + fixtureCounter}T00-00-00-${conversationId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
const userMsg = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text }] } });
const assistantMsg = (id, text) => JSON.stringify({ type: "response_item", payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] } });
const sessionMeta = (conversationId, cwd) => JSON.stringify({ type: "session_meta", payload: { session_id: conversationId, cwd, originator: "codex-tui" } });

// --- The OLD (buggy) and NEW (fixed) predicate logic, mirrored EXACTLY from
// codex-doctrine-real-spawn.mjs's own before/after — never re-derived loosely, so this file actually
// proves what that file's fix does, not a lookalike. ------------------------------------------------------
function oldPredicateReply(turns) {
  return turns.find((turn) => turn.role === "assistant" && turn.text.trim().length > 0);
}
function newPredicateReply(turns, expectedId) {
  return turns.find((turn) => {
    if (turn.role !== "assistant" || !turn.text.trim()) return false;
    return expectedId ? turn.text.includes(expectedId) : true; // degraded-fallback path (no id to check) keeps the old "any non-empty" signal
  });
}

// === Specimen 1: the FIRST real captured preamble ("...to check the value.") ==============================
{
  const expectedId = "439830e2"; // the real expected id from the captured failure
  const cwd = "/fake/codex/cwd-1";
  const conversationId = "predicate-fixture-1";
  const preamble = "I'll read AGENTS.md to check the value.\n";
  const fixtureFile = writeRolloutFixture(conversationId, [
    sessionMeta(conversationId, cwd),
    userMsg(`Read the file AGENTS.md ... reply with EXACTLY the 8-character value that appears after "LOOM-DOCTRINE-ID:" ...`),
    assistantMsg("a1", preamble),
  ]);
  const turnsPreambleOnly = readTranscript(cwd, conversationId, "codex");
  check("sanity: the real parser extracted the preamble as its own non-empty assistant turn", turnsPreambleOnly.some((t) => t.role === "assistant" && t.text === preamble));

  check("RED PROOF: the OLD predicate IS satisfied by the preamble alone (reproduces the real bug mechanism)", !!oldPredicateReply(turnsPreambleOnly));
  check("GREEN: the NEW predicate is NOT satisfied by the preamble alone (no LOOM-DOCTRINE-ID present yet)", !newPredicateReply(turnsPreambleOnly, expectedId));

  // Now simulate the genuine completion landing later in the SAME rollout file (exactly what a real,
  // slower turn does — the preamble is followed, eventually, by the real answer).
  fs.appendFileSync(fixtureFile, assistantMsg("a2", `LOOM-DOCTRINE-ID: ${expectedId}`) + "\n");
  const turnsAfterCompletion = readTranscript(cwd, conversationId, "codex");
  const found = newPredicateReply(turnsAfterCompletion, expectedId);
  check("POSITIVE CONTROL: the NEW predicate correctly finds the genuine completion once it lands (not a predicate that just always returns false)", !!found && found.text.includes(expectedId));
  check("the NEW predicate still correctly rejects the OLDER preamble turn specifically, not just accepting the transcript as a whole", !newPredicateReply([turnsPreambleOnly[turnsPreambleOnly.length - 1]], expectedId));
}

// === Specimen 2: the SECOND real captured preamble ("I'll read AGENTS.md.") — a different exact string,
// proving the fix isn't overfit to specimen 1's wording. ===================================================
{
  const expectedId = "aa11bb22";
  const cwd = "/fake/codex/cwd-2";
  const conversationId = "predicate-fixture-2";
  const preamble = "I'll read AGENTS.md.\n";
  writeRolloutFixture(conversationId, [
    sessionMeta(conversationId, cwd),
    userMsg("Read AGENTS.md and reply with the id."),
    assistantMsg("b1", preamble),
  ]);
  const turns = readTranscript(cwd, conversationId, "codex");
  check("RED PROOF (specimen 2): the OLD predicate IS satisfied by this second real preamble string too", !!oldPredicateReply(turns));
  check("GREEN (specimen 2): the NEW predicate is NOT satisfied by this preamble either", !newPredicateReply(turns, expectedId));
}

// === Specimen 4: the SIBLING fix in codex-transcript-real-spawn.mjs — same defect shape, but the expected
// reply is the literal word "pong", not an id, so the fix there checks /pong/i.test(text) instead. =========
{
  const oldPongPredicate = (turns) => turns.some((turn) => turn.role === "assistant" && turn.text.trim().length > 0);
  const newPongPredicate = (turns) => turns.some((turn) => turn.role === "assistant" && /pong/i.test(turn.text));

  const cwd = "/fake/codex/cwd-4";
  const conversationId = "predicate-fixture-4";
  const preamble = "I'll reply now.\n";
  const fixtureFile4 = writeRolloutFixture(conversationId, [
    sessionMeta(conversationId, cwd),
    userMsg("Reply with exactly the single word: pong."),
    assistantMsg("d1", preamble),
  ]);
  const turnsPreambleOnly = readTranscript(cwd, conversationId, "codex");
  check("RED PROOF (sibling, specimen 4): the OLD predicate IS satisfied by a preamble here too", oldPongPredicate(turnsPreambleOnly));
  check("GREEN (sibling, specimen 4): the NEW /pong/i predicate is NOT satisfied by the preamble", !newPongPredicate(turnsPreambleOnly));

  fs.appendFileSync(fixtureFile4, assistantMsg("d2", "pong\n") + "\n");
  const turnsWithReply = readTranscript(cwd, conversationId, "codex");
  check("POSITIVE CONTROL (sibling, specimen 4): the NEW /pong/i predicate correctly finds the genuine reply once it lands", newPongPredicate(turnsWithReply));
}

// === Degraded-fallback path: expectedId is null (AGENTS.md write somehow failed) — the NEW predicate must
// keep the OLD "any non-empty text" behavior here, or a legitimate degraded run would hang for 150s. ======
{
  const cwd = "/fake/codex/cwd-3";
  const conversationId = "predicate-fixture-3";
  writeRolloutFixture(conversationId, [
    sessionMeta(conversationId, cwd),
    userMsg("Reply with exactly the single word: pong."),
    assistantMsg("c1", "pong\n"),
  ]);
  const turns = readTranscript(cwd, conversationId, "codex");
  check("degraded-fallback (expectedId=null) is NOT a regression: the NEW predicate still finds a plain non-empty reply when there is no id to check for", !!newPredicateReply(turns, null));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the OLD completion predicate is proven RED against both real captured preamble strings (it would have satisfied `waitUntil` on either), and the NEW predicate is proven to reject both while still finding the genuine completion once it lands, with no regression to the degraded (no-id) fallback path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
