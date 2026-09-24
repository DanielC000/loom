/**
 * Daemon-global, in-memory concurrency limiter for HEAVY, daemon-EXECUTED gate runs — the
 * merge-confirm gate (`confirmWorkerMerge`), the scoped-deploy gate (`deployOwnProject`), and the worker
 * DoD self-check (`runWorkerGate` / the `run_gate` tool), all of which invoke `runGateSequential` with an
 * arbitrary human-set build/test command. Bounds how many can run AT ONCE across every project.
 * @decision 301d8c01 — never assume cross-project gate concurrency is bounded by anything but this one
 *   semaphore; before this it was enforced only by manager discipline (sequencing merges by hand), not
 *   code — no other structural guarantee exists.
 *
 * @decision fb8df559 — a caller that can't acquire a slot QUEUES rather than being rejected; never add
 *   separate client-timeout handling for this — `PendingOpRegistry.attach` already degrades to a pending
 *   handle for any call past its sync-wait budget, queued or running alike. Daemon-local, in-memory state.
 *
 * @decision 24642c3d — PRIORITY QUEUE: `highWaiters` (merge/deploy) drain fully before `lowWaiters` (a
 *   worker's own self-check), FIFO within each tier. Never add preemption of an already-RUNNING gate to
 *   fix starvation — it wastes progress and risks a leaked process tree; this queue reorder is the fix.
 *
 * @decision a1c86452 — LIVE REGISTRY (the Gates page): every in-flight run records a metadata
 *   `RegistryEntry`, added before acquisition and removed ONLY in `runExclusive`'s `finally` — removing it
 *   anywhere else lets a phantom active gate accumulate in the live view.
 *
 * ⚠️ THE REGISTRY IS NOT PURE METADATA (card 8d585277) — `descriptor.worktreePath` (when set) also
 * gates ADMISSION via `activeWorktrees` (`acquire`/`admit`/`release`/`grantNext` below), so two runs bound
 * to the SAME worktree can never both be RUNNING at once. Do not assume it is side-effect-free.
 *
 * @decision 8d585277 — CANCELLATION: a QUEUED entry withdraws with ZERO process risk (`fn` never
 *   invoked); an ALREADY-RUNNING entry can only be ASKED to stop (`cancelRunning`) — never report it
 *   cancelled unless `SessionService`'s own caller VERIFIES the kill; an unverified death stays held.
 *
 * @decision 92e960d1 — PER-REPO ADMISSION GUARD: a second, narrower exclusivity guard on
 *   `descriptor.repoPath`, closing the hazard of two same-repo merges racing to squash — queues the
 *   second rather than letting it burn a full gate run before self-aborting.
 *
 * @decision 0196ba78 — SCOPE, MADE EXPLICIT: this is an ADMISSION-time mechanism, not a
 *   merge-OPERATION-wide one — a reuse-path or gateless merge never reaches `runExclusive` and is
 *   structurally invisible to it, deliberately: `requireCanonicalHead`'s in-lock re-check protects those.
 *
 * @decision e4701333 — WIDENED the 92e960d1 guard to also cover `worker`-kind run_gate self-checks,
 *   ASYMMETRICALLY (see `mergeRepoFree`'s own doc for the exact rule — a symmetric first draft broke a
 *   real worker-vs-worker concurrency fixture): `deploy` stays excluded either way.
 *
 * @decision 567b8724 — cross-project fairness caps a project's held slots (`projectSlotFree`) only
 *   while a DIFFERENT, ADMISSIBLE project's waiter is queued — never touch an already-RUNNING entry, and
 *   never let an inadmissible foreign waiter reserve a slot it can't use.
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
 *  the exact starvation pattern this card was filed against.
 *
 *  ⚠️ Card 567b8724: this tier ordering is WITHIN-project only. `projectSlotFree` is keyed on `projectId`,
 *  never on this priority — a foreign project's admissible `"low"` waiter CAN be granted ahead of an
 *  over-quota project's own `"high"` one (deliberate — cross-project fairness IS the point). A project's
 *  own `"high"` waiter is still always found before its own `"low"` one, unaffected. */
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
   *  the descriptor at the `runExclusive` call site, never mutated in place by the CALLER — the semaphore itself
   *  copies the descriptor on entry and only a chain link's `attempt`/`priorAttemptMs` patch touches that copy
   *  (card 68155573). Both absent on every other
   *  gate (solo merge, worker self-check, deploy), which is what keeps those runs byte-identical. */
  batchBranches?: string[] | null;
  batchLandedCount?: number | null;
  /** @decision 19256231 — set only on a batch's per-branch fallback merge, carrying the batch's own
   *  opId; never rely on the "taskId:null/branch:null/workerLabel:Orchestrator" heuristic to find these
   *  rows in gate_queue — it finds only the batch's OWN gate, structurally missing every fallback row. */
  fallbackOfBatchOpId?: string | null;
  /** @decision b9e07a4a — opId is the IDENTITY `activeMergeRepos` stores against repoPath, not merely
   *  forensics; a merge descriptor calling `holdRepoGuardOnExit` MUST supply a real, stable opId, or the
   *  external `beginSquash`/`endSquash` call that later frees it can never match this hold. */
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
  /** @decision 92e960d1 — repoPath serializes same-repo merge gates; never assume release() freeing this
   *  guard at gate-settle is sufficient — a queued same-repo sibling must also wait for the holder's own
   *  SQUASH to land (`holdRepoGuardOnExit`/`beginSquash`/`endSquash`, card c24dd48a), or both can race. */
  // Card e4701333: also serializes a `worker` run_gate self-check against a same-repo `merge`, either
  // order — the squash-extension above stays merge-only; a worker's hold releases at its own gate settle.
  repoPath?: string | null;
  /** @decision 99a1cf6f — attempt/priorAttemptMs distinguish a retry re-admission from a first wait;
   *  never assume attempt is capped at 2 — a resumed non-final step after a passing single-file retry
   *  reaches attempt:3 (card 7ad12202), on both the solo and batch merge paths. */
  attempt?: number;
  /** Card 99a1cf6f — present iff `attempt` is, alongside it: attempt 1's own measured wall-clock run time
   *  (`gateAttempt1DurationMs`, `sessions/service.ts`, captured the instant attempt 1's own admission
   *  settles) — patched onto the live descriptor by a chain link (card 68155573) so a manager reading
   *  `gate_status`/`gate_queue` sees, e.g., `phase:"running", attempt:2, priorAttemptMs:1129000`.
   *  Purely informational: never consulted by admission/queueing/squash logic itself. */
  priorAttemptMs?: number;
}

/** The callback shape {@link GateSemaphore.runExclusive} runs once admitted — one per chain link. */
export type GateRunFn<T> = (
  startedAt: number, cancelSignal: AbortSignal, hooks: GateLivenessHooks,
  getMaxConcurrentGates: () => number, holdRepoGuardOnExit: () => void,
) => Promise<T>;

/**
 * One further link of a {@link GateSemaphore.runExclusive} CHAIN: a retry/resume that continues the SAME
 * admission.
 * @decision 68155573 — never release the slot/guard between links or re-queue a retry; a fresh
 *   `runExclusive` for a retry lets a sibling take the slot in the same tick (see the decision record).
 *
 * `descriptorPatch` merges into the live registry descriptor (typically `attempt`/`priorAttemptMs`) so
 * `gate_queue`/`gate_status` read the retry as `running` with `attempt:2`. `next` decides whether ANOTHER
 * link follows this one.
 */
export interface GateContinuation<T> {
  /** Narrowed to the two informational fields on purpose: `release()` keys on `worktreePath`/`repoPath`/
   *  `opId`/`gateType`, so a link must never be able to patch any of THOSE mid-chain. */
  descriptorPatch?: Pick<GateDescriptor, "attempt" | "priorAttemptMs">;
  fn: GateRunFn<T>;
  next?: (result: T) => GateContinuation<T> | null | Promise<GateContinuation<T> | null>;
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
  /** Card 68155573: epoch-ms the CURRENT chain link (attempt) began running — equals `since` on a
   *  first/only attempt, later than it once a retry continued this same admission (`since` deliberately
   *  keeps the ORIGINAL admission time). Null while queued. */
  attemptStartedAt: number | null;
  /** "running" once it holds a lane; "queued" while it's still waiting for one. */
  phase: "running" | "queued";
  /** Epoch-ms anchor for the UI's live elapsed clock: startedAt (running) or enqueuedAt (queued). */
  since: number;
  /** 1-based position in the ACTUAL admission order (all high waiters before low, FIFO within a tier —
   *  mirrors `release()`); null for a running entry. */
  queuePosition: number | null;
  /** Echoed from {@link GateDescriptor.opId} — see its doc; null when the run's descriptor didn't carry one. */
  opId: string | null;
  /** @decision 166ba5d9 — never treat a large elapsed time alone as evidence of a hung gate; the
   *  null-while-running window before this is first stamped is proven bounded by gitOpMs (≤120s worst
   *  case), orders of magnitude under the 20-minute stale-park threshold, and MEASURED sub-2s in practice. */
  lastOutputAt: number | null;
  /** True once the CURRENT step's timeout has already been auto-extended once (see `GATE_EXTEND_IDLE_MS`'s
   *  doc — the extension is `!extended`-gated and fires AT MOST ONCE per step). Resets to `false` at the
   *  start of every new step in a multi-step `gateCommand`, mirroring `runGateStep`'s own per-step
   *  `extended` flag exactly — this is per-STEP state, not a whole-run total. Always `false` while queued. */
  extended: boolean;
  /** @decision 92e960d1 (widened to `worker` by card e4701333) — repoContended:true names ONE specific
   *  queued cause (the per-repo guard, now merge-or-worker); never read a queued merge/worker with a
   *  free cap slot as a bug without checking this field first — distinct from cap or worktree contention. */
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
 * invisible to gate_queue. Never fold this into `GateSnapshotEntry` — no process runs here, so it
 * carries no lastOutputAt/extended/repoContended of its own; an entry here IS the contention itself.
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
  /** Card 68155573: start of the current chain link; `null` while queued. See {@link GateSnapshotEntry.attemptStartedAt}. */
  attemptStartedAt: number | null;
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
   *  never free an entry here without checking the presented holderId matches what's stored, or an
   *  unconditional release (e.g. after a failed/cancelled op) can delete a live sibling's hold. */
  // Card e4701333: populated ONLY by `merge`-kind admissions — a `worker`-kind hold lives in
  // {@link activeWorkerRepos} instead; never add a worker entry here, or `mergeRepoFree`'s asymmetric
  // check (merge excludes everything, worker excludes only merge) breaks.
  private readonly activeMergeRepos = new Map<string, string>();
  /** Card e4701333: repoPath -> the SET of `worker`-kind holder ids currently admitted for it — a Map
   *  (not a count) because {@link mergeRepoFree}'s asymmetric rule means MULTIPLE workers can concurrently
   *  hold the SAME repoPath (worker-vs-worker is deliberately unguarded — see that method's own doc for
   *  why), unlike {@link activeMergeRepos}'s single-holder shape. A repoPath key exists here ONLY while
   *  its Set is non-empty — deleted the instant the last worker releases, mirroring `activeMergeRepos`'s
   *  own invariant so a `.has(repoPath)` check is always a true presence test, never a stale empty entry.
   *  Never extended past a worker's own gate settle (workers never call `holdRepoGuardOnExit`), so this
   *  map needs no squash-hold counterpart — a worker's membership here tracks its OWN admit/release
   *  lifecycle exactly, nothing else. */
  private readonly activeWorkerRepos = new Map<string, Set<string>>();
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
   *  AT the mutation via performance.now(), never reconstructed later from a settledAt — that stamp
   *  measurably postdates the real mutation by an unmeasured margin. */
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

  /** Card 92e960d1, WIDENED by card e4701333: true when `entry` is free to be admitted RIGHT NOW with
   *  respect to the per-repo gate-admission guard alone — mirrors {@link worktreeFree}'s shape exactly,
   *  one level narrower in scope. ASYMMETRIC by design (card e4701333 Code Review, closing a real
   *  regression `gate-history.mjs`'s worker1+worker3-concurrent-admission fixture caught): a `merge`-kind
   *  descriptor is blocked by ANY active holder of its `repoPath` — another merge ({@link activeMergeRepos})
   *  OR a worker ({@link activeWorkerRepos}) — but a `worker`-kind descriptor is blocked ONLY by an active
   *  MERGE holder, never by another worker. Two workers on the SAME repo (e.g. two different workers each
   *  running their own `run_gate`) stay fully concurrent, exactly as before this card — only a merge↔worker
   *  pairing (either order) now serializes, closing the gap where that pairing could race a shared
   *  cross-process resource. A `worker` is ALSO blocked by a QUEUED same-repo `merge` ({@link mergeWaitingOnRepo}). Returns `true` immediately (never blocking) for `deploy` or any other
   *  gateType (deliberately excluded — see `docs/decisions/e4701333-*.md`), or for a merge/worker
   *  descriptor with no `repoPath` set. Does not consider `cap`/`active`/worktree — callers combine this
   *  with those separately, same composition {@link acquire}/{@link grantNext} already use for
   *  {@link worktreeFree}. */
  private mergeRepoFree(entry: RegistryEntry): boolean {
    const gt = entry.descriptor.gateType;
    if (gt !== "merge" && gt !== "worker") return true;
    const rp = entry.descriptor.repoPath;
    if (rp == null) return true;
    if (gt === "merge") return !this.activeMergeRepos.has(rp) && !this.activeWorkerRepos.has(rp);
    return !this.activeMergeRepos.has(rp) && !this.mergeWaitingOnRepo(rp);
  }

  /** True while a `merge`-kind waiter for `repoPath` sits in either queue tier — {@link mergeRepoFree}
   *  then holds back NEW same-repo `worker` admissions (writer-preference barrier).
   *  @decision eb491463 — never drop this barrier or scope it to one admission site: workers never exclude
   *  each other, so without it back-to-back worker gates starve a queued merge indefinitely. */
  private mergeWaitingOnRepo(repoPath: string): boolean {
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      for (const w of tier) {
        if (w.entry.descriptor.gateType === "merge" && w.entry.descriptor.repoPath === repoPath) return true;
      }
    }
    return false;
  }

  /** Card 567b8724: true iff some OTHER project currently has a queued waiter (either tier) that is
   *  itself ADMISSIBLE right now with respect to {@link worktreeFree}/{@link mergeRepoFree} — i.e. a
   *  waiter that would actually be capable of running if `projectId`'s own claim stepped aside.
   *  WORK-CONSERVING BY CONSTRUCTION: a foreign waiter blocked by its OWN worktree/repo guard is
   *  deliberately NOT counted — reserving a slot for it would leave that slot idle (neither this
   *  project's candidate NOR the blocked foreign waiter could use it), which is strictly worse than
   *  today. Deliberately does NOT recurse into a foreign candidate's own {@link projectSlotFree}: two
   *  projects each holding the other's only queued waiter would each ask "is the other admissible",
   *  which asks right back — a genuine mutual dependency, not merely deep recursion — so this checks
   *  only worktree/repo admissibility for the foreign candidate, never its own fairness eligibility. */
  private hasAdmissibleForeignWaiter(projectId: string): boolean {
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      for (const w of tier) {
        if (w.entry.descriptor.projectId === projectId) continue;
        if (this.worktreeFree(w.entry) && this.mergeRepoFree(w.entry)) return true;
      }
    }
    return false;
  }

  /** Card 567b8724: true when `entry` is free to be admitted RIGHT NOW with respect to the cross-project
   *  fairness guard alone — mirrors {@link worktreeFree}/{@link mergeRepoFree}'s shape, one level wider.
   *  While {@link hasAdmissibleForeignWaiter} is true for `entry`'s own project, that project may hold at
   *  most `Math.max(1, Math.ceil(cap / 2))` concurrently-ADMITTED slots (registry entries with
   *  `startedAt != null`) — closing the gap where one project's own backlog wins every freed slot ahead
   *  of a quiet sibling's single request, purely by FIFO arrival order. With NO admissible foreign
   *  waiter, unrestricted — a lone, uncontested project may always use every slot up to `cap`. CROSS-TIER
   *  by design: keyed on `projectId`, never `priority`/`gateType` — a foreign LOW-tier waiter CAN be
   *  granted ahead of an over-quota project's own HIGH-tier one while contested; tier order stays
   *  preserved WITHIN one project, since {@link grantNext} exhausts every `highWaiters` entry (all
   *  projects) before ever looking at `lowWaiters`. Callers combine this with `cap`/`active`/worktree/repo
   *  separately, same composition {@link acquire}/{@link grantNext} use for {@link worktreeFree}. */
  private projectSlotFree(entry: RegistryEntry, cap: number): boolean {
    const projectId = entry.descriptor.projectId;
    if (!this.hasAdmissibleForeignWaiter(projectId)) return true;
    const perProjectCap = Math.max(1, Math.ceil(cap / 2));
    let activeForProject = 0;
    for (const e of this.registry.values()) {
      if (e.startedAt != null && e.descriptor.projectId === projectId) activeForProject++;
    }
    return activeForProject < perProjectCap;
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
   *  only — claims its worktree in {@link activeWorktrees}; and, per the ASYMMETRIC rule
   *  {@link mergeRepoFree} enforces (card 92e960d1, card e4701333) — for a `merge`-kind descriptor
   *  carrying a `repoPath`, claims its repo in {@link activeMergeRepos}; for a `worker`-kind one, joins
   *  the repo's holder SET in {@link activeWorkerRepos} instead (never the same map — see that field's
   *  own doc for why). The one and only place either mutation happens, shared by the immediate fast path
   *  and a queued waiter's eventual grant. */
  private admit(entry: RegistryEntry): void {
    this.active++;
    entry.startedAt = Date.now();
    entry.attemptStartedAt = entry.startedAt;
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.add(wt);
    const rp = entry.descriptor.repoPath;
    if (entry.descriptor.gateType === "merge" && rp != null) {
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
        console.log(`[gate:repo-guard] WARNING merge-descriptor-missing-opid repoPath=${rp} entryId=${entry.id} - beginSquash/endSquash can NEVER free this hold from outside this call if it survives past release() via holdRepoGuardOnExit (repoHolderId falls back to entry.id, which no external caller can ever present) t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      }
      this.activeMergeRepos.set(rp, this.repoHolderId(entry));
      this.logRepoGuardMutation("add", rp, entry.descriptor.opId, "admit");
    } else if (entry.descriptor.gateType === "worker" && rp != null) {
      // Card e4701333: a worker's own hold never calls `holdRepoGuardOnExit` and never survives past its
      // own `release()`, so — unlike the merge branch above — there is no external-free hazard here to
      // warn about; a missing opId just falls back to `entry.id`, safe for this op's own admit/release.
      let set = this.activeWorkerRepos.get(rp);
      if (!set) { set = new Set(); this.activeWorkerRepos.set(rp, set); }
      set.add(this.repoHolderId(entry));
      this.logRepoGuardMutation("add", rp, entry.descriptor.opId, "admit-worker");
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
   *  currently held by another running entry OR its project is over its fair share while a foreign
   *  project waits (card 567b8724, {@link projectSlotFree}) — onto the `"high"` or `"low"` tier per
   *  `priority`. A worktree conflict queues the caller even when `cap` has spare headroom (card 8d585277's
   *  structural guard: same-worktree ops serialize regardless of tier or cap) — see {@link grantNext} for
   *  how a worktree-blocked (or fairness-blocked) waiter is later found and admitted once eligible, out of
   *  arrival order if necessary. */
  private acquire(cap: number, priority: GatePriority, entry: RegistryEntry): Promise<AcquireOutcome> {
    if (this.active < cap && this.worktreeFree(entry) && this.mergeRepoFree(entry) && this.projectSlotFree(entry, cap)) {
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
   *  — can be freed from {@link activeWorktrees}, and its repo hold — if any — freed from whichever of
   *  {@link activeMergeRepos}/{@link activeWorkerRepos} it actually joined, per {@link admit}'s own
   *  asymmetric routing), then hand the freed slot to the next ELIGIBLE waiter via {@link grantNext}.
   *  `holdRepoGuard` (card c24dd48a): when `true` — because this run's own `fn` called the
   *  `holdRepoGuardOnExit` callback {@link runExclusive} handed it — SKIPS freeing {@link activeMergeRepos}
   *  for a `merge`-kind descriptor's `repoPath`; everything else (the cap slot, the worktree, granting
   *  other eligible waiters) releases exactly as normal. The caller is then on the hook to free the repo
   *  guard explicitly, later, via {@link endSquash}/{@link releaseMergeRepoGuard} — see
   *  `holdRepoGuardOnExit`'s own doc for why this can never be automatic. Card e4701333: a `worker` entry
   *  never declares `holdRepoGuardOnExit` (`holdRepoGuard` is always `false` for it) — its repo hold
   *  always frees below, at its own settle, by leaving the `activeWorkerRepos` set it joined in `admit`. */
  private release(entry: RegistryEntry, holdRepoGuard: boolean): void {
    this.active--;
    const wt = entry.descriptor.worktreePath;
    if (wt != null) this.activeWorktrees.delete(wt);
    const rp = entry.descriptor.repoPath;
    if (entry.descriptor.gateType === "merge" && rp != null) {
      if (holdRepoGuard) {
        // Card 93b568e6: this op is now mid-squash — registry deletion (this method's own caller,
        // runExclusive's `finally`) is about to make it invisible to `snapshot()`; record it here so
        // `squashOnlySnapshot()` can still report it until `endSquash`/`releaseMergeRepoGuard` frees it.
        this.squashHolders.set(rp, {
          repoPath: rp, since: Date.now(), opId: entry.descriptor.opId ?? null,
          projectId: entry.descriptor.projectId, sessionId: entry.descriptor.sessionId,
          taskId: entry.descriptor.taskId ?? null, branch: entry.descriptor.branch ?? null,
        });
      } else {
        this.freeRepoPath(rp, this.repoHolderId(entry), entry.descriptor.opId, "release");
      }
    } else if (entry.descriptor.gateType === "worker" && rp != null) {
      const set = this.activeWorkerRepos.get(rp);
      if (set) {
        set.delete(this.repoHolderId(entry));
        if (set.size === 0) this.activeWorkerRepos.delete(rp);
      }
      this.logRepoGuardMutation("delete", rp, entry.descriptor.opId, "release-worker");
    }
    this.grantEligible();
  }

  /** Waiters parked in {@link acquireRepoGuardOnly}, keyed by `repoPath` — entirely separate from
   *  {@link highWaiters}/{@link lowWaiters} (card b9e07a4a): those two tiers queue for a CAP slot, and a
   *  repo-guard-only waiter must NEVER consume one — it has no gate to run at all.
   *  ⚠️ PRIORITY INVERSION, DELIBERATE (card b9e07a4a): {@link freeRepoPath} checks THIS map before
   *  `highWaiters` — a repo-guard-only waiter for `repoPath` ALWAYS wins the next hand-off, regardless of
   *  arrival order; `highWaiters`/`lowWaiters`' own ordering is otherwise unaffected.
   *  @decision ac7aad04 — never assume this wait settles near-instantly; a holder can run a real reap +
   *  `git merge` + `git diff` while holding it (~1.5s typical, bounded by gitOpMs worst-case). */
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

  /** The ONE place `activeMergeRepos` ever actually vacates a `repoPath`, shared by {@link release}/
   *  {@link releaseMergeRepoGuard}/{@link endSquash}/{@link acquireRepoGuardOnly}'s own release closure.
   *  @decision b9e07a4a — IDENTITY-CHECKED FIRST: `holderId` MUST equal what's currently stored, or it's
   *  a SAFE NO-OP (`refused-not-owner`), never a throw — free only after that check, or a live sibling's
   *  hold can be deleted.
   *
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
      this.grantEligible();
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

  /** @decision c24dd48a — marks `repoPath` squash-in-flight, extending an admitted merge's hold across
   *  its own squash. Called ONLY when `gateRan` is true (never for reuse/gateless, card 0196ba78) — a
   *  VALIDATED marker only; never mutates {@link activeMergeRepos} itself. */
  beginSquash(repoPath: string, opId: string): void {
    const current = this.activeMergeRepos.get(repoPath);
    if (current !== opId) {
      console.log(`[gate:repo-guard] beginSquash-identity-mismatch repoPath=${repoPath} expectedId=${opId} actualId=${current ?? "none"} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      return;
    }
    this.logRepoGuardMutation("add", repoPath, opId, "beginSquash");
  }

  /** @decision c24dd48a — end a `beginSquash` hold; same effect as {@link releaseMergeRepoGuard}, kept
   *  as a distinctly-named pair purely for begin/end readability at the call site, never a different
   *  mechanism — both route through the SAME identity-checked `freeRepoPath`, no separate logic to drift. */
  endSquash(repoPath: string, opId: string): void {
    this.releaseMergeRepoGuard(repoPath, opId);
  }

  /** @decision c24dd48a — explicitly frees a per-repo merge-admission guard ({@link endSquash}'s synonym).
   *  Routed through {@link freeRepoPath}, IDENTITY-CHECKED against `opId`: an absent key, or one held by
   *  a different identity, is a safe no-op, never a throw. */
  releaseMergeRepoGuard(repoPath: string, opId: string): void {
    this.freeRepoPath(repoPath, opId, opId, "releaseMergeRepoGuard");
    this.grantEligible();
  }

  /** Card eb491463: grant EVERY waiter now eligible (each grant re-checks cap via {@link grantNext}), not just one.
   *  The writer-preference barrier ({@link mergeWaitingOnRepo}) can hold several workers back beside free cap; when the
   *  merge that held them releases, one freed slot no longer means exactly one eligible waiter. */
  private grantEligible(): void {
    while (this.grantNext()) { /* drain */ }
  }

  /** Grant exactly ONE freed slot to the next eligible waiter — drains `highWaiters` before `lowWaiters`
   *  (card 8d585277), but WITHIN a tier scans for the first waiter whose worktree/repo (card 92e960d1) or
   *  cross-project fairness share (card 567b8724, {@link projectSlotFree}) isn't STILL blocked, skipping
   *  an ineligible head-of-line waiter rather than deadlocking behind it — this is what lets a foreign
   *  project's waiter jump an over-quota project's own earlier-queued one, across tiers if necessary.
   *  @decision d9d5057f — gated on `this.lastKnownCap` before scanning: never assume every caller here is
   *  release-shaped — `releaseMergeRepoGuard`/`endSquash` frees a REPO guard, not a cap slot, so a
   *  cap-blind grant here could over-admit past `cap`. */
  private grantNext(): boolean {
    if (this.lastKnownCap !== undefined && this.active >= this.lastKnownCap) return false;
    for (const tier of [this.highWaiters, this.lowWaiters]) {
      for (let i = 0; i < tier.length; i++) {
        const w = tier[i]!;
        if (!this.worktreeFree(w.entry) || !this.mergeRepoFree(w.entry)) continue;
        if (this.lastKnownCap !== undefined && !this.projectSlotFree(w.entry, this.lastKnownCap)) continue;
        tier.splice(i, 1);
        w.grant();
        return true;
      }
    }
    return false;
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
   * @decision c6750500 — `fn` ALSO receives `getMaxConcurrentGates`; never look up `maxConcurrent` by
   *   registry id from inside or after `fn` — close over `entry` directly instead, so it stays correct
   *   after this entry is deleted from {@link registry}.
   *
   * @decision c24dd48a — `fn` ALSO receives `holdRepoGuardOnExit`; never call it without an unconditional
   *   `finally` that reaches `endSquash`/`releaseMergeRepoGuard` on every exit path — a hold with no
   *   matching release permanently blocks that repo.
   */
  async runExclusive<T>(
    cap: number, descriptor: GateDescriptor,
    fn: GateRunFn<T>,
    priority: GatePriority = "high",
    next?: (result: T) => GateContinuation<T> | null | Promise<GateContinuation<T> | null>,
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
      id: `gate-${++this.seq}`, descriptor: { ...descriptor }, priority, enqueuedAt: Date.now(), startedAt: null, attemptStartedAt: null,
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
      let result = await fn(entry.startedAt!, entry.controller.signal, hooks, getMaxConcurrentGates, holdRepoGuardOnExit);
      // Card 68155573 — CHAIN: each further link runs INSIDE this same try, so the one `finally` below is the
      // only release on every exit (a throw in `next`/`fn`, a cancel, a normal end). No release, `grantEligible`
      // or re-queue happens between links; `holdRepoGuard` is per-link, so only the LAST link's hold counts.
      let link = next ? await next(result) : null;
      while (link) {
        Object.assign(entry.descriptor, link.descriptorPatch);
        entry.attemptStartedAt = Date.now();
        entry.lastOutputAt = null;
        entry.extended = false;
        // A `cancelRunning` that landed while `next()` was awaited aborted the PREVIOUS controller; carry it
        // onto the fresh one so the abort is never silently lost (a link that reads its signal sees it aborted).
        const prevController = entry.controller;
        entry.controller = new AbortController();
        if (prevController.signal.aborted) entry.controller.abort(prevController.signal.reason);
        holdRepoGuard = false;
        result = await link.fn(entry.attemptStartedAt, entry.controller.signal, hooks, getMaxConcurrentGates, holdRepoGuardOnExit);
        link = link.next ? await link.next(result) : null;
      }
      return result;
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
   *  `GateCancelledError` catch; never write this as a denylist (e.g. `=== "deploy"` → refuse) — that
   *  fails OPEN for a future GateType, silently allowing cancellation before its catch is proven safe. */
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
        // Card eb491463: a cancelled `merge` waiter LIFTS its repo's worker barrier ({@link
        // mergeWaitingOnRepo}) with no slot released, so workers it was holding back would sit idle beside
        // free cap until some unrelated release — grant every now-eligible waiter (only a merge waiter can
        // change eligibility here, so this is a no-op for a cancelled worker).
        if (gateType === "merge") this.grantEligible();
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
      attemptStartedAt: phase === "running" ? e.attemptStartedAt : null,
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

  /** Look up ONE live (running or queued) gate run by its {@link GateDescriptor.opId} — the LIVE-registry
   *  half of `gate_status(opId)`. Accepts a full opId or an unambiguous id-PREFIX (card 225bc7bd) — the
   *  same `resolveIdPrefix` resolution `agent_get`/`worker_spawn` already use.
   *  @decision edc1ec12 — never fold `kind:"ambiguous"` into "not found" here; an ambiguous prefix is a
   *  distinct outcome the caller must surface, not silently collapse to a plain miss.
   *  @decision e3e40167 — `kind:"none"` here is LIVE-ONLY and genuinely can't distinguish settled from
   *  never-existed; never report it as a plain "not found" — `SessionService.gateStatus` falls through
   *  to the durable tombstone table for the real terminal state.
   *
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
