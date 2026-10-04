/**
 * Submitting a typed draft without destroying it on failure. JSX-free on purpose — the ORDERING is the
 * whole point and a pure test can observe it, so this is unit-tested by `test/draft-submit.mjs`.
 *
 * The defect it exists to fix (card a1ec70a6): Board's Add-to-Inbox field cleared the typed title in the
 * same tick it fired the create, so a 400/401 left the user staring at an error with their text gone.
 * Clearing is an effect of SUCCESS, not of submitting — which means it can only happen after the awaited
 * create resolves, and a caller that clears inline is structurally unable to get it right.
 *
 * And clearing on success is still not unconditional: the user may have kept typing while the write was in
 * flight, and that newer text is no more the app's to delete than the original was. So the clear is scoped
 * to the exact text that was SUBMITTED — applied as a functional update, because by then the submitting
 * closure's own view of the draft is stale by definition.
 *
 * @decision a1ec70a6 — never clear a draft before its write resolves, and never clear text the write did
 * not submit (the owner's never-clobber-user-input rule). The re-entry guard must be a synchronous ref,
 * not React state: `setBusy(true)` has not re-rendered when a second click in the same tick reads it.
 */

/** What became of a submit. `"empty"`/`"busy"` never reached the write at all. */
export type DraftSubmitOutcome = "empty" | "busy" | "created" | "failed";

export interface DraftSubmitOptions {
  /** The raw typed value. Submitted only if it has non-whitespace content. */
  draft: string;
  /** Is a submit already in flight? Read SYNCHRONOUSLY (a ref, never React state — see the doc above). */
  inFlight: () => boolean;
  /** Mark the in-flight state, both to block re-entry and to drive a disabled/pending affordance. */
  setInFlight: (value: boolean) => void;
  /** The write. Rejecting (or resolving `false`) means the draft must survive untouched. */
  create: () => Promise<unknown>;
  /**
   * Apply a FUNCTIONAL update to the live draft — React's `setState(fn)` satisfies this as-is (`setTitle`).
   * It must be functional, not a plain setter: this is the only way to read the draft as it stands AFTER
   * the await, which is the whole point. The updater this module hands over clears the draft only when it
   * still holds the submitted text.
   */
  updateDraft: (update: (current: string) => string) => void;
}

/**
 * Run one submit: refuse an empty or re-entrant one, await the write, and clear the draft only once it
 * actually succeeded AND only if it still holds what was submitted. Never rejects — the outcome is the
 * return value, so a caller can `void` it.
 */
export async function submitDraft(opts: DraftSubmitOptions): Promise<DraftSubmitOutcome> {
  if (!opts.draft.trim()) return "empty";
  if (opts.inFlight()) return "busy";
  // Captured BEFORE the await: this is the text the create is about to send, and the only text the clear
  // below is entitled to remove. Reading `opts.draft` again afterwards would read whatever the user has
  // since typed — i.e. exactly the value that must survive.
  const submitted = opts.draft;
  opts.setInFlight(true);
  try {
    await opts.create();
  } catch {
    return "failed"; // the draft stays exactly as typed — the error line tells the user what happened
  } finally {
    opts.setInFlight(false);
  }
  // The guard lives HERE, not at the call site: a caller that clears unconditionally looks correct in
  // isolation, and this is the one place that still knows what was actually submitted.
  opts.updateDraft((current) => (current === submitted ? "" : current));
  return "created";
}
