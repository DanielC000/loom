// Hermetic unit test for src/lib/lineDiff.ts — the line-level LCS behind every text-vs-text compare view
// (the Skills page's per-file diff, and the released-skill panel's store-vs-on-disk diff, card 75ea3f73).
//
// These helpers were private to pages/Skills.tsx until that card moved them here so two renderers could
// share ONE diff. That move is exactly when behaviour can drift unnoticed, so this pins it: the CRLF
// tolerance, the fold, and the fact that `text` keeps the RAW line while only the COMPARISON normalises.
//
//   node --experimental-strip-types packages/web/test/lineDiff.mjs
import assert from "node:assert/strict";
import { collapse, diffLines } from "../src/lib/lineDiff.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

/** The classified diff as a compact string, e.g. "  a|- b|+ c", for readable assertions. */
const shape = (rows) => rows.map((r) => (r.t === "fold" ? `fold${r.n}` : `${r.t}${r.text}`)).join("|");

check("identical text classifies every line as context", () => {
  assert.equal(shape(diffLines("a\nb", "a\nb")), " a| b");
});

check("a replaced line reads as one removal then one addition", () => {
  assert.equal(shape(diffLines("a\nb\nc", "a\nB\nc")), " a|-b|+B| c");
});

check("a pure insertion and a pure deletion each touch only their own side", () => {
  assert.equal(shape(diffLines("a\nc", "a\nb\nc")), " a|+b| c");
  assert.equal(shape(diffLines("a\nb\nc", "a\nc")), " a|-b| c");
});

check("an empty side is wholly added or wholly removed", () => {
  assert.equal(shape(diffLines("", "x")), "-|+x");
  assert.equal(shape(diffLines("x", "")), "-x|+");
});

// The load-bearing tolerance: a CRLF/LF skew between the two sides must NOT read as whole-file churn.
// (It mirrors the daemon's own normalizeForCompare.) The displayed `text` still carries the raw line —
// stripping it here instead would quietly rewrite content in a view whose whole job is to show content.
check("a CRLF/LF skew is context, not churn — and the raw \\r survives in `text`", () => {
  const rows = diffLines("a\r\nb\r\n", "a\nb\n");
  assert.deepEqual(rows.map((r) => r.t), [" ", " ", " "], "a bare line-ending skew read as a change");
  assert.equal(rows[0].text, "a\r", "the raw line lost its \\r, so the diff would render altered content");
});

check("the fold collapses only runs beyond the context window, and counts them", () => {
  // 20 identical lines with one change in the middle: 3 lines of context either side survive, and the
  // two long unchanged runs each become one fold carrying its own line count.
  const base = Array.from({ length: 21 }, (_, i) => `l${i}`).join("\n");
  const changed = base.split("\n").map((l, i) => (i === 10 ? "CHANGED" : l)).join("\n");
  const rows = collapse(diffLines(base, changed));
  const folds = rows.filter((r) => r.t === "fold");
  assert.equal(folds.length, 2, `expected one fold either side of the change, got ${shape(rows)}`);
  // 21 lines: 0..6 before the kept window, 7..9 context, 10 changed (-/+), 11..13 context, 14..20 after.
  assert.equal(folds[0].n, 7);
  assert.equal(folds[1].n, 7);
  assert.ok(rows.some((r) => r.t === "-" && r.text === "l10"), "the change itself was folded away");
  assert.ok(rows.some((r) => r.t === "+" && r.text === "CHANGED"), "the change itself was folded away");
});

check("an all-context diff collapses to a single fold (what the renderer reads as 'no change')", () => {
  const rows = collapse(diffLines("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\ne\nf\ng\nh"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].t, "fold");
  assert.equal(rows[0].n, 8);
});

check("a short unchanged run inside the context window is kept verbatim, not folded", () => {
  const rows = collapse(diffLines("x\na\nb\ny", "X\na\nb\nY"));
  assert.equal(rows.filter((r) => r.t === "fold").length, 0, `a 2-line gap should not fold: ${shape(rows)}`);
});

console.log(`\n${pass} passed`);
