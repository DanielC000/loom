import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import type { PendingOpView } from "../orchestration/pending-ops.js";

/**
 * Recycle-lineage helpers, shared by session-lifecycle logic and any merge/gate dedupe key that must
 * stay stable across a `worker_recycle`/manager recycle. Rehomed here from `platform-lead-prompt.ts`
 * (card `1c51de69`, out of Code Review `f96c209a` on card `3a2dac9c`) — that module's own header
 * describes card `2fed1663`'s Platform Lead resume-doc scoping, and these three helpers are general
 * session-lineage primitives with no connection to it; a reader debugging `peekPendingMerge` or a batch
 * dedupe key would never think to grep the resume-doc module for them.
 *
 * INVARIANT (Code Review, card `1c51de69`-follow-up): every function here that accepts a caller-supplied
 * `{ id, recycledFrom }` seed instead of re-fetching via `db.getSession` (the optional seed on
 * `lineageResolvedPendingOp`, and `lineageRootId`'s own required `session` param) relies on
 * `recycledFrom` being IMMUTABLE for a given row's lifetime once inserted — a session's `recycledFrom` is
 * set once at INSERT and never rewritten; all three recycle paths (`recycleWorker`/`recycleManager`/the
 * Platform Lead's own recycle) insert a brand-new successor ROW rather than mutating the predecessor's.
 * This is EMERGENT, not enforced by any DB trigger/constraint or by this module.
 *
 * `Db.setOrchestration` now HAS exactly one production caller SHAPE of `recycledFrom` — three call sites
 * (one per recycle path), each identical in structure: each of the three recycle paths' OWN pre-spawn-
 * failure catch nulls its OWN just-inserted successor's `recycledFrom` — synchronously, in the SAME tick
 * as the `insertSession` that set it (no `await` between), before that row is ever returned to a caller
 * or read by anything outside the recycle method itself. This does NOT reopen the immutability gap
 * above: no OTHER caller mutates `recycledFrom` after insert, and this one caller only ever mutates a row
 * that (a) was inserted THIS SAME synchronous call, (b) never had a process — it reads `processState:
 * 'live'` in the DB throughout this window, but `pty.spawn()` never returned successfully for it, and
 * (c) is unlinked before any other code path (a lineage walk, `getSuccessor`, a caller-supplied seed)
 * could ever have observed the old value.
 *
 * @decision 4be56c33 — a FUTURE `setOrchestration({recycledFrom})` caller outside that exact shape
 * (mutating a live or already-observed row) reopens this invariant — re-examine every seed-accepting
 * function below before adding one.
 */

/**
 * Walk a session's `recycledFrom` chain back to its LINEAGE ROOT — the original session with no
 * predecessor. Every successor in a recycle chain shares its root's id as the stable `lineageId`. A
 * fresh (non-recycled) session is its own root. Cycle-guarded (defensive; a real chain never cycles).
 */
export function lineageRootId(db: Db, session: { id: string; recycledFrom?: string | null }): string {
  let current: { id: string; recycledFrom?: string | null } = session;
  const seen = new Set<string>([current.id]);
  while (current.recycledFrom && !seen.has(current.recycledFrom)) {
    const prev = db.getSession(current.recycledFrom);
    if (!prev) break;
    seen.add(prev.id);
    current = prev;
  }
  return current.id;
}

/**
 * Walk a session's recycle-successor chain FORWARD, starting from `sessionId`, to find the LIVE end
 * of its lineage — the complement to {@link lineageRootId} (which walks BACKWARD to the root). At each
 * step it follows `db.getSuccessor` (the session, if any, whose `recycledFrom` points at the current
 * one) until it finds a live session or the chain runs out. Cycle-guarded (defensive; a real chain
 * never cycles). Returns null if `sessionId` doesn't exist or no live session exists anywhere forward
 * in its lineage.
 */
export function liveLineageSuccessor(db: Db, sessionId: string): Session | null {
  let current: Session | undefined = db.getSession(sessionId);
  const seen = new Set<string>();
  while (current) {
    if (current.processState === "live") return current;
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = db.getSuccessor(current.id);
  }
  return null;
}

/**
 * Walk a session's `recycledFrom` chain BACKWARD, from `sessionId` itself out to its lineage root,
 * looking for a per-session-keyed pending op (`${kindPrefix}:${id}`) minted under one of the ancestor
 * ids — the read-side complement to {@link liveLineageSuccessor}'s forward walk (card `3a2dac9c`, out of
 * `eeb26621`'s investigation). A `merge`/`gate` op is minted under whichever session id was live at
 * `attach()` time; `recycleWorker`/`recycleManager` mint a fresh successor id but never rewrite or alias
 * that key onto it (see `confirmWorkerMergeTracked`'s own doc for why not — the tombstone's
 * `ownerSessionId` for a merge op is the MANAGER, not the worker, so there is nothing on the durable row
 * to rewrite anyway). Without this walk, an op started before a recycle is invisible to any reader that
 * only ever peeks the CURRENT (successor) id's own key.
 *
 * `peek` is caller-supplied (a bound `PendingOpRegistry.peek`, or any lookalike) rather than this
 * function taking a `PendingOpRegistry` directly, so a caller only needs to hand in a lookup function,
 * never the whole registry — this module's own import of `pending-ops.ts` stays limited to the
 * `PendingOpView` return-shape type, never a value/class import of the registry itself.
 *
 * `session` accepts either a bare id (this function re-fetches its `recycledFrom` via `db.getSession`,
 * same as before) OR a `{ id, recycledFrom }` seed (card `1c51de69` DoD-3) — like `lineageRootId`'s own
 * `session` param — for a caller that already holds the row (e.g. from a `listAllSessions()`/
 * `listWorkers()` projection) and would otherwise force a redundant point-read here just to learn a
 * `recycledFrom` it already has in hand.
 *
 * Returns the first hit — an op that's still running, or a not-yet-expired retained view (`peek()`
 * surfaces both, see pending-ops.ts) — together with the exact key it was found under and which ancestor
 * id owns it, so a caller can tell "my own op" (`originSessionId === sessionId`) from "my predecessor's"
 * by comparing that id. Returns `undefined` when the walk finds nothing anywhere in the lineage. Bounded
 * + cycle-guarded like `lineageRootId`; a real chain never cycles.
 */
export function lineageResolvedPendingOp(
  db: Db, kindPrefix: string, peek: (key: string) => PendingOpView | undefined,
  session: string | { id: string; recycledFrom?: string | null },
): { key: string; view: PendingOpView; originSessionId: string } | undefined {
  let current: { id: string; recycledFrom?: string | null } | undefined =
    typeof session === "string" ? (db.getSession(session) ?? { id: session, recycledFrom: null }) : session;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    const key = `${kindPrefix}:${current.id}`;
    const view = peek(key);
    if (view) return { key, view, originSessionId: current.id };
    if (!current.recycledFrom) return undefined;
    current = db.getSession(current.recycledFrom);
  }
  return undefined;
}
