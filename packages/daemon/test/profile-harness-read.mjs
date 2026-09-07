import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3edf6ef7: `profile_get`/`list_all_profiles` could not tell "this profile's harness is unset" apart
// from "this tool doesn't project harness" — a NULL `harness` column maps to `undefined` (db.ts's
// `toProfile`), and JSON.stringify drops an undefined-valued key entirely, so the wire response for an
// unset profile carries no `harness` key at all, same as a hypothetical tool that never named the field.
// HERMETIC like profiles-crud.mjs: isolated LOOM_HOME, a REAL Db, no daemon, no real claude.
//
// Covers:
//   (1) REPRO — simulating the actual MCP wire shape (JSON.parse(JSON.stringify(...)), matching this
//       router's `ok()` envelope) on the RAW `db.getProfile()` output: a SET harness survives the
//       round-trip, an UNSET one vanishes — the ambiguity, reproduced before any fix is invoked.
//   (2) FIX — `profileFields()` (what `profile_get`/`list_all_profiles`/`profile_update`'s response
//       actually return) resolves an unset harness to explicit `null`, so the key is ALWAYS present on
//       the wire, AND an unset profile stays distinguishable from one explicitly set to "claude" (the
//       property this card actually needs: can a reader answer "is this set?" — not just "is the key
//       present?"). `null` mirrors what the DB column itself already means (see db.ts's insertProfile
//       comment: "NULL = 'claude' (absent ⇒ today's only harness)").
//   (3) SCOPE — `db.ts`'s shared `toProfile()` mapper (what `profile_update`'s merge-base `existing`
//       comes from) is left UNTOUCHED: an unset harness still reads back as `undefined` off `db.getProfile()`
//       directly, preserving the partial-edit "absent = leave this column as-is" semantics `updateProfile`
//       depends on. This is a NEGATIVE control on the read fix itself: profileFields's own resolution must
//       not have leaked into the shared object it wraps.
//   (4) TRUST BOUNDARY — `agentProfileKeyError` (the agent MCP write-path guard) still rejects a raw
//       patch naming `harness`, and does not fire on an unrelated key. Untouched by this change; asserted
//       directly so the read fix is not simultaneously mistaken for a write-path change.
// Run: 1) build (turbo builds shared first), 2) node test/profile-harness-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pharness-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { profileFields } = await import("../dist/mcp/entityRowFields.js");
const { agentProfileKeyError } = await import("../dist/profiles/validate.js");

const db = new Db();
db.insertProfile({ id: "pUnset", name: "Unset", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertProfile({ id: "pSet", name: "Set", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });

const rawUnset = db.getProfile("pUnset");
const rawSet = db.getProfile("pSet");

// ===================== (1) REPRO — the ambiguity, on the raw mapper's actual wire shape =====================
const wireRawSet = JSON.parse(JSON.stringify(rawSet));
const wireRawUnset = JSON.parse(JSON.stringify(rawUnset));
check("(1 repro) positive control: a SET harness survives the raw wire round-trip", wireRawSet.harness === "codex");
check("(1 repro) THE DEFECT: an UNSET harness's key is entirely ABSENT from the raw wire round-trip " +
  "(indistinguishable from a tool that never projects harness at all)", !("harness" in wireRawUnset));

// ===================== (2) FIX — profileFields() always projects harness, SET and UNSET distinguishable =====================
const wireFixedSet = JSON.parse(JSON.stringify(profileFields(rawSet)));
const wireFixedUnset = JSON.parse(JSON.stringify(profileFields(rawUnset)));
check("(2 fix) profileFields(): a SET harness still reads through unchanged", wireFixedSet.harness === "codex");
check("(2 fix) profileFields(): an UNSET harness now reads back explicitly as `null`, no longer ambiguous",
  wireFixedUnset.harness === null);
check("(2 fix) profileFields(): the harness key is present on the wire in BOTH cases now",
  "harness" in wireFixedSet && "harness" in wireFixedUnset);
check("(2 fix) profileFields(): UNSET (null) and explicitly-SET-to-a-value remain DISTINGUISHABLE — the " +
  "property the card actually needs, not just key-presence", wireFixedUnset.harness !== wireFixedSet.harness);
check("(2 fix) profileFields(undefined) still passes undefined straight through (unchanged degenerate path)",
  profileFields(undefined) === undefined);

// ===================== (3) SCOPE — db.ts's shared toProfile() mapper is UNTOUCHED =====================
// This is the negative control on the fix itself: if profileFields's resolution had leaked into the
// shared db.getProfile() object (e.g. by mutating `row` instead of the picked copy), this would go red.
check("(3 scope) db.getProfile() raw output for the UNSET profile is untouched: harness is still " +
  "`undefined` (never coerced) — preserves profile_update's \"absent = leave column as-is\" semantics",
  rawUnset.harness === undefined);
check("(3 scope) db.getProfile() raw output for the SET profile is untouched", rawSet.harness === "codex");

// ===================== (4) TRUST BOUNDARY — unchanged; this card is READ-only =====================
check("(4 trust boundary) agentProfileKeyError still rejects a raw patch naming harness",
  typeof agentProfileKeyError({ harness: "codex" }) === "string");
check("(4 trust boundary) agentProfileKeyError does not fire on an unrelated key",
  agentProfileKeyError({ description: "x" }) === null);

console.log(failures === 0 ? "\nAll profile-harness-read checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
