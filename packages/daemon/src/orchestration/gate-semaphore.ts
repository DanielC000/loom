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
 *
 * PER-REPO MERGE ADMISSION (card 92e960d1): a SECOND, narrower exclusivity guard alongside the
 * per-worktree one above — `descriptor.repoPath` (set ONLY on a `merge`-kind descriptor, by
 * `confirmWorkerMerge`) gates admission via `activeMergeRepos`, so two `merge`-kind gates targeting the
 * SAME canonical repo can never both be RUNNING at once, regardless of `cap`/tier — closing the class
 * where two same-repo merges race concurrently, one guaranteed to burn a full gate run before aborting at
 * squash (canonical main is a single shared resource; see `mergeBranchLocked`'s `requireCanonicalHead`
 * re-check in git/worktrees.ts). Composes with the worktree guard and the priority queue exactly the same
 * way that guard already does (`mergeRepoFree`, alongside `worktreeFree`, in `acquire`/`grantNext`) — a
 * `worker`/`deploy` gate is structurally unaffected (see `mergeRepoFree`'s own doc), and two merges on
 * DIFFERENT repos are never cross-serialized.
 *
 * ⚠️ SCOPE, MADE EXPLICIT (card 0196ba78 — this is an ADMISSION-time mechanism, not a
 * merge-OPERATION-wide one): the "can never both be RUNNING" claim above binds ONLY to ops that actually
 * reach `acquire`/`admit` via `runExclusive` — anything that never calls `runExclusive` is structurally
 * invisible to `activeMergeRepos` and gets NO protection from this guard. Two real paths reach a squash
 * without ever calling `runExclusive`: a merge-gate REUSE (card e50600d2 — `gateResult = reuseResult ??
 * await this.gateSemaphore.runExclusive(...)`, short-circuited by `??` when a redundant re-gate is
 * skipped) and a GATELESS project/repo (no `gateCommand` configured, so the whole `if (gate)` block in
 * `confirmWorkerMerge` never runs). THIS IS DELIBERATE, not an oversight the way the unqualified claim
 * above initially reads:
 *   - THE JUSTIFYING CLAUSE ABOVE IS LANE LANGUAGE: this guard's own originating commit (`848f55fb`,
 *     2026-08-04) titled the problem "wasting a lane unrelated work could have used." A reuse-path merge
 *     NEVER TAKES A LANE AT ALL — it skips `runExclusive` entirely — so the harm this guard exists to
 *     prevent is one reuse is structurally incapable of causing. That's a category fact, not a scoping
 *     judgement call.
 *   - THE DATING CONFIRMS IT: `e50600d2` (commit `1a779c8f`, 2026-07-29) predates `92e960d1`
 *     (`848f55fb`, 2026-08-04) by six days — this guard was written into a codebase that ALREADY carried
 *     a documented, standing reuse-skip exemption from `runExclusive` (see the reuse producer's own doc
 *     at its `confirmWorkerMerge` call site in service.ts). The boundary drawn here is the mechanism's
 *     natural edge, not a gap that was missed.
 *   - `c24dd48a` (2026-08-05) independently RE-DERIVED the same boundary under review pressure: an
 *     earlier draft of that card called `beginSquash`/`endSquash` unconditionally, review caught that
 *     this let a reuse/gateless op silently delete a DIFFERENT, genuinely-admitted op's still-active hold
 *     (`activeMergeRepos` has no per-op identity), and the shipped fix confines both calls to `gateRan`
 *     — i.e. keeps reuse/gateless permanently outside this mechanism (see that call site's own doc in
 *     service.ts). Two independent derivations of the same boundary is strong evidence it's correct.
 *
 * WHAT ACTUALLY PROTECTS THE EXCLUDED PATHS: not this guard — `requireCanonicalHead`, re-checked INSIDE
 * `mergeBranchLocked`'s own lock (git/worktrees.ts) at squash time, fail-closed. A racing reuse/gateless
 * squash against a genuinely-admitted sibling self-aborts with `gateBaseInvalidated` rather than landing
 * unverified content — this is a throughput/wasted-gate-run gap, NOT a data-loss one.
 *
 * RESIDUAL EXPOSURE, PRECISELY SCOPED — do not round either of these up or down:
 *   - GATELESS: on a project where every binding of a given `repoPath` sets a `gateCommand` (the ordinary
 *     case, and this project's actual configuration), a gateless race can't occur — there's no
 *     gate-running sibling on that repo for a gateless op to race. That is NOT a general guarantee:
 *     `gateCommand` is per-PROJECT, `repoPath` is per-REPO, and nothing prevents two DIFFERENT projects on
 *     the same daemon from binding the SAME repo path with differing gate configuration — in that
 *     arrangement a gateless merge from one project genuinely can race a gate-running merge from the
 *     other. Unreachable on any configuration where every project binding this repo sets a gateCommand;
 *     the residual requires two projects sharing one `repoPath` with differing gate configuration.
 *   - REUSE: has no such conditional escape — it's a live gap under every configuration — but is observed
 *     at n=0 in weeks (card 0196ba78): low OBSERVED frequency on an instrument that can't distinguish
 *     "rare" from "never fires," not asserted-low severity.
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
   *  one) simply omits it and that entry is un-lookup-able by opId, exactly as before this field existed.
   *
   *  Card b9e07a4a Code Review (Critical): for a `merge`-kind descriptor carrying `repoPath` — the ONLY
   *  case that ever touches {@link GateSemaphore}'s `activeMergeRepos` — `opId` is now the IDENTITY that
   *  Map stores against `repoPath`, not merely forensics. Omitting it here does NOT break admission (a
   *  safe internal fallback applies — see `GateSemaphore.repoHolderId`'s own doc), but it DOES mean this
   *  hold can never be matched by an EXTERNAL `beginSquash`/`endSquash`/`releaseMergeRepoGuard(repoPath,
   *  opId)` call, since those only ever have an `opId` to present, never the semaphore's own internal id —
   *  a merge descriptor that intends to call `holdRepoGuardOnExit` MUST supply a real, stable `opId`
   *  (every real `confirmWorkerMerge` call already does: `gateDescriptor.opId` and the later
   *  `beginSquash`/`endSquash(repoPath, thisOpId)` calls are the SAME value by construction). */
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
  /**
   * Card 92e960d1: the CANONICAL repo path this MERGE gate targets — set ONLY at the merge-gate call
   * site (`confirmWorkerMerge`, resolved via `resolveRepoByKey(project, worker.repoKey).path`, never a
   * bare `projectId`, so two DIFFERENT repos registered on the same multi-repo project are never
   * cross-serialized). NEVER set on a `worker`-kind (`runWorkerGate`) or `deploy`-kind
   * (`deployOwnProject`) descriptor — see {@link GateSemaphore.mergeRepoFree}'s own doc for why those two
   * gate types are structurally unaffected by this field regardless.
   *
   * THE HAZARD THIS CLOSES: two `merge`-kind gates admitted concurrently for the SAME repo race to
   * squash — at most one lands (canonical main is a single shared resource), and the other burns its
   * full gate run before `mergeBranchLocked`'s `requireCanonicalHead` re-check (git/worktrees.ts) fails
   * closed and aborts it. This field is what lets the semaphore refuse to ADMIT the second one at all,
   * queueing it instead — see {@link GateSemaphore.mergeRepoFree}/`activeMergeRepos`.
   *
   * ⚠️ AT THE TIME THIS FIELD WAS ADDED, it was NOT a fix for the second merge's own odds of landing: its
   * `gateBaseMainHead` (the union-merge's captured main sha) was fixed BEFORE it ever reached this
   * semaphore, so if the FIRST same-repo merge landed while the second was queued, the second's captured
   * base was already stale by the time it was admitted — it still ran its own gate and then still
   * self-aborted via the fail-closed check, needing a manager re-confirm despite the throughput win this
   * field buys (no more SIMULTANEOUS double-lane loss, and the other cap lane staying free for unrelated
   * cross-project work during the first merge's run). PARTIALLY addressed by card b798e706 (fast-follow):
   * the merge gate's own `runExclusive` callback RE-DERIVES `gateBaseMainHead` the instant it is admitted
   * here (`confirmWorkerMerge`'s `reunionAtAdmission`), re-unioning against canonical main's then-current
   * tip when it moved during the queue wait — but b798e706, by itself, left the HEADLINE same-repo-sibling
   * scenario open: this field's own `release()` used to free the admission guard the MOMENT a running
   * merge's gate settled, strictly BEFORE that merge's own squash (`mergeBranch`, called outside
   * `runExclusive`). CLOSED FOR REAL by card c24dd48a: `runExclusive`'s `fn` can now call the
   * `holdRepoGuardOnExit` callback it's handed (see `runExclusive`'s own doc) to keep THIS field's guard
   * held past the gate's own settle, and `confirmWorkerMerge` extends that hold across its own squash call
   * via `beginSquash`/`endSquash` below — so a queued same-repo sibling is not admitted until the holder's
   * squash commit has actually landed (or failed), closing the exact gap this comment used to describe. A
   * residual TOCTOU window remains BY DESIGN — a landing at the exact instant a run IS admitted (before
   * this field's guard is even checked) can still invalidate a freshly-re-derived base — caught fail-closed
   * by `requireCanonicalHead`'s own in-lock re-check at squash time, same as ever; this field only ever
   * narrows the ADMISSION window, it was never meant to replace that fail-closed check.
   */
  repoPath?: string | null;
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
  /**
   * Card 92e960d1: while `phase:"queued"`, whether THIS entry's per-repo merge-admission guard (see
   * {@link GateDescriptor.repoPath}/{@link GateSemaphore.mergeRepoFree}) is CURRENTLY the reason (or one
   * of the reasons — cap contention can hold simultaneously) it isn't admitted: another `merge`-kind gate
   * for the same repo is already RUNNING. Always `false` while `phase:"running"` (nothing is blocking an
   * already-admitted entry) and always `false` for a non-merge or repoPath-less descriptor. A LIVE,
   * point-in-time read — recomputed fresh on every `snapshot()` call, never cached at enqueue time, so it
   * can flip between two reads of the same still-queued entry as sibling ops settle (e.g. a second
   * same-repo waiter queued behind this one gets admitted first, freeing the repo before this one is).
   * Named for exactly ONE cause: before card 92e960d1, "queued" only ever meant cap contention (or the
   * pre-existing per-worktree guard, card 8d585277 — this field does NOT cover that one, only the
   * repo-level guard this card added) — without this, a caller reading `gate_queue` with a free cap slot
   * and a queued merge would see something that looks like a bug instead of the new, deliberate
   * repo-exclusivity wait.
   */
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
 * One repo-guard-only holder/waiter in {@link GateSemaphore.repoGuardOnlySnapshot}'s result — the
 * `acquireRepoGuardOnly` counterpart to {@link GateSnapshotEntry}. Card b9e07a4a Code Review: BEFORE this
 * existed, a repo-guard-only hold/wait was invisible to `gate_queue` entirely — an operator reading it
 * could see a queued `merge`-kind gate reporting `repoContended:true` while the live registry showed ZERO
 * running merges on that repo (the contending holder was a repo-guard-only op, which `snapshot()` never
 * counted), and had no way to even SEE, let alone cancel, a wedged repo-guard-only wait (unlike every other
 * way to hold this guard, which is at minimum visible via `snapshot()`/`gate_cancel`). This type — and
 * `repoGuardOnlySnapshot()`/`findRepoGuardOnlyByOpId()`/`cancelRepoGuardOnlyWait()` below — close that gap.
 * Deliberately NOT merged into {@link GateSnapshotEntry}/`snapshot()`: this is not a cap-admitted
 * `RegistryEntry` (see `acquireRepoGuardOnly`'s own doc for why it structurally can't be one), so it
 * carries no `lastOutputAt`/`extended`/`liveness` (nothing runs here — there is no process, no gate
 * command) and no `repoContended` (that field answers "is something ELSE blocking me"; an entry here IS
 * the contention another `merge`-kind `GateSnapshotEntry` might be reporting).
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
  /** Card 92e960d1: repoPath -> the identity of whichever holder CURRENTLY holds the per-repo
   *  merge-admission guard for it — the structural per-repo merge-admission guard. Only ever
   *  populated/consulted for a `merge` descriptor carrying a non-null `repoPath` (see every read/write
   *  site below, all guarded via {@link mergeRepoFree}) — a `worker`/`deploy` gate, or a `merge` gate
   *  with no `repoPath`, never touches this map at all. Deliberately SEPARATE from
   *  {@link activeWorktrees}: a worktree identifies one worker's own checkout, a repo path identifies the
   *  shared canonical repo two DIFFERENT workers' merges can both target — the two guards protect
   *  different resources and compose independently.
   *
   *  IDENTITY-AWARE (card b9e07a4a Code Review, CRITICAL): was a bare `Set<string>` — membership alone
   *  could not tell "genuinely free" apart from "held by someone else". The reproduced cascade: op A's
   *  real gate FAILS (`holdRepoGuardOnExit` never called) → `release(holdRepoGuard:false)` frees/hands off
   *  `repoPath` to a queued op B → but `confirmWorkerMerge`'s OUTER `finally` still unconditionally calls
   *  `endSquash(repoPath, A's opId)` (gated on `gateRan`, which was set BEFORE the gate ever ran — true
   *  regardless of pass/fail, see that flag's own doc) — an unconfined `Set.delete` there would DELETE B's
   *  now-live hold, a real regression of "at most one running merge gate per repo" (op C could then be
   *  admitted while B is mid-squash), and B's OWN later release would then delete C's hold in turn. The
   *  identical shape hits the cancelled-while-queued path too: a `gateRan:true` op cancelled before it was
   *  ever admitted (`GateCancelledError`, thrown before `fn` runs) never touched this map at all, yet its
   *  `finally` still fires `endSquash`. A `Map<repoPath, holderId>` closes BOTH: every release-side call
   *  ({@link freeRepoPath}, {@link releaseMergeRepoGuard}/{@link endSquash}) must present the SAME
   *  `holderId` that was stored at acquisition and is REFUSED — a safe no-op, logged distinctly — if it
   *  doesn't match, so an op can only ever touch its OWN hold, never a sibling's, REGARDLESS of pass/fail/
   *  cancel timing. See {@link repoHolderId}'s own doc for exactly what that identity value is. */
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

  /** Card 96d5f76b: forensics for `activeMergeRepos`'s add/delete lifecycle — this Map's membership AND
   *  identity together are the ENTIRE per-repo merge-admission guard (card b9e07a4a widened this from
   *  membership alone, once a plain Set was shown unable to tell "free" apart from "held by someone
   *  else" — see `activeMergeRepos`'s own doc for the cascade that gap allowed). The incident THIS card
   *  investigates (a holder's guard vanishing ~10 minutes into its own still-running gate, with no known
   *  caller responsible) went unexplained for as long as it did because no mutation of this Map was ever
   *  logged with a timestamp taken AT the mutation itself — every timing argument had to be reconstructed
   *  after the fact from a
   *  LATER stamp (an op's own `settledAt`), which is measurably not the same instant (confirmed during
   *  that investigation: a sibling op's `settledAt` postdates its own `endSquash` call, the actual
   *  `activeMergeRepos` mutation, by an unmeasured margin). `performance.now()` (monotonic — immune to
   *  wall-clock adjustment, and the same clock `gate-runner.ts`'s own liveness tracking already uses) is
   *  the ordering-authoritative value; the ISO `Date.now()` string rides alongside it purely so a reader
   *  can correlate this line against `pending_gate_ops`/`orchestration_events`, which are wall-clock only.
   *  `opId` is `undefined` for a call site that has none to offer (none exist today — every caller of the
   *  four mutation points below has one) rather than a fabricated placeholder. */
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
    if (!holdRepoGuard && entry.descriptor.gateType === "merge" && entry.descriptor.repoPath != null) {
      this.freeRepoPath(entry.descriptor.repoPath, this.repoHolderId(entry), entry.descriptor.opId, "release");
    }
    this.grantNext();
  }

  /** Card b9e07a4a: waiters parked in {@link acquireRepoGuardOnly}, keyed by `repoPath` — entirely
   *  separate from {@link highWaiters}/{@link lowWaiters}: those two tiers exist to queue for a CAP slot
   *  (`admit()` always increments `active`), and a repo-guard-only waiter must NEVER consume one — the
   *  whole point of this primitive is a caller (the `db9b0130` inert-diff skip) that has no gate to run
   *  and therefore nothing that needs a cap slot at all, only exclusivity against a same-repo sibling
   *  merge. Reusing the cap-based tiers here would silently re-admit this class of caller through
   *  `grantNext()`'s `admit()` call and start consuming cap headroom it was never supposed to need.
   *
   *  ⚠️ PRIORITY INVERSION, DOCUMENTED (Code Review, card b9e07a4a): {@link freeRepoPath} checks THIS map
   *  before ever considering `highWaiters` — a repo-guard-only waiter for `repoPath` ALWAYS wins the next
   *  hand-off over a same-repo `highWaiters` entry, REGARDLESS of arrival order, even one that has been
   *  queued far longer. This is a deliberate, accepted cost (a repo-guard-only wait is bounded by, at
   *  worst, another op's own squash — near-instant — never a full gate run), not a redesign of the
   *  existing FIFO/priority tiering; `highWaiters`/`lowWaiters`' OWN relative ordering (card 24642c3d) is
   *  completely unaffected — this inversion exists ONLY between this map and those two tiers, for the
   *  SAME contested `repoPath`. */
  private readonly repoGuardOnlyWaiters = new Map<string, Array<{ id: string; descriptor: RepoGuardOnlyDescriptor; enqueuedAt: number; resolve: () => void; reject: (err: Error) => void }>>();

  /** Card b9e07a4a Code Review: metadata for a repoPath CURRENTLY held via {@link acquireRepoGuardOnly}
   *  (never an `admit()`-based hold — those live only in {@link registry}) — exists purely so
   *  {@link repoGuardOnlySnapshot} can report a "holding" entry `gate_queue` can display; the actual
   *  admission state lives in {@link activeMergeRepos} as it always has, this is a read-side mirror only. */
  private readonly repoGuardOnlyHolders = new Map<string, { id: string; descriptor: RepoGuardOnlyDescriptor; since: number }>();
  private repoGuardOnlySeq = 0;

  /** Card b9e07a4a: the ONE place `activeMergeRepos` ever actually vacates a `repoPath` — shared by
   *  {@link release} (a `runExclusive`-admitted merge's own repo hold) and {@link releaseMergeRepoGuard}/
   *  {@link endSquash} (the same op's LATER, deferred release via `holdRepoGuardOnExit`), and
   *  {@link acquireRepoGuardOnly}'s own returned release closure.
   *
   *  IDENTITY-CHECKED FIRST (Code Review, card b9e07a4a, CRITICAL): `holderId` MUST equal what's currently
   *  stored for `repoPath` — see {@link activeMergeRepos}'s own doc for the exact cascade an unconfined
   *  free/hand-off used to allow (a failed-gate or cancelled-while-queued op deleting a live sibling's
   *  hold). A mismatch is a SAFE NO-OP (logged distinctly as `refused-not-owner`, never a throw — the
   *  calling `finally` blocks this guards must never fail) — this op does not own whatever is there right
   *  now, so it must not touch it.
   *
   *  Only once identity is confirmed does this check for a queued {@link acquireRepoGuardOnly} waiter for
   *  this SAME `repoPath`: if one exists, hands the hold DIRECTLY to it — `activeMergeRepos` never
   *  actually loses the key, it stays continuously present, just re-attributed (to the waiter's OWN
   *  internally-minted id — see `acquireRepoGuardOnly`'s own doc) in the SAME synchronous turn as the old
   *  holder's release. This atomicity is load-bearing: it is what makes a race with `acquire()`'s own
   *  synchronous fast-path check (`this.active < cap && this.worktreeFree(entry) &&
   *  this.mergeRepoFree(entry)`, called from a DIFFERENT `runExclusive` caller) impossible — that check
   *  can only ever observe `repoPath` as either "held by the old op" or "held by the new one", never a
   *  genuinely-free instant a third caller could slip into. Only once no repo-guard-only waiter is queued
   *  does this actually delete the key, leaving `repoPath` genuinely free for `grantNext()`'s own
   *  cap-based scan (called by every caller of this method, same as before this existed) to pick up. */
  private freeRepoPath(repoPath: string, holderId: string, releasingOpId: string | undefined, releasingSite: string): void {
    const current = this.activeMergeRepos.get(repoPath);
    if (current !== holderId) {
      console.log(`[gate:repo-guard] refused-not-owner repoPath=${repoPath} presentedId=${holderId} actualId=${current ?? "none"} opId=${releasingOpId ?? "?"} site=${releasingSite} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      return;
    }
    this.repoGuardOnlyHolders.delete(repoPath);
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

  /** Card c24dd48a: mark `repoPath` as squash-in-flight for merge-admission purposes — the counterpart to
   *  {@link endSquash}/{@link releaseMergeRepoGuard}, extending a `runExclusive`-admitted merge's own hold
   *  (already taken at admission via `admit`, kept alive past the gate's own settle by `holdRepoGuardOnExit`
   *  — see `runExclusive`'s own doc) across `confirmWorkerMerge`'s subsequent `mergeBranch` call.
   *
   *  CALLER CONTRACT, NOT MERELY "SAFE TO CALL": `confirmWorkerMerge` calls this ONLY when `gateRan` is
   *  true — i.e. ONLY for an op that actually went through `this.gateSemaphore.runExclusive(...)` this
   *  invocation (`gateRan = !reuseResult`, a provable proxy — see that call site's own doc). The REUSE path
   *  (card e50600d2, `reuseResult` set — its `??` short-circuits `runExclusive` entirely) and a GATELESS
   *  project/repo (`gate` falsy — never reaches a `runExclusive` call at all) DELIBERATELY NEVER call this;
   *  those two paths get NO admission-level protection from this mechanism, unchanged from before this
   *  card — `requireCanonicalHead` (inside `mergeBranch`'s own lock) is what protects them, exactly as it
   *  always has — see the standing TOCTOU note on `confirmWorkerMerge`'s reuse producer.
   *
   *  Card b9e07a4a Code Review: NO LONGER MUTATES {@link activeMergeRepos} AT ALL — an earlier version
   *  `.add()`-ed unconditionally, which under the (then-unidentified) IDENTITY gap could silently
   *  overwrite a correctly-stored `entry.id` fallback identity with this call's own `opId`, corrupting the
   *  ACTUAL holder's stored identity for a caller that never supplied a matching `opId` at admission. The
   *  hold's continuity is ALREADY fully guaranteed by `admit()` + `holdRepoGuardOnExit`'s release-skip
   *  (see `runExclusive`'s own doc) — there is nothing left for this call to acquire. It is now a
   *  VALIDATED marker only: logs the expected reaffirmation on a match, and a distinct
   *  `beginSquash-identity-mismatch` line (never a throw — this guards a `finally`-adjacent call site) on
   *  a mismatch, which should never happen in correct usage and is worth surfacing if it ever does.
   *
   *  `opId` is now REQUIRED (Code Review, card b9e07a4a) — it is the identity this call validates against,
   *  not merely forensics; every real call site already supplies the SAME `opId` used on the originating
   *  `GateDescriptor` (see that field's own doc). */
  beginSquash(repoPath: string, opId: string): void {
    const current = this.activeMergeRepos.get(repoPath);
    if (current !== opId) {
      console.log(`[gate:repo-guard] beginSquash-identity-mismatch repoPath=${repoPath} expectedId=${opId} actualId=${current ?? "none"} t=${performance.now().toFixed(3)} iso=${new Date().toISOString()}`);
      return;
    }
    this.logRepoGuardMutation("add", repoPath, opId, "beginSquash");
  }

  /** Card c24dd48a: end a `beginSquash` hold (the squash has settled — landed or failed, doesn't matter
   *  which) and grant the freed repo to the next eligible queued waiter, if any. Same effect as
   *  {@link releaseMergeRepoGuard} — kept as a distinctly-named pair with {@link beginSquash} purely for
   *  readability at the call site (begin/end bracketing one squash call), not a different mechanism. Same
   *  caller contract as {@link beginSquash} — `confirmWorkerMerge` calls this ONLY when `gateRan` is true.
   *  IDENTITY-CHECKED (card b9e07a4a Code Review) via {@link releaseMergeRepoGuard}'s own `opId` match —
   *  see {@link activeMergeRepos}'s own doc for the exact cascade this closes: a `gateRan:true` op whose
   *  gate FAILED (never held anything past its own `release()`) or was cancelled while queued (never held
   *  anything at all) can now call this unconditionally and safely — it simply won't match whatever (if
   *  anything) is currently stored, and is refused as a no-op rather than deleting a sibling's live hold.
   *  `opId` is now REQUIRED — see {@link beginSquash}'s own doc for why. */
  endSquash(repoPath: string, opId: string): void {
    this.releaseMergeRepoGuard(repoPath, opId);
  }

  /** Card c24dd48a: explicitly free a per-repo merge-admission guard — see {@link endSquash}'s doc (its
   *  synonym) for when/why to call this.
   *
   *  Card b9e07a4a Code Review (CRITICAL): routed through {@link freeRepoPath} (same as {@link release}),
   *  IDENTITY-CHECKED against `opId` — an absent key OR a key held by a DIFFERENT identity is a safe
   *  no-op (never a throw), which is what closes the reviewer's reproduced cascade (see
   *  {@link activeMergeRepos}'s own doc): a `gateRan:true` op whose gate FAILED, or was cancelled while
   *  still queued, never actually holds `repoPath` under ITS OWN `opId` — this call correctly refuses to
   *  touch whatever a DIFFERENT, genuinely-admitted op (or a handed-off repo-guard-only waiter) currently
   *  holds there instead. On a genuine match: a queued {@link acquireRepoGuardOnly} waiter for this SAME
   *  repoPath is handed the guard directly instead of ever observing it as free — this is the path a REAL
   *  merge gate's deferred `holdRepoGuardOnExit` release actually takes (`endSquash`, called well after
   *  this op's own `release()`), and without this an inert-diff-skip waiter queued behind a real gate's
   *  squash phase would never be woken.
   *
   *  `opId` is now REQUIRED (Code Review, card b9e07a4a) — it is the identity this call validates against,
   *  not merely forensics (card 96d5f76b) — see {@link beginSquash}'s own doc for the full reasoning. */
  releaseMergeRepoGuard(repoPath: string, opId: string): void {
    this.freeRepoPath(repoPath, opId, opId, "releaseMergeRepoGuard");
    this.grantNext();
  }

  /** Grant exactly ONE freed slot to the next eligible waiter — drains `highWaiters` before touching
   *  `lowWaiters`, same as before card 8d585277, but WITHIN a tier this no longer blindly `.shift()`s the
   *  head: it scans for the first waiter whose worktree (if any) isn't STILL held by some other running
   *  entry AND whose repo (if any, card 92e960d1 — a `merge` gate only) isn't STILL held by some other
   *  running merge, skipping past a blocked head-of-line waiter to admit a later, eligible one instead —
   *  the mechanism that makes the per-worktree AND per-repo guards compose with the existing priority
   *  queue rather than deadlocking behind it. A worktree-less/repo-less waiter is never skipped by either
   *  check (see `worktreeFree`/`mergeRepoFree`). Grants at most one waiter per call, matching `release()`'s
   *  own one-slot-freed contract — unchanged from before this card.
   *
   *  CAP CHECK (card d9d5057f): gated on `this.lastKnownCap` before scanning any tier — chosen over
   *  threading a fresh `cap` through every call site because `releaseMergeRepoGuard`/`endSquash` (the
   *  OTHER caller, invoked standalone from `confirmWorkerMerge`, outside `runExclusive` entirely) has no
   *  `cap` in scope at all and is a PUBLIC method other code already calls by this exact signature; adding
   *  a `cap` param there would be a breaking API change for a value this class already tracks. Both
   *  callers were previously assumed "release-shaped" (called only when a slot had JUST freed, so
   *  `active` was already `< cap` by construction) — true for `release()` (its own `this.active--` runs
   *  immediately before this call, in the same synchronous turn) but NOT for `releaseMergeRepoGuard()`:
   *  it frees a REPO guard, not a cap slot — the cap slot for that same op was already freed earlier, at
   *  its own `release()` call, and an unrelated op can have consumed that freed slot in the gap between
   *  the two. A cap-blind grant here would then over-admit past `cap`. `lastKnownCap` is the same
   *  RESOLVE-LIVE value `runExclusive` already refreshes on every call (see its own doc + the
   *  `[gate] maxConcurrentGates …` transition log) — reading it here extends that existing liveness
   *  instead of freezing a cap captured at construction time. `undefined` (no `runExclusive` call has
   *  ever happened yet) never blocks — unreachable in practice, since `grantNext()` is only ever reached
   *  from `release()`/`releaseMergeRepoGuard()`, both of which presuppose at least one prior admission
   *  that already set this.
   *
   *  ⚠️ Fixing this gap INVALIDATES a premise card `96d5f76b`'s investigation relied on: reasoning about
   *  whether a decline at `release()`/`endSquash()` was cap-caused or repo-caused held ONLY because
   *  `grantNext()` had no cap check. Any conclusion from that investigation resting on that premise needs
   *  re-deriving now, not assumed to still hold. */
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
   *
   * `fn` ALSO receives a fifth param (card c24dd48a), `holdRepoGuardOnExit`: a callback `fn` can call —
   * synchronously, any time before it returns — to declare that this run's per-repo merge-admission guard
   * (a `merge`-kind descriptor's `repoPath` in {@link activeMergeRepos}) should survive PAST this call's
   * own settle instead of releasing automatically in the `finally` below. This exists for EXACTLY ONE
   * caller shape: `confirmWorkerMerge`'s gate callback, which calls it iff the gate it just ran PASSED —
   * a passing gate is about to hand off to that caller's own squash phase (`mergeBranch`, called outside
   * this method entirely), and the whole point is to close the gap where a queued same-repo sibling could
   * otherwise be admitted the INSTANT this gate settles but strictly BEFORE the squash actually lands (see
   * `GateDescriptor.repoPath`'s own doc for the incident this closes). Calling it is what makes that
   * transition ATOMIC: the flag is read by THIS SAME `finally` block, in the SAME synchronous turn `fn`
   * set it in, so there is no `await`-shaped window between "gate settled" and "guard still held" for a
   * queued waiter's own `grantNext` to slip through. The caller is then on the hook to release the guard
   * explicitly, later, once its own squash phase has itself settled — via `endSquash`/
   * `releaseMergeRepoGuard(repoPath)` — a hold with no matching release is a PERMANENT block on that repo,
   * so every call site that ever invokes this must have a `finally` that unconditionally reaches the
   * release, no matter which of throw/cancel/timeout/pass/fail the squash itself hits. A caller whose `fn`
   * never calls this (every pre-c24dd48a call site, and any FAILING merge gate) is byte-identical to
   * before this parameter existed — `holdRepoGuard` defaults to `false` and `release()` frees the guard
   * exactly as it always has.
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
