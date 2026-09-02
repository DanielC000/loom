// Wiring regression test for card 8c13a023: codescapeSupervisor.stop() was ABSENT from the
// graceful-shutdown teardown sequence for months with no test asserting it should be there — this
// is that assertion, so a future refactor that drops the line fails loudly instead of going
// unnoticed a second time. Mirrors shutdown-snapshot.mjs's own wiring check (5): read the BUILT
// dist/index.js, structurally bound gracefulShutdown()'s body via the shared _graceful-region.mjs
// helper (no fixed byte budget — survives future teardown additions), and assert
// codescapeSupervisor.stop() is reached from inside that body, before the clean-stop process.exit(0).
// Static/structural — no daemon spawn, no real codescape, matches this file's sibling harness.
//
// Card d671f1b8: the real `codescapeSupervisor.stop()` call moved OUT of gracefulShutdown's own body
// and into a shared `flushVaultsAndStopCodescape` function (so daemon_restart's exit path can call the
// SAME cleanup) — gracefulShutdown's body now just calls that function. So this no longer asserts the
// literal call text lives INSIDE the gracefulShutdown region; it asserts the region calls
// flushVaultsAndStopCodescape, AND that flushVaultsAndStopCodescape's own body genuinely contains the
// real codescapeSupervisor.stop() call — same anti-regression guarantee (a dropped call in EITHER
// place fails loudly), just spanning two anchors instead of one.
//
// MUST match in CODE POSITION, not raw text: the fix's own explanatory comment above the real call
// literally contains the substring "codescapeSupervisor.stop() (card 8c13a023): ..." — a naive regex
// against the raw file matches that comment and stays green even if the real call below it is
// deleted, which is exactly the silent regression this test exists to catch. Comments are stripped
// BEFORE either assertion runs, using the same per-line discipline as exit-code-verdict-guard.mjs /
// harness-adapter-claude-literal-guard.mjs (a line inside a `/* ... */` block, or whose trimmed text
// starts with `//`/`*`, is excluded; a trailing `//` comment on an otherwise-real code line is cut).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gracefulShutdownRegion } from "./_graceful-region.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function stripComments(source) {
  const state = { inBlock: false };
  const kept = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (state.inBlock) {
      if (trimmed.includes("*/")) state.inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) state.inBlock = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue; // JSDoc/block-comment continuation
    kept.push(raw.replace(/(?<!:)\/\/.*/, ""));
  }
  return kept.join("\n");
}

// Card d671f1b8: the shared cleanup function's own body region — from its `const
// flushVaultsAndStopCodescape = (` anchor to the next top-level statement (`sessions.setShutdownCleanup(`,
// which immediately follows it in source, both in this file and in the compiled output — tsc doesn't
// reorder a simple const-then-call sequence). No fixed byte budget, same reasoning as
// gracefulShutdownRegion: survives future comment/line additions inside the function.
function flushCleanupRegion(codeOnly) {
  const start = codeOnly.indexOf("flushVaultsAndStopCodescape = (");
  if (start < 0) return ""; // anchor gone — assertions on "" fail loudly, which is the point
  const end = codeOnly.indexOf("sessions.setShutdownCleanup(", start);
  return end >= 0 ? codeOnly.slice(start, end) : codeOnly.slice(start);
}

const indexJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"), "utf8");
const codeOnly = stripComments(indexJs);
const gracefulRegion = gracefulShutdownRegion(codeOnly);
const cleanupRegion = flushCleanupRegion(codeOnly);

// Sanity: prove the stripper actually removes the fix's own comment mention of the symbol, so a
// positive result below can't be coming from the comment text this test was written to ignore.
check("sanity: the raw built file's COMMENT does mention codescapeSupervisor.stop (else stripping proves nothing)",
  /\/\/.*codescapeSupervisor\.stop/.test(indexJs));
check("sanity: comment-stripped text no longer contains that mention as a `//`-prefixed line",
  !stripComments("// codescapeSupervisor.stop() (card 8c13a023): this was ABSENT").includes("codescapeSupervisor"));

check("built daemon calls codescapeSupervisor.stop in real CODE (not merely mentioned in a comment)",
  /codescapeSupervisor\.stop\s*\(/.test(codeOnly));
check("the shared flushVaultsAndStopCodescape function's own body genuinely contains the codescapeSupervisor.stop call (not just mentioned nearby)",
  cleanupRegion !== "" && /codescapeSupervisor\.stop\s*\(/.test(cleanupRegion));
check("the graceful-shutdown path invokes flushVaultsAndStopCodescape in CODE before its clean-stop exit",
  /flushVaultsAndStopCodescape\s*\(\s*\)/.test(gracefulRegion) &&
    gracefulRegion.indexOf("flushVaultsAndStopCodescape()") < gracefulRegion.indexOf("process.exit(0)"));

console.log(failures === 0
  ? "\n✅ ALL PASS — the shared graceful-shutdown path calls flushVaultsAndStopCodescape() before its clean-stop exit, and that shared function's own body genuinely calls codescapeSupervisor.stop() in real code (verified comment-stripped, so the adjacent explanatory comment mentioning the same symbol can't mask a dropped call), so the codescape serve child is reaped explicitly rather than depending on an undocumented platform default."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
