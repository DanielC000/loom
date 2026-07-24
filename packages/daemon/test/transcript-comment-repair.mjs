// Repro + regression guard for the loom-audit comment-mangling bug: the real Claude Code engine (v2.1.202,
// Windows) occasionally writes its OWN on-disk JSONL with a Grep/Read tool-result hunk's LAST context line
// collapsed — a leading `// ` -> `\ `, a leading `/**` -> `\**` — even though the actual source file is
// clean (confirmed via a live repro: the same line read back with `Read` is byte-correct `//`/`/**`; only
// the engine's captured JSONL carries the corruption). Loom's transcript.ts never touches this text before
// parsing (straight fs.readFileSync + JSON.parse), so the fix lives at the READ side: repair the known
// corruption so the loom-audit surface (transcript_read) hands back verbatim comment prefixes regardless of
// what the engine wrote. Deterministic, no daemon/claude. Run: node test/transcript-comment-repair.mjs
import { readTranscript } from "../dist/sessions/transcript.js";
import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A tool_result payload mimicking a real Grep -C hunk: a MANGLED `//` line, a MANGLED `/**` line, a
// CLEAN `//` line (must stay byte-identical — no false-positive repair), and a genuine mid-line
// Windows-path backslash (must also stay untouched — the repair only fires on a LEADING marker).
const grepHunk = [
  "1902-    // keep an unattended worker pty from wedging on a pager / credential prompt.",
  "1903-    const env = buildSpawnEnv(process.env, opts.sessionEnv);",
  "1904-    \\ Obsidian auto-start: when the resolved config turned it on (LOOM_OBSIDIAN_AUTOSTART rode in via",
  "--",
  "40-/** Every recognized command name lives in this table. */",
  "41-\\** Every recognized command name lives in this OTHER table.",
  "42-const p = \"C:\\Users\\alex\\file.ts\"; // a real mid-line backslash — must NOT be touched",
].join("\n");

const engineSessionId = "11111111-2222-3333-4444-555555555555";
const line = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: grepHunk }] },
});

withEngineTranscriptFixture(
  { prefix: "loom-transcript-repair-", engineSessionId, fileContent: line + "\n" },
  (cwd) => {
    const turns = readTranscript(cwd, engineSessionId);
    check("exactly one turn parsed", turns.length === 1);
    const text = turns[0]?.text ?? "";

    check("mangled leading `//` is restored", text.includes("// Obsidian auto-start: when the resolved config"));
    check("no residual bare backslash before 'Obsidian'", !text.includes("\\ Obsidian"));
    check("mangled leading `/**` is restored", text.includes("/** Every recognized command name lives in this OTHER table."));
    check("no residual bare backslash before the second 'Every'", !text.includes("\\** Every recognized command name lives in this OTHER"));
    check("an already-clean `//` line is untouched (no false positive)", text.includes("/** Every recognized command name lives in this table. */"));
    check("a genuine mid-line Windows-path backslash is left alone", text.includes('"C:\\Users\\alex\\file.ts"'));
  },
);

console.log(failures === 0
  ? "\n✅ ALL PASS — loom-audit transcript_read restores a mangled `//`/`/**` comment prefix without touching real content."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
