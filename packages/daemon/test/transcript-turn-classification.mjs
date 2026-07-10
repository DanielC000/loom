// Regression guard for transcript-audit findings (board cards 5cab5c2e, ff97fa2f):
//   1. A tool-result submission is written by the engine as a JSONL entry with type:"user" (the
//      Messages API models a tool_result as a "user"-role turn) even though no human typed it — it
//      must classify as role "tool_result", not "user".
//   2. A real human turn that's ONLY a pasted image (no caption text) must not vanish from the
//      transcript silently — it should render as a placeholder turn, not be dropped.
//   3. A tool_result whose nested content includes an "image" sub-block (e.g. a browser/Playwright
//      screenshot returned by a tool) must render an "[image]" marker, not just the bare
//      "-> tool result" placeholder with no indication an image came back.
//   4. A tool_use turn and its matching tool_result turn embed the SAME short correlation tag (the
//      tool_use_id's tail) in their "[tool]"/"-> tool result" markers, so they can be visually paired.
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
  // A tool result whose nested content is ONLY an image sub-block (e.g. a screenshot tool's return),
  // no text — must not collapse to the bare placeholder.
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }] }] } },
  // A matched tool_use / tool_result pair sharing a tool_use_id — both should carry the same tag.
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_pairId01", name: "Grep", input: { pattern: "x" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_pairId01", content: "matched" }] } },
];

withEngineTranscriptFixture(
  { prefix: "loom-transcript-classify-", engineSessionId, fileContent: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" },
  (cwd) => {
    const turns = readTranscript(cwd, engineSessionId);
    check("all 7 turns parsed (none silently dropped)", turns.length === 7);
    check("turn 0 is a real user turn", turns[0]?.role === "user" && turns[0]?.text === "hello");
    check("turn 1 is the assistant's tool_use", turns[1]?.role === "assistant" && turns[1].text.includes("[tool] Read"));
    check("turn 2 (engine-submitted tool result) is classified tool_result, NOT user", turns[2]?.role === "tool_result");
    check("turn 2 retains the tool result body", turns[2]?.text.includes("file contents"));
    check("turn 3 (image-only human turn) survives as a placeholder, not dropped", turns[3]?.role === "user" && turns[3]?.text === "[image]");
    check("turn 4 (tool result with an image sub-block) is classified tool_result", turns[4]?.role === "tool_result");
    check("turn 4 renders an [image] marker, not the bare placeholder", turns[4]?.text.includes("[image]") && turns[4]?.text !== "-> tool result");
    check("turn 5 (tool_use) embeds the short correlation tag", turns[5]?.text.includes("[tool] {pairId01} Grep"));
    check("turn 6 (matching tool_result) embeds the SAME correlation tag", turns[6]?.text.includes("-> tool result {pairId01}: matched"));
  },
);

console.log(failures === 0
  ? "\n✅ ALL PASS — tool-result submissions classify as tool_result, image-only turns (and tool-result images) don't vanish."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
