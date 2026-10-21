// Per-session persistence for the queue strip's UNFINISHED INPUT and the state needed to get back to
// it — the same shape, and the same reason, as lib/composerDrafts.ts (card 525c8ad9 review round 2).
//
// `QueueEditor` held its in-progress text in plain `useState` with no backing store, so ANY unmount of
// the strip destroyed a half-written queued message. That was survivable while every surface mounting
// it was a long-lived card; the Atlas session node made it reachable, because its Diff tab is a route
// (`/review/:workerId`) and a Terminal→Diff hop therefore unmounts the whole node.
//
// @decision 525c8ad9 — keep all THREE here, never just the text: a restored draft with no restored
// drawer and no restored editing row comes back unreachable, which reads to a user as destroyed.
//
// In-memory only, exactly like composerDrafts: a draft is ephemeral and deliberately does not survive a
// reload. Keyed by session id (and, for the text, the queue entry id) so two sessions — or two entries
// in one queue — can never share a draft.

const drafts = new Map<string, string>();
const editing = new Map<string, string>();
const expanded = new Set<string>();

const draftKey = (sessionId: string, entryId: string) => `${sessionId}\u0000${entryId}`;

export function getQueueDraft(sessionId: string, entryId: string): string | undefined {
  return drafts.get(draftKey(sessionId, entryId));
}

/**
 * An EMPTY string is stored like any other, not treated as a delete. Clearing the box is something the
 * user did on purpose, and collapsing it into "no draft" made a remount re-seed the entry's original
 * text — silently undoing that deliberate clearing. Only `clearQueueDraft` and `pruneQueueDrafts`
 * remove anything.
 */
export function setQueueDraft(sessionId: string, entryId: string, text: string): void {
  drafts.set(draftKey(sessionId, entryId), text);
}

export function clearQueueDraft(sessionId: string, entryId: string): void {
  drafts.delete(draftKey(sessionId, entryId));
}

/**
 * Drop everything this session is holding for entries that are no longer IN its queue, and return
 * whether the open editing row was one of them.
 *
 * Without this the store only ever grows. A queue entry is a transient thing — it drains on the next
 * turn boundary, a Loom nudge is re-minted under a fresh id, another surface deletes it — and none of
 * those paths runs through the editor, so its draft (and possibly the editing id pointing at it) would
 * sit here for the lifetime of the tab. Called with the ids actually present each time a session's
 * queue is read, which is the only moment this module can learn that an entry is gone.
 *
 * `present` is the FULL current list for the session, so an empty array legitimately clears everything.
 */
export function pruneQueueDrafts(sessionId: string, present: readonly string[]): boolean {
  const keep = new Set(present.map((id) => draftKey(sessionId, id)));
  const prefix = `${sessionId}\u0000`;
  for (const key of [...drafts.keys()]) {
    if (key.startsWith(prefix) && !keep.has(key)) drafts.delete(key);
  }
  const open = editing.get(sessionId);
  if (open && !present.includes(open)) {
    editing.delete(sessionId);
    return true;
  }
  return false;
}

/** Which queue entry this session has open in its editor, or null. */
export function getQueueEditing(sessionId: string): string | null {
  return editing.get(sessionId) ?? null;
}

export function setQueueEditing(sessionId: string, entryId: string | null): void {
  if (entryId) editing.set(sessionId, entryId);
  else editing.delete(sessionId);
}

/** Whether this session's manage drawer is open. */
export function isQueueExpanded(sessionId: string): boolean {
  return expanded.has(sessionId);
}

export function setQueueExpanded(sessionId: string, open: boolean): void {
  if (open) expanded.add(sessionId);
  else expanded.delete(sessionId);
}
