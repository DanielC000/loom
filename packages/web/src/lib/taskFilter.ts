import type { Task } from "@loom/shared";

/** The minimal shape the board's free-text search needs — Task satisfies it. */
export type SearchableTask = Pick<Task, "id" | "title" | "body">;

// The board search haystack is id + title + body (case-insensitive substring). The id is included so a
// card is findable by its PRIMARY handle — the thing agents cite and the owner copies from logs — via a
// full id OR any prefix (ids are lowercase hex + dashes, so a prefix substring-matches the full id).
// `query` must already be trimmed + lowercased by the caller (which lowercases once for the whole pass);
// an empty query matches every card, so the search filter is a no-op until the user types.
export function taskMatchesSearch(task: SearchableTask, query: string): boolean {
  if (query === "") return true;
  return `${task.id} ${task.title} ${task.body ?? ""}`.toLowerCase().includes(query);
}
