// Per-session Composer draft persistence. The Composer holds its "send a turn" text in component-local
// state, but the Composer is REMOUNTED whenever its terminal tile is maximized/minimized (the layout
// swaps the grid view for the single full-size view → unmount + fresh mount), which would otherwise
// drop the user's in-progress draft. This tiny module-level store keeps the draft alive ACROSS that
// remount, keyed by sessionId so two sessions never share a draft. In-memory only (drafts are
// ephemeral and intentionally not persisted across reloads) — read on mount, written on change,
// cleared on a successful send.
const drafts = new Map<string, string>();

export function getDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

export function setDraft(sessionId: string, text: string): void {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}
