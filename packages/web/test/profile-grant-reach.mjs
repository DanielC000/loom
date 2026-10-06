// Hermetic unit test for lib/profileGrantReach.ts — the pre-save gate behind card 3c4e0df6 (the Profiles
// editor confirms a human-only grant's blast radius before it takes effect).
//
// ⚠️ SCOPE, stated up front: this covers the PLANNER and the two grant-slice ADAPTERS it is fed, nothing
// else. The defect class this gate exists to avoid is a caller sampling an unresolved query as if it were
// an empty answer, and a pure test structurally cannot see WHEN its caller samples state (the 654869e2
// lesson) — it supplies the inputs itself. The WIRING — that Profiles.tsx actually passes
// `isSuccess ? data : null` and not `data ?? []` — is proved by packages/web/e2e/profile-grant-reach.spec.ts,
// which ABORTS the agents request against a real daemon. Neither test substitutes for the other.
//
// The adapter half (card 6eb31db4) is here for a reason the §ADAPTERS block below states: a key pinned to
// a constant in `grantFieldsOfValues` reads as "nothing granted" forever, which the planner cannot see
// because the pin happens one layer above it.
//
// The web package has no test runner, so this is a self-contained node script importing the pure module
// directly (only `import type` is stripped), mirroring test/form-sync.mjs. Run it with:
//   node --experimental-strip-types packages/web/test/profile-grant-reach.mjs
import assert from "node:assert/strict";
import { AGENT_FORBIDDEN_PROFILE_KEYS, addedProfileGrants } from "@loom/shared";
import {
  planGrantSave, grantKeyList, GRANT_REACH_UNKNOWN,
  grantFieldsOfProfile, grantFieldsOfValues, parseAllowDelta,
} from "../src/lib/profileGrantReach.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const BARE = { connections: [], capabilities: [], allowDelta: [] };
const fields = (over = {}) => ({ ...BARE, ...over });

const AGENTS = [
  { id: "a1", name: "Dev", projectId: "p1", projectName: "Alpha", profileId: "rig" },
  { id: "a2", name: "QA", projectId: "p2", projectName: "Beta", profileId: "rig" },
  { id: "a3", name: "Elsewhere", projectId: "p1", projectName: "Alpha", profileId: "other-rig" },
];

check("a grant-free edit plans a plain save, with no prompt", () => {
  const plan = planGrantSave(fields({ connections: ["c1"] }), fields({ connections: ["c1"] }), "rig", AGENTS);
  assert.equal(plan.kind, "save");
});

check("adding a grant with agents bound plans a confirm naming them", () => {
  const plan = planGrantSave(fields(), fields({ vaultWrite: true }), "rig", AGENTS);
  assert.equal(plan.kind, "confirm");
  assert.deepEqual(plan.addedKeys, ["vaultWrite"]);
  assert.equal(plan.agentCount, 2);
  assert.deepEqual(plan.agents.map((a) => `${a.projectName}/${a.name}`), ["Alpha/Dev", "Beta/QA"]);
});

check("an agent bound to a DIFFERENT profile is never counted", () => {
  const plan = planGrantSave(fields(), fields({ vaultWrite: true }), "rig", AGENTS);
  assert.ok(!plan.agents.some((a) => a.id === "a3"));
});

check("adding a grant with NOBODY bound plans a plain save — there is no blast radius to show", () => {
  // The daemon still files its event in this case; the UI simply has nothing worth interrupting for.
  const plan = planGrantSave(fields(), fields({ vaultWrite: true }), "unbound-rig", AGENTS);
  assert.equal(plan.kind, "save");
});

check("a genuinely empty install (loaded, zero agents) is a save, not an unknown", () => {
  // The whole point of the null/[] split: [] is a real answer and must not read as "could not load".
  const plan = planGrantSave(fields(), fields({ vaultWrite: true }), "rig", []);
  assert.equal(plan.kind, "save");
});

check("FAIL-CLOSED: an UNLOADED agent list still confirms, and never claims zero", () => {
  const plan = planGrantSave(fields(), fields({ vaultWrite: true }), "rig", null);
  assert.equal(plan.kind, "confirm-unknown");
  assert.deepEqual(plan.addedKeys, ["vaultWrite"]);
  // There must be no agent count anywhere on this plan — a "0 agents" reading is exactly the silent
  // fail-open this gate exists to prevent.
  assert.equal(plan.agentCount, undefined);
  assert.equal(plan.agents, undefined);
});

check("an unloaded list does NOT invent a prompt when no grant is being added", () => {
  // Fail-closed applies to the REACH, not to the grant test itself — a rename must still save cleanly
  // even while the agents query is down, or an outage blocks every unrelated profile edit.
  const plan = planGrantSave(fields({ vaultWrite: true }), fields({ vaultWrite: true }), "rig", null);
  assert.equal(plan.kind, "save");
});

check("a grant being REMOVED is not a grant, loaded or not", () => {
  assert.equal(planGrantSave(fields({ vaultWrite: true }), fields(), "rig", AGENTS).kind, "save");
  assert.equal(planGrantSave(fields({ vaultWrite: true }), fields(), "rig", null).kind, "save");
});

check("a SECOND connection on a profile that already had one still confirms", () => {
  // The case a non-empty "is it carried" check cannot see — a new secret reaching every bound agent.
  const plan = planGrantSave(fields({ connections: ["c1"] }), fields({ connections: ["c1", "c2"] }), "rig", AGENTS);
  assert.equal(plan.kind, "confirm");
  assert.deepEqual(plan.addedKeys, ["connections"]);
});

check("grantKeyList reads as prose for one, two and three keys", () => {
  assert.equal(grantKeyList(["vaultWrite"]), "vault write");
  assert.equal(grantKeyList(["connections", "vaultWrite"]), "authenticated-egress connections and vault write");
  assert.equal(
    grantKeyList(["connections", "capabilities", "vaultWrite"]),
    "authenticated-egress connections, capability grants and vault write",
  );
  assert.equal(grantKeyList([]), "");
});

check("the unknown-reach copy says it could not load, never that nobody is bound", () => {
  assert.match(GRANT_REACH_UNKNOWN, /could not load/i);
  assert.doesNotMatch(GRANT_REACH_UNKNOWN, /\b(no|zero|0)\s+agents?\b/i);
});

// ── §ADAPTERS — the two projections the planner is fed (card 6eb31db4) ──────────────────────────────
//
// The planner above is only as good as the slices handed to it, and `grantFieldsOfValues` is where a
// FAIL-OPEN hides: `vaultWrite` used to be pinned `false` there (honestly, while no control exposed it),
// so once card 6eb31db4 shipped the toggle a ticked box would have reported `false`, `addedProfileGrants`
// would have seen no added grant, and the save would have landed with no confirm at all. Every check
// below is about one property — the adapter reports the LIVE field, never a constant.

/** The editor's full ProfileFields record — a superset of ProfileGrantFormValues, as the real call site
 *  passes. Everything off/empty, so each check turns exactly one thing on. */
const FORM = {
  name: "Rig", role: "", description: "", icon: "", model: "",
  allowText: "", connections: [], capabilities: [], vaultWrite: false,
  harness: "claude", browserTesting: false, documentConversion: false,
  restrictedTools: false, noCommit: false, skills: [],
};
const form = (over = {}) => ({ ...FORM, ...over });

check("ADAPTER: grantFieldsOfValues reports the LIVE vaultWrite, not a pinned constant", () => {
  // The regression this card fixed, asserted at the layer that carried it.
  assert.equal(grantFieldsOfValues(form({ vaultWrite: true })).vaultWrite, true);
  assert.equal(grantFieldsOfValues(form()).vaultWrite, false);
});

check("ADAPTER: a vaultWrite false→true flip is an ADDED grant end to end", () => {
  // The whole chain the toggle depends on: stored row → baseline slice, form → after slice, planner.
  const stored = { connections: [], capabilities: [], allowDelta: [], vaultWrite: false };
  const plan = planGrantSave(
    grantFieldsOfProfile(stored),
    grantFieldsOfValues(form({ vaultWrite: true })),
    "rig",
    AGENTS,
  );
  assert.equal(plan.kind, "confirm");
  assert.deepEqual(plan.addedKeys, ["vaultWrite"]);
  assert.equal(plan.agentCount, 2);
});

check("ADAPTER: turning vaultWrite OFF again is not a grant", () => {
  const stored = { connections: [], capabilities: [], allowDelta: [], vaultWrite: true };
  const plan = planGrantSave(grantFieldsOfProfile(stored), grantFieldsOfValues(form()), "rig", AGENTS);
  assert.equal(plan.kind, "save");
});

check("ADAPTER: NO grant key is pinned — each one alone is detected as added", () => {
  // The generalisation of the vaultWrite pin, so the next key added cannot repeat it: for every member of
  // AGENT_FORBIDDEN_PROFILE_KEYS, flipping ONLY that field in the FORM must make the adapter pair report
  // exactly that key. A constant anywhere in grantFieldsOfValues fails here rather than in production.
  const FLIP = {
    connections: { connections: ["c9"] },
    capabilities: { capabilities: [{ slug: "browser-testing" }] },
    vaultWrite: { vaultWrite: true },
    harness: { harness: "codex" },
    browserTesting: { browserTesting: true },
    documentConversion: { documentConversion: true },
    allowDelta: { allowText: "Read(*)" },
  };
  // Positive control on the loop itself: a missing key would silently test fewer fields than it claims.
  assert.deepEqual(Object.keys(FLIP).sort(), [...AGENT_FORBIDDEN_PROFILE_KEYS].sort());
  const baseline = grantFieldsOfValues(form());
  for (const key of AGENT_FORBIDDEN_PROFILE_KEYS) {
    const after = grantFieldsOfValues(form(FLIP[key]));
    assert.deepEqual(addedProfileGrants(baseline, after), [key], `flipping ${key} alone must add ${key}`);
  }
});

check("ADAPTER: allowText is PARSED, so a whitespace-only edit grants nothing", () => {
  const before = grantFieldsOfValues(form({ allowText: "Read(*)\nBash(pnpm *)" }));
  const after = grantFieldsOfValues(form({ allowText: "  Read(*)  \n\n  Bash(pnpm *)\n" }));
  assert.deepEqual(after.allowDelta, ["Read(*)", "Bash(pnpm *)"]);
  assert.deepEqual(addedProfileGrants(before, after), []);
  assert.deepEqual(parseAllowDelta(""), []);
});

check("ADAPTER: grantFieldsOfProfile narrows to the grant keys and drops computed state", () => {
  // A whole ProfileSummary carries bundled/customized/updateAvailable; none of it is any part of a grant.
  const slice = grantFieldsOfProfile({
    connections: ["c1"], capabilities: [], allowDelta: ["Read(*)"], vaultWrite: true,
    harness: "codex", browserTesting: false, documentConversion: true,
    name: "Rig", bundled: true, customized: true, updateAvailable: true,
  });
  assert.deepEqual(Object.keys(slice).sort(), [...AGENT_FORBIDDEN_PROFILE_KEYS].sort());
  assert.equal(slice.vaultWrite, true);
});

console.log(`\n${pass} check(s) passed`);
