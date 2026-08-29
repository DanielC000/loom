// Wiring regression test for card 8c13a023: codescapeSupervisor.stop() was ABSENT from the
// graceful-shutdown teardown sequence for months with no test asserting it should be there — this
// is that assertion, so a future refactor that drops the line fails loudly instead of going
// unnoticed a second time. Mirrors shutdown-snapshot.mjs's own wiring check (5): read the BUILT
// dist/index.js, structurally bound gracefulShutdown()'s body via the shared _graceful-region.mjs
// helper (no fixed byte budget — survives future teardown additions), and assert
// codescapeSupervisor.stop() is called inside that body, before the clean-stop process.exit(0).
// Static/structural — no daemon spawn, no real codescape, matches this file's sibling harness.
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

const indexJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js"), "utf8");
const codeOnly = stripComments(indexJs);
const region = gracefulShutdownRegion(codeOnly);

// Sanity: prove the stripper actually removes the fix's own comment mention of the symbol, so a
// positive result below can't be coming from the comment text this test was written to ignore.
check("sanity: the raw built file's COMMENT does mention codescapeSupervisor.stop (else stripping proves nothing)",
  /\/\/.*codescapeSupervisor\.stop/.test(indexJs));
check("sanity: comment-stripped text no longer contains that mention as a `//`-prefixed line",
  !stripComments("// codescapeSupervisor.stop() (card 8c13a023): this was ABSENT").includes("codescapeSupervisor"));

check("built daemon calls codescapeSupervisor.stop in real CODE (not merely mentioned in a comment)",
  /codescapeSupervisor\.stop\s*\(/.test(codeOnly));
check("the graceful-shutdown path invokes codescapeSupervisor.stop in CODE before its clean-stop exit",
  /codescapeSupervisor\.stop\s*\(/.test(region) && region.indexOf("codescapeSupervisor.stop") < region.indexOf("process.exit(0)"));

console.log(failures === 0
  ? "\n✅ ALL PASS — the shared graceful-shutdown path calls codescapeSupervisor.stop() in real code before its clean-stop exit (verified comment-stripped, so the adjacent explanatory comment mentioning the same symbol can't mask a dropped call), so the codescape serve child is reaped explicitly rather than depending on an undocumented platform default."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
