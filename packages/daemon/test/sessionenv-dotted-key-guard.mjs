// Card 12400719 — the config write validator rejects a `sessionEnv` key that contains a literal "."
// (see @decision 12400719 / docs/decisions/12400719-reject-dotted-sessionenv-key.md for the full
// rationale). `sessionEnv` is the only record-shaped config field addressed element-wise by the config
// PATCH's `unset` dot-path grammar (`sessionEnv.<key>`); a key literally containing "." can never be
// spelled as one path segment there, so once stored it could never be individually removed — this test
// pins the fix at the validator boundary (`validateProjectConfigOverride`, `mcp/platform.ts`), which is
// the ONE write path a dotted sessionEnv key could ever reach (the agent-facing schema omits `sessionEnv`
// entirely, so `validateAgentProjectConfigOverride` was never a route for this field).
//
// Hermetic — imports the built validator from dist/* only (no daemon, no db, no claude), mirroring
// test/config-bounds.mjs's style for a pure schema check.
//
// Proves:
//   (1) POSITIVE CONTROL — a plain (undotted) sessionEnv key is still accepted, so the rejection below
//       is scoped to the dot, not an accidental full-field lockout.
//   (2) A dotted key is rejected, and the reason names the OFFENDING KEY and explains WHY (the unset
//       dot-path grammar), not a bare/opaque zod path+type error.
//   (3) A dotted key mixed alongside otherwise-valid plain keys is still rejected as a whole (fail
//       closed on the write, not a silent partial-drop of just the bad key).
//   (4) The pre-existing `__proto__` rejection (@decision c9a2f1e0) still fires — proves the two
//       preprocess layers (dunder-proto + dotted-key) compose without one silently swallowing the other.
//   (5) An empty/absent sessionEnv is untouched (no false positive on the common no-op case).
//   (6) Card 5b290c3c refinement — an ALREADY-STORED dotted key's VALUE may still be rotated via
//       `priorSessionEnvKeys`, while a genuinely NEW dotted key stays rejected (including mixed with an
//       existing one in the same write), and omitting the option entirely preserves the original
//       reject-everything default.
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const withEnv = (sessionEnv) => ({ sessionEnv });

// --- (1) positive control: a plain key is unaffected -------------------------------------------------
{
  const ok = validateProjectConfigOverride(withEnv({ LOOM_DEJA_BIN: "/usr/bin/deja" }));
  check("(1) positive control: a plain (undotted) sessionEnv key is accepted", ok.ok === true);
  check("(1) positive control: the accepted value round-trips unchanged",
    ok.ok === true && ok.value.sessionEnv?.LOOM_DEJA_BIN === "/usr/bin/deja");
}

// --- (2) a dotted key is rejected with a usable, specific reason --------------------------------------
{
  const bad = validateProjectConfigOverride(withEnv({ "a.b": "x" }));
  check("(2) a dotted sessionEnv key is rejected", bad.ok === false);
  check("(2) the reason NAMES the offending key",
    bad.ok === false && bad.error.includes('"a.b"'));
  check("(2) the reason explains WHY (the unset dot-path grammar), not a bare zod error",
    bad.ok === false && /unset/i.test(bad.error) && /dot-path/i.test(bad.error));
  // Contrast: a bare `z.record` failure (the pre-fix shape) would have read as a generic
  // "Invalid input"/"Expected string, received ..." zod message with no mention of "." or "unset" at
  // all — asserting the message's CONTENT (not just ok:false) is what catches a regression back to that.
  check("(2) the reason is not a generic/opaque zod message",
    bad.ok === false && !/^\(root\): Invalid$/i.test(bad.error.trim()));
}

// --- (3) a dotted key mixed with valid plain keys still fails the WHOLE write -------------------------
{
  const bad = validateProjectConfigOverride(withEnv({ GOOD_KEY: "1", "bad.key": "2" }));
  check("(3) a dotted key mixed with plain keys still rejects the whole sessionEnv write", bad.ok === false);
  check("(3) the reason names the actually-offending key", bad.ok === false && bad.error.includes('"bad.key"'));
}

// --- (4) the pre-existing __proto__ rejection still fires (composition sanity) -------------------------
// A plain object LITERAL `{ __proto__: "x" }` does NOT create an own "__proto__" property — for a
// non-object/non-null value the literal's special `__proto__` syntax silently no-ops instead (this is
// exactly the JS gotcha @decision c9a2f1e0's own record explains). JSON.parse builds via
// CreateDataProperty, not that special-cased [[Set]], so it produces a genuine own key the same way a
// real HTTP/MCP JSON body would.
{
  const raw = JSON.parse('{"config":{"sessionEnv":{"__proto__":"x"}}}').config;
  check("(4) sanity: the JSON.parse fixture really carries an OWN __proto__ key",
    Object.hasOwn(raw.sessionEnv, "__proto__"));
  const bad = validateProjectConfigOverride(raw);
  check("(4) __proto__ is still rejected after adding the dotted-key check", bad.ok === false);
  check("(4) the __proto__ reason is unchanged (dotted-key check didn't swallow it)",
    bad.ok === false && /__proto__/.test(bad.error));
}

// --- (5) no false positive on the common empty/absent case ---------------------------------------------
{
  check("(5) an absent sessionEnv is accepted", validateProjectConfigOverride({}).ok === true);
  check("(5) an empty sessionEnv object is accepted", validateProjectConfigOverride(withEnv({})).ok === true);
}

// --- sanity: sessionEnv is omitted from the agent-facing schema entirely (pre-existing, unrelated to
// this card) — a dotted key on that path is therefore rejected as an UNKNOWN key (.strict()), not
// reachable via this card's own check at all. Included only so a future schema change that re-adds
// sessionEnv to the agent path doesn't silently skip this guard.
{
  const bad = validateAgentProjectConfigOverride(withEnv({ "a.b": "x" }));
  check("(sanity) sessionEnv is not an agent-settable field at all (rejected as unknown key)", bad.ok === false);
}

// --- (6) card 5b290c3c refinement: an ALREADY-STORED dotted key may have its VALUE rotated -------------
// The original fix rejected every dotted key unconditionally, which also broke a legitimate in-place
// value rotation of a pre-existing dotted key (the Settings panel's own documented/tested behavior,
// packages/web/e2e/settings-session-env.spec.ts's "a pre-existing DOTTED key can have its value changed"
// case) — caught diagnosing card 5b290c3c. `priorSessionEnvKeys` is how a caller states which keys
// already exist; only a key NOT in that set is still rejected.
{
  const priorSessionEnvKeys = new Set(["MY.VAR"]);
  const rotated = validateProjectConfigOverride(withEnv({ "MY.VAR": "rotated" }), { priorSessionEnvKeys });
  check("(6) an EXISTING dotted key's value rotation is accepted when it's named in priorSessionEnvKeys",
    rotated.ok === true && rotated.value.sessionEnv?.["MY.VAR"] === "rotated");

  const stillNew = validateProjectConfigOverride(withEnv({ "brand.new": "x" }), { priorSessionEnvKeys });
  check("(6) a GENUINELY NEW dotted key is still rejected even when priorSessionEnvKeys is non-empty",
    stillNew.ok === false && stillNew.error.includes('"brand.new"'));

  const noContext = validateProjectConfigOverride(withEnv({ "MY.VAR": "rotated" }));
  check("(6) omitting priorSessionEnvKeys entirely still rejects every dotted key (unchanged default)",
    noContext.ok === false && noContext.error.includes('"MY.VAR"'));

  const mixed = validateProjectConfigOverride(
    withEnv({ "MY.VAR": "rotated", "brand.new": "x" }),
    { priorSessionEnvKeys },
  );
  check("(6) one existing + one new dotted key in the same write still rejects the whole write",
    mixed.ok === false && mixed.error.includes('"brand.new"'));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the config write validator rejects a dot-bearing sessionEnv key name with a reason naming the offending key and the unset dot-path grammar, accepts plain keys and the empty/absent case unchanged, fails the whole write when a dotted key is mixed with valid ones, composes correctly alongside the pre-existing __proto__ rejection, and (card 5b290c3c) lets an ALREADY-STORED dotted key's value be rotated via priorSessionEnvKeys while a genuinely new dotted key stays rejected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
