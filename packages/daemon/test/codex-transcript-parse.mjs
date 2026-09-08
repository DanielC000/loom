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

await finishAndExit(failures === 0 ? 0 : 1);
