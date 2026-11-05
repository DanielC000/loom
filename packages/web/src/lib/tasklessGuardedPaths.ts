// Taskless guarded paths in Settings (card 7e15ff89, follow-up to a880c391): the pure half behind the editor in
// components/tasklessGuardedPaths.tsx. The daemon owns the semantics and the enforcement; this only turns the
// textarea into the list the human config PATCH stores, and checks it with the SAME shared parser the daemon's
// validator runs (`parseTasklessGuardedPaths`), so the editor refuses exactly what the PATCH would and nothing more.
import { TASKLESS_GUARDED_PATHS_LIMITS, parseTasklessGuardedPaths } from "@loom/shared";

export { TASKLESS_GUARDED_PATHS_LIMITS };

/** The config path this editor writes and, for an empty list, unsets. */
export const TASKLESS_GUARDED_PATHS_KEY = "orchestration.tasklessGuardedPaths";

export type GuardedPathsDraft = { ok: true; paths: string[] } | { ok: false; error: string };

/**
 * Textarea → list: one glob per line, each trimmed, blank lines dropped, order kept, nothing deduplicated (the daemon
 * stores duplicates as-is). Then the shared parser decides; its `[i]` index is translated back to the line the human
 * typed, so the message points at the right line even when blank lines were dropped above it.
 */
function draftRows(text: string): Array<{ line: number; glob: string }> {
  return text.split(/\r?\n/).map((raw, i) => ({ line: i + 1, glob: raw.trim() })).filter((r) => r.glob !== "");
}

/** The trimmed, non-blank lines, valid or not (what the dirty check compares). */
export function draftLines(text: string): string[] {
  return draftRows(text).map((r) => r.glob);
}

/** Textarea → validated list (see the comment above `draftRows`). */
export function guardedPathsFromText(text: string): GuardedPathsDraft {
  const rows = draftRows(text);
  const paths = rows.map((r) => r.glob);
  const parsed = parseTasklessGuardedPaths(paths);
  if (parsed.ok) return { ok: true, paths: parsed.paths };
  const m = /^tasklessGuardedPaths\[(\d+)\] (.*)$/.exec(parsed.error);
  if (m) {
    const row = rows[Number(m[1])];
    if (row) return { ok: false, error: `Line ${row.line}: ${m[2]}` };
  }
  if (paths.length > TASKLESS_GUARDED_PATHS_LIMITS.maxEntries) {
    return { ok: false, error: `${paths.length} paths; the limit is ${TASKLESS_GUARDED_PATHS_LIMITS.maxEntries}` };
  }
  return { ok: false, error: parsed.error };
}

/** Stored override → textarea seed. A corrupt stored value seeds an empty draft and reports why. */
export function guardedPathsSeed(stored: unknown): { text: string; error: string | null } {
  const parsed = parseTasklessGuardedPaths(stored);
  return parsed.ok ? { text: parsed.paths.join("\n"), error: null } : { text: "", error: parsed.error };
}

/** Comparable form of a draft or a stored list (what the dirty check diffs). */
export function guardedPathsSignature(paths: readonly string[]): string {
  return JSON.stringify(paths);
}

/** The config PATCH arguments: a non-empty list is written whole, an empty one unsets the key (no guard). */
export function guardedPathsConfigWrite(paths: readonly string[]):
  { override: { orchestration: { tasklessGuardedPaths: string[] } }; unset: undefined } | { override: Record<string, never>; unset: string[] } {
  return paths.length > 0
    ? { override: { orchestration: { tasklessGuardedPaths: [...paths] } }, unset: undefined }
    : { override: {}, unset: [TASKLESS_GUARDED_PATHS_KEY] };
}
