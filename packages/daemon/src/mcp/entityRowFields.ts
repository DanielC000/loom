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
  connections: 1, capabilities: 1, vaultWrite: 1,
};
const PROFILE_KEYS = Object.keys(PROFILE_FIELDS) as (keyof Profile)[];

export function profileFields(row: Profile | undefined): Profile | undefined {
  return row === undefined ? row : pickFields(row, PROFILE_KEYS);
}
