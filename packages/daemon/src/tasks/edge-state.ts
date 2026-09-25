// Card 3df86c87 (review 8d5f73bd) — the ONE pure model of a `blocks` edge's state, shared by the planner's
// cycle check (tasks/relations.ts) and every writer (db.ts applyBlocksPatch), so what is validated and what
// is written can never diverge.
// @decision 3df86c87 — `declared` and `gates` are two INDEPENDENT bits on one edge (row exists iff either or
// `released` is set); never fold them into one flag or infer state from who created the row.

/** One `blocks` edge, blocker (`from`) → blocked card (`to`). */
export interface EdgeBits {
  from: string;
  to: string;
  /** The user's explicit dependency (blockedBy/blocks). */
  declared: boolean;
  /** Backs the target's `deferredUntilTaskId` alias. */
  gates: boolean;
  /** History only: the deferral alias auto-released this edge and nothing declared it. Display-only — a
   *  released edge is NOT a live dependency (never counted by `ready`/the roll-up, never in the cycle graph). */
  released: boolean;
}

/** The blocks-graph part of a structure patch, for the card `taskId`. `undefined` = untouched, `[]` = clear. */
export interface EdgePatch {
  taskId: string;
  /** REPLACES the `declared` bit of every edge INTO taskId. */
  blockedBy?: string[];
  /** REPLACES the `declared` bit of every edge OUT OF taskId. */
  blocks?: string[];
  /** REPLACES the `gates` bit of every edge INTO taskId (the deferredUntilTaskId alias). */
  deferral?: string[];
}

/** An edge is a LIVE dependency iff one of the two live bits is set (a released row is history only). */
export const isLiveEdge = (e: Pick<EdgeBits, "declared" | "gates">): boolean => e.declared || e.gates;

/**
 * The `blocks` edges that exist AFTER applying `patch` to `rows` — a pure function of its inputs, used by BOTH
 * the planner's cycle check and the writers. Each patch part only ever touches its own bit, so the parts
 * commute (applying them in one call or one after another gives the same result). A row survives iff any of
 * the three bits is set; setting a live bit clears `released`.
 */
export function edgesAfterPatch(rows: EdgeBits[], patch: EdgePatch): EdgeBits[] {
  const key = (from: string, to: string) => `${from}\u0000${to}`;
  const map = new Map<string, EdgeBits>();
  for (const r of rows) map.set(key(r.from, r.to), { ...r });
  const ensure = (from: string, to: string): EdgeBits => {
    const k = key(from, to);
    let e = map.get(k);
    if (!e) { e = { from, to, declared: false, gates: false, released: false }; map.set(k, e); }
    return e;
  };
  const T = patch.taskId;
  if (patch.blockedBy) {
    for (const e of map.values()) if (e.to === T) e.declared = patch.blockedBy.includes(e.from);
    for (const b of patch.blockedBy) ensure(b, T).declared = true;
  }
  if (patch.blocks) {
    for (const e of map.values()) if (e.from === T) e.declared = patch.blocks.includes(e.to);
    for (const y of patch.blocks) ensure(T, y).declared = true;
  }
  if (patch.deferral) {
    for (const e of map.values()) if (e.to === T) e.gates = patch.deferral.includes(e.from);
    for (const d of patch.deferral) ensure(d, T).gates = true;
  }
  const out: EdgeBits[] = [];
  for (const e of map.values()) {
    if (isLiveEdge(e)) e.released = false;
    if (isLiveEdge(e) || e.released) out.push(e);
  }
  return out;
}
