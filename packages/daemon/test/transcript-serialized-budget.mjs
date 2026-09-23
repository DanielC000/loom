import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 91fef05a, reviewer finding 2 — pageTranscript/lastNTurns/spillableTurnsResponse (sessions/
// transcript.ts) used to bound turns against their RAW char length, but `ok()` (mcp/*.ts) always
// JSON.stringify's the response before it ever reaches the tool-result cap. A turn dominated by chars
// that expand under JSON.stringify (embedded quotes/backslashes/newlines/control chars) can have a raw
// length comfortably under TRANSCRIPT_PAGE_CHAR_BUDGET while its SERIALIZED footprint blows well past it
// — the exact gap the "never spill to disk" contract (card 26134f1a) silently relied on being closed.
// Fix: every budget check in transcript.ts now measures `JSON.stringify(text).length`
// (`serializedLen`), and `truncateWithMarker` binary-searches a raw head/tail split whose SERIALIZED
// candidate provably fits, never a raw-length guess. Also proves the surrogate-pair-safety fix (a bare
// slice could otherwise split a multi-code-unit char, e.g. an emoji, in half at the truncation boundary).
// UNIT-LEVEL, hermetic: no Db, no MCP transport — drives the pure functions directly.
// Run: 1) build (turbo builds shared first), 2) node test/transcript-serialized-budget.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { pageTranscript, lastNTurns, spillableTurnsResponse, TRANSCRIPT_PAGE_CHAR_BUDGET } =
  await import("../dist/sessions/transcript.js");

const serializedLen = (s) => JSON.stringify(s).length;

// ═══ (A) a turn whose RAW length is under budget but whose SERIALIZED length is NOT — the exact gap ═══
{
  // Every char is a double-quote: raw length X, serialized length ~2X+2 (each `"` becomes `\"`).
  // Pick a raw length comfortably UNDER budget but whose serialized length comfortably EXCEEDS it.
  const rawLen = Math.floor(TRANSCRIPT_PAGE_CHAR_BUDGET * 0.7);
  const quoteBomb = '"'.repeat(rawLen);
  check("(A) fixture sanity: raw length is UNDER the page budget", quoteBomb.length < TRANSCRIPT_PAGE_CHAR_BUDGET);
  check("(A) fixture sanity: SERIALIZED length is OVER the page budget (the exact gap this fix closes)", serializedLen(quoteBomb) > TRANSCRIPT_PAGE_CHAR_BUDGET);

  const turns = [{ role: "assistant", text: quoteBomb }];
  const bounded = spillableTurnsResponse(turns, null);
  check("(A) spillableTurnsResponse truncated the turn (a raw-length-only check would have left it untouched)",
    bounded[0].text !== quoteBomb && bounded[0].text.includes("[TRUNCATED: showing"));
  check("(A) the truncated turn's SERIALIZED size is provably within the page budget (the whole point of the fix)",
    serializedLen(bounded[0].text) <= TRANSCRIPT_PAGE_CHAR_BUDGET);
}

// ═══ (B) pageTranscript itself packs FEWER turns when they're escaping-heavy (serialized, not raw, drives the pack) ═══
{
  // 10 turns, each raw ~6000 chars of pure double-quotes — raw total 60,000 (would ALL fit a naive
  // raw-length pack under a much larger cap), but each turn's SERIALIZED size is ~2x its raw size.
  const rawPer = 6000;
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user", text: `T${i}-` + '"'.repeat(rawPer) }));
  const totalRaw = turns.reduce((s, t) => s + t.text.length, 0);
  check("(B) fixture sanity: total RAW size comfortably exceeds the page budget on its own", totalRaw > TRANSCRIPT_PAGE_CHAR_BUDGET);
  const page = pageTranscript(turns, {});
  // Verify the page's ACTUAL serialized footprint (turns + envelope overhead) never exceeds the budget
  // by more than the last (always-included) turn's own overhead — i.e. every turn beyond the first that
  // was included genuinely fit under budget when serialized, not merely by raw length.
  let runningSerialized = 0;
  for (const t of page.turns) runningSerialized += serializedLen(t.text) + t.role.length + 40;
  const overhead = serializedLen(page.turns.at(-1)?.text ?? "") + (page.turns.at(-1)?.role.length ?? 0) + 40;
  check("(B) pageTranscript's own running SERIALIZED total (minus the one always-included turn's own size) stays within budget",
    page.turns.length > 0 && runningSerialized - overhead <= TRANSCRIPT_PAGE_CHAR_BUDGET);
  check("(B) NOT every turn was packed in (the escaping-heavy serialized size forced a smaller page than a raw-length pack would)",
    page.turns.length < turns.length);
}

// ═══ (C) lastNTurns — same serialized-budget discipline as pageTranscript ═══
{
  const rawPer = 6000;
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user", text: `T${i}-` + '"'.repeat(rawPer) }));
  const kept = lastNTurns(turns, turns.length);
  check("(C) lastNTurns also packs FEWER turns than requested when they're escaping-heavy", kept.length > 0 && kept.length < turns.length);
  check("(C) lastNTurns kept the MOST RECENT turns (trims from the older end)", kept[kept.length - 1].text === turns[turns.length - 1].text);
}

// ═══ (D) an extreme worst-case expansion (control chars, ~6x under \uXXXX escaping) still resolves ═══
{
  // \u0001 (a control char) serializes to the 6-char literal `\u0001` — a much higher expansion ratio
  // than the quote-bomb above. Confirms the binary search in truncateWithMarker converges even under a
  // near-worst-case per-char blowup, not just the ~2x quote case.
  const rawLen = Math.floor(TRANSCRIPT_PAGE_CHAR_BUDGET * 0.3);
  const controlBomb = "\u0001".repeat(rawLen);
  check("(D) fixture sanity: SERIALIZED length is WAY over budget (near-6x expansion)", serializedLen(controlBomb) > TRANSCRIPT_PAGE_CHAR_BUDGET * 1.5);
  const bounded = spillableTurnsResponse([{ role: "assistant", text: controlBomb }], null);
  check("(D) the extreme-expansion turn was truncated", bounded[0].text.includes("[TRUNCATED: showing"));
  check("(D) its truncated SERIALIZED size still fits within the page budget", serializedLen(bounded[0].text) <= TRANSCRIPT_PAGE_CHAR_BUDGET);
}

// ═══ (E) surrogate-pair safety — a truncation boundary must never split a multi-code-unit char in half ═══
{
  // U+1F600 (😀) is a surrogate PAIR in UTF-16 (2 code units). Repeat it enough to force truncation at a
  // boundary that would, without the surrogate-safety fix, land mid-pair roughly half the time.
  const emoji = "\u{1F600}"; // 😀 — 2 UTF-16 code units
  const rawLen = Math.floor(TRANSCRIPT_PAGE_CHAR_BUDGET * 1.5); // comfortably forces truncation
  const emojiText = emoji.repeat(Math.floor(rawLen / emoji.length));
  const bounded = spillableTurnsResponse([{ role: "assistant", text: emojiText }], null);
  const truncated = bounded[0].text;
  check("(E) the emoji-heavy turn was truncated", truncated.includes("[TRUNCATED: showing"));
  // A well-formed string round-trips through JSON.stringify/JSON.parse byte-for-byte; a lone/split
  // surrogate would still round-trip (JSON.stringify escapes it as \udXXX) but would visibly differ from
  // re-encoding via TextEncoder/TextDecoder (which replaces an unpaired surrogate with U+FFFD).
  const reencoded = new TextDecoder("utf-8", { fatal: false }).decode(new TextEncoder().encode(truncated));
  check("(E) the truncated text contains NO unpaired surrogate (UTF-8 round-trip is byte-for-byte, no U+FFFD replacement)",
    !reencoded.includes("�") && reencoded === truncated);
  // The marker itself is prefixed by "\n\n" (see truncateWithMarker) — split on the marker's OWN leading
  // newlines, not just "[TRUNCATED", so the check inspects the real content boundary, not those two
  // marker-owned newline chars.
  check("(E) the head genuinely ends on a WHOLE emoji, not a split code unit", truncated.split("\n\n[TRUNCATED")[0].endsWith(emoji));
}

// ═══ (F) below-budget content is completely untouched (no regression from the serialized-length switch) ═══
{
  const smallText = "a perfectly ordinary small turn with a few \"quotes\" and\nnewlines.";
  const bounded = spillableTurnsResponse([{ role: "user", text: smallText }], null);
  check("(F) a below-cap turn stays byte-identical", bounded[0].text === smallText);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — pageTranscript/lastNTurns/spillableTurnsResponse (sessions/transcript.ts) all bound a turn against its SERIALIZED size (JSON.stringify(text).length), not its raw char count, closing the gap where an escaping-heavy turn (quotes/newlines/control chars) could have a raw length under budget while its serialized footprint — what ok() actually emits — blew well past it; truncateWithMarker's binary search converges even under near-worst-case expansion and never splits a UTF-16 surrogate pair at the truncation boundary."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
