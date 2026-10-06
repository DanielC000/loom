// Hermetic unit test for lib/profileGrantReach.ts — the pre-save gate behind card 3c4e0df6 (the Profiles
// editor confirms a human-only grant's blast radius before it takes effect).
//
// ⚠️ SCOPE, stated up front: this covers the PLANNER only. The defect class this gate exists to avoid is a
// caller sampling an unresolved query as if it were an empty answer, and a pure test structurally cannot
// see WHEN its caller samples state (the 654869e2 lesson) — it supplies the inputs itself. The WIRING —
// that Profiles.tsx actually passes `isSuccess ? data : null` and not `data ?? []` — is proved by
// packages/web/e2e/profile-grant-reach.spec.ts, which ABORTS the agents request against a real daemon.
// Neither test substitutes for the other.
//
// The web package has no test runner, so this is a self-contained node script importing the pure module
// directly (only `import type` is stripped), mirroring test/form-sync.mjs. Run it with:
//   node --experimental-strip-types packages/web/test/profile-grant-reach.mjs
import assert from "node:assert/strict";
import { planGrantSave, grantKeyList, GRANT_REACH_UNKNOWN } from "../src/lib/profileGrantReach.ts";

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

console.log(`\n${pass} check(s) passed`);
