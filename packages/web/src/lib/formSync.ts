// Three-way field reconcile for a form seeded from a server record an AGENT can rewrite while the human
// has the form open (card 65aa951c; design: docs/decisions/654869e2-config-deltas-not-echoes.md).
//
// @decision 65aa951c — decide "the human changed this" against the SEED the form last synced from, never
// against the record's CURRENT value: comparing to the current value cannot express "stale, and the human
// never chose it", which is the whole distinction both remedies below turn on.
//
// A form that seeds `useState` once at mount and then re-sends every modelled field on Save silently
// REVERTS every write made to that record since the mount — the save succeeds, the form looks right, and
// nothing surfaces the loss. Two independent remedies, and BOTH are needed:
//
//   DELTA   (`changedFields`) — send only the fields the human actually changed. This is the structural
//           half: an untouched field is never on the wire at all, so the server's own value survives with
//           NO refetch required. That matters because a refetch is not guaranteed — a human can sit on a
//           page for an hour without one.
//   RE-SYNC (`reconcileSeed`) — when the record DOES refetch, adopt the new value into every UNTOUCHED
//           field. This is the honesty half: the form shows the truth, and a stale field can never read
//           as a pending human edit (an enabled Save the human never armed).
//
// Both are pure and total over the field map, so a field ADDED to a form's value shape is covered the
// moment it appears in the seed — there is no per-field registration to forget.
//
// ⚠️ A pure test over these functions cannot see WHEN its caller samples state (the `654869e2` lesson: a
// `useState` initializer's staleness is invisible to a unit test). These are unit-tested for the algebra;
// the wiring is proved by `packages/web/e2e/concurrent-agent-write.spec.ts`.

/** Per-field equality overrides. Anything omitted falls back to value-then-JSON equality. */
export type FieldComparers<V> = { readonly [K in keyof V]?: (a: V[K], b: V[K]) => boolean };

/**
 * Value-then-JSON equality — the default comparer. JSON is the right fallback here because every field
 * these forms model is a plain scalar, array or record built from the server's own JSON, so a structural
 * compare is exact rather than approximate. A field with its own normalization (a trimmed string, an
 * order-insensitive list) passes a comparer instead of relying on this.
 */
export const sameFieldValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

function comparerFor<V extends object, K extends keyof V>(
  comparers: FieldComparers<V> | undefined,
  key: K,
): (a: V[K], b: V[K]) => boolean {
  return comparers?.[key] ?? (sameFieldValue as (a: V[K], b: V[K]) => boolean);
}

/**
 * The fields the human actually changed — `local` against the `seed` it was last synced from. This is
 * what a delta PATCH/PUT carries, and (being exactly "is anything changed") what a Save button's `dirty`
 * should read, so the two can never disagree about whether there is something to save.
 *
 * Iterates `seed`'s own keys, so a key present only on `local` is deliberately not reported: the seed
 * defines the modelled field set, and a form that cannot seed a field cannot honestly diff it either.
 */
export function changedFields<V extends object>(seed: V, local: V, comparers?: FieldComparers<V>): (keyof V)[] {
  return (Object.keys(seed) as (keyof V)[]).filter((k) => !comparerFor(comparers, k)(seed[k], local[k]));
}

export interface SeedReconcile<V> {
  /** The local values to apply — untouched fields advanced to the record's new value, edits left alone. */
  values: V;
  /** Fields silently advanced to the server's value (the human had not touched them). */
  adopted: (keyof V)[];
  /**
   * Fields the human HAS edited whose server value also moved, to a different value — the only case worth
   * disclosing, because saving will overwrite someone else's write. A field whose server value moved TO
   * what the human is already holding (the record refetching after this form's OWN save) is NOT a
   * conflict, which is what keeps a routine save from reporting one against itself.
   */
  conflicts: (keyof V)[];
}

/**
 * Reconcile local form state against a newly-fetched record. Call this whenever the record changes and
 * then advance the stored seed to `next` WHOLESALE — including for a conflicting field, so a human edit
 * stays measured against the record as it is NOW rather than being re-reported as a conflict forever.
 */
export function reconcileSeed<V extends object>(
  seed: V,
  local: V,
  next: V,
  comparers?: FieldComparers<V>,
): SeedReconcile<V> {
  const values = { ...local };
  const adopted: (keyof V)[] = [];
  const conflicts: (keyof V)[] = [];
  for (const key of Object.keys(seed) as (keyof V)[]) {
    const eq = comparerFor(comparers, key);
    if (eq(seed[key], next[key])) continue; // the record did not move on this field — nothing to decide
    if (eq(local[key], seed[key])) {
      values[key] = next[key];
      adopted.push(key);
    } else if (!eq(local[key], next[key])) {
      conflicts.push(key);
    }
  }
  return { values, adopted, conflicts };
}

/**
 * The accumulated conflict list, advanced by one reconcile: every previously-reported field that STILL
 * diverges from the record is kept, the newly-reported ones are added, and a field that has stopped
 * diverging is dropped.
 *
 * Dropping on CONVERGENCE is what retires a conflict notice after the form's own save — local then equals
 * the stored row, so there is nothing left to overwrite and the notice would be a false accusation.
 *
 * @decision 65aa951c — retire a conflict when the field stops DIVERGING, never by clearing the whole list
 * on a reconcile that produced no new conflicts: one field settling would then silently erase a live
 * conflict on another the human has not dealt with yet.
 */
export function retainConflicts<V extends object>(
  prev: readonly (keyof V)[],
  added: readonly (keyof V)[],
  local: V,
  row: V,
  comparers?: FieldComparers<V>,
): (keyof V)[] {
  // The SAME comparer resolution the rest of this module uses — a conflict must retire under exactly the
  // equality that decided it was one, or a normalized value (a trimmed string, a re-ordered multiselect)
  // keeps the notice alive against a field the form already considers settled.
  const diverges = (f: keyof V) => !comparerFor(comparers, f)(local[f], row[f]);
  return [...new Set([...prev.filter(diverges), ...added])];
}
