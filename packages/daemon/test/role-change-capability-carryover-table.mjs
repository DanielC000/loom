import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure function test
// Card acd3c688 "also in scope" (from delta Code Review 9061ed1c of 05153988, APPROVED Minor): a
// table-driven unit test for `roleChangeCapabilityCarryoverError`'s per-key "carried" predicates
// (profiles/validate.ts's `AGENT_FORBIDDEN_PROFILE_KEY_CARRIED`) — previously pinned end to end only for
// browserTesting. One row per `AGENT_FORBIDDEN_PROFILE_KEYS` member: a SET value ⇒ carried (role-change
// refused); an empty/false/"claude" value ⇒ NOT carried (role-change allowed); plus a no-role-change row
// ⇒ null regardless of carried grants (the function's own first check).
//
// Run: 1) build (turbo builds shared first), 2) node test/role-change-capability-carryover-table.mjs
import { AGENT_FORBIDDEN_PROFILE_KEYS } from "@loom/shared";
const { roleChangeCapabilityCarryoverError } = await import("../dist/profiles/validate.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The full set of forbidden keys, each with a BACKSTOP (not-carried) value and a SET (carried) value.
const ROWS = {
  connections: { backstop: [], set: ["connX"] },
  capabilities: { backstop: [], set: [{ slug: "some-capability" }] },
  vaultWrite: { backstop: false, set: true },
  harness: { backstop: "claude", set: "codex" },
  browserTesting: { backstop: false, set: true },
  documentConversion: { backstop: false, set: true },
  allowDelta: { backstop: [], set: ["Bash(*)"] },
};

check("(setup) the table above covers every AGENT_FORBIDDEN_PROFILE_KEYS member, no more, no fewer",
  JSON.stringify(Object.keys(ROWS).sort()) === JSON.stringify([...AGENT_FORBIDDEN_PROFILE_KEYS].sort()));

const backstopProfile = () => Object.fromEntries(AGENT_FORBIDDEN_PROFILE_KEYS.map((k) => [k, ROWS[k].backstop]));

for (const key of AGENT_FORBIDDEN_PROFILE_KEYS) {
  // (A) SET ⇒ carried ⇒ a genuine role change is refused, naming this key.
  {
    const existing = { ...backstopProfile(), [key]: ROWS[key].set };
    const err = roleChangeCapabilityCarryoverError("worker", "manager", existing);
    check(`(${key}) SET ⇒ carried ⇒ role change REFUSED`, typeof err === "string");
    check(`(${key}) SET ⇒ the refusal names this key`, err?.includes(key));
  }
  // (B) backstop (empty/false/"claude") ⇒ NOT carried ⇒ a role change with ONLY this key at backstop,
  // all others also at backstop, is ALLOWED (null).
  {
    const existing = backstopProfile();
    const err = roleChangeCapabilityCarryoverError("worker", "manager", existing);
    check(`(${key}) backstop (all keys) ⇒ NOT carried ⇒ role change ALLOWED (null)`, err === null);
  }
}

// (C) no-role-change row ⇒ null regardless of carried grants (checked FIRST, before any key is examined).
{
  const existing = Object.fromEntries(AGENT_FORBIDDEN_PROFILE_KEYS.map((k) => [k, ROWS[k].set]));
  check("(no-role-change) previousRole === newRole ⇒ null even with EVERY key carried",
    roleChangeCapabilityCarryoverError("manager", "manager", existing) === null);
  check("(no-role-change) both null ⇒ null (not a role change)",
    roleChangeCapabilityCarryoverError(null, null, existing) === null);
  check("(no-role-change) undefined vs null ⇒ treated as the SAME (both normalize to null) ⇒ null",
    roleChangeCapabilityCarryoverError(undefined, null, existing) === null);
}

// (D) multiple carried keys are ALL named in one refusal (not just the first).
{
  const existing = { ...backstopProfile(), connections: ["c1"], vaultWrite: true };
  const err = roleChangeCapabilityCarryoverError("worker", "manager", existing);
  check("(multi) both carried keys are named in the SAME refusal", err?.includes("connections") && err?.includes("vaultWrite"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — roleChangeCapabilityCarryoverError's per-key carried predicates are pinned end to end for every AGENT_FORBIDDEN_PROFILE_KEYS member (not just browserTesting): a set value refuses and names the key, a backstop value allows, a no-role-change row is always null, and multiple carried keys are all named together."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
