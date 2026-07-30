// Card 9fea4196 — a Windows-only test proving the ADAPTED `windowsCommandLine` (pty/host.ts) stays
// behaviourally equivalent to node-pty's REAL `argsToCommandLine`, for the array-args path our
// production code actually uses. windowsCommandLine is a hand-maintained ADAPTATION of a moving
// internal dependency (see its own doc in pty/host.ts for why it's copied, not imported, in
// PRODUCTION) — nothing else re-checks it against the real thing. This test closes that gap by
// importing node-pty's own `argsToCommandLine` (a test is exactly where coupling to an internal
// surface is cheap: a break here is a signal, not an outage) and asserting byte-equality of OUTPUT
// across a corpus DERIVED from the branches `argsToCommandLine` itself special-cases — not fuzzed, not
// hand-picked. See §DERIVATION below for the rule. This is ADDITIVE to
// test/spawn-command-line-preflight.mjs (which covers the preflight wiring/messages/real-spawn
// boundary), not a replacement for it.
//
// ⛔ Do NOT "fix" windowsCommandLine's quoting logic off a failure here without re-reading card
// 9fea4196 first — as of this test's authorship it was measured byte-identical to node-pty@1.1.0 over
// 13 independently-checked adversarial shapes; this file exists to catch a FUTURE drift, not a
// present one.
//
// FEASIBILITY (verified live, card 9fea4196 — do not re-derive): node-pty's package.json has NO
// `exports` field, so a deep `require("node-pty/lib/windowsPtyAgent.js")` resolves and returns a
// callable `argsToCommandLine`. If node-pty later ADDS an `exports` map, this import breaks — loudly,
// which is the point (a red TEST instead of a silently-stale production adaptation nobody re-checks).
//
// §DERIVATION — argsToCommandLine's array-args path branches on a CLOSED, TINY syntactic alphabet:
// space, tab, `"`, `\`, the empty string, and two enclosing-quote predicates
// (hasLopsidedEnclosingQuote / hasNoEnclosingQuotes). That's finite and readable straight off the
// implementation, so the corpus below is one case per branch (plus one composite), not a fuzzed or
// hand-picked list — each case's comment names which branch it exercises, so a future reader can tell
// why this many cases and not more or fewer. The corpus is the INPUT set only: expected OUTPUT is
// never hand-computed here (an easy place to make the exact arithmetic mistake this test exists to
// catch) — it comes from actually running node-pty's real function on each input.
//
// WINDOWS-ONLY, LOUDLY: node-pty's quoting is Windows-specific (the CommandLineToArgvW convention)
// with no POSIX analogue to compare against, so this whole file is gated on process.platform, up
// front. On a non-Windows runner it prints an explicit "SKIP" line and process.exit(0)s WITHOUT ever
// reaching the `check(`/PASS machinery below — this file never prints "PASS" or "ALL PASS" on a
// platform that didn't run the check, so a skip is distinguishable from a pass by grep (not just by a
// human reading the log): "SKIP" appears, "PASS"/"ALL PASS" never do. A green tick on the one axis
// that matters, from a platform that never ran the check, would be worse than no test at all.
//
// Run: 1) build (turbo builds shared first), 2) node test/node-pty-quoting-parity.mjs
import { createRequire } from "node:module";

if (process.platform !== "win32") {
  console.log(
    "SKIP  node-pty-quoting-parity — Windows-only (process.platform !== 'win32' here); node-pty's " +
    "argsToCommandLine is Windows-specific quoting logic (CommandLineToArgvW convention) with no " +
    "POSIX analogue to compare parity against. Nothing below this line runs on this platform — see " +
    "this file's header for why a silent skip-as-a-pass would be worse than no test at all.",
  );
  process.exit(0);
}

const { windowsCommandLine } = await import("../dist/pty/host.js");
const require = createRequire(import.meta.url);
// Deliberately the internal `lib/` path, not the package's public entrypoint — see the FEASIBILITY
// note above. Only THIS test couples to it; production stays on its own decoupled adaptation.
const { argsToCommandLine } = require("node-pty/lib/windowsPtyAgent.js");
const nodePtyVersion = require("node-pty/package.json").version;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// DoD 6: record the exact node-pty version this run validated against, in the test's own output — so
// a dependency bump is legible straight in a CI log, not something a reader has to go infer from
// package.json separately.
console.log(`[node-pty-quoting-parity] validating windowsCommandLine against the REAL node-pty@${nodePtyVersion} argsToCommandLine (installed) — daemon package.json currently pins "node-pty": "^1.1.0"`);

// --- DoD 4: positive-control the comparator BEFORE trusting any of its "match" verdicts below. An
// always-equal comparator would pass every case silently — this card's own failure shape, reproduced
// inside its own fix, is exactly what this guards against. Prove plain `===` string comparison can
// report BOTH a genuine mismatch and a genuine match on two known inputs, first. ---
check("comparator positive control: DETECTS a real mismatch between two different strings", ("abc" === "abd") === false);
check("comparator positive control: reports a match for identical strings (sanity)", ("abc" === "abc") === true);

// A parity case runs BOTH implementations on the IDENTICAL (file, args) input and asserts
// byte-equality of the full OUTPUT string (DoD 3 — not length-equality: two different strings of
// equal length would pass a length check and still be wrong). `branch` is documentation only, printed
// alongside the label and (on failure) both raw outputs, naming which branch of argsToCommandLine
// this case is derived from.
function parityCase(label, branch, file, args) {
  const ours = windowsCommandLine(file, args);
  const theirs = argsToCommandLine(file, args);
  const ok = ours === theirs;
  check(`${label}  [branch: ${branch}]`, ok);
  if (!ok) {
    console.log(`   ours:   ${JSON.stringify(ours)}`);
    console.log(`   theirs: ${JSON.stringify(theirs)}`);
  }
}

const FILE = "bin";

// 1. arg === '' — the empty-string special case (quoted as "" even though it has no content to hide).
parityCase("empty-string arg", "arg === ''", FILE, [""]);
// 2. No special chars at all — the no-op fall-through (baseline: no quoting, no escaping branch taken).
parityCase("plain arg, no special chars", "fall-through (no quoting/escaping)", FILE, ["plain"]);
// 3. A space, with neither end pre-quoted → hasNoEnclosingQuotes is true, so the whitespace triggers quoting.
parityCase("arg with a space, no enclosing quotes", "hasNoEnclosingQuotes + space", FILE, ["has space"]);
// 4. A tab, unquoted → the same predicate, the OTHER whitespace char argsToCommandLine special-cases.
parityCase("arg with a tab, no enclosing quotes", "hasNoEnclosingQuotes + tab", FILE, ["has\ttab"]);
// 5. A space, but the arg is ALREADY fully quoted at both ends → neither enclosing-quote predicate
//    fires, so it is NOT re-quoted — the one case where whitespace does NOT trigger the `quote` branch.
parityCase("arg with a space, already quoted at both ends", "neither predicate (pre-quoted, not re-quoted)", FILE, ['"already quoted"']);
// 6. A space, quote only at the START (lopsided) → hasLopsidedEnclosingQuote fires, so it IS
//    re-quoted even though it already starts with a literal quote character.
parityCase("arg with a space, quote only at the start (lopsided)", "hasLopsidedEnclosingQuote (start)", FILE, ['"lopsided start']);
// 7. A space, quote only at the END (lopsided, the other direction) → same predicate, opposite side.
parityCase("arg with a space, quote only at the end (lopsided)", "hasLopsidedEnclosingQuote (end)", FILE, ['lopsided end"']);
// 8. A single-char arg that IS a space: `arg.length > 1` is false, so the whitespace does NOT
//    trigger quoting despite containing a space — the length-boundary edge of the `quote` predicate.
parityCase("single-char arg that is itself a space", "arg.length > 1 boundary (length === 1, not quoted)", FILE, [" "]);
// 9. An embedded quote forces quoting via the accompanying space, then the quote char itself is
//    escaped (backslash-doubling with bsCount === 0 immediately before it).
parityCase("arg with an embedded quote and a space", "embedded '\"' escape (bsCount=0 before it) + quoting", FILE, ['say "hi"']);
// 10. A backslash immediately before an embedded quote, with NO surrounding space — the escape loop
//     (bsCount*2+1 doubling before a quote char) fires independently of the `quote` wrapping decision,
//     which stays false here (no space/tab anywhere in this arg).
parityCase("backslash immediately before an embedded quote, no space", "backslash-run-before-quote escape (bsCount>0), unquoted overall", FILE, ['a\\"b']);
// 11. A trailing backslash on an arg that DOES get wrapped in quotes (because of the accompanying
//     space) — the trailing backslash-run must be DOUBLED so it can't escape the closing quote.
parityCase("arg ending in a backslash, with a space (quoted)", "trailing backslash-run doubled (quoted path)", FILE, ["C:\\a b\\"]);
// 12. A trailing backslash on an arg that does NOT get wrapped in quotes (no space) — the trailing
//     backslash-run passes through UNDOUBLED, the other side of case 11's branch.
parityCase("arg ending in a backslash, no space (unquoted)", "trailing backslash-run passed through (unquoted path)", FILE, ["C:\\path\\"]);
// 13. A non-BMP (astral, surrogate-pair) character with no other special chars. Not a distinct
//     decision branch in argsToCommandLine itself, but both implementations walk the arg by JS string
//     index (i.e. by UTF-16 code unit) — this proves that walk doesn't diverge outside the ASCII
//     alphabet the other 12 cases are drawn from.
parityCase("astral (surrogate-pair) character, no other special chars", "non-branch: UTF-16 code-unit walk parity outside ASCII", FILE, ["\u{1D518}nicode"]);
// 14. Bonus composite (not a new branch — several of the above at once), matching the shape of a REAL
//     production argv value: a JSON blob like the one --mcp-config actually carries, with embedded
//     quotes, colons, braces and one space all in the same arg.
parityCase(
  "realistic composite: an --mcp-config-shaped JSON blob",
  "composite (multiple branches together, in one real-shaped arg)",
  FILE,
  [JSON.stringify({ mcpServers: { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1 with a space" } } })],
);

console.log(failures === 0
  ? `\n✅ ALL PASS — windowsCommandLine (pty/host.ts) is byte-identical to the REAL node-pty@${nodePtyVersion} argsToCommandLine, for every array-args branch its own implementation special-cases (see the branch labels above).`
  : `\n❌ ${failures} FAILURE(S) — windowsCommandLine has DRIFTED from node-pty@${nodePtyVersion}'s real argsToCommandLine. See card 9fea4196: this is exactly the silent-drift class this test exists to catch loudly instead of letting it ship as either an under-refusal (raw OS error code: 206) or an over-refusal (valid spawns rejected).`);
process.exit(failures === 0 ? 0 : 1);
