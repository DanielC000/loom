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
 * `SessionService.snapshotGates`). Each `runExclusive` REQUIRES a {@link GateDescriptor} (a required
 * param, so the compiler forces every call site to supply one — no silent gaps), and the registry entry
 * is added before acquisition and removed in a `finally` that fires on EVERY exit path
 * (admission-then-settle, a `fn` that throws, a `fn` that times out), so a leaked "phantom active gate"
 * can never accumulate.
 *
 * ⚠️ AS OF CARD 8d585277 THE REGISTRY IS NO LONGER PURE METADATA — it is also where per-worktree
 * exclusivity is decided: `descriptor.worktreePath` (when set) gates admission via `activeWorktrees`
 * (`acquire`/`admit`/`release`/`grantNext` below), so two runs bound to the SAME worktree can never both
 * be RUNNING at once, regardless of `cap`/tier. This is a deliberate, load-bearing exception to the
 * historical "additive only" framing above — do not assume the registry is side-effect-free just because
 * this comment once said so elsewhere in this file.
 *
 * CANCELLATION (card 8d585277): a QUEUED entry can be withdrawn (`cancelQueued`/`cancelQueuedForSession`)
 * with ZERO process risk — `fn` was never invoked, so there is nothing to kill. An ALREADY-RUNNING entry
 * can only be ASKED to stop (`cancelRunning`, aborting its `controller`) — whether it actually does, and
 * how verifiably, is entirely up to what `fn` does with the signal it's handed; this class has no
 * process-level knowledge at all. See `SessionService.cancelGateOp`/`runWorkerGate` for where the actual
 * kill + verified-death tagging happens.
 */

import type { GateType } from "@loom/shared";
import { resolveIdPrefix, type IdPrefixResult } from "../id-prefix.js";
import type { GateLivenessHooks } from "./gate-runner.js";

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
  /**
   * Card 8d585277: the worktree this run is bound to, when it's bound to one at all — a worker self-check
   * or a merge gate both name the SAME worktree (the worker's own), which is exactly what makes this a
   * useful exclusivity key; a deploy gate (runs in the project's canonical repoPath, not a worker
   * worktree) has none.
   *
   * ⚠️ `null`/`undefined` MEANS "NO EXCLUSIVITY GROUP" — NEVER a shared group with every other
   * worktreePath-less run. Every admission/grant check below is written `wt == null || …` for exactly
   * this reason: treating `undefined` as one common key would silently serialize every deploy gate (or
   * any future worktree-less gate type) against every OTHER worktree-less gate, cutting their real
   * throughput in half with no user-visible error — a naive `Map<string, …>` keyed by a stringified
   * `undefined` is the shape of bug this guards against. Covered by a dedicated regression test (two
   * worktree-less ops must co-run at cap headroom).
   */
  worktreePath?: string | null;
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
  /** Epoch-ms of the CURRENT step's last liveness event — the SAME `lastOutputAt` clock
   *  {@link GateLivenessHooks} mirrors from `gate-runner.ts`'s own auto-extend decision, never a second,
   *  independently-derived one (see that file's `GateLivenessHooks` doc for why). Stamped the instant a
   *  step actually STARTS (`onStepStart`, mirroring `runGateStep`'s own `lastOutputAt = performance.now()`
   *  at the top of its promise body — i.e. before the child even spawns), then advanced forward on every
   *  `onOutput` — never null merely because no output has arrived yet once the step has genuinely begun (a
   *  step that hasn't printed anything is legitimately "idle since it started", which is real information,
   *  not an absence). Null while `queued` (no step has started at all) AND, for a caller with real async
   *  work between admission and its OWN `runGateSequential` call (e.g. `run_gate`'s pre-flight git-stamp
   *  read in `runWorkerGate` — `confirmWorkerMerge`/`deployOwnProject` have no such gap, they invoke the
   *  runner synchronously on admission), for the brief window between admission and that call — this
   *  entry is genuinely `phase:"running"` during that window with NOTHING yet to report, which is exactly
   *  why `null` (not a fabricated `0`) is correct there too. A caller computes idle time as
   *  `Date.now() - lastOutputAt` when non-null, matching how `since`/`elapsedMs` are derived elsewhere in
   *  this codebase (raw epoch-ms here, `now - stamp` at the read site). A LARGE elapsed time (`since`) is
   *  frequently HEALTHY (see `GATE_EXTEND_IDLE_MS`'s doc: a gate still producing output gets its timeout
   *  extended rather than killed) — idle time, not elapsed time, is what actually distinguishes "working
   *  hard" from "hung". */
  lastOutputAt: number | null;
  /** True once the CURRENT step's timeout has already been auto-extended once (see `GATE_EXTEND_IDLE_MS`'s
   *  doc — the extension is `!extended`-gated and fires AT MOST ONCE per step). Resets to `false` at the
   *  start of every new step in a multi-step `gateCommand`, mirroring `runGateStep`'s own per-step
   *  `extended` flag exactly — this is per-STEP state, not a whole-run total. Always `false` while queued. */
  extended: boolean;
}

/** The whole live picture: the counter/queue depth plus a detail entry per in-flight run. */
export interface GateSnapshot {
  active: number;
  queued: number;
  entries: GateSnapshotEntry[];
}

/** Internal registry row: `startedAt` is null while queued, stamped at admission. `priority` is retained
 *  so {@link GateSemaphore.snapshot} can order queued entries in the real high-then-low admission order.
 *  `controller` (card 8d585277) is created unconditionally for EVERY run, admitted or not — cheap (a
 *  plain object), and it's what {@link GateSemaphore.cancelRunning} aborts to signal a running `fn`; a
 *  caller whose `fn` never reads the signal (e.g. `deployOwnProject`'s callback ignores its 2nd param, as
 *  TS permits) is simply never interrupted by it — byte-identical to before this field existed. */
interface RegistryEntry {
  id: string;
  descriptor: GateDescriptor;
  priority: GatePriority;
  enqueuedAt: number;
  startedAt: number | null;
  controller: AbortController;
  /** See {@link GateSnapshotEntry.lastOutputAt} — null until the running `fn`'s `GateLivenessHooks` first
   *  reports a step start/output, updated in lockstep with `gate-runner.ts`'s own internal clock. */
  lastOutputAt: number | null;
  /** See {@link GateSnapshotEntry.extended} — mirrors the CURRENT step's `runGateStep` `extended` flag. */
  extended: boolean;
  /** Card c6750500: the HIGHEST `active` count observed at any point WHILE this entry has held a slot —
   *  i.e. the true max-concurrent-over-run, not just at-admission. `0` while queued (never admitted).
   *  Updated ONLY inside {@link GateSemaphore.admit}, which is the ONLY place `active` can ever INCREASE —
   *  a release can only decrease it, so it can never raise anyone's max, and no separate bookkeeping is
   *  needed there. On every admission, EVERY currently-running entry's `maxConcurrent` (not just the one
   *  just admitted) is bumped to `max(current, active)` — this is what correctly captures "admitted alone,
   *  joined mid-run": the joined entry's OWN recorded max must reflect the join too, not just the joiner's.
   *  Frozen (no further updates possible) the instant this entry is removed from {@link registry} — see
   *  {@link runExclusive}'s `finally`, which deletes before releasing, so no other admission can ever touch
   *  a completed entry's value again. This is a derived-from-admit/release bookkeeping field, NOT a
   *  polling sample — no timer is involved, so no transition between updates can ever be missed. */
  maxConcurrent: number;
}

/** One reason a queued/running gate op can be cancelled (card 8d585277): `"superseded-by-merge"` is the
 *  AUTOMATIC, no-human-judgement path (a manager's `worker_merge_confirm` reclaiming its own worker's
 *  now-moot QUEUED self-check — see {@link GateSemaphore.cancelQueuedForSession}); `"manual"` is the
 *  explicit `gate_cancel` tool a manager invokes for a case auto-supersede does not cover (a known-failing
 *  base, a stale/superseded self-check, etc.). Threaded through so a caller several layers up
 *  (SessionService's settle-nudge text) can tell a manager-decided supersede apart from a manager's
 *  explicit cancel without re-deriving it from free text.
 */
export type GateCancelKind = "superseded-by-merge" | "manual";

/**
 * Thrown by {@link GateSemaphore.runExclusive} when a QUEUED op is cancelled before it was ever admitted —
 * `fn` is NEVER invoked in this case (no process was ever spawned), so this is always a zero-process-risk
 * cancellation. A caller catches this specifically (never lets it fall through to generic error handling,
 * which would misreport a deliberate cancel as a genuine runner exception) and resolves its own result with
 * a distinct `cancelled` shape instead of rethrowing — see SessionService.runWorkerGate's own catch.
 */
export class GateCancelledError extends Error {
  constructor(public readonly kind: GateCancelKind, public readonly detail: string) {
    super(`gate cancelled (${kind}): ${detail}`);
    this.name = "GateCancelledError";
  }
}

/** One waiter parked in `highWaiters`/`lowWaiters` — `id` mirrors its {@link RegistryEntry.id} so
 *  {@link GateSemaphore.cancelQueued} can find and splice out ONE specific waiter (not just shift the
 *  head), and `entry` lets {@link GateSemaphore.grantNext} read its `descriptor.worktreePath` to decide
 *  eligibility without a second lookup. `grant`/`cancel` are the ONLY two ways a queued waiter's promise
 *  ever settles — never both for the same waiter (whichever fires first is final; the other can't reach a
 *  waiter that's already been spliced out of its array). */
interface Waiter {
  id: string;
  entry: RegistryEntry;
  grant: () => void;
  cancel: (kind: GateCancelKind, detail: string) => void;
}

/** {@link GateSemaphore}'s private `acquire()` outcome — `admitted:false` carries the SAME
 *  {@link GateCancelledError} shape `runExclusive` throws, so that call site is a one-line translation. */
type AcquireOutcome = { admitted: true } | { admitted: false; kind: GateCancelKind; detail: string };

export class GateSemaphore {
  private active = 0;
  private readonly highWaiters: Waiter[] = [];
  private readonly lowWaiters: Waiter[] = [];
  /** Card 8d585277: the set of worktree paths currently held by a RUNNING (admitted) entry — the
   *  structural per-worktree exclusivity guard. Only ever populated/consulted for a NON-NULL
   *  `descriptor.worktreePath` (see every read/write site below, all guarded `wt != null`) — a
   *  worktree-less run never touches this set at all, which is exactly what keeps `undefined` from ever
   *  behaving like a shared group (see `GateDescriptor.worktreePath`'s own doc). */
  private readonly activeWorktrees = new Set<string>();
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

  /** True when `entry` is free to be admitted RIGHT NOW with respect to the per-worktree exclusivity
   *  guard alone (card 8d585277) — a worktree-less descriptor (`wt == null`) is ALWAYS eligible, never
   *  blocked by this check; a worktree-bound one is eligible only while no OTHER running entry holds the
   *  same path. Does not consider `cap`/`active` — callers combine this with that separately. */
  private worktreeFree(entry: RegistryEntry): boolean {
    const wt = entry.descriptor.worktreePath;
    return wt == null || !this.activeWorktrees.has(wt);
  }

  /** Actually admit `entry`: stamps `startedAt`, bumps `active`, and — for a worktree-bound descriptor
   *  only — claims its worktree in {@link activeWorktrees}. The one and only place either mutation
   *  happens, shared by the immediate fast path and a queued waiter's eventual grant. */
  private admit(entry: RegistryEntry): void {
    this.active++;
    entry.startedAt = Date.now();
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.add(wt);
    // Card c6750500: an admission is the ONLY event that can raise `active` — a release only ever lowers
    // it — so it's the only place a running entry's max-over-run can change. Bump EVERY currently-running
    // entry (this newly-admitted one included, since it's already in `registry` with `startedAt` set
    // above), not just the one just admitted: an entry admitted solo and joined 10 minutes later must have
    // ITS OWN `maxConcurrent` reflect that join, which is exactly the defect this card fixes.
    for (const e of this.registry.values()) {
      if (e.startedAt != null && this.active > e.maxConcurrent) e.maxConcurrent = this.active;
    }
  }

  /** Acquire a slot under `cap`, queueing (awaiting) if it's already saturated OR its worktree is
   *  currently held by another running entry — onto the `"high"` or `"low"` tier per `priority`. A
   *  worktree conflict queues the caller even when `cap` has spare headroom (card 8d585277's structural
   *  guard: same-worktree ops serialize regardless of tier or cap) — see {@link grantNext} for how a
   *  worktree-blocked waiter is later found and admitted once its worktree frees up, out of arrival
   *  order if necessary. */
  private acquire(cap: number, priority: GatePriority, entry: RegistryEntry): Promise<AcquireOutcome> {
    if (this.active < cap && this.worktreeFree(entry)) {
      this.admit(entry);
      return Promise.resolve({ admitted: true });
    }
    return new Promise<AcquireOutcome>((resolve) => {
      const waiter: Waiter = {
        id: entry.id,
        entry,
        grant: () => { this.admit(entry); resolve({ admitted: true }); },
        cancel: (kind, detail) => resolve({ admitted: false, kind, detail }),
      };
      (priority === "high" ? this.highWaiters : this.lowWaiters).push(waiter);
    });
  }

  /** Release a held slot (identified by the SAME entry `runExclusive` admitted, so its worktree — if any
   *  — can be freed from {@link activeWorktrees} too), then hand the freed slot to the next ELIGIBLE
   *  waiter via {@link grantNext}. */
  private release(entry: RegistryEntry): void {
    this.active--;
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.delete(wt);
    this.grantNext();
  }

  /** Grant exactly ONE freed slot to the next eligible waiter — drains `highWaiters` before touching
   *  `lowWaiters`, same as before card 8d585277, but WITHIN a tier this no longer blindly `.shift()`s the
   *  head: it scans for the first waiter whose worktree (if any) isn't STILL held by some other running
   *  entry, skipping past a worktree-blocked head-of-line waiter to admit a later, eligible one instead —
   *  the mechanism that makes the per-worktree guard compose with the existing priority queue rather than
   *  deadlocking behind it. A worktree-less waiter is never skipped by this check (see `worktreeFree`).
   *  Grants at most one waiter per call, matching `release()`'s own one-slot-freed contract — unchanged
   *  from before this card. */
  private grantNext(): void {
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      for (let i = 0; i < tier.length; i++) {
        const w = tier[i]!;
        if (!this.worktreeFree(w.entry)) continue;
        tier.splice(i, 1);
        w.grant();
        return;
      }
    }
  }

  /**
   * Run `fn` holding one of `cap` concurrent slots — awaits a slot first (queueing past `cap`, ordered
   * by `priority`, and past a per-worktree conflict regardless of `cap` — card 8d585277), then releases
   * it once `fn` settles, whether it resolves or rejects. `cap` is read fresh on every call (mirrors the
   * "RESOLVE-LIVE" config reads at each call site), so a human PATCH to `orchestration.maxConcurrentGates`
   * takes effect on the very next gate run with no daemon restart. `priority` defaults to `"high"` so an
   * untouched/future call site behaves exactly as before card 24642c3d (every caller was implicitly
   * equal-priority FIFO).
   *
   * `fn` receives the entry's admission timestamp (`startedAt`) AND a `cancelSignal` (card 8d585277) —
   * aborted by {@link cancelRunning} to ask an ALREADY-ADMITTED `fn` to stop; a caller whose `fn` never
   * reads this second parameter (every pre-8d585277 call site — TS permits a callback to ignore trailing
   * params) is simply never interruptible this way, byte-identical to before this existed.
   *
   * A QUEUED caller can be cancelled before ever being admitted (see {@link cancelQueued}/
   * {@link cancelQueuedForSession}) — `fn` is NEVER invoked in that case; this method translates that into
   * a thrown {@link GateCancelledError} instead, so a caller's own try/catch decides how to represent "no
   * verdict" rather than this class doing it for them.
   *
   * The registry entry is added up front and deleted in `finally` — which runs on admission-then-settle,
   * a throwing `fn`, and a timing-out `fn` alike — so no in-flight metadata ever leaks. `release()` is
   * gated on `acquired` so a slot is only ever released if one was actually taken.
   *
   * `fn` ALSO receives a third param, {@link GateLivenessHooks} — a caller whose `fn` forwards it into its
   * own `runGateSequential`/`runGateStep` call lets THIS entry's `lastOutputAt`/`extended` mirror that
   * run's real liveness (see {@link GateSnapshotEntry.lastOutputAt}'s doc for why this must be a mirror of
   * the runner's own clock, never a second one computed here). A caller whose `fn` ignores it (ever pre-
   * existing call site — TS permits a callback to omit trailing params) simply leaves `lastOutputAt` null
   * and `extended` false forever, byte-identical to before this parameter existed.
   *
   * `fn` ALSO receives a fourth param (card c6750500), `getMaxConcurrentGates`: a live getter reading THIS
   * entry's {@link RegistryEntry.maxConcurrent} directly off the closed-over `entry` object — NOT a
   * registry lookup by id, which is deliberate: it stays correct even called AFTER this entry has already
   * been deleted from {@link registry} in the `finally` below (the value is frozen at that point anyway,
   * since no further admission can touch a deleted entry). A caller can therefore capture the getter
   * reference inside `fn` and call it any time after — even outside `fn`, once `runExclusive` itself has
   * resolved — and always read the true final max-over-run. A caller whose `fn` ignores it (every call
   * site that predates this param) is byte-identical to before it existed.
   */
  async runExclusive<T>(
    cap: number, descriptor: GateDescriptor,
    fn: (startedAt: number, cancelSignal: AbortSignal, hooks: GateLivenessHooks, getMaxConcurrentGates: () => number) => Promise<T>,
    priority: GatePriority = "high",
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
    const entry: RegistryEntry = {
      id: `gate-${++this.seq}`, descriptor, priority, enqueuedAt: Date.now(), startedAt: null,
      controller: new AbortController(), lastOutputAt: null, extended: false, maxConcurrent: 0,
    };
    this.registry.set(entry.id, entry);
    // Card c6750500: closes over `entry` directly (not a registry lookup), so it reads correctly even
    // after this entry is deleted from `registry` in the `finally` below — see this method's own doc.
    const getMaxConcurrentGates = (): number => entry.maxConcurrent;
    // Mirrors gate-runner.ts's own per-step lastOutputAt/extended state into this entry — see
    // GateLivenessHooks' doc. onStepStart resets BOTH (a fresh step's own state starts clean, matching
    // runGateStep's local vars exactly), onOutput/onExtend update forward as the step actually runs.
    const hooks: GateLivenessHooks = {
      onStepStart: () => { entry.lastOutputAt = Date.now(); entry.extended = false; },
      onOutput: () => { entry.lastOutputAt = Date.now(); },
      onExtend: () => { entry.extended = true; },
    };
    let acquired = false;
    try {
      const outcome = await this.acquire(cap, priority, entry);
      if (!outcome.admitted) throw new GateCancelledError(outcome.kind, outcome.detail);
      acquired = true;
      return await fn(entry.startedAt!, entry.controller.signal, hooks, getMaxConcurrentGates);
    } finally {
      this.registry.delete(entry.id);
      if (acquired) this.release(entry);
    }
  }

  /** Cancel a QUEUED (never-admitted) entry by its registry `id` — removes its waiter from whichever tier
   *  holds it and resolves it as cancelled instead of granted. Zero process risk BY CONSTRUCTION: a queued
   *  entry has never had `fn` invoked, so there is no child process this could ever need to kill. Returns
   *  `false` (no-op) if `id` isn't currently queued — already admitted, already settled, or never existed
   *  — the caller's own `runExclusive` throw/return path is what actually produces the visible outcome.
   *
   *  ⚠️ THE REAL INVARIANT (Code Review re-review of 8d585277, card 8f58c354; RE-STATED, card 361520a0
   *  Half Two CR follow-up): a `gateType` is cancellable HERE only once its `runExclusive` caller has a
   *  `GateCancelledError` catch to turn a withdrawn admission into a clean settle instead of a crash-shaped
   *  throw (see `SessionService.cancelGateOp`'s own doc for the exact failure this prevents) — `worker`
   *  (`runWorkerGate`) and, since card 361520a0, `merge` (`confirmWorkerMerge`) both have one; `deploy`
   *  (`deployOwnProject`) does NOT yet. THIS IS DELIBERATELY AN ALLOWLIST, NOT A DENYLIST — a card 361520a0
   *  CR finding caught an earlier draft written as `gateType === "deploy"`, which flips fail-closed into
   *  fail-open: a FOURTH `GateType` added later would be silently CANCELLABLE by default (allowed by a
   *  denylist that never named it) instead of refused until its own caller is proven to have the catch. The
   *  `switch` below is exhaustive over {@link GateType} — TypeScript raises a COMPILE ERROR at the `never`
   *  assignment in `default` the moment a new member is added to that union, forcing an explicit decision
   *  here rather than a silent permission grant. Enforced HERE, at the primitive, so a future third caller
   *  of this method inherits the SAME fail-closed default automatically instead of having to remember to
   *  re-derive it — the existing caller-side guards (`cancelGateOp`, `cancelQueuedForSession`'s own
   *  `gateType` match) stay in place; this is defence-in-depth, not a replacement for them. */
  cancelQueued(id: string, kind: GateCancelKind, detail: string): boolean {
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      const idx = tier.findIndex((w) => w.id === id);
      if (idx !== -1) {
        const gateType = tier[idx]!.entry.descriptor.gateType;
        switch (gateType) {
          case "worker":
          case "merge":
            break; // has a GateCancelledError catch — see this method's own doc
          case "deploy":
            return false;
          default: {
            // UNREACHABLE in correctly-typed code — TypeScript rejects this assignment the moment
            // GateType grows a member this switch doesn't name (the compile-time enforcement this doc
            // describes). Falls back to `false` (refuse), never a throw: this method's whole contract is
            // "returns boolean, never throws" — throwing here would itself BE a crash-shaped failure, the
            // exact class this guard exists to prevent, over a runtime path that should be unreachable.
            const exhaustive: never = gateType;
            void exhaustive;
            return false;
          }
        }
        const [w] = tier.splice(idx, 1);
        w!.cancel(kind, detail);
        return true;
      }
    }
    return false;
  }

  /** Convenience wrapper over {@link cancelQueued} for the auto-supersede path (card 8d585277): find the
   *  (at most one, by construction — a session has at most one outstanding op per key) QUEUED entry for
   *  `sessionId`/`gateType`/`projectId` and cancel it. Deliberately does nothing for an already-RUNNING
   *  entry — see the call site's own doc for why the automatic path is scoped to queued-only.
   *
   *  `projectId` (Code Review finding B2-1): REQUIRED, not optional — matched against the descriptor's
   *  OWN `projectId` (server-derived at the ORIGINAL `runExclusive` call, never caller-supplied), exactly
   *  mirroring `SessionService.cancelGateOp`'s existing project check. Without this, a caller could
   *  supersede a DIFFERENT project's queued self-check merely by naming that project's worker session id —
   *  the ownership check that's supposed to guard this (`confirmWorkerMerge`'s "not your worker") lives
   *  DEEPER in the call chain than this method's own caller, so this method cannot assume its caller was
   *  already authorized by the time it runs; it must enforce its own scope. */
  cancelQueuedForSession(sessionId: string, gateType: GateType, projectId: string, kind: GateCancelKind, detail: string): { cancelled: boolean; opId?: string } {
    for (const e of this.registry.values()) {
      if (e.startedAt == null && e.descriptor.sessionId === sessionId && e.descriptor.gateType === gateType && e.descriptor.projectId === projectId) {
        if (this.cancelQueued(e.id, kind, detail)) return { cancelled: true, opId: e.descriptor.opId };
      }
    }
    return { cancelled: false };
  }

  /** Ask an ALREADY-RUNNING entry (by registry `id`) to stop, by aborting its `controller` — this is a
   *  REQUEST, not a guarantee: whether (and how fast, and how verifiably) the run actually stops depends
   *  entirely on whether its own `fn` reads `cancelSignal` and how it responds (see
   *  `SessionService.runWorkerGate`'s wiring into `runGateSequential`/`runGateStep`, which is where the
   *  actual process-tree kill + verified-death tagging happens — this method has no process-level
   *  knowledge at all). Returns `false` if `id` isn't currently running (queued, already settled, or never
   *  existed) — the caller decides what that means for its own outcome. */
  cancelRunning(id: string, detail: string): boolean {
    const entry = this.registry.get(id);
    if (!entry || entry.startedAt == null) return false;
    entry.controller.abort(detail);
    return true;
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
      lastOutputAt: e.lastOutputAt,
      extended: e.extended,
    });
    const entries: GateSnapshotEntry[] = [
      ...running.map((e) => toEntry(e, "running", null)),
      ...queued.map((e, i) => toEntry(e, "queued", i + 1)),
    ];
    return { active: this.active, queued: this.highWaiters.length + this.lowWaiters.length, entries };
  }

  /** Look up ONE live (running or queued) gate run by its {@link GateDescriptor.opId} — the LIVE-registry
   *  half of `gate_status(opId)` (card edc1ec12; prefix support added by card 225bc7bd). Accepts EITHER a
   *  full opId OR an unambiguous id-PREFIX (the 8-char short id Loom displays everywhere else — the same
   *  `resolveIdPrefix` resolution `agent_get`/`worker_spawn` already use), so a caller pasting the short id
   *  it was shown gets a real answer instead of a spurious miss. `kind:"found"` on a unique match;
   *  `kind:"ambiguous"` (with the matching opIds) when the prefix matches more than one LIVE entry —
   *  callers must surface this distinctly, never fold it into "not found"; `kind:"none"` when nothing
   *  matches at all — either the op already settled, it never existed, or it hasn't registered with this
   *  semaphore yet; this lookup, being LIVE-ONLY, genuinely cannot tell those apart on its own, but BOTH
   *  are a real "no live run", unlike the ambiguous case. Card e3e40167: `SessionService.gateStatus`, the
   *  caller of this method, now resolves that ambiguity itself — a `kind:"none"` here falls through to a
   *  SECOND, identically-scoped lookup against the durable `pending_gate_ops` tombstone table
   *  (`Db.findPendingGateOpByOpId`), which DOES distinguish settled/evicted/orphaned/never-minted. This
   *  method's own contract is unchanged by that — it still only ever answers about the LIVE registry.
   *  Entries with no `opId` (a run whose descriptor never carried a correlating one) are excluded from the
   *  candidate set entirely, so they can never spuriously satisfy a prefix match. O(n) over the live
   *  registry, which is bounded by `maxConcurrentGates` + queue depth — never large enough to matter.
   *
   *  `scopeSessionId` (card fc243a43 — the worker-facing `gate_status`) restricts the CANDIDATE SET itself
   *  to entries whose `descriptor.sessionId` matches, BEFORE prefix resolution runs — not just a post-hoc
   *  filter on the result. A scoped caller's `ambiguous`/`none` outcomes are therefore computed only over
   *  ITS OWN live ops: it can never learn that a same-prefix op exists under another session (no count, no
   *  ids leak). Omitted (every pre-existing manager call site), this is byte-identical to before the param
   *  existed.
   *
   *  `scopeProjectId` (Code Review finding B2-3, card 8d585277's `gate_cancel`) is the SAME kind of
   *  candidate-set restriction, keyed by project instead of session: when set, an id whose only matches
   *  (exact OR prefix) belong to a DIFFERENT project is filtered out before prefix resolution runs, so an
   *  `ambiguous` result can only ever name opIds within the caller's OWN project. `cancelGateOp` uses this
   *  on a SECOND, re-scoped call specifically to avoid the leak an UNSCOPED ambiguous resolution would
   *  otherwise expose (prefix-probing could otherwise enumerate other projects' live opIds via the
   *  `ambiguous` error's `ids` list) — see its own doc for why the first (unscoped) call is still made too,
   *  to preserve the informative `refused` outcome for a clean EXACT/unambiguous cross-project match.
   *  Independent of `scopeSessionId` (both apply as separate, AND-combined filters) — since card e3e40167,
   *  the worker-facing `gate_status` call site DOES pass both together (session AND its own project), so
   *  this is no longer merely a theoretical combination. Omitted, this is byte-identical to before the
   *  param existed. */
  findByOpId(opId: string, scopeSessionId?: string, scopeProjectId?: string): IdPrefixResult<GateSnapshotEntry> {
    const candidates = this.snapshot().entries
      .filter((e): e is GateSnapshotEntry & { opId: string } => e.opId != null)
      .filter((e) => scopeSessionId == null || e.sessionId === scopeSessionId)
      .filter((e) => scopeProjectId == null || e.projectId === scopeProjectId)
      .map((e) => ({ id: e.opId, entry: e }));
    const r = resolveIdPrefix(candidates, opId);
    if (r.kind === "found") return { kind: "found", record: r.record.entry };
    if (r.kind === "ambiguous") return { kind: "ambiguous", ids: r.ids };
    return { kind: "none" };
  }
}
