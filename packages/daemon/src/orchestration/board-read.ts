import { resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Task } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Card 9c8e256e — the `[loom:idle]` nudge used to carry no indication of what changed on the board since
 * the recipient last looked, forcing a full board re-read on every park cycle. This module snapshots a
 * session's own board state at the moment it genuinely reads the board (tasks_list) and later diffs the
 * live board against that snapshot to produce a delta digest.
 *
 * Stored via the EXISTING generic Db.getMeta/setMeta (app_meta table) — no schema change, so this never
 * touches db.ts. Keyed per-(session, project) — card e9750bc2: a Lead session can genuinely read MULTIPLE
 * projects (list_all_tasks, either the no-filter aggregate or a projectId-narrowed call), so a single
 * per-session key would let a read of project B silently clobber project A's snapshot (and a later delta
 * for A would then diff against B's cards — false "created" for every one of A's real cards). Keying by
 * (session, project) makes each project's anchor independent, so DoD-3's not-computed/measured-zero/
 * real-delta three-way distinction holds PER PROJECT, not just per session. A manager (single-project,
 * unchanged since card 9c8e256e) still gets exactly one key — this is a superset, not a behavior change
 * for that path.
 */
const BOARD_READ_META_PREFIX = "board_read:";
const DELTA_LIST_CAP = 10;

function boardReadMetaKey(sessionId: string, projectId: string): string {
  return `${BOARD_READ_META_PREFIX}${sessionId}:${projectId}`;
}

interface SnapshotCard {
  columnKey: string;
  priority: string;
  title: string;
}

interface BoardReadSnapshot {
  at: string;
  cards: Record<string, SnapshotCard>;
}

function isSnapshot(v: unknown): v is BoardReadSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.at === "string" && !!o.cards && typeof o.cards === "object";
}

/**
 * Every non-terminal (still-live) card on a project's board — id/title/columnKey/priority only. Uses the
 * SAME "non-terminal" definition idle-watcher's own `nonTerminal` filter uses (columnKey !== the
 * role-resolved terminal column). Queried fresh here since {@link recordBoardRead}'s only caller
 * (mcp/server.ts's tasks_list handler) has no precomputed list of its own — unlike
 * {@link computeBoardDelta}, which takes the caller's already-fetched list instead of re-querying.
 */
function currentNonTerminalCards(db: Db, projectId: string): Pick<Task, "id" | "title" | "columnKey" | "priority">[] {
  const project = db.getProject(projectId);
  if (!project) return [];
  const terminalKey = columnKeyForRole(resolveConfig(project.config).kanbanColumns, "terminal");
  return db.listTasks(projectId).filter((t) => t.columnKey !== terminalKey);
}

/**
 * Snapshot the project's CURRENT full non-terminal board state under `sessionId`'s own app_meta key.
 * Call this from every genuine board read (mcp/server.ts's `tasks_list` handler) so the recorded state
 * reflects what the recipient actually saw — INDEPENDENT of that read's own filter/pagination args, so a
 * filtered/paginated tasks_list call still snapshots the WHOLE non-terminal board and a later delta is
 * never computed against a partial view.
 */
export function recordBoardRead(db: Db, sessionId: string, projectId: string, atIso: string): void {
  const cards: Record<string, SnapshotCard> = {};
  for (const t of currentNonTerminalCards(db, projectId)) {
    cards[t.id] = { columnKey: t.columnKey, priority: t.priority, title: t.title };
  }
  const snapshot: BoardReadSnapshot = { at: atIso, cards };
  db.setMeta(boardReadMetaKey(sessionId, projectId), JSON.stringify(snapshot));
}

/**
 * Card e9750bc2 DoD-1 — the platform (`list_all_tasks`) analogue of {@link recordBoardRead} for a
 * cross-project aggregate read: records ONE (session, project) snapshot per project the aggregate
 * actually scanned (`projectIds` — every live project when unfiltered, or the single narrowed project),
 * regardless of how the aggregate's OWN result set is filtered/paginated afterward — same "independent of
 * this call's own filter/pagination args" contract {@link recordBoardRead} already has for a single
 * project, just applied once per project instead of once per call.
 */
export function recordBoardReadForProjects(db: Db, sessionId: string, projectIds: string[], atIso: string): void {
  for (const projectId of projectIds) recordBoardRead(db, sessionId, projectId, atIso);
}

export interface BoardDeltaEntry {
  id: string;
  title: string;
}

export interface BoardDeltaMoveEntry extends BoardDeltaEntry {
  from: string;
  to: string;
}

export type BoardDelta =
  | { computed: false }
  | {
      computed: true;
      at: string;
      createdCount: number;
      created: BoardDeltaEntry[];
      movedCount: number;
      moved: BoardDeltaMoveEntry[];
      reprioritizedCount: number;
      reprioritized: BoardDeltaMoveEntry[];
    };

/**
 * Diff `currentNonTerminal` (the caller's ALREADY-FETCHED live board slice — idle-watcher passes its own
 * `nonTerminal`, so this never re-queries the board) against `sessionId`'s last recorded board-read
 * snapshot FOR `projectId` (card e9750bc2 — snapshots are keyed per (session, project), see the module
 * doc, so a delta for project A is never computed against a snapshot a different project's read left
 * behind). `computed:false` means no snapshot exists for THIS project under this session yet (it has
 * never read this project's board since this feature shipped, or its one recorded snapshot is corrupt) —
 * this MUST render distinctly from a computed-but-empty delta (card 9c8e256e DoD-3); see
 * {@link formatBoardDeltaDigest}.
 *
 * Deliberately does NOT use Task.updatedAt to detect a move/re-prioritization: `Db.updateTask` (db.ts)
 * bumps `updatedAt` on EVERY patch — held/deferred/repoKey/merged* writes included, not just column or
 * priority — so "updatedAt changed" can't tell you WHICH field changed, only that something did. (Only
 * `Task.version` is gated to title/body edits specifically — a different field, see its own doc.)
 * Comparing the actual columnKey/priority VALUES against the snapshot is the only way to know whether a
 * given update was a move, a re-prioritization, both, or neither.
 */
export function computeBoardDelta(
  db: Db,
  sessionId: string,
  projectId: string,
  currentNonTerminal: Pick<Task, "id" | "title" | "columnKey" | "priority">[],
): BoardDelta {
  const raw = db.getMeta(boardReadMetaKey(sessionId, projectId));
  if (!raw) return { computed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { computed: false };
  }
  if (!isSnapshot(parsed)) return { computed: false };
  const snapshot = parsed;

  const created: BoardDeltaEntry[] = [];
  const moved: BoardDeltaMoveEntry[] = [];
  const reprioritized: BoardDeltaMoveEntry[] = [];
  for (const t of currentNonTerminal) {
    const prior = snapshot.cards[t.id];
    if (!prior) {
      created.push({ id: t.id, title: t.title });
      continue;
    }
    if (prior.columnKey !== t.columnKey) moved.push({ id: t.id, title: t.title, from: prior.columnKey, to: t.columnKey });
    if (prior.priority !== t.priority) reprioritized.push({ id: t.id, title: t.title, from: prior.priority, to: t.priority });
  }
  return {
    computed: true,
    at: snapshot.at,
    createdCount: created.length,
    created: created.slice(0, DELTA_LIST_CAP),
    movedCount: moved.length,
    moved: moved.slice(0, DELTA_LIST_CAP),
    reprioritizedCount: reprioritized.length,
    reprioritized: reprioritized.slice(0, DELTA_LIST_CAP),
  };
}

function fmtEntries(entries: { id: string }[], totalCount: number): string {
  const ids = entries.map((e) => e.id.slice(0, 8)).join(", ");
  return totalCount > entries.length ? `${ids}, +${totalCount - entries.length} more` : ids;
}

/**
 * Render a {@link BoardDelta} as nudge text. THREE distinguishable shapes (card 9c8e256e DoD-3):
 *  - not-computed — no anchor exists; NEVER rendered in a way that could be mistaken for a measured zero.
 *  - computed-and-empty — a genuine "0 changes", stated as a measured fact; costs the reader zero further
 *    calls.
 *  - computed-and-nonempty — per-kind counts + capped id lists.
 */
export function formatBoardDeltaDigest(delta: BoardDelta): string {
  if (!delta.computed) {
    return "[loom:board-delta] not computed — no prior board read recorded for this session yet.";
  }
  const total = delta.createdCount + delta.movedCount + delta.reprioritizedCount;
  if (total === 0) {
    return `[loom:board-delta] 0 changes since your last board read (${delta.at}) — nothing new to re-check.`;
  }
  const parts: string[] = [];
  if (delta.createdCount > 0) parts.push(`${delta.createdCount} created (${fmtEntries(delta.created, delta.createdCount)})`);
  if (delta.movedCount > 0) parts.push(`${delta.movedCount} moved (${fmtEntries(delta.moved, delta.movedCount)})`);
  if (delta.reprioritizedCount > 0) {
    parts.push(`${delta.reprioritizedCount} re-prioritised (${fmtEntries(delta.reprioritized, delta.reprioritizedCount)})`);
  }
  return `[loom:board-delta] since your last board read (${delta.at}): ${parts.join("; ")}.`;
}
