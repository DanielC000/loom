// Context-size measurement test (PR #11). HERMETIC like orch-model.mjs: no daemon, no real
// claude. Writes fixture transcript JSONLs at engineTranscriptPath(tmpCwd, id) — a unique temp
// cwd hashes to a collision-free dir under ~/.claude/projects, removed in finally — and asserts
// readContextStats reads the LAST assistant turn's usage. Run: 1) build daemon, 2) node test/context-stats.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineTranscriptPath } from "../dist/sessions/transcript.js";
import { readContextStats } from "../dist/sessions/context.js";
import { contextWindowForModel } from "../../shared/dist/index.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Unique temp cwd → collision-free transcript dir under the real ~/.claude/projects.
const cwd = path.join(os.tmpdir(), `loom-ctx-${Date.now()}`);
const dir = path.dirname(engineTranscriptPath(cwd, "seed"));
fs.mkdirSync(dir, { recursive: true });
const writeFixture = (id, lines) =>
  fs.writeFileSync(engineTranscriptPath(cwd, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

try {
  // (a)/(b): two assistant turns with usage; meta lines interleaved. Must read the LAST usage.
  writeFixture("multi", [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "first" }], model: "claude-sonnet-4-6", usage: { input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 } } },
    { type: "summary", summary: "ignore me" },
    { type: "user", message: { content: "more" } },
    { type: "assistant", message: { content: [{ type: "text", text: "second" }], model: "claude-opus-4-8", usage: { input_tokens: 2000, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 11 } } },
  ]);
  const s = readContextStats(cwd, "multi");
  check("(a) inputTokens = LAST assistant usage summed (2000+300+40=2340), not the earlier 115", s?.inputTokens === 2340);
  check("(b) turns = assistant-line count (2)", s?.turns === 2);
  check("(e) model = LAST assistant line's model (claude-opus-4-8)", s?.model === "claude-opus-4-8");
  check("(f) contextWindowForModel(opus-4-8) = 1M (the 4.x 1M-beta window, not 200k)", contextWindowForModel(s?.model) === 1_000_000);

  // usage without cache fields → input_tokens only (num() defaults the absent caches to 0).
  writeFixture("nocache", [
    { type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: 500, output_tokens: 3 } } },
  ]);
  const nc = readContextStats(cwd, "nocache");
  check("usage without cache fields → input_tokens only (500)", nc?.inputTokens === 500);
  check("(g) no model on the line → model null → window falls back to 200k", nc?.model === null && contextWindowForModel(nc?.model) === 200_000);

  // (c) missing transcript file → null.
  check("(c) missing transcript file → null", readContextStats(cwd, "no-such-id") === null);

  // (d) assistant lines present but none carry usage → null (even though turns would be > 0).
  writeFixture("nousage", [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "no usage here" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "still none" }] } },
  ]);
  check("(d) assistant lines but no usage → null", readContextStats(cwd, "nousage") === null);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — readContextStats reads the latest turn's context occupancy."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
