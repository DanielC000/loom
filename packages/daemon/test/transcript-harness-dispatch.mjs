import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ec60d9c (multi-harness epic df1f94b0, Phase 1 follow-up): `sessions/transcript.ts`'s
// `readTranscript`/`resolveTranscriptFile`/`engineTranscriptExists`/`snapshotTranscript`/
// `readArchivedTranscript` used to be HARDCODED re-exports of `pty/claude-transcript.ts` — a codex
// session's transcript was structurally unreadable through this module no matter what `harness` a caller
// held, because nothing here ever looked at it. This test proves the fix: passing `harness:"codex"`
// actually reaches `pty/codex-transcript.ts`'s OWN parser/resolver (not a second copy of it — see
// `transcriptOpsFor`'s own doc, the ONE resolution site every function below goes through), while the
// default (harness omitted, or `"claude"`) stays byte-identical to the pre-fix behavior.
//
// Every positive assertion below is paired with a NEGATIVE CONTROL proving the dispatch is real, not
// vacuous: a codex id read with no `harness` (defaults to claude) must NOT find the codex fixture (claude's
// resolver scans a completely different root), and a claude id read with `harness:"codex"` must NOT find
// the claude fixture either. If `transcriptOpsFor` were a no-op (always claude), every "codex-harness"
// assertion below would read as an accidental pass on an untested instrument — the negative controls close
// that gap the same way `codex-transcript-parse.mjs`'s own negative controls do.
//
// ⚠️ Isolation: CODEX_HOME and LOOM_HOME are BOTH set to fresh temp dirs BEFORE importing any dist module
// that reads them at call time (codex-doctrine.ts's realCodexHome() re-reads CODEX_HOME fresh on every
// call — never cached at module load — and paths.ts's LOOM_HOME backs the archive store) — this test never
// touches the real ~/.codex or ~/.loom. The CLAUDE side of this test still writes into the real
// ~/.claude/projects (claude-transcript.ts has no HOME-override knob — same accepted convention
// `_transcript-fixture.mjs`'s own header documents), via the SAME shared fixture helper every other
// readTranscript test uses, so its cleanup discipline (leak-detection guard) is inherited unchanged.
//
// Run: 1) build (turbo builds shared first), 2) node test/transcript-harness-dispatch.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpCodexHome = mkdtempManaged("loom-transcript-dispatch-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
useOwnLoomHome("loom-transcript-dispatch-loomhome-");

const {
  readTranscript, resolveTranscriptFile, engineTranscriptExists, snapshotTranscript, readArchivedTranscript,
  deleteArchivedTranscript,
} = await import("../dist/sessions/transcript.js");

// ── codex fixture: a real rollout file, same confirmed shapes codex-transcript-parse.mjs builds ──
const codexConversationId = "dispatch-fixture-conversation-id";
const codexCwd = "/fake/codex/cwd";
const codexDayDir = path.join(tmpCodexHome, "sessions", "2026", "09", "07");
fs.mkdirSync(codexDayDir, { recursive: true });
const codexRolloutFile = path.join(codexDayDir, `rollout-2026-09-07T00-00-00-${codexConversationId}.jsonl`);
fs.writeFileSync(
  codexRolloutFile,
  [
    JSON.stringify({ type: "session_meta", payload: { session_id: codexConversationId, cwd: codexCwd, originator: "codex-tui" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", id: "r1", role: "user", content: [{ type: "input_text", text: "codex fixture prompt" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "codex fixture reply" } }),
  ].join("\n") + "\n",
);

withEngineTranscriptFixture(
  {
    prefix: "loom-transcript-dispatch-claude-",
    engineSessionId: "dispatch-fixture-claude-id",
    fileContent: JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "claude fixture reply" }] },
    }) + "\n",
  },
  (claudeCwd) => {
    const claudeEngineId = "dispatch-fixture-claude-id";

    // ── resolveTranscriptFile ──
    check("resolveTranscriptFile(codex id, harness:'codex') finds the rollout file",
      resolveTranscriptFile(codexCwd, codexConversationId, "codex") === codexRolloutFile);
    check("NEGATIVE CONTROL: resolveTranscriptFile(codex id) with NO harness (defaults claude) does NOT find it",
      resolveTranscriptFile(codexCwd, codexConversationId) === null);
    check("resolveTranscriptFile(claude id, harness:'claude') still resolves (unchanged default behavior)",
      resolveTranscriptFile(claudeCwd, claudeEngineId, "claude") !== null &&
      resolveTranscriptFile(claudeCwd, claudeEngineId, "claude") === resolveTranscriptFile(claudeCwd, claudeEngineId));
    check("NEGATIVE CONTROL: resolveTranscriptFile(claude id, harness:'codex') does NOT find it (codex scans its own root)",
      resolveTranscriptFile(claudeCwd, claudeEngineId, "codex") === null);

    // ── engineTranscriptExists ──
    check("engineTranscriptExists(codex id, 'codex') === true",
      engineTranscriptExists(codexCwd, codexConversationId, "codex") === true);
    check("NEGATIVE CONTROL: engineTranscriptExists(codex id) with no harness === false",
      engineTranscriptExists(codexCwd, codexConversationId) === false);

    // ── readTranscript ──
    const codexTurns = readTranscript(codexCwd, codexConversationId, "codex");
    check("readTranscript(codex id, 'codex') extracts the real codex turns (user + task_complete fallback)",
      codexTurns.length === 2 && codexTurns[0].text === "codex fixture prompt" && codexTurns[1].role === "assistant" && codexTurns[1].text === "codex fixture reply");
    check("NEGATIVE CONTROL: readTranscript(codex id) with no harness returns [] (proves the positive match above isn't vacuous)",
      readTranscript(codexCwd, codexConversationId).length === 0);
    const claudeTurns = readTranscript(claudeCwd, claudeEngineId, "claude");
    check("readTranscript(claude id, 'claude') matches the DEFAULT (harness-omitted) call — unchanged behavior",
      JSON.stringify(claudeTurns) === JSON.stringify(readTranscript(claudeCwd, claudeEngineId)) && claudeTurns.length === 1);
    check("NEGATIVE CONTROL: readTranscript(claude id, 'codex') returns [] (codex resolver never finds a claude JSONL)",
      readTranscript(claudeCwd, claudeEngineId, "codex").length === 0);

    // ── snapshotTranscript + readArchivedTranscript (round-trip through Loom's OWN archive store) ──
    const codexProjectId = "dispatch-codex-project";
    const codexSessionId = "dispatch-codex-session";
    const claudeProjectId = "dispatch-claude-project";
    const claudeSessionId = "dispatch-claude-session";
    try {
      check("snapshotTranscript(codex, harness:'codex') returns true (real write, via codex's OWN archive impl)",
        snapshotTranscript(codexCwd, codexConversationId, codexProjectId, codexSessionId, "codex") === true);
      const archivedCodexTurnsRight = readArchivedTranscript(codexProjectId, codexSessionId, "codex");
      check("readArchivedTranscript(..., 'codex') parses the archived codex snapshot correctly",
        archivedCodexTurnsRight.length === 2 && archivedCodexTurnsRight[1].text === "codex fixture reply");
      check("NEGATIVE CONTROL: readArchivedTranscript(same archive) with NO harness (claude parser) finds 0 turns — codex's wire format has no 'user'/'assistant' TOP-LEVEL type claude's parser looks for",
        readArchivedTranscript(codexProjectId, codexSessionId).length === 0);

      check("snapshotTranscript(claude, harness:'claude') returns true",
        snapshotTranscript(claudeCwd, claudeEngineId, claudeProjectId, claudeSessionId, "claude") === true);
      const archivedClaudeTurns = readArchivedTranscript(claudeProjectId, claudeSessionId, "claude");
      check("readArchivedTranscript(..., 'claude') parses the archived claude snapshot correctly",
        archivedClaudeTurns.length === 1 && archivedClaudeTurns[0].text === "claude fixture reply");
      check("readArchivedTranscript(same archive) with NO harness (defaults claude) matches — unchanged default behavior",
        JSON.stringify(archivedClaudeTurns) === JSON.stringify(readArchivedTranscript(claudeProjectId, claudeSessionId)));
    } finally {
      deleteArchivedTranscript(codexProjectId, codexSessionId);
      deleteArchivedTranscript(claudeProjectId, claudeSessionId);
    }
  },
);

await finishAndExit(failures === 0 ? 0 : 1);
