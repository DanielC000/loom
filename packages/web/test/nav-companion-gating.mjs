// Hermetic unit test for the Companion header-nav gating (UI-audit finding #4, card 1307fb2d).
// Owner ruling: Companion renders as a primary header tab ONLY when a companion is ACTIVE (an enabled
// companion config exists, and/or a live bound `assistant` session exists) — otherwise it stays under
// "More ▾ · Config" (today's default). The gating lives in src/lib/companion.ts (isCompanionActive /
// withCompanionNavGating), NOT nav.tsx itself: nav.tsx has top-level JSX (page element imports) that
// node's `--experimental-strip-types` runner can't parse, mirroring why column-sort/archive-invalidate
// pull their logic into a JSX-free lib module. nav.tsx's `useVisibleNavPages` just wires these two pure
// functions to react-query data — same pattern as pages/Companion.tsx's own companionConfigs/allSessions
// reads, so the test can't drift from what actually ships.
//
// The web package has no test runner, so this is a self-contained node script. Run it standalone with:
//   node --experimental-strip-types packages/web/test/nav-companion-gating.mjs
import assert from "node:assert/strict";
import { isCompanionActive, withCompanionNavGating } from "../src/lib/companion.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// A minimal NAV_PAGES-shaped fixture: Companion declared non-primary (its default "More ▾ · Config" slot),
// alongside an always-primary page, mirroring the real array's shape closely enough to exercise the gate.
const pages = () => [
  { to: "/", primary: true },
  { to: "/companion", primary: undefined },
  { to: "/skills" },
];

// ── isCompanionActive ────────────────────────────────────────────────────────────────────────────────

check("inactive: no configs, no sessions", () => {
  assert.equal(isCompanionActive(undefined, undefined), false);
  assert.equal(isCompanionActive([], []), false);
});

check("inactive: a config exists but is disabled, and no assistant session", () => {
  assert.equal(isCompanionActive([{ enabled: false }], [{ role: "worker" }, { role: "manager" }]), false);
});

check("active: an enabled config exists", () => {
  assert.equal(isCompanionActive([{ enabled: true }], []), true);
});

check("active: a disabled config plus an enabled one still counts", () => {
  assert.equal(isCompanionActive([{ enabled: false }, { enabled: true }], []), true);
});

check("active: no config at all, but a live bound assistant session exists", () => {
  assert.equal(isCompanionActive([], [{ role: "worker" }, { role: "assistant" }]), true);
});

check("active: both signals present", () => {
  assert.equal(isCompanionActive([{ enabled: true }], [{ role: "assistant" }]), true);
});

// ── withCompanionNavGating ───────────────────────────────────────────────────────────────────────────

check("active: Companion is promoted to a primary header tab", () => {
  const gated = withCompanionNavGating(pages(), true);
  const companion = gated.find((p) => p.to === "/companion");
  assert.equal(companion.primary, true);
});

check("inactive: Companion is demoted (stays under More ▾ · Config)", () => {
  const gated = withCompanionNavGating(pages(), false);
  const companion = gated.find((p) => p.to === "/companion");
  assert.equal(companion.primary, false);
});

check("gating never touches any other page's primary flag", () => {
  const before = pages();
  const gatedActive = withCompanionNavGating(before, true);
  const gatedInactive = withCompanionNavGating(before, false);
  assert.equal(gatedActive.find((p) => p.to === "/").primary, true);
  assert.equal(gatedActive.find((p) => p.to === "/skills").primary, undefined);
  assert.equal(gatedInactive.find((p) => p.to === "/").primary, true);
  assert.equal(gatedInactive.find((p) => p.to === "/skills").primary, undefined);
});

check("no duplicate entry: Companion appears exactly once, either primary or not, never both", () => {
  for (const active of [true, false]) {
    const gated = withCompanionNavGating(pages(), active);
    const matches = gated.filter((p) => p.to === "/companion");
    assert.equal(matches.length, 1, "exactly one /companion entry");
    assert.equal(matches[0].primary, active);
  }
});

console.log(`\n${pass} passed`);
