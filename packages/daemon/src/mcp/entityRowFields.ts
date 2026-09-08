import type { Agent, Profile, Project } from "@loom/shared";

/**
 * Shared MCP-layer row projections for the platform + setup routers' Project/Agent/Profile
 * single-record reads/writes and cross-project lists (card 4f2b2da7, same class as f8d53712's
 * `projectSessionRowFields` for Session). A handler that returns `db.getProject()` / `db.getAgent()` /
 * `db.getProfile()` (spread or bare) ships every column on those tables to the calling agent
 * automatically — an OPT-OUT shape where the next column added there reaches the wire with no code
 * change and no review step.
 *
 * COMPILE-TIME TOTALITY, both REQUIRED and OPTIONAL fields: each type's field list below is written
 * once, as a `Record<keyof T, 1>` sentinel (`PROJECT_FIELDS` etc.) — `keyof T` includes OPTIONAL
 * keys too, unlike a hand-typed `const x: T = {...}` object literal, which TypeScript only forces to
 * name REQUIRED fields (an added `newThing?: X` on `T` compiles fine against a literal that never
 * mentions it, so that shape alone would silently DROP a future optional field from the projection —
 * caught the hard way on `Profile`, which is 7-of-15 fields optional: see git history for the version
 * of this file that had that gap, and the guard's own history for how it was proven). A field added to
 * `Project`/`Agent`/`Profile` in `@loom/shared` — required OR optional — now breaks the build at the
 * matching sentinel below until it's a deliberate, reviewed addition. ONE list per type, not two: the
 * sentinel's own keys ARE the field list the runtime projection iterates, so there is nothing to keep
 * in sync by hand.
 *
 * ⚠️ THE SENTINEL VALUE IS THE NUMBER `1`, NOT THE BOOLEAN LITERAL — DELIBERATELY, and this comment
 * deliberately never spells out the colon-then-boolean sequence it's warning about, since
 * `test/agent-runs-keys.mjs` (G3) textually scans every compiled `dist/mcp/*.js` file's raw source
 * (comments included — it has no idea what a comment is) for that exact sequence on the `endpoint`
 * field (an Agent Runs trust-boundary guard: no MCP path may flip an agent's `endpoint` field or mint an
 * API key, only the loopback REST surface may). This sentinel's `endpoint` entry used to hold that
 * boolean literal, and TypeScript compiles a `Record` object literal's key/value pairs straight into the
 * `.js` output as literal text — so the sentinel's own meaning ("this field is projected") collided,
 * purely textually, with the guard's real question ("does any MCP path SET that field to that value").
 * The guard is right to be this blunt (a false positive here is far cheaper than a false negative on a
 * real trust-boundary leak) — so the fix is on this side: a numeric marker carries the exact same
 * compile-time exhaustiveness guarantee (still `Record<keyof T, ...>`, still forces every key) without
 * colliding with G3's pattern. If you're tempted to "tidy" the value back to a boolean to match the other
 * sentinels' apparent style, don't — that silently re-breaks the gate on the next merge, and won't even
 * show up locally unless you happen to run G3.
 *
 * BEHAVIOUR-PRESERVING, not a trim: every field on each type is projected, including ones no tool
 * description currently names by name (e.g. Profile's `connections`/`capabilities`/`vaultWrite` — the
 * `profile_get`/`list_all_profiles` descriptions enumerate only a subset of Profile's fields, but the
 * raw row they return today already carries all of them when set, and DoD says preserve that shape).
 *
 * UNDEFINED-SAFE: `db.getProject`/`getAgent`/`getProfile` all return `T | undefined`, and several call
 * sites today spread that possibly-undefined value directly (`{...db.getProject(id)!, extra}`,
 * `{...maybeUndefined, promptWarning}`) — spreading `undefined` is a legal no-op in JS, so the existing
 * degenerate-row behaviour is a real, if unlikely, path to preserve exactly. Each helper here accepts
 * `T | undefined` and passes `undefined` straight through rather than throwing, so swapping a raw
 * `db.getX(id)` call for `xFields(db.getX(id))` changes nothing about what a caller sees on that path.
 * A `getByIdPrefix(...)` result is NOT `T | undefined` (it's `T | { error: string }`) — narrow that
 * with `"error" in result` BEFORE calling the matching helper; passing the whole union through here
 * would silently read undefined fields off the error object instead of surfacing the error.
 */

/**
 * Project a row down to exactly the fields named in `keys` — the shared machinery every xFields helper
 * below calls. Exported (card b6e3493f) so agentView.ts/sessionView.ts's `full:true` projections reuse
 * it too, instead of adding two more standalone copies of the same five lines — this file's own §WHY
 * is precisely about that class of divergence.
 */
export function pickFields<T>(row: T, keys: readonly (keyof T)[]): T {
  const out = {} as T;
  for (const k of keys) out[k] = row[k];
  return out;
}

const PROJECT_FIELDS: Record<keyof Project, 1> = {
  id: 1, name: 1, repoPath: 1, vaultPath: 1, referenceRepos: 1, repos: 1,
  config: 1, createdAt: 1, archivedAt: 1, reserved: 1, noGateByDesign: 1, denyGlobs: 1,
};
const PROJECT_KEYS = Object.keys(PROJECT_FIELDS) as (keyof Project)[];

export function projectFields(row: Project | undefined): Project | undefined {
  return row === undefined ? row : pickFields(row, PROJECT_KEYS);
}

const AGENT_FIELDS: Record<keyof Agent, 1> = {
  id: 1, projectId: 1, name: 1, startupPrompt: 1, position: 1, profileId: 1,
  endpoint: 1, ioSchema: 1,
};
const AGENT_KEYS = Object.keys(AGENT_FIELDS) as (keyof Agent)[];

export function agentFields(row: Agent | undefined): Agent | undefined {
  return row === undefined ? row : pickFields(row, AGENT_KEYS);
}

const PROFILE_FIELDS: Record<keyof Profile, 1> = {
  id: 1, name: 1, role: 1, description: 1, allowDelta: 1, skills: 1, model: 1,
  icon: 1, browserTesting: 1, documentConversion: 1, restrictedTools: 1, noCommit: 1,
  connections: 1, capabilities: 1, vaultWrite: 1, harness: 1,
};
const PROFILE_KEYS = Object.keys(PROFILE_FIELDS) as (keyof Profile)[];

/** The wire-only shape `profileFields` actually returns: identical to `Profile` except `harness` is
 *  widened to include `null`, so an UNSET profile can be told apart from one explicitly holding the
 *  shipped default. This type exists ONLY for this projection's return value (never assigned back into
 *  a real `Profile`, which stays `?: "claude" | "codex"` with no `null` member — see the comment below). */
type ProfileWireView = Omit<Profile, "harness"> & { harness: "claude" | "codex" | null };

export function profileFields(row: Profile | undefined): ProfileWireView | undefined {
  if (row === undefined) return row;
  const picked = pickFields(row, PROFILE_KEYS);
  // Card 3edf6ef7: an unset `harness` (a NULL column becomes `undefined` per db.ts's `toProfile`) and a
  // field this projection simply doesn't carry are INDISTINGUISHABLE once this router's `ok()` envelope's
  // `JSON.stringify` drops the undefined-valued key — `profile_get`/`list_all_profiles` could not answer
  // "has this profile's harness been set" without querying the `profiles` table directly.
  //
  // The fix has to answer a SEMANTIC question, not just a structural one: what should an unset harness
  // serialize as? Resolving it to the shipped default literal ("claude") only trades one ambiguity for
  // another — a reader could no longer tell "never touched" from "explicitly set to claude", which is
  // exactly the property this card exists to make readable (a human write path now exists with no
  // trustworthy read-back). `null` is the right value: it mirrors what the DB column itself already
  // means (NULL = unset; insertProfile's own comment: "NULL = 'claude' (absent ⇒ today's only harness)"),
  // so `null` = unset, `"claude"`/`"codex"` = explicitly set — three distinguishable, always-present wire
  // states from two DB states plus the resolved default.
  //
  // Widening a LOCAL, wire-only return type (ProfileWireView, above) — never `Profile` itself — deliberately
  // sidesteps the type constraint this card also flags (`Profile.harness` is `?: "claude" | "codex"` with
  // NO `null` member): nothing downstream treats `profileFields()`'s result as a real `Profile` (every
  // call site pipes it straight into `ok(...)` for the wire), so this widening has zero blast radius
  // outside this one function's return value.
  //
  // Deliberately NOT fixed by changing db.ts's `toProfile()` (or the analogous `toSession()`) to stop
  // returning `undefined` for an unset harness: that shared object is reused UNWRAPPED as the merge base
  // in `profile_update`/`PUT /api/profiles/:id` (`{...existing, ...patch}` → `validateProfile` →
  // `updateProfile`), whose partial-edit semantics treat an `undefined` `harness` as "leave the column
  // as-is" (validate.ts's own doc comment on this field). Resolving it to ANY concrete value at that
  // shared layer — `null` included — would silently persist it into a previously-NULL column on ANY
  // unrelated profile edit — a write-path side effect this READ-only card must not introduce.
  // `Session.harness` (db.ts's other mapper, `toSession`) does NOT have this hazard, despite sharing the
  // identical `?: "claude" | "codex"` type shape: no `UPDATE sessions SET` statement in db.ts touches the
  // `harness` column at all, and the fork/recycle "carry the pinned vendor CLI forward" call sites
  // (sessions/service.ts) each build a brand-new `Session` literal (never a partial update) via
  // `old.harness ?? undefined`, which `insertSession`'s own binding (`s.harness ?? null`) collapses to the
  // same NULL regardless of whether the source was `undefined` or an explicit `null` — so there is no
  // "leave-as-is" semantic on the Session side to disturb. The real blocker on `toSession()` is a TYPE
  // one instead: `Session.harness` has no `null` member, so returning an explicit `null` there wouldn't
  // compile without widening that shared type — out of scope here.
  return { ...picked, harness: picked.harness ?? null };
}
