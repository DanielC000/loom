// Regression guard for two transcript-audit findings (board card 5cab5c2e):
//   1. A tool-result submission is written by the engine as a JSONL entry with type:"user" (the
//      Messages API models a tool_result as a "user"-role turn) even though no human typed it — it
//      must classify as role "tool_result", not "user".
//   2. A real human turn that's ONLY a pasted image (no caption text) must not vanish from the
//      transcript silently — it should render as a placeholder turn, not be dropped.
// Deterministic, no daemon/claude. Run: node test/transcript-turn-classification.mjs
import { readTranscript } from "../dist/sessions/transcript.js";
import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const engineSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
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

withEngineTranscriptFixture(
  { prefix: "loom-transcript-classify-", engineSessionId, fileContent: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" },
  (cwd) => {
    const turns = readTranscript(cwd, engineSessionId);
    check("all 4 turns parsed (none silently dropped)", turns.length === 4);
    check("turn 0 is a real user turn", turns[0]?.role === "user" && turns[0]?.text === "hello");
    check("turn 1 is the assistant's tool_use", turns[1]?.role === "assistant" && turns[1].text.includes("[tool] Read"));
    check("turn 2 (engine-submitted tool result) is classified tool_result, NOT user", turns[2]?.role === "tool_result");
    check("turn 2 retains the tool result body", turns[2]?.text.includes("file contents"));
    check("turn 3 (image-only human turn) survives as a placeholder, not dropped", turns[3]?.role === "user" && turns[3]?.text === "[image]");
  },
);

console.log(failures === 0
  ? "\n✅ ALL PASS — tool-result submissions classify as tool_result, image-only turns don't vanish."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
