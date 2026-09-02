/**
 * Daemon-global, in-memory, ADVISORY-ONLY registry of "I intend to fire a gate at ~T" declarations (card
 * a5d1ae04 — the structured replacement for a hand-written peer-channel "ANNOUNCE" letter, whose measured
 * delivery latency — 2.0-23.3 min, one outlier at 107 min — routinely exceeds the 7-15 min coordination
 * floor it exists to protect; see that card's own DoD/PROVENANCE for the full measurement).
 *
 * ⛔ THIS NEVER GATES, BLOCKS, OR DELAYS AN ACTUAL GATE ADMISSION (card a5d1ae04 DoD-4). That is not a
 * policy documented on the tools below — it is a structural fact: nothing in `gate-runner.ts` or
 * `gate-semaphore.ts` (the two files that actually execute/admit a gate) imports or references this class
 * at all, and `test/gate-intent-no-firing-coupling.mjs` asserts that absence by grepping those two files
 * directly, with a positive control proving the grep itself has power to catch a planted reference. A
 * declaration is pure disclosure — a caller reads it, or doesn't; nothing here can ever change what a gate
 * does.
 *
 * ONE LIVE ROW PER DECLARING SESSION — a redeclare fully replaces the prior row (including `declaredAt`,
 * which is NOT preserved across a redeclare; each `declare()` call is a fresh declaration, full stop). This
 * is why `withdraw()` takes no identifying argument beyond the session itself: there is never more than one
 * row to disambiguate.
 *
 * STORAGE: a bare in-memory `Map`, no persistence — resets on daemon restart, same posture as
 * `GateSemaphore`'s own live registry (see that class's file-level doc). A declaration is inherently
 * short-lived (bounded lifetime `INTENT_MAX_LEAD_MS + INTENT_EXPIRE_GRACE_MS` regardless of anything else,
 * see {@link GateIntentRegistry.snapshot}), so there is nothing durable to lose across a restart — a
 * still-relevant manager just redeclares.
 *
 * REAPING IS LAZY, NOT TIMER-DRIVEN: there is no `setInterval`/`setTimeout` anywhere in this class. Every
 * stale or dead row is dropped inside {@link GateIntentRegistry.snapshot}, the ONE place any caller ever
 * reads this registry — so every read is also a sweep, there is no separate schedule to keep in sync, and
 * (deliberately) nothing here is the kind of thing a fixed-wait test could ever need to poll for.
 */

import type { GateType } from "@loom/shared";

/**
 * How far into the future a manager may declare an intent-to-fire — bounds the worst-case lifetime of a
 * stale, never-withdrawn declaration together with {@link INTENT_EXPIRE_GRACE_MS}. Chosen to comfortably
 * cover card a5d1ae04's own measured merge-gate coordination floors (7-15 min) with headroom; not derived
 * from any other constant in this codebase, and not the same clock as `gateTimeoutMs`/`GATE_EXTEND_IDLE_MS`
 * (those bound a RUNNING gate's own execution; this bounds how far ahead a caller may claim to be about to
 * START one).
 */
export const INTENT_MAX_LEAD_MS = 20 * 60_000;

/**
 * How long a declaration stays visible AFTER its declared `firesAt` has passed (or after the hard
 * `declaredAt + INTENT_MAX_LEAD_MS` backstop) before {@link GateIntentRegistry.snapshot} reaps it on the
 * next read — regardless of whether the declaring session withdrew it or is still alive. This is a
 * courtesy grace window, not a promise: the correct hygiene is for a manager to `gate_intent_withdraw` once
 * it actually fires (see that tool's own doc) — this constant is only the backstop for when it doesn't.
 * Deliberately NOT zero: a caller reading `gate_queue` in the instant just after a declared `firesAt` still
 * sees the declaration (`msUntilFire` negative, never clamped to 0 — see that field's own doc on
 * `GateQueueEntry`/`GateIntentEntry`) rather than it vanishing exactly on the declared instant, which would
 * make "did it fire, or did it just get reaped" indistinguishable from the read side.
 */
export const INTENT_EXPIRE_GRACE_MS = 5 * 60_000;

/** What a caller supplies to {@link GateIntentRegistry.declare} — `sessionId`/`projectId` identify the
 *  declaring MANAGER session (never a worker's), the rest is the optional structured content a peer reads
 *  off `gate_queue`'s `declarations` array. See {@link GateIntentRow} for the two server-stamped fields this
 *  descriptor does NOT carry. */
export interface GateIntentDescriptor {
  sessionId: string;
  projectId: string;
  gateType?: GateType;
  /** Card a5d1ae04's own design-checkpoint ruling: stays OWN-PROJECT ONLY when read back via `gate_queue`
   *  (same sensitivity class as `Task.repoKey`/`GateQueueEntry.branch` — a project-internal identifier a
   *  foreign caller has no business seeing) — see {@link GateIntentEntry.repoKey}'s own doc. `null` means
   *  "the project's primary repo", mirroring `Task.repoKey`'s own convention; `undefined` means "not
   *  specified at all". */
  repoKey?: string | null;
  /** Short freeform text, own-project-only on read-back, same redaction tier as `repoKey` above. No length
   *  enforcement here — a caller supplying something enormous is a caller bug, not a case this registry
   *  guards against; the MCP tool layer is where a real length bound would be added if this ever becomes a
   *  problem in practice. */
  note?: string;
}

/** A declaration as stored — {@link GateIntentDescriptor} plus the two fields this registry itself stamps.
 *  `declaredAt`/`firesAt` are epoch-ms (this class's own internal unit); the MCP-facing shape
 *  (`GateIntentEntry` in `sessions/service.ts`) converts both to ISO strings at the read boundary, the same
 *  convention `GateQueueEntry` already uses. */
export interface GateIntentRow extends GateIntentDescriptor {
  /** Server-stamped the instant `declare()` is called — never client-supplied, so there is no clock-skew
   *  question between a declaring session and the daemon (card a5d1ae04 DoD-3). */
  declaredAt: number;
  /** `declaredAt + etaMs` — see {@link GateIntentRegistry.declare}'s own doc for why the registry takes a
   *  relative offset rather than an absolute timestamp from the caller. */
  firesAt: number;
}

/**
 * See this file's own top-of-file doc for the full design rationale. This class is intentionally tiny:
 * `declare`/`withdraw`/`snapshot` are its entire surface, and none of the three ever throws — a caller
 * (`SessionService`) is responsible for validating `etaMs` before calling `declare`, and for resolving
 * whatever `isSessionLive` predicate `snapshot` needs.
 */
export class GateIntentRegistry {
  private readonly bySession = new Map<string, GateIntentRow>();

  /** Injectable clock, defaulting to the real one — exists purely so a test can drive `snapshot`'s
   *  expiry math deterministically (advance a fake clock past `firesAt + INTENT_EXPIRE_GRACE_MS` and
   *  observe the reap) without a real `setTimeout`/sleep anywhere in the test. Never used for anything
   *  else in this class. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Replace the caller's own declaration (if any) with a fresh one — `declaredAt` is always re-stamped to
   *  "now", even on a redeclare; this is never a merge/update of the prior row.
   *
   *  `etaMs` MUST already be validated into `[0, INTENT_MAX_LEAD_MS]` by the caller — this method does not
   *  clamp or reject an out-of-range value itself (a bad value here is a caller bug, not a runtime guard;
   *  `SessionService.declareGateIntent` is where the real validation — and the user-facing `{error}` for a
   *  bad value — lives, matching how every other tool handler in this codebase shapes its own errors rather
   *  than pushing that responsibility down into a shared primitive). */
  declare(descriptor: GateIntentDescriptor, etaMs: number): GateIntentRow {
    const declaredAt = this.now();
    const row: GateIntentRow = { ...descriptor, declaredAt, firesAt: declaredAt + etaMs };
    this.bySession.set(descriptor.sessionId, row);
    return row;
  }

  /** Remove the caller's own declaration, if any. Returns whether one was actually present — a caller with
   *  nothing to withdraw is NOT an error; the `gate_intent_withdraw` tool is idempotent by design. */
  withdraw(sessionId: string): boolean {
    return this.bySession.delete(sessionId);
  }

  /**
   * Every declaration that is still LIVE right now — reaping everything else in the SAME pass (this method
   * mutates {@link bySession}; every call is a sweep, not a pure read). A row is dropped when EITHER:
   *   - `now > declaredAt + INTENT_MAX_LEAD_MS + INTENT_EXPIRE_GRACE_MS` (the hard, unconditional backstop
   *     — bounds worst-case lifetime regardless of the other two conditions below), OR
   *   - `now > firesAt + INTENT_EXPIRE_GRACE_MS` (the ordinary case: the declared fire time passed, plus
   *     the grace window — see {@link INTENT_EXPIRE_GRACE_MS}'s own doc for why this isn't zero), OR
   *   - `isSessionLive(sessionId)` returns `false` — the DEAD-SEAT detection this feature exists to add
   *     over the letter it replaces: the instant the declaring session recycles/exits, its declaration is
   *     gone on the very next read, unbounded by either clock above (this is what directly answers card
   *     a5d1ae04's own measured 17.7-min-late recycle notice — a peer never has to wait out a TTL to learn
   *     a declaring seat no longer exists).
   *
   * `isSessionLive` is supplied by the caller (`SessionService`, via `db.getSession(id)?.processState ===
   * "live"`) rather than looked up here — this class has no `Db` reference of its own, deliberately, so it
   * stays testable with zero I/O.
   */
  snapshot(isSessionLive: (sessionId: string) => boolean): GateIntentRow[] {
    const now = this.now();
    const out: GateIntentRow[] = [];
    for (const [sessionId, row] of this.bySession) {
      const hardExpired = now > row.declaredAt + INTENT_MAX_LEAD_MS + INTENT_EXPIRE_GRACE_MS;
      const fireExpired = now > row.firesAt + INTENT_EXPIRE_GRACE_MS;
      if (hardExpired || fireExpired || !isSessionLive(sessionId)) {
        this.bySession.delete(sessionId);
        continue;
      }
      out.push(row);
    }
    return out;
  }
}
