import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TASK_STRUCTURE_SHAPE, TASK_STRUCTURE_DOC, TASK_CREATE_STRUCTURE_SHAPE, TASK_CREATE_STRUCTURE_DOC } from "../tasks/relations.js";
import { resolveConfig, mountsTaskMcp } from "@loom/shared";
import type { Db } from "../db.js";
import type { WakeService } from "../orchestration/wake.js";
import {
  listProjectTasks, getProjectTask, createProjectTaskChecked, updateProjectTask, DEFAULT_TASK_SUMMARY_CAP,
  listProjectTaskRequests, getProjectTaskRequest, deferTaskItem, updateDeferredItemStatus, countProjectTasks, countProjectTasksAsync,
  spillableTaskGet, spillableTaskUpdateResult, pickFields, applyBodyExcerpt, resolveParentIdFilter,
} from "./tasks.js";
import { writeProjectMemory, forgetProjectMemory, listProjectMemoryEntries, readProjectMemory, readProjectMemoryHistory, MAX_MEMORY_HISTORY_LIMIT } from "./memory.js";
import { registerDecisionTools } from "./decisions.js";
import { performAuthenticatedRequest } from "../connections/request.js";
import { resolveUsableConnections, resolveUsableSshConnections, connectionGrantDrift, grantDriftNote } from "../connections/store.js";
import { performSshExec } from "../connections/sshExec.js";
import { writeVaultFile } from "../vault/writer.js";
import { isConfirmedSubagent, type ToolAttributionResult } from "../pty/tool-attribution.js";
import { resolveAlias, strictShape } from "./arg-alias.js";
import { instrumentServer } from "./call-record.js";
import { withWakeTimeEcho, nowEcho, localTimeString } from "../orchestration/time-echo.js";
import { spillTextIfLarge, SPILL_INLINE_BUDGET_CHARS } from "../spill.js";
import { recordBoardRead } from "../orchestration/board-read.js";
import { isSupersededByRecycle, retiredCallerMessage } from "../orchestration/crash-orphaned-workers.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * List-shaped response, NEWLINE-DELIMITED (one JSON object per line) instead of a single
 * `JSON.stringify(array)` blob (card dc647ae2 part A) — relies on the host engine's own opaque
 * overflow-spill if the result is big enough. Used by `memory_list`, whose notes are already bounded by
 * the 4000-byte-per-note write cap. See {@link okLinesSpillable} for the tasks_list/task_requests_list
 * sibling, which proactively spills through the shared `spillTextIfLarge` primitive instead.
 */
const okLines = (rows: unknown[]) => ({ content: [{ type: "text" as const, text: rows.map((r) => JSON.stringify(r)).join("\n") }] });

/**
 * The `tasks_list`/`task_requests_list` sibling of {@link okLines}: same NEWLINE-DELIMITED JSON shape,
 * but proactively spilled via the SHARED {@link spillTextIfLarge} primitive (the same one
 * `sessions/transcript.ts` uses for oversized transcript turns) instead of relying on the host engine's
 * own opaque overflow-spill. A wide `tasks_list` window (e.g. excludeDone:false + a large limit/offset,
 * or includeBody:true over many cards) can overflow the MCP tool-result cap; the host engine's own spill
 * of a SINGLE giant JSON-array line would be unpaginatable (`Read` can't offset/limit-slice one line), so
 * this renders NDJSON text first (always Read/grep-pageable one row at a time) and only THEN checks it
 * against the budget.
 *
 * BELOW the cap: byte-identical to before — the bare NDJSON text, no envelope — UNLESS `page` is passed
 * AND signals a possibly-partial result (see below), in which case a `{rows,total,returned,offset,
 * nextOffset}` envelope is returned instead (`rows` as the real parsed array, not NDJSON text — safe to
 * inline since this only happens below the spill cap).
 * ABOVE the cap: the text is written verbatim to `sessionId`'s own scratch dir (real per-row line
 * breaks, explicit UTF-8 — same NDJSON shape the inline text already promised) and the response becomes
 * a small `{rowsFile,rowsChars,rowCount,note}` pointer instead — plus the same `total,returned,offset,
 * nextOffset` fields when `page` is passed. `key` should be deterministic per (session, list) so
 * repeated pulls overwrite rather than accumulate scratch-dir garbage.
 *
 * `page` is the completeness signal: pass `{total, offset, nextOffset, explicit}` (total = the TRUE
 * matching-row count before this page's slice; nextOffset = offset+returned while more remains, else
 * null; explicit = true iff the caller passed offset/limit itself) to opt a caller into the envelope.
 * Omitting `page` (as `task_requests_list` still does below) preserves today's behavior byte-for-byte —
 * an ADDITIVE opt-in, not a behavior change for every existing caller of this helper.
 * @decision 84f6ac42 — total/nextOffset must come from a real count query, never `rows.length` (already
 * post-slice, so it can never tell "exactly at the cap" apart from "more remains").
 * @decision 57cb355d — mirrors `list_all_tasks`'s own page envelope field-for-field, and the same "bare
 * when it fits and wasn't explicitly paged, else envelope" contract `spillableTurnsResponse` also uses.
 */
const okLinesSpillable = (
  sessionId: string, subdir: string, key: string, rows: unknown[],
  page?: { total: number; offset: number; nextOffset: number | null; explicit: boolean },
) => {
  // An empty result is an EXPLICIT empty envelope, never `text:""` (a client renders that as "no output",
  // indistinguishable from a dropped response).
  if (rows.length === 0) {
    return ok({ rows: [], total: page?.total ?? 0, returned: 0, ...(page ? { offset: page.offset, nextOffset: page.nextOffset } : {}) });
  }
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  const spill = spillTextIfLarge(sessionId, subdir, key, text, SPILL_INLINE_BUDGET_CHARS);
  if (spill.inline) {
    if (!page || (!page.explicit && page.nextOffset === null)) return { content: [{ type: "text" as const, text }] };
    return ok({ rows, total: page.total, returned: rows.length, offset: page.offset, nextOffset: page.nextOffset });
  }
  const note =
    `${rows.length} rows are ${spill.chars} chars — too large to inline safely, so they were written to ` +
    `${spill.file} as NDJSON (one JSON object per line, real line breaks, UTF-8) — page it with Read ` +
    "(offset/limit are LINE-based) or grep it for a field/id. Re-call with a narrower filter/limit to inline fewer rows instead.";
  return ok({
    rowsFile: spill.file, rowsChars: spill.chars, rowCount: rows.length, note,
    ...(page ? { total: page.total, returned: rows.length, offset: page.offset, nextOffset: page.nextOffset } : {}),
  });
};

/**
 * Deterministic JSON serialization with object keys sorted (recursively) — unlike `JSON.stringify`'s
 * array-form replacer (which filters/reorders EVERY nested object's keys against the SAME top-level key
 * list, silently emptying a nested array's numeric-index "keys"), this only touches actual object
 * properties and leaves array contents untouched. Used to derive a stable hash from an args object whose
 * key insertion order isn't guaranteed to be identical across two calls with the same logical content.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `tasks_list` spill KEY — derived from the effective (post-default) query args rather than a fixed
 * string. `spillTextIfLarge`'s own contract is "deterministic path so repeated pulls of THE SAME CONTENT
 * overwrite" — a fixed key would instead make *different* content (two distinct filter/pagination
 * combos) collide on one filename: call A spills under columns:["backlog"], call B spills under
 * excludeDone:false+includeBody:true and SILENTLY OVERWRITES A's file, so a caller reading A's pointer
 * after B's call gets B's rows with no error or signal. Hashing the args keeps the "same query overwrites,
 * not accumulates" property while giving genuinely different queries genuinely different files.
 */
function taskListSpillKey(effectiveArgs: Record<string, unknown>): string {
  return `tasks-${createHash("sha1").update(stableJson(effectiveArgs)).digest("hex").slice(0, 10)}`;
}

/**
 * `tasks_get`'s own spill KEY (card d56c6ef0) — distinguishes an EXCERPTED read (`bodyGrep`/`bodySlice`)
 * from a plain full-body read of the SAME task, and distinguishes two different excerpt options from
 * each other. Mirrors {@link taskListSpillKey}'s "derive from the effective args" shape, but a plain
 * read (no excerpt option) keeps the task's own id as its key, UNCHANGED — the exact key
 * `spillableTaskGet`/`spillableTaskUpdateResult` already use at every OTHER call site (plain reads,
 * create, update), so those stay byte-identical. Only an excerpted read gets a distinguishing suffix, so
 * a full-body spill and a bodyGrep/bodySlice spill for the same task can never silently overwrite each
 * other's scratch file — the same collision class `taskListSpillKey` already fixed for `tasks_list`'s
 * own filter/pagination combos.
 */
function taskGetSpillKey(taskId: string, excerpt: { bodyGrep?: string; bodySlice?: [number, number] }): string {
  if (excerpt.bodyGrep === undefined && excerpt.bodySlice === undefined) return taskId;
  return `${taskId}-${createHash("sha1").update(stableJson(excerpt)).digest("hex").slice(0, 10)}`;
}

/** Task priority enum, shared by the create/update/list tool schemas (rejects any other string). */
export const prioritySchema = z.enum(["p0", "p1", "p2", "p3"]);

/**
 * Project-scoped task MCP server. The session id arrives in the URL path
 * (/mcp/:sessionId); we resolve session -> project SERVER-SIDE and bind every tool to that
 * project. The agent never supplies a projectId, so cross-project access is impossible by
 * construction (§6).
 *
 * Stateless: a fresh McpServer+transport is built per request (the URL path supplies the
 * session→project binding). No per-session transport is cached, so a dropped stream can never
 * wedge the surface — every request rebuilds the identical tools from the stable mapping.
 */
export class TaskMcpRouter {
  // `fetchOverride` is a TEST-ONLY seam for `authenticated_request` (mirrors the envelope's `keyPath`
  // swappable-backend seam) — production never passes a 3rd arg, so every real spawn is unaffected.
  constructor(private db: Db, private wakes: WakeService, private fetchOverride?: typeof fetch) {}

  // @decision c2ccc4b0 — gate via the SHARED `mountsTaskMcp` predicate, never a hand-rolled
  // `role === "run"` check, or this served-side gate can drift from buildMcpServers' mount-side one.
  resolveProject(sessionId: string): string | null {
    const session = this.db.getSession(sessionId);
    if (!session || !mountsTaskMcp(session.role ?? null)) return null;
    return session.projectId;
  }

  private buildServer(projectId: string, sessionId: string, attributions?: Map<string, ToolAttributionResult>): McpServer {
    const db = this.db;
    const wakes = this.wakes;
    const fetchOverride = this.fetchOverride;
    const server = new McpServer({ name: "loom-tasks", version: "0.1.0" });
    instrumentServer(server, { router: "task", sessionId, attributions }); // card 8ef582d0; bcef7e48
    // @decision 90dc3c8c — every tool registered on this server is auto-approved under codex
    // (CODEX_AUTO_APPROVE_MCP_SERVER_IDS, pty/host.ts) the instant it merges — no separate review.

    // `session` is resolved HERE (not further down, where it used to be computed only for the
    // authenticated_request/vault_write gates) so tasks_create/tasks_update below can also condition on
    // it — SAME conditional-registration pattern as those two tools (an omitted tool never reaches
    // tools/list, not a runtime denial).
    const session = db.getSession(sessionId);

    // Field-provenance pointers for `tasks_list`'s description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // Card 245c0837 — held/heldBy are projected here; see tasks.ts's own comment on that field.
    // Card d6d40edd — mergedVerificationAtMerge:null's four legitimate causes; see tasks.ts/service.ts's
    // own comments on that batch-landing shape.
    // Card 23fde5f8 — the `fields:[...]` projection; see tasks.ts's `pickFields` doc comment.
    // @decision 022659ac — deferredUntilTaskId accepts an array for a card blocked on several tasks.
    // @decision 634edd2b — mergedVerificationAtMerge replaces the ambiguous flat mergedVerification.
    // @decision 84f6ac42 — the COMPLETENESS SIGNAL: total/nextOffset must come from a real count query.
    server.registerTool(
      "tasks_list",
      {
        description:
          "List this project's board tasks. `parentId` (full id or id-prefix) returns only that card's direct children; `ready:true` returns only READY work — cards in the workReady lane that are not held, not deferred, and have no open `blockedBy` edge (combine with `parentId` to see what is ready inside one epic). Each summary row carries `parentId`. Returns NEWLINE-DELIMITED JSON — one task object per line, NOT a JSON array — so a wide read stays Read/grep-pageable even if it spills to a file. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the rows are written to a scratch file instead of inlining, and the response becomes a `{rowsFile,rowsChars,rowCount,note}` pointer at that same NDJSON text (one task per line) — page it with Read or grep it; re-call with a narrower filter/limit to inline instead. DEFAULT: a lightweight SUMMARY ({id,title,columnKey,position,priority,updatedAt,merged,repoKey,deferred,deferredUntilTaskId,deferredStuck,deferredAt,deferredReason,held,heldBy}) — bodies OMITTED, terminal/done cards EXCLUDED. Pass includeBody:true for full bodies, or tasks_get(id) for one card. `held` is the owner's SOLE brake — `worker_spawn` refuses to dispatch onto a held:true card — and `heldBy` (`\"human\"|\"agent\"|null`) is server-stamped provenance of who set it; both are now projected here, so triaging the board no longer requires a per-card tasks_get to see a hold. deferredUntilTaskId (when set) names the task(s) this card is auto-cleared behind — a bare id for one blocker, or an array for several; deferred flips to false here once EVERY named blocker's merged state resolves non-null (one of several landing does not clear a multi-blocker card). `deferredReason` is the reason required on a manual deferral (deferred:true with no deferredUntilTaskId); null on an auto-deferral or when not deferred. `deferredAt` is the server-stamped instant the current deferral started; null when not deferred. `deferredStuck` (only meaningful while deferred:true) is `true` when the release condition can no longer be shown to resolve — a named blocker is deleted, or sits in the terminal (done) column with no proven merge (e.g. it closed with zero commits). With several blockers it is an OR: ANY one going dangling/closed-with-no-merge sets it. It is a fail-toward-VISIBLE signal, not proof the blocker will never ship; a stuck card is worth a manual look. `merged` is this card's git-derived ship state — {sha,date,verification?} of its squash-merge commit on this project's repo, else null (null = NOT PROVEN merged, not 'never merged'; treat a predecessor's 'unbuilt'/'won't-do' claim as suspect if merged is non-null). `verification`: \"content\" (byte-verified against a still-live branch tip, strongest) | \"pathset\" (same FILES landed, per a persisted path-set trailer) | \"trailer-only\" (trailer presence alone, weaker) | \"ledger\" (matched against Loom's own merge ledger and re-verified reachable; typically answers once the branch is gone, e.g. on an `orchestration.commitTrailers:\"off\"` project). Absent means unknown, not unverified. `merged.verification` is recomputed on every read; a full row (includeBody:true) ALSO carries `mergedVerificationAtMerge`, the value frozen at landing, and the two may legitimately differ once the branch is deleted — not a bug. `mergedVerificationAtMerge:null` on a merged card is never an anomaly (a solo ALREADY_MERGED/boot-reconcile landing, a `noop` batch landing, a batch landing on a `commitTrailers:\"off\"` project, or pre-fix history). Filters: columns:[...] (only those column keys), excludeDone:false (include done), minPriority:p0|p1|p2|p3 (only tasks at or above it; lower number = higher priority), idPrefix (only ids starting with this), titleContains (case-insensitive title substring) — prefer a scoped filter over paging a huge window. fields:[...] projects each returned row down to ONLY the given top-level key names, e.g. fields:[\"id\",\"title\",\"columnKey\",\"priority\",\"held\",\"deferred\",\"merged\"] (dropping deferredReason, the field most likely to blow the inline budget on a wide read). Un-asked-for fields are genuinely ABSENT, an unknown field name is silently ignored, and `id` is NOT auto-added. Ignored when countsOnly:true. Capped at " + DEFAULT_TASK_SUMMARY_CAP + " rows by default (the DEFAULT limit when you pass none) — page with limit/offset. COMPLETENESS SIGNAL: with NO offset/limit passed and the whole matching set fits in one page, returns the bare NDJSON rows (an EMPTY match returns the explicit envelope {rows:[],total:0,returned:0,...}, never an empty response); otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope: {rows,total,returned,offset,nextOffset} inline, or {rowsFile,rowsChars,rowCount,note,total,returned,offset,nextOffset} when the rows spilled to a file. `total` is the TRUE matching-row count before this call's offset/limit slice; `nextOffset` is offset+returned while more remains, else null. Page by calling again with offset:nextOffset until it is null; a `rowCount`/`returned` equal to your `limit` never by itself means \"that's everything\" unless `nextOffset` is null. Pass countsOnly:true to answer \"how many cards, by column/priority\" WITHOUT fetching row bodies — returns {total, byColumn, byPriority}; the same filters apply, limit/offset/includeBody are ignored.",
        inputSchema: strictShape({
          columns: z.array(z.string()).optional(),
          excludeDone: z.boolean().optional(),
          includeBody: z.boolean().optional(),
          minPriority: prioritySchema.optional(),
          idPrefix: z.string().optional(),
          titleContains: z.string().optional(),
          parentId: z.string().optional(),
          ready: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          countsOnly: z.boolean().optional(),
          fields: z.array(z.string()).optional(),
        }),
      },
      // Backstop the read with a default cap (caller-applied, the agentView/sessionView pattern) so an
      // includeBody read on a board with hundreds of cards can't overflow the tool-result cap. The spill
      // key is derived from the EFFECTIVE (post-default) args (taskListSpillKey) — a repeat pull under the
      // SAME filter combo overwrites the same scratch file, but two DIFFERENT filter combos never collide.
      async (args) => {
        // card d56c6ef0: an ambiguous `parentId` prefix is reported HERE, before either the countsOnly or
        // the row-fetch path below ever reaches filterProjectTasks — both share the same resolver
        // (resolveParentIdFilter), so this one check covers both.
        if (args.parentId) {
          const resolvedParent = resolveParentIdFilter(db, projectId, args.parentId);
          if ("error" in resolvedParent) return ok(resolvedParent);
        }
        // countsOnly short-circuits BEFORE the row fetch/spill machinery below — a caller asking "how many"
        // never pays for row bodies or the merged-state git enrichment (card 9798200c).
        if (args.countsOnly) return ok(await countProjectTasksAsync(db, projectId, args));
        const effective = { ...args, limit: args.limit ?? DEFAULT_TASK_SUMMARY_CAP };
        const rows = await listProjectTasks(db, projectId, effective); // `ready` (if set) is applied inside, BEFORE pagination
        // Card 84f6ac42: the completeness signal. `total` is the TRUE filtered-row count BEFORE this
        // call's offset/limit slice — computed via the cheap countProjectTasks (same filters, no
        // merged-state git enrichment, no body) rather than re-deriving it from `rows.length` (which is
        // already post-slice and can never tell "exactly at the cap" apart from "more remains").
        const total = (await countProjectTasksAsync(db, projectId, effective)).total;
        const off = effective.offset ?? 0;
        const nextOffset = off + rows.length < total ? off + rows.length : null;
        const explicit = args.offset !== undefined || args.limit !== undefined;
        // Card 23fde5f8: project down to the requested fields AFTER the completeness signal (total/
        // nextOffset) is computed against the full row set — `fields` narrows what's IN each row, never
        // how many rows there are. `effective` (which the spill key hashes) already carries `fields`, so
        // two different projections of the same query never collide on one spill file.
        const projected = pickFields(rows, effective.fields);
        const result = okLinesSpillable(sessionId, "tasks-list-spills", taskListSpillKey(effective), projected, { total, offset: off, nextOffset, explicit });
        // Card 9c8e256e: this is the genuine "recipient read the board" signal the idle-watcher's delta
        // digest anchors to (board-read.ts) — recorded for manager/platform sessions only, the only roles
        // the idle nudge ever reaches. Snapshots the FULL non-terminal board regardless of this call's own
        // filter/pagination args (see recordBoardRead's own doc), so a later delta is never computed
        // against a partial view. countsOnly above never reaches here (no card contents were actually seen).
        if (session?.role === "manager" || session?.role === "platform") {
          recordBoardRead(db, sessionId, projectId, new Date().toISOString());
        }
        return result;
      },
    );
    // Field-provenance pointers for `tasks_get`'s description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // Card d6d40edd — mergedVerificationAtMerge:null's four legitimate causes; see tasks.ts/service.ts's
    // own comments on that batch-landing shape.
    // Card 40f4cae9 — the `fields:[...]` projection; see tasks.ts's `pickFields` doc comment.
    // Card 67c54f48 — bodyGrep/bodySlice server-side excerpting; see tasks.ts's own doc on that helper.
    // @decision 3df86c87 — task parent/children/relations structure, and blocks vs deferredUntilTaskId.
    // @decision 0d4bc3f0 — deferredItems outbound view vs incomingDeferredItems, and the spill byte cost.
    // @decision 634edd2b — mergedVerificationAtMerge replaces the ambiguous flat mergedVerification.
    server.registerTool(
      "tasks_get",
      {
        description: "Read ONE full task (title + body) by id; project-scoped. Also returns the card's structure: `parentId`, `parent` ({id,title,columnKey}), `children` ({done,total,items}: `done`/`total` are always exact, `items` is capped at 100) and `relations` ({blockedBy,blocks,related,discoveredFrom,discoveries}; each blockedBy/blocks entry carries `resolved` — true once the blocker is terminal or merged; an entry with `released:true` is auto-released deferral HISTORY, not a declared dependency — don't send it back in a blockedBy/blocks write). id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool uses) — pass either one (if both, id wins). An optional `projectId` is tolerated but ignored — this tool is already scoped to the caller's own project. Also returns `deferredStuck` (only meaningful while deferred:true) — see tasks_list's own description for the full contract; it's the same field. Also returns a `requests` summary ({total, answered, pending, cancelled, items:[{id,type,title,state}]}) of any Requests connected to this task (soft-linked via taskId at question_ask time) — a task you're working may already carry a prior owner decision you'd otherwise miss; read one in full via task_request_get, or list them all via task_requests_list. Also returns this card's OWN outbound `deferredItems` ([{id,text,toTaskId,status,createdAt,updatedAt}]) — sub-items THIS card's DoD deferred onto other cards via `tasks_defer_item` — AND `incomingDeferredItems` ({total,open,acknowledged,declined,items:[{itemId,text,status,fromTaskId,fromTaskTitle,createdAt,updatedAt}]}), the INBOUND view: every item ANY other card on this board has deferred onto THIS one, regardless of that donor card's own state. Read `incomingDeferredItems.open` before assuming a card with no obvious open work is actually idle — a hand-off nobody has acknowledged shows up here even if the donor card has already closed. Flip an item's status with `tasks_defer_item_ack`. Also returns `merged`: {sha,date,verification?} of this card's squash-merge on the project repo, else null (null = not proven merged, not 'never merged'; don't trust a stale handoff claiming this card is unbuilt without checking). `verification`: content (byte-verified, strongest) | pathset (same files landed) | trailer-only | ledger; see tasks_list for the tiers. It is recomputed on every read; `mergedVerificationAtMerge` is the value frozen at landing, and the two may legitimately differ once the branch is deleted. `mergedVerificationAtMerge:null` on a merged card is never an anomaly. `fields:[...]` (same contract as `tasks_list`'s) projects the task down to ONLY the given top-level keys (unknown names are silently ignored; `id` is NOT auto-added); it is applied AFTER the spill decision, so an oversized body still spills even when `fields` omits it. `bodyGrep` (case-insensitive substring, not a regex; returns matching lines + `bodyGrepMatches`, where 0 means no match, not an empty body) or `bodySlice` ([start,end), String.slice semantics, out-of-range end clamped) excerpt `body` server-side before the spill decision (pass at most one; both is an error). The response then carries `bodyExcerpt:true` and `bodyCharsFull` (the original body length), and `body` (or `bodyFile`, if the excerpt itself spills) holds only the excerpt.",
        inputSchema: strictShape({
          id: z.string().optional(), taskId: z.string().optional(), projectId: z.string().optional(), fields: z.array(z.string()).optional(),
          bodyGrep: z.string().optional(),
          bodySlice: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
        }),
      },
      async ({ id, taskId, fields, bodyGrep, bodySlice }) => {
        const resolvedId = id ?? taskId;
        if (!resolvedId) return ok({ error: "id (or taskId) is required" });
        if (bodyGrep !== undefined && bodySlice !== undefined) return ok({ error: "pass either bodyGrep or bodySlice, not both" });
        const result = await getProjectTask(db, projectId, resolvedId);
        if ("error" in result) return ok(result);
        // Card 67c54f48: excerpt BEFORE spilling — spillableTaskGet then sees the (usually much smaller)
        // excerpted body, same as it always sees whatever `body` currently holds.
        const excerpted = (bodyGrep !== undefined || bodySlice !== undefined)
          ? applyBodyExcerpt(result, { bodyGrep, bodySlice })
          : result;
        const spilled = spillableTaskGet(sessionId, "tasks-get-spills", taskGetSpillKey(result.id, { bodyGrep, bodySlice }), excerpted);
        // Card 40f4cae9: single-row use of the same `pickFields` tasks_list already reuses — wrap/unwrap a
        // one-element array rather than writing a second (row-shaped, non-array) projector.
        const [projected] = pickFields([spilled as unknown as Record<string, unknown>], fields);
        return ok(projected);
      },
    );
    server.registerTool(
      "task_requests_list",
      {
        description:
          "List every Request (from question_ask) connected to ONE task — pending + answered + consumed + " +
          "cancelled alike — as lightweight NEWLINE-DELIMITED JSON rows: {id,type,title,state,answeredAt}. " +
          "NON-CONSUMING: unlike question_pull (which drains + consumes), this is a stable, re-readable " +
          "reference you can call again later or from a different agent/turn and still see the same " +
          "requests. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the rows spill to a scratch file " +
          "instead of inlining, and the response becomes a `{rowsFile,rowsChars,rowCount,note}` pointer at " +
          "that same NDJSON text (one request per line) — page it with Read or grep it. Use " +
          "task_request_get(id) for the full body/options/recommendation + answer. taskId " +
          "accepts the full id OR an unambiguous 8-char id-prefix (mirrors tasks_get).",
        inputSchema: strictShape({ taskId: z.string() }),
      },
      async ({ taskId }) => {
        const result = listProjectTaskRequests(db, projectId, taskId);
        if ("error" in result) return ok(result);
        // Key by the RESOLVED full task id, not the raw arg — two different unambiguous prefixes naming
        // the same task must spill to the SAME file (see listProjectTaskRequests's own doc).
        return okLinesSpillable(sessionId, "task-requests-spills", result.taskId, result.rows);
      },
    );
    server.registerTool(
      "task_request_get",
      {
        description:
          "Read ONE Request connected to a task, IN FULL: {id,type,title,body,options,recommendation," +
          "state,taskId,createdAt,answeredAt} plus its answer by type — `chosenOption`+`note` for " +
          "\"decision\"/\"input\", `approved`+`note`+`scope`+`expiresAt`+`lapsed`+`fulfillment` for " +
          "\"permission\" (all null/false until answered) — `scope`/`expiresAt` are the human's ACTUAL " +
          "decided grant (distinct from the ask-time REQUESTED scope/expiry), and `lapsed` is a " +
          "read-time-derived flag, true only once `expiresAt` is set AND in the past. ADVISORY ONLY — Loom " +
          "persists + surfaces this grant but never itself enforces, blocks, or revokes it; a recycled " +
          "successor should re-read this rather than trust a predecessor's belief about a prior 'standing' " +
          "grant. `fulfillment: {state, detail}` — an APPROVAL is an AUTHORIZATION, not evidence the " +
          "human-only write it authorizes actually happened; this reports whether it was OBSERVED, " +
          "recomputed fresh on every read (never cached): \"unknown\" (no checkable target was declared at " +
          "ask time — the default), \"unwritable\" (a target was declared but can never be observed — " +
          "`detail` says why), \"not_yet_done\" (declared, checked, not yet true — a MEASURED false, never " +
          "confused with \"unknown\"), or \"fulfilled\". Set at ask time via `question_ask`'s " +
          "`fulfillmentTarget` — see that tool's own doc. `ack` " +
          "ONLY (never the secret) for \"credential\" (null until provided). NON-CONSUMING: unlike " +
          "question_pull, reading this never flips the request's state — re-readable across turns/agents. " +
          "`id` is the REQUEST id — full id or an unambiguous 8-char id-prefix (from tasks_get's " +
          "`requests.items`/task_requests_list) — never a task/card id. Optional `taskId` " +
          "(full id or an unambiguous 8-char id-prefix) further scopes the lookup — if given, the request " +
          "must be connected to THAT task or this errors. An optional `projectId` is tolerated but ignored " +
          "— this tool is already scoped to the caller's own project (mirrors tasks_get). A request that " +
          "exists but belongs to a DIFFERENT project's board reads as not-found-here, distinctly worded " +
          "from a request that doesn't exist anywhere.",
        inputSchema: strictShape({ id: z.string(), taskId: z.string().optional(), projectId: z.string().optional() }),
      },
      async ({ id, taskId }) => ok(getProjectTaskRequest(db, projectId, id, taskId)),
    );
    // An "assistant" (Companion) session gets NEITHER tool — its only card-write path is the separately
    // grant-checked `board_create`/`board_update` (companion/capabilities.ts, mounted on loom-orchestration),
    // which take an EXPLICIT `project` param and are checked against a real `board-reach` act-mode grant.
    // Unlike those, tasks_create/tasks_update ALWAYS write to THIS session's own project with no grant
    // check at all. Every other role is unaffected — this is conditional TOOL REGISTRATION (an omitted
    // tool never reaches tools/list), the same pattern already used by authenticated_request/vault_write
    // below.
    //
    // @decision sha:9d5fd461 — tasks_create/tasks_update must stay excluded for an "assistant" (Companion)
    // session: unlike board_create/board_update they carry no grant check, so a Companion asked to file to
    // a named project could silently misfile to its own home board instead.
    //
    // `session?.role !== "assistant"` reads fail-open on a null session (an unknown/expired sessionId
    // would take the TRUE branch and register the tools) — that's fine because it's UNREACHABLE, not
    // merely unlikely: `buildServer` is private with exactly ONE caller, `handle()` below, which resolves
    // `resolveProject(sessionId)` FIRST and returns a synchronous 404 ("unknown or expired session")
    // before ever calling `buildServer` — no `await` in between, so there's no TOCTOU window either. A
    // null `session` here can only mean the id resolved to a project moments ago but the session row is
    // now gone, which cannot happen within one synchronous request.
    if (session?.role !== "assistant") {
      // Field-provenance pointers for `tasks_create`'s description below, relocated out of the
      // agent-facing text (an end-user agent can't resolve a card/decision id):
      // @decision 267fd215 — the HTML-entity title guard rejects the SHAPE, not the author's intent.
      // @decision 3a833d94 — the conventional-type guard mirrors the HTML-entity guard's own refusal shape.
      // @decision 5b221bf2 — the cross-channel duplicate advisory's own identifier-strength rules.
      // @decision d6890435 — that advisory was demoted from a block to advisory-only.
      server.registerTool(
        "tasks_create",
        {
          description: "Create a task on this project's board. priority p0|p1|p2|p3 (low number = higher priority), default p2. Optional repoKey (multi-repo epic) targets one of this project's registered `repos` — omit (or pass \"primary\") for the project's primary repo; an unknown key is rejected with {error}. CROSS-CHANNEL DUPLICATE ADVISORY: if this card's title+body shares a RARE STRONG identifier (a session id or a Loom branch name — full UUIDs/`loom/<hex>` only, NOT prose similarity or a bare code symbol/file:line/error constant) with an existing card, the create still SUCCEEDS and the result carries `related: {taskId, title, sharedIdentifiers}` naming the suspected counterpart — never a block or auto-merge. Pass allowDuplicate:true to skip computing the advisory, or supersedes:\"<taskId>\" (full id or unambiguous prefix) to declare that this card replaces one (noted on the new card's body and back-noted on the target's), or relatedTo:\"<taskId>\" (or an array of ids) to create real `related` relations (no prose written). Both skip the advisory. HTML-ENTITY GUARD: a title containing &lt;/&gt;/&amp;/&quot;/&#NN; is REFUSED with {error} naming the decoded form you likely meant — a SOLO merge uses the title VERBATIM as the squash commit subject, so an accidentally-escaped title becomes a PERMANENT mainline artifact. If the title is genuinely ABOUT escaped HTML, pass allowHtmlEntities:true. CONVENTIONAL-TYPE GUARD: a title carrying a `type(scope):`-shaped prefix whose type is NOT one of feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert is REFUSED with {error} naming the bad type and the allowed set — the merge-time coercion net only fixes BARE prose, so an invalid type-shaped prefix would ship verbatim as a permanent mainline commit subject. A title with NO type-shaped prefix is unaffected. Pass allowNonConventionalType:true if deliberate. DEFERRAL AT CREATE: `deferred`, `deferredUntilTaskId` (full id/prefix, or an array) and `deferredReason` mean exactly what they do on tasks_update (a manual deferral — deferred:true with no deferredUntilTaskId — REQUIRES deferredReason). They are applied right after the card is created; if the deferral is refused the card still exists and the result carries `deferralError` (retry the deferral with tasks_update)." + TASK_CREATE_STRUCTURE_DOC,
          inputSchema: strictShape({
            ...TASK_CREATE_STRUCTURE_SHAPE,
            title: z.string(), body: z.string().optional(), columnKey: z.string().optional(), priority: prioritySchema.optional(), repoKey: z.string().nullable().optional(),
            allowDuplicate: z.boolean().optional(), supersedes: z.string().optional(), relatedTo: z.union([z.string(), z.array(z.string())]).optional(),
            allowHtmlEntities: z.boolean().optional(),
            allowNonConventionalType: z.boolean().optional(),
            deferred: z.boolean().optional(),
            deferredUntilTaskId: z.union([z.string(), z.array(z.string())]).nullable().optional(),
            deferredReason: z.string().nullable().optional(),
          }),
        },
        async ({ allowDuplicate, supersedes, relatedTo, allowHtmlEntities, allowNonConventionalType, deferred, deferredUntilTaskId, deferredReason, ...args }) => {
          let created = createProjectTaskChecked(db, projectId, args, { allowDuplicate, supersedes, relatedTo }, allowHtmlEntities, allowNonConventionalType);
          // Card 788ed7f4: a successful card create is a disposition — clear any open "owner message left
          // without a disposition" episode for THIS session, by occurrence alone (no content matching).
          if (!("error" in created)) db.clearPendingOwnerMessage(sessionId);
          // Deferral at create: routed through updateProjectTask (a field-only patch, no baseVersion) so it
          // shares tasks_update's validation byte-for-byte. A refusal never un-creates the card; it is
          // surfaced as `deferralError` on the otherwise-successful result.
          const deferralPatch: Record<string, unknown> = {};
          if (deferred !== undefined) deferralPatch.deferred = deferred;
          if (deferredUntilTaskId !== undefined) deferralPatch.deferredUntilTaskId = deferredUntilTaskId;
          if (deferredReason !== undefined) deferralPatch.deferredReason = deferredReason;
          if (!("error" in created) && Object.keys(deferralPatch).length > 0) {
            const applied = await updateProjectTask(db, projectId, created.id, deferralPatch, { sessionId, role: session?.role });
            if ("error" in applied) {
              created = { ...created, deferralError: applied.error } as typeof created;
            } else {
              const fresh = db.getTask(created.id);
              if (fresh) created = { ...created, ...fresh } as typeof created;
            }
          }
          // Card f651aff0: same oversized-body gap as tasks_get (card 7aeea78b) — createProjectTaskChecked
          // returns the full Task (title+body) on success, unbounded. spillableTaskGet is a no-op below the
          // cap (byte-identical to before).
          return ok("error" in created ? created : spillableTaskGet(sessionId, "tasks-create-spills", created.id, created));
        },
      );
      // Field-provenance pointers for `tasks_update`'s description below, relocated out of the
      // agent-facing text (an end-user agent can't resolve a card/decision id):
      // Card e2756e47 — appendBody's additive-vs-full-replace exclusivity; see companion/capabilities.ts's
      // own comment on that same contract.
      // Card fe4a9a17 — the 409 conflict is a bare `baseVersion !== current.version` comparison, never a
      // separate read-tracker; see tasks.ts's own comment at that check.
      // Card f5292cf9 — the auto-release-on-read fold/version-bump mechanics; see tasks.ts/gateway/
      // server.ts's own comments on that path.
      // Card 3b2aa339 — the terminal-close specimen where this guard correctly did NOT block the move; see
      // tasks.ts's own `PendingRequestWarning` doc comment. (3b2aa339 is the REST-tier memory-capacity
      // card itself — card c4355598 cites that same card's own terminal close as its grounding specimen;
      // one card, not a colliding id with project-memory-recall.ts's own decision anchor for it.)
      // @decision 022659ac — deferredUntilTaskId accepts an array for a card blocked on several tasks.
      // @decision c90e9525 — a manual deferral with no deferredUntilTaskId requires deferredReason.
      // @decision 1d27c3cd — the "Previously deferred" body fold happens before either reset.
      // @decision 74716cfb — deferredUntilEvent never auto-clears and carries no release semantics.
      // @decision 0ad1ca68 — heldRequestId traces a hold back to its Request after it's answered/consumed.
      // @decision 09d68835 — the destructive-truncation guard specimen.
      // @decision a53b24ce — the same truncation guard also covers deferredReason.
      // @decision d0978321 — task version is a content counter, not a row counter.
      // @decision 363f5c2d — the manual-deferral-release body fold + version bump also fires on auto-release.
      // @decision 267fd215 — the HTML-entity title guard rejects the shape, not the author's intent.
      // @decision 3a833d94 — the conventional-type guard mirrors the HTML-entity guard's own refusal shape.
      // @decision c4355598 — the terminal-lane pending-request warning can never block the move.
      server.registerTool(
        "tasks_update",
        {
          description: "Update a task by id; project-scoped. PATCH-style: pass only the field(s) you're changing. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); `taskId` is accepted as an ALIAS for `id` (as on every sibling task tool); if both, id wins. priority p0|p1|p2|p3 (low number = higher priority). held=true marks an owner-gated card the idle watchdog won't nag about — you MAY set this yourself. held=false CLEARS it, but only if held wasn't set by the owner: clearing an owner-set hold is REFUSED (returns {error}, nothing written); only the owner can release it, via the board UI. deferred=true is YOUR OWN sequencing/dependency marker — discounted from the idle watchdog's actionable count, but (unlike held) never blocks worker_spawn. Optional deferredUntilTaskId (\"deferred until THIS task merges\") pairs with deferred:true for a blocker that's a queryable card ON THIS BOARD (full id or unambiguous prefix, normalized to the full id): the daemon auto-clears deferred the next time this card is read, once that blocker's `merged` state resolves non-null; pass null to clear the pairing. Pass an ARRAY of ids when blocked on MORE than one thing: deferred then auto-clears only once EVERY named blocker has merged, and deferredStuck fires if ANY one goes dangling/closed-with-no-merge. A single resolved id always reads back as a bare string. If the blocker instead closes with NO squash commit (a legitimate 0-commit outcome) or is deleted, deferred deliberately does NOT auto-clear; the read-time `deferredStuck` flag (tasks_list/tasks_get) flips true and the card stops being discounted from the idle watchdog's actionable count. A self-reference or an id that doesn't resolve on this board rejects the whole patch (nothing written). PREFER deferredUntilTaskId over prose whenever the blocker IS a queryable card: a condition named only in deferredReason has no auto-clear and can't raise deferredStuck. Leave it unset ONLY for a deferral gated on something that isn't a card (an owner decision, an external release, an elapsed-time window, an observation like \"if this recurs\"); those stay manually managed and need a periodic manual sweep. A MANUAL deferral (deferred:true with no deferredUntilTaskId) REQUIRES `deferredReason` (a short string: why it's parked and what would release it); the write is REFUSED (whole patch rejected, nothing written) if the resulting state would be manually-deferred with no reason recorded before or after this patch. The daemon stamps a read-only `deferredAt` (never caller-settable) the first time a reason lands; `deferredAt` and `deferredReason` reset to null on an explicit `deferred:false` and on the deferredUntilTaskId auto-release. Before either reset, a recorded reason is folded into the card's `body` as its own \"**Previously deferred:**\" paragraph (replacing any earlier such paragraph), so the reasoning survives. A deferredUntilTaskId deferral needs no reason. Optional deferredUntilEvent ({kind:\"gate-fail-naming\"|\"request-answered\", key:<string>}) ANNOTATES which event a deferral is watching for (e.g. {kind:\"gate-fail-naming\", key:\"some-test-file.mjs\"} for a gate run whose failed test files include that one), so a later gate-outcome nudge can point a reader at this card. It NEVER auto-clears anything and has no release semantics; release is your own judgement call. Pass null to clear; a malformed kind/key is REFUSED (whole patch rejected). repoKey (multi-repo epic) re-targets the card to another entry in this project's `repos` registry, or null/\"primary\" to reset to the primary repo; an unknown key is REFUSED (whole patch rejected), like an unknown columnKey. Optional heldRequestId is a STANDING annotation: which owner Request (any state, including answered/consumed) this card's hold traces back to. It is independent of held/deferred and of the Request's own taskId, and nothing infers it, so set it yourself when a hold is explained by a specific Request. It must resolve to a real request on THIS project (whole patch rejected otherwise); pass null to clear. tasks_get resolves it LIVE into `heldRequestState` on every read, degrading to a fail-visible {notFound:true} if the request is later deleted.\n\nA column/priority/deferred/held/heldRequestId/repoKey/deferredUntilTaskId/deferredReason/deferredUntilEvent-only move needs ONLY id + those fields — no body — and returns a TRIMMED ack ({id,title,columnKey,priority,position,held,deferred,heldBy,heldRequestId,repoKey,deferredUntilTaskId,deferredAt,deferredReason,deferredUntilEvent,updatedAt,version,changed}, no body); deferredStuck is read-derived only, so re-read via tasks_get/tasks_list for it. Pass body when you're intentionally editing it — that returns the full updated task, body included. ⚠️ `body` is a FULL REPLACE, not a merge or append — whatever string you pass BECOMES the entire body, with NO undo; to change part of it, read the current body first (tasks_get) and pass back the whole thing with your edit folded in. DESTRUCTIVE-TRUNCATION GUARD: a `body` write that would discard the large majority of an existing SUBSTANTIAL body (≥1024 characters, keeping <25% of it) is REFUSED — {error naming the current/proposed lengths, truncation:true, current (the task as it stands now), currentLength, proposedLength}. A short body, or a rewrite of comparable size, is never touched. If a large discard is genuinely intentional, pass allowTruncate:true. The SAME guard (thresholds, override and {truncation:true,...} shape) also covers `deferredReason`, even though it is otherwise a field-only patch needing no baseVersion; pass deferredReason:null to clear one deliberately (never guarded) or allowTruncate:true. ⚠️ NEVER write a placeholder into deferredReason (or body) just to read a task's `version` back: tasks_get, tasks_list and every tasks_update response already return `version`.\n\n`appendBody` is the ADDITIVE alternative to `body`: it appends a timestamped \"## Triage note — <ts>\" section instead of replacing the body — use it for a note, decision or status update on a card whose body already carries something worth keeping (e.g. a worker's report), so it can never clobber it. Passing both `body` and `appendBody` is REJECTED (whole patch, nothing written). `appendBody` needs NO `baseVersion` (an append can't destructively clobber a concurrent edit; worst case under a race is two sections in nondeterministic order, never lost content). The destructive-truncation guard still applies to the resulting write as a backstop. Returns the same TRIMMED ack as a field-only move (id, title, version, updatedAt, `changed:[\"body\",...]`, no body) — pass `returnFullTask:true` to get the full updated task, body included (a `body` replace still returns the full task).\n\nOPTIMISTIC CONCURRENCY: writing `title` and/or `body` on an EXISTING task REQUIRES `baseVersion` — the `version` you last read for this task (from tasks_get/tasks_list/a prior tasks_update response). A stale-or-omitted `baseVersion` on a title/body write is REJECTED with {error, conflict:true, current} (the task as it stands now) instead of overwriting — re-read and retry, merging your change into the current body. It is a PLAIN COMPARISON against the task's current `version`, not a read-tracker; the error text says which cause fired: `baseVersion` omitted (by far the more common: you forgot the param, not a race) or genuinely stale (`current` differs from what you last read). If `current` is byte-identical to what you have, nobody wrote it in between (mirrors memory_write). A column/priority/held/deferred/position/repoKey/deferredUntilTaskId/deferredReason/deferredUntilEvent-only patch needs NO baseVersion. `version` advances whenever a patch INCLUDES `title` and/or `body` as a key, even when the value is byte-identical to the stored one (the bump keys on the patch's shape, not a value diff). It can also advance without you passing body: a manual `deferred:false` release that had a `deferredReason` folds it into `body` server-side (see above), and the same fold fires on a plain READ, since tasks_get/tasks_list auto-release a deferral once its named blocker merges. So re-read the returned `version` rather than assuming it from which fields you patched; an unchanged `version` across two tasks_update calls does not prove nothing happened in between.\n\nHTML-ENTITY GUARD: a `title` write containing &lt;/&gt;/&amp;/&quot;/&#NN; is REFUSED with {error} naming the decoded form you likely meant — a SOLO merge uses the title VERBATIM as the squash commit subject, so an accidentally-escaped title becomes a PERMANENT mainline artifact. If the title is genuinely ABOUT escaped HTML, pass allowHtmlEntities:true; irrelevant when this patch doesn't touch `title`.\n\nCONVENTIONAL-TYPE GUARD: a `title` write carrying a `type(scope):`-shaped prefix whose type is NOT one of feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert is REFUSED with {error} naming the bad type and the allowed set — the merge-time coercion net only fixes BARE prose (no type-shaped prefix), so an already type-shaped-but-invalid prefix would ship verbatim as a permanent mainline commit subject. A title with no type-shaped prefix is unaffected. Pass allowNonConventionalType:true if deliberate; irrelevant when this patch doesn't touch `title` (a stored title with an invalid type is never retroactively blocked by an unrelated field-only patch).\n\nTERMINAL-LANE PENDING-REQUEST WARNING: a `columnKey` move into the board's terminal (done) lane is ADDITIVELY flagged with `pendingRequestWarning: [{id, title}, ...]` when this task still has one or more `state:\"pending\"` owner Requests connected to it (the set task_requests_list/task_request_get read): the specific request id(s) and question title(s), never a bare count. This NEVER blocks the move (a real terminal close was correct despite a still-pending Request), and the field is OMITTED for a non-terminal move or when nothing is pending." + TASK_STRUCTURE_DOC,
          inputSchema: strictShape({
            ...TASK_STRUCTURE_SHAPE,
            id: z.string().optional(),
            taskId: z.string().optional(),
            title: z.string().optional(),
            body: z.string().optional(),
            appendBody: z.string().optional(),
            columnKey: z.string().optional(),
            position: z.number().optional(),
            priority: prioritySchema.optional(),
            held: z.boolean().optional(),
            deferred: z.boolean().optional(),
            deferredUntilTaskId: z.union([z.string(), z.array(z.string())]).nullable().optional(),
            deferredReason: z.string().nullable().optional(),
            deferredUntilEvent: z.object({ kind: z.enum(["gate-fail-naming", "request-answered"]), key: z.string() }).nullable().optional(),
            repoKey: z.string().nullable().optional(),
            heldRequestId: z.string().nullable().optional(),
            baseVersion: z.number().optional(),
            allowTruncate: z.boolean().optional(),
            allowHtmlEntities: z.boolean().optional(),
            allowNonConventionalType: z.boolean().optional(),
            returnFullTask: z.boolean().optional(),
          }),
        },
        async ({ id, taskId, baseVersion, allowTruncate, appendBody, allowHtmlEntities, allowNonConventionalType, returnFullTask, ...patch }) => {
          const resolvedId = resolveAlias(id, taskId);
          if (resolvedId === undefined) return ok({ error: "id (or taskId) is required" });
          // role threaded for the repoKey authority guard (code-review ruling): a worker on this SAME
          // router can reach tasks_update, but must not be able to set repoKey (a dispatch decision) —
          // see updateProjectTask's own doc.
          const result = await updateProjectTask(db, projectId, resolvedId, patch, { sessionId, role: session?.role }, baseVersion, allowTruncate, appendBody, allowHtmlEntities, allowNonConventionalType, returnFullTask !== true);
          // Card f651aff0: same oversized-body gap as tasks_get (card 7aeea78b) — a body/appendBody write
          // (or the `current` a conflict/truncation refusal hands back) returns the full unbounded Task.
          // spillableTaskUpdateResult is a no-op below the cap and for the trimmed TaskUpdateAck/bare-error
          // shapes, which carry no body at all — byte-identical to before in both cases.
          return ok(spillableTaskUpdateResult(sessionId, "tasks-update-spills", result));
        },
      );
      // @decision 0d4bc3f0 — deferredItems outbound view vs incomingDeferredItems, and the spill byte cost.
      server.registerTool(
        "tasks_defer_item",
        {
          description:
            "Board-hygiene: defer a DoD sub-item from THIS task onto ANOTHER task on the " +
            "same board, recorded STRUCTURALLY instead of only in a `Related:`/prose note (write that too — " +
            "this is additive, not a replacement). `id`/`taskId` (alias) is the DONOR task — the one whose " +
            "DoD is deferring the item; `toTaskId` (full id or an unambiguous 8-char prefix, resolved to the " +
            "full id before it's written) is the RECEIVING task. Rejects a self-reference and a `toTaskId` " +
            "that doesn't resolve on this board — whole call rejected, nothing written. The new item starts " +
            "`status:\"open\"` and is returned in full ({id,text,toTaskId,status,createdAt,updatedAt}); the " +
            "RECEIVING task sees it show up in ITS OWN `tasks_get`'s `incomingDeferredItems` — that's the " +
            "detectability mechanism: a card that never acknowledges a hand-off stays visibly `\"open\"` on " +
            "a plain read of the recipient, instead of the hand-off evaporating into donor-card prose nobody " +
            "is obligated to re-read. Flip the status later with `tasks_defer_item_ack`.",
          inputSchema: strictShape({
            id: z.string().optional(),
            taskId: z.string().optional(),
            toTaskId: z.string(),
            text: z.string(),
          }),
        },
        async ({ id, taskId, toTaskId, text }) => {
          const resolvedId = resolveAlias(id, taskId);
          if (resolvedId === undefined) return ok({ error: "id (or taskId) is required" });
          return ok(deferTaskItem(db, projectId, resolvedId, { text, toTaskId }));
        },
      );
      // @decision 0d4bc3f0 — deferredItems outbound view vs incomingDeferredItems, and the spill byte cost.
      server.registerTool(
        "tasks_defer_item_ack",
        {
          description:
            "Flip ONE deferred item's status — acknowledge it landed in the recipient's " +
            "scope, decline it (the donor changed its mind, or the recipient is explicitly not taking it " +
            "on), or reopen it back to \"open\". `id`/`taskId` (alias) is the DONOR task that RECORDED the " +
            "item (via `tasks_defer_item`) — the one whose `deferredItems` array actually holds it, NOT " +
            "necessarily the task you're currently working; `itemId` is the item's own id, found on the " +
            "donor's own `tasks_get` (`deferredItems[].id`) or on the RECEIVING task's `tasks_get` " +
            "(`incomingDeferredItems.items[].itemId` — same items array carries the matching `fromTaskId` " +
            "to pass as `id` here). Either party may call this. Returns the updated item, or {error} if " +
            "`itemId` doesn't match any entry on that task.",
          inputSchema: strictShape({
            id: z.string().optional(),
            taskId: z.string().optional(),
            itemId: z.string(),
            status: z.enum(["open", "acknowledged", "declined"]),
          }),
        },
        async ({ id, taskId, itemId, status }) => {
          const resolvedId = resolveAlias(id, taskId);
          if (resolvedId === undefined) return ok({ error: "id (or taskId) is required" });
          return ok(updateDeferredItemStatus(db, projectId, resolvedId, itemId, status));
        },
      );
    }

    // Project-scoped SHARED memory (card 2fd9abf9) — universal, every project session, ANY worker may
    // write (owner decision #1: it's notes, not code/secrets). Pinned + FTS5-related notes are injected
    // into every kickoff (sessions/service.ts); these tools are the deliberate-capture write path.
    // Field-provenance pointers for `memory_write`'s description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // @decision aeec1880 — triggerGlob gates pinned delivery to a kickoff whose text names a matching path.
    // @decision b1f34988 — the near-duplicate advisory's score + coverage computation.
    // @decision 57a91801 — expiresAt gates kickoff DELIVERY, not existence.
    // @decision 8d158088 — the sub-agent-attribution refusal: fail-open on an uncertain attribution.
    server.registerTool(
      "memory_write",
      {
        description:
          "Write (or UPDATE) a project-scoped note into this project's SHARED memory — durable knowledge " +
          "every worker/manager sees at kickoff, across sessions. `key` is a short stable slug (letters/" +
          "digits/-/_ only) that identifies this note: writing the SAME key again UPDATES it in place " +
          "(no duplicate accumulation) — prefer refining an existing key over minting a near-duplicate. " +
          "`text` is the note body. `pinned:true` marks it especially important — pinned notes are " +
          "offered to EVERY kickoff and never auto-evicted — a long pinned note is injected as its lead plus a " +
          "`memory_read` pointer, and a \"never-drop\" note as its title, first rule line and key only (read " +
          "the body with `memory_read`; a note under ~400 chars goes whole), so put the rule FIRST: the first " +
          "line that isn't a date/version stamp or heading is the rule; leave it false/omitted for a note " +
          "that should surface only when RELEVANT (full-text matched against the kickoff/task text). When the " +
          "digest budget can't fit every pinned note, they are delivered newest-updated first, so an old " +
          "critical pinned note can be dropped — tag it `\"never-drop\"` (via `tags`) to pack it ahead of every " +
          "other pinned note; a dropped never-drop note is reported as a distinct ALARM, but can still fail to " +
          "fit if it alone exceeds the whole budget. `\"never-drop\"` is inert on an unpinned note (this " +
          "response says so). On a pinned note it returns a `neverDropStatus` giving that floor tier's current " +
          "size against the read-side digest budget (`memory.budgetTokens`) — informational, never blocks. " +
          "UNPINNED notes are bounded too (`memory.maxNotes`, a per-project cap on unpinned rows; pinned are " +
          "exempt): at the cap, every write anywhere in the project evicts the single most-evictable unpinned " +
          "row (never-retrieved notes first, oldest first) — a note you just wrote can BE that row and vanish " +
          "within minutes of a sibling write with no prior signal. When the project is at/over the cap and this " +
          "note is unpinned, the response carries an `evictionStatus` " +
          "({nextEvictionCandidate, unpinnedCount, maxNotes, writesUntilEviction, message}): " +
          "`nextEvictionCandidate:true` means the VERY NEXT write by ANYONE will delete this note; " +
          "`writesUntilEviction` estimates the writes left at its current rank. ONLY landing in a RENDERED " +
          "kickoff digest resets a note's rank — `memory_read`/`memory_list` do NOT save it. Informational, " +
          "never blocks. If the note must survive, put its content somewhere durable outside project memory " +
          "(the task card or your report); do NOT pin just to dodge the cap, since pinning spends the " +
          "separately-budgeted pinned tier and gives up the note's FTS-relevance recall path (a pinned note " +
          "rides every kickoff, or is dropped from it). Optional `title` " +
          "(short label, max 200 chars) and `tags` (string[]). `title` (or, if omitted, `key`) is rendered " +
          "into every delivered note's digest header as `### {title} ({key})`; both consume " +
          "`memory.budgetTokens` on every kickoff like `text` does, so keep the title short. Write " +
          "declarative facts/decisions worth remembering across sessions, not throwaway task chatter. " +
          "`text` ALONE is capped at 4000 bytes (the header's bytes are separate and uncapped here); a " +
          "too-long write is rejected with `bytesOver` + the current note (if any) so you can trim without " +
          "re-fetching. A note that is (after this write) `pinned:true` AND tagged `\"never-drop\"` — i.e. " +
          "IN the floor tier — is held to a LOWER, SEPARATE cap of 2000 bytes, and this one BLOCKS (it is not " +
          "the `neverDropStatus` advisory): that tier rides on EVERY future kickoff regardless of relevance. " +
          "Rejected the same way (`bytesOver` + `current`), on ANY write leaving the note pinned+never-drop and " +
          "over 2000 bytes, including a metadata-only update; no grandfather clause. For dense " +
          "safety/operational prose, PREFER splitting the overflow into a separate cross-linked key over " +
          "trimming. Unpinning the note, or dropping `\"never-drop\"`, falls back to the general 4000-byte cap " +
          "and makes the note evictable. " +
          "UPDATING AN EXISTING KEY IS A TRUE PATCH: `title`/`pinned`/`tags`/`text` you OMIT are left " +
          "UNCHANGED, never reset to a default — pass only `key`+`baseVersion` to edit metadata and leave the " +
          "body byte-identical, or only `key`+`text`+`baseVersion` to edit the body alone. To CLEAR " +
          "`pinned`/`tags`, pass them explicitly (`pinned:false`, `tags:[]`); `text` cannot be blanked to " +
          "empty. `text` stays REQUIRED when `key` names a BRAND-NEW note. " +
          "The response echoes the resulting `pinned`/`tags`/`title`/`text`. " +
          "UPDATING A NOTE THAT ALREADY EXISTS REQUIRES `baseVersion` — the `version` you last read for " +
          "this key (from memory_read, memory_list, or a prior memory_write's response; NOT its `updatedAt` " +
          "timestamp). Omitting it, or passing a stale one, is REJECTED with `conflict:true` and `current` " +
          "(the note as it stands now) instead of overwriting someone else's write — re-read, merge your " +
          "change into `current.text`, and retry with `baseVersion: current.version`. A brand-new " +
          "key needs no base, and omitted `title`/`pinned`/`tags` default to \"\"/false/[] on create. " +
          "Optional `requestIds`: link this note to Request ids (from `question_ask`) instead of writing their " +
          "state into `text` — every read (kickoff injection, memory_read, memory_list) re-resolves each id's " +
          "LIVE state and appends `[linked request <id>: <STATE> as of <date>]`, so a note written while a " +
          "request is PENDING self-corrects once answered. Omitting `requestIds` on an update keeps the links " +
          "(PATCH semantics); pass `[]` to clear. " +
          "Optional `triggerGlob` — a path-glob predicate that gates a `pinned:true` note's delivery to a " +
          "kickoff whose text names a matching path, instead of pinning it globally: where the glob matches the " +
          "note rides the pinned tier; on every other kickoff it stays FULLY reachable via full-text search. " +
          "Only meaningful on a note that is (post-write) `pinned:true` and NOT tagged `\"never-drop\"` " +
          "(never-drop always bypasses any trigger, so tagging both leaves it inert); the response's " +
          "`triggerGateStatus` says which applies. PATCH semantics: omit to keep, `\"\"` to clear back to " +
          "unconditional pinning, or a glob (e.g. `\"src/memory/**\"`) to set it — matched against path-like " +
          "substrings found literally in the RECEIVING session's kickoff/task text, not real touched files. " +
          "On a BRAND-NEW key only, the response may carry a `nearDuplicateStatus` " +
          "({message, key, score, coverage}) when the new note's title+text closely resembles an EXISTING " +
          "note (local FTS5 check, no metered tokens) — advisory, never blocks; consider updating the NAMED " +
          "key instead of accumulating a near-duplicate. Never present on an update. " +
          "If `text` contains a `[[wikilink]]` whose target key does not exist in this project's memory, the " +
          "response carries an `unresolvedLinkStatus` ({message, unresolvedKeys}) — advisory, never blocks, " +
          "the link is never stripped. The target may be a typo, a note not yet written, or a deliberate " +
          "reference into a DIFFERENT memory system; treat it as a prompt to double-check, not an error. " +
          "Optional `expiresAt` — an ISO date/datetime (UTC, e.g. \"2026-12-01\") past which this note is " +
          "excluded from EVERY kickoff tier (pinned AND related), for a note that should compete for context " +
          "only while something stays true. The note is NOT deleted: `memory_read`/`memory_list` keep returning " +
          "it, annotated `expired:true`, and it still counts toward `memory.maxNotes` eviction and " +
          "near-duplicate matching; only kickoff delivery is gated. PATCH semantics as `triggerGlob`: omit to " +
          "keep, `\"\"` to clear (never expires), or a date to set; it must parse as a valid date or the write " +
          "is rejected. The response may carry an `expiryStatus` ({message, alreadyExpired?}) when `expiresAt` " +
          "is set — advisory; `alreadyExpired:true` means the date has ALREADY passed, so the note won't ride " +
          "any kickoff tier until cleared or moved forward. " +
          "REFUSED with {error} if this call is CONFIRMED to have originated from a sub-agent (a Task/Agent " +
          "sub-call) rather than your own top-level turn — call this directly. An UNCERTAIN attribution never " +
          "refuses (fail-open).",
        inputSchema: strictShape({
          key: z.string(),
          // Card 145e8d72: optional at the SCHEMA level so the SDK doesn't strip/reject an omitted `text`
          // on a metadata-only update — writeProjectMemory (mcp/memory.ts) is the one that still enforces
          // "required on create" (a request-shape rule, not a type one; see mcp-sdk-strips-undeclared-args
          // project memory for why an alias/optionality decision like this belongs in the schema, not a
          // pre-validation hook that doesn't exist).
          text: z.string().optional(),
          title: z.string().optional(),
          pinned: z.boolean().optional(),
          tags: z.array(z.string()).optional(),
          requestIds: z.array(z.string()).optional(),
          triggerGlob: z.string().optional(),
          expiresAt: z.string().optional(),
          baseVersion: z.number().int().optional(),
        }),
      },
      async (args) => {
        // Card 8d158088 (enforcement half of cd0c7fee): refuse ONLY on a POSITIVELY CONFIRMED sub-agent
        // call — "unknown"/"ambiguous" (a correlation failure, an old CLI, a post-restart empty queue)
        // MUST fail open, non-negotiably (CLAUDE.md's own standing rule on this card). memory_write has no
        // stranding risk (unlike worker_report, a worker's only channel up), so this is the one of the two
        // watched tools where the directionality review landed on refusal rather than attribute-and-allow.
        const attribution = attributions?.get("memory_write");
        if (isConfirmedSubagent(attribution?.state)) {
          return ok({
            error:
              `memory_write REFUSED — this call was attributed to a sub-agent` +
              `${attribution?.agentType ? ` (agentType=${attribution.agentType})` : ""}, not your own top-level ` +
              "turn. Project memory is shared, durable knowledge — call memory_write directly from your own " +
              "reasoning, not through a delegated Task/Agent sub-call.",
          });
        }
        return ok(writeProjectMemory(db, projectId, args));
      },
    );
    // Card 42e9caf9 — mirrors memory_write's own sub-agent-attribution refusal (card 8d158088, see that
    // tool's own provenance comment above); see also db.ts/memory.ts's own comments on the deleted-key
    // conflict case. (42e9caf9's own DoD covered this fix AND registry.ts's RESERVED_CAPABILITY_SLUGS
    // reservation (its item 4) in the same card — one card, not two unrelated records sharing an id.)
    server.registerTool(
      "memory_forget",
      {
        description:
          "Delete a project-scoped memory note by key. Idempotent — deleting a missing key returns " +
          "{ok:true,deleted:false}, never an error. Mirrors memory_write's own refusal shape: " +
          "REFUSED with {error} if this specific call is CONFIRMED to have originated from a " +
          "sub-agent (a Task/Agent sub-call), rather than your own top-level turn — project memory is " +
          "shared, durable knowledge; deleting it is a deliberate curation decision the calling agent " +
          "should make directly, not through a delegated sub-agent. An UNCERTAIN attribution never refuses " +
          "(fail-open) — only a positively-confirmed sub-agent call is rejected.",
        inputSchema: strictShape({ key: z.string() }),
      },
      async ({ key }) => {
        // Card 8d158088 / 42e9caf9: same fail-open-unless-confirmed posture as memory_write above — see
        // that handler's own comment for why "unknown"/"ambiguous" attributions must never refuse.
        const attribution = attributions?.get("memory_forget");
        if (isConfirmedSubagent(attribution?.state)) {
          return ok({
            error:
              `memory_forget REFUSED — this call was attributed to a sub-agent` +
              `${attribution?.agentType ? ` (agentType=${attribution.agentType})` : ""}, not your own top-level ` +
              "turn. Project memory is shared, durable knowledge — call memory_forget directly from your own " +
              "reasoning, not through a delegated Task/Agent sub-call.",
          });
        }
        return ok(forgetProjectMemory(db, projectId, key));
      },
    );
    // @decision 57a91801 — expiresAt gates kickoff DELIVERY, not existence (the note still reads back).
    server.registerTool(
      "memory_list",
      {
        description:
          "List this project's SHARED memory notes (pinned first, then most-recently-updated). Returns " +
          "NEWLINE-DELIMITED JSON, one note per line. Each note carries `requestAnnotations` — one line per " +
          "linked `requestIds` entry, resolved against the requests store's LIVE state at THIS read (never " +
          "frozen at write time): `[linked request <id>: <STATE> as of <date>]`, or a fail-visible " +
          "\"request not found — may be deleted\"/\"not found in this project\" if the id doesn't resolve. " +
          "Each note also carries `everDelivered` (`retrievalCount > 0`) — false means this note has NEVER " +
          "once been included in an actually-injected kickoff digest (a merely-explicit memory_read/memory_list " +
          "doesn't count), regardless of whether it's pinned or matched by a related-tier search — if you wrote " +
          "a note and it shows `everDelivered:false`, nobody has received it yet. Each note also carries " +
          "`backlinks` — one line per OTHER note whose text `[[wikilinks]]` to this note's key, resolved live " +
          "at THIS read (never stored, never counted against this note's own byte cap); `[]` is a measured " +
          "zero (nothing links here), not an absent field; past 20 inbound links a trailing line reports " +
          "\"showing 20 of N\" rather than truncating silently. Each note also carries " +
          "`unresolvedOutboundLinks` — every `[[wikilink]]` key THIS note's own text cites that does NOT " +
          "exist in this project's memory store, resolved live at THIS read; `[]` is a measured zero " +
          "(every target resolves, or there are none), not an absent field. Never auto-stripped from " +
          "`text` — a target may be a typo, a note not written yet, or a deliberate reference into a " +
          "different memory system this store has no visibility into. Each note also carries `expired` (" +
          "`expiresAt` set AND already past) — an expired note is NOT deleted, it's still " +
          "returned here in full; `expired:true` just means it's currently excluded from every kickoff " +
          "tier (pinned and related). Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars " +
          "(a per-note write cap bounds one row, but not the ROW COUNT) the notes spill to a scratch file " +
          "instead of inlining, and the response becomes a `{notesFile,notesChars,rowCount,note}` pointer at " +
          "that same NDJSON text — page it with Read or grep it.",
        inputSchema: strictShape({}),
      },
      // card 26134f1a: the per-note 4000-byte write cap bounds ONE row, never the row COUNT — a project
      // with enough notes (this repo's own project memory corpus is a real example) can still overflow
      // the engine's own native tool-result threshold, which spills into the transcript-root-deny tree
      // for the roles that read this tool. Route through the same spill primitive tasks_list already uses.
      async () => {
        const rows = listProjectMemoryEntries(db, projectId);
        const text = rows.map((r) => JSON.stringify(r)).join("\n");
        const spill = spillTextIfLarge(sessionId, "memory-list-spills", "notes", text, SPILL_INLINE_BUDGET_CHARS);
        if (spill.inline) return okLines(rows);
        const note =
          `${rows.length} notes are ${spill.chars} chars — too large to inline safely, so they were ` +
          `written to ${spill.file} as NDJSON (one note per line, real line breaks, UTF-8) — page it ` +
          "with Read (offset/limit are LINE-based) or grep it for a key/tag.";
        return ok({ notesFile: spill.file, notesChars: spill.chars, rowCount: rows.length, note });
      },
    );
    // @decision 57a91801 — expiresAt gates kickoff DELIVERY, not existence (the note still reads back).
    server.registerTool(
      "memory_read",
      {
        description:
          "Read ONE project-scoped memory note in full by key. Carries `requestAnnotations` — one line per " +
          "linked `requestIds` entry, resolved against the requests store's LIVE state at THIS read (never " +
          "frozen at write time): `[linked request <id>: <STATE> as of <date>]`, or a fail-visible " +
          "\"request not found — may be deleted\"/\"not found in this project\" if the id doesn't resolve. " +
          "Also carries `backlinks` — one line per OTHER note whose text `[[wikilinks]]` to THIS note's key, " +
          "resolved live at THIS read (never stored, never counted against this note's own byte cap); `[]` " +
          "is a measured zero (nothing links here), not an absent field; past 20 inbound links a trailing " +
          "line reports \"showing 20 of N\" rather than truncating silently. Also carries " +
          "`unresolvedOutboundLinks` — every `[[wikilink]]` key THIS note's own text cites that does NOT " +
          "exist in this project's memory store, resolved live at THIS read; `[]` is a measured zero " +
          "(every target resolves, or there are none), not an absent field. Never auto-stripped from " +
          "`text` — a target may be a typo, a note not written yet, or a deliberate reference into a " +
          "different memory system this store has no visibility into. Also carries `mentions` — the " +
          "cards (`{kind:\"card\",id}`), `@decision` anchors (`kind:\"decision\"`) and file paths " +
          "(`kind:\"path\"`) THIS note cites that at least one OTHER live note also cites, found live at " +
          "THIS read with no `[[wikilink]]` needed; capped at 10, with `mentionsTruncated:true` when more " +
          "exist than are listed; `[]` is a measured zero. A bare 8-hex id only counts when it matches " +
          "exactly one card on this project. Single-note read only — `memory_list` does not carry it. " +
          "Also carries `expired` (" +
          "`expiresAt` set AND already past) — the note is still returned here in full either " +
          "way; `expired:true` just means it's currently excluded from every kickoff tier.",
        inputSchema: strictShape({ key: z.string() }),
      },
      async ({ key }) => ok(readProjectMemory(db, projectId, key)),
    );
    server.registerTool(
      "memory_history",
      {
        description:
          "Read ONE project-scoped memory note's APPEND-ONLY prior-text history by key — every PAST " +
          "version of its `text`, newest-first. A row exists only for an UPDATE that actually changed " +
          "`text` (a metadata-only patch — title/pinned/tags/etc with `text` omitted or resent " +
          "byte-identical — never writes one, and neither does the key's own first `memory_write`, which " +
          "has no prior text to record). Each row is {id,projectId,key,version,oldText,newText,updatedAt} " +
          "— `version` is the note's `ProjectMemoryEntry.version` that this transition PRODUCED, so " +
          "`oldText` was the note's text as of `version - 1` and `newText` is its text as of `version`. " +
          "An unknown or never-edited key returns `{entries:[]}`, never an error — no history existing yet " +
          "is a normal answer, not a fault. `limit` (optional, default 50, max " + MAX_MEMORY_HISTORY_LIMIT +
          ") bounds how many rows come back from this one read; the STORE itself also keeps only the " +
          "newest 50 rows per key, oldest pruned automatically on every edit. `memory_forget` DELETES " +
          "this key's history too, in the same transaction as the note itself — a forgotten note's past " +
          "text is gone, not just hidden; a later `memory_write` under the same key starts a brand-new " +
          "lineage, it does not resume the deleted one.",
        inputSchema: strictShape({ key: z.string(), limit: z.number().optional() }),
      },
      async ({ key, limit }) => ok(readProjectMemoryHistory(db, projectId, key, limit)),
    );

    // The @decision anchor index (card dbad4b59) — universal, every project session, read-only. See
    // decisions.ts's own module doc for the escape-hatch design constraint. `repoPath` is re-read from
    // `db` on every call (never cached at buildServer time — this router is already stateless per
    // request, so there's no staleness window even without this, but the resolver itself stays honest).
    registerDecisionTools(server, () => db.getProject(projectId)?.repoPath);

    // Self-scheduled wake-ups (universal — every session, any role). Keyed to THIS session id.
    server.registerTool(
      "wake_me",
      {
        description:
          "Provide exactly one of `delaySeconds`/`minutes` or `wakeAt` (ISO). Schedule a one-shot wake-up: end your turn and go idle; you'll be re-prompted with `note` (or its alias `reason`) when it fires (re-submits as a fresh turn; auto-resumed if stopped). `minutes` is sugar for delaySeconds (×60) — if both are given, delaySeconds (the explicit form) wins. Use to WAIT for a known external process/condition — a build, render, deploy — instead of busy-polling. Min 30s, max 24h.",
        inputSchema: strictShape({
          delaySeconds: z.number().optional(),
          minutes: z.number().optional(),
          wakeAt: z.string().optional(),
          note: z.string().optional(),
          reason: z.string().optional(),
        }),
      },
      async ({ delaySeconds, minutes, wakeAt, note, reason }) => {
        // @decision 92c20eb9 — a superseded manager must not schedule a new wake (it fires into a dying
        // predecessor, or is silently dropped once stopped). role==="manager" only — worker/platform-lead
        // recycled-wake semantics are un-analyzed, not confirmed safe.
        if (db.getSession(sessionId)?.role === "manager" && isSupersededByRecycle(db, sessionId)) {
          return ok({ error: retiredCallerMessage(db, sessionId), ...nowEcho() });
        }
        try {
          return ok(withWakeTimeEcho(wakes.schedule(sessionId, { delaySeconds, minutes, wakeAt, note, reason })));
        } catch (e) {
          // Card 6cef30d5: the server-now stamp is what actually mattered on THIS path — the live
          // incident was a wakeAt-in-the-past rejection mislabeled "ISO-Z parsed as local" because
          // nothing in the error let the caller check its wakeAt against the server's real clock.
          return ok({ error: (e as Error).message, ...nowEcho() });
        }
      },
    );
    server.registerTool(
      "wake_cancel",
      { description: "Cancel one of your pending wake-ups by id.", inputSchema: strictShape({ wakeId: z.string() }) },
      async ({ wakeId }) => ok({ ...wakes.cancel(sessionId, wakeId), ...nowEcho() }),
    );
    server.registerTool(
      "wake_list",
      { description: "List your pending wake-ups.", inputSchema: strictShape({}) },
      async () => ok(wakes.list(sessionId).map((w) => ({ ...w, wakeAtLocal: localTimeString(w.wakeAt) }))),
    );

    // Agent-tooling epic P2: the profile-gated authenticated-egress tool. OMITTED from tools/list
    // entirely (not merely denied) when this session has no pinned connections — a session's `connections`
    // allowlist is resolved from the session ROW (pinned at spawn from the Profile, mirrors browserTesting)
    // fresh on every request, since this router is stateless. The default daemon-global permission already
    // whole-server-allows "mcp__loom-tasks" (config.ts), so — UNLIKE browserTesting/documentConversion's
    // separate stdio MCP servers — no `--allowedTools` entry is needed here: conditional registration IS
    // the gate. The handler double-checks the requested connection id against this same pinned list
    // (defense in depth), so a future bug in this gate still can't reach a connection outside the grant.
    // (`session` is resolved above, ahead of tasks_create/tasks_update's own conditional registration.)
    const sessionConnections = session?.connections ?? [];
    if (sessionConnections.length > 0) {
      const guard = resolveConfig(undefined, db.getPlatformConfig()).platform.connections;
      // Grants added to (or revoked from) the AGENT after this session pinned its list — said out loud in the
      // description and on every refusal, so "none resolvable" never reads as a misconfigured binding.
      const driftNote = session ? grantDriftNote(connectionGrantDrift(db, db.getAgent(session.agentId)?.connections, sessionConnections, projectId), sessionId) : "";
      const withDrift = <T extends object>(res: T): T | (T & { grantDrift: string }) =>
        driftNote && (res as { ok?: unknown }).ok === false ? { ...res, grantDrift: driftNote } : res;
      // card 298b826e: the session's own USABLE allowlist — {id,name,host}, never the secret, already
      // scope-filtered by `resolveUsableConnections` (never lists one this session's own project can't
      // reach) — listed IN the description so an agent never has to guess an id or truncate one by hand.
      const usableConnections = resolveUsableConnections(db, sessionConnections, projectId);
      // `name`/`host` are owner/agent-authored (credential provisioning lets either set them) and are
      // NOT restricted to a safe character set — a quote or newline inside either would otherwise break
      // out of this hand-built delimited text and inject arbitrary content into the TOOL DESCRIPTION
      // every agent reads. `JSON.stringify` quotes+escapes each field (including embedded quotes and
      // newlines as `\n`), keeping the whole description one line per connection regardless of content.
      const usableConnectionsText = usableConnections.length > 0
        ? usableConnections.map((c) => `id=${JSON.stringify(c.id)} name=${JSON.stringify(c.name)} host=${JSON.stringify(c.host)}`).join("; ")
        : "none are currently resolvable for this session in this project — ask your owner/manager to check the binding.";
      server.registerTool(
        "authenticated_request",
        {
          description:
            "Perform a credential-injected HTTP request to one of THIS session's allowlisted connections " +
            "(set on your profile by the owner). Loom builds the URL from the connection's fixed host + your " +
            "`path` and injects the auth header server-side — you never see the secret and cannot set an " +
            "Authorization header yourself (rejected if you try). Redirects are NOT followed: a 3xx comes " +
            "back as {status, location} instead of being chased. `method` defaults to GET. `headers` may " +
            "carry NON-auth headers only. `body` may be a string or a JSON-serializable object (a JSON " +
            "object defaults Content-Type: application/json). Bounded by a request timeout and a response-" +
            "size cap; each connection also has a request-rate limit. `connection` may be given as an id, " +
            "or as a NAME when it matches exactly one of this session's usable connections (case-sensitive) " +
            "— an ambiguous or unresolved name is refused and the usable list is named again. This " +
            `session's usable connections: ${usableConnectionsText}` + (driftNote ? ` NOTE: ${driftNote}` : ""),
          inputSchema: strictShape({
            connection: z.string(),
            path: z.string(),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
          }),
        },
        async (args) => ok(withDrift(await performAuthenticatedRequest({ db, fetchImpl: fetchOverride }, sessionConnections, guard, args, projectId))),
      );

      // `ssh_exec`: registered on the SAME session-row `connections` read as above, only when at least one
      // granted connection is a usable `ssh` one — never off the profile or agent row. Host/port/user always
      // come from the connection row. Loom-side filtering is defense-in-depth only.
      const sshConnections = resolveUsableSshConnections(db, sessionConnections, projectId);
      if (sshConnections.length > 0) {
        const sshListText = sshConnections.map((c) => `id=${JSON.stringify(c.id)} name=${JSON.stringify(c.name)} host=${JSON.stringify(c.host)}`).join("; ");
        server.registerTool(
          "ssh_exec",
          {
            description:
              "Run ONE command on a remote host over a pre-configured SSH connection granted to this session. " +
              "Loom connects as the connection's fixed user to its fixed, host-key-pinned address and you never see " +
              "the key; you pass only `connectionId` and `command`. The command is checked before anything is sent: " +
              "shell syntax is refused (no `;` `&` backticks `$()` redirection, globbing, newlines or " +
              "non-ASCII); quoted arguments and `|` pipelines are accepted only on a read-write connection the " +
              "owner enabled them on, and each pipeline stage is checked on its own (find's `{}` must be quoted; a quoted argument that still carries shell syntax, such as `'{}'` or `'^#'`, is held for owner approval). Read-only connections accept " +
              "only a short list of read verbs (this limits which verbs run, not what the server-side user can " +
              "read), an owner allowlist may further restrict commands. A risky command, a shell or interpreter, " +
              "xargs or find -exec is held the same way (a pipe into a shell included). A risky command (reboot, rm, service control, …) is NOT run: " +
              "it is held, the owner is asked to approve that exact text, and you get {ok:false, status:" +
              "\"awaiting-owner-approval\", approvalRequestId}. Once the owner authorizes it, call again with the " +
              "IDENTICAL command; any changed text needs its own approval, and a denied or expired approval refuses. " +
              "Output is size-capped, the call is time-bounded and rate-limited per connection, and every " +
              "call — run or refused — is audited. This Loom-side filtering is defense-in-depth only: the real " +
              "security boundary is the server-side dedicated least-privileged user the owner provisions. " +
              "A refusal returns {ok:false, reason}; a failed connection says whether the host was unreachable or " +
              `rejected the key. This session's ssh connections: ${sshListText}` + (driftNote ? ` NOTE: ${driftNote}` : ""),
            inputSchema: strictShape({ connectionId: z.string(), command: z.string() }),
          },
          async (args) => ok(withDrift(await performSshExec({ db, sessionId, projectId, guard }, sessionConnections, args))),
        );
      }
    }

    // Card be8be211: the profile-gated confined vault-write tool — same shape as authenticated_request
    // immediately above (conditional registration IS the gate; OMITTED from tools/list entirely, not
    // merely denied, when this session's Profile didn't opt in). `projectId` is the SERVER-DERIVED
    // binding this whole router is keyed on (never agent-supplied — see the class doc), so the write can
    // only ever land in THIS session's own project vault; `path` is REQUIRED to be vault-relative and is
    // confined by vault/writer.ts's `resolveInVault` traversal guard (reused verbatim, not reimplemented).
    // Write-only (create/overwrite) — no delete tool is exposed here, matching the profile field's doc.
    if (session?.vaultWrite) {
      const project = db.getProject(projectId);
      if (project) {
        server.registerTool(
          "vault_write",
          {
            description:
              "Write (create or overwrite) a UTF-8 text note under THIS project's vault, then commit it " +
              "through the vault auto-committer. `path` is a vault-RELATIVE path (e.g. \"Design/My Note.md\") " +
              "— confined to the project's vault root; a `..`/absolute-path escape or a backslash is REJECTED. " +
              "Prefer the project's documented vault taxonomy folder for a well-behaved note rather than the " +
              "vault root. Returns { ok:true, committed, committedBlockedReason? } or { ok:false, reason } " +
              "('traversal' on a path escape, 'is-dir', 'hard-link' if the overwrite target is a hard link " +
              "to another file, 'operational-dir' if this project's vault points at Loom's own home " +
              "directory, 'error'). The file write always lands on disk when ok:true; " +
              "committed:false with committedBlockedReason:'code-repo-collision' means this project's vault " +
              "is configured on top of a registered code repo — fix the project's vaultPath/repoPath " +
              "pairing rather than retrying; 'paused' means an advisory auto-commit pause lease is " +
              "currently held — a later tick commits it once the lease lifts, with no further edit " +
              "needed. Either way the write succeeded but was NOT committed. There is no delete — this " +
              "tool only ever creates or overwrites.",
            inputSchema: strictShape({ path: z.string(), content: z.string() }),
          },
          async ({ path: relPath, content }) => {
            if (!project.vaultPath) return ok({ error: "no vault path for this project" });
            return ok(await writeVaultFile(project.vaultPath, relPath, content));
          },
        );
      }
    }

    return server;
  }

  /**
   * HTTP entry for /mcp/:sessionId. `body` is the Fastify-parsed JSON (or undefined). `attributions`
   * (card 8d158088) is gateway/server.ts's ALREADY-COMPUTED sub-agent-call attribution for this exact
   * request (keyed by tool name) — threaded through rather than re-derived here, since
   * `PtyHost.consumeToolAttribution` is destructive/single-shot (see its own doc); optional so every
   * existing test that calls `.handle()` directly with no 5th arg stays byte-identical (fails open, same
   * as an "unknown" attribution).
   */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown, attributions?: Map<string, ToolAttributionResult>): Promise<void> {
    const projectId = this.resolveProject(sessionId);
    if (!projectId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or expired session" }));
      return;
    }

    // Stateless per request: sessionIdGenerator undefined → no session state, no validation, so a
    // transient stream close can't strand the session. (The old per-session cache deleted the
    // transport on onclose, and claude never re-initialized a server it thought died → the
    // loom-tasks "drop".) The same surface is rebuilt every request from the session→project map.
    const server = this.buildServer(projectId, sessionId, attributions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
