import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression coverage for the shared `_strip-comments.mjs` stripper (card 36afbbdd manager review round
// 2) — its OWN doc comment names three findings from a full per-source-line old-vs-new diff against the
// real corpus every stripped scanner reads (207 src/**/*.ts + 29 dist files, not synthetic fixtures):
//   (1) FIXED: a `//` inside a same-line `"`/`'` string literal used to be treated as a comment opener,
//       truncating real code after it (found in src/connections/request.ts, src/pty/claude-transcript.ts).
//   (2) FIXED: the trailing-comment cut used to silently drop a line's trailing CRLF `\r` (found across
//       40+ real files) — a naive `slice` doesn't preserve what a `String#replace` match never consumed.
//   (3) REVERTED, NOT fixed: a cross-line multi-line-template-literal tracker was built to stop a
//       `**bold**`-led line of embedded prompt text being dropped like a JSDoc continuation (found in
//       src/platform/seed.ts, src/setup/seed.ts) — then reverted after the SAME diff method caught it
//       silently swallowing real, unrelated `//` comments later in src/companion/tts.ts, because that
//       file's inline-code-span regex (`` /`([^`]+)`/g ``) contains three literal backticks with no
//       relation to any template literal, defeating simple backtick-parity counting. (5)/(6) below pin
//       that this shape stays UNFIXED (not a silent future regression risk if someone "fixes" it again
//       without re-running the same corpus-wide diff).
import { stripComments } from "./_strip-comments.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===== baseline behavior (pre-existing, unaffected by this pass) =====
// A dropped (comment-only) line contributes NOTHING to the output — not even a blank placeholder — so
// dropping N leading lines shortens the joined result, it doesn't blank them.
check("(0) a full-line // comment is removed", stripComments("// hello\nreal();") === "real();");
check("(0) a /* ... */ single-line block comment is removed", stripComments("/* hi */\nreal();") === "real();");
check("(0) a multi-line /* ... */ block is removed", stripComments("/**\n * doc\n */\nreal();") === "real();");
check("(0) a trailing // comment on a real code line is cut", stripComments("real(); // note") === "real(); ");
check("(0) a URL's :// is NOT mistaken for a comment opener", stripComments('const u = "https://x";') === 'const u = "https://x";');

// ===== (1) same-line string-literal fix =====
check("(1) a // inside a same-line double-quoted string is preserved",
  stripComments('if (path.startsWith("//")) return "bad";') === 'if (path.startsWith("//")) return "bad";');
check("(1) real code AFTER that string is preserved too",
  stripComments('x = "//" + rest.slice(1);') === 'x = "//" + rest.slice(1);');
check("(1) a genuine trailing comment AFTER the string is still cut",
  stripComments('if (path.startsWith("//")) return "bad"; // real comment') === 'if (path.startsWith("//")) return "bad"; ');
check("(1) a // inside a same-line single-quoted string is preserved",
  stripComments("x = '//' + y;") === "x = '//' + y;");
// NEGATIVE/POSITIVE controls, card 36afbbdd's own convention: prove the OLD (unfixed) shape really did
// break, and that a genuine comment right after the string still gets removed by the fixed version.
{
  const oldNaive = (s) => s.replace(/(?<!:)\/\/.*/, "");
  const line = 'if (path.startsWith("//")) return "bad";';
  check("(1-control) NEGATIVE: the OLD naive strip DID truncate this real line (proves the bug was real)",
    oldNaive(line) !== line && oldNaive(line) === 'if (path.startsWith("');
  check("(1-control) POSITIVE: the FIXED stripper leaves it untouched", stripComments(line) === line);
}

// ===== (2) CRLF preservation fix =====
check("(2) a trailing CR survives a comment-only-stripped line", stripComments("real(); // note\r") === "real(); \r");
check("(2) a trailing CR survives an untouched (no-comment) line", stripComments("real();\r") === "real();\r");
check("(2) mixed CRLF/LF in one source is preserved per-line", stripComments("a(); // c\r\nb();\r\n") === "a(); \r\nb();\r\n");

// ===== (3)/(4) the regex-literal gap (a) stays documented, unfixed, and non-silent =====
check("(3) KNOWN GAP: a // formed by a regex literal's own delimiters still truncates (documented, not a silent surprise)",
  stripComments('x.replace(/\\//g, "_");') !== 'x.replace(/\\//g, "_");');

// ===== (5)/(6) the multi-line-template gap (b) stays REVERTED — regression pin =====
// This is the exact shape (companion/tts.ts's inline-code-span regex) that broke the reverted
// backtick-parity tracker: an ODD number of literal backticks used as ordinary regex content, nowhere
// near a template literal. If a future "fix" reintroduces cross-line backtick tracking without handling
// this, THIS check goes red first.
check("(5) a regex literal with an odd backtick count does not corrupt a LATER real comment on another line",
  stripComments("out.replace(/`([^`]+)`/g, \"$1\");\nreal(); // still a real comment\n")
    === "out.replace(/`([^`]+)`/g, \"$1\");\nreal(); \n");
// And the KNOWN gap itself stays reproducible: a `**bold**`-led line of embedded prompt text inside a
// multi-line template literal is still dropped like a JSDoc continuation (documents the accepted trade,
// not a silent regression — see this file's header for why fixing it broke (5) instead).
check("(6) KNOWN GAP: a template-literal line starting with ** (markdown bold) is still dropped whole",
  !stripComments("const P = `intro\n**bold prompt line**\nend`;\n").includes("bold prompt line"));

console.log(failures === 0
  ? "\n✅ ALL PASS — _strip-comments.mjs: baseline comment removal, the same-line string-literal fix + its negative/positive controls, CRLF preservation, the documented regex-literal gap, and a regression pin proving the reverted multi-line-template tracker's exact failure shape stays fixed-as-reverted (no silent reintroduction)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
