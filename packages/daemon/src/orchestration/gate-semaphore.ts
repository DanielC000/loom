/**
 * Daemon-global, in-memory concurrency limiter for HEAVY, daemon-EXECUTED gate runs — the
 * merge-confirm gate (`confirmWorkerMerge`), the scoped-deploy gate (`deployOwnProject`), and the worker
 * DoD self-check (`runWorkerGate` / the `run_gate` tool), all of which invoke `runGateSequential` with an
 * arbitrary human-set build/test command. Bounds how many can run AT ONCE across every project, so N
 * concurrent gate calls can't pile up heavy build/test processes and starve a live sibling service on a
 * self-hosting host (card 301d8c01) — today that's enforced only by manager discipline (sequencing merges
 * by hand), not code.
 *
 * A caller that can't acquire a slot QUEUES (awaits) rather than being rejected — merge correctness is
 * unaffected, it just may wait behind another in-flight gate. This composes cleanly with the existing
 * client-timeout resilience (card fb8df559): `PendingOpRegistry.attach` already wraps the WHOLE
 * `confirmWorkerMerge`/`deploy`/`run_gate` call and degrades to a pending handle once it runs past its
 * sync-wait budget, so a gate that sits queued for a while is handled exactly like a gate that just runs
 * long — no separate handling needed here.
 *
 * Mirrors `CapQueueRegistry`'s simplicity: daemon-local, in-memory, no persistence. Resetting on a
 * daemon restart is fine — a queued waiter only ever exists inside a live, in-flight call; there is
 * nothing durable to lose.
 *
 * PRIORITY QUEUE (card 24642c3d): queued callers wait on TWO tiers — `highWaiters` (merge/deploy) drain
 * fully before `lowWaiters` (a worker's own `run_gate` self-check), FIFO within each tier. This stops a
 * low-priority worker's timing-out `run_gate` retries from head-of-line-blocking a higher-priority merge
 * that arrives later. It reorders the QUEUE only — there is no preemption of an already-RUNNING gate.
 *
 * LIVE REGISTRY (card a1c86452, the Gates page): alongside the counting/blocking machinery, every
 * in-flight run also records a small metadata `RegistryEntry` so the daemon can enumerate what is
 * currently RUNNING and QUEUED (the Gates page's active lane-hero reads this via
 * `SessionService.snapshotGates`). The registry is PURE ADDITIVE METADATA: it never influences admission
 * — `active`/`highWaiters`/`lowWaiters` and the acquire/release logic are byte-identical to the
 * pre-registry version. Each `runExclusive` REQUIRES a {@link GateDescriptor} (a required param, so the
 * compiler forces every call site to supply one — no silent gaps), and the registry entry is added before
 * acquisition and removed in a `finally` that fires on EVERY exit path (admission-then-settle, a `fn`
 * that throws, a `fn` that times out), so a leaked "phantom active gate" can never accumulate.
 */

import type { GateType } from "@loom/shared";
import { resolveIdPrefix, type IdPrefixResult } from "../id-prefix.js";

/** Queue priority for {@link GateSemaphore.runExclusive} (card 24642c3d): `"high"` for a merge/deploy
 *  gate, `"low"` for a worker's own `run_gate` DoD self-check. Governs QUEUE ORDER only — there is no
 *  preemption of an already-RUNNING gate (killing a healthy in-flight gate to make room would waste the
 *  work it's already done and risks leaking a process tree); a `"high"` caller only jumps ahead of
 *  ALREADY-QUEUED `"low"` waiters, same-tier order stays FIFO. This is what stops a low-priority worker's
 *  timing-out `run_gate` retries from head-of-line-blocking a higher-priority merge that arrives later —
 *  the exact starvation pattern this card was filed against. */
export type GatePriority = "high" | "low";

/**
 * The identity of one gate run, supplied at `runExclusive` time. REQUIRED (not optional) so a missing
 * descriptor is a compile error at the call site rather than a silent registry gap. `sessionId` is the
 * SUBJECT session: the worker for a merge/worker gate (its branch is what's being gated), the manager for
 * a deploy. `taskId`/`branch` are carried when they exist (a deploy has neither).
 */
export interface GateDescriptor {
  gateType: GateType;
  projectId: string;
  sessionId: string;
  taskId?: string | null;
  branch?: string | null;
  /** The PendingOpRegistry opId this gate run belongs to (card edc1ec12's `gate_status(opId)` read tool) —
   *  a caller holding the opId a `run_gate`/`worker_merge_confirm` pending response returned can look this
   *  run up in {@link GateSemaphore.snapshot}'s entries without needing the semaphore's own internal `id`.
   *  Optional: a call site with no correlating op (there are none today — every `runExclusive` caller has
   *  one) simply omits it and that entry is un-lookup-able by opId, exactly as before this field existed. */
  opId?: string;
}

/** One live gate run in the snapshot — a `GateDescriptor` enriched with its lane phase + timing. */
export interface GateSnapshotEntry {
  id: string;
  gateType: GateType;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  branch: string | null;
  /** "running" once it holds a lane; "queued" while it's still waiting for one. */
  phase: "running" | "queued";
  /** Epoch-ms anchor for the UI's live elapsed clock: startedAt (running) or enqueuedAt (queued). */
  since: number;
  /** 1-based position in the ACTUAL admission order (all high waiters before low, FIFO within a tier —
   *  mirrors `release()`); null for a running entry. */
  queuePosition: number | null;
  /** Echoed from {@link GateDescriptor.opId} — see its doc; null when the run's descriptor didn't carry one. */
  opId: string | null;
}

/** The whole live picture: the counter/queue depth plus a detail entry per in-flight run. */
export interface GateSnapshot {
  active: number;
  queued: number;
  entries: GateSnapshotEntry[];
}

/** Internal registry row: `startedAt` is null while queued, stamped at admission. `priority` is retained
 *  so {@link GateSemaphore.snapshot} can order queued entries in the real high-then-low admission order. */
interface RegistryEntry {
  id: string;
  descriptor: GateDescriptor;
  priority: GatePriority;
  enqueuedAt: number;
  startedAt: number | null;
}

export class GateSemaphore {
  private active = 0;
  private readonly highWaiters: (() => void)[] = [];
  private readonly lowWaiters: (() => void)[] = [];
  // Live metadata registry, keyed by a per-run id. Iteration order is enqueue order; the snapshot re-orders
  // queued entries by (priority, enqueuedAt) to match the real admission order below.
  private readonly registry = new Map<string, RegistryEntry>();
  private seq = 0;
  // Card 424ed9a8: the last `cap` value this semaphore actually observed a caller pass, so a change in
  // the daemon-global `orchestration.maxConcurrentGates` (resolved fresh by every call site) is logged
  // the moment the semaphore itself sees the new value — not merely when config is written, which is a
  // DIFFERENT (and previously unrecorded) moment. `undefined` until the first `runExclusive` call, so
  // boot's own initial cap never logs a spurious "transition" from nothing.
  private lastKnownCap: number | undefined;

  /** Acquire a slot under `cap`, queueing (awaiting) if it's already saturated — onto the `"high"` or
   *  `"low"` tier per `priority`. On admission stamps the entry's `startedAt` so the registry can
   *  distinguish running from queued (and expose the run's start for a `durationMs` measurement). The
   *  `active`/tier mutation is unchanged from the pre-registry version — the only addition is the stamp. */
  private acquire(cap: number, priority: GatePriority, entry: RegistryEntry): Promise<void> {
    if (this.active < cap) {
      this.active++;
      entry.startedAt = Date.now();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = () => {
        this.active++;
        entry.startedAt = Date.now();
        resolve();
      };
      (priority === "high" ? this.highWaiters : this.lowWaiters).push(waiter);
    });
  }

  /** Release a held slot, handing it directly to the next queued waiter (if any) rather than letting a
   *  fresh `acquire` race it — drains ALL of `highWaiters` before touching `lowWaiters`, FIFO within
   *  each tier. */
  private release(): void {
    this.active--;
    const next = this.highWaiters.shift() ?? this.lowWaiters.shift();
    if (next) next();
  }

  /**
   * Run `fn` holding one of `cap` concurrent slots — awaits a slot first (queueing past `cap`, ordered
   * by `priority`), then releases it once `fn` settles, whether it resolves or rejects. `cap` is read
   * fresh on every call (mirrors the "RESOLVE-LIVE" config reads at each call site), so a human PATCH to
   * `orchestration.maxConcurrentGates` takes effect on the very next gate run with no daemon restart.
   * `priority` defaults to `"high"` so an untouched/future call site behaves exactly as before card
   * 24642c3d (every caller was implicitly equal-priority FIFO).
   *
   * `fn` receives the entry's admission timestamp (`startedAt`) so the caller can compute a `durationMs`
   * for its audit event that reflects the actual RUN time (settle − admission), excluding queue wait.
   *
   * The registry entry is added up front and deleted in `finally` — which runs on admission-then-settle,
   * a throwing `fn`, and a timing-out `fn` alike — so no in-flight metadata ever leaks. `release()` is
   * gated on `acquired` so a slot is only ever released if one was actually taken (defensive: `acquire`
   * doesn't reject today, but this keeps the counter correct if that ever changes).
   */
  async runExclusive<T>(
    cap: number, descriptor: GateDescriptor, fn: (startedAt: number) => Promise<T>, priority: GatePriority = "high",
  ): Promise<T> {
    // TRANSITION LOG (card 424ed9a8): fires exactly when THIS semaphore observes `cap` change from what
    // it last saw — i.e. what a gate run actually adopted, not merely what was written to config (those
    // can differ: a write with no gate call in between never shows up here, and that's correct — nothing
    // ever ADOPTED it). Skipped on the very first call (`lastKnownCap` still undefined) so boot's initial
    // cap is a plain fact, not a transition from nothing.
    if (this.lastKnownCap !== undefined && this.lastKnownCap !== cap) {
      console.log(`[gate] maxConcurrentGates ${this.lastKnownCap} -> ${cap}`);
    }
    this.lastKnownCap = cap;
    const entry: RegistryEntry = { id: `gate-${++this.seq}`, descriptor, priority, enqueuedAt: Date.now(), startedAt: null };
    this.registry.set(entry.id, entry);
    let acquired = false;
    try {
      await this.acquire(cap, priority, entry);
      acquired = true;
      return await fn(entry.startedAt!);
    } finally {
      this.registry.delete(entry.id);
      if (acquired) this.release();
    }
  }

  /** A point-in-time snapshot of every in-flight gate run — the source for the Gates page's active
   *  lane-hero. Read-only: derives phase/queue-position from the registry without touching admission.
   *  Queued entries are ordered by the REAL admission order (all high before low, FIFO within a tier),
   *  so the UI's queue positions match what `release()` will actually admit next. */
  snapshot(): GateSnapshot {
    const running: RegistryEntry[] = [];
    const queued: RegistryEntry[] = [];
    for (const e of this.registry.values()) (e.startedAt != null ? running : queued).push(e);
    queued.sort((a, b) => {
      const pa = a.priority === "high" ? 0 : 1;
      const pb = b.priority === "high" ? 0 : 1;
      return pa !== pb ? pa - pb : a.enqueuedAt - b.enqueuedAt;
    });
    const toEntry = (e: RegistryEntry, phase: "running" | "queued", queuePosition: number | null): GateSnapshotEntry => ({
      id: e.id,
      gateType: e.descriptor.gateType,
      projectId: e.descriptor.projectId,
      sessionId: e.descriptor.sessionId,
      taskId: e.descriptor.taskId ?? null,
      branch: e.descriptor.branch ?? null,
      phase,
      since: phase === "running" ? e.startedAt! : e.enqueuedAt,
      queuePosition,
      opId: e.descriptor.opId ?? null,
    });
    const entries: GateSnapshotEntry[] = [
      ...running.map((e) => toEntry(e, "running", null)),
      ...queued.map((e, i) => toEntry(e, "queued", i + 1)),
    ];
    return { active: this.active, queued: this.highWaiters.length + this.lowWaiters.length, entries };
  }

  /** Look up ONE live (running or queued) gate run by its {@link GateDescriptor.opId} — the read path for
   *  `gate_status(opId)` (card edc1ec12; prefix support added by card 225bc7bd). Accepts EITHER a full
   *  opId OR an unambiguous id-PREFIX (the 8-char short id Loom displays everywhere else — the same
   *  `resolveIdPrefix` resolution `agent_get`/`worker_spawn` already use), so a caller pasting the short id
   *  it was shown gets a real answer instead of a spurious miss. `kind:"found"` on a unique match;
   *  `kind:"ambiguous"` (with the matching opIds) when the prefix matches more than one LIVE entry —
   *  callers must surface this distinctly, never fold it into "not found"; `kind:"none"` when nothing
   *  matches at all — either the op already settled (the caller should instead rely on the eventual
   *  `[loom:gate-*]`/`[loom:merge-*]` nudge) or it never existed; this lookup genuinely cannot tell those
   *  two apart, but BOTH are a real "no live run", unlike the ambiguous case. Entries with no `opId` (a run
   *  whose descriptor never carried a correlating one) are excluded from the candidate set entirely, so
   *  they can never spuriously satisfy a prefix match. O(n) over the live registry, which is bounded by
   *  `maxConcurrentGates` + queue depth — never large enough to matter.
   *
   *  `scopeSessionId` (card fc243a43 — the worker-facing `gate_status`) restricts the CANDIDATE SET itself
   *  to entries whose `descriptor.sessionId` matches, BEFORE prefix resolution runs — not just a post-hoc
   *  filter on the result. A scoped caller's `ambiguous`/`none` outcomes are therefore computed only over
   *  ITS OWN live ops: it can never learn that a same-prefix op exists under another session (no count, no
   *  ids leak). Omitted (every pre-existing manager call site), this is byte-identical to before the param
   *  existed. */
  findByOpId(opId: string, scopeSessionId?: string): IdPrefixResult<GateSnapshotEntry> {
    const candidates = this.snapshot().entries
      .filter((e): e is GateSnapshotEntry & { opId: string } => e.opId != null)
      .filter((e) => scopeSessionId == null || e.sessionId === scopeSessionId)
      .map((e) => ({ id: e.opId, entry: e }));
    const r = resolveIdPrefix(candidates, opId);
    if (r.kind === "found") return { kind: "found", record: r.record.entry };
    if (r.kind === "ambiguous") return { kind: "ambiguous", ids: r.ids };
    return { kind: "none" };
  }
}
