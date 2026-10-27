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
//   (4) Card 2c215ede: FIXED — a mid-line `/* ... */` (one that does not open at the start of a trimmed
//       line) used to survive the strip verbatim, which could desync a CONSUMER's own whole-file `'`/`"`
//       quote-state tracker (see `_strip-comments.mjs`'s own header for the full mechanism and the three
//       real consumers this closed). (7) below pins the fix (same-line close, multi-line continuation,
//       quote-awareness); (8) pins a REAL REGRESSION that same fix briefly introduced and this card also
//       fixed — a `/**` glob inside a backtick template literal was misread as an unclosed comment opener,
//       silently dropping the rest of the file in two real consumers. (9) pins a NAMED RESIDUAL in the
//       same card: an escaped-slash-then-quantifier regex literal (`/\/*$/`) was ALSO misread the same
//       catastrophic way — mitigated (9a) — but an unescaped `/*` inside a regex character class
//       (`/[/*]/`) still is NOT (9b, a documented, not a silent, gap — see docs/decisions/2c215ede-*.md).
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

// ===== card 2c215ede: mid-line `/* ... */` comment stripping =====
// A comment that does NOT open at the start of a trimmed line used to survive the strip VERBATIM — the
// real example from the card body (git/reader.ts:84): a `catch` block whose comment contains an
// apostrophe ("doesn't"), which desyncs a CONSUMER's own whole-file `'`/`"` quote-state tracker (see
// bare-ref-positional-argv-guard.mjs, createworktree-loom-home-guard.mjs, mcp-project-fields-chokepoint-
// guard.mjs for the real consumers this fixes).
check("(7) a mid-line /* ... */ comment (not line-leading) is removed, apostrophe and all",
  stripComments("catch { /* no origin remote — the host rule simply doesn't apply (resolvability still checked) */ }")
    === "catch {  }");
check("(7) code AFTER a same-line mid-line comment is preserved and still scanned for a real trailing comment",
  stripComments("x(); /* note */ y(); // real\n") === "x(); " + " y(); \n");
check("(7) a mid-line /* that does NOT close before EOL carries into the next line(s), dropping them whole, "
  + "and resumes scanning on whatever follows the */ on the closing line",
  stripComments("x(); /* starts here\ncontinues\nends */ y();\n") === "x(); \n y();\n");
check("(7) a /* inside a same-line double-quoted string is never a comment opener (e.g. a glob literal)",
  stripComments('const g = "a/*b*/c";') === 'const g = "a/*b*/c";');

// ===== card 2c215ede: the regression THIS card's own before/after diff caught, now fixed =====
// A `/**` glob INSIDE a backtick template literal (e.g. a Claude settings `Edit(${glob}/**)` rule) was
// wrongly read as an UNCLOSED mid-line comment opener (no `*/` anywhere later on the line) — which set
// `midlineBlock` and silently dropped the ENTIRE REST OF THE FILE in two real consumers
// (loom-home-write-deny.mjs, mcp-config-secret-lifecycle.mjs) before this was caught and fixed. A
// per-line (never cross-line) backtick toggle closes it without reopening gap (b)'s own reverted
// cross-line tracker — see (5) above, still green, proving that revert stays intact.
check("(8) REGRESSION PIN: a /** glob inside a backtick template literal is never read as an unclosed comment",
  stripComments('return e.kind === "dir" ? `Edit(${glob}/**)` : `Edit(${glob})`;')
    === 'return e.kind === "dir" ? `Edit(${glob}/**)` : `Edit(${glob})`;');
check("(8) REGRESSION PIN: real code on EVERY later line survives (the catastrophic swallow-the-rest-of-"
  + "the-file shape, not just the one offending line)",
  stripComments('const g = `Edit(${glob}/**)`;\nconst h = 1;\nconst i = 2;\n')
    === 'const g = `Edit(${glob}/**)`;\nconst h = 1;\nconst i = 2;\n');
check("(8) a GENUINE mid-line comment AFTER a backtick template on the same line is still removed",
  stripComments('const g = `Edit(${glob}/**)`; /* note */ real();')
    === 'const g = `Edit(${glob}/**)`;  real();');

// ===== card 2c215ede: the regex-literal residual — mitigated shape, and the still-open shape =====
// Same category as gap (a)'s `//`-from-a-regex-literal — here for `/*`: an escaped slash immediately
// followed by a `*` quantifier (e.g. `/\/*$/`, `/a\/*b/`) used to be misread as an unclosed mid-line
// comment opener, catastrophically dropping the rest of the file. (9a) pins the mitigation (a `/*` whose
// `/` is immediately preceded by `\` is never a comment opener). (9b) pins that a DIFFERENT shape — an
// unescaped `/` adjacent to `*` inside a character class (`/[/*]/`, valid JS, no escaping needed in
// `[...]`) — is a KNOWN, NOT-fixed residual of the SAME catastrophic shape, so whoever hits it finds it
// here rather than rediscovering it from scratch.
check("(9a) MITIGATION PIN: an escaped-slash-then-quantifier regex literal (`/\\/*$/`) is never read as an unclosed comment",
  stripComments('s.replace(/\\/*$/, "");\nreal2();\nreal3();\n')
    === 's.replace(/\\/*$/, "");\nreal2();\nreal3();\n');
check("(9a) MITIGATION PIN: the same shape as a bare regex literal (`/a\\/*b/`)",
  stripComments('const re = /a\\/*b/;\nreal2();\nreal3();\n')
    === 'const re = /a\\/*b/;\nreal2();\nreal3();\n');
check("(9b) KNOWN GAP (not fixed): an unescaped /* inside a regex character class (`/[/*]/`) still "
  + "catastrophically drops the rest of the file — documented, not a silent surprise",
  stripComments('const re = /[/*]/;\nreal2();\nreal3();\n') !== 'const re = /[/*]/;\nreal2();\nreal3();\n');

console.log(failures === 0
  ? "\n✅ ALL PASS — _strip-comments.mjs: baseline comment removal, the same-line string-literal fix + its negative/positive controls, CRLF preservation, the documented regex-literal gap, a regression pin proving the reverted multi-line-template tracker's exact failure shape stays fixed-as-reverted (no silent reintroduction), card 2c215ede's mid-line /* ... */ stripping (same-line, multi-line-continuation, and quote-awareness), the regression pin for the backtick-template-glob false-unclosed-comment bug that fix briefly introduced, the mitigation pin for an escaped-slash-then-quantifier regex literal, and the documented (not fixed) residual for an unescaped /* inside a regex character class."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
