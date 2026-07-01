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
export function gracefulShutdownRegion(indexJs) {
  const start = indexJs.indexOf("gracefulShutdown = (");
  if (start < 0) return ""; // anchor gone — assertions on "" fail loudly, which is the point
  const exitIdx = indexJs.indexOf("process.exit", start);
  if (exitIdx < 0) return indexJs.slice(start); // no exit in the body — let the assertions fail loudly
  const closeParen = indexJs.indexOf(")", exitIdx); // extend past `process.exit(0)` so it's inside the slice
  const end = closeParen >= 0 ? closeParen + 1 : indexJs.length;
  return indexJs.slice(start, end);
}
