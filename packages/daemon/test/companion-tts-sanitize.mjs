import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — TTS-friendly voice replies (owner ask: emojis/markdown garble the spoken audio).
// Hermetic, pure-function test: sanitizeForSpeech has no I/O, so this drives it directly with NO
// python/venv, NO daemon, NO real claude. Proves:
//   1. plain prose passes through unchanged (no false-positive stripping)
//   2. emoji + pictographs + ZWJ/keycap sequences are stripped
//   3. markdown → plain: bold/italic (both ** and _ forms), inline code, fenced code, heading, bullet
//      list markers, numbered list markers, and [label](url) links → label
//   4. bare URLs are dropped outright
//   5. read-aloud-hostile symbol runs (***, ---, ~~~, >>>) are removed
//   6. multi-space/newline runs collapse to a single space, and the result is trimmed
//   7. an all-emoji / all-markup reply sanitizes to EMPTY STRING (the synthesize() null-degrade edge
//      case is covered separately in companion-voice-tts.mjs; this file only proves the sanitizer
//      itself produces "" so that degrade can trigger)
// Run: 1) build (turbo builds shared first), 2) node test/companion-tts-sanitize.mjs
import { sanitizeForSpeech } from "../dist/companion/tts.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ============ 1 — plain prose passes through unchanged ====================================================
  check(
    "1: plain prose is unchanged",
    sanitizeForSpeech("Hello, world! This is a normal sentence, isn't it?") ===
      "Hello, world! This is a normal sentence, isn't it?",
  );
  check("1: prose with snake_case identifiers is left alone (not mistaken for italic)", sanitizeForSpeech("check my_var_name please") === "check my_var_name please");

  // ============ 2 — emoji / pictographs / ZWJ / keycap sequences are stripped ================================
  check("2: a trailing emoji is stripped", sanitizeForSpeech("Great job! \u{1F389}") === "Great job!");
  check("2: an emoji mid-sentence is stripped and spacing collapses", sanitizeForSpeech("I ❤️ this") === "I this");
  check("2: a ZWJ family emoji sequence is fully stripped", sanitizeForSpeech("family \u{1F468}‍\u{1F469}‍\u{1F467} time") === "family time");
  check(
    "2: a keycap sequence strips its combining marks, keeping the readable digit",
    sanitizeForSpeech("step 1\u{FE0F}\u{20E3} go") === "step 1 go",
  );

  // ============ 3 — markdown → plain =========================================================================
  check("3: **bold** → inner text", sanitizeForSpeech("this is **bold** text") === "this is bold text");
  check("3: __bold__ → inner text", sanitizeForSpeech("this is __bold__ text") === "this is bold text");
  check("3: *italic* → inner text", sanitizeForSpeech("this is *italic* text") === "this is italic text");
  check("3: _italic_ → inner text", sanitizeForSpeech("this is _italic_ text") === "this is italic text");
  check("3: `inline code` → inner text", sanitizeForSpeech("run `npm install` first") === "run npm install first");
  check(
    "3: fenced ```code``` block → inner text",
    sanitizeForSpeech("before\n```js\nconst x = 1;\n```\nafter") === "before const x = 1; after",
  );
  check("3: # Heading → text, marker dropped", sanitizeForSpeech("# Heading\nbody text") === "Heading body text");
  check("3: '- ' bullet marker dropped, item kept", sanitizeForSpeech("- first item\n- second item") === "first item second item");
  check("3: '1. ' numbered marker dropped, item kept", sanitizeForSpeech("1. first item\n2. second item") === "first item second item");
  check(
    "3: [label](url) link → label only",
    sanitizeForSpeech("see [the docs](https://example.com/docs) for more") === "see the docs for more",
  );

  // ============ 4 — bare URLs dropped outright ================================================================
  check("4: a bare URL is dropped, not read aloud", sanitizeForSpeech("check https://example.com/path?q=1 now") === "check now");

  // ============ 5 — read-aloud-hostile symbol runs removed ====================================================
  check("5: *** run removed", sanitizeForSpeech("wait *** really") === "wait really");
  check("5: --- horizontal rule removed", sanitizeForSpeech("section one\n---\nsection two") === "section one section two");
  check("5: ~~~ run removed", sanitizeForSpeech("look ~~~ here") === "look here");
  check("5: >>> run removed", sanitizeForSpeech("quote >>> text") === "quote text");

  // ============ 6 — whitespace collapse + trim ================================================================
  check("6: multiple spaces collapse to one", sanitizeForSpeech("too   many    spaces") === "too many spaces");
  check("6: newlines collapse to a single space", sanitizeForSpeech("line one\n\n\nline two") === "line one line two");
  check("6: leading/trailing whitespace is trimmed", sanitizeForSpeech("   padded text   ") === "padded text");

  // ============ 7 — all-emoji / all-markup reply sanitizes to empty ===========================================
  check("7: an all-emoji reply sanitizes to empty string", sanitizeForSpeech("\u{1F389}\u{1F600}\u{1F44D}") === "");
  check("7: an all-markup reply (just a fence + nothing else) sanitizes to empty string", sanitizeForSpeech("```\n```") === "");
  check("7: pure whitespace sanitizes to empty string", sanitizeForSpeech("   \n\t  ") === "");
} catch (err) {
  console.error("UNCAUGHT:", err);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
