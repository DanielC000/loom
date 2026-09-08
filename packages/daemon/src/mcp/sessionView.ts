import type { SessionListItem } from "@loom/shared";
import { pickFields } from "./entityRowFields.js";

// Shared MCP-layer projection for the cross-project session list tools (audit list_sessions +
// platform list_all_sessions). This is a PRESENTATION projection only — it never touches the db
// query semantics; the same enriched SessionListItem[] is fetched, then thinned here.

// SESSION-ID NAMING POLICY (card 7fcb586a): the settled rule for every MCP surface that returns a
// session id to an agent lives on `Session` in `@loom/shared` (packages/shared/src/types.ts) — hosted
// there, not here, because it governs surfaces across both packages (my_context, events_search,
// auditRequestItem, input params), not just this file's list-projection surface. Read it there rather
// than re-deriving it. SessionSummary/SessionListItem's own `id` field below is a case of that policy's
// rule 3 (a record's own primary key stays bare `id`) — see `Session.id`'s own doc for the full reasoning.

/**
 * The lightweight session row the list tools return by DEFAULT — a compact projection that keeps
 * just what's needed to triage + address a session (its id, project, agent, lifecycle state, and
 * context meters) and DROPS the heavy/verbose fields (title, cwd, engineSessionId, branch, worktree
 * path, lineage ids, errors, rate-limit bookkeeping). Mirrors tasks_list's TaskSummary: a full list
 * of dozens of enriched session rows was a 300K+ blob, so a default list read here stays bounded.
 * Callers that need a whole record opt in with full:true (or read one transcript via transcript_read).
 */
export type SessionSummary = Pick<
  SessionListItem,
  | "id" | "projectId" | "projectName" | "agentId" | "agentName" | "role" | "processState"
  | "busy" | "archivedAt" | "createdAt" | "lastActivity" | "model"
  | "ctxInputTokens" | "ctxTurns"
>;

/** Project ONE enriched session row down to its summary. Optional fields normalise to null. */
export const toSessionSummary = (s: SessionListItem): SessionSummary => ({
  id: s.id,
  projectId: s.projectId,
  projectName: s.projectName,
  agentId: s.agentId,
  agentName: s.agentName,
  role: s.role ?? null,
  processState: s.processState,
  busy: s.busy,
  archivedAt: s.archivedAt ?? null,
  createdAt: s.createdAt,
  lastActivity: s.lastActivity,
  model: s.model ?? null,
  ctxInputTokens: s.ctxInputTokens ?? null,
  ctxTurns: s.ctxTurns ?? null,
});

/**
 * The session-list STATE filter (process lifecycle), mirroring tasks_list's excludeDone precedent:
 * the lightweight cross-project feed DEFAULTS to live (non-exited) sessions so it stays bounded as
 * finished sessions pile up; "exited"/"all" opt into history. This is the process axis (has the engine
 * exited) and is ORTHOGONAL to the audit tool's `scope` axis (archived-vs-not) — a session can be
 * exited-but-not-archived (which is exactly what was streaming back forever). "live" keeps every
 * non-terminal ProcessState (none|starting|live); only "exited" is dropped.
 */
export type SessionStateFilter = "live" | "exited" | "all";

/** Filter an enriched session list by process-lifecycle state (see {@link SessionStateFilter}). Pure. */
export function filterSessionsByState(
  rows: SessionListItem[], state: SessionStateFilter,
): SessionListItem[] {
  if (state === "all") return rows;
  const wantExited = state === "exited";
  return rows.filter((s) => (s.processState === "exited") === wantExited);
}

/**
 * Backstop cap on a DEFAULT (summary) cross-project session list so a `state:"all"`/`"exited"` (or audit
 * `scope:"all"`, which keeps every archived row) read can't overflow the tool-result token cap with no
 * explicit limit. Callers opt past it with an explicit limit/offset; full:true is an explicit heavy
 * opt-in and is NOT capped here. SIZED BY MEASUREMENT, not a round number: the old 200 LIED — 200 summary
 * rows ran ~71K chars at audit scope:all and still overflowed the cap (PL Auditor finding #5), forcing a
 * manual re-issue at limit:40. A worst-case summary row is ~480 chars, so 50 rows ≈ 24K chars —
 * comfortably under the ~48K-char "safely under the tool-result cap" figure the transcript pager uses
 * (TRANSCRIPT_PAGE_CHAR_BUDGET), with ~2× headroom.
 */
export const DEFAULT_SESSION_SUMMARY_CAP = 50;

/**
 * COMPILE-TIME TOTALITY for the full:true path (card b6e3493f). `projectSessionList` below used to
 * return `full:true` rows unprojected — an OPT-OUT shape that ships every column on a `Session` row
 * straight to the wire, with no build error and no test failure when a new one is added. Every caller
 * of this function (list_all_sessions on both platform.ts + setup.ts, and the auditor's list_sessions
 * in transcript-read.ts) genuinely feeds it `SessionListItem[]` (enriched with `projectName`/
 * `agentName`, not bare `Session`), so the sentinel is against `SessionListItem` — a bare `keyof
 * Session` sentinel would have silently dropped those two fields on every real caller today, not just
 * a hypothetical future one (contrast agentView.ts's AGENT_LIST_FIELDS, where the enrichment is only a
 * future-proofing concern). `pendingMerge` (optional on `Session`, `PendingMerge | null`) is included
 * here rather than excluded like orchestration.ts's SESSION_ROW_FIELDS does for `worker_status` —
 * nothing on this path computes or overrides `pendingMerge`, and a DB-sourced row never sets it, so
 * keeping the sentinel genuinely total over `keyof SessionListItem` costs nothing (the resulting
 * `undefined` is dropped entirely by this router's `ok()` envelope's `JSON.stringify`).
 */
const SESSION_LIST_FIELDS: Record<keyof SessionListItem, 1> = {
  id: 1, projectId: 1, agentId: 1, engineSessionId: 1, title: 1, cwd: 1, processState: 1,
  resumability: 1, busy: 1, createdAt: 1, lastActivity: 1, lastError: 1, role: 1,
  parentSessionId: 1, taskId: 1, worktreePath: 1, branch: 1, reviewBaseSha: 1, repoKey: 1,
  gen: 1, recycledFrom: 1, ctxInputTokens: 1, ctxTurns: 1, turnSeq: 1, ctxUpdatedAt: 1,
  model: 1, rateLimitedUntil: 1, rateLimitDeadline: 1, browserTesting: 1, documentConversion: 1,
  restrictedTools: 1, noCommit: 1, skills: 1, connections: 1, vaultWrite: 1, companionLeadMode: 1,
  capabilities: 1, archivedAt: 1, pendingMerge: 1, scheduledSpawn: 1, harness: 1,
  projectName: 1, agentName: 1,
};
const SESSION_LIST_KEYS = Object.keys(SESSION_LIST_FIELDS) as (keyof SessionListItem)[];

/** The wire-only shape `toFullSessionRow` actually returns: identical to `SessionListItem` except
 *  `harness` is widened to include `null`, so an UNSET session can be told apart from one explicitly
 *  holding the shipped default. This type exists ONLY for this projection's return value (never assigned
 *  back into a real `SessionListItem` — see entityRowFields.ts's `ProfileWireView`/orchestration.ts's
 *  `SessionWireView` for the identical shape on the Profile/worker_status sides). */
type SessionFullWireView = Omit<SessionListItem, "harness"> & { harness: "claude" | "codex" | null };

/**
 * Project ONE session row to the full (non-summary) shape `full:true` returns. See SESSION_LIST_FIELDS.
 *
 * Card 589afd55 (the third `harness`-reads-are-ambiguous instalment, after 3edf6ef7's `profileFields` and
 * 41f35bfe's `projectSessionRowFields`): an unset `harness` (a NULL column becomes `undefined` per
 * db.ts's `toSession`) and a field this projection simply doesn't carry were INDISTINGUISHABLE once this
 * router's `ok()` envelope's `JSON.stringify` drops the undefined-valued key — `list_all_sessions`
 * (platform.ts + setup.ts) and `list_sessions` (transcript-read.ts) on the `full:true` path could not
 * answer "has this session's harness been set". `null` = unset, `"claude"`/`"codex"` = explicitly set —
 * mirroring what the DB column itself already means (db.ts's insertSession comment: "NULL = 'claude'
 * (absent ⇒ today's only harness)").
 *
 * Deliberately NOT fixed by changing db.ts's shared `toSession()`/`listAllSessions()` mappers to stop
 * returning `undefined` for an unset harness — but NOT for the reason the Profile-side precedent might
 * suggest by analogy. `Session.harness` is typed `?: "claude" | "codex"` with NO `null` member, so
 * `toSession()` returning an explicit `null` would not even COMPILE without widening that shared type,
 * which is out of scope here. This differs from the Profile side: `Profile.harness` has the identical
 * type shape, but `updateProfile`'s column binding (db.ts:4806, `patch.harness === undefined ? undefined
 * : patch.harness ?? null`) genuinely DOES read an unresolved `undefined` as "leave the column as-is" on
 * a real partial-PATCH path (`profile_update`/`PUT /api/profiles/:id`) — that hazard is real for
 * Profiles. It does NOT transfer to Sessions: checked directly — no `UPDATE sessions SET` statement in
 * db.ts touches the `harness` column at all (verified by grepping every such statement), and the
 * fork/recycle "carry the pinned vendor CLI forward" call sites (sessions/service.ts) each build a
 * brand-new `Session` literal (`id: randomUUID()`, a full `insertSession`, never a partial update) via
 * `old.harness ?? undefined`, which `insertSession`'s own binding (`s.harness ?? null`) then collapses to
 * the same NULL value whether the source was `undefined` or an explicit `null` — so there is no
 * "leave-as-is" semantic on the Session side to disturb. Widening a LOCAL, wire-only return type
 * (`SessionFullWireView`, above) — never `SessionListItem` itself — is still the right call regardless,
 * on its own independent merit: every caller of `projectSessionList`'s `full:true` path (`list_all_sessions`
 * on platform.ts + setup.ts, `list_sessions` on transcript-read.ts) only ever uses the result for its
 * `.length` and spreads it straight into `ok(...)`/an envelope for the wire, never treating it as a real
 * `SessionListItem` — verified at each of those three call sites — so this widening has zero blast radius
 * outside this one function's return value, with no need to touch the shared mapper either way.
 *
 * Card 589afd55's Site B (`gateway/fleet-hub.ts`'s `session:upsert` WS push) is DELIBERATELY left
 * unfixed: that push's shape is `ServerFleetMessage`'s `session:upsert` variant, a SHARED cross-package
 * protocol type (`packages/shared/src/protocol.ts`) consumed by the web UI — not a local, function-scoped
 * wire type like this one — and no web UI code reads `session.harness` today (verified: `harness` greps
 * in `packages/web/src` hit only Profile-editing UI, unrelated to the fleet feed). The same REST route
 * that seeds the same `["allSessions"]` cache (`GET /api/sessions`, server.ts) has the identical
 * unresolved-`harness` gap and isn't touched by this card either — widening only the WS delta would make
 * it disagree with that REST seed for this one field, a worse state than today's uniform ambiguity.
 */
const toFullSessionRow = (s: SessionListItem): SessionFullWireView => {
  const picked = pickFields(s, SESSION_LIST_KEYS);
  return { ...picked, harness: picked.harness ?? null };
};

/**
 * Apply the shared MCP-layer list shape to an already-fetched, already-filtered session list:
 * optional offset/limit pagination, then summary projection unless full:true. Pure — no db access.
 */
export function projectSessionList(
  rows: SessionListItem[],
  opts: { full?: boolean; limit?: number; offset?: number } = {},
): SessionFullWireView[] | SessionSummary[] {
  let page = rows;
  if (opts.offset !== undefined) page = page.slice(opts.offset);
  if (opts.limit !== undefined) page = page.slice(0, opts.limit);
  return opts.full ? page.map(toFullSessionRow) : page.map(toSessionSummary);
}
