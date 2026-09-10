import { resolveConfig, columnKeyForRole } from "@loom/shared";
import type { Task } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * @decision 9c8e256e — board state is snapshotted per (session, project), not per session: a single
 * per-session key would let a read of one project silently clobber another's snapshot, producing false
 * "created" entries. See card e9750bc2 for the Lead's per-project recording side of this.
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
 * snapshot for `projectId`. See {@link formatBoardDeltaDigest}.
 *
 * @decision 9c8e256e — do NOT use `Task.updatedAt` to detect a move/re-prioritization (it bumps on
 * any patch, not just column/priority, so it can't tell you WHICH field changed) — compare the
 * actual columnKey/priority VALUES instead.
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
