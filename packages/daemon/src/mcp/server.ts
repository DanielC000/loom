import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { WakeService } from "../orchestration/wake.js";
import {
  listProjectTasks, getProjectTask, createProjectTaskChecked, updateProjectTask, DEFAULT_TASK_SUMMARY_CAP,
  listProjectTaskRequests, getProjectTaskRequest, deferTaskItem, updateDeferredItemStatus, countProjectTasks,
} from "./tasks.js";
import { writeProjectMemory, forgetProjectMemory, listProjectMemoryEntries, readProjectMemory } from "./memory.js";
import { performAuthenticatedRequest } from "../connections/request.js";
import { writeVaultFile } from "../vault/writer.js";
import { isConfirmedSubagent, type ToolAttributionResult } from "../pty/tool-attribution.js";
import { resolveAlias, strictShape } from "./arg-alias.js";
import { withWakeTimeEcho, nowEcho, localTimeString } from "../orchestration/time-echo.js";
import { spillTextIfLarge, SPILL_INLINE_BUDGET_CHARS } from "../spill.js";
import { recordBoardRead } from "../orchestration/board-read.js";

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
 * `page` (card 84f6ac42) is the completeness signal: pass `{total, offset, nextOffset, explicit}` (total
 * = the TRUE matching-row count before this page's slice; nextOffset = offset+returned while more
 * remains, else null; explicit = true iff the caller passed offset/limit itself) to opt a caller into the
 * envelope. Mirrors `list_all_tasks`' own page envelope (card 57cb355d) field-for-field, and the SAME
 * "bare when it fits and wasn't explicitly paged, else envelope" contract `spillableTurnsResponse` (the
 * transcript-reading sibling) already uses — so a capped/partial read is NEVER indistinguishable from a
 * complete one. Omitting `page` (as `task_requests_list` still does below) preserves today's behavior
 * byte-for-byte — this is an ADDITIVE opt-in, not a behavior change for every caller of this helper.
 */
const okLinesSpillable = (
  sessionId: string, subdir: string, key: string, rows: unknown[],
  page?: { total: number; offset: number; nextOffset: number | null; explicit: boolean },
) => {
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

  resolveProject(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  private buildServer(projectId: string, sessionId: string, attributions?: Map<string, ToolAttributionResult>): McpServer {
    const db = this.db;
    const wakes = this.wakes;
    const fetchOverride = this.fetchOverride;
    const server = new McpServer({ name: "loom-tasks", version: "0.1.0" });
    // `session` is resolved HERE (not further down, where it used to be computed only for the
    // authenticated_request/vault_write gates) so tasks_create/tasks_update below can also condition on
    // it — SAME conditional-registration pattern as those two tools (an omitted tool never reaches
    // tools/list, not a runtime denial).
    const session = db.getSession(sessionId);

    server.registerTool(
      "tasks_list",
      {
        description:
          "List this project's board tasks. Returns NEWLINE-DELIMITED JSON — one task object per line, NOT a JSON array — so a wide read stays Read/grep-pageable even if it spills to a file. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the rows are written to a scratch file instead of inlining, and the response becomes a `{rowsFile,rowsChars,rowCount,note}` pointer at that same NDJSON text (one task per line) — page it with Read or grep it; re-call with a narrower filter/limit to inline instead. DEFAULT: a lightweight SUMMARY ({id,title,columnKey,position,priority,updatedAt,merged,repoKey,deferred,deferredUntilTaskId,deferredStuck,deferredAt,deferredReason}) — bodies OMITTED, terminal/done cards EXCLUDED. Pass includeBody:true for full bodies, or tasks_get(id) for one card. deferredUntilTaskId (when set) names the task this card is auto-cleared behind — deferred flips to false here the moment that task's merged state resolves non-null, no separate check needed. `deferredReason` is the reason required on a manual deferral (deferred:true with no deferredUntilTaskId) — null on an auto-deferral or when not deferred. `deferredAt` is the server-stamped instant the current deferral started — null when not deferred. `deferredStuck` (only meaningful while deferred:true) is `true` when that release condition can no longer be shown to resolve — the named blocker is deleted, or it's already sitting in the terminal (done) column with no proven merge (e.g. it closed with zero commits, a legitimate outcome that never produces a squash commit) — a fail-toward-VISIBLE signal, not proof the blocker will never ship (a real merge outside the scan window reads the same way); a stuck card is worth a manual look rather than trusting it'll resolve on its own. `merged` is this card's git-derived ship state — {sha,date,verification?} of its squash-merge commit on this project's repo if one is found, else null; null means NOT PROVEN merged (never merged, landed outside the scan window, or a git read failure), not an authoritative 'never merged' — treat a predecessor's 'unbuilt'/'won't-do' claim as suspect if merged is non-null. `verification` names WHICH check answered it: \"content\" (byte-verified against a still-live branch tip — the strongest), \"pathset\" (verified from the landed commit's own ancestry against a persisted path-set trailer — proves the same FILES landed, not the same content), or \"trailer-only\" (pre-fix history — trailer PRESENCE alone, the weakest). Absent means unknown, not unverified. Filters: columns:[...] (only those column keys), excludeDone:false (include done), minPriority:p0|p1|p2|p3 (only tasks at or above it; lower number = higher priority), idPrefix (only ids starting with this), titleContains (case-insensitive title substring) — prefer a scoped filter over paging a huge window. Capped at " + DEFAULT_TASK_SUMMARY_CAP + " rows by default (the DEFAULT limit when you pass none) — page with limit/offset. COMPLETENESS SIGNAL (card 84f6ac42): with NO offset/limit passed and the whole matching set fits in one page, returns the bare NDJSON rows exactly as before (today's shape, unchanged) — otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope alongside the rows instead: {rows,total,returned,offset,nextOffset} inline, or {rowsFile,rowsChars,rowCount,note,total,returned,offset,nextOffset} when the rows themselves spilled to a file. `total` is the TRUE matching-row count before this call's offset/limit slice; `nextOffset` is offset+returned while more remains, else null. Page deterministically by calling again with offset:nextOffset until it is null (mirrors list_all_tasks' own page envelope) — a capped read is thus self-evidently partial; a `rowCount`/`returned` equal to your `limit` never by itself means \"that's everything\" unless `nextOffset` is null. Pass countsOnly:true to answer \"how many cards, by column/priority\" WITHOUT fetching any row bodies — returns {total, byColumn, byPriority} (a few hundred bytes) instead of the filtered row set; the same column/priority/id/title filters above still apply, limit/offset/includeBody are ignored in this mode.",
        inputSchema: strictShape({
          columns: z.array(z.string()).optional(),
          excludeDone: z.boolean().optional(),
          includeBody: z.boolean().optional(),
          minPriority: prioritySchema.optional(),
          idPrefix: z.string().optional(),
          titleContains: z.string().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          countsOnly: z.boolean().optional(),
        }),
      },
      // Backstop the read with a default cap (caller-applied, the agentView/sessionView pattern) so an
      // includeBody read on a board with hundreds of cards can't overflow the tool-result cap. The spill
      // key is derived from the EFFECTIVE (post-default) args (taskListSpillKey) — a repeat pull under the
      // SAME filter combo overwrites the same scratch file, but two DIFFERENT filter combos never collide.
      async (args) => {
        // countsOnly short-circuits BEFORE the row fetch/spill machinery below — a caller asking "how many"
        // never pays for row bodies or the merged-state git enrichment (card 9798200c).
        if (args.countsOnly) return ok(countProjectTasks(db, projectId, args));
        const effective = { ...args, limit: args.limit ?? DEFAULT_TASK_SUMMARY_CAP };
        const rows = await listProjectTasks(db, projectId, effective);
        // Card 84f6ac42: the completeness signal. `total` is the TRUE filtered-row count BEFORE this
        // call's offset/limit slice — computed via the cheap countProjectTasks (same filters, no
        // merged-state git enrichment, no body) rather than re-deriving it from `rows.length` (which is
        // already post-slice and can never tell "exactly at the cap" apart from "more remains").
        const total = countProjectTasks(db, projectId, effective).total;
        const off = effective.offset ?? 0;
        const nextOffset = off + rows.length < total ? off + rows.length : null;
        const explicit = args.offset !== undefined || args.limit !== undefined;
        const result = okLinesSpillable(sessionId, "tasks-list-spills", taskListSpillKey(effective), rows, { total, offset: off, nextOffset, explicit });
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
    server.registerTool(
      "tasks_get",
      {
        description: "Read ONE full task (title + body) by id; project-scoped. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool uses) — pass either one (if both, id wins). An optional `projectId` is tolerated but ignored — this tool is already scoped to the caller's own project. Also returns `deferredStuck` (only meaningful while deferred:true) — see tasks_list's own description for the full contract; it's the same field. Also returns a `requests` summary ({total, answered, pending, cancelled, items:[{id,type,title,state}]}) of any Requests connected to this task (soft-linked via taskId at question_ask time) — a task you're working may already carry a prior owner decision you'd otherwise miss; read one in full via task_request_get, or list them all via task_requests_list. Also returns this card's OWN outbound `deferredItems` ([{id,text,toTaskId,status,createdAt,updatedAt}], card 0d4bc3f0) — sub-items THIS card's DoD deferred onto other cards via `tasks_defer_item` — AND `incomingDeferredItems` ({total,open,acknowledged,declined,items:[{itemId,text,status,fromTaskId,fromTaskTitle,createdAt,updatedAt}]}), the INBOUND view: every item ANY other card on this board has deferred onto THIS one, regardless of that donor card's own state. Read `incomingDeferredItems.open` before assuming a card with no obvious open work is actually idle — a hand-off nobody has acknowledged shows up here even if the donor card has already closed. Flip an item's status with `tasks_defer_item_ack`. Also returns `merged` — this card's git-derived ship state ({sha,date,verification?} of its squash-merge commit on this project's repo, else null). null means NOT PROVEN merged, never an authoritative 'never merged' — don't trust a stale handoff claiming this card is unbuilt without checking this first. `verification` names WHICH check answered it: \"content\" (byte-verified against a still-live branch tip — the strongest), \"pathset\" (verified from the landed commit's own ancestry against a persisted path-set trailer — proves the same FILES landed, not the same content), or \"trailer-only\" (pre-fix history — trailer PRESENCE alone, the weakest). Absent means unknown, not unverified.",
        inputSchema: strictShape({ id: z.string().optional(), taskId: z.string().optional(), projectId: z.string().optional() }),
      },
      async ({ id, taskId }) => {
        const resolvedId = id ?? taskId;
        if (!resolvedId) return ok({ error: "id (or taskId) is required" });
        return ok(await getProjectTask(db, projectId, resolvedId));
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
          "\"decision\"/\"input\", `approved`+`note`+`scope`+`expiresAt`+`lapsed` for \"permission\" (all " +
          "null/false until answered) — `scope`/`expiresAt` are the human's ACTUAL decided grant (distinct " +
          "from the ask-time REQUESTED scope/expiry), and `lapsed` is a read-time-derived flag, true only " +
          "once `expiresAt` is set AND in the past. ADVISORY ONLY — Loom persists + surfaces this grant but " +
          "never itself enforces, blocks, or revokes it; a recycled successor should re-read this rather " +
          "than trust a predecessor's belief about a prior 'standing' grant. `ack` " +
          "ONLY (never the secret) for \"credential\" (null until provided). NON-CONSUMING: unlike " +
          "question_pull, reading this never flips the request's state — re-readable across turns/agents. " +
          "`id` is the request id (from tasks_get's `requests.items`/task_requests_list). Optional `taskId` " +
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
    // check at all — for the Companion that silently meant "your own bound board", which is exactly the
    // silent-wrong-board footgun this omission closes (a Companion asked to file to a NAMED project would
    // reach for this tool and misfile to its home board instead). Every other role is unaffected — this is
    // conditional TOOL REGISTRATION (an omitted tool never reaches tools/list), the same pattern already
    // used by authenticated_request/vault_write below.
    //
    // `session?.role !== "assistant"` reads fail-open on a null session (an unknown/expired sessionId
    // would take the TRUE branch and register the tools) — that's fine because it's UNREACHABLE, not
    // merely unlikely: `buildServer` is private with exactly ONE caller, `handle()` below, which resolves
    // `resolveProject(sessionId)` FIRST and returns a synchronous 404 ("unknown or expired session")
    // before ever calling `buildServer` — no `await` in between, so there's no TOCTOU window either. A
    // null `session` here can only mean the id resolved to a project moments ago but the session row is
    // now gone, which cannot happen within one synchronous request.
    if (session?.role !== "assistant") {
      server.registerTool(
        "tasks_create",
        {
          description: "Create a task on this project's board. priority p0|p1|p2|p3 (low number = higher priority), default p2. Optional repoKey (multi-repo epic) targets one of this project's registered `repos` — omit (or pass \"primary\") for the project's primary repo; an unknown key is rejected with {error}. CROSS-CHANNEL DUPLICATE CHECK (card 5b221bf2): if this card's title+body shares rare identifiers (a session id, a branch, a named error constant, a file:line, a code symbol — NOT prose/title similarity) with an existing card on this board, the create is REFUSED with {error} naming the suspected counterpart — never a silent drop or auto-merge. Pass allowDuplicate:true to create anyway, or supersedes/relatedTo:\"<taskId>\" (full id or unambiguous prefix) to both bypass the refusal AND note the relationship on the new card's body.",
          inputSchema: strictShape({
            title: z.string(), body: z.string().optional(), columnKey: z.string().optional(), priority: prioritySchema.optional(), repoKey: z.string().nullable().optional(),
            allowDuplicate: z.boolean().optional(), supersedes: z.string().optional(), relatedTo: z.string().optional(),
          }),
        },
        async ({ allowDuplicate, supersedes, relatedTo, ...args }) => ok(createProjectTaskChecked(db, projectId, args, { allowDuplicate, supersedes, relatedTo })),
      );
      server.registerTool(
        "tasks_update",
        {
          description: "Update a task by id; project-scoped. PATCH-style: pass only the field(s) you're changing. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool — tasks_get/task_requests_list/task_request_get — uses) — pass either one (if both, id wins). priority p0|p1|p2|p3 (low number = higher priority). held=true marks an owner-gated card the idle watchdog won't nag about — you MAY set this yourself. held=false CLEARS it, but only if held wasn't set by the owner: clearing an owner-set hold is REFUSED here (returns {error}, nothing written) — only the owner can release their own hold, via the board UI. deferred=true is YOUR OWN sequencing/dependency-gating marker — also discounted from the idle watchdog's actionable count, but (unlike held) never blocks worker_spawn. Optional deferredUntilTaskId (\"deferred until THIS task merges\") pairs with deferred:true for a blocker that's a queryable card ON THIS BOARD (full id or unambiguous prefix, normalized to the full id) — the daemon then auto-clears deferred the next time this card is read, once that blocker's `merged` state resolves non-null; pass null to clear the pairing. If the blocker instead closes with NO squash commit (a legitimate 0-commit outcome) or is deleted, deferred deliberately does NOT auto-clear (that would silently redefine \"until it merges\" as \"until it's closed\") — instead the read-time `deferredStuck` flag (tasks_list/tasks_get) flips true and the card stops being discounted from the idle watchdog's actionable count, so an unreachable deferral surfaces instead of sitting invisibly forever. Rejects a self-reference or an id that doesn't resolve on this board (whole patch rejected, nothing written). Leave deferredUntilTaskId unset for a deferral gated on an owner decision or an external/upstream dependency — those must stay manually managed, never auto-cleared — but a MANUAL deferral like that (deferred:true with no deferredUntilTaskId) REQUIRES `deferredReason` (a short string: why it's parked and what would release it) — the write is REFUSED (whole patch rejected, nothing written) if the resulting state would be manually-deferred with no reason recorded either before or after this patch, so a card can never again go byte-identical-to-forgotten (card c90e9525). The daemon also stamps a read-only `deferredAt` (the instant this manual deferral last started — never caller-settable) the first time a reason lands on it; both `deferredAt` and `deferredReason` reset to null on an explicit `deferred:false` clear — and the SAME reset happens on the deferredUntilTaskId auto-release above. Card 1d27c3cd: before either reset, if a reason was recorded it's folded into the card's `body` as its own \"**Previously deferred:**\" paragraph (idempotently replacing any earlier such paragraph, so repeated defer/release cycles never pile up more than the latest one) — so the reasoning survives even though the field itself is cleared; re-read via tasks_get/tasks_list to see it. A route-(a) deferral (deferredUntilTaskId set) needs no reason — its release condition is the named blocker task itself. repoKey (multi-repo epic) re-targets the card to a different entry in this project's `repos` registry, or null/\"primary\" to reset it to the project's primary repo — an unknown key is REFUSED (whole patch rejected, nothing written), same convention as an unknown columnKey. A column/priority/deferred/held/repoKey/deferredUntilTaskId/deferredReason-only move needs ONLY id + those fields — no body — and returns a TRIMMED ack ({id,title,columnKey,priority,position,held,deferred,heldBy,repoKey,deferredUntilTaskId,deferredAt,deferredReason,updatedAt,version,changed}, no body) instead of echoing the full card back — deferredStuck is read-derived only (not part of this ack); re-read via tasks_get/tasks_list for its current value. Pass body when you're intentionally editing it — that returns the full updated task, body included. ⚠️ `body` is a FULL REPLACE, not a merge or append — whatever string you pass BECOMES the entire body, with NO undo; if you only mean to change part of it, read the current body first (tasks_get) and pass back the whole thing with your edit folded in. DESTRUCTIVE-TRUNCATION GUARD (card 09d68835): a `body` write that would discard the large majority of an existing SUBSTANTIAL body (≥1024 characters, keeping <25% of it) is REFUSED — {error naming the current/proposed lengths, truncation:true, current (the task as it stands right now), currentLength, proposedLength} — instead of silently overwriting (the specimen that motivated this: a one-sentence annotation accidentally replaced a ~13,300-character card). A short body, or a rewrite that stays a comparable size, is never touched by this. If a large discard is genuinely intentional, pass allowTruncate:true to bypass it.\n\n`appendBody` (card e2756e47) is the ADDITIVE alternative to `body`: appends a timestamped \"## Triage note — <ts>\" section instead of replacing the whole thing — use this for a note, decision, or status update on a card whose body already carries something worth keeping (e.g. a worker's report or another agent's analysis), so your note can never clobber it the way a `body` write would. Passing both `body` and `appendBody` is REJECTED (whole patch, nothing written) — they're different intents. `appendBody` needs NO `baseVersion` (unlike `body`): an append can't destructively clobber a concurrent edit the way a full replace can, so there's nothing to gate — worst case under a race is two sections landing in a nondeterministic order, never lost content. The destructive-truncation guard above still applies to the resulting write (it can never fire on a correct append, but stays as a backstop against a buggy one). Returns the full updated task, same as a `body` write.\n\nOPTIMISTIC CONCURRENCY (card d0978321): writing `title` and/or `body` on an EXISTING task REQUIRES `baseVersion` — the `version` you last read for this task (from tasks_get/tasks_list/a prior tasks_update response). A stale-or-omitted `baseVersion` on a title/body write is REJECTED with {error, conflict:true, current} (the task as it stands right now) instead of overwriting — re-read it and retry, merging your change into the current body (mirrors memory_write exactly). A column/priority/held/deferred/position/repoKey/deferredUntilTaskId/deferredReason-only patch needs NO baseVersion at all — those never touch prose and are never gated. `version` ADVANCES ONLY when title/body actually change — a field-only move leaves it unchanged, so an unchanged version does NOT mean the card is unchanged in every sense, only that its title/body haven't.",
          inputSchema: strictShape({
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
            deferredUntilTaskId: z.string().nullable().optional(),
            deferredReason: z.string().nullable().optional(),
            repoKey: z.string().nullable().optional(),
            baseVersion: z.number().optional(),
            allowTruncate: z.boolean().optional(),
          }),
        },
        async ({ id, taskId, baseVersion, allowTruncate, appendBody, ...patch }) => {
          const resolvedId = resolveAlias(id, taskId);
          if (resolvedId === undefined) return ok({ error: "id (or taskId) is required" });
          // role threaded for the repoKey authority guard (code-review ruling): a worker on this SAME
          // router can reach tasks_update, but must not be able to set repoKey (a dispatch decision) —
          // see updateProjectTask's own doc.
          return ok(await updateProjectTask(db, projectId, resolvedId, patch, { sessionId, role: session?.role }, baseVersion, allowTruncate, appendBody));
        },
      );
      server.registerTool(
        "tasks_defer_item",
        {
          description:
            "Card 0d4bc3f0 (board-hygiene): defer a DoD sub-item from THIS task onto ANOTHER task on the " +
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
      server.registerTool(
        "tasks_defer_item_ack",
        {
          description:
            "Card 0d4bc3f0: flip ONE deferred item's status — acknowledge it landed in the recipient's " +
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
    server.registerTool(
      "memory_write",
      {
        description:
          "Write (or UPDATE) a project-scoped note into this project's SHARED memory — durable knowledge " +
          "every worker/manager sees at kickoff, across sessions. `key` is a short stable slug (letters/" +
          "digits/-/_ only) that identifies this note: writing the SAME key again UPDATES it in place " +
          "(no duplicate accumulation) — prefer refining an existing key over minting a near-duplicate. " +
          "`text` is the note body. `pinned:true` marks it especially important — pinned notes are " +
          "injected IN FULL on EVERY kickoff and are never auto-evicted; leave it false/omitted for a note " +
          "that should surface only when it's RELEVANT (matched by full-text search against the kickoff/" +
          "task text). Pinned notes are delivered newest-updated first when the digest budget can't fit " +
          "them all, so an old, untouched-but-critical pinned note can still be dropped — tag it " +
          "`\"never-drop\"` (via `tags`) to pack it ahead of every other pinned note; a dropped never-drop " +
          "note is reported as a distinct ALARM (not routine overflow) so a broken guarantee is never " +
          "silent, but it can still fail to fit if it alone exceeds the whole budget. NOTE: `\"never-drop\"` " +
          "only does anything on a note that is ALSO `pinned:true` — set on an unpinned note it's inert " +
          "(never packed into the floor tier), and this response says so. Setting/keeping `\"never-drop\"` " +
          "on a pinned note returns a `neverDropStatus` on this response reporting that whole floor tier's " +
          "current size against the project's read-side digest budget (`memory.budgetTokens`) — purely " +
          "informational, it never blocks this write; use it to judge whether the tier is getting too big " +
          "to keep guaranteeing delivery. Optional `title` " +
          "(short label, max 200 chars) and `tags` (string[]). `title` (or, if omitted, `key`) is rendered " +
          "into every delivered note's digest header as `### {title} ({key})` — both `title` and `key` are " +
          "on-budget, consuming `memory.budgetTokens` on every kickoff exactly like `text` does, so a long " +
          "descriptive title is NOT a free way to say more; keep it short. Write " +
          "declarative facts/decisions worth remembering across sessions, not throwaway task chatter — " +
          "`text` ALONE is capped at 4000 bytes (a short, curated note, not a dumping ground; the header's " +
          "own bytes are separate and uncapped here); a too-long write " +
          "is rejected with `bytesOver` + the current note (if any) so you can trim without re-fetching. " +
          "A note that is (effectively, after this write) `pinned:true` AND tagged `\"never-drop\"` — i.e. " +
          "actually IN the floor tier — is held to a LOWER, SEPARATE cap of 2000 bytes instead, and this " +
          "one BLOCKS (it is not the `neverDropStatus` advisory above): that tier rides on EVERY future " +
          "kickoff regardless of relevance, so its cost is fixed overhead for every session on the " +
          "project, not just this note's own author. Rejected the same way as the general cap " +
          "(`bytesOver` + `current`). Fires on ANY write that leaves the note pinned+never-drop and over " +
          "2000 bytes — including an update that only changes `title`/`tags` on an already-oversized floor " +
          "note, since `text` must be resupplied on every write; there is no grandfather clause. For dense " +
          "safety/operational prose, PREFER splitting the overflow into a separate cross-linked key over " +
          "trimming (trimming risks silently dropping a load-bearing clause) — the rejection names this. " +
          "Unpinning the note, or dropping the `\"never-drop\"` tag, also exempts it and falls back to the " +
          "general 4000-byte cap, at the cost of the note becoming evictable. " +
          "UPDATING AN EXISTING KEY IS A TRUE PATCH: `title`/`pinned`/`tags` you OMIT are left UNCHANGED " +
          "from the stored note, never reset to a default — pass only `key`+`text`+`baseVersion` to edit " +
          "the body alone. To deliberately CLEAR a field, pass it explicitly (`pinned:false` unpins, " +
          "`tags:[]` empties the tag list) — that still takes effect; only OMITTING the field preserves it. " +
          "The response echoes the resulting `pinned`/`tags`/`title` so you can see the outcome. " +
          "UPDATING A NOTE THAT ALREADY EXISTS REQUIRES `baseVersion` — the `version` you last read for " +
          "this key (from memory_read, memory_list, or a prior memory_write's response; NOT its `updatedAt` " +
          "timestamp). Omitting it, or passing a stale one, is REJECTED with `conflict:true` and `current` " +
          "(the note as it stands right now) instead of silently overwriting someone else's write — re-read, " +
          "merge your change into `current.text`, and retry with `baseVersion: current.version`. A brand-new " +
          "key needs no base, and omitted `title`/`pinned`/`tags` default to \"\"/false/[] on create. " +
          "Optional `requestIds`: EXPLICITLY link this note to one or more Request ids (from `question_ask`) " +
          "instead of writing their state into `text` yourself — every future read (kickoff injection, " +
          "memory_read, memory_list) re-resolves each linked id's LIVE state and appends " +
          "`[linked request <id>: <STATE> as of <date>]`, so a note written while a request is PENDING " +
          "self-corrects the moment the owner answers it instead of saying PENDING forever. Omitting " +
          "`requestIds` on an update preserves the existing links (same PATCH semantics as `tags`); pass " +
          "`[]` explicitly to clear them. " +
          "Card 8d158088: REFUSED with {error} if this specific call is CONFIRMED to have originated from " +
          "a sub-agent (a Task/Agent sub-call), rather than your own top-level turn — project memory is " +
          "shared, durable knowledge meant to reflect the calling agent's own reasoning; call this " +
          "directly, not through a delegated sub-agent. An UNCERTAIN attribution never refuses (fail-open) " +
          "— only a positively-confirmed sub-agent call is rejected.",
        inputSchema: strictShape({
          key: z.string(),
          text: z.string(),
          title: z.string().optional(),
          pinned: z.boolean().optional(),
          tags: z.array(z.string()).optional(),
          requestIds: z.array(z.string()).optional(),
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
    server.registerTool(
      "memory_forget",
      { description: "Delete a project-scoped memory note by key. Idempotent — deleting a missing key returns {ok:true,deleted:false}, never an error.", inputSchema: strictShape({ key: z.string() }) },
      async ({ key }) => ok(forgetProjectMemory(db, projectId, key)),
    );
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
          "\"showing 20 of N\" rather than truncating silently.",
        inputSchema: strictShape({}),
      },
      async () => okLines(listProjectMemoryEntries(db, projectId)),
    );
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
          "line reports \"showing 20 of N\" rather than truncating silently.",
        inputSchema: strictShape({ key: z.string() }),
      },
      async ({ key }) => ok(readProjectMemory(db, projectId, key)),
    );

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
            "size cap; each connection also has a request-rate limit.",
          inputSchema: strictShape({
            connection: z.string(),
            path: z.string(),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
          }),
        },
        async (args) => ok(await performAuthenticatedRequest({ db, fetchImpl: fetchOverride }, sessionConnections, guard, args, projectId)),
      );
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
              "vault root. Returns { ok:true, committed } or { ok:false, reason } ('traversal' on a path " +
              "escape, 'is-dir', 'error'). There is no delete — this tool only ever creates or overwrites.",
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
