// Hermetic unit test for the ⌘K palette's filtering and ranking — src/lib/paletteCommands.ts, card
// bafbca40 (Atlas audit finding A-29: typing "bra" found a request but not the AUDIT-Bravo project).
// No daemon, no browser: it imports the real module and asserts on plain rows.
//
// Run it with: node --experimental-strip-types packages/web/test/palette-commands.mjs
import assert from "node:assert/strict";
import { matchGrade, rankPaletteRows, stepActive } from "../src/lib/paletteCommands.ts";

const row = (key, kind, label, context) => ({ key, kind, label, context });
const keys = (rows) => rows.map((r) => r.key);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// The audit's own repro. The request is listed FIRST, as the palette's caller would put attention
// rows ahead of nothing — so a ranker that only filtered (the old `includes`) would keep it on top.
const auditRows = [
  row("attn", "request", "Answer · Decision needed Rebrand the landing copy"),
  row("page:/board", "page", "Board", "AUDIT-Alpha"),
  row("project:b", "project", "AUDIT-Bravo Data Pipeline"),
  row("project:a", "project", "AUDIT-Alpha Storefront"),
  row("session:s1", "session", "Orchestrator 1", "AUDIT-Alpha"),
];

check("\"bra\" ranks the AUDIT-Bravo project above a request that merely contains the letters", () => {
  const ranked = rankPaletteRows(auditRows, "bra");
  assert.deepEqual(keys(ranked), ["project:b", "attn"]);
  // Control: the request DOES match, so the order above is a ranking, not a filter dropping it.
  assert.ok(matchGrade(auditRows[0], "bra") !== null);
});

check("grades: exact < prefix < word start < substring < context", () => {
  assert.equal(matchGrade({ kind: "page", label: "Board" }, "board"), 0);
  assert.equal(matchGrade({ kind: "page", label: "Boardroom" }, "board"), 1);
  assert.equal(matchGrade({ kind: "project", label: "AUDIT-Bravo" }, "bra"), 2);
  assert.equal(matchGrade({ kind: "agent", label: "Some thing" }, "thing"), 2);
  assert.equal(matchGrade({ kind: "project", label: "Library" }, "bra"), 3);
  assert.equal(matchGrade({ kind: "session", label: "QA", context: "AUDIT-Alpha" }, "alpha"), 4);
  assert.equal(matchGrade({ kind: "agent", label: "QA", context: "AUDIT-Alpha" }, "alpha"), 4);
  assert.equal(matchGrade({ kind: "session", label: "QA", context: "AUDIT-Alpha" }, "zzz"), null);
});

check("a PAGE's context is display-only: it never matches a query on its own", () => {
  // A page's context is the active project, so matching it would flood any query naming that project
  // with tab rows. The same context on a session (control, above) DOES match.
  assert.equal(matchGrade({ kind: "page", label: "Board", context: "AUDIT-Alpha" }, "alpha"), null);
});

check("a later word-start occurrence beats an earlier mid-word one in the same label", () => {
  // "abra" holds "bra" mid-word first; "Bravo" holds it at a word start later on.
  assert.equal(matchGrade({ kind: "project", label: "Abra Bravo" }, "bra"), 2);
});

check("matching is case-insensitive and ignores surrounding spaces", () => {
  assert.equal(matchGrade({ kind: "page", label: "Settings" }, "  SETT "), 1);
});

check("an empty query keeps every row in the caller's order", () => {
  assert.deepEqual(keys(rankPaletteRows(auditRows, "")), keys(auditRows));
  assert.deepEqual(keys(rankPaletteRows(auditRows, "   ")), keys(auditRows));
});

check("equal grades keep input order (the caller's grouping is the tiebreak)", () => {
  const rows = [row("p1", "page", "Settings", "Workspace"), row("p2", "page", "Settings", "AUDIT-Alpha")];
  assert.deepEqual(keys(rankPaletteRows(rows, "settings")), ["p1", "p2"]);
  assert.deepEqual(keys(rankPaletteRows([...rows].reverse(), "settings")), ["p2", "p1"]);
});

check("a project name typed finds that project and what runs in it, not its pages", () => {
  const ranked = rankPaletteRows(auditRows, "alpha");
  // The project itself (word start in its label) leads the session that matched on context; the
  // Board page, whose context is the same project, is not offered.
  assert.deepEqual(keys(ranked), ["project:a", "session:s1"]);
});

check("no match yields an empty list", () => {
  assert.deepEqual(rankPaletteRows(auditRows, "qqq"), []);
});

check("stepActive wraps at both ends and handles an empty list", () => {
  assert.equal(stepActive(0, 3, 1), 1);
  assert.equal(stepActive(2, 3, 1), 0);
  assert.equal(stepActive(0, 3, -1), 2);
  assert.equal(stepActive(-1, 3, 1), 0);
  assert.equal(stepActive(-1, 3, -1), 2);
  assert.equal(stepActive(5, 3, 1), 0);
  assert.equal(stepActive(0, 0, 1), -1);
});

console.log(`\n${pass} checks passed`);
