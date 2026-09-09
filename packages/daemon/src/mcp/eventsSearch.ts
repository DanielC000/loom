import type { Db, EventForensicsRow } from "../db.js";
import { ALL_ORCHESTRATION_EVENT_KINDS } from "@loom/shared";
// Card 40f4cae9: the `fields:[...]` projection carried forward from `tasks_list` (card 23fde5f8) — reuse
// the SAME generic `pickFields` rather than a second projector. Applied HERE (the one query path every
// `events_search` registration — manager (mcp/orchestration.ts) and platform (mcp/platform.ts) — calls)
// so both surfaces get it uniformly instead of drifting apart.
import { pickFields } from "./tasks.js";

/** Backstop cap on a default `events_search` read (limit omitted) — same posture as
 *  DEFAULT_PROMPT_SEARCH_CAP/DEFAULT_AGENT_SUMMARY_CAP: bounds the payload of an unscoped forensics
 *  query, while an explicit `limit` can still page up to MAX_EVENTS_SEARCH_PAGE. Shared by every
 *  `events_search` registration (platform + manager surfaces) so the default can never drift between
 *  them. */
export const DEFAULT_EVENTS_SEARCH_CAP = 50;

/** Card 39f79291: `events_search`'s `kind` filter used to accept ANY string and silently match zero rows
 *  on a typo/unknown value — a false-negative generator on a forensics surface (a caller investigating
 *  precisely BECAUSE they don't know what happened reads a silent `[]` as "this never occurred"). Both
 *  the validation Set and the description string below are derived from the SAME canonical
 *  `ALL_ORCHESTRATION_EVENT_KINDS` (itself compiler-checked against the `OrchestrationEventKind` union in
 *  shared/types.ts), so an unrecognized-kind rejection and every surface's own advertised valid-kinds
 *  list can never drift apart from each other or from the real type. */
const EVENT_SEARCH_VALID_KINDS_SET = new Set<string>(ALL_ORCHESTRATION_EVENT_KINDS);
export const EVENT_SEARCH_VALID_KINDS_LIST = [...ALL_ORCHESTRATION_EVENT_KINDS].sort().join(", ");

/** The ONE query path every `events_search` registration calls — never hand-copy this. Validates `kind`
 *  against the real event-kind set (card 39f79291's fix) BEFORE the query runs, then reuses
 *  `db.listOrchestrationEventsBounded` verbatim. `projectId` is the CALLER's resolved scope: pass a
 *  concrete project id to scope the read to one project (the manager surface always does — see
 *  `orchestration.ts`'s `events_search`), or `null` for an unscoped platform-wide read (the platform
 *  surface, when its own optional `projectId` argument is omitted). */
export function eventsSearchQuery(
  db: Db,
  args: {
    kind?: string[];
    projectId: string | null;
    sessionId?: string | null;
    taskId?: string | null;
    limit?: number;
    offset?: number;
    /** Card 40f4cae9: project each returned event down to ONLY these top-level key names — see
     *  `pickFields`'s own doc (mcp/tasks.ts) for its three deliberate properties. */
    fields?: string[];
  },
): { error: string } | { events: EventForensicsRow[] | Partial<EventForensicsRow>[]; total: number; returned: number; offset: number; nextOffset: number | null } {
  const { kind, projectId, sessionId, taskId, limit, offset, fields } = args;
  if (kind && kind.length > 0) {
    const unrecognized = kind.filter((k) => !EVENT_SEARCH_VALID_KINDS_SET.has(k));
    if (unrecognized.length > 0) {
      return { error: `unrecognized kind(s): ${unrecognized.join(", ")} — valid kinds are: ${EVENT_SEARCH_VALID_KINDS_LIST}` };
    }
  }
  const off = offset ?? 0;
  const page = db.listOrchestrationEventsBounded({
    kind, projectId, sessionId: sessionId ?? null, taskId: taskId ?? null,
    limit: limit ?? DEFAULT_EVENTS_SEARCH_CAP, offset: off,
  });
  // Card 40f4cae9: nextOffset/total/returned are all derived from page.items.length/page.total BEFORE
  // projection — fields narrows what's IN each event, never how many events there are (tasks_list's rule).
  const nextOffset = off + page.items.length < page.total ? off + page.items.length : null;
  const events = pickFields(page.items as unknown as Record<string, unknown>[], fields) as EventForensicsRow[] | Partial<EventForensicsRow>[];
  return { events, total: page.total, returned: page.items.length, offset: off, nextOffset };
}
