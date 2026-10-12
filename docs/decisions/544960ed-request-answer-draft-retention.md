# Request answer-draft retention — what is kept, where, and what is deliberately not

Card `544960ed`. Owner intake 2026-10-12: the Requests answer dialog closed on any click outside it, destroying whatever the human had already typed. The standing rule is never to clobber a user's unfinished input, so the draft had to outlive the dialog.

## The shape

`packages/web/src/lib/requestDrafts.ts` is a module-level `Map<requestId, RequestDraft>`. The four answer controls (decision · input · permission · credential) read it on mount to restore and write it on change.

A draft is retired on **two** paths, and both are needed:

- `useAnswerMutation` clears it on a successful submit — the one place that knows an answer landed through this dialog.
- `RequestDetail` clears it whenever the loaded question's state is no longer `"pending"`. A request can stop being answerable without that mutation ever running: the owner answers it in chat (`question_resolve`), from another tab, or a manager cancels it. The control then simply stops mounting, so the first path never fires and the dirty flag is stranded — reopening would refuse the backdrop/Escape close with "Draft kept", over a draft that can never be sent, with the answered readout on screen and no form to explain why. (Only `CredentialControl` self-healed here, via the unmount clear it has for its own separate reason.) This is deliberately **not** extended to the query's error state: `retry` is off, so a transient blip would destroy a draft the human is still typing — the exact loss this record exists to prevent. A vanished request can always still be closed with ✕.

It serves two consumers, which is why it carries a `dirty` flag and not just the text:

1. **The controls** — restore/persist across every unmount.
2. **`RequestModal`** — reads `isRequestDraftDirty(id)` at the *moment* of a backdrop or Escape close attempt and refuses the close instead of unmounting the form. It never subscribes to the store, so a keystroke in the form never re-renders the dialog, and no dirty-state prop has to be threaded down through `RequestDetail` → `RequestControl` → the control. The store is the single source of truth for both questions.

Retention is set-or-delete: a draft is only stored *while dirty*. A clean form sits at its defaults and has nothing to restore, so `isRequestDraftDirty` can be plain `Map.has` — presence is dirtiness. Same set-or-delete shape as the older `composerDrafts.ts`.

## Why in-memory and not sessionStorage

Drafts are meant to outlive a *close*, not a *reload*. Nothing here touches sessionStorage or localStorage, matching `composerDrafts.ts`. That also means there is no storage path a secret could ever reach, which is the next section.

## Why a credential secret is not stored at all

The card permitted either "keep it only in memory" or "don't persist it at all, and say which". This chose the stricter one: the map holds `secretDirty`, a boolean saying the secret input is non-empty, and **never the value**.

The reason is that the whole credential path is write-only by design — envelope-encrypted at the daemon's one write boundary, never returned, never shown again, with the form's own banner telling the human "store it once — you won't see it after". Holding the plaintext in a module-level map for the remaining life of the page, *after* the human explicitly closed the dialog, would quietly widen that surface for no behavioural gain the guard does not already provide: `secretDirty` is enough for the backdrop/Escape guard, and the guard is what makes the accidental-click loss — the actual reported bug — impossible.

What that leaves: the explicit ✕ on a credential form discards the secret. The dialog says so in as many words (the blocked-close notice reads "Secret not kept — ✕ discards it" rather than the "Draft kept" copy the other three types get), so the one close path that can still lose a secret announces itself before the human takes it.

## Do not

- **Do not store a credential secret value in `requestDrafts.ts`**, nor move any part of this store to sessionStorage/localStorage. Either change puts a plaintext secret somewhere the credential contract promises it never goes.
- **Do not make the explicit ✕ refuse to close a dirty form.** Backdrop and Escape are the accidental gestures and are the ones guarded; ✕ is the deliberate one and must always work, or a dirty form becomes impossible to dismiss.
- **Do not make `RequestModal` subscribe to this store.** It reads imperatively at close time on purpose — a subscription re-renders the whole dialog on every keystroke.
- **Do not remove the non-pending clear in `RequestDetail`, and do not narrow it to the submit path.** Every way a request stops being answerable other than this dialog's own submit leaves a stranded dirty flag that refuses to close a dialog with no form in it. Equally, **do not widen it to the query's error state** — see above for why that destroys live drafts.
