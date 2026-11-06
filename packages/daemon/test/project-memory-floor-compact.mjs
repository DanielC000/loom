import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A never-drop (floor) note rides every kickoff as its header + ONE rule line + a memory_read pointer, not
// its body (the floor guarantees REACHABILITY). The rule line is the FIRST eligible line in document order
// (a `>` quote line or a plain content line; never a heading, a bold provenance stamp, a date-only line, a
// code-fence opener or anything inside a fenced block), capped at FLOOR_RULE_MAX_CHARS with an open code
// fence closed. A SHORT note (<= FLOOR_SHORT_NOTE_MAX_CHARS) renders whole. A note the kickoff cites by key
// renders in full; linked-Request annotations still ride; the status helper sizes the COMPACT form.
//
// Run: 1) build, 2) node test/project-memory-floor-compact.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const R = await import("../dist/sessions/project-memory-recall.js");
const { composeProjectMemoryDigest, floorRuleLine, computeFloorTierStatus, FLOOR_RULE_MAX_CHARS, FLOOR_SHORT_NOTE_MAX_CHARS, NEVER_DROP_TAG } = R;

const now = new Date().toISOString();
const entry = (key, text, over = {}) => ({
  id: `id-${key}`, projectId: "p", key, title: `Title of ${key}`, text, pinned: true, tags: over.tags ?? [NEVER_DROP_TAG],
  createdAt: now, updatedAt: now, lastRetrievedAt: null, retrievalCount: 0, version: 1, requestIds: null, triggerGlob: null, expiresAt: null,
});
// Pads a note past the short-note threshold so it is compacted; the pad is a plain paragraph AFTER the rule.
const PAD = `\n\n${"filler ".repeat(80)}`;
const rule = (text) => floorRuleLine(entry("k", text + PAD)).split("\n")[0];
const fenceCount = (s) => (s.match(/```/g) ?? []).length;

// --- rule-line selection: first eligible line in DOCUMENT ORDER ---
check("(rule) a plain first line beats a LATER blockquote", rule("First rule line.\n\n> a later evidence quote") === "First rule line.");
check("(rule) a blockquote that comes first wins over later plain lines", rule("> The quoted rule.\n\nplain after") === "The quoted rule.");
check("(rule) provenance + heading + quote yields the quote", rule("**Est. 2026-08-01, card abc.**\n\n## THE RULE\n> THE RULE: do X\n\nmore") === "THE RULE: do X");
check("(rule) a `**Est.` provenance line is skipped", rule("**Est. 2026-08-01, card abc.**\n\nReal rule here.") === "Real rule here.");
check("(rule) a `**v5 2026-08-29` provenance line is skipped", rule("**v5 2026-08-29 (gen 209): x**\nReal rule.") === "Real rule.");
check("(rule) a `**Established` provenance line is skipped", rule("**Established 2026-08-27, n=1.**\nReal rule.") === "Real rule.");
check("(rule) a date-ONLY line is skipped", rule("2026-08-27\nReal rule.") === "Real rule.");
check("(rule) a bold date-only line is skipped", rule("**2026-08-27**\nReal rule.") === "Real rule.");
check("(rule) a bold line OPENING with a date plus prose is provenance (read-the-artifact shape: bold date line, heading, `>` rule)",
  rule("**2026-08-04. v4 2026-08-27: specimens split to [[x-evidence]]; nothing deleted.**\n\n## THE DISCIPLINE\n> READ THE ARTIFACT BEFORE YOU SEND.\n\nmore") === "READ THE ARTIFACT BEFORE YOU SEND.");
check("(rule) an UNBOLDED date opening a content line stays content", rule("2026-09-25. Never push without asking.\nmore") === "2026-09-25. Never push without asking.");
check("(rule) a blockquote that is itself provenance is skipped", rule("> **Est. 2026-01-01, card abc.**\nReal rule.") === "Real rule.");
check("(rule) a markdown heading line is skipped", rule("## THE RULE\nReal rule.") === "Real rule.");
check("(rule) a line starting 'v2 of the design is X.' is CONTENT, not provenance (no bold prefix)", rule("v2 of the design is X.\nmore") === "v2 of the design is X.");
check("(rule) a date followed by content is CONTENT", rule("2026-09-25 OWNER DIRECTIVE: never push\nmore") === "2026-09-25 OWNER DIRECTIVE: never push");
check("(rule) an OWNER DIRECTIVE line is content", rule("OWNER DIRECTIVE 2026-07-23: never do Y\nmore") === "OWNER DIRECTIVE 2026-07-23: never do Y");
check("(rule) a note with only provenance/heading lines gets the pointer alone",
  floorRuleLine(entry("only-prov", "**Est. 2026-01-01.**\n## H\n```\n" + "code line\n".repeat(60) + "```")) === "[… `memory_read` only-prov for the full note]");
check("(rule) the pointer names the key", floorRuleLine(entry("the-key", "Rule." + PAD)).endsWith("`memory_read` the-key for the full note]"));

// --- length cap, surrogate pairs, CRLF ---
check("(cap) a line over the cap is truncated with an ellipsis",
  rule("z".repeat(FLOOR_RULE_MAX_CHARS + 50)) === "z".repeat(FLOOR_RULE_MAX_CHARS) + "…");
check("(cap) a line exactly at the cap is untouched", rule("z".repeat(FLOOR_RULE_MAX_CHARS)) === "z".repeat(FLOOR_RULE_MAX_CHARS));
{
  // 239 ASCII chars + a surrogate pair straddling the cut (indices 239,240): the cut must back off the high surrogate.
  const cut = rule("a".repeat(FLOOR_RULE_MAX_CHARS - 1) + "\u{1F600}" + "b".repeat(50));
  check("(cap) a surrogate pair straddling the cut is dropped whole, never split",
    cut === "a".repeat(FLOOR_RULE_MAX_CHARS - 1) + "…" && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut));
}
{
  const crlf = floorRuleLine(entry("crlf", `**Est. 2026-01-01.**\r\n\r\n> The CRLF rule.\r\n\r\n${"filler ".repeat(80)}\r\n`));
  check("(crlf) a CRLF body yields the rule line with no stray CR", crlf.split("\n")[0] === "The CRLF rule." && !crlf.includes("\r"));
}

// --- code fences (a fence-first note must not swallow the rest of the kickoff) ---
check("(fence) a fence-opener first line is never the rule; the fenced block's contents are skipped too",
  rule("```js\nconst fenced = 1;\n```\nReal rule after the fence.") === "Real rule after the fence.");
check("(fence) a ~~~ fence is skipped as well", rule("~~~\ncode\n~~~\nReal rule.") === "Real rule.");
check("(fence) an unterminated fence leaves no eligible line (pointer alone) and no fence marker",
  !floorRuleLine(entry("unterm", "```\n" + "code line\n".repeat(60))).includes("```"));
check("(fence) an inline ``` pair cut mid-pair by the cap is re-closed (even fence count)",
  fenceCount(floorRuleLine(entry("inl", "x".repeat(FLOOR_RULE_MAX_CHARS - 10) + " ```code``` tail tail tail" + PAD))) % 2 === 0);
{
  const fenceFirst = entry("fence-first", "```\n" + "const a = 1;\n".repeat(60) + "```\n\nRule after code.");
  const next = entry("next-note", "> A following note.\n\n" + "filler ".repeat(80));
  const { digest } = composeProjectMemoryDigest([fenceFirst, next], [], 100000);
  check("(fence) a fence-first floor note renders with an even number of fence markers in the whole digest", fenceCount(digest) % 2 === 0);
  check("(fence) the following note's header is intact and outside any code fence",
    digest.includes("### Title of next-note (next-note)") && fenceCount(digest.slice(0, digest.indexOf("### Title of next-note"))) % 2 === 0);
}

// --- short notes render whole ---
{
  const short = "Never do X.\n- Do not Y.\n- Do not Z.";
  check("(short) a note at or under the threshold renders whole, no pointer", floorRuleLine(entry("s", short)) === short);
  const edge = "e".repeat(FLOOR_SHORT_NOTE_MAX_CHARS);
  check("(short) a note of exactly the threshold renders whole", floorRuleLine(entry("e", edge)) === edge);
  check("(short) one char over the threshold is compacted (pointer present)", floorRuleLine(entry("o", edge + "e")).includes("`memory_read` o"));
}

// --- digest rendering ---
const LATE = "LATE-SENTINEL";
const body = `**Est. 2026-01-01.**\n\n> The rule.\n\n${"filler ".repeat(300)}\n\n${LATE}`;
const floor = entry("floor-a", body);
const sect = (digest, k) => { const s = digest.indexOf(`(${k})`); const e = digest.indexOf("\n### ", s + 1); return digest.slice(s, e < 0 ? undefined : e); };
{
  const { digest, droppedFloorKeys } = composeProjectMemoryDigest([floor], [], 100000);
  const s = sect(digest, "floor-a");
  check("(digest) floor note renders its rule line", s.includes("The rule."));
  check("(digest) floor note does NOT render its body (tail sentinel absent)", !s.includes(LATE) && !s.includes("filler filler"));
  check("(digest) floor note carries the memory_read pointer", s.includes("`memory_read` floor-a"));
  check("(digest) nothing dropped", droppedFloorKeys.length === 0);
}
{
  const { digest } = composeProjectMemoryDigest([floor], [], 100000, () => [], "please read floor-a first");
  check("(cited) a floor note the kickoff cites by key renders in full", sect(digest, "floor-a").includes(LATE));
}
{
  const { digest } = composeProjectMemoryDigest([floor], [], 100000, () => ["[linked request r1: PENDING as of 2026-01-01]"]);
  check("(annot) an annotation line (linked-Request state) still rides after the compact note",
    sect(digest, "floor-a").includes("[linked request r1: PENDING"));
}
{
  // Reachability at a tight budget: ten ~3.5KB floor notes do not fit full, but all fit compact.
  const many = Array.from({ length: 10 }, (_, i) => entry(`many-${i}`, `> Rule ${i}.\n\n${"x".repeat(3500)}`));
  const { digest, droppedFloorKeys, includedIds } = composeProjectMemoryDigest(many, [], 1500);
  check("(reach) all ten floor notes are delivered compact at a budget their full bodies overflow",
    droppedFloorKeys.length === 0 && includedIds.length === 10 && many.every((m) => digest.includes(`\`memory_read\` ${m.key}`)));
  const full = composeProjectMemoryDigest(many, [], 1500, () => [], "", { truncateLongNotes: false });
  check("(reach) NEGATIVE CONTROL: rendered in full (truncateLongNotes:false) the same set overflows and drops floor notes",
    full.droppedFloorKeys.length > 0);
}

// --- status sizes the compact form ---
{
  const status = computeFloorTierStatus([floor], 100000);
  check("(status) computeFloorTierStatus sizes the compact form (far below the ~1.8K-token body)", status.floorTokens < 150 && status.floorCount === 1);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
