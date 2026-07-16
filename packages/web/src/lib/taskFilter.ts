import type { Task, BoardTask } from "@loom/shared";

/**
 * The minimal shape the board's free-text search needs — both Task and BoardTask satisfy it. `body` is
 * optional because the board LIST route omits it for a DONE card (card 4fa2c146); such a card's search
 * match falls back to id+title only, same as the pre-existing "no body" case this already handled.
 */
export type SearchableTask = Pick<Task, "id" | "title"> & Pick<BoardTask, "body">;

// The board search haystack is id + title + body (case-insensitive substring) WHEN body is present — a
// DONE card without a loaded body (see SearchableTask above) still matches on id/title. The id is
// included so a card is findable by its PRIMARY handle — the thing agents cite and the owner copies from
// logs — via a full id OR any prefix (ids are lowercase hex + dashes, so a prefix substring-matches the
// full id). `query` must already be trimmed + lowercased by the caller (which lowercases once for the
// whole pass); an empty query matches every card, so the search filter is a no-op until the user types.
export function taskMatchesSearch(task: SearchableTask, query: string): boolean {
  if (query === "") return true;
  return `${task.id} ${task.title} ${task.body ?? ""}`.toLowerCase().includes(query);
}
