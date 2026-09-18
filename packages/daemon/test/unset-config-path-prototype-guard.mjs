import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e07daa96 — CODE-REVIEWER FINDING, reviewing b5faa194's commit 3425b1a3 (session 4275d929,
// 2026-09-18). unsetConfigPath (mcp/platform.ts) used to descend with a RAW bracket read
// (`cur[parts[i]]`, no own-property check). A dot-path segment named "__proto__" resolves via the
// accessor to the REAL Object.prototype (not an own property of the config object), so descending onto
// it turned the leaf `delete` into a permanent, process-wide `delete Object.prototype.<name>` — measured
// live: `unsetConfigPath({sessionEnv:{A:"1"}}, "sessionEnv.__proto__.toString")` deleted
// Object.prototype.toString, after which String({}) throws for the remaining life of the daemon process,
// for every project it serves.
//
// PRE-EXISTING (not introduced by b5faa194's commit 3425b1a3) and NOT closed by that commit's own
// collision guard (findConfigPatchUnsetCollisions) — that guard bails whenever the PATCH doesn't mention
// the colliding path's first segment, which is exactly the shape of this unset-only attack (no `config`
// write at all, so there is nothing for the collision guard to compare against).
//
// Fix: Object.hasOwn(node, part) BEFORE the read at unsetConfigPath's descent — matching the function's
// own real contract (its leaf `delete` only ever removes an OWN property; a prototype-chain READ during
// descent was incoherent with that to begin with).
//
// Proves:
//   (1) POSITIVE CONTROL — an unset of a genuinely OWN nested path still deletes correctly (so "nothing
//       was deleted" below passes for the RIGHT reason, not because the whole function silently no-ops).
//   (2) DESTRUCTIVE CONTROL — an unset path that hops through `sessionEnv.__proto__.toString` is a
//       harmless no-op: the config value is untouched, Object.prototype.toString survives (identity
//       check against the reference captured before this file does anything), and String({}) still
//       works.
//   (3) The same hop from the TOP LEVEL (`__proto__.toString`, no intermediate object segment) is also a
//       no-op — proves the guard isn't accidentally scoped to only the nested case.
//
// Global state is captured before anything runs and restored in a `finally`, regardless of outcome — a
// red here must never leave Object.prototype mutated for whatever runs next in this process.
//
// Run: 1) build (turbo builds shared first), 2) node test/unset-config-path-prototype-guard.mjs
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = mkdtempManaged("loom-unsetproto-");
requireHermeticEnv(); // no {port:true} — this file never talks to a live daemon over HTTP

const { unsetConfigPath } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Captured BEFORE any assertion runs, so a real regression (the guard missing/broken) can still be
// detected AND repaired — restoring this is what keeps a red here from poisoning anything downstream.
const originalToString = Object.prototype.toString;

try {
  // ===== (1) POSITIVE CONTROL: a genuinely OWN nested path is still deleted correctly =====
  const posResult = unsetConfigPath({ sessionEnv: { A: "1", B: "2" } }, "sessionEnv.A");
  check("(1) positive control: an own nested path IS deleted", posResult.sessionEnv?.A === undefined);
  check("(1) positive control: a sibling own key survives", posResult.sessionEnv?.B === "2");

  // ===== (2) DESTRUCTIVE CONTROL: a __proto__ hop through a real intermediate object must be a no-op,
  // never a delete off the real Object.prototype =====
  const destResult = unsetConfigPath({ sessionEnv: { A: "1" } }, "sessionEnv.__proto__.toString");
  check("(2) destructive control: the config value is untouched (no-op, not a mutation)", destResult.sessionEnv?.A === "1");
  check("(2) ★★ destructive control: Object.prototype.toString SURVIVES (identity check against the pre-captured reference)",
    Object.prototype.toString === originalToString);
  check("(2) ★★ destructive control: String({}) does not throw — Object.prototype.toString is still callable",
    (() => { try { return String({}) === "[object Object]"; } catch { return false; } })());

  // ===== (3) the SAME hop from the TOP LEVEL (no intermediate object segment at all) =====
  const destResult2 = unsetConfigPath({}, "__proto__.toString");
  check("(3) top-level __proto__ hop: result is an empty object (no-op)", Object.keys(destResult2).length === 0);
  check("(3) ★★ top-level __proto__ hop: Object.prototype.toString STILL survives", Object.prototype.toString === originalToString);
  // Same defensive try/catch as (2)'s equivalent check: a genuine regression makes this coercion THROW,
  // and a bare `check(label, String({}) === …)` would let that throw escape uncaught — still safe for
  // the finally-restore below (finally runs before an uncaught exception propagates), but a needlessly
  // messy failure mode for what is otherwise just one more red assertion.
  check("(3) ★★ top-level __proto__ hop: String({}) still works",
    (() => { try { return String({}) === "[object Object]"; } catch { return false; } })());
} finally {
  // Restore regardless of pass/fail — see the file header. A defensive belt-and-braces: if the guard
  // above is ever broken again, this test must not itself become the thing that poisons every later
  // assertion/log call in this process (console.log, error formatting, etc. all coerce via toString).
  if (Object.prototype.toString !== originalToString) {
    Object.defineProperty(Object.prototype, "toString", { value: originalToString, writable: true, configurable: true, enumerable: false });
    console.log("[restore] Object.prototype.toString was mutated by this test run — restored to the original reference");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unsetConfigPath's descent uses own-property semantics (Object.hasOwn), so a dot-path segment named __proto__/constructor/etc. can never resolve through the prototype chain: a genuinely own nested path still deletes correctly, and a __proto__ hop (nested or top-level) is a harmless no-op that leaves Object.prototype — and String({}) coercion — intact."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
