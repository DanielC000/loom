// Hermetic unit test for the Companion Manage section/group model (lib/companionManage.ts) — card
// e2af6ad7, Atlas build plan P2-6, closing §J.1 of docs/plans/atlas-ui/01-parity-checklist.md.
//
// WHAT IS ACTUALLY AT RISK, and why this is a list test rather than a render test. The classic
// Companion page renders all twelve Manage sections down one column; the Atlas Companion node renders
// the same twelve across four `?sec=` sub-sections. Each layout renders ONLY under its own Atlas-switch
// state, so no single rendered page can ever show both — a section that reaches one and misses the other
// is invisible to any test that drives the browser. Declaring the sections once and asserting over that
// declaration is the only check that sees both at the same time.
//
// THE ORDER PIN IS THE LOAD-BEARING ASSERTION. `COMPANION_MANAGE_SECTIONS`' order IS the classic page's
// column order, and the classic page must not move before phase 3 of the Atlas plan. The expected order
// below was written from today's rendered column (the twelve components in pages/Companion.tsx's
// `companion-panel-manage`), NOT copied from the module under test, so a re-order to suit the Atlas
// grouping fails here rather than silently relocating a control on a UI nobody opted into. It also
// supersedes, with something exact, the positional proxy in companion-multi.mjs (which only checks that
// the proactive home renders somewhere between the Manage panel marker and Pairing).
//
// The web package has no test runner, so this is a self-contained node script, auto-globbed by
// test/run-all.mjs (wired into @loom/web's `build`). Run standalone with:
//   node --experimental-strip-types packages/web/test/companion-manage-sections.mjs
import assert from "node:assert/strict";
import {
  COMPANION_MANAGE_GROUPS, COMPANION_MANAGE_SECTIONS, COMPANION_MODES,
  manageSectionsInGroup, resolveCompanionMode, resolveManageGroup,
} from "../src/lib/companionManage.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── The classic column, written out independently of the module under test ──────────────────────────
// Read off pages/Companion.tsx's Manage panel as it shipped before this card: ConfigSection,
// ProactiveHomeSection, VoiceProvisioningSection, ChannelsSection, PersonaSection, SkillsSection,
// MemorySection, RemindersSection, RestrictToolsSection, CapabilityGrantsSection, PairingSection,
// DeleteCompanionSection.
const CLASSIC_COLUMN = [
  "config", "home", "voice", "channels", "persona", "skills", "memory", "reminders",
  "restricted-tools", "capabilities", "pairing", "delete",
];

check("the flat order still IS the classic page's column order", () => {
  assert.deepEqual(
    COMPANION_MANAGE_SECTIONS.map((s) => s.key),
    CLASSIC_COLUMN,
    "COMPANION_MANAGE_SECTIONS' order is what the CLASSIC Companion page renders. Re-ordering it to " +
    "suit the Atlas grouping moves a control on a UI nobody opted into — group by filtering, never by " +
    "re-sorting this array (docs/decisions/e2af6ad7-atlas-companion-modes.md).",
  );
});

check("every section is declared exactly once", () => {
  const keys = COMPANION_MANAGE_SECTIONS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "a duplicated key would render one section twice");
  assert.equal(keys.length, 12, "twelve Manage sections — the count the parity checklist's §J.1 named ten of");
});

check("every section lands in a declared group, and no group is empty", () => {
  const groups = new Set(COMPANION_MANAGE_GROUPS.map((g) => g.key));
  for (const s of COMPANION_MANAGE_SECTIONS) {
    assert.ok(groups.has(s.group), `section ${s.key} names group "${s.group}", which is not declared`);
  }
  // An empty group is a sub-tab that renders nothing — a dead affordance, not a harmless one.
  for (const g of COMPANION_MANAGE_GROUPS) {
    assert.ok(manageSectionsInGroup(g.key).length > 0, `group "${g.key}" holds no sections`);
  }
});

check("the groups partition the sections — nothing dropped, nothing double-counted", () => {
  // THIS is the check that catches the invisible failure: the Atlas node renders group by group, so a
  // section whose group nobody renders is unreachable in Atlas while still fine on the classic page.
  const reachable = COMPANION_MANAGE_GROUPS.flatMap((g) => manageSectionsInGroup(g.key));
  assert.equal(reachable.length, COMPANION_MANAGE_SECTIONS.length, "the groups must cover every section exactly once");
  assert.deepEqual(
    [...reachable].sort(),
    [...CLASSIC_COLUMN].sort(),
    "every section the classic column renders must be reachable through exactly one Atlas sub-section",
  );
});

check("a group's own order follows the flat array, not its own idea of one", () => {
  for (const g of COMPANION_MANAGE_GROUPS) {
    const inGroup = manageSectionsInGroup(g.key);
    const expected = CLASSIC_COLUMN.filter((k) => inGroup.includes(k));
    assert.deepEqual(inGroup, expected, `group "${g.key}" re-orders its sections relative to the classic column`);
  }
});

check("each group carries a label and a one-line blurb", () => {
  for (const g of COMPANION_MANAGE_GROUPS) {
    assert.ok(g.label.length > 0, `group "${g.key}" has no label`);
    assert.ok(g.blurb.length > 0, `group "${g.key}" has no blurb`);
    // The blurb sits on ONE line under the sub-tab row at `.loom-companion-manage-blurb`'s own 68ch
    // measure; a paragraph there is a paragraph nobody reads. Measured at 1600px: 68 chars is the wrap
    // point, so this cap is the rendered one, not a guess.
    assert.ok(g.blurb.length <= 68, `group "${g.key}"'s blurb is ${g.blurb.length} chars — it will wrap to a second line`);
    assert.ok(!g.blurb.includes("\n"), `group "${g.key}"'s blurb must be a single line`);
  }
});

// ── The `?sec=` / `?tab=` resolvers ─────────────────────────────────────────────────────────────────
// Both fall back rather than render nothing: an old link, a hand-typed typo and a cleared param are all
// the same case to a reader, and an empty node is a worse answer than the canonical one.

check("resolveManageGroup falls back to the first group for anything it does not name", () => {
  for (const g of COMPANION_MANAGE_GROUPS) assert.equal(resolveManageGroup(g.key), g.key);
  const first = COMPANION_MANAGE_GROUPS[0].key;
  assert.equal(resolveManageGroup(null), first, "no ?sec= at all");
  assert.equal(resolveManageGroup(undefined), first);
  assert.equal(resolveManageGroup(""), first);
  assert.equal(resolveManageGroup("nonsense"), first);
  // Case matters: the param is an identifier, not prose. A near-miss resolving silently would make the
  // URL look authoritative when it is not.
  assert.equal(resolveManageGroup("Trust"), first);
});

check("resolveCompanionMode falls back to Chat, the companion's canonical face", () => {
  for (const m of COMPANION_MODES) assert.equal(resolveCompanionMode(m.key), m.key);
  assert.equal(resolveCompanionMode(null), "chat", "the bare /companion address is Chat");
  assert.equal(resolveCompanionMode(undefined), "chat");
  assert.equal(resolveCompanionMode(""), "chat");
  assert.equal(resolveCompanionMode("manage "), "chat", "a trailing space is not a mode");
  assert.equal(resolveCompanionMode("Terminal"), "chat");
});

check("the three modes are exactly the three the classic page offers", () => {
  // The classic ModeToggle's own options, written out here rather than imported: if the Atlas node ever
  // gained (or lost) a mode, these two surfaces would disagree about what a companion even has.
  assert.deepEqual(COMPANION_MODES.map((m) => m.key), ["chat", "manage", "terminal"]);
  assert.deepEqual(COMPANION_MODES.map((m) => m.label), ["Chat", "Manage", "Terminal"]);
});

console.log(`\n${pass} checks passed`);
