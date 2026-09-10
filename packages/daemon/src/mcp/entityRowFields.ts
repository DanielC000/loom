import type { Agent, Profile, Project } from "@loom/shared";

/**
 * Shared MCP-layer row projections for the platform + setup routers' Project/Agent/Profile
 * single-record reads/writes and cross-project lists — never spread a raw `db.getProject()` /
 * `db.getAgent()` / `db.getProfile()` row into a tool response; use the `xFields()` helpers below,
 * which name every field explicitly.
 * @decision 4f2b2da7 — a raw spread is an OPT-OUT shape: the next column added to that table reaches
 * the wire with no code change and no review step.
 *
 * Each type's field list below is written ONCE, as a `Record<keyof T, 1>` sentinel (`PROJECT_FIELDS`
 * etc.), not a hand-typed object literal — `keyof T` forces BOTH required and optional keys, so a
 * field added to `Project`/`Agent`/`Profile` in `@loom/shared`, required OR optional, breaks the build
 * at the matching sentinel below until it's a deliberate, reviewed addition.
 * @decision sha:529b6f41 — do not replace with a hand-typed `const x: T = {...}` literal; TypeScript
 * only forces such a literal to name REQUIRED fields, so it would compile fine while silently
 * dropping a future OPTIONAL field from the projection.
 *
 * ⚠️ THE SENTINEL VALUE IS THE NUMBER `1`, NOT THE BOOLEAN LITERAL — DELIBERATELY: `test/agent-runs-
 * keys.mjs` (G3) textually scans every compiled `dist/mcp/*.js` file's raw source for a colon-then-
 * boolean sequence on the `endpoint` field (an Agent Runs trust-boundary guard: no MCP path may flip
 * an agent's `endpoint` field or mint an API key). Never "tidy" this value back to a boolean.
 * @decision sha:529b6f41 — a boolean sentinel here collides, purely textually, with G3's pattern and
 * silently re-breaks that guard on the next merge, with nothing failing locally unless you run G3.
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
  // @decision 3edf6ef7 — unset `harness` resolves to `null` here (LOCAL wire type only, never `Profile`
  // itself); never fix this in db.ts's toProfile()/toSession() instead — that breaks profile_update's
  // partial-edit "leave the column as-is" semantics on unrelated writes.
  return { ...picked, harness: picked.harness ?? null };
}
