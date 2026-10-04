// Shared test util: structurally bound the built daemon's gracefulShutdown() body in dist/index.js.
//
// Both shutdown-snapshot.mjs and periodic-snapshot.mjs assert on the CONTENTS of gracefulShutdown()
// (snapshot-before-exit ordering; ≥2 clearInterval teardown calls). They used to slice a FIXED ~2200
// byte window from the anchor — brittle because `tsconfig` keeps comments (removeComments unset), so
// every teardown line/comment added inside the function pushed `process.exit(0)` past the budget and
// tripped a SPURIOUS failure. This bounds the region structurally instead: from the gracefulShutdown
// anchor to the END of its first `process.exit(...)` statement — the clean-stop exit that terminates
// the body. No hardcoded length, so it survives future teardown additions.
//
// The returned region INCLUDES the `process.exit(0)` call so callers can still assert ordering via
// `region.indexOf("process.exit(0)")`.
//
// Card 36afbbdd: comments are stripped from `indexJs` BEFORE either anchor search — unstripped, a comment
// mentioning the literal text "process.exit" anywhere between the two real anchors would truncate the
// region early (indexOf finds the comment's occurrence first), silently excluding the real teardown
// calls this region exists to bound; a comment mentioning "gracefulShutdown = (" could equally mislocate
// `start`. Every caller's own `region.indexOf(...)` ordering/count assertions inherit this same immunity
// for free, without each caller needing its own strip.
import { stripComments } from "./_strip-comments.mjs";

export function gracefulShutdownRegion(indexJs) {
  const codeOnly = stripComments(indexJs);
  const start = codeOnly.indexOf("gracefulShutdown = (");
  if (start < 0) return ""; // anchor gone — assertions on "" fail loudly, which is the point
  const exitIdx = codeOnly.indexOf("process.exit", start);
  if (exitIdx < 0) return codeOnly.slice(start); // no exit in the body — let the assertions fail loudly
  const closeParen = codeOnly.indexOf(")", exitIdx); // extend past `process.exit(0)` so it's inside the slice
  const end = closeParen >= 0 ? closeParen + 1 : codeOnly.length;
  return codeOnly.slice(start, end);
}

// Card f1366911 round 2: structurally bound the `for (const sig of HANDLED_SIGNALS) { ... }` registration
// loop in dist/index.js. Since card f1366911 moved HANDLED_SIGNALS' definition (and its "SIGINT" literal)
// out of index.ts into boot-shutdown-stub.ts, the literal string "SIGINT" no longer appears in dist/
// index.js at all — a scanner anchored on that literal silently finds nothing (indexOf returns -1) rather
// than failing loudly. Anchor on the registration loop itself instead, which f1366911's own
// boot-shutdown-registered-before-listen.mjs already proves is unique (exactly one such loop in the file).
// Bounded to the loop's own body (first "}" after the loop's opening "{") so a comment or unrelated code
// before/after the loop can't be swept in — the loop body is a single arrow-function statement with no
// nested braces, so the first "}" is genuinely the loop's close.
export function signalHandlerRegion(indexJs) {
  const codeOnly = stripComments(indexJs);
  const start = codeOnly.indexOf("HANDLED_SIGNALS) {");
  if (start < 0) return ""; // anchor gone — assertions on "" fail loudly, which is the point
  const openBrace = codeOnly.indexOf("{", start);
  if (openBrace < 0) return codeOnly.slice(start);
  const closeBrace = codeOnly.indexOf("}", openBrace);
  const end = closeBrace >= 0 ? closeBrace + 1 : codeOnly.length;
  return codeOnly.slice(start, end);
}
