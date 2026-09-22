import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 353f6dc4 (multi-harness epic df1f94b0, Phase 1) — hermetic unit coverage for
// pty/codex-transcript.ts's rollout-JSONL parser. NOT a real-spawn test (see codex-version-real-spawn.mjs
// for that): parsing a file is pure JSON logic, not a subprocess/pty boundary, so a fixture file built
// from the REAL confirmed record shapes (see codex-transcript.ts's own header — three real rollout files
// this host's codex-cli 0.153.4 produced, structure inspected directly, never guessed from docs) is the
// right-sized test, per this project's own "hermetic, not ambient-host-dependent" testing doctrine.
//
// ⚠️ Isolation: this sets CODEX_HOME to a temp dir BEFORE importing the dist module — resolveTranscriptFile
// resolves its lookup root fresh on every call via codex-doctrine.ts's CODEX_HOME-aware realCodexHome()
// (never a module-load-time-cached os.homedir() call), so this test never touches the real ~/.codex —
// which, on a dev host, holds the OWNER's genuine personal Codex conversation history.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-transcript-parse.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-codex-transcript-");
process.env.CODEX_HOME = tmpHome;

const { parseTranscriptFile, resolveTranscriptFile } = await import("../dist/pty/codex-transcript.js");

// Lines mirror the REAL confirmed shapes byte-for-byte in structure (session_meta first, response_item
// role:"user"/"developer" with content[0].type:"input_text", event_msg task_complete carrying
// last_agent_message as the assistant-side fallback — see codex-transcript.ts's header for which parts
// of this are confirmed vs. a disclosed, unconfirmed gap).
const rolloutLines = [
  JSON.stringify({ type: "session_meta", payload: { session_id: "fixture-1", cwd: "/fake", originator: "codex-tui" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "developer", content: [{ type: "input_text", text: "system instructions" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r2", role: "user", content: [{ type: "input_text", text: "Reply with exactly the single word: pong." }] } }),
  // A malformed line (truncated JSON) must be SKIPPED, never thrown — mirrors claude-transcript.ts's own
  // per-line try/catch discipline.
  "{ this is not valid json",
  // An empty line must also be skipped.
  "",
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "pong", error: null } }),
];

const dayDir = path.join(tmpHome, "sessions", "2026", "09", "07");
fs.mkdirSync(dayDir, { recursive: true });
const rolloutFile = path.join(dayDir, "rollout-2026-09-07T00-00-00-fixture-conversation-id.jsonl");
fs.writeFileSync(rolloutFile, rolloutLines.join("\n") + "\n");

const turns = parseTranscriptFile(rolloutFile);
check("extracts exactly 3 turns (developer+user response_items + the task_complete fallback; malformed/empty lines skipped)", turns.length === 3);
check("developer role maps to 'system' (card 100c523f — the 4th bucket TranscriptTurn.role added so this doesn't silently mislabel as 'user')", turns[0]?.role === "system" && turns[0]?.text === "system instructions");
check("user response_item extracted verbatim", turns[1]?.role === "user" && turns[1]?.text === "Reply with exactly the single word: pong.");
check("task_complete.last_agent_message fallback surfaces as an assistant turn", turns[2]?.role === "assistant" && turns[2]?.text === "pong");

// A response_item with a role that is neither "assistant" nor "developer" must fall back to "user" —
// proves classifyRole's "system" mapping is specific to "developer" and not a blanket default, so the
// PASS above (turns[0].role === "system") isn't vacuously true from a broken classifier that always
// returns "system".
const unknownRoleFile = path.join(dayDir, "rollout-2026-09-07T00-02-00-unknown-role.jsonl");
fs.writeFileSync(unknownRoleFile, JSON.stringify({ type: "response_item", payload: { type: "message", id: "r4", role: "some_future_role", content: [{ type: "input_text", text: "unclassified" }] } }) + "\n");
check("an unrecognized role falls back to 'user', not 'system' (negative control on the developer->system mapping)", parseTranscriptFile(unknownRoleFile)[0]?.role === "user");

// A response_item with NO matching content-block type (e.g. a future item type this parser doesn't
// recognize) must not crash and must not add a spurious blank turn.
const unrecognizedContentFile = path.join(dayDir, "rollout-2026-09-07T00-01-00-unrecognized.jsonl");
fs.writeFileSync(unrecognizedContentFile, JSON.stringify({ type: "response_item", payload: { type: "message", id: "r3", role: "user", content: [{ type: "some_future_type", text: "ignored" }] } }) + "\n");
check("an unrecognized content-block type produces no turn (never a crash, never a blank turn)", parseTranscriptFile(unrecognizedContentFile).length === 0);
check("parseTranscriptFile on a nonexistent file returns [] rather than throwing (negative control)", parseTranscriptFile(path.join(tmpHome, "does-not-exist.jsonl")).length === 0);

// resolveTranscriptFile: locate-by-id-substring under the dated tree, isolated to tmpHome via CODEX_HOME.
const resolved = resolveTranscriptFile("/fake", "fixture-conversation-id");
check("resolveTranscriptFile locates a rollout file nested under sessions/YYYY/MM/DD by id substring", resolved === rolloutFile);
check("resolveTranscriptFile returns null for an id that genuinely doesn't exist (negative control, proving the positive match above isn't vacuous)", resolveTranscriptFile("/fake", "no-such-id-anywhere") === null);

// Card ca9c4e34: the final-assistant-turn double-render. The pilot's own duplicate is a READER defect, not
// a write-side one — nothing in the rollout JSONL is byte-duplicated. It's produced by the parser's own two
// independent assistant-extraction paths (a real `response_item` with role:"assistant", and the
// `task_complete.last_agent_message` DEFENSIVE FALLBACK — see this parser's own header, which documents the
// fallback as intended ONLY "when [an assistant reply] never appears as its own response_item") both firing
// for the SAME turn. This fixture is entirely SYNTHETIC (no live codex spawn is available in this project —
// see the card) but is built from a real, in-repo, discriminating fact: `classifyRole` already maps
// `role:"assistant"` on a response_item straight to `"assistant"` (this file's own header discloses that
// shape was never OBSERVED on this host's trivial one-word pilot probe, but the code path exists and is
// exercised nowhere else in this file before this addition) alongside the pre-existing, unconditional
// task_complete fallback — so a turn that legitimately gets BOTH produces the exact duplicate shape the card
// describes, with no fabricated JSONL record types.
const duplicateSourceFile = path.join(dayDir, "rollout-2026-09-07T00-03-00-duplicate-source.jsonl");
fs.writeFileSync(duplicateSourceFile, [
  JSON.stringify({ type: "session_meta", payload: { session_id: "fixture-dup", cwd: "/fake", originator: "codex-tui" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "user", content: [{ type: "input_text", text: "say hi" }] } }),
  // The real assistant reply, captured as its own response_item — the shape this file's header discloses
  // was never observed on THIS host's trivial pilot, but which classifyRole already handles.
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r2", role: "assistant", content: [{ type: "output_text", text: "hello there" }] } }),
  // task_complete's own last_agent_message ECHOES that same final reply — this is what the fallback exists
  // to surface only when NO response_item already captured it; here one did.
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "hello there", error: null } }),
].join("\n") + "\n");
const dupTurns = parseTranscriptFile(duplicateSourceFile);
check(
  "a turn whose assistant reply is captured by BOTH a response_item and the task_complete fallback produces exactly ONE assistant turn, not two byte-identical ones (card ca9c4e34 — this assertion is a NEGATIVE/ABSENCE check: see the negative-control proof in this task's worker_report for confirmation it reds against the pre-fix parser)",
  dupTurns.filter((t) => t.role === "assistant").length === 1,
);
check("the surviving assistant turn is the real response_item text, not a second copy", dupTurns.some((t) => t.role === "assistant" && t.text === "hello there"));

// The fallback must still fire when NO response_item ever captured the assistant's reply (the original,
// still-load-bearing case the first fixture in this file already covers structurally — this is an explicit,
// adjacent negative control proving the fix above didn't just always suppress the fallback).
const fallbackOnlyFile = path.join(dayDir, "rollout-2026-09-07T00-04-00-fallback-only.jsonl");
fs.writeFileSync(fallbackOnlyFile, [
  JSON.stringify({ type: "session_meta", payload: { session_id: "fixture-fallback-only", cwd: "/fake", originator: "codex-tui" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "user", content: [{ type: "input_text", text: "say hi" }] } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "hi back", error: null } }),
].join("\n") + "\n");
const fallbackOnlyTurns = parseTranscriptFile(fallbackOnlyFile);
check(
  "with no assistant response_item at all, the task_complete fallback still surfaces exactly one assistant turn (negative control — the dedupe fix above must not blanket-suppress the fallback)",
  fallbackOnlyTurns.filter((t) => t.role === "assistant").length === 1 && fallbackOnlyTurns.some((t) => t.role === "assistant" && t.text === "hi back"),
);

// A SECOND turn in the same file must not stay suppressed by the first turn's own response_item — proves
// the fix is scoped PER-TURN (reset on task_started), not a file-wide "saw an assistant response_item once"
// latch that would silently eat a later turn's own legitimate fallback-only reply.
const twoTurnsFile = path.join(dayDir, "rollout-2026-09-07T00-05-00-two-turns.jsonl");
fs.writeFileSync(twoTurnsFile, [
  JSON.stringify({ type: "session_meta", payload: { session_id: "fixture-two-turns", cwd: "/fake", originator: "codex-tui" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "user", content: [{ type: "input_text", text: "first" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r2", role: "assistant", content: [{ type: "output_text", text: "first reply" }] } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "first reply", error: null } }),
  JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r3", role: "user", content: [{ type: "input_text", text: "second" }] } }),
  // Second turn's reply is captured ONLY via the fallback (no response_item) — must still surface.
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t2", last_agent_message: "second reply", error: null } }),
].join("\n") + "\n");
const twoTurnsAssistant = parseTranscriptFile(twoTurnsFile).filter((t) => t.role === "assistant");
check(
  "per-turn scoping: turn 1 dedupes to one assistant turn AND turn 2's fallback-only reply still surfaces (not silently eaten by turn 1's own response_item)",
  twoTurnsAssistant.length === 2 && twoTurnsAssistant[0]?.text === "first reply" && twoTurnsAssistant[1]?.text === "second reply",
);

// Manager review (card ca9c4e34): the guard must not depend on `task_started` being present for every
// turn — if it's ever absent, a flag reset ONLY on `task_started` stays `true` from an earlier turn and
// silently EATS a later fallback-only reply, converting the original duplicate defect into a WORSE loss
// defect (this repo's own fail-toward-duplicate-never-a-loss principle, docs/decisions/88f11385). This
// fixture has NO `task_started` between the two turns at all — only the guard resetting on `task_complete`
// itself (regardless of whether it pushed) can close this.
const noTaskStartedFile = path.join(dayDir, "rollout-2026-09-07T00-06-00-no-task-started.jsonl");
fs.writeFileSync(noTaskStartedFile, [
  JSON.stringify({ type: "session_meta", payload: { session_id: "fixture-no-task-started", cwd: "/fake", originator: "codex-tui" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "user", content: [{ type: "input_text", text: "first" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r2", role: "assistant", content: [{ type: "output_text", text: "first reply" }] } }),
  // Correctly suppressed (response_item already captured turn 1's reply) — but with NO task_started
  // anywhere in this file, a task_started-only reset leaves the flag stuck `true` forever afterward.
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "first reply", error: null } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", id: "r3", role: "user", content: [{ type: "input_text", text: "second" }] } }),
  // Turn 2's reply is captured ONLY via the fallback — must still surface even though no task_started
  // ever ran between the two turns.
  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t2", last_agent_message: "second reply", error: null } }),
].join("\n") + "\n");
const noTaskStartedAssistant = parseTranscriptFile(noTaskStartedFile).filter((t) => t.role === "assistant");
check(
  "no task_started anywhere: turn 1 still dedupes to one assistant turn AND turn 2's fallback-only reply still surfaces — NOT silently dropped (card ca9c4e34 manager review; this assertion is a NEGATIVE/ABSENCE check on turn 1 combined with a POSITIVE presence check on turn 2, so a broken guard can fail it in either direction)",
  noTaskStartedAssistant.length === 2 && noTaskStartedAssistant[0]?.text === "first reply" && noTaskStartedAssistant[1]?.text === "second reply",
);

await finishAndExit(failures === 0 ? 0 : 1);
