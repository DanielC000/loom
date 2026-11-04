// Hermetic guard for Usage.tsx's INTERACTIVE-session copy (UI-audit finding #2, card 51388021).
//
// WHY THIS EXISTS: the interactive-session usage plane once framed its dollar figure as "BILLED" /
// "COST (BILLED)" / "genuine spend", implying metered charges. On a flat Claude subscription that's
// misleading — the $ is an ESTIMATE of what the tokens WOULD cost on metered API (plan consumption),
// not a separate bill. The owner keeps the $ estimate; only the framing changed. This guard fails the
// build if "billed"/"spend"/"genuine" wording creeps back onto the interactive-session section, AND
// asserts the dollar estimate (fmtUsd of the interactive totals) is still rendered.
//
// It's a lightweight STRUCTURAL check (no React render, no DOM, no deps), mirroring terminal-chrome.mjs:
// it reads Usage.tsx, slices out ONLY the interactive-session section (SessionUsageSection through the
// by-day chart), and asserts the framing on that slice. It deliberately does NOT look at the Agent Runs
// section or live occupancy, which legitimately say "billed"/"spend".
//
// Run standalone:  node packages/web/test/usage-consumption-wording.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/pages/Usage.tsx", import.meta.url), "utf8");

// Scope to the interactive-session section: from its section marker to the note that closes the file
// (card 30266229 moved the shared primitives — MetricToggle included, which used to END this slice — to
// components/usageKit.tsx and left that note in their place). This covers the section head tag,
// description, empty state, aggregate strip, per-project/-agent rows, and the ByDayChart — i.e. every
// interactive-session-facing string — and nothing from Agent Runs / live occupancy, both of which are
// declared ABOVE the start marker.
const startMarker = "// ── Interactive-sessions (historical · est. consumption) section";
const endMarker = "// `MetricToggle` (the by-day chart's cost|tokens picker)";
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker);
assert.notEqual(startIdx, -1, "interactive-session section marker not found — did Usage.tsx get restructured?");
assert.notEqual(endIdx, -1, "by-day chart marker not found — did Usage.tsx get restructured?");
assert.ok(endIdx > startIdx, "interactive-session slice bounds are inverted");
const section = src.slice(startIdx, endIdx);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("interactive-session copy has no metered-billing framing (billed / spend / genuine)", () => {
  for (const bad of [/\bbilled\b/i, /\bspend\b/i, /\bgenuine\b/i]) {
    assert.equal(section.match(bad), null, `interactive-session section still contains ${bad}`);
  }
});

check("interactive-session copy frames the $ as an estimate / consumption", () => {
  assert.match(section, /est\.\s*consumption|estimat/i, "no estimate/consumption framing found on the interactive-session $");
});

check("the interactive-session dollar ESTIMATE is still rendered (fmtUsd on the cost total)", () => {
  assert.match(section, /fmtUsd\(totals\.costUsd\)/, "the interactive-session $ estimate (fmtUsd(totals.costUsd)) was removed — the owner keeps it");
});

console.log(`\n${pass} passed`);
