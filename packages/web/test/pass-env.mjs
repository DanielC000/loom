// Hermetic unit test for lib/passEnv.ts — the client-side mirror of the daemon's `passEnv` validation,
// behind the Capabilities Settings panel's per-row ambient-env editor (card dec4959a; the field itself
// is card fafae623).
//
// ⚠️ WHAT THIS CAN AND CANNOT PROVE, stated up front. This is a PURE test of the mirror. It proves the
// mirror's own rules and its message text; it CANNOT prove the mirror still agrees with the daemon,
// because the daemon's copy lives in @loom/daemon, which the web package does not depend on and this
// file therefore cannot import. So the §PINNED block below quotes the server's strings LITERALLY and
// asserts the mirror reproduces them byte-for-byte — a human-maintained equivalence, not a derived one.
// If packages/daemon/src/capabilities/registry.ts changes a rule, THIS FILE goes stale silently and the
// e2e spec (packages/web/e2e/capability-pass-env.spec.ts), which drives a real daemon, is what catches
// it. Neither test substitutes for the other.
//
// The strings pinned below were read from packages/daemon/src/capabilities/registry.ts at the time of
// writing (`validatePassEnv`, `passEnvReservedReason`, `ENV_KEY_NAME_RE`, `PASS_ENV_MAX_KEYS`):
//   `passEnv must be an array of at most 32 env var names`
//   `passEnv entry ${JSON.stringify(entry)} is not a valid env var name`
//   `passEnv entry rejected: ${reason}`
//   `'${name}' is a reserved Loom credential name`      (exact: LOOM_MCP_TOKEN)
//   `'${name}' matches the reserved '${prefix}*' prefix` (prefixes: CLAUDE_CODE_, LOOM_)
//
// NEGATIVE CONTROLS are recorded at the bottom of this file: four mutants that each KEEP the exported
// function and disable only its logic, so no leg passes for the structural reason (lesson 298).
//
// The web package has no test runner, so this is a self-contained node script importing the pure module
// directly (only `import type` is stripped), mirroring test/profile-grant-reach.mjs. Run it with:
//   node --experimental-strip-types packages/web/test/pass-env.mjs
import assert from "node:assert/strict";
import {
  ENV_KEY_NAME_RE, PASS_ENV_MAX_KEYS,
  duplicatePassEnvIndexes, passEnvEntryError, passEnvReservedReason, validatePassEnv,
} from "../src/lib/passEnv.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// --- (A) the charset rule ------------------------------------------------------------------------

check("a plain identifier is accepted, in every legal shape", () => {
  for (const name of ["HTTPS_PROXY", "npm_config_registry", "_LEADING", "A", "a1", "X_9_z"]) {
    assert.equal(validatePassEnv([name]).ok, true, `${name} must be accepted`);
    assert.equal(passEnvEntryError(name), null, `${name} must carry no row error`);
  }
});

check("every illegal shape is rejected — and the regex itself agrees", () => {
  // Each of these is a DIFFERENT way to be illegal, so one over-broad fix cannot satisfy them all:
  // a leading digit, a space, an `=`, shell metacharacters, a hyphen, a dot, and the empty string.
  for (const name of ["9LIVES", "HAS SPACE", "A=B", "X;rm -rf /", "$(id)", "A-B", "A.B", "", "a\nb"]) {
    const r = validatePassEnv([name]);
    assert.equal(r.ok, false, `${JSON.stringify(name)} must be rejected`);
    assert.equal(ENV_KEY_NAME_RE.test(name), false, `${JSON.stringify(name)} must fail the regex`);
  }
  // The row-level helper agrees for every non-empty one. "" is deliberately exempt (an unfinished row).
  for (const name of ["9LIVES", "HAS SPACE", "A=B", "A-B"]) {
    assert.match(passEnvEntryError(name), /not a valid env var name/i);
  }
  assert.equal(passEnvEntryError(""), null, "a blank row is unfinished, not an error");
});

check("a non-string entry is rejected without throwing", () => {
  for (const entry of [null, 42, true, {}, [], undefined]) {
    assert.equal(validatePassEnv([entry]).ok, false, `${JSON.stringify(entry ?? null)} must be rejected`);
  }
});

// --- (B) the reserved-name denylist -------------------------------------------------------------

check("the LOOM_ and CLAUDE_CODE_ prefixes are reserved, case-insensitively", () => {
  for (const name of ["LOOM_HOME", "Loom_home", "loom_anything", "CLAUDE_CODE_X", "claude_code_x"]) {
    const reason = passEnvReservedReason(name);
    assert.ok(reason, `${name} must be reserved`);
    assert.equal(validatePassEnv([name]).ok, false, `${name} must be rejected by the array validator`);
  }
  // A name that merely CONTAINS a reserved prefix, rather than starting with it, is fine — the rule is
  // startsWith, and widening it to `includes` would reject legitimate names.
  assert.equal(passEnvReservedReason("MY_LOOM_VAR"), null);
  assert.equal(validatePassEnv(["MY_LOOM_VAR"]).ok, true);
  // Nor is a bare shared word reserved: only the two prefixes and the one exact name are.
  assert.equal(passEnvReservedReason("CLAUDE_HOME"), null);
  assert.equal(passEnvReservedReason("HTTPS_PROXY"), null);
});

check("LOOM_MCP_TOKEN reports the exact-match reason, not the prefix one", () => {
  // It matches BOTH arms; the server checks exact FIRST and this mirror must keep that order, or the
  // two produce different text for the same input.
  assert.equal(passEnvReservedReason("LOOM_MCP_TOKEN"), "'LOOM_MCP_TOKEN' is a reserved Loom credential name");
  assert.equal(passEnvReservedReason("loom_mcp_token"), "'loom_mcp_token' is a reserved Loom credential name");
  assert.match(passEnvReservedReason("LOOM_OTHER"), /matches the reserved 'LOOM_\*' prefix/);
});

check("the row-level helper returns the reserved reason verbatim", () => {
  assert.equal(passEnvEntryError("LOOM_HOME"), passEnvReservedReason("LOOM_HOME"));
  assert.equal(passEnvEntryError("LOOM_MCP_TOKEN"), passEnvReservedReason("LOOM_MCP_TOKEN"));
});

// --- (C) §PINNED — the server's own message text, quoted in this file's header ------------------

check("PINNED: the mirror reproduces the server's message strings byte-for-byte", () => {
  assert.equal(
    validatePassEnv(Array.from({ length: PASS_ENV_MAX_KEYS + 1 }, (_, i) => `V${i}`)).error,
    "passEnv must be an array of at most 32 env var names",
  );
  assert.equal(validatePassEnv("nope").error, "passEnv must be an array of at most 32 env var names");
  assert.equal(validatePassEnv(["9LIVES"]).error, 'passEnv entry "9LIVES" is not a valid env var name');
  assert.equal(validatePassEnv([42]).error, "passEnv entry 42 is not a valid env var name");
  assert.equal(
    validatePassEnv(["LOOM_HOME"]).error,
    "passEnv entry rejected: 'LOOM_HOME' matches the reserved 'LOOM_*' prefix",
  );
  assert.equal(
    validatePassEnv(["LOOM_MCP_TOKEN"]).error,
    "passEnv entry rejected: 'LOOM_MCP_TOKEN' is a reserved Loom credential name",
  );
});

check("PINNED: the cap is 32 — exactly 32 passes, 33 does not", () => {
  assert.equal(PASS_ENV_MAX_KEYS, 32);
  const names = (n) => Array.from({ length: n }, (_, i) => `V${i}`);
  assert.equal(validatePassEnv(names(32)).ok, true, "exactly 32 is legal");
  assert.equal(validatePassEnv(names(33)).ok, false, "33 is over the cap");
});

// --- (D) absent / empty, and the dedupe --------------------------------------------------------

check("undefined means [] — the same as the server's absent-key handling", () => {
  assert.deepEqual(validatePassEnv(undefined), { ok: true, value: [] });
  assert.deepEqual(validatePassEnv([]), { ok: true, value: [] });
});

check("a repeated name is COLLAPSED, never rejected", () => {
  const r = validatePassEnv(["HTTPS_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]);
  assert.equal(r.ok, true, "the server accepts a duplicate rather than refusing it");
  assert.deepEqual(r.value, ["HTTPS_PROXY", "HTTP_PROXY"], "first-occurrence order, one copy each");
});

check("duplicatePassEnvIndexes flags only the LATER occurrence, and skips blanks", () => {
  assert.deepEqual([...duplicatePassEnvIndexes(["A", "B", "A", "B", "C"])], [2, 3]);
  assert.deepEqual([...duplicatePassEnvIndexes(["A", "B", "C"])], [], "no repeats ⇒ nothing flagged");
  // Blanks are unfinished rows, not a value — two of them are not "duplicates of each other", and
  // flagging them would put a redundancy note under every freshly added row.
  assert.deepEqual([...duplicatePassEnvIndexes(["", "", "A"])], []);
  // Row-ALIGNED indexes: the editor reads this set against its own row index, so a blank in the middle
  // must not shift the answer. ("A" at row 3 repeats "A" at row 0 ⇒ 3, never 1.)
  assert.deepEqual([...duplicatePassEnvIndexes(["A", "", "", "A"])], [3]);
  // Case-SENSITIVE, matching the server's own Set-of-strings dedupe: `PROXY` and `proxy` are two
  // different env vars, and the server stores both.
  assert.deepEqual([...duplicatePassEnvIndexes(["PROXY", "proxy"])], []);
  assert.deepEqual(validatePassEnv(["PROXY", "proxy"]).value, ["PROXY", "proxy"]);
});

console.log(`\n${pass} check(s) passed`);

// --- NEGATIVE CONTROLS (recorded; re-run by hand against src/lib/passEnv.ts) --------------------
// Each mutant KEEPS the exported function and disables only its logic, so a RED here is behavioural,
// never the "not a function" structural red that proves nothing (lesson 298).
//
// ⚠️ `assert` THROWS, so this script halts at its FIRST failing leg. Each line below therefore records
// the first leg observed to fail and the exit code — NOT a count of how many legs that mutant would
// break, which a single run structurally cannot show. Verified by running all four, 2026-11-04:
//
//   M1  `passEnvReservedReason` body ⇒ `return null` (signature kept)
//       RED, exit 1, at "the LOOM_ and CLAUDE_CODE_ prefixes are reserved, case-insensitively"
//       (assertion: `LOOM_HOME must be reserved`).
//   M2  drop `|| !ENV_KEY_NAME_RE.test(entry)` from `validatePassEnv`'s entry check
//       RED, exit 1, at "every illegal shape is rejected" (assertion: `"9LIVES" must be rejected`).
//   M3  drop `|| v.length > PASS_ENV_MAX_KEYS` from the array check
//       RED, exit 1, at "PINNED: the mirror reproduces the server's message strings byte-for-byte"
//       (the 33-entry array stops erroring) — 6 legs pass before it.
//   M4  `return { ok: true, value: v }` instead of `[...seen]` (dedupe off, validation intact)
//       RED, exit 1, at "a repeated name is COLLAPSED, never rejected" — 9 legs pass before it.
//
// Hand-rolled rather than run through scripts/negative-control.mjs: that tool reverts a file to a
// pre-fix sha, and this module is NEW in the same commit, so there is no earlier revision of it to
// revert to. Each mutant was applied in place, run, and restored.
