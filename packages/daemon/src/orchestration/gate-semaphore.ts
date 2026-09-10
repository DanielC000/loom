/**
 * Daemon-global, in-memory concurrency limiter for HEAVY, daemon-EXECUTED gate runs — the
 * merge-confirm gate (`confirmWorkerMerge`), the scoped-deploy gate (`deployOwnProject`), and the worker
 * DoD self-check (`runWorkerGate` / the `run_gate` tool), all of which invoke `runGateSequential` with an
 * arbitrary human-set build/test command. Bounds how many can run AT ONCE across every project.
 * @decision 301d8c01 — today that's enforced only by manager discipline (sequencing merges by hand), not
 *   code (docs/decisions/301d8c01-gate-semaphore-bounds-daemon-global-heavy-gate-concurrency.md)
 *
 * @decision fb8df559 — a caller that can't acquire a slot QUEUES rather than being rejected, composing
 *   with PendingOpRegistry's client-timeout resilience with no separate handling needed; daemon-local,
 *   in-memory, no persistence to lose on restart (docs/decisions/fb8df559-worker-list-pendingmerge-is-additive-with-a-placeholder-spawn-row.md)
 *
 * @decision 24642c3d — PRIORITY QUEUE: `highWaiters` (merge/deploy) drain fully before `lowWaiters` (a
 *   worker's own `run_gate` self-check), FIFO within each tier; reorders the QUEUE only, no preemption of
 *   an already-RUNNING gate (docs/decisions/24642c3d-gate-priority-queue-two-tiers-no-preemption.md)
 *
 * @decision a1c86452 — LIVE REGISTRY (the Gates page): every in-flight run also records a small metadata
 *   `RegistryEntry` so the daemon can enumerate what is currently RUNNING and QUEUED
 *   (docs/decisions/a1c86452-gate-history-page-enrichment-is-one-join-not-an-n-plus-1.md)
 *
 * ⚠️ THE REGISTRY IS NOT PURE METADATA (card 8d585277) — `descriptor.worktreePath` (when set) also
 * gates ADMISSION via `activeWorktrees` (`acquire`/`admit`/`release`/`grantNext` below), so two runs bound
 * to the SAME worktree can never both be RUNNING at once. Do not assume it is side-effect-free.
 *
 * @decision 8d585277 — CANCELLATION: a QUEUED entry withdraws with ZERO process risk (`fn` never
 *   invoked); an ALREADY-RUNNING entry can only be ASKED to stop (`cancelRunning`) — see
 *   `SessionService.cancelGateOp`/`runWorkerGate` for the actual kill + verified-death tagging
 *   (docs/decisions/8d585277-gate-cancel-queued-zero-risk-running-worker-only.md)
 *
 * @decision 92e960d1 — PER-REPO MERGE ADMISSION: a second, narrower exclusivity guard on
 *   `descriptor.repoPath` (`merge`-kind only) via `activeMergeRepos`, composing with the worktree guard
 *   and priority queue the same way (docs/decisions/92e960d1-per-repo-merge-admission-guard.md)
 *
 * @decision 0196ba78 — SCOPE, MADE EXPLICIT: this is an ADMISSION-time mechanism, not a
 *   merge-OPERATION-wide one — a reuse-path or gateless merge never reaches `runExclusive` and is
 *   structurally invisible to it, deliberately, not an oversight
 *   (docs/decisions/0196ba78-per-repo-merge-guard-is-admission-time-not-operation-wide.md)
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
  /** Card 10fd660b — set ONLY by the batched-merge gate (`mergeBatch`, sessions/service.ts), so the Gates
   *  page's ACTIVE lane can render a batch as a batch instead of losing its identity line entirely (a
   *  batch descriptor carries `taskId:null`/`branch:null` by design). `batchBranches` is the REQUESTED
   *  branch-name set, known when the descriptor is built; `batchLandedCount` is the POST-ASSEMBLY landed
   *  count, known only once `runBatchedMerge` calls back into the gate — so it is spread onto a COPY of
   *  the descriptor at the `runExclusive` call site, never mutated in place. Both absent on every other
   *  gate (solo merge, worker self-check, deploy), which is what keeps those runs byte-identical. */
  batchBranches?: string[] | null;
  batchLandedCount?: number | null;
  /** @decision 19256231 — set only on a batch's per-branch fallback merge, carrying the batch's own
   *  opId; the "taskId:null/branch:null/workerLabel:Orchestrator" trick for finding a live batch op
   *  is structurally blind to these rows (docs/decisions/19256231-fallbackofbatchopid-marks-a-batch-fallback-merge.md) */
  fallbackOfBatchOpId?: string | null;
  /** @decision b9e07a4a — opId is the IDENTITY activeMergeRepos stores against repoPath, not merely
   *  forensics; also what makes a run findable by gate_status(opId) (card edc1ec12)
   *  (docs/decisions/b9e07a4a-repoguardonlyqueueentry-exists-and-hides-repopath.md) */
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
  /** @decision 92e960d1 — repoPath serializes same-repo merge gates; only partially closed by
   *  b798e706, closed for real by c24dd48a's holdRepoGuardOnExit hold-past-settle
   *  (docs/decisions/92e960d1-per-repo-merge-admission-guard.md) */
  repoPath?: string | null;
  /** @decision 99a1cf6f — attempt/priorAttemptMs distinguish a retry re-admission from a first wait;
   *  CORRECTED by 7ad12202 — attempt can reach 3, not capped at 2
   *  (docs/decisions/99a1cf6f-gatebaseinvalidated-is-a-real-verdict-never-cache-it.md) */
  attempt?: number;
  /** Card 99a1cf6f — present iff `attempt` is, alongside it: attempt 1's own measured wall-clock run time
   *  (`gateAttempt1DurationMs`, `sessions/service.ts`, captured the instant attempt 1's own admission
   *  settles) — carried onto the retry's descriptor so a manager reading `gate_status`/`gate_queue` while
   *  `phase:"queued"` sees, e.g., `attempt:2, priorAttemptMs:1129000` instead of a bare, contextless
   *  `queued`. Purely informational: never consulted by admission/queueing/squash logic itself. */
  priorAttemptMs?: number;
}

/** One live gate run in the snapshot — a `GateDescriptor` enriched with its lane phase + timing. */
export interface GateSnapshotEntry {
  id: string;
  gateType: GateType;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  branch: string | null;
  /** Echoed from {@link GateDescriptor.batchBranches} / {@link GateDescriptor.batchLandedCount} — see
   *  their shared doc. Null on every non-batched run. */
  batchBranches: string[] | null;
  batchLandedCount: number | null;
  /** Echoed from {@link GateDescriptor.fallbackOfBatchOpId} — see its own doc. Null on every run that
   *  isn't one of a batch's own per-branch fallback confirms (including the batch's OWN gate run). */
  fallbackOfBatchOpId: string | null;
  /** Echoed from {@link GateDescriptor.attempt} / {@link GateDescriptor.priorAttemptMs} — see their shared
   *  doc. Null/null on a first admission (every ordinary merge, worker self-check, and deploy gate);
   *  `2`/`<ms>` on either of `confirmWorkerMerge`'s own retries' re-admission. */
  attempt: number | null;
  priorAttemptMs: number | null;
  /** "running" once it holds a lane; "queued" while it's still waiting for one. */
  phase: "running" | "queued";
  /** Epoch-ms anchor for the UI's live elapsed clock: startedAt (running) or enqueuedAt (queued). */
  since: number;
  /** 1-based position in the ACTUAL admission order (all high waiters before low, FIFO within a tier —
   *  mirrors `release()`); null for a running entry. */
  queuePosition: number | null;
  /** Echoed from {@link GateDescriptor.opId} — see its doc; null when the run's descriptor didn't carry one. */
  opId: string | null;
  /** @decision 166ba5d9 — the null-while-running window before lastOutputAt is first stamped is
   *  proven bounded by gitOpMs, and separately MEASURED at sub-2s (card 33aa0291)
   *  (docs/decisions/166ba5d9-lastoutputat-null-window-is-bounded-and-measured.md) */
  lastOutputAt: number | null;
  /** True once the CURRENT step's timeout has already been auto-extended once (see `GATE_EXTEND_IDLE_MS`'s
   *  doc — the extension is `!extended`-gated and fires AT MOST ONCE per step). Resets to `false` at the
   *  start of every new step in a multi-step `gateCommand`, mirroring `runGateStep`'s own per-step
   *  `extended` flag exactly — this is per-STEP state, not a whole-run total. Always `false` while queued. */
  extended: boolean;
  /** @decision 92e960d1 — repoContended:true names ONE specific queued cause (a same-repo merge
   *  guard), so a free cap slot with a queued merge doesn't read as a bug
   *  (docs/decisions/92e960d1-per-repo-merge-admission-guard.md) */
  repoContended: boolean;
}

/** The whole live picture: the counter/queue depth plus a detail entry per in-flight run. */
export interface GateSnapshot {
  active: number;
  queued: number;
  entries: GateSnapshotEntry[];
}

/**
 * Card b9e07a4a Code Review: the identity of one {@link GateSemaphore.acquireRepoGuardOnly} caller — the
 * `db9b0130` inert-diff skip's own descriptor, mirroring {@link GateDescriptor}'s identity fields (minus
 * `gateType`/`worktreePath`/cap-related bits, none of which apply — this primitive never touches `cap` or
 * `activeWorktrees` at all, see `acquireRepoGuardOnly`'s own doc) so a repo-guard-only holder/waiter can be
 * labeled and redacted in `gate_queue` exactly like a real gate run. `opId` is REQUIRED here (unlike the
 * forensics-only, optional field on `GateDescriptor`) because it is what makes this entry findable by
 * `gate_cancel` — an opId-less repo-guard-only wait can still be acquired/released correctly (identity is
 * independently guaranteed by an internally-minted token, never this field), it just cannot be looked up
 * or cancelled by id.
 */
export interface RepoGuardOnlyDescriptor {
  repoPath: string;
  projectId: string;
  sessionId: string;
  taskId?: string | null;
  branch?: string | null;
  opId: string;
}

/**
 * @decision b9e07a4a — RepoGuardOnlyEntry exists because a repo-guard-only hold/wait was otherwise
 * invisible to gate_queue (a queued merge could report repoContended:true with zero running merges
 * visible anywhere) (docs/decisions/b9e07a4a-repoguardonlyqueueentry-exists-and-hides-repopath.md)
 */
export interface RepoGuardOnlyEntry {
  /** The waiter's OWN id (an internally-minted `rgo-N` token, never a caller-supplied value) — pass this,
   *  not `opId`, to {@link GateSemaphore.cancelRepoGuardOnlyWait}. */
  id: string;
  repoPath: string;
  /** "holding" while it actually holds the per-repo guard; "queued" while waiting for a same-repo holder
   *  (real gate OR another repo-guard-only op) to release it. */
  phase: "holding" | "queued";
  /** Epoch-ms anchor: since-acquired (holding) or since-enqueued (queued) — mirrors
   *  {@link GateSnapshotEntry.since}'s own phase-scoped meaning. */
  since: number;
  /** 1-based position within THIS repoPath's OWN repo-guard-only queue; null while holding. Deliberately
   *  scoped per-repoPath, not a global position — unlike `GateSnapshotEntry.queuePosition`, there is no
   *  single shared cap-ordered queue here (see `freeRepoPath`'s own doc on the priority-inversion this
   *  implies against `highWaiters`/`lowWaiters`). */
  queuePosition: number | null;
  opId: string | null;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  branch: string | null;
}

/**
 * Card 93b568e6: one `merge`-kind op currently past its own gate command but still holding
 * {@link activeMergeRepos} because its `fn` called `holdRepoGuardOnExit` (card c24dd48a) — i.e. it is
 * mid-squash. This op has ALREADY been deleted from {@link registry} (every `runExclusive` caller is,
 * unconditionally, in its `finally` — see that method's own doc), so {@link GateSemaphore.snapshot} never
 * sees it; and it was never an {@link acquireRepoGuardOnly} hold, so {@link repoGuardOnlyHolders}/
 * {@link repoGuardOnlySnapshot} never see it either (see that map's own doc for the exact disqualifying
 * clause). Before this existed, a squashing merge was enumerated NOWHERE — `gate_queue` read empty for it,
 * indistinguishable from "nothing is running". This type — and {@link GateSemaphore.squashOnlySnapshot} —
 * close that read gap. Purely a read-side mirror, same posture as {@link repoGuardOnlyHolders}'s own doc:
 * the actual admission state still lives in {@link activeMergeRepos} exactly as it always has.
 */
export interface SquashHolderEntry {
  repoPath: string;
  /** Epoch-ms this op's gate command settled and its repo hold began surviving past `release()`. */
  since: number;
  opId: string | null;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  branch: string | null;
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
  /** @decision b9e07a4a — activeMergeRepos is IDENTITY-aware (Map<repoPath,holderId>), not a bare Set —
   *  a Set couldn't tell "free" from "held by someone else", letting a failed/cancelled op's release
   *  delete a live sibling's hold (docs/decisions/b9e07a4a-repoguardonlyqueueentry-exists-and-hides-repopath.md) */
  private readonly activeMergeRepos = new Map<string, string>();
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

  /** @decision 96d5f76b — every activeMergeRepos mutation is logged with a monotonic timestamp taken
   *  AT the mutation, never reconstructed later from a settledAt that measurably postdates it
   *  (docs/decisions/96d5f76b-repo-guard-mutations-are-logged-at-the-mutation-not-reconstructed.md) */
  private logRepoGuardMutation(action: "add" | "delete", repoPath: string, opId: string | undefined, callSite: string): void {
    console.log(`[gate:repo-guard] ${action} repoPath=${repoPath} opId=${opId ?? "?"} site=${callSite} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
  }

  /** True when `entry` is free to be admitted RIGHT NOW with respect to the per-worktree exclusivity
   *  guard alone (card 8d585277) — a worktree-less descriptor (`wt == null`) is ALWAYS eligible, never
   *  blocked by this check; a worktree-bound one is eligible only while no OTHER running entry holds the
   *  same path. Does not consider `cap`/`active` — callers combine this with that separately. */
  private worktreeFree(entry: RegistryEntry): boolean {
    const wt = entry.descriptor.worktreePath;
    return wt == null || !this.activeWorktrees.has(wt);
  }

  /** Card 92e960d1: true when `entry` is free to be admitted RIGHT NOW with respect to the per-repo
   *  MERGE-admission guard alone — mirrors {@link worktreeFree}'s shape exactly, one level narrower in
   *  scope. Returns `true` immediately (never blocking) for anything that isn't itself a `merge`-kind
   *  descriptor with a `repoPath` — this is the STRUCTURAL half of "worker/deploy gates are out of
   *  scope" (DoD-2): even a future call site that accidentally sets `repoPath` on a `worker`/`deploy`
   *  descriptor has zero effect here, because the gateType check runs first. Does not consider
   *  `cap`/`active`/worktree — callers combine this with those separately, same composition
   *  {@link acquire}/{@link grantNext} already use for `worktreeFree`. */
  private mergeRepoFree(entry: RegistryEntry): boolean {
    if (entry.descriptor.gateType !== "merge") return true;
    const rp = entry.descriptor.repoPath;
    return rp == null || !this.activeMergeRepos.has(rp);
  }

  /** Card b9e07a4a Code Review: the identity {@link activeMergeRepos} stores for an `admit()`-ed entry —
   *  `entry.descriptor.opId` when the caller supplied one (every real `confirmWorkerMerge`/`runWorkerGate`
   *  call does — see {@link GateDescriptor.opId}'s own doc), else `entry.id` (the semaphore's own
   *  internal, always-unique registry id) as a safe fallback for a descriptor that omitted it (some
   *  test-only call shapes that never call `beginSquash`/`endSquash` externally) — NEVER a shared/
   *  ambiguous value either way. Centralized here so {@link admit}/{@link release} derive the IDENTICAL
   *  value from the IDENTICAL `entry`, by construction — the self-release path (`release`, which always
   *  has `entry` in hand) never depends on the external `opId` alone the way an EXTERNAL
   *  `beginSquash`/`endSquash(repoPath, opId)` call necessarily does. */
  private repoHolderId(entry: RegistryEntry): string {
    return entry.descriptor.opId ?? entry.id;
  }

  /** Actually admit `entry`: stamps `startedAt`, bumps `active`, and — for a worktree-bound descriptor
   *  only — claims its worktree in {@link activeWorktrees}; and — for a `merge`-kind descriptor carrying
   *  a `repoPath` — claims its repo in {@link activeMergeRepos} (card 92e960d1), keyed by
   *  {@link repoHolderId}'s identity (card b9e07a4a). The one and only place either mutation happens,
   *  shared by the immediate fast path and a queued waiter's eventual grant. */
  private admit(entry: RegistryEntry): void {
    this.active++;
    entry.startedAt = Date.now();
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.add(wt);
    if (entry.descriptor.gateType === "merge" && entry.descriptor.repoPath != null) {
      // Card b9e07a4a Code Review: a merge+repoPath descriptor that omits `opId` falls back to `entry.id`
      // (see `repoHolderId`'s own doc) — safe for THIS op's own admit/release cycle (both derive the
      // identical value from the identical `entry`), but UNREACHABLE from outside it: an external
      // `beginSquash`/`endSquash(repoPath, opId)` call only ever has an `opId` to present, never
      // `entry.id`, so a caller that extends this hold past release via `holdRepoGuardOnExit` and then
      // tries to free it externally gets `refused-not-owner` FOREVER — a permanent, silent wedge on this
      // repoPath for the daemon's lifetime (converts the fixed over-release bug into a worse under-release
      // one). Every real call site supplies `opId` today (confirmWorkerMerge always does), so this is
      // loud-but-unreachable in production — surfaced here specifically so a FUTURE call site that omits
      // it fails loud instead of silently wedging a repo weeks later.
      if (entry.descriptor.opId == null) {
        console.log(`[gate:repo-guard] WARNING merge-descriptor-missing-opid repoPath=${entry.descriptor.repoPath} entryId=${entry.id} - beginSquash/endSquash can NEVER free this hold from outside this call if it survives past release() via holdRepoGuardOnExit (repoHolderId falls back to entry.id, which no external caller can ever present) t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      }
      this.activeMergeRepos.set(entry.descriptor.repoPath, this.repoHolderId(entry));
      this.logRepoGuardMutation("add", entry.descriptor.repoPath, entry.descriptor.opId, "admit");
    }
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
    if (this.active < cap && this.worktreeFree(entry) && this.mergeRepoFree(entry)) {
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
   *  — can be freed from {@link activeWorktrees}, and its repo — if any, card 92e960d1 — from
   *  {@link activeMergeRepos}), then hand the freed slot to the next ELIGIBLE waiter via
   *  {@link grantNext}. `holdRepoGuard` (card c24dd48a): when `true` — because this run's own `fn` called
   *  the `holdRepoGuardOnExit` callback {@link runExclusive} handed it — SKIPS freeing
   *  {@link activeMergeRepos} for a `merge`-kind descriptor's `repoPath`; everything else (the cap slot,
   *  the worktree, granting other eligible waiters) releases exactly as normal. The caller is then on the
   *  hook to free the repo guard explicitly, later, via {@link endSquash}/{@link releaseMergeRepoGuard} —
   *  see `holdRepoGuardOnExit`'s own doc for why this can never be automatic. */
  private release(entry: RegistryEntry, holdRepoGuard: boolean): void {
    this.active--;
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.delete(wt);
    if (entry.descriptor.gateType === "merge" && entry.descriptor.repoPath != null) {
      if (holdRepoGuard) {
        // Card 93b568e6: this op is now mid-squash — registry deletion (this method's own caller,
        // runExclusive's `finally`) is about to make it invisible to `snapshot()`; record it here so
        // `squashOnlySnapshot()` can still report it until `endSquash`/`releaseMergeRepoGuard` frees it.
        const repoPath = entry.descriptor.repoPath;
        this.squashHolders.set(repoPath, {
          repoPath, since: Date.now(), opId: entry.descriptor.opId ?? null,
          projectId: entry.descriptor.projectId, sessionId: entry.descriptor.sessionId,
          taskId: entry.descriptor.taskId ?? null, branch: entry.descriptor.branch ?? null,
        });
      } else {
        this.freeRepoPath(entry.descriptor.repoPath, this.repoHolderId(entry), entry.descriptor.opId, "release");
      }
    }
    this.grantNext();
  }

  /** Waiters parked in {@link acquireRepoGuardOnly}, keyed by `repoPath` — entirely separate from
   *  {@link highWaiters}/{@link lowWaiters} (card b9e07a4a): those two tiers queue for a CAP slot, and a
   *  repo-guard-only waiter must NEVER consume one — it has no gate to run at all.
   *  ⚠️ PRIORITY INVERSION, DELIBERATE (card b9e07a4a): {@link freeRepoPath} checks THIS map before
   *  `highWaiters` — a repo-guard-only waiter for `repoPath` ALWAYS wins the next hand-off, regardless of
   *  arrival order; `highWaiters`/`lowWaiters`' own ordering is otherwise unaffected.
   *  @decision ac7aad04 — this wait is NO LONGER near-instant; a holder can run a real reap + merge + diff
   *  while holding it (docs/decisions/ac7aad04-repo-guard-only-hold-no-longer-near-instant.md) */
  private readonly repoGuardOnlyWaiters = new Map<string, Array<{ id: string; descriptor: RepoGuardOnlyDescriptor; enqueuedAt: number; resolve: () => void; reject: (err: Error) => void }>>();

  /** Card b9e07a4a Code Review: metadata for a repoPath CURRENTLY held via {@link acquireRepoGuardOnly}
   *  (never an `admit()`-based hold — those live only in {@link registry}) — exists purely so
   *  {@link repoGuardOnlySnapshot} can report a "holding" entry `gate_queue` can display; the actual
   *  admission state lives in {@link activeMergeRepos} as it always has, this is a read-side mirror only. */
  private readonly repoGuardOnlyHolders = new Map<string, { id: string; descriptor: RepoGuardOnlyDescriptor; since: number }>();
  private repoGuardOnlySeq = 0;

  /** Card 93b568e6: repoPath -> the descriptor+timestamp of a `merge`-kind op currently mid-squash — i.e.
   *  {@link release} was called with `holdRepoGuard:true` for it. Populated ONLY there, cleared ONLY in
   *  {@link freeRepoPath} once the SAME repoPath's identity check there passes (the same instant
   *  {@link activeMergeRepos} would otherwise show this repoPath as freed/handed-off) — so this map's
   *  membership always tracks "past release(), not yet endSquash()" exactly, never longer. Read-side
   *  mirror only, same posture as {@link repoGuardOnlyHolders} — {@link activeMergeRepos} remains the sole
   *  admission authority; this exists purely so {@link squashOnlySnapshot} can report it. */
  private readonly squashHolders = new Map<string, SquashHolderEntry>();

  /** @decision b9e07a4a — the ONE place `activeMergeRepos` ever actually vacates a `repoPath`, shared by
   *  {@link release}/{@link releaseMergeRepoGuard}/{@link endSquash}/{@link acquireRepoGuardOnly}'s own
   *  release closure. IDENTITY-CHECKED FIRST (CRITICAL): `holderId` MUST equal what's currently stored, or
   *  it's a SAFE NO-OP, logged `refused-not-owner`, never a throw
   *  (docs/decisions/b9e07a4a-repoguardonlyqueueentry-exists-and-hides-repopath.md).
   *  ⚠️ Once identity is confirmed, a queued {@link acquireRepoGuardOnly} waiter for the SAME `repoPath`
   *  is handed the hold DIRECTLY, in the SAME synchronous turn — `activeMergeRepos` never actually loses
   *  the key. This atomicity is load-bearing: it is what makes a race with `acquire()`'s own synchronous
   *  fast-path check impossible. Only once no repo-guard-only waiter is queued is the key actually deleted,
   *  leaving `repoPath` free for `grantNext()`'s own cap-based scan to pick up. */
  private freeRepoPath(repoPath: string, holderId: string, releasingOpId: string | undefined, releasingSite: string): void {
    const current = this.activeMergeRepos.get(repoPath);
    if (current !== holderId) {
      console.log(`[gate:repo-guard] refused-not-owner repoPath=${repoPath} presentedId=${holderId} actualId=${current ?? "none"} opId=${releasingOpId ?? "?"} site=${releasingSite} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      return;
    }
    this.repoGuardOnlyHolders.delete(repoPath);
    // Card 93b568e6: the identity check above already confirmed `holderId` owns whatever is CURRENTLY
    // stored for `repoPath` — safe to unconditionally clear a squash-hold record for it too (a no-op if
    // this repoPath was never mid-squash to begin with).
    this.squashHolders.delete(repoPath);
    const waiters = this.repoGuardOnlyWaiters.get(repoPath);
    if (waiters && waiters.length > 0) {
      const w = waiters.shift()!;
      if (waiters.length === 0) this.repoGuardOnlyWaiters.delete(repoPath);
      this.activeMergeRepos.set(repoPath, w.id);
      this.repoGuardOnlyHolders.set(repoPath, { id: w.id, descriptor: w.descriptor, since: Date.now() });
      this.logRepoGuardMutation("delete", repoPath, releasingOpId, releasingSite);
      this.logRepoGuardMutation("add", repoPath, w.descriptor.opId, `${releasingSite}->repoGuardOnlyHandoff`);
      w.resolve();
      return;
    }
    this.logRepoGuardMutation("delete", repoPath, releasingOpId, releasingSite);
    this.activeMergeRepos.delete(repoPath);
  }

  /** Card b9e07a4a: acquire ONLY the per-repo merge-admission guard ({@link activeMergeRepos}) for
   *  `descriptor.repoPath` — never `cap`/`active`, never {@link activeWorktrees}. Built for exactly one
   *  caller shape: `confirmWorkerMerge`'s `db9b0130` inert-diff skip, which never calls
   *  {@link runExclusive} at all (there is no gate to run), but — since card b9e07a4a's reachability
   *  analysis — still needs to serialize against a same-repo sibling that IS genuinely running a real gate
   *  right now, exactly the same repo-level exclusivity {@link runExclusive}'s `mergeRepoFree` check gives
   *  a real gate. Routing through `runExclusive` itself was the reviewer's original suggestion and is
   *  DELIBERATELY NOT what this does — `acquire()` gates on `cap` and `mergeRepoFree` TOGETHER (see its
   *  own code), so an inert merge routed through `runExclusive` would queue behind CAP contention too,
   *  reintroducing exactly the gate-lane wait the inert-diff skip exists to avoid even when the repo
   *  itself is uncontended. This method waits ONLY on `mergeRepoFree`'s equivalent for `repoPath` — a
   *  saturated cap never blocks it.
   *
   *  IDENTITY (Code Review, card b9e07a4a): this hold's identity is an INTERNALLY-MINTED token
   *  (`rgo-<n>`), never `descriptor.opId` — deliberately decoupled from the caller-supplied value (unlike
   *  an `admit()`-based hold, see {@link repoHolderId}'s own doc) so this primitive's own correctness
   *  never depends on the caller reliably supplying a real, unique opId. `descriptor.opId` is REQUIRED on
   *  {@link RepoGuardOnlyDescriptor} regardless — not for identity, but because it's what makes this
   *  hold/wait findable by {@link findRepoGuardOnlyByOpId}/`gate_cancel` and labelable in `gate_queue`.
   *
   *  UNCONTENDED (the overwhelmingly common case): resolves on the same microtask turn it's called on,
   *  functionally instant — byte-identical in substance to having no guard at all.
   *
   *  CONTENDED (a same-repo sibling — real gate or another inert-skip — currently holds `repoPath`):
   *  queues behind it in {@link repoGuardOnlyWaiters}, FIFO per repoPath, and resolves the instant that
   *  holder releases (via {@link freeRepoPath}'s direct hand-off, never a delete-then-reacquire race) —
   *  OR is withdrawn via {@link cancelRepoGuardOnlyWait} (card b9e07a4a Code Review: this wait previously
   *  had NO cancellation path at all, unlike every other way to hold this guard — a wedge here had no
   *  operator remedy short of a daemon restart), in which case this THROWS a {@link GateCancelledError}
   *  instead of ever resolving — `confirmWorkerMerge`'s own catch around this call mirrors its EXISTING
   *  `GateCancelledError` catch around `runExclusive`. Otherwise unbounded, same as any other same-repo
   *  queued merge today — bounded in practice only by whatever bounds the HOLDER (a real gate's own
   *  `gateCommandTimeoutMs`, or another inert-skip's own near-instant squash), never by anything new this
   *  method adds.
   *
   *  Returns a `release` closure the caller MUST invoke exactly once, from a `finally` that runs on every
   *  exit path (clean resolve, throw, early return) — see `confirmWorkerMerge`'s own try/finally around
   *  this call for the actual bracket. `release` is idempotent (a second call is a harmless no-op) as a
   *  belt-and-braces safety net, NOT a substitute for that `finally` — a caller that never calls it at
   *  all still leaks the guard forever, exactly like a leaked `activeMergeRepos` entry from any other
   *  path (see {@link endSquash}'s own doc on why every caller must guarantee its own release). NEVER
   *  returned at all for a cancelled-while-queued wait (see above — `fn`-equivalent semantics: nothing was
   *  ever acquired, so there is nothing to release). */
  async acquireRepoGuardOnly(descriptor: RepoGuardOnlyDescriptor): Promise<() => void> {
    const { repoPath, opId } = descriptor;
    const id = `rgo-${++this.repoGuardOnlySeq}`;
    if (this.activeMergeRepos.has(repoPath)) {
      console.log(`[gate:repo-guard] wait-begin repoPath=${repoPath} opId=${opId} site=acquireRepoGuardOnly t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      await new Promise<void>((resolve, reject) => {
        const q = this.repoGuardOnlyWaiters.get(repoPath) ?? [];
        q.push({ id, descriptor, enqueuedAt: Date.now(), resolve, reject });
        this.repoGuardOnlyWaiters.set(repoPath, q);
      });
      // Handed off directly by `freeRepoPath` — `activeMergeRepos`/`repoGuardOnlyHolders` already carry
      // `repoPath` attributed to `id` on our behalf; nothing further to acquire. (A rejection above throws
      // out of this `await` instead of ever reaching here — see this method's own CONTENDED doc.)
    } else {
      this.activeMergeRepos.set(repoPath, id);
      this.repoGuardOnlyHolders.set(repoPath, { id, descriptor, since: Date.now() });
      this.logRepoGuardMutation("add", repoPath, opId, "acquireRepoGuardOnly");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.freeRepoPath(repoPath, id, opId, "acquireRepoGuardOnly-release");
      // Freeing a repo-guard-only hold can newly satisfy a CAP-based `runExclusive` waiter that was ALSO
      // blocked on this same repoPath (mergeRepoFree) — e.g. a real gate queued behind this inert-skip's
      // own hold. `freeRepoPath` only ever hands off to ANOTHER repo-guard-only waiter or deletes the
      // key; it never scans `highWaiters`/`lowWaiters` itself (it has no `cap` in scope — see
      // `grantNext`'s own doc on why that scan needs `lastKnownCap`), so this call is what actually wakes
      // a cap-based sibling once the key is genuinely free. A harmless no-op scan when the key was instead
      // handed off to another repo-guard-only waiter (repoPath still held, nothing new is eligible).
      this.grantNext();
    };
  }

  /** Point-in-time snapshot of every repo-guard-only holder/waiter — the `acquireRepoGuardOnly` counterpart
   *  to {@link snapshot} (which only ever sees cap-admitted `RegistryEntry` rows; see
   *  {@link RepoGuardOnlyEntry}'s own doc for why this had to be a separate read). Read-only. */
  repoGuardOnlySnapshot(): RepoGuardOnlyEntry[] {
    const entries: RepoGuardOnlyEntry[] = [];
    for (const [repoPath, holder] of this.repoGuardOnlyHolders) {
      entries.push({
        id: holder.id, repoPath, phase: "holding", since: holder.since, queuePosition: null,
        opId: holder.descriptor.opId, projectId: holder.descriptor.projectId, sessionId: holder.descriptor.sessionId,
        taskId: holder.descriptor.taskId ?? null, branch: holder.descriptor.branch ?? null,
      });
    }
    for (const [repoPath, waiters] of this.repoGuardOnlyWaiters) {
      waiters.forEach((w, i) => {
        entries.push({
          id: w.id, repoPath, phase: "queued", since: w.enqueuedAt, queuePosition: i + 1,
          opId: w.descriptor.opId, projectId: w.descriptor.projectId, sessionId: w.descriptor.sessionId,
          taskId: w.descriptor.taskId ?? null, branch: w.descriptor.branch ?? null,
        });
      });
    }
    return entries;
  }

  /** Card 93b568e6: point-in-time snapshot of every `merge`-kind op currently mid-squash (past its own
   *  gate command's `release()`, held via `holdRepoGuardOnExit`, not yet freed by `endSquash`/
   *  `releaseMergeRepoGuard`) — the {@link squashHolders} counterpart to {@link snapshot}/
   *  {@link repoGuardOnlySnapshot}, closing the read gap neither of those two covers (see
   *  {@link SquashHolderEntry}'s own doc for exactly why). Read-only. */
  squashOnlySnapshot(): SquashHolderEntry[] {
    return Array.from(this.squashHolders.values());
  }

  /** Look up ONE repo-guard-only holder/waiter by its `opId` (full or an unambiguous id-prefix — same
   *  resolution {@link findByOpId} uses) — the {@link acquireRepoGuardOnly} counterpart `gate_cancel`
   *  needs, since {@link findByOpId} only ever sees cap-admitted `RegistryEntry` rows (Code Review, card
   *  b9e07a4a: before this, a repo-guard-only wait was unreachable by opId at all — no lookup, no
   *  cancellation). `scopeProjectId` mirrors `findByOpId`'s own param — see its doc for the cross-project
   *  ambiguity-leak reasoning this identically guards against. */
  findRepoGuardOnlyByOpId(opId: string, scopeProjectId?: string): IdPrefixResult<RepoGuardOnlyEntry> {
    const candidates = this.repoGuardOnlySnapshot()
      .filter((e) => scopeProjectId == null || e.projectId === scopeProjectId)
      .map((e) => ({ id: e.opId!, entry: e }));
    const r = resolveIdPrefix(candidates, opId);
    if (r.kind === "found") return { kind: "found", record: r.record.entry };
    if (r.kind === "ambiguous") return { kind: "ambiguous", ids: r.ids };
    return { kind: "none" };
  }

  /** Cancel a QUEUED repo-guard-only wait by its OWN waiter `id` (the `id` field
   *  {@link findRepoGuardOnlyByOpId} returns — NOT the caller-supplied `opId`) — zero process risk, exactly
   *  like {@link cancelQueued}: a repo-guard-only wait never spawns anything while queued, so withdrawing
   *  it is always safe. The withdrawn waiter's `acquireRepoGuardOnly` call THROWS a
   *  {@link GateCancelledError} instead of ever resolving — see that method's own CONTENDED doc. A
   *  currently-HOLDING repo-guard-only op is NOT reachable here (mirrors `cancelGateOp`'s own refusal for
   *  an already-RUNNING merge gate — interrupting an in-flight hold risks the exact staged-residue hazard
   *  that refusal exists to avoid; only a QUEUED wait is ever zero-risk). Returns `false` if `id` isn't
   *  currently queued for any repoPath. */
  cancelRepoGuardOnlyWait(id: string, kind: GateCancelKind, detail: string): boolean {
    for (const [repoPath, waiters] of this.repoGuardOnlyWaiters) {
      const idx = waiters.findIndex((w) => w.id === id);
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        if (waiters.length === 0) this.repoGuardOnlyWaiters.delete(repoPath);
        w!.reject(new GateCancelledError(kind, detail));
        return true;
      }
    }
    return false;
  }

  /** @decision c24dd48a — mark `repoPath` as squash-in-flight, extending a `runExclusive`-admitted
   *  merge's own hold across `confirmWorkerMerge`'s subsequent `mergeBranch` call. Called ONLY when
   *  `gateRan` is true — a reuse or gateless merge NEVER calls this (see 0196ba78); VALIDATED marker only,
   *  does not mutate {@link activeMergeRepos} (docs/decisions/c24dd48a-holdrepoguardonexit-extends-a-merges-repo-hold-across-its-own-squash.md) */
  beginSquash(repoPath: string, opId: string): void {
    const current = this.activeMergeRepos.get(repoPath);
    if (current !== opId) {
      console.log(`[gate:repo-guard] beginSquash-identity-mismatch repoPath=${repoPath} expectedId=${opId} actualId=${current ?? "none"} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      return;
    }
    this.logRepoGuardMutation("add", repoPath, opId, "beginSquash");
  }

  /** @decision c24dd48a — end a `beginSquash` hold; same effect as {@link releaseMergeRepoGuard}, kept
   *  as a distinctly-named pair purely for begin/end readability at the call site, not a different
   *  mechanism (docs/decisions/c24dd48a-holdrepoguardonexit-extends-a-merges-repo-hold-across-its-own-squash.md) */
  endSquash(repoPath: string, opId: string): void {
    this.releaseMergeRepoGuard(repoPath, opId);
  }

  /** @decision c24dd48a — explicitly free a per-repo merge-admission guard (see {@link endSquash}'s doc,
   *  its synonym). Routed through {@link freeRepoPath}, IDENTITY-CHECKED against `opId`: an absent key or
   *  one held by a different identity is a safe no-op, never a throw
   *  (docs/decisions/c24dd48a-holdrepoguardonexit-extends-a-merges-repo-hold-across-its-own-squash.md) */
  releaseMergeRepoGuard(repoPath: string, opId: string): void {
    this.freeRepoPath(repoPath, opId, opId, "releaseMergeRepoGuard");
    this.grantNext();
  }

  /** Grant exactly ONE freed slot to the next eligible waiter — drains `highWaiters` before `lowWaiters`
   *  (card 8d585277), but WITHIN a tier scans for the first waiter whose worktree/repo (card 92e960d1)
   *  isn't STILL held elsewhere, skipping a blocked head-of-line waiter rather than deadlocking behind it.
   *  @decision d9d5057f — gated on `this.lastKnownCap` before scanning: `releaseMergeRepoGuard`/`endSquash`
   *  is NOT release-shaped like `release()` is, so a cap-blind grant here could over-admit past `cap`
   *  (docs/decisions/d9d5057f-grantnext-cap-check-releasemergerepoguard-is-not-release-shaped.md) */
  private grantNext(): void {
    if (this.lastKnownCap !== undefined && this.active >= this.lastKnownCap) return;
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      for (let i = 0; i < tier.length; i++) {
        const w = tier[i]!;
        if (!this.worktreeFree(w.entry) || !this.mergeRepoFree(w.entry)) continue;
        tier.splice(i, 1);
        w.grant();
        return;
      }
    }
  }

  /**
   * Run `fn` holding one of `cap` concurrent slots — awaits a slot first (queueing past `cap`, ordered
   * by `priority` (card 24642c3d), and past a per-worktree conflict regardless of `cap` — card 8d585277),
   * then releases it once `fn` settles. `cap` is read fresh on every call, so a human PATCH to
   * `orchestration.maxConcurrentGates` takes effect on the very next gate run with no daemon restart.
   * `priority` defaults to `"high"` (byte-identical to every pre-24642c3d call site).
   *
   * `fn` receives: the entry's admission timestamp (`startedAt`); a `cancelSignal` (card 8d585277,
   * aborted by {@link cancelRunning} to ask an ALREADY-ADMITTED `fn` to stop — an `fn` that ignores it is
   * simply never interruptible this way); a {@link GateLivenessHooks} (a caller that forwards it into its
   * own `runGateSequential`/`runGateStep` call lets this entry's `lastOutputAt`/`extended` mirror that
   * run's real liveness, never a second clock computed here).
   *
   * A QUEUED caller can be cancelled before ever being admitted (see {@link cancelQueued}/
   * {@link cancelQueuedForSession}) — `fn` is NEVER invoked in that case; this method translates that into
   * a thrown {@link GateCancelledError} instead. The registry entry is added up front and deleted in
   * `finally` (admission-then-settle, a throwing `fn`, and a timing-out `fn` alike), so no in-flight
   * metadata ever leaks; `release()` is gated on `acquired` so a slot is only released if one was taken.
   *
   * @decision c6750500 — `fn` ALSO receives `getMaxConcurrentGates`, closing over `entry` directly (not a
   *   registry lookup) so it stays correct after this entry is deleted from {@link registry}
   *   (docs/decisions/c6750500-getmaxconcurrentgates-closes-over-entry-not-a-registry-lookup.md)
   *
   * @decision c24dd48a — `fn` ALSO receives `holdRepoGuardOnExit`, a callback that keeps this run's
   *   per-repo merge guard held PAST settle, atomically, until the caller's own squash lands
   *   (docs/decisions/c24dd48a-holdrepoguardonexit-extends-a-merges-repo-hold-across-its-own-squash.md)
   */
  async runExclusive<T>(
    cap: number, descriptor: GateDescriptor,
    fn: (startedAt: number, cancelSignal: AbortSignal, hooks: GateLivenessHooks, getMaxConcurrentGates: () => number, holdRepoGuardOnExit: () => void) => Promise<T>,
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
    // Card c24dd48a: closed over by `fn` via the `holdRepoGuardOnExit` param below — see this method's own
    // doc for why setting this flag and reading it in `finally` must happen in the same synchronous turn.
    let holdRepoGuard = false;
    const holdRepoGuardOnExit = (): void => { holdRepoGuard = true; };
    try {
      const outcome = await this.acquire(cap, priority, entry);
      if (!outcome.admitted) throw new GateCancelledError(outcome.kind, outcome.detail);
      acquired = true;
      return await fn(entry.startedAt!, entry.controller.signal, hooks, getMaxConcurrentGates, holdRepoGuardOnExit);
    } finally {
      this.registry.delete(entry.id);
      if (acquired) this.release(entry, holdRepoGuard);
    }
  }

  /** Cancel a QUEUED (never-admitted) entry by its registry `id`. Zero process risk BY CONSTRUCTION: a
   *  queued entry has never had `fn` invoked, so there is no child process this could ever need to kill.
   *  Returns `false` (no-op) if `id` isn't currently queued — the caller's own `runExclusive` throw/return
   *  path is what actually produces the visible outcome.
   *  @decision 8f58c354 — a `gateType` is cancellable HERE only once its `runExclusive` caller has a
   *  `GateCancelledError` catch; the `switch` below is a compile-enforced ALLOWLIST, never a denylist
   *  (docs/decisions/8f58c354-cancelqueued-is-an-allowlist-enforced-by-an-exhaustive-switch.md) */
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
      batchBranches: e.descriptor.batchBranches ?? null,
      batchLandedCount: e.descriptor.batchLandedCount ?? null,
      fallbackOfBatchOpId: e.descriptor.fallbackOfBatchOpId ?? null,
      attempt: e.descriptor.attempt ?? null,
      priorAttemptMs: e.descriptor.priorAttemptMs ?? null,
      phase,
      since: phase === "running" ? e.startedAt! : e.enqueuedAt,
      queuePosition,
      opId: e.descriptor.opId ?? null,
      lastOutputAt: e.lastOutputAt,
      extended: e.extended,
      // Card 92e960d1: LIVE, recomputed here (never cached at enqueue time) — see the field's own doc for
      // why. Always false while running (nothing blocks an already-admitted entry).
      repoContended: phase === "queued" && !this.mergeRepoFree(e),
    });
    const entries: GateSnapshotEntry[] = [
      ...running.map((e) => toEntry(e, "running", null)),
      ...queued.map((e, i) => toEntry(e, "queued", i + 1)),
    ];
    return { active: this.active, queued: this.highWaiters.length + this.lowWaiters.length, entries };
  }

  /** @decision edc1ec12 — look up ONE live (running or queued) gate run by its {@link
   *  GateDescriptor.opId}, the LIVE-registry half of `gate_status(opId)`. Accepts a full opId or an
   *  unambiguous id-PREFIX (card 225bc7bd); `kind:"ambiguous"` must never fold into "not found"
   *  (docs/decisions/edc1ec12-gate-status-is-read-only-with-no-passfail-outcome.md).
   *  @decision e3e40167 — `kind:"none"` here is LIVE-ONLY and genuinely can't distinguish settled from
   *  never-existed; `SessionService.gateStatus` falls through to the durable tombstone table for that
   *  (docs/decisions/e3e40167-tombstone-fallback-supersedes-not-found.md).
   *  `scopeSessionId` (card fc243a43) and `scopeProjectId` (card 8d585277's `gate_cancel`, B2-3) both
   *  restrict the CANDIDATE SET itself before prefix resolution runs, never a post-hoc filter — see
   *  `cancelGateOp`'s own doc for why an unscoped call is still made first too. Omitted, either is
   *  byte-identical to before the param existed. */
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
