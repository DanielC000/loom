import type { PermissionScope } from "@loom/shared";

// Per-request answer-draft persistence for the Requests dialog. The four answer controls (decision ·
// input · permission · credential) hold their unsent answer in component-local state, but that state dies
// on EVERY close path: the modal's backdrop/Escape/✕, a linked-task or live-session navigation, or another
// request opening over the top. The draft lives here instead, keyed by request id. Read on mount
// (restore), written on change, cleared on a successful submit — and read imperatively by RequestModal at
// the moment of a backdrop/Escape close attempt, which refuses the close while a draft is unsent.
//
// @decision 544960ed — never store a credential secret VALUE here (only `secretDirty`), and never move
// this store to sessionStorage/localStorage: either puts a plaintext secret somewhere the credential
// contract promises it never goes. The explicit ✕ discards a dirty secret, and the dialog says so.
export type RequestDraft = {
  choice: string | null;
  note: string;
  scope: PermissionScope | null;
  expiry: string;
  secretDirty: boolean;
};

export const EMPTY_REQUEST_DRAFT: RequestDraft = { choice: null, note: "", scope: null, expiry: "", secretDirty: false };

const drafts = new Map<string, RequestDraft>();

// A draft is only RETAINED while it is dirty — a clean form is at its defaults and has nothing to restore,
// so storing it would just keep a row alive for no one. Mirrors composerDrafts' set-or-delete shape, and
// is what lets isRequestDraftDirty below be a plain Map.has: presence IS dirtiness.
export function setRequestDraft(id: string, draft: RequestDraft, dirty: boolean): void {
  if (dirty) drafts.set(id, draft);
  else drafts.delete(id);
}

export function getRequestDraft(id: string): RequestDraft {
  return drafts.get(id) ?? EMPTY_REQUEST_DRAFT;
}

export function clearRequestDraft(id: string): void {
  drafts.delete(id);
}

export function isRequestDraftDirty(id: string): boolean {
  return drafts.has(id);
}
