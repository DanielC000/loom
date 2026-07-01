// Hermetic unit test for src/lib/profileRoles.ts — the pure role-option list behind the Profiles
// page's role <Select> (pages/Profiles.tsx). Guards UI-audit finding #3 (card 146a3301): the dropdown
// used to be a frozen hardcoded subset missing `assistant`, so opening the seeded Companion profile
// rendered role "(plain)" and SAVING clobbered its real role to plain. This asserts the option set is
// derived from — and stays exactly in sync with — the shared SessionRole union, so a future role can
// never be silently missing again.
//
// The web package has no test runner, so this is a self-contained node script. It imports the pure
// list directly (via Node's type stripping) and the built @loom/shared package (turbo builds shared
// before web, so dist/ is guaranteed to exist). Run it with:
//   node --experimental-strip-types packages/web/test/profileRoles.mjs
import assert from "node:assert/strict";
import { SESSION_ROLES } from "@loom/shared";
import { PROFILE_ROLE_OPTIONS } from "../src/lib/profileRoles.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("PROFILE_ROLE_OPTIONS is the blank default plus every SessionRole, in shared's order", () => {
  assert.deepEqual(PROFILE_ROLE_OPTIONS, ["", ...SESSION_ROLES]);
});

check("every SessionRole appears exactly once, with no extras and no duplicates", () => {
  const nonBlank = PROFILE_ROLE_OPTIONS.filter((r) => r !== "");
  assert.deepEqual(new Set(nonBlank), new Set(SESSION_ROLES), "the rendered option set must equal the SessionRole union");
  assert.equal(nonBlank.length, SESSION_ROLES.length, "no duplicate options");
});

check("assistant is selectable (the regression this test guards against)", () => {
  assert.ok(PROFILE_ROLE_OPTIONS.includes("assistant"));
});

console.log(`\n${pass} passed`);
