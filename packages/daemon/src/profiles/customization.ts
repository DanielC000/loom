import type { Profile, ProfileFieldMerge, ProfileMergeResult } from "@loom/shared";
import type { Db } from "../db.js";
import { bundledProfileByName } from "./seed.js";

/**
 * Bundled-profile customization — the profiles analog of skills/store.ts's customization engine, but
 * FIELD-level (profiles are structured DB rows, not text), so node-diff3 does NOT transfer. The three
 * versions per bundled-by-name profile:
 *   mine    = the user's `profiles` row (what sessions resolve) — db.getProfile(id)
 *   base    = the shipped def at the user's last sync (the `base_snapshot` JSON column) ?? shipped
 *   shipped = Loom's current bundled def — bundledProfileByName(name)
 * `name` is the identity match key and is EXCLUDED from the field set (renaming un-bundles a profile,
 * the documented limitation). See `[[Profile Customization]]` in the vault for the full contract.
 */

/** The mergeable/compared fields — every writable Profile field EXCEPT `name` (the identity key). */
export const MERGEABLE_PROFILE_FIELDS = [
  "role",
  "description",
  "allowDelta",
  "skills",
  "model",
  "icon",
  "browserTesting",
  "documentConversion",
  "openDesign",
  "restrictedTools",
  "noCommit",
  "connections",
  "capabilities",
] as const;
type MergeableField = (typeof MERGEABLE_PROFILE_FIELDS)[number];

// `allowDelta` / `skills` / `connections` are string[]-valued; everything else (but `capabilities`) is a
// scalar/boolean. `capabilities` is object[]-valued and needs its own canonicalization (see fieldEqual).
const ARRAY_FIELDS = new Set<string>(["allowDelta", "skills", "connections"]);
const OBJECT_ARRAY_FIELDS = new Set<string>(["capabilities"]);

/**
 * Per-field equality (per the design):
 *  - scalars/booleans: strict `===`.
 *  - string[] arrays: ATOMIC — compared as normalized (sorted-copy) JSON; the whole array is one field
 *    value, with NO element-level merge. `null` (skills = "all") is a DISTINCT value from `[]`.
 *  - object[] arrays (capabilities): each grant is canonicalized to a key-sorted JSON string first (so
 *    `{slug,connectionId}` and `{connectionId,slug}` compare equal regardless of key order), THEN the
 *    canonical strings are sorted and compared as one array — same ATOMIC, no-element-merge contract.
 */
function fieldEqual(field: string, a: unknown, b: unknown): boolean {
  if (OBJECT_ARRAY_FIELDS.has(field)) {
    if (a == null || b == null) return a === b;
    const canon = (arr: unknown[]) => arr.map((o) => JSON.stringify(o, Object.keys(o as object).sort())).sort();
    return JSON.stringify(canon(a as unknown[])) === JSON.stringify(canon(b as unknown[]));
  }
  if (ARRAY_FIELDS.has(field)) {
    if (a == null || b == null) return a === b; // null (all) is distinct from [] and from a populated array
    const na = [...(a as string[])].sort();
    const nb = [...(b as string[])].sort();
    return JSON.stringify(na) === JSON.stringify(nb);
  }
  return a === b;
}

/**
 * Normalize a (possibly partial / JSON-parsed) profile to canonical mergeable-field values so all three
 * versions compare like-for-like — undefined booleans → false, undefined description → "", undefined
 * skills → null ("all"). Matches validateProfile / the db round-trip, so `mine` (a db row) is already
 * canonical and `shipped` (a BUNDLED_PROFILES entry, which may omit optional fields) and `base` (parsed
 * JSON) are brought to the same shape.
 */
function normalizeFields(p: Partial<Profile>): Record<MergeableField, unknown> {
  return {
    role: p.role ?? null,
    description: p.description ?? "",
    allowDelta: p.allowDelta ?? [],
    skills: p.skills === undefined ? null : p.skills,
    model: p.model ?? null,
    icon: p.icon ?? null,
    browserTesting: p.browserTesting ?? false,
    documentConversion: p.documentConversion ?? false,
    openDesign: p.openDesign ?? false,
    restrictedTools: p.restrictedTools ?? false,
    noCommit: p.noCommit ?? false,
    // Unlike skills, absent always means [] (no access) — never "all". A shipped bundled profile never
    // carries connection ids (those are the user's own credential grants), so shipped always normalizes
    // to [] here, which is what lets the merge rule protect a user's grant across an "adopt".
    connections: p.connections ?? [],
    // Same off-by-default direction as connections; no bundled profile seeds capabilities, so shipped
    // always normalizes to [] — the merge rule protects a user's own grants across an "adopt".
    capabilities: p.capabilities ?? [],
  };
}

/**
 * Field-level 3-way merge — apply Loom's shipped delta onto the user's edits using `base` as the common
 * ancestor. For each mergeable field:
 *  - mine == base   → take shipped  (user didn't touch it → accept the update)
 *  - shipped == base → keep mine    (Loom didn't change it → keep the user's value)
 *  - mine == shipped → that value   (convergent; no conflict even if base differs)
 *  - else            → CONFLICT     (all three differ; merged keeps mine pending the user's pick)
 * `clean` ⇔ no conflicts; `merged` carries every field's auto-resolved value (conflict fields left at mine).
 */
export function mergeProfile(
  base: Partial<Profile>,
  mine: Partial<Profile>,
  shipped: Partial<Profile>,
): ProfileMergeResult {
  const nb = normalizeFields(base);
  const nm = normalizeFields(mine);
  const ns = normalizeFields(shipped);
  const merged: Record<string, unknown> = {};
  const conflicts: ProfileFieldMerge[] = [];
  for (const f of MERGEABLE_PROFILE_FIELDS) {
    const bv = nb[f];
    const mv = nm[f];
    const sv = ns[f];
    if (fieldEqual(f, mv, bv)) merged[f] = sv; // user didn't touch → take shipped
    else if (fieldEqual(f, sv, bv)) merged[f] = mv; // Loom didn't change → keep mine
    else if (fieldEqual(f, mv, sv)) merged[f] = mv; // convergent
    else {
      merged[f] = mv; // conflict: keep mine pending the user's wholesale mine-vs-shipped pick
      conflicts.push({ field: f, mine: mv, base: bv, shipped: sv });
    }
  }
  return { clean: conflicts.length === 0, merged: merged as Partial<Profile>, conflicts };
}

/** The three normalized versions for a bundled-by-name profile; null if the id is unknown or not bundled. */
function threeVersions(
  db: Db,
  id: string,
): { base: Partial<Profile>; mine: Profile; shipped: Omit<Profile, "id"> } | null {
  const mine = db.getProfile(id);
  if (!mine) return null;
  const shipped = bundledProfileByName(mine.name);
  if (!shipped) return null; // user-created / renamed away — not a bundled-by-name profile
  const snap = db.getProfileBaseSnapshot(id);
  const base: Partial<Profile> = snap ? (JSON.parse(snap) as Partial<Profile>) : shipped; // missing → shipped
  return { base, mine, shipped };
}

/**
 * The computed customization state surfaced on list/get for a profile — `bundled` for every profile,
 * `customized`/`updateAvailable` ONLY for bundled-by-name ones (NEVER persisted). A user-created profile
 * returns `{ bundled: false }` (no flags), exactly like a non-bundled skill.
 */
export function profileCustomizationState(
  db: Db,
  id: string,
): { bundled: boolean; customized?: boolean; updateAvailable?: boolean } {
  const v = threeVersions(db, id);
  if (!v) return { bundled: false };
  const nb = normalizeFields(v.base);
  const nm = normalizeFields(v.mine);
  const ns = normalizeFields(v.shipped);
  const customized = MERGEABLE_PROFILE_FIELDS.some((f) => !fieldEqual(f, nm[f], nb[f]));
  const updateAvailable = MERGEABLE_PROFILE_FIELDS.some((f) => !fieldEqual(f, nb[f], ns[f]));
  return { bundled: true, customized, updateAvailable };
}

/** True iff a shipped update is available (base != shipped) for a bundled-by-name profile — the adopt/preview guard. */
export function profileUpdateAvailable(db: Db, id: string): boolean {
  const v = threeVersions(db, id);
  if (!v) return false;
  const nb = normalizeFields(v.base);
  const ns = normalizeFields(v.shipped);
  return MERGEABLE_PROFILE_FIELDS.some((f) => !fieldEqual(f, nb[f], ns[f]));
}

/** Preview the field-level adopt-update merge for a bundled-by-name profile. null if not bundled-by-name. */
export function previewProfileMerge(db: Db, id: string): ProfileMergeResult | null {
  const v = threeVersions(db, id);
  if (!v) return null;
  return mergeProfile(v.base, v.mine, v.shipped);
}

/**
 * "What shipped changed" since the user's last sync: the base→shipped field changes (each entry carries
 * mine/base/shipped for the UI). null if not a bundled-by-name profile.
 */
export function profileUpdateDiff(db: Db, id: string): { changed: ProfileFieldMerge[] } | null {
  const v = threeVersions(db, id);
  if (!v) return null;
  const nb = normalizeFields(v.base);
  const nm = normalizeFields(v.mine);
  const ns = normalizeFields(v.shipped);
  const changed: ProfileFieldMerge[] = [];
  for (const f of MERGEABLE_PROFILE_FIELDS) {
    if (!fieldEqual(f, nb[f], ns[f])) changed.push({ field: f, mine: nm[f], base: nb[f], shipped: ns[f] });
  }
  return { changed };
}

/** A per-field resolution for an adopt with conflicts: pick the user's value or the shipped value, wholesale. */
export type ProfileFieldResolution = "mine" | "shipped";

/**
 * Adopt the shipped update NON-DESTRUCTIVELY: apply the field-level merge (auto-resolved fields + the
 * user's per-conflict resolutions) and ADVANCE base := shipped. NEVER auto-applied — the REST layer
 * calls this only on explicit user action, guarded to updateAvailable. Outcomes:
 *  - { ok: true } — applied; base advanced (updateAvailable now clears).
 *  - reason "not-bundled" → 404; "no-update" → 409; "unresolved" (+ the field names) → 409 (the user
 *    must supply a mine/shipped choice for each conflict field, mirroring the skills adopt-needs-content 409).
 */
export function adoptProfileUpdate(
  db: Db,
  id: string,
  resolutions: Record<string, ProfileFieldResolution>,
): { ok: true } | { ok: false; reason: "not-bundled" | "no-update"; unresolved?: undefined } | { ok: false; reason: "unresolved"; unresolved: string[] } {
  const v = threeVersions(db, id);
  if (!v) return { ok: false, reason: "not-bundled" };
  if (!profileUpdateAvailable(db, id)) return { ok: false, reason: "no-update" };
  const merge = mergeProfile(v.base, v.mine, v.shipped);
  const ns = normalizeFields(v.shipped);
  const patch: Record<string, unknown> = { ...merge.merged }; // auto-resolved fields (conflicts at mine)
  const unresolved: string[] = [];
  for (const c of merge.conflicts) {
    const choice = resolutions[c.field];
    if (choice !== "mine" && choice !== "shipped") {
      unresolved.push(c.field);
      continue;
    }
    patch[c.field] = choice === "shipped" ? ns[c.field as MergeableField] : c.mine; // wholesale field pick
  }
  if (unresolved.length) return { ok: false, reason: "unresolved", unresolved };
  db.updateProfile(id, patch as Partial<Profile>);
  db.setProfileBaseSnapshot(id, JSON.stringify(v.shipped)); // base = shipped: the update is now adopted
  return { ok: true };
}
