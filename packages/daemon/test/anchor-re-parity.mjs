// anchor-re-parity.mjs — cross-file identity guard for the decision-anchor `ANCHOR_RE` grammar (card
// 969b0e1c, code-review finding S1).
//
// WHY THIS EXISTS: the `@decision`/`@decision sha:<id>` anchor grammar is DELIBERATELY DUPLICATED across
// THREE independently-maintained copies — `packages/daemon/assets/decision-records.mjs`,
// `packages/daemon/assets/comment-anchor-lint.mjs`, and `packages/daemon/src/mcp/decisions.ts` (each
// file's own header explains why: assets ship standalone, invoked by a bare `node <path>`, while
// decisions.ts ships compiled into the daemon). Nothing MECHANICAL pinned these three in sync before this
// card — when the sigil grammar was added, the two `.mjs` copies were updated together but the THIRD copy
// (decisions.ts, backing the agent-facing `decisions_for` MCP tool) was missed for an entire review round.
// The bug this produced was silent and two-sided: `decisions_for` reported `anchorCount:0` for a file that
// genuinely had a `sha:`-sigil'd anchor (BLIND), and `orphan:true` for a sha-keyed record that genuinely
// had live anchors (AFFIRMATIVELY WRONG — an invitation to delete a live record). This test is the
// mechanical backstop: had it existed, that miss would have been a RED test, not a review finding.
//
// METHOD (mirrors an existing in-repo precedent — test/decision-records.mjs's own DECISION_RECORD_STORE_
// KINDS-vs-anyStoreExists cross-file check, card 0635f545): literal-parse the `const ANCHOR_RE = ...;`
// declaration line out of each file's own source TEXT (never imported — importing a `.ts` file from a
// `.mjs` test, or importing an asset that's deliberately independent of dist/, would defeat the point of
// checking the files as they actually SHIP), turn each extracted literal into a real RegExp via a bounded
// `new Function(...)` construction, and compare `.source`/`.flags` — structural equality, not a raw byte
// diff, so a future harmless reformat (e.g. decisions.ts's own quoting/whitespace conventions differing
// from the `.mjs` files') doesn't false-positive-fail this guard. `test()` fires each extracted regex
// against real anchor lines too — a SECOND, behavioral equality check, and the closest thing to a positive
// control that the compared regexes don't merely LOOK equal but actually match the same things.
// ⭐ A POSITIVE CONTROL runs FIRST (against a synthetic fixture, not the real files) to prove the
// extraction pattern itself can find a known-present literal before trusting its silence anywhere else —
// a source-extraction check that matches nothing passes vacuously, and that is exactly the failure shape
// this whole test exists to rule out (card 969b0e1c review S1's own explicit ask).
//
// Run: `node test/anchor-re-parity.mjs` from packages/daemon (no build, no LOOM_HOME needed — reads
// SOURCE files directly, decisions.ts included, never dist/).
import fs from "node:fs";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const ANCHOR_RE_DECL_RE = /^const ANCHOR_RE = (.+);\s*$/m;

/** Extract the `const ANCHOR_RE = <literal>;` declaration's literal text from `text`, or null if the
 * declaration isn't present in this exact shape. */
function extractAnchorRegexLiteral(text) {
  const m = ANCHOR_RE_DECL_RE.exec(text);
  return m ? m[1] : null;
}

/** Turn an extracted regex-literal TEXT (e.g. "/@decision\\s+.../gi") into a real RegExp object. Bounded
 * `new Function` — never a bare `eval` — over TEXT THIS TEST ITSELF EXTRACTED FROM REPO SOURCE FILES
 * (never user/network input), the same trust boundary as any other test reading its own fixture source. */
function literalToRegExp(literalText) {
  return new Function(`return ${literalText};`)();
}

// --- positive control: prove extractAnchorRegexLiteral can actually find something, against a SYNTHETIC
// fixture, before trusting its silence against any real file. ---
{
  const fixture = "// some header comment\nconst UNRELATED = 1;\nconst ANCHOR_RE = /fixture-pattern/gi;\nconst AFTER = 2;\n";
  const extracted = extractAnchorRegexLiteral(fixture);
  check("positive control: extractAnchorRegexLiteral finds a known-present literal in a synthetic fixture",
    extracted === "/fixture-pattern/gi");
  const re = literalToRegExp(extracted);
  check("positive control: the extracted literal round-trips into a real, working RegExp",
    re instanceof RegExp && re.source === "fixture-pattern" && re.flags === "gi" && re.test("a fixture-pattern here"));
}

// --- the real three files ---
const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FILES = {
  "assets/decision-records.mjs": path.join(REPO_ROOT, "packages", "daemon", "assets", "decision-records.mjs"),
  "assets/comment-anchor-lint.mjs": path.join(REPO_ROOT, "packages", "daemon", "assets", "comment-anchor-lint.mjs"),
  "src/mcp/decisions.ts": path.join(REPO_ROOT, "packages", "daemon", "src", "mcp", "decisions.ts"),
};

const extracted = {};
for (const [label, filePath] of Object.entries(FILES)) {
  check(`sanity: ${label} exists and is readable`, fs.existsSync(filePath));
  const text = fs.readFileSync(filePath, "utf8");
  const literal = extractAnchorRegexLiteral(text);
  check(`${label}: a "const ANCHOR_RE = ...;" declaration is found in its source text`, typeof literal === "string" && literal.length > 0);
  extracted[label] = literal;
}

const regexes = {};
for (const [label, literal] of Object.entries(extracted)) {
  if (typeof literal !== "string") continue; // already failed above; don't cascade a second failure from a null literal
  let re = null;
  try { re = literalToRegExp(literal); } catch { /* leave null — reported below */ }
  check(`${label}: its extracted literal round-trips into a real, working RegExp (no syntax drift)`, re instanceof RegExp);
  regexes[label] = re;
}

const [aLabel, bLabel, cLabel] = Object.keys(FILES);
const [a, b, c] = [regexes[aLabel], regexes[bLabel], regexes[cLabel]];

if (a && b && c) {
  check(`STRUCTURAL PARITY: ${aLabel} and ${bLabel} (the two duplicated .mjs assets) have IDENTICAL .source`, a.source === b.source);
  check(`STRUCTURAL PARITY: ${aLabel} and ${bLabel} have IDENTICAL .flags`, a.flags === b.flags);
  check(`STRUCTURAL PARITY: ${cLabel} (the compiled TS copy) has the SAME .source as the .mjs pair`, a.source === c.source);
  check(`STRUCTURAL PARITY: ${cLabel} has the SAME .flags as the .mjs pair`, a.flags === c.flags);

  // --- behavioral parity: the closest thing to a positive control that these aren't just structurally
  // equal but ACTUALLY MATCH the same things — real anchor lines, both namespaces, run through all three
  // independently (matchAll is stateful on a `g`-flagged regex, so a FRESH RegExp per line per file avoids
  // any lastIndex cross-contamination between assertions). ---
  const SAMPLE_LINES = [
    "// @decision 1974444d — a bare card-id anchor",
    "// @decision sha:00435c8f — a sha-sigil'd commit anchor",
    "// @decision 11111111 — first  // @decision sha:22222222 — second, same line",
    "// just prose, no anchor here at all",
  ];
  for (const line of SAMPLE_LINES) {
    const matchesFor = (re) => [...line.matchAll(new RegExp(re.source, re.flags))].map((m) => [m[1] ?? "", m[2] ?? ""]);
    const [ma, mb, mc] = [matchesFor(a), matchesFor(b), matchesFor(c)];
    check(`BEHAVIORAL PARITY on ${JSON.stringify(line)}: all three regexes yield the SAME match groups`,
      JSON.stringify(ma) === JSON.stringify(mb) && JSON.stringify(mb) === JSON.stringify(mc));
  }
  // At least one sample line must actually match something in EVERY file — a behavioral parity check that
  // only ever compares empty match sets (three regexes agreeing on "nothing") would pass vacuously.
  const anyMatched = (re) => SAMPLE_LINES.some((l) => new RegExp(re.source, re.flags).test(l));
  check("positive control: the sample lines actually exercise a real match in all three regexes (not a vacuous all-empty agreement)",
    anyMatched(a) && anyMatched(b) && anyMatched(c));
} else {
  check("STRUCTURAL PARITY: skipped — at least one file's ANCHOR_RE failed to extract/parse (see failures above)", false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the three independently-maintained ANCHOR_RE copies (decision-records.mjs, "
    + "comment-anchor-lint.mjs, mcp/decisions.ts) are structurally AND behaviorally identical. Update all "
    + "three together; this guard is what catches the next one that's missed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
