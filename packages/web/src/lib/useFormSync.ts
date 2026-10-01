import { useEffect, useRef, useState } from "react";
import { changedFields, reconcileSeed, retainConflicts, type FieldComparers } from "./formSync";

// The REACT half of `lib/formSync` (card 65aa951c) — the bookkeeping all three seed-backed forms do
// identically: hold the seed, run the reconcile when the row moves, keep the conflict list, and re-seed
// after the form's own save. `formSync.ts` stays PURE so `packages/web/test/form-sync.mjs` can import it
// under bare `node --experimental-strip-types`; this file imports React and therefore cannot live there.
//
// It exists because the three copies DID drift. Settings cleared its conflict list on a successful save
// and the other two never cleared theirs at all, so after a human saved their own version a later re-edit
// of that same field accused them of overwriting a write they had just deliberately replaced. One shared
// unit means the next form gets the behaviour rather than a fourth near-copy of it.
//
// @decision 65aa951c — a conflict is retired when the field stops DIVERGING from the row, never by
// clearing the whole list on a reconcile that happened to produce no new conflicts: an unrelated field
// moving would then silently erase a live conflict the human still needs to see.

export interface FormSync<V extends object> {
  /** The record this form's state was last synced FROM — what Reset restores and what the delta diffs. */
  seed: V;
  /** The fields the human changed against that seed. Drives BOTH the save payload and `dirty`. */
  changed: (keyof V)[];
  changedSet: ReadonlySet<keyof V>;
  /** `changed.length > 0` — the one place a seed-backed form should read its dirtiness from. */
  dirty: boolean;
  /**
   * Fields the human is editing whose stored value ALSO moved, to a different value — already filtered to
   * what is still changed, so a Reset retires the notice without any extra bookkeeping at the call site.
   */
  conflicts: (keyof V)[];
  /**
   * Call from the save's own `onSuccess` with the record the server persisted AND the snapshot that was
   * SENT. Required only by a form that re-seeds itself from the response; a form whose save instead
   * invalidates the query it reads (ProfileEditor, AgentEditor) is served by the row reconcile alone.
   */
  onSaved: (persisted: V, sent: V) => void;
}

/**
 * Seed-backed form state for a record an AGENT can rewrite while the human has the form open.
 *
 * `row` is the RAW server value and `project` maps it into the form's field shape. They are separate
 * arguments on purpose: the reconcile must fire exactly when the row moves, and a projection rebuilt on
 * every render is a fresh object every time — passing one as the effect's dependency would re-run the
 * reconcile on every keystroke instead.
 */
export function useFormSync<R, V extends object>(
  row: R,
  project: (row: R) => V,
  local: V,
  apply: (values: V) => void,
  comparers?: FieldComparers<V>,
): FormSync<V> {
  // STATE, never a ref: `dirty` is derived from the seed, so advancing it must re-render. With a ref the
  // one path that adopts nothing — the row refetching after this form's OWN save, where local already
  // equals the row — advances the seed silently and the editor reads "unsaved changes" forever.
  const [seed, setSeed] = useState(() => project(row));
  const [conflicted, setConflicted] = useState<(keyof V)[]>([]);

  // The latest render's inputs, readable from a callback that must NOT be re-created when they change:
  // the reconcile below keys on the row alone, and `onSaved` is invoked by react-query long after the
  // render that armed the save. Assigned during render rather than in an effect so the row reconcile —
  // which runs in the same commit — can never read a stale copy.
  const latest = useRef({ local, project, apply, comparers });
  latest.current = { local, project, apply, comparers };

  useEffect(() => {
    const { local: held, project: projectRow, apply: applyValues, comparers: eq } = latest.current;
    const next = projectRow(row);
    if (changedFields(seed, next, eq).length === 0) return; // the row did not move — nothing to decide
    const r = reconcileSeed(seed, held, next, eq);
    setSeed(next);
    if (r.adopted.length) applyValues(r.values);
    setConflicted((prev) => retainConflicts(prev, r.conflicts, r.values, next, eq));
    // `seed`/`local` are READ here but deliberately not tracked: with them in the deps this would also
    // run on every keystroke, against a seed already advanced to the current row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  const onSaved = (persisted: V, sent: V) => {
    const { local: held, apply: applyValues, comparers: eq } = latest.current;
    // 🔴 Reconciled against WHAT WAS SENT, not against the old seed and not field-by-field across the
    // board. Only the Save BUTTON is disabled during a save — the inputs stay live — so a field the human
    // typed into while the PATCH was open has a local value the response knows nothing about. Adopting
    // the persisted record over every field (which is what this used to do) destroys that keystroke
    // silently: the owner watches their own typing vanish and the save looks like it worked.
    const r = reconcileSeed(sent, held, persisted, eq);
    setSeed(persisted);
    if (r.adopted.length) applyValues(r.values);
    setConflicted((prev) => retainConflicts(prev, r.conflicts, r.values, persisted, eq));
  };

  const changed = changedFields(seed, local, comparers);
  const changedSet = new Set(changed);
  return {
    seed,
    changed,
    changedSet,
    dirty: changed.length > 0,
    conflicts: conflicted.filter((f) => changedSet.has(f)),
    onSaved,
  };
}
