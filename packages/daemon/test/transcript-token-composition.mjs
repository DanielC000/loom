// card 02cc2fbb — unit test for scripts/transcript-token-composition.mjs on a tiny synthetic fixture.
// The fixture is hand-built so every expected number is computable by hand (see EXPECTED below).
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("ttc-");
const mod = await import("../scripts/transcript-token-composition.mjs");

const home = process.env.LOOM_HOME;
const root = path.join(home, "projects");
const projDir = path.join(root, "C--x-proj-abc12345");
fs.mkdirSync(projDir, { recursive: true });

const usage = (inp, read, create) => ({ input_tokens: inp, cache_read_input_tokens: read, cache_creation_input_tokens: create });
const asst = (id, model, u, content) => JSON.stringify({ type: "assistant", message: { id, model, usage: u, content } });
const user = (content) => JSON.stringify({ type: "user", message: { role: "user", content } });

// 4 calls (m1 is written as TWO records — must count once). First call ctx = 100.
const lines = [
  JSON.stringify({ type: "attachment", rendered: [{ content: "Contents of /r/CLAUDE.md (project instructions):\n" + "A".repeat(100) + "\n</system-reminder>" }] }),
  user([{ type: "text", text: "kickoff\nContents of /r/CLAUDE.md (project instructions):\n" + "C".repeat(400) + "\n</system-reminder>\n[loom:project-memory] " + "M".repeat(200) }]),
  asst("m1", "opus", usage(0, 0, 100), [{ type: "thinking", thinking: "t" }]),
  asst("m1", "opus", usage(0, 0, 100), [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
  user([{ type: "tool_result", tool_use_id: "t1", content: "B".repeat(80) }]),
  asst("m2", "opus", usage(0, 100, 20), [{ type: "tool_use", id: "t2", name: "Read", input: {} }]),
  user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "R".repeat(40) }, { type: "image", source: {} }] }]),
  asst("m3", "sonnet", usage(0, 120, 60000), [{ type: "text", text: "x" }]), // cache rebuild (>50K write)
  user([{ type: "tool_result", tool_use_id: "t9", content: "Z".repeat(8) }]), // after m3
  asst("m4", "sonnet", usage(0, 60120, 10), [{ type: "text", text: "y" }]),
];
const raw = lines.join("\n") + "\n{torn";
const file = path.join(projDir, "s1.jsonl");
fs.writeFileSync(file, raw);

const s = mod.analyzeSession(raw);
// EXPECTED: calls=4, denominator = 100 + 120 + 60120 + 60130 = 120470
assert.equal(s.calls, 4, "message.id de-dup: two records of m1 are ONE call");
assert.equal(s.inputTokens, 100 + 120 + 60120 + 60130);
assert.equal(s.firstCallCtx, 100);
assert.equal(s.rebuilds, 1, "only m3 (non-first, write 60000 > 50000) is a rebuild");
// Bash result (80 chars) appears after 1 call -> 3 later calls; Read (40 chars, image excluded) after 2 calls -> 2 later.
assert.equal(s.charTurns.bash, 80 * 3);
assert.equal(s.charTurns.read, 40 * 2);
assert.equal(s.charTurns.otherTool, 8 * 1, "unknown tool id falls to otherTool, 1 later call");
assert.equal(s.kickoffCharTurns.claudeMd, (400 + 100) * 4, "CLAUDE.md chars (user text + attachment record) x all calls");
assert.ok(s.kickoffCharTurns.memory >= 200 * 4);
assert.deepEqual(s.models, { opus: 2, sonnet: 2 });

// Aggregate + the report names denominator, window and method.
const r = mod.aggregate([s]);
assert.equal(r.denominatorInputTokens, 120470);
assert.equal(r.firstCallShare, (100 * 4) / 120470);
assert.ok(Math.abs(r.shares.bash - 240 / 4 / 120470) < 1e-12);

// End to end through run(): window + project filter + file listing.
const text = mod.run([`--root=${root}`, "--project=abc12345", "--days=1"]);
assert.match(text, /Denominator: 120470 input tokens/);
assert.match(text, /Window: /);
assert.match(text, /chars\/4/);
assert.match(text, /1 sessions analysed of 1 in window/);
assert.match(mod.run([`--root=${root}`, "--project=nomatch"]), /0 sessions analysed of 0/);
assert.throws(() => mod.run([]), /--root/, "no default root");
// Window excludes an old file.
const old = new Date(Date.now() - 30 * 86_400_000);
fs.utimesSync(file, old, old);
assert.match(mod.run([`--root=${root}`, "--days=7"]), /0 sessions analysed of 0/);

// Read-only: the fixture file is byte-identical after all of the above.
assert.equal(fs.readFileSync(file, "utf8"), raw);

console.log("transcript-token-composition: OK");
