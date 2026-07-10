// Regression guard for two transcript-audit findings (board card 5cab5c2e):
//   1. A tool-result submission is written by the engine as a JSONL entry with type:"user" (the
//      Messages API models a tool_result as a "user"-role turn) even though no human typed it — it
//      must classify as role "tool_result", not "user".
//   2. A real human turn that's ONLY a pasted image (no caption text) must not vanish from the
//      transcript silently — it should render as a placeholder turn, not be dropped.
// Deterministic, no daemon/claude. Run: node test/transcript-turn-classification.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTranscript } from "../dist/sessions/transcript.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-transcript-classify-"));
const cwd = path.join(tmpRoot, "repo");
fs.mkdirSync(cwd, { recursive: true });

// readTranscript resolves the engine transcript under the user's REAL ~/.claude/projects (Claude's
// on-disk dir-encoding), NOT under tmpRoot — so this fixture dir must be cleaned up explicitly in
// teardown (below) or the hermetic suite leaks a stray dir into the user's real Claude home.
const engineDir = path.join(os.homedir(), ".claude", "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(engineDir, { recursive: true });
const engineSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const file = path.join(engineDir, `${engineSessionId}.jsonl`);

try {
  const lines = [
    // A real human text turn.
    { type: "user", message: { role: "user", content: "hello" } },
    // The assistant calls a tool.
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] } },
    // The engine submits the tool's result back — type:"user", but NOT human-authored.
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } },
    // A real human turn that's ONLY a pasted screenshot, no caption.
    { type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const turns = readTranscript(cwd, engineSessionId);
  check("all 4 turns parsed (none silently dropped)", turns.length === 4);
  check("turn 0 is a real user turn", turns[0]?.role === "user" && turns[0]?.text === "hello");
  check("turn 1 is the assistant's tool_use", turns[1]?.role === "assistant" && turns[1].text.includes("[tool] Read"));
  check("turn 2 (engine-submitted tool result) is classified tool_result, NOT user", turns[2]?.role === "tool_result");
  check("turn 2 retains the tool result body", turns[2]?.text.includes("file contents"));
  check("turn 3 (image-only human turn) survives as a placeholder, not dropped", turns[3]?.role === "user" && turns[3]?.text === "[image]");
} finally {
  // Clean up BOTH the tmpdir fixture AND the real-~/.claude/projects mangled dir this test created —
  // a thrown check mid-run must not leak the latter into the user's actual Claude home.
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(engineDir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tool-result submissions classify as tool_result, image-only turns don't vanish."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
