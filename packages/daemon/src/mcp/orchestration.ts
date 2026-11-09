import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { contextWindowForModel, contextPercentFor, resolveConfig, resolveProfile, QUESTION_STATES, QUESTION_TYPES, type SessionRole, type KanbanColumn, type Session, type OrchestrationEvent, type GateType } from "@loom/shared";
import { QUESTION_ASK_INPUT_SHAPE, buildQuestionAsk, finalizeQuestionAsk, appendQuestionAskedEvent, pullQuestionsForAgent, auditRequestItem, pageRequests, cancelQuestionForAgent, amendQuestionForAgent, resolveQuestionForAgent, resolveOwnerTextForQuestionResolve, applySupersede, noticeOwnerActionAdvisory } from "./questionTool.js";
import { DEFAULT_REQUESTS_LIST_CAP } from "./audit.js";
// Card 40f4cae9 — the `fields:[...]` projection carried forward from `tasks_list` (card 23fde5f8): reuse
// the SAME generic `pickFields` (mcp/tasks.ts) rather than writing a second projector — see that
// function's own doc for its three deliberate properties (no-op when `fields` is omitted, an unknown
// field name silently ignored, `id` never auto-added).
import { pickFields } from "./tasks.js";
import { resolveAlias, strictShape } from "./arg-alias.js";

/** A manager's RECORDED (never authenticated) reason for landing a red-self-check tip ungated: trimmed, non-empty, bounded. */
const OVERRIDE_REASON_SCHEMA = z.string().trim().min(1).max(500);
import { instrumentServer } from "./call-record.js";
import { currentColumns, type DesiredColumn } from "../tasks/columns.js";
import type { Db } from "../db.js";
import { MAX_GATE_HISTORY_PAGE, DEFAULT_GATE_HISTORY_PAGE, MAX_EVENTS_SEARCH_PAGE } from "../db.js";
import { eventsSearchQuery, eventsCountQuery, DEFAULT_EVENTS_SEARCH_CAP, EVENT_SEARCH_VALID_KINDS_LIST } from "./eventsSearch.js";
import type { PtyHost } from "../pty/host.js";
import { possibleDuplicateRootLabel, withinKickoffConfirmWindow, kickoffConfirmWindowMs } from "../pty/host.js";
import type { ToolAttributionResult } from "../pty/tool-attribution.js";
import type { SessionService, MergeBatchResult } from "../sessions/service.js";
import { describeBranchRetainedCauseUnverifiableSuffix } from "../sessions/service.js";
import { readTranscript, pageTranscript, lastNTurns, applyAggregateWalkCap, spillableTurnsResponse } from "../sessions/transcript.js";
import { spillTextIfLarge, spillRowsIfLarge, spillableAgentGet, SPILL_INLINE_BUDGET_CHARS } from "../spill.js";
import { UsageLimitError } from "../orchestration/usage-awareness.js";
import { deriveAwaitingReview } from "../orchestration/report-resolution.js";
import { computeGateTimingBand, readFailedNamesForOp } from "../orchestration/gate-timing-band.js";
import { deferredTriggerNotice } from "../orchestration/deferred-trigger-notice.js";
import { isSupervised } from "../orchestration/restart.js";
import { MANAGER_SESSION_BARRED_ERROR } from "../agents/clone-core.js";
import { CapQueueRejectedError } from "../orchestration/cap-queue.js";
import { nextFireAt } from "../orchestration/cron.js";
import { withScheduleTimeEcho, nowEcho } from "../orchestration/time-echo.js";
import { reminderNextFireAt, reminderNextFireAtBySession } from "../companion/reminders.js";
import type { CompanionReminder, CompanionRoute } from "../companion/types.js";
import { resolveIdPrefix, MIN_ID_PREFIX_LEN } from "../id-prefix.js";
import { buildServedStatusAsync } from "../served-status.js";
import { advisoryBuildStamp } from "../deploy-staleness.js";
import { lineageRootId } from "../sessions/lineage.js";
import { isSupersededByRecycle, retiredCallerMessage, currentUnresolvedSettleSuccessor, unresolvedSettleEscalationHint } from "../orchestration/crash-orphaned-workers.js";
import { resolveResumeDocPath } from "../sessions/resume-doc-notes.js";
import { runResumeDocCheck, containUnderVault } from "../orchestration/rotation-check.js";
import {
  authorCompanionSkill,
  listCompanionSkills,
  readCompanionSkill,
  removeCompanionSkill,
} from "../skills/companion-store.js";
import {
  authorCompanionMemory,
  listCompanionMemories,
  readCompanionMemory,
  removeCompanionMemory,
} from "../skills/companion-memory-store.js";
import { registerCompanionCapabilities, clearPendingProposalsForSession } from "../companion/capabilities.js";
import { createOwnerAttestation, OwnerConfirmStore, AuthoredContentGrantStore } from "../companion/attestation.js";
import { CompanionTrustWindow } from "../companion/trust-window.js";
import { GitWriter } from "../git/writer.js";
import type { FreshMintInfo, PendingOpView, CacheHitInfo } from "../orchestration/pending-ops.js";
import { INTENT_MAX_LEAD_MS } from "../orchestration/gate-intent.js";
import { contextTelemetryFor } from "../pty/adapter.js";

// Same envelope as the task MCP server (mcp/server.ts).
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** Project a row down to exactly the fields named in `keys` — same shape as entityRowFields.ts's own
 *  local `pickFields` helper (not exported there, so this is a small standalone copy, not a shared
 *  import) — generic so `out[k] = row[k]` type-checks against a homomorphic `Pick<T, K>`. */
function pickKeys<T, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = row[k];
  return out;
}

/**
 * Card 615967c5 — the cached-verdict-legibility fix: `AttachResult.freshMint` (set by PendingOpRegistry
 * ONLY for a genuine fresh mint, never a cache hit — see that class's own doc) is registry-shaped
 * (`reason`/`priorIdentity`/`currentIdentity`), not response-shaped. These two helpers turn it into the
 * `worker_merge_confirm` response fields + a reason-specific `note`, so a caller can never mistake an
 * announced fresh gate run for a replayed cached verdict. OBSERVED FIELDS ONLY — this reports what the
 * registry recorded (the identities), never asserts WHY they differ (e.g. never claims "main advanced";
 * `identity-mismatch` names the OBSERVATION, the note states the two shas and lets the caller judge).
 */
function freshMintResponseFields(freshMint: FreshMintInfo | undefined): Record<string, unknown> {
  if (!freshMint) return {};
  return {
    supersededBy: freshMint.reason,
    ...(freshMint.priorIdentity !== undefined ? { cachedVerdictIdentity: freshMint.priorIdentity } : {}),
    ...(freshMint.currentIdentity !== undefined ? { currentIdentity: freshMint.currentIdentity } : {}),
    ...(freshMint.priorMainTip !== undefined ? { cachedVerdictMainTip: freshMint.priorMainTip } : {}),
    ...(freshMint.currentMainTip !== undefined ? { currentMainTip: freshMint.currentMainTip } : {}),
  };
}

/** DoD-5 (card 615967c5): the `untilSupersededVerdicts` cache is PROCESS-LOCAL — a daemon restart clears
 *  it (see PendingOpRegistry's own doc) — so "genuinely-new" must never read as "this branch has never
 *  been checked"; it may simply mean the cache was cleared. Neither other branch claims any durability
 *  property, so only that one needs the caveat. */
function freshMintNote(freshMint: FreshMintInfo): string {
  switch (freshMint.reason) {
    case "identity-mismatch":
      // Card e8df2659: the two shown identities are the bare commit (the merge-gate suffix is scrubbed), so
      // EQUAL ones mean the only thing that changed is the project's merge-gate switch.
      if (freshMint.priorIdentity !== undefined && freshMint.priorIdentity === freshMint.currentIdentity) {
        return `a prior verdict for this worker exists for the SAME commit ${freshMint.priorIdentity}, but the project's merge-gate switch has changed since it was earned — ` +
          "so this call is running under the current setting FOR REAL, not replaying that verdict from cache. This is a genuinely new run, not a cache hit.";
      }
      // @decision 3a460d4a — both identities are DEFINED here by construction (the registry only produces
      // "identity-mismatch" when both resolved) — never fall back to a vague string that would also,
      // wrongly, read as honest for the unresolved case ("identity-unresolved", below).
      return `a prior verdict for this worker exists but describes commit ${freshMint.priorIdentity}; ` +
        `this call found the branch now at ${freshMint.currentIdentity} (e.g. the worker pushed a new commit, a sibling's squash moved it, or sometimes this call's own union-merge ` +
        "since that verdict) — so it is being gated FOR REAL, not replayed from " +
        "cache. This is a genuinely new gate run, not a cache hit.";
    // @decision 3a460d4a — DISTINCT from "identity-mismatch": an identity could not be resolved at all
    // here, not two different commits compared. Never claim a commit "moved" — there is none to name.
    case "identity-unresolved":
      return freshMint.priorIdentity !== undefined
        ? `a prior verdict for this worker exists for commit ${freshMint.priorIdentity}, but this call could not resolve the branch's CURRENT identity (e.g. a transient git read error) — ` +
          "with no way to confirm it still describes the same commit, the cached verdict was not trusted and this re-ran for real rather than risk replaying a stale answer. This is a genuinely new gate run, not a cache hit."
        : "this call could not resolve this worker's identity (e.g. a transient git read error), and no prior verdict's identity could be confirmed either — " +
          "the cached verdict was not trusted and this re-ran for real rather than risk replaying a stale answer. This is a genuinely new gate run, not a cache hit.";
    case "main-advanced":
      // @decision c06f876a — same commit, different mainline: a genuinely different tree to gate, not a re-roll.
      return `a prior verdict for this worker exists for the SAME commit ${freshMint.priorIdentity ?? "(unknown)"}, but the mainline has advanced since it was earned ` +
        `(${freshMint.priorMainTip?.slice(0, 8) ?? "?"} -> ${freshMint.currentMainTip?.slice(0, 8) ?? "?"}) — so this call is gating the branch against the CURRENT main FOR REAL, not replaying that verdict from cache. This is a genuinely new gate run, not a cache hit.`;
    case "forced":
      return "forceRemoveWorktree:true bypassed any cached verdict" +
        (freshMint.priorIdentity !== undefined ? ` (which described commit ${freshMint.priorIdentity})` : "") +
        " and is running a genuinely fresh gate, as requested — not a cache replay.";
    case "genuinely-new":
      return "no cached verdict exists for this worker in this daemon process yet (this cache is process-local — " +
        "a daemon restart also produces this, even for a branch checked before) — this is a genuinely new gate " +
        "run, not a cache replay.";
  }
}

/**
 * Card 4aedde84 — the cache-hit-legibility fix: the mirror of {@link freshMintResponseFields} for the
 * branch that fix left silent. `r.cacheHit` (set by `PendingOpRegistry` ONLY on an actual cache-served
 * settle — see `CacheHitInfo`'s own doc) is registry-shaped, not response-shaped; this turns it into the
 * `servedFromCache` field a caller can check directly instead of having to notice the ABSENCE of
 * `supersededBy` — the exact incident this card fixes (a manager who had `supersededBy` in view on a
 * PREVIOUS call did not think to check for its absence on the next). `cacheHit` and `freshMint` are set in
 * disjoint branches of the SAME decision inside `attach()` (see that class's own doc), so the two markers
 * can never both appear — never derived from two independent checks that could theoretically disagree.
 */
function cacheHitResponseFields(cacheHit: CacheHitInfo | undefined): Record<string, unknown> {
  if (!cacheHit) return {};
  return { servedFromCache: true };
}

/** Card 4aedde84 — the note accompanying `servedFromCache`, naming what the incident showed a manager
 *  actually needed to notice: the opId being replayed (`opId` is `undefined` whenever the caller passes
 *  it that way for a thrown-error settle — both call sites below do, unconditionally, since a thrown
 *  error's raw value carries no opId of its own), the identity that verdict was validated against (when
 *  the registry knows it), and the ONE path that re-runs an unchanged commit.
 *
 *  @decision 7f86c02f — a thrown-error cache hit is now UNREACHABLE for both of this function's only
 *  two callers (every throw classifies "unknown", or solo-only "not-your-worker" — both never-cached).
 *  The `opId:undefined` branch below stays harmless/dead-safe, not a claim that shape still occurs.
 *
 *  Card d240fceb, m1 — `forceRemoveWorktree` is a `worker_merge_confirm` parameter only; `merge_batch`'s
 *  own strict schema has no such field, so the cache-defeat tail must say something else there. Pass
 *  `forceOverridePath: "worker_merge_confirm"` from the `merge_batch` call site; omit it (or pass nothing)
 *  for the solo path, which keeps the original, byte-identical wording. */
export function cacheHitNote(cacheHit: CacheHitInfo, opId: string | undefined, forceOverridePath?: "worker_merge_confirm"): string {
  const base = "served from cache: this is the SAME verdict already returned" +
    (opId !== undefined ? ` for op ${opId}` : "") +
    (cacheHit.identity !== undefined ? `, validated against commit ${cacheHit.identity}` : "") +
    " — no gate ran on this call, and the branch has not changed since that verdict was produced. ";
  return base + (forceOverridePath === "worker_merge_confirm"
    ? "This call has no cache-defeat parameter of its own; to force a genuine re-run of one specific candidate's exact, unchanged commit, call worker_merge_confirm on it directly with forceRemoveWorktree:true (merge_batch itself cannot bypass this cache)."
    : "To force a genuine re-run of this exact, unchanged commit, re-call with forceRemoveWorktree:true " +
      "(the only path that bypasses this cache).");
}

/** Card e8e98d43 (the sync explanation) / card d240fceb, m1 (the historical wording) — extracted to a
 *  named, exported, pure function so it can be unit-tested directly against a synthetic `finishRefused`
 *  array, independent of the full batch/git/DB fixture weight `merge_batch`'s own tool handler needs.
 *  Worded HISTORICALLY on purpose: this note may describe a CACHE REPLAY of an earlier run (see
 *  `cacheHitNote`, right above), so a `finishRefused` entry states that run's own outcome, never a claim
 *  about the candidate's current state — it may since have been separately finalized via
 *  `worker_merge_confirm`, which this note cannot see. Returns `undefined` for an empty/absent list. */
export function buildFinishRefusedNote(finishRefused: MergeBatchResult["finishRefused"]): string | undefined {
  if (!finishRefused || finishRefused.length === 0) return undefined;
  return `FINISH REFUSED AS OF THAT RUN (fast-forwarded onto main but NOT finalized at that time — task/worktree/worker untouched as of that verdict; check its CURRENT state before assuming this is still true): ${finishRefused.map((f) => `${f.branch}: ${f.reason} — run worker_merge_confirm on ${f.workerSessionId} to check its current state and finalize if still needed (re-firing merge_batch will NOT re-evaluate it)`).join("; ")}.`;
}

/**
 * Card 343441bd: the staleDirective threshold — a delivered `worker_message` directive with no
 * worker_report seen after delivery, once at least this many of the worker's OWN turns have completed
 * (see PtyHostEvents.onTurnCompleted for what counts as a "turn" — a real Stop/StopFailure completion
 * only, never a stuck/never-started submit). Turn-count-based rather than wall-clock: one turn increments
 * exactly once regardless of its own duration, so a worker legitimately deep in ONE long build reads as
 * turnsSinceDelivery ≤ 1 no matter how long it runs — the no-false-alarm property is structural, not
 * threshold-tuned. Named constant (not a magic literal) so a future tune doesn't need to hunt for it.
 */
const STALE_DIRECTIVE_TURN_THRESHOLD = 3;

/**
 * Card 4491bd3b (DoD-1) — the `staleReport` threshold, the MIRROR of `STALE_DIRECTIVE_TURN_THRESHOLD`
 * for the opposite direction: a worker_report sitting `awaitingReview:true` while the MANAGER's own
 * turnSeq has advanced this many times since the report was recorded (`managerTurnSeqAtReport`, stamped
 * by `workerReport` in sessions/service.ts). Same turn-count-not-wall-clock rationale as the sibling
 * constant — a manager legitimately deep in one long turn right after the report lands reads as
 * turnsSinceReport ≤ 1, never a false alarm. This does NOT claim the report was lost, ignored, or seen —
 * only that the manager's session kept cycling turns while this specific report stayed unresolved, which
 * is the mechanism-agnostic, server-side-derivable signal the card asks for.
 */
const STALE_REPORT_TURN_THRESHOLD = 3;

// Card c5b234aa: {ctxMeasuredAt, ctxMidTurn} — ctxMeasuredAt mirrors `ctxUpdatedAt` (when this ctx
// reading was last written, by either the Stop hook or the mid-turn sampler); ctxMidTurn is true ONLY
// while that reading was taken DURING the turn that's STILL running (busy && ctxUpdatedAt at-or-after the
// current turn's own rising edge, `lastActivity` — the same invariant context-watcher.ts's checkBlindTurn
// already relies on) — false (never a bare null) once idle, or whenever ctxUpdatedAt predates the current
// turn (a stale, carried-over-from-before-this-turn reading — exactly the gap card 8c7dfc65 exists to
// close). `null` input (no session row to read, a placeholder row) returns the not-determinable
// {ctxMeasuredAt:null, ctxMidTurn:null} pair. Module-scope (not a `buildServer`-local const) because
// `registerMyContext` and `buildServer`'s `fleetView`/`worker_status` are separate method scopes that
// both need it.
//
// ⚠️ APPROXIMATE, not exact: `lastActivity` is the current turn's rising edge for the mid-turn sampler's
// own purposes, but it is ALSO bumped by several OTHER, turn-unrelated writes — `Db.setLastError`, `setProcessState`,
// `setEngineSessionId`, and the capabilities/skills/connections patch (db.ts) all stamp it too. So a
// mid-turn bump from one of THOSE (not a real turn boundary) can make `ctxMidTurn` read `false` for a
// reading that is, in fact, still perfectly fresh — it self-corrects the moment the NEXT sample lands
// (the sampler's next tick re-stamps `ctxUpdatedAt` past the new `lastActivity` again). Never read a
// single `false` here as proof a reading is stale; it is a useful signal, not an exact one.
function ctxMidTurnFields(
  w: Pick<Session, "busy" | "ctxUpdatedAt" | "lastActivity"> | null,
): { ctxMeasuredAt: string | null; ctxMidTurn: boolean | null } {
  return w
    ? { ctxMeasuredAt: w.ctxUpdatedAt ?? null, ctxMidTurn: w.busy && w.ctxUpdatedAt != null && w.ctxUpdatedAt >= w.lastActivity }
    : { ctxMeasuredAt: null, ctxMidTurn: null };
}

/** `gate_status(opId)` is a read-only lookup, scoped per-caller, with no pass/fail outcome path of its
 *  own.
 *
 *  @decision edc1ec12 — a scoped (worker) miss must never claim `never_existed`; the scoping filter
 *  can't tell "never existed" from "belongs to someone else" apart, so it returns `"unknown"` instead.
 *
 *  @decision bed91595 — never reintroduce an in-process opId cache/reclassification for `deploy`; the
 *  durable `pending_gate_ops` tombstone already covers restart-survival and unbounded retention.
 *
 *  Field-provenance pointers for the two description branches below, relocated out of the agent-facing
 *  text (an end-user agent can't resolve a card/decision id). Entries with a matching docs/decisions
 *  record use @decision; a bare `card <id>` line has no such record and is a plain provenance citation.
 *
 *  @decision a16c580b — `outputFile`/the cross-project redaction field list use a wrapper object.
 *
 *  card 45390f74 — the live-only `note` field's "do NOT poll" guidance, both branches.
 *
 *  @decision 3407caad — `proximity`, the warn-before-breach companion to `extended`.
 *
 *  @decision 24642c3d — a post-timeout retry's hard ceiling carries no auto-extend.
 *
 *  @decision d5e67146 — the `pending` tombstone's own liveness signal (`ownerSessionAlive`), and why a
 *  merge_batch op can legitimately read `pending` for tens of minutes.
 *
 *  @decision 19c0ef1e — `timingBand`, best-effort and additive.
 *
 *  card 1ec2e353 — the on-disk NDJSON key stays `testCount` for history compatibility.
 *
 *  card c8df9663 — `poolSize`/`isolatedPhaseFileCount` are matched exactly, never widened.
 *
 *  @decision 0f0816e2 — the isolated sequential phase is curated, not name-pattern-derived.
 *
 *  card 5f3a394e — `deferredTriggerNotice`, both branches.
 *
 *  @decision 5ef78900 — the cross-project redaction list widened to cover `timingBand`'s own numeric
 *  disclosure.
 *
 *  @decision 99a1cf6f — `attempt`/`priorAttemptMs`/`attemptStartedAt` are live-entry-only fields.
 *
 *  @decision 68155573 — a retry CONTINUES its original admission; it is never re-queued.
 *
 *  @decision 7ad12202 — dispatch on the gate's own verdict, never on `retryPassed` alone — the
 *  `attempt:3` third-link-of-the-same-admission shape this backs.
 *
 *  card 2ec00f6a — `priorAttemptVerdict`, attempt 1's own failed verdict.
 *
 *  @decision fd0d34da — `emitCompareNotApplicableKind` is a cross-project-visible category, not a path.
 *
 *  @decision a228dfb5 — a `"skipped"` merge verdict must map to `outcome:"skipped"`, never a plain pass.
 *
 *  @decision db9b0130 — the inert-diff proof backing a docs-only `"skipped"` merge shares its shared-diff
 *  flags with two load-bearing, unrelated reasons.
 *
 *  @decision 720bb7ad — `steps`'s own env stamp and batch-size requirement.
 *
 *  @decision e2b6f900 — `gateCap`/`concurrentGates`/`concurrentGatesMax` are two imperfect lenses, never
 *  a single combined "contention score".
 *
 *  @decision 318ac7b2 — a single-file retry cancelled while still queued never loses attempt 1.
 *
 *  @decision 725dc89a — `emitCompareReduced` is persisted retrospectively, tri-state.
 *
 *  @decision 65336570 — the reduced-gate declaration is echoed onto the merge-done nudge live, before
 *  this field makes it readable after the fact too.
 *
 *  @decision 2154b6ad — "ran REDUCED" means emit-compare skips the runtime suite, never the whole gate.
 *
 *  @decision 72769424 — the import/scanner widening rules fold additional test files in.
 *
 *  @decision 2db8a3dd — `notApplicable` and "ran the full suite" are distinct terminal states; the first
 *  one reached wins.
 *
 *  card edbf9bd1 — `emitCompareTestFiles`, the selected test file(s) actually run.
 *
 *  card 17cd1f30 — `emitCompareNotHermeticExcluded`, the specific excluded file names.
 *
 *  @decision 7a1a76e9 — a taskless merge's commit subject uses the branch tip, never the branch name.
 *
 *  @decision b88704bb — `worker_merge`'s own review surfaces this same prospective commit subject.
 *
 *  @decision 6dcb9cd3 — `retriedFile` is a positive, measured negative (`null`), never an absent key.
 *
 *  @decision 344ce950 — the bounded single-file retry's cost, and why a pass-after-retry is weaker
 *  evidence than an ordinary clean pass.
 *
 *  @decision 67030bb9 — `retryWarning`'s three cases, corrected to be present on a fail too; also backs
 *  `batchBranchCount` and the (absent-here) `retryDeclineReason`.
 *
 *  @decision 4ad6ccfd — the batch-sync return's `retryWarning` mirrors this tool's own gating.
 *
 *  @decision 9bdc8ea5 — `formatRetryAlsoFailedWarning` is a separate function from the pass-side one.
 *
 *  @decision 553ea58c — `batchLanded` is a separate, later fact from `batchBranchCount`; never conflate
 *  them.
 *
 *  @decision b801bad0 — a batch fast-forward pins and re-verifies the checked-out branch; an unverified
 *  landing is a third, distinct `undefined` meaning on a pass row.
 *
 *  @decision b480dda9 — `batchBranchCount` vs `batchLanded` is a correlated subquery, not a join — never
 *  "fix" a forfeited row by zeroing branchCount instead.
 *
 *  @decision a0d1165c — `transientRetried` is mutually exclusive with `retriedFile`.
 *
 *  @decision bcba83a1 — the transient-kill auto-retry this backs, so managers stop routing around the
 *  gate.
 *
 *  @decision 81d795de — a merge_batch's own settle is deferred to whole-batch completion, the gap
 *  `d5e67146` above closes.
 *
 *  card fde10c75 — `emittedBuild`, the current-vs-stale one-token stamp.
 *
 *  @decision 8ff7ccde — `emittedBuild` derives from `runningCodeBuiltAt`; a rebuild can outpace the
 *  running process, so the raw on-disk `distBuiltAt` would understate staleness. */
function registerGateStatus(server: McpServer, sessions: SessionService, db: Db, scopeSessionId?: string, getScopeProjectId?: () => string | undefined, getRedactCrossProjectCallerProjectId?: () => string | undefined): void {
  const forWorker = scopeSessionId != null;
  const description = forWorker
    ? "Read-only status for YOUR OWN gate run, by the `opId` a `run_gate` {status:\"pending\"} " +
      "response returned — lets you check whether that run is still queued behind the daemon's gate " +
      "concurrency cap, actually executing, or has already reached a terminal state, WITHOUT starting a " +
      "new gate run and WITHOUT waiting for the eventual completion nudge. Use this instead of re-calling " +
      "`run_gate` when you only want to ask \"am I queued or stuck?\" — re-calling `run_gate` is also an " +
      "ACTION (it can attach to your in-flight op and return `staleAgainstWorktree`, a result you must " +
      "then discard); this tool never starts or affects a run, it only reads. SCOPED to YOUR OWN session: " +
      "an opId belonging to another session's gate run is indistinguishable from `unknown` here — you " +
      "cannot use this to probe another worker's run. `opId` accepts the FULL id OR an unambiguous " +
      "8-char id-prefix (the short id `run_gate` returned). Returns {state:\"queued\"|\"running\"|" +
      "\"pending\"|\"settled\"|\"evicted-dead-owner\"|\"orphaned-by-restart\"|\"unknown\"|" +
      "\"ambiguous\", gateType, elapsedMs, idleMs, extended?, error?, note?, admittedAt?, " +
      "passed?, cancelled?, reason?, " +
      "durationMs?, validatedHead?, headWarning?, steps?, outputTail?, outputFile?, gateDetail?, proximity?}. " +
      "`outputFile`, present whenever `outputTail` is, is an absolute path to this op's " +
      "FULL captured gate output — `outputTail` above is a bounded ~4KB (or content-selected ~16KB on a " +
      "failure) tail that can cut a diagnostic mid-line; the file is never truncated on that account (only " +
      "a much larger, disk-usage-only ceiling can still cap it on a pathological run). Retained on a " +
      "rolling, count-bounded window across the whole daemon — an old op's file may already be gone by the " +
      "time you read this back; treat a missing file at this path as \"aged out\", not a bug. `note` " +
      "is present ONLY while `state` is `queued`/`running` and carries the SAME \"Do NOT poll\" " +
      "guidance `run_gate`'s own not-settled reply already gives: stop calling this tool on a timer, " +
      "`worker_report progress` with `awaiting:\"background\"`, and END your turn — the `[loom:gate-done]`/" +
      "`[loom:gate-failed]` nudge starts your next turn with the result. `admittedAt` (ISO, when " +
      "the op was minted) is present whenever a row exists at all — live or settled — not gated on a " +
      "recorded verdict. ⚠️ IT READS as \"when this op was admitted past the gate concurrency cap\" but is " +
      "NOT that — a queued op can sit for minutes before it's actually admitted, so don't difference it " +
      "against a settle time expecting queue-wait-excluded duration; the field that DOES re-base to true " +
      "admission is `gate_queue`'s (or this SAME tool's own pre-settle) `since`/`elapsedMs`, but only while " +
      "the op is still LIVE (`queued`/`running`) — once settled there is no queue-wait-excluded field left. " +
      "`queued`/`running` mean it's still " +
      "LIVE. `settled` means the op reached a normal terminal result (pass, fail, error, or cancelled). " +
      "The `[loom:gate-done]`/`[loom:gate-failed]` nudge is still the PRIMARY, unprompted way you learn the " +
      "outcome — but once `state` reads `settled`, this tool NOW ALSO reports it directly: `passed:true` " +
      "(a green run) or `passed:false` (a real failure, with `reason` + `gateDetail` — the SAME " +
      "phase/failedStep/failingTest/exitCode/signal/timedOut diagnosis the failure nudge embeds) are set " +
      "together with `durationMs`/`validatedHead`/`headWarning`/`steps` (the same per-step timings the " +
      "green merge nudge already carries) and a bounded `outputTail` (present on BOTH a pass and a fail — " +
      "a passing run used to retain none of this at all). `gateDetail.failingTest` is a FLOOR, not a " +
      "complete account, unless `gateDetail.failingTestCount` reads exactly `1` — `undefined` count means " +
      "`failingTest` is itself `undefined` (nothing recognizable at all); `1` means the named test IS the " +
      "whole story; `>1` means it's only the LAST of several matching lines, and the others (possibly a " +
      "different file, possibly a different assertion shape) are NOT named anywhere in this result. Even at " +
      "`1`, this is a prompt to go run the file and enumerate — never proof by itself that nothing else " +
      "could be wrong. Never size a fix from `failingTest` alone when `failingTestCount` is `>1`; go read " +
      "the actual file. `proximity` ({nearBudget, step, fraction}) is a WARN-BEFORE-BREACH signal — unlike `extended` (which only ever tells you a run " +
      "ALREADY consumed its one-time auto-extend, i.e. already breached budget), `proximity.nearBudget:true` " +
      "means the worst step's `durationMs` crossed a threshold set well above this project's own healthy " +
      "steady state, so it's worth raising `gateCommandTimeoutMs`, splitting the suite, or investigating " +
      "what got slower — BEFORE the next run actually times out. `fraction` is ALWAYS against the RAW, " +
      "configured `gateCommandTimeoutMs` — the HARD ceiling a post-timeout retry enforces with NO " +
      "auto-extend — never the ~2× effective ceiling a FIRST attempt's own one-time " +
      "auto-extend can reach; a `fraction` over `1` means this step already needed more than the hard " +
      "ceiling and only survived because it was a first attempt, so a RETRY of it would have no such net. " +
      "Present on BOTH a pass and a fail whenever " +
      "a real gate spawned; `undefined` for a gateless project or a REUSED self-check, same discipline as " +
      "`extended`. `cancelled:true` (with `reason`, no `passed`) " +
      "means no verdict was ever reached — a manager's `gate_cancel`, or your self-check being superseded " +
      "by a merge decision — never read the ABSENCE of `passed` alone as a failure; check `cancelled` " +
      "first. Every one of these fields is OMITTED, never a fabricated `null`/`false`, when there's nothing " +
      "recorded — a settled op predating this capability, or one whose thrown-error settle only ever " +
      "carries a bare `reason`. Use this to recover a verdict you missed or lost the nudge for; it is NOT a " +
      "replacement for the nudge as your primary signal — don't poll this on a timer waiting for `passed` " +
      "to appear, wait for the nudge and use this as the fallback. `evicted-dead-owner` and " +
      "`orphaned-by-restart` are edge-case terminal states you're " +
      "unlikely to see for your OWN gate op (they're merge-op/restart shapes) — if you do, treat them like " +
      "`settled`: no verdict was ever reached, re-run `run_gate` if you still need one. `pending` is rare for " +
      "your OWN gate op: the op is known to exist but isn't visible in the live registry yet (a narrow " +
      "just-started or post-restart window) — wait and re-check rather than treating it as stuck. (This " +
      "state widens for a manager's own `merge_batch` op, whose tombstone can sit `pending` " +
      "for tens of minutes — see the manager-facing description below; for your own `run_gate` self-check " +
      "specifically the window stays narrow.) While `pending`, `elapsedMs` is time SINCE MINT (not since " +
      "admission — there's no live admission clock left once an op has fallen out of the registry). " +
      "(This tool ALSO carries an `ownerSessionAlive` field on the MANAGER surface for exactly this " +
      "widened-`merge_batch` case — omitted HERE: your own scoped lookup can only ever resolve an op YOU " +
      "started, so it would always read `true` and teach you nothing.) `unknown` covers BOTH " +
      "\"this opId never existed\" AND \"it exists but isn't yours\" — this tool deliberately can't (and " +
      "won't) tell those apart for you (that's what keeps it from being usable to probe another worker's " +
      "run), so never read `unknown` as proof an id is bogus; never confuse it with `settled` either (a " +
      "real op may well have run, you just have no visibility into it from here). `ambiguous` (with " +
      "`error` naming the matching opIds, among YOUR OWN ops only) means your prefix matches more than one " +
      "of your own ops — pass more characters or the full id. `elapsedMs` is PHASE-SCOPED to `state` while " +
      "`queued`/`running` (the SAME " +
      "way `gate_queue`'s `since`/`elapsedMs` are — while `state` is `queued` it measures time WAITING " +
      "since enqueue; the moment it flips to `running` the SAME field RE-BASES to admission time and " +
      "measures time RUNNING instead), and `null` for every other state (nothing live left to time). So a " +
      "large `elapsedMs` alone doesn't mean you're stuck — check `state` first: a big number while still " +
      "`queued` is queue depth, not a hung run; compare it against how long this project's gate normally " +
      "takes (in whichever phase `state` reports) before concluding it's wedged and re-firing. BUT EVEN A " +
      "LARGE `elapsedMs` WHILE `running` IS NOT ITSELF EVIDENCE OF A WEDGE: your own gate auto-extends a " +
      "step's timeout, rather than killing it, for as long as the step keeps producing output (see " +
      "`GATE_EXTEND_IDLE_MS`'s doc in gate-runner.ts) — a long-running-but-healthy gate is routine, not a " +
      "red flag. `idleMs` (`Date.now()` minus your step's last liveness event — started, or produced a " +
      "stdout/stderr byte, the SAME clock your gate's own auto-extend decision reads, not a second, " +
      "independently-computed number) is " +
      "the signal that actually distinguishes \"working hard\" from \"hung\": non-null once your step has " +
      "genuinely started (normally the same instant `state` flips to `running`, though a brief real gap " +
      "right after admission — before your gate's own pre-flight check finishes — can still read `null` " +
      "too), `null` while " +
      "`queued` (nothing has started yet) or any other state. A SMALL `idleMs` on a `running` entry (recent " +
      "output) means the step is alive and producing output no matter how large `elapsedMs` has grown — " +
      "not proof it's converging (a stuck-but-retrying step emits just as steadily); a `idleMs` " +
      "approaching this project's gate-idle threshold is the real warning sign. `extended` (present, " +
      "always `true`/`false`, only while `queued`/`running`) tells you whether the CURRENT step has already " +
      "used its one-time auto-extend — `true` means a stall from here would be killed at the NEXT deadline, " +
      "not given another reprieve. Still not a " +
      "replacement for the completion nudge — check this when you're unsure whether to keep waiting, don't " +
      "poll it on a timer. " +
      "On a `settled` row with a recorded verdict, ALSO carries `timingBand?` — a " +
      "stratified comparison against this project's OWN gate-timing history, computed ONLY when this " +
      "op's own `run-summary` row is found in the timing NDJSON (never fabricated otherwise, so its " +
      "absence means \"nothing to compare against\", not \"this run was slow\"): {poolSize, " +
      "testFileCount (a FILE count — one per hermetic test FILE, never per individual test/assertion; " +
      "the on-disk NDJSON key stays `testCount` for compatibility with existing history), " +
      "testFileCountSpan, isolatedPhaseFileCount, n, nUnfiltered, nExact, minSec?, medianSec?, maxSec?, " +
      "instrument, filter, readWindowBytes, readWindowTruncated}. `poolSize` AND `isolatedPhaseFileCount` " +
      "(0 for a flat pooled run, positive when an isolated sequential phase " +
      "ran ahead of the pool) are BOTH matched EXACTLY and NEVER widened: pool size dominates run duration " +
      "more than population size does (a smaller pool at a bigger testFileCount can run FASTER than a " +
      "bigger pool at a smaller one), and a flat run vs. an isolated-phase run measure a structurally " +
      "different thing (a run's scheduling shape, not just its pool size or file count, drives its " +
      "duration) — pooling across either would be a category error, not a convenience, so a band can " +
      "never silently mix scheduling shapes. " +
      "`testFileCount` starts as an EXACT match but widens outward to " +
      "the nearest neighbouring testFileCount values when the exact match alone has fewer than a named " +
      "floor (8) of clean samples — measured live: it increments on every single test file added or " +
      "removed, so an exact-only match is statistically empty (n<5) for the large majority of real strata, " +
      "emptiest right after someone changes the suite, exactly when a duration comparison matters most. " +
      "`testFileCountSpan` (`[min,max]`) is the ACTUAL testFileCount range the band below was computed " +
      "over — equal to `[testFileCount,testFileCount]` when no widening happened, a real range when it " +
      "did; always read this before trusting `n` describes an exact match. `n` counts runs across " +
      "`testFileCountSpan` (same `poolSize`, excluding every row this op's own opId ever wrote — a " +
      "retried op can leave more than one) that were BOTH complete and zero-failure — " +
      "`minSec`/`medianSec`/`maxSec` are computed over exactly that filtered population; `nUnfiltered` is " +
      "the same (possibly widened) population before that filter, so you can see how much a few " +
      "flaky/failing runs would otherwise have skewed the median slow; `nExact` is the clean count for the " +
      "EXACT testFileCount match alone, reported regardless " +
      "of whether widening happened, so a widened band never hides how thin the exact match actually was. " +
      "`instrument`/`filter` name what produced the numbers (never read a duration without its producer " +
      "— `run-summary.durationMs` is NOT the same clock as this tool's own `durationMs`/`totalDurationMs` " +
      "above) and `filter` also states in plain text whether/why widening happened. " +
      "`readWindowTruncated:true` means older history outside a bounded tail " +
      "read was never considered — `n`/`nUnfiltered`/`nExact` may undercount the true population, never " +
      "overcount it. " +
      "On a FAILED settled row, ALSO carries `deferredTriggerNotice?` — the SAME " +
      "`[loom:deferred-trigger] ...` advisory text the `[loom:gate-failed]` completion nudge composes, " +
      "RECOMPUTED here at read time rather than only relied on from that one-shot push: present whenever " +
      "some task on this project has annotated itself `deferredUntilEvent:{kind:\"gate-fail-naming\"}` " +
      "naming one of THIS run's own failed test files, absent (never a fabricated empty string) when no " +
      "task matches. Re-derived fresh on every call from the durable gate-timing NDJSON plus the board's " +
      "CURRENT deferral state — so calling this after a missed or lost completion nudge (including one " +
      "the daemon never got to enqueue because it crashed between this op settling and that push) still " +
      "recovers the SAME advisory, not a stale or absent one."
    : "Read-only status for ONE merge-gate run, by the `opId` a `worker_merge_confirm` " +
      "{status:\"pending\"} response returned — lets you check whether that run is still queued behind the " +
      "daemon's gate concurrency cap, actually executing, or has already reached a terminal state, WITHOUT " +
      "waiting for the eventual completion nudge. `opId` accepts the FULL id OR an unambiguous 8-char " +
      "id-prefix (the short id Loom displays everywhere else — same resolution as `tasks_get`/" +
      "`worker_spawn`/`escalation_status`). Returns {state:\"queued\"|\"running\"|\"pending\"|\"settled\"|" +
      "\"evicted-dead-owner\"|\"orphaned-by-restart\"|\"never_existed\"|\"unknown\"|\"ambiguous\", gateType, elapsedMs, " +
      "idleMs, extended?, attempt?, priorAttemptMs?, attemptStartedAt?, priorAttemptVerdict?, error?, note?, admittedAt?, ownerSessionAlive?, settledAt?, totalDurationMs?, outcome?, proximity?, steps?, " +
      "outputTail?, outputFile?, gateDetail?, gateCap?, concurrentGates?, concurrentGatesMax?, emitCompareReduced?, " +
      "emitCompareNotApplicableKind?, skipReason? (\"gate-disabled\" when the merge landed with the human-only merge gate OFF, or \"gate-interval\" when the human-only gate INTERVAL let it land ungated (not its turn) — outcome \"skipped\", never a pass; or \"all-candidates-dropped\" on a merge_batch whose BATCH gate never ran because every candidate was dropped at assembly and handed to its own worker_merge_confirm — outcome \"skipped\", passed:false, batchBranchCount:0, batchLanded:false; the gate was NOT switched off, and each candidate's own solo op (its own opId/gate_status) says whether it landed; totalDurationMs includes those fallback runs; or \"assembly-aborted-rollback-unverified\" on a merge_batch whose BATCH gate never ran because a candidate's own rollback could not be verified clean — assembly stopped EARLY (unlike \"all-candidates-dropped\", some candidates may never have been attempted at all), and the SAME outcome \"skipped\"/passed:false/batchBranchCount:0/batchLanded:false shape applies, each original candidate routed to its own solo worker_merge_confirm; or \"watermark-unreadable\" on a merge_batch refused before any worktree cut because the stored mainline watermark record is unreadable — outcome \"skipped\", passed:false, batchBranchCount:0, batchLanded:false, no per-candidate fallback started; or \"forfeited-at-admission\" on a merge_batch that re-checked canonical main at GATE ADMISSION (before the real gate command ever spawned) and found main had already moved since the batch was cut — outcome \"skipped\", passed:false, batchLanded:false, each candidate routed to its own solo worker_merge_confirm; or \"canonical-trust-refusal-at-admission\" on a merge_batch whose SAME admission-time re-check instead found a structural canonical-git TRUST refusal (a commondir redirect or pin mismatch) rather than an ordinary forfeit — outcome \"skipped\", passed:false, batchLanded:false, but — unlike forfeited-at-admission — NO per-candidate fallback is started at all (never cached; a re-fire after a human repairs the canonical repo genuinely re-attempts the batch) — unlike every OTHER \"skipped\" shape above, BOTH forfeited-at-admission and canonical-trust-refusal-at-admission carry the REAL assembled batchBranchCount (never 0): this batch WAS fully assembled before either was detected, it just never got a gate run; or \"reduced-gate-only-file-failed\" — the reduced gate's own --only-file= overflow selection could not be written (a transient host condition, e.g. disk/permission) before any gate step ever spawned, on EITHER a solo worker_merge_confirm (outcome \"rejected\", never cached — a re-confirm genuinely retries) or a merge_batch (outcome \"skipped\", passed:false, batchBranchCount:0, batchLanded:false, each candidate routed to its own solo worker_merge_confirm — never counted as a merge-gate RED/gateOwed)), " +
      "this tool is UNSCOPED for a manager — a real opId from ANY project on this daemon resolves here, not " +
      "just your own. For an op belonging to a DIFFERENT project than yours, the following are REDACTED (omitted) — every field that can carry that project's own " +
      "content, paths, or identifiers: `outputFile`, `outputTail`, `steps`, `gateDetail`, `reason`, " +
      "`commitSubject`, `retriedFile`, `retryWarning`, `emitCompareTestFiles`, " +
      "`emitCompareNotHermeticExcluded`, `validatedHead`, `headWarning`, `timingBand` (a foreign project's " +
      "test-file count and gate-duration distribution — mirroring `gate_queue`'s own cross-project " +
      "redaction), `deferredTriggerNotice` (names a foreign project's own card id and " +
      "failed test file; never even computed for a cross-project op, not merely stripped after the fact), " +
      "and `ownerSessionAlive` (see below for why this one is redacted despite " +
      "carrying no path/test/error content of its own). This is an EXPLICIT, enumerated list, not " +
      "\"everything sensitive\" by " +
      "inference — treat any field not named here as VISIBLE on a foreign read, never assume redaction. " +
      "What stays visible on a foreign read: `state`/`passed`/`cancelled`/`outcome`/`gateType`/`durationMs`/" +
      "`admittedAt`/`settledAt`/`totalDurationMs`/`extended`/`attempt`/`priorAttemptMs`/`attemptStartedAt`/`proximity`/`gateCap`/`concurrentGates`/" +
      "`concurrentGatesMax`/`emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareNotApplicableKind`/`skipReason`/" +
      "`retryPassed`/`transientRetried`/" +
      "`transientRetryWarning` — this is a targeted redaction of content-bearing fields, not a refusal. " +
      "`attempt`/`priorAttemptMs`/`attemptStartedAt` are present ONLY while `state` is `queued`/`running` " +
      "(a live-entry-only concept, same population scope as `extended`). `attempt`/`priorAttemptMs` are ONLY for a `merge`-kind op — " +
      "`undefined` on every ordinary first admission (`attemptStartedAt` is set for EVERY running entry). `attempt:2` means this LIVE entry is `confirmWorkerMerge`'s " +
      "OWN single-file or transient-kill retry — a CONTINUATION of the SAME admission: it keeps " +
      "the cap slot and the per-repo guard straight through the fail->retry gap and is NEVER re-queued, so it " +
      "reads `state:\"running\"`, never `queued`, and `elapsedMs` keeps counting from the ORIGINAL admission. " +
      "`attemptStartedAt` (ISO) is when the CURRENT attempt began — equal to the admission time on a first " +
      "attempt, later once a retry continued it; `null` while queued. `attempt:3` (both " +
      "the solo AND batch merge paths) means a single-file retry above already passed but the original gate " +
      "short-circuited on a non-final step — this is a THIRD link of the same admission re-running whatever step(s) " +
      "never got to run, so a pass can be reported without a configured step ever silently going unexecuted. " +
      "`priorAttemptMs` alongside either is how long everything BEFORE this attempt already ran (attempt 1, and the " +
      "retry for `attempt:3`). `priorAttemptVerdict` is attempt 1's own failed " +
      "verdict {attempt:1, passed:false, durationMs, retriedFile, failingTest?} — present ONLY on a live " +
      "`attempt>=2` single/multi-file retry (a retry now reads running), so a retry never hides that " +
      "attempt 1 FAILED; the same fact is durable as a `build_gate_single_file_retry_attempt` event. `retriedFile`/" +
      "`failingTest` are omitted on a cross-project read (`attempt`/`passed`/`durationMs` stay). Read this before concluding a long-`running` merge op is stuck — " +
      "a retry is a routine continuation of the same admission, not a wedge or a lost verdict. " +
      "`emitCompareNotApplicableKind` is a coarse CATEGORY naming why `emitCompareReduced` " +
      "itself is `undefined` (e.g. `\"repo-out-of-domain\"`, `\"path-out-of-scope\"`) — it never carries a " +
      "path/filename/error string the way `reason` does, which is exactly why it's safe to leave visible " +
      "where `reason` itself is redacted. " +
      "`ownerSessionAlive` is the ONE EXCEPTION to \"redacted only when content-bearing\": it's a bare " +
      "boolean with no path/test/error content, but unlike `gateCap`/`concurrentGates` (daemon-GLOBAL " +
      "operational facts) it's a PER-TENANT fact about one foreign project's own session, AND a foreign " +
      "reader has no stake or available action on it either way — by the time a tombstone reaches " +
      "`state===\"pending\"` its op has already left the shared GateSemaphore (no slot held, nothing a " +
      "foreign caller could contend with), so there's no fleet-operational reason to disclose it. Redacted " +
      "on that basis (a dedicated code review), not because it fails the usual content test. " +
      "emitCompareIdenticalCount?, emitCompareTestFiles?, emitCompareNotHermeticExcluded?, commitSubject?, " +
      "retriedFile?, retryPassed?, retryWarning?, transientRetried?, transientRetryWarning?}. `queued`/`running` " +
      "mean it's still LIVE — and while it is, this reply's `note` carries an explicit " +
      "\"Do NOT poll\" instruction: stop re-calling this tool on a timer, `idle_report({state:\"waiting\"})`, " +
      "and END your turn — the `[loom:merge-done]`/`[loom:merge-rejected]`/`[loom:merge-failed]` nudge " +
      "starts your next turn with the result. `settled` means the op reached a normal terminal " +
      "result (merged, rejected, or errored) — rely on the `[loom:merge-done]`/`[loom:merge-rejected]`/" +
      "`[loom:merge-failed]` nudge as your PRIMARY, unprompted way to learn the outcome, but a settled op " +
      "now ALSO retains a durable, queryable RECORD you can pull on demand: `outcome` " +
      "(`\"pass\"`|`\"fail\"`|`\"error\"`|`\"cancelled\"`|`\"skipped\"` — `\"pass\"` means merged AND a real " +
      "gate spawned and passed, `\"fail\"` means a resolved rejection, `\"error\"` means a thrown exception " +
      "mid-confirm; `\"skipped\"` means merged — the code DID land — but NO gate ever " +
      "spawned because the branch's entire changed-path set was proven inert, docs-only: " +
      "`passed` reads `false` for it, same as `\"cancelled\"`, since no verdict was ever reached — check " +
      "`outcome`, never `passed` alone, to tell a genuine merge-with-no-gate apart from an ordinary pass; " +
      "`commitSubject` (below) is still present, since the merge itself did land), `steps` (" +
      "per-step `{step,durationMs,status}` at sub-ms precision, present on BOTH a pass and a fail, the same " +
      "shape the completion nudge's own steps line renders from — DIAGNOSTIC ONLY: a step's `status` is NOT " +
      "the verdict for this op and must never be read as one (see `outcome`/`passed` for the real verdict) " +
      "— a `\"pass\"` op can carry a `steps[]` entry with a nonzero `status` from a FIRST gate attempt that " +
      "genuinely failed before a single-file retry (see `retriedFile` below) passed and the merge landed; " +
      "reading that entry's `status` as THE answer, instead of `outcome`, is exactly how a retry-assisted " +
      "pass gets misread as a failing gate that merged code) and a bounded `outputTail`, and — on a " +
      "`\"fail\"` only — `gateDetail` (phase/failedStep/failingTest/exitCode/signal/timedOut, the SAME " +
      "diagnosis the `[loom:merge-rejected]` nudge embeds). `gateDetail.failingTest` is a FLOOR, not a " +
      "complete account, unless `gateDetail.failingTestCount` reads exactly `1` — `undefined` count means " +
      "`failingTest` is itself `undefined`; `1` means the named test IS the whole story; `>1` means it's " +
      "only the LAST of several matching lines, and the others (possibly a different file, possibly a " +
      "different assertion shape) are NOT named anywhere in this result. Even at `1`, this is a prompt to " +
      "go run the file and enumerate — never proof by itself that nothing else could be wrong. Never size a " +
      "fix from `failingTest` alone when `failingTestCount` is `>1`; go read the actual file. " +
      "`gateCap`/`concurrentGates`/`concurrentGatesMax` are the gate CONCURRENCY this op " +
      "ran under — present on BOTH a pass and a fail via THIS tool (before this card a PASSING merge " +
      "carried none of this HERE — neither this tool's return nor the durable store behind it — and a " +
      "FAILING one only baked it as unstructured TEXT into the `[loom:merge-rejected]` nudge, never here. " +
      "`gate_history`, a separate audit-event series, already had this triple on both outcomes before this " +
      "card; use it for a multi-row trend, this field for a single opId's own recovery). `gateCap` is the " +
      "resolved concurrency cap in force at admission. `concurrentGates` " +
      "is a SNAPSHOT AT ADMISSION ONLY — how many gates were admitted together the instant THIS one started " +
      "— and UNDERSTATES contention: a second gate joining seconds later never moves it. `concurrentGatesMax` " +
      "is the TRUE max-over-run figure and OVERSTATES a brief overlap as full contention — it can't tell " +
      "\"contended the whole run\" from \"joined for the last few minutes\". Read them as two different, " +
      "imperfect lenses on the same question, never as a single settled answer — and never derive a combined " +
      "\"contention score\" from them, which would hide exactly that span ambiguity. ⚠️ RETRIES CONTINUE ONE ADMISSION: " +
      "a single-file or transient-kill retry runs as a link of the FIRST attempt's own admission (it is never re-queued), so on every " +
      "row written since this triple describes that ONE admission — `concurrentGates` is attempt 1's " +
      "admission snapshot and `concurrentGatesMax` is the max across the WHOLE chain (attempt 1 plus its retry/resume " +
      "links). HISTORICAL (older rows): a retry re-admitted through the semaphore separately, so on a " +
      "non-null `retriedFile` the triple described the RETRY's admission instead (and the cancelled-retry " +
      "shape left it describing attempt 1's). A live `gate_queue` read taken while the op ran now agrees with this " +
      "settled triple by construction; cross-check `retriedFile` only for older rows before " +
      "comparing a settled " +
      "`concurrentGates`/`concurrentGatesMax` against an earlier live `gate_queue` observation of this op. " +
      "Same `undefined`-for-" +
      "no-gate-spawned discipline as `steps`/`outputTail` above. `admittedAt` (ISO, when the op was MINTED — " +
      "present whenever a row exists at all, live or settled) READS as \"when this op was admitted past " +
      "the gate concurrency cap\" but is NOT that: a queued op can sit for minutes before it's actually " +
      "admitted (routine at `maxConcurrentGates>=2`), so `totalDurationMs` (`settledAt - admittedAt`, " +
      "below) silently INCLUDES that queue wait — it's the real total op wall time (worktree prep + queue " +
      "wait + union-merge + gate + squash), never a queue-wait-excluded figure. The field that DOES " +
      "re-base to true admission is `gate_queue`'s (or THIS SAME tool's own pre-settle) `since`/`elapsedMs` " +
      "— but only while the op is still LIVE (`queued`/`running`); read it there before it settles if you " +
      "need queue wait specifically — there is no settled-and-queue-wait-excluded field. `settledAt` (ISO) " +
      "pairs with `totalDurationMs` (`settledAt - admittedAt`, the FULL op wall time — worktree prep + " +
      "union-merge + gate + squash, not just the gate step itself; strictly ≥ `Σ(steps)`, which is only " +
      "ever a FLOOR on the real total). `extended` here means something different from the LIVE `extended` below: once settled, it " +
      "reports whether ANY step of the gate this op actually ran ever consumed its one-time auto-extend — " +
      "`undefined` (not `false`) when no gate spawned for this op at all (gateless project, a REUSED " +
      "self-check, or an inert-diff `outcome:\"skipped\"` merge), so `extended:true` paired with `outcome:\"fail\"` is the specific \"this run was over " +
      "budget AND it failed\" signal worth flagging, distinct from either fact alone. `proximity` " +
      "({nearBudget, step, fraction}) is a WARN-BEFORE-BREACH companion to `extended` — " +
      "unlike `extended` (which only ever fires AFTER a breach), `proximity.nearBudget:true` fires while " +
      "a run is still comfortably PASSING, once its worst step's duration crosses a threshold set well " +
      "above this project's own healthy steady state — worth raising `gateCommandTimeoutMs`, splitting " +
      "the suite, or investigating what got slower BEFORE the next run actually times out. `fraction` is " +
      "ALWAYS against the RAW, configured `gateCommandTimeoutMs` — the HARD ceiling a post-timeout retry " +
      "enforces with NO auto-extend — never the ~2× effective ceiling a FIRST attempt's " +
      "own one-time auto-extend can reach; a `fraction` over `1` means this step already needed more than " +
      "the hard ceiling and only survived because it was a first attempt. Same " +
      "`undefined`-for-no-gate-spawned discipline as `extended`. `emitCompareReduced` is the " +
      "RETROSPECTIVE answer to \"was this merge's gate reduced, and what went ungated?\" — the SAME " +
      "declaration `[loom:merge-done]` already announces live, now readable after the fact " +
      "once that nudge has scrolled away. TRI-STATE, deliberately: `true` means a real gate spawned for this " +
      "op and ran REDUCED (a build step + the static guards + any selected test file " +
      "(changed, plus any pulled in by the import/scanner widening rules), instead " +
      "of the full suite, because every changed compiled file was proven transpile-identical); `false` means " +
      "a real gate spawned and was PROVEN NOT reduced — never confuse this with `undefined`, which means " +
      "no gate spawned for this op at all (gateless project, a REUSED self-check, or an inert-diff " +
      "`outcome:\"skipped\"` merge), this settled row " +
      "predates this field, OR a real gate DID spawn and ran the FULL suite on a repo " +
      "whose layout this predicate can never evaluate in the first place — its hardcoded " +
      "backend-source/test path scope and `scripts/test-daemon.mjs`/`typescript`-dev-dependency " +
      "requirements make it, by construction, ONLY EVER decidable (`true`/`false`) on a project shaped " +
      "like Loom's own daemon package; on every other project `emitCompareReduced` reads `undefined` here " +
      "too, not by coincidence — same structural-layout-limit disclosure `retriedFile` gives below for its " +
      "own hardcoded assumption. A bare `undefined` conflating \"genuinely not reduced\" with \"nothing " +
      "recorded\" (of either cause) is exactly the ambiguity `emitCompareNotApplicableKind` " +
      "narrows: set IFF a real gate spawned AND the predicate itself returned `notApplicable:true` (never " +
      "on a genuine `true`/`false`, and never when no gate spawned at all) — one of `\"repo-out-of-domain\"` " +
      "(a REPO-LEVEL fact, checked via a dedicated `git ls-tree` against the repo's own tree, never inferred " +
      "from this diff alone: NONE of the four scope directories exist anywhere in this repo, so the " +
      "predicate could never decide ANY diff on it — every project that isn't Loom's own daemon package), " +
      "`\"path-out-of-scope\"` (covers BOTH remaining shapes, which share the identical actionable fact: " +
      "the predicate applies to this repo fine, just not — fully, or at all — to THIS diff. Either THIS diff " +
      "touched an out-of-scope path while the SAME diff also touches an in-scope one elsewhere, OR the " +
      "repo's own tree DOES have one of the four scope directories even though this particular diff doesn't " +
      "touch it), " +
      "`\"harness-config-unavailable\"`, `\"typescript-unresolvable\"`, `\"git-operation-failed\"`, " +
      "`\"empty-diff\"`, or `\"unparseable-diff\"`. `emitCompareIdenticalCount` (the " +
      "count of compiled files proven transpile-identical) and `emitCompareTestFiles` (the " +
      "SELECTED test file(s) actually run directly: changed files PLUS any pulled in by the import/scanner " +
      "widening rules — never read its length as a count of files THIS diff changed) are " +
      "present ONLY alongside `emitCompareReduced:true`. " +
      "`emitCompareNotHermeticExcluded` names the SPECIFIC changed test file(s) excluded " +
      "from `--only=` because they're NOT_HERMETIC (same exclusion the full suite already makes) — the file " +
      "names, not just a count, so you can tell WHICH changed test(s) went ungated without re-deriving it; " +
      "an empty array here means none were excluded, distinct from `emitCompareReduced` itself being " +
      "`undefined`/`false`. Same two-dominant-outcomes population as `gateCap`/`concurrentGates` above " +
      "(a plain gate-fail rejection, a plain successful merge) — populated for \"merge\" rows only. " +
      "`commitSubject` is the landed squash subject (the same `commitSubject`, the " +
      "SAME value the sync `worker_merge_confirm` return and the `[loom:merge-done]` nudge carry) — the " +
      "documented \"if you need the answer sooner\" poll for a QUEUED merge, which previously could not " +
      "answer this at all. Present on `outcome:\"pass\"` OR `\"skipped\"` (a skip still " +
      "lands a real new commit, just with no gate behind it; a rejection/error never lands one); " +
      "`undefined` for every other outcome, the ALREADY_MERGED case (no new commit lands there either), or " +
      "a settled row that predates this card — never fabricated. These settled- " +
      "record fields are OMITTED, never fabricated, for a settled op that predates this capability. " +
      "⚠️ `retriedFile`/`retryPassed`/`retryWarning` — A SETTLED `outcome:\"pass\"` CAN BE A " +
      "RETRY-ASSISTED PASS, WEAKER EVIDENCE THAN AN ORDINARY CLEAN PASS, and these are the fields that " +
      "discriminate. The bounded single-file retry / the bounded multi-file retry (AND — " +
      "a batch op via merge_batch, not just a solo worker_merge_confirm) merge gate can retry UP TO " +
      "`MULTI_FILE_RETRY_MAX` identifiable failing test files together in isolation " +
      "before rejecting; if that retry passes, the merge lands as an ordinary `outcome:\"pass\"` — the SAME " +
      "shape a clean first-attempt pass has, unless you read these three fields. `retriedFile` is a " +
      "comma-joined list of the retried file name(s) (a bare single name for the N=1 case, byte-identical " +
      "to before this field existed), or a literal `null` — DELIBERATELY a MEASURED NEGATIVE here, NOT this " +
      "tool's usual undefined-means-nothing-to-report discipline: `null` positively asserts \"no such retry " +
      "fired for this row\", present on every settled \"merge\" pass/fail going forward (same present-with-" +
      "null-vs-absent-key contract `composerDirtyLen`/`recentTimeoutStreak` use elsewhere on this daemon) — " +
      "`undefined` means only \"this row predates this field\" or \"this op never reached a pass/fail " +
      "verdict at all (cancelled/errored)\", never \"no retry\". `retryPassed` mirrors `retriedFile`'s own " +
      "null-vs-undefined discipline: `null` whenever `retriedFile` is `null`; when `retriedFile` names a " +
      "real file, `true`/`false` — never assume a non-null `retriedFile` implies `retryPassed:true`. " +
      "CORRECTED: this used to also claim `retryPassed` \"STAYS `null`\" for the retry-" +
      "cancelled-while-queued exception — false for THIS tool's own return: such an op settles " +
      "`outcome:\"cancelled\"`, and the whole pass/fail/skipped-gated block described above (including " +
      "`retriedFile`) is simply ABSENT for that outcome, never `null`. The real `retriedFile`-non-null-" +
      "plus-`retryPassed:null` shape exists only on a DIFFERENT record — see the `retryWarning` note just " +
      "below for that same audit-event-vs-payload distinction. `retryWarning` (correcting an earlier claim here that it was " +
      "present whenever `retriedFile` was non-null, regardless of outcome — that produced a REJECTED op " +
      "whose warning text asserted \"passed only after retrying\") is present ONLY when `retryPassed` is " +
      "STRICTLY `true` or `false` (never for the `null`/never-verdicted exception just above, where neither " +
      "wording would be honest — that mixed shape is not currently reachable on THIS field anyway; it is " +
      "the `gate_history` `build_gate` audit event's own cancelled-while-queued row that carries it, a " +
      "different tool from this one). On `retryPassed:true` it's " +
      "\"⚠ WEAKER PASS: the first gate attempt failed; passed only after retrying '<file>' in isolation " +
      "once...\" — the SAME wording the `[loom:merge-done]` nudge already renders live for this exact op, " +
      "one shared formatter feeding both, so a caller who only ever reads `gate_status` (never the nudge) " +
      "gets the identical warning, not a paraphrase. On `retryPassed:false` it's a DIFFERENT formatter's " +
      "DISTINCT \"⚠ RETRY ALSO FAILED...\" wording (no live-nudge analogue exists for this case — a rejected " +
      "op never reaches the nudge's own `merged`/`ok`-gated render at all) that never contains the word " +
      "\"passed\" — for a SINGLE retried file, the retry reproducing the failure in isolation rules out an " +
      "order-dependent/cross-test-pollution bug; for MULTIPLE retried files it only rules out pollution " +
      "from the rest of the suite, never pollution among the retried files themselves (they ran " +
      "concurrently in one pool by default), and the wording is scoped accordingly rather than asserting " +
      "the stronger single-file claim regardless of N. An order-dependent/cross-test-pollution bug can pass " +
      "alone in isolation and fail in the full suite — exactly the class this single-file retry can otherwise mask — " +
      "so treat a non-null `retriedFile` pass differently from an ordinary clean one before reporting it up " +
      "as a plain green. Populated for \"merge\" rows only (a \"gate\"/worker-self-check row has no " +
      "this-retry mechanism at all) and, structurally, ONLY EVER non-null on a project whose gate " +
      "runs THIS daemon's own hermetic test-runner script — `identifyRetriableTestFiles` " +
      "hardcodes that layout, so on every other project `retriedFile` reads `null` by construction, not by " +
      "coincidence. ⚠️ `retryDeclineReason` is NOT a field on THIS tool's return — a genuine " +
      "gate failure's decline reason (WHY `identifyRetriableTestFiles` refused to identify a retry) is " +
      "durable ONLY on `gate_history`'s own row (see that tool's own `retriedFile`/`retryDeclineReason` " +
      "doc), never recovered here; `gate_status(opId)`'s settled read has no equivalent field for it. " +
      "`batchBranchCount` is present ONLY on a `merge_batch`-produced row: the count of " +
      "branches ASSEMBLED into the batch worktree during assembly (correction — an earlier " +
      "version of this doc wrongly called it \"how many branches actually landed\"). It stays PRESENT AND " +
      "ACCURATE regardless of whether the batch actually landed — see `batchLanded` below for that separate, " +
      "later fact; do not read a present `batchBranchCount` as proof of a landing on its own. Fed into " +
      "`retryWarning` so a retry-assisted BATCH pass names the count, not just the solo wording. " +
      "🔴 `batchLanded` is present ONLY alongside a `merge_batch`-produced `outcome:\"pass\"` " +
      "row: whether the gate (and any single-file retry) passing actually resulted in the assembled branches " +
      "landing on main. A stored `false` is a MEASURED NEGATIVE (the batch's fast-forward forfeited because " +
      "canonical main advanced mid-gate, or the canonical checkout diverted to an unexpected branch) — " +
      "`undefined` carries a THIRD, distinct meaning on a `merge_batch` pass row: " +
      "the fast-forward genuinely landed but its POST-landing re-read failed, so the result could not be " +
      "VERIFIED (never \"it did not land\" — the opposite is more likely); check the op's own `reason`/the " +
      "durable `batch_merge_ff_unverified` event, then confirm with a plain `git log` on mainline before " +
      "trusting either way. On every OTHER row shape `undefined` means only \"not a batch row\" or \"predates " +
      "this field\", never \"nothing to report\". `retryWarning`'s own batch clause " +
      "(\"ALL N land on the strength of this ONE retry\") is omitted — never rendered — whenever " +
      "`batchLanded === false`, WITHOUT touching `batchBranchCount` itself, which stays visible: the count " +
      "and the landing outcome are two separate facts, never conflated (the sibling `gate_history` surface " +
      "carries the same precedent — \"do NOT 'fix' a forfeited row by zeroing branchCount instead\"). " +
      "⚠️ `transientRetried`/`transientRetryWarning` — the SIBLING gap this closes: a " +
      "settled `outcome:\"pass\"` can ALSO be reached via the TRANSIENT-KILL AUTO-RETRY, " +
      "which auto-retries the WHOLE gate once after attempt 1 was killed/timed out — mutually exclusive " +
      "with the single-file retry above (a first attempt is classified either \"genuine\", eligible for " +
      "`retriedFile`, or \"kill\"/\"timeout\", eligible for THIS retry, never both — so `retriedFile` and " +
      "`transientRetried` are never both non-null/`true` on the same op). Before this card this fact was " +
      "\"nudge text only\": the live `[loom:merge-done]` push rendered it, but nothing durable recorded it, " +
      "so a manager who missed that one nudge (a recycle, a restart, a successor reading history later) saw " +
      "an ordinary clean pass with no way to tell it apart. `transientRetried` is a MEASURED NEGATIVE, the " +
      "identical present-with-false-vs-absent-key contract `retriedFile` uses (present-with-null): a stored " +
      "`false` positively asserts \"this verdict was NOT reached via this retry\", present on every settled " +
      "\"merge\" pass/fail going forward; `undefined` means only \"this row predates this field\" or " +
      "\"cancelled\"/\"error\" (never computed there). `transientRetryWarning` is present ONLY when " +
      "`transientRetried` is `true`: the SAME `formatTransientRetryWarning()` text the live nudge already " +
      "renders for this exact op — one shared formatter, so a caller who only ever reads `gate_status` gets " +
      "the identical warning, never a paraphrase. Same \"the concurrency triple beside this note describes " +
      "the RETRY's own admission, not attempt 1's\" caveat the live nudge's wording already carries. " +
      "⚠️ `gate_history[].transientRetried` means something DIFFERENT: there it names which ROW IS the " +
      "retry's own row (true on a pass OR a rejection), never a weaker-verdict signal — don't carry this " +
      "field's meaning across surfaces. " +
      "`evicted-dead-owner` means the op's OWNING MANAGER died before it settled and a later confirm force-" +
      "evicted it — its own run() may STILL be executing unreachable in the background; no verdict was " +
      "ever delivered for it, treat it like `settled` for planning purposes and just re-run " +
      "`worker_merge_confirm`. `orphaned-by-restart` means this op's outcome could not be recovered after a " +
      "daemon restart (no durable settle record was found for it) — you should already have received a " +
      "synthetic `[loom:merge-orphaned]` nudge for it at boot, a DISTINCT signal from `[loom:merge-failed]` " +
      "since NO verdict was ever reached; not a failure — re-run `worker_merge_confirm` to get a real " +
      "result. `pending` means the op is known to exist but isn't visible in the " +
      "live registry yet — for an ordinary solo `worker_merge_confirm` this is a narrow just-started or " +
      "post-restart window, wait and re-check rather than treating it as stuck. ⚠️ FOR A `merge_batch` OP " +
      "THIS IS NOT NARROW: once the batch's own gate " +
      "run finishes it releases its live gate-queue entry and keeps working (fast-forward, then every " +
      "fallback candidate's own sequential solo merge) — so a HEALTHY, still-finalizing batch can " +
      "legitimately read `pending` for tens of minutes, and until this card that was byte-identical to a " +
      "genuinely stranded row. Two fields now tell them apart WITHOUT you needing to already know which " +
      "one you're looking at: `elapsedMs` (time since this op was MINTED — not since admission, since " +
      "there's no live admission clock left once an op has fallen out of the registry; a large value here " +
      "is routine for a batch with a long fallback chain, not itself a wedge signal) and " +
      "`ownerSessionAlive` (whether ANYONE is still around to be told the result — walked through a " +
      "recycle, exactly like the settle nudge itself: `false` means the ENTIRE lineage of the session that " +
      "started this op — the original manager AND every successor it may have been `worker_recycle`d/" +
      "`worker_stop`d/replaced into — is gone, not merely that the ORIGINAL manager session has exited; a " +
      "mid-batch recycle is ordinary for a run this long and must not, by itself, read as stranded. `false` " +
      "IS then a genuine stranded signal: nobody is left alive to ever see this op's result, even if it's " +
      "still nominally running unreachable in the background; `true` only rules that dead-lineage case OUT, " +
      "it does NOT by itself prove the batch is healthy or progressing — a hung-but-owner-still-around op " +
      "would read `true` too, indistinguishably). ONLY on THIS (manager) surface, and never on a foreign " +
      "project's op (see the cross-project redaction section above) — omitted, not a fabricated value, in " +
      "both cases. `elapsedMs` (unlike `ownerSessionAlive`) is populated cross-project and stays populated " +
      "regardless. Both are populated ONLY while `state===\"pending\"` — " +
      "omitted for every settled/evicted/orphaned state, where the state itself (or a recorded verdict) " +
      "already answers the question. `never_existed` is a POSITIVE assertion the id was never minted at all — never " +
      "confuse it with `settled` (a real op DID run, you just don't have its outcome from this tool). " +
      "A `deploy` opId (from the `deploy` tool, if registered) is resolved the SAME way as a merge/worker " +
      "gate opId — it writes its own durable `pending_gate_ops` tombstone, so it reaches " +
      "`settled` (with a real verdict — see below) rather than any special-cased `unknown`; a `deploy` " +
      "opId never_existed only means genuinely bogus, exactly like every other kind. " +
      "`ambiguous` (with `error` naming the matching opIds) means your prefix matches more than one op — " +
      "pass more characters or the full id; it is a DISTINCT outcome from `never_existed`, never fold the " +
      "two together. `elapsedMs` is PHASE-SCOPED to `state` while `queued`/`running` (the SAME way " +
      "`gate_queue`'s `since`/`elapsedMs` are — while `state` is `queued` it measures time WAITING since " +
      "enqueue; the moment it flips to `running` the SAME field RE-BASES to admission time and measures " +
      "time RUNNING instead — never read a `queued` entry's `elapsedMs` as run time), and `null` for every " +
      "other state. Use this when a merge has been pending for a long time and you want to confirm it's " +
      "genuinely still working (a large `elapsedMs` alone doesn't mean it's stuck — check `state` first, " +
      "then compare against how long the project's gate normally takes IN THAT PHASE) rather than " +
      "concluding it's wedged. IMPORTANT — even a large `elapsedMs` while `running` is routinely HEALTHY: " +
      "the gate auto-extends a step's timeout, rather than killing it, for as long as the step keeps " +
      "producing output (`GATE_EXTEND_IDLE_MS` in gate-runner.ts), so elapsed time alone cannot tell " +
      "\"working hard\" from \"hung\". `idleMs` (`Date.now()` minus the gate's last liveness event — " +
      "started, or produced a stdout/stderr byte, the SAME clock the gate's own auto-extend decision " +
      "reads, never a second, independently-computed number) is the signal that actually distinguishes " +
      "the two: non-null once the step has genuinely started (normally the same instant `state` flips to " +
      "`running`, though a brief real pre-flight gap right after admission can still read `null` too), " +
      "`null` while `queued` or any other state. A small `idleMs` on a `running` entry means the run is " +
      "alive and producing output no matter how large `elapsedMs` has grown — not proof it's converging " +
      "(a stuck-but-retrying run emits just as steadily); `idleMs` approaching this project's " +
      "gate-idle threshold is the real warning sign, not `elapsedMs`. `extended` (present, always " +
      "`true`/`false`, only while `queued`/`running`) tells you whether the CURRENT step has already used " +
      "its one-time auto-extend — `true` means a stall from here would be killed at the next deadline, not " +
      "given another reprieve. " +
      "On a `settled` row with a recorded verdict, ALSO carries `timingBand?` — a " +
      "stratified comparison against this project's OWN gate-timing history, computed ONLY when this " +
      "op's own `run-summary` row is found in the timing NDJSON (never fabricated otherwise, so its " +
      "absence means \"nothing to compare against\", not \"this run was slow\"): {poolSize, " +
      "testFileCount (a FILE count — one per hermetic test FILE, never per individual test/assertion; " +
      "the on-disk NDJSON key stays `testCount` for compatibility with existing history), " +
      "testFileCountSpan, isolatedPhaseFileCount, n, nUnfiltered, nExact, minSec?, medianSec?, maxSec?, " +
      "instrument, filter, readWindowBytes, readWindowTruncated}. `poolSize` AND `isolatedPhaseFileCount` " +
      "(0 for a flat pooled run, positive when an isolated sequential phase " +
      "ran ahead of the pool) are BOTH matched EXACTLY and NEVER widened: pool size dominates run duration " +
      "more than population size does (a smaller pool at a bigger testFileCount can run FASTER than a " +
      "bigger pool at a smaller one), and a flat run vs. an isolated-phase run measure a structurally " +
      "different thing (a run's scheduling shape, not just its pool size or file count, drives its " +
      "duration) — pooling across either would be a category error, not a convenience, so a band can " +
      "never silently mix scheduling shapes. " +
      "`testFileCount` starts as an EXACT match but widens outward to " +
      "the nearest neighbouring testFileCount values when the exact match alone has fewer than a named " +
      "floor (8) of clean samples — measured live: it increments on every single test file added or " +
      "removed, so an exact-only match is statistically empty (n<5) for the large majority of real strata, " +
      "emptiest right after someone changes the suite, exactly when a duration comparison matters most. " +
      "`testFileCountSpan` (`[min,max]`) is the ACTUAL testFileCount range the band below was computed " +
      "over — equal to `[testFileCount,testFileCount]` when no widening happened, a real range when it " +
      "did; always read this before trusting `n` describes an exact match. `n` counts runs across " +
      "`testFileCountSpan` (same `poolSize`, excluding every row this op's own opId ever wrote — a " +
      "retried op can leave more than one) that were BOTH complete and zero-failure — " +
      "`minSec`/`medianSec`/`maxSec` are computed over exactly that filtered population; `nUnfiltered` is " +
      "the same (possibly widened) population before that filter, so you can see how much a few " +
      "flaky/failing runs would otherwise have skewed the median slow; `nExact` is the clean count for the " +
      "EXACT testFileCount match alone, reported regardless " +
      "of whether widening happened, so a widened band never hides how thin the exact match actually was. " +
      "`instrument`/`filter` name what produced the numbers (never read a duration without its producer " +
      "— `run-summary.durationMs` is NOT the same clock as `totalDurationMs`/`Σ(steps)` above) and " +
      "`filter` also states in plain text whether/why widening happened. " +
      "`readWindowTruncated:true` means older history outside a bounded tail read was never considered — " +
      "`n`/`nUnfiltered`/`nExact` may undercount the true population, never overcount it. " +
      "On a FAILED settled row for YOUR OWN project, ALSO carries `deferredTriggerNotice?` — the SAME `[loom:deferred-trigger] ...` advisory text the `[loom:merge-rejected]`/" +
      "`[loom:gate-failed]` completion nudge composes, RECOMPUTED here at read time rather than only " +
      "relied on from that one-shot push: present whenever some task on this project has annotated " +
      "itself `deferredUntilEvent:{kind:\"gate-fail-naming\"}` naming one of THIS run's own failed test " +
      "files, absent (never a fabricated empty string) when no task matches. Re-derived fresh on every " +
      "call from the durable gate-timing NDJSON plus the board's CURRENT deferral state — so calling " +
      "this after a missed or lost completion nudge (including one the daemon never got to enqueue " +
      "because it crashed between this op settling and that push) still recovers the SAME advisory, not " +
      "a stale or absent one. Redacted (never even computed) for a foreign project's op, see above. " +
      "ALSO carries `emittedBuild?` on any settled row — a one-token stamp (`\"current\"` " +
      "or `\"stale, N commit(s) behind\"`, plus the running code's own build timestamp) telling you " +
      "whether THIS READ — not the op itself, which may have settled long before, possibly across a " +
      "restart — was served by current or stale daemon code, without a separate `served_status` call. " +
      "Derived from `runningCodeBuiltAt`, never the raw on-disk `distBuiltAt` clock (that " +
      "would understate staleness). Absent (never a fabricated \"current\") when the signal itself is " +
      "unavailable — e.g. a packaged install with no `.git`.";
  server.registerTool(
    "gate_status",
    {
      description,
      inputSchema: strictShape({ opId: z.string() }),
    },
    async ({ opId }) => {
      try {
        // LAZY (card e3e40167 fix): resolved on EACH call, not once at registration — buildServer runs
        // for every session on every connect, including test doubles that stub `db` as `{}`/a partial
        // fake with no `getSession`; reading it eagerly at registration time crashed those (companion-loop
        // .mjs's role:"worker" server build). Deferring to call time matches how every other db read in
        // this router already works, and costs nothing extra on the real path (a session row read).
        // Card a16c580b, 2nd manager-review catch (widened by card 5ef78900 to cover outputTail/steps/
        // gateDetail, not just outputFile): construct the wrapper whenever this call site EVER asks for
        // redaction (`getRedactCrossProjectCallerProjectId` provided at all, i.e. the manager surface) —
        // even when the getter itself resolves to `undefined` (a failed `db.getSession` lookup). Passing
        // `getRedactCrossProjectCallerProjectId?.()` directly as a bare value here would collapse BOTH
        // "never asked for redaction" (worker) and "asked, but couldn't resolve" (manager, lookup failed)
        // onto the identical `undefined`, silently un-redacting the failure case — see
        // `SessionService.gateStatus`'s own `redactCrossProject` doc for the full mechanism this wrapper
        // exists to prevent.
        const redactCrossProject = getRedactCrossProjectCallerProjectId
          ? { callerProjectId: getRedactCrossProjectCallerProjectId() }
          : undefined;
        const result = sessions.gateStatus(opId, scopeSessionId, getScopeProjectId?.(), redactCrossProject);
        // @decision bed91595 — this resolves through the ordinary tombstone fallback now; never resurrect
        // the removed in-process deploy-opId cache/reclassification workaround on top of it.
        // @decision 19c0ef1e — a `timingBand` read/parse failure must never propagate as a `gate_status`
        // error; let it fall through to the plain result, same as any other advisory-only enrichment.
        // @decision 5ef78900 — never fold `timingBand`'s cross-project numeric disclosure into
        // `gateStatus`'s own redaction; gate it separately via `isCrossProjectGateOp` instead.
        if (result.state === "settled" && result.outcome !== undefined && !sessions.isCrossProjectGateOp(opId, redactCrossProject)) {
          let enriched: Record<string, unknown> = result;
          try {
            const timingBand = await computeGateTimingBand(opId);
            if (timingBand) enriched = { ...enriched, timingBand };
          } catch {
            // Advisory only — an observability read must never turn a real gate_status answer into an
            // error. Fall through and return the plain result below.
          }
          // Card fde10c75: this settled result may be read long after the op itself settled — possibly
          // across a daemon restart — so stamp it with the build serving THIS read, the same
          // "recompute at read time" posture as `deferredTriggerNotice` below. Best-effort, same posture
          // as `timingBand` immediately above.
          try {
            // Card 97b60350: resolved through `sessions.resolveDeployStaleness()` (not the bare
            // imported `currentDeployStaleness()`) so a hermetic test can pin this read via
            // `setDeployStalenessOverrideForTest` instead of racing a real git call — see that
            // method's own doc on `SessionService`.
            const emittedBuild = advisoryBuildStamp(await sessions.resolveDeployStalenessAsync());
            if (emittedBuild) enriched = { ...enriched, emittedBuild };
          } catch {
            // Advisory only, same posture as timingBand above.
          }
          // Card 5f3a394e: recompute the `[loom:deferred-trigger]` advisory HERE, at READ time, rather
          // than relying solely on the one-shot push composed when the op settled
          // (sessions/service.ts's `onSettledAfterPending`/`confirmWorkerMergeTracked` — see
          // `deferredTriggerNotice`'s own doc). That push is genuinely lost if the daemon crashes in the
          // async gap between the op's `state` flipping to settled and the nudge being enqueued (the
          // window `deferredTriggerNotice`'s doc + card `c4b70fe8` describe) — there is no replay for it.
          // `readFailedNamesForOp` reads the SAME durable gate-timing NDJSON the push itself reads,
          // keyed only by this `opId` — genuinely recoverable after a restart, independent of whether the
          // push ever fired, and re-evaluated against the board's CURRENT `deferredUntilEvent` state (a
          // task added/edited its annotation after the gate settled is picked up too, not just what
          // existed at push time). Fail-only (mirrors `gateFailedForTrigger` in service.ts) — a passing
          // run has nothing to attribute, and `result.passed` is never `true` for a `"cancelled"`/`"error"`
          // verdict (see `SessionService.gateStatus`'s own verdict-kind branches), so this can't
          // misfire there either. Best-effort, same posture as `timingBand` immediately above.
          if (result.passed === false) {
            try {
              const projectId = getScopeProjectId?.() ?? redactCrossProject?.callerProjectId;
              if (projectId) {
                const notice = deferredTriggerNotice(db, projectId, await readFailedNamesForOp(opId));
                if (notice) enriched = { ...enriched, deferredTriggerNotice: notice };
              }
            } catch {
              // Advisory only, same posture as timingBand above.
            }
          }
          return ok(enriched);
        }
        // Card 45390f74: `run_gate`'s not-settled reply carries an explicit "Do NOT poll" `note` — this
        // one, the tool the docs tell a caller to use INSTEAD of re-calling run_gate, carried none, so a
        // caller that correctly avoided re-calling run_gate landed on the one path with no anti-poll
        // guardrail at all. Mirror run_gate's own wording (never reworded) rather than inventing new
        // text, phrased for whichever audience actually holds this scoped instance: a worker checking its
        // own run_gate self-check reports via `worker_report`, a manager checking a merge/deploy op has no
        // such tool and uses `idle_report` instead.
        if (result.state === "queued" || result.state === "running") {
          const note = forWorker
            ? `gate still ${result.state}. Do NOT poll or re-call gate_status to check again — worker_report progress with awaiting:"background" and END your turn; the [loom:gate-done]/[loom:gate-failed] nudge starts your next turn with the result.`
            : `gate still ${result.state}. Do NOT poll or re-call gate_status to check again — idle_report({state:"waiting"}) and END your turn; the [loom:merge-done]/[loom:merge-rejected]/[loom:merge-failed] (or [loom:gate-done]/[loom:gate-failed]) nudge starts your next turn with the result.`;
          return ok({ ...result, note });
        }
        return ok(result);
      } catch (e) {
        return ok({ error: (e as Error).message });
      }
    },
  );
}

// @decision fa359824 — never merge `recentTimeoutStreak` into the semaphore's own phase/queuePosition
// belief (a second, independent signal, surfaced side by side); never read a queued row's `since` as
// `gate_status`'s `admittedAt` — they are different clocks.
//
// Field-provenance pointers for the description below, relocated out of the agent-facing text (an
// end-user agent can't resolve a card/decision id). Entries with a matching docs/decisions record use
// @decision; a bare `card <id>` line has no such record and is a plain provenance citation.
//
// @decision 3ab5c540 — this tool measures semaphore admissions only, never host load; a peer's own live
// trace caught it reading `activeCount:0` while the box was genuinely busy.
//
// @decision 8d585277 — the older, separate per-worktree admission guard `repoContended` does NOT report
// on.
//
// @decision 92e960d1 — the per-repo merge-admission guard a queued `merge`/`worker` entry's
// `repoContended` reflects.
//
// @decision 567b8724 — cross-project gate fairness: a project can hold its fair share of `cap` while a
// different project's admissible waiter still jumps ahead.
//
// card cffa71e6 — a queued entry's `since` is only approximately queue-entry time, and re-bases again
// once the entry is admitted; three non-interchangeable timestamps across one op's life.
//
// @decision 80d54122 — the four-field cross-project omission (`taskId`/`branch`/`workerLabel`/
// `fallbackOfBatchOpId`), and the bare `recentTimeoutStreak` integer's own redaction scope.
//
// card 1cf0ced1 — the exact four-field cross-project omission list, corrected from an earlier
// undercounted "project + gate kind + age" description.
//
// @decision e4701333 — `repoContended` widened to cover a queued `worker`-kind entry too, not just
// `merge`.
//
// @decision eb491463 — a waiting merge blocks every not-yet-admitted same-repo worker, so worker
// self-checks cannot starve it.
//
// @decision 68155573 — a single-file/transient-kill retry continues its original admission as a link of
// the SAME chain; it is never re-queued.
//
// @decision 99a1cf6f — `attempt`/`priorAttemptMs`/`attemptStartedAt` distinguish a retry re-admission
// from a first wait.
//
// @decision 7ad12202 — `attempt:3` resumes whatever step(s) a prior short-circuited gate never ran, after
// its single-file retry already passed.
//
// @decision b9e07a4a — `repoGuardOnly`: an inert-diff-skip merge holding or waiting on a same-repo
// sibling's per-repo guard without ever admitting through the ordinary cap/registry.
//
// @decision db9b0130 — the inert-diff proof an inert-diff-skip merge's `repoGuardOnly` entry rests on.
//
// card 61aa6f1d — the `redacted: true` marker on a foreign `repoGuardOnly`/`squashing` entry, matching
// `running`/`queued`'s own redaction shape.
//
// card 93b568e6 — `squashing`: a merge op whose gate command already finished but whose squash is still
// in flight, previously enumerated nowhere in this tool's result.
//
// @decision a5d1ae04 — `declarations`: a manager's own advisory "I intend to fire a gate" declaration;
// never registered on the worker surface.
//
// @decision e50600d2 — the `run_gate` worker self-check `waitingOnSelfCheck` names.
//
// @decision 59986602 — `waitingOnSelfCheck`: a merge op still parked inside its own pre-admission wait
// for a worker's `run_gate` self-check.
function registerGateQueue(server: McpServer, sessions: SessionService, db: Db, sessionId: string): void {
  server.registerTool(
    "gate_queue",
    {
      description:
        "Read-only snapshot of the WHOLE daemon-global gate queue: the resolved concurrency `cap` plus every gate run " +
        "`running` or `queued` (merge/deploy/worker-self-check alike) — answers 'why is my gate queued, who holds the " +
        "slot, how deep am I' in one read. Cheap (in-memory, bounded by cap + queue depth); safe to call before " +
        "`run_gate`/`worker_merge_confirm` and again after either returns `pending`. " +
        "⚠️ IT MEASURES SEMAPHORE ADMISSIONS, NEVER HOST LOAD: `activeCount:0`/`queuedCount:0` means nothing is " +
        "admitted through the GateSemaphore, NOT that the box is idle. It is blind to any hand-run test/build " +
        "(the worker DoD default, so up to one lane per live worker) and to all non-agent load. For 'is the box " +
        "quiet', use a whole-box CPU reading plus a worktree-scoped process attribution check, whichever your " +
        "install provides (the latter is partial by construction). " +
        "Returns {cap, activeCount, queuedCount, running, queued, repoGuardOnly, squashing, declarations, " +
        "waitingOnSelfCheck, restartSafe}. " +
        "`restartSafe` (bool, DAEMON-GLOBAL, not own-project) is `true` iff nothing in `running`/`queued`/" +
        "`repoGuardOnly`/`squashing`/`waitingOnSelfCheck` is anything OTHER than an automatic dist-importer " +
        "advisory check (`distImporterCheckOnly`), AND no merge or gate operation is live in the daemon (this " +
        "includes a merge confirm still in its pre-queue preparation). A daemon restart itself cancels advisory " +
        "checks and re-fires ONE after boot, so a `true` here (including with advisory entries still listed) " +
        "means no merge/gate work the daemon is tracking would be interrupted. It does NOT cover untracked work. " +
        "It reads the semaphore's belief only — blind to hand-run tests, like every field here. " +
        "`queued` is ordered by ARRIVAL within priority tier (high-priority merge/deploy before low-priority worker " +
        "self-checks, FIFO within each), so index + 1 IS `queuePosition` — a BELIEF about arrival order, NOT a " +
        "promise of grant order: the semaphore skips a head-of-line waiter that isn't admissible and grants the " +
        "next one that is. Skip reasons: its worktree is still held by a running entry; its repoPath is guarded " +
        "(see `repoContended`); or its project already holds its fair share of `cap` while a DIFFERENT project has " +
        "an admissible waiter (which can let a foreign low-tier waiter beat this project's own high-tier one; tier " +
        "priority holds WITHIN a project). " +
        "Each running/queued entry carries {opId, gateType, projectId, projectName, since, elapsedMs, idleMs, " +
        "extended, attempt, priorAttemptMs, attemptStartedAt, queuePosition, repoContended}. " +
        "`since`/`elapsedMs` are PHASE-SCOPED: while `queued` they measure time WAITING (approximately; `since` is " +
        "only roughly queue-entry time); once admitted the SAME entry RE-BASES to the real command-start instant and " +
        "they measure time RUNNING. One op therefore shows three non-interchangeable timestamps: " +
        "`gate_status.admittedAt` (MINT time, a few seconds before enqueue) → queued-row `since` → running-row " +
        "`since`. Never substitute one for another, and never read a queued `elapsedMs` as run time: a deeply " +
        "queued op can show a large `elapsedMs` with zero work done. " +
        "A large running `elapsedMs` is NOT evidence of a wedge either — the gate auto-extends a step's timeout " +
        "while it keeps producing output. `idleMs` (now minus the last liveness event: start or a stdout/stderr " +
        "byte; the same clock the auto-extend reads) is the real signal: `null` while `queued`/not live, a small " +
        "value means recent output, and one approaching this project's gate-idle threshold is the warning sign. " +
        "`extended` (bool) says whether the CURRENT step already used its one-time auto-extend; `true` means the " +
        "NEXT deadline is a real kill. `idleMs`/`extended` are on every entry, cross-project too. " +
        "`opId` is the id `gate_status(opId)` accepts (full or unambiguous 8-char prefix). " +
        "Your OWN project's entries also carry {taskId, branch, workerLabel, fallbackOfBatchOpId}; a " +
        "DIFFERENT project's entry omits exactly those four (never redacted-to-null) and carries `redacted: true` " +
        "instead. Everything else above rides cross-project un-redacted, including `recentTimeoutStreak` — enough " +
        "to tell 'someone else holds the slot' from 'this looks leaked' without exposing task/branch identity. " +
        "`repoContended` (bool, live-recomputed each call) is `true` ONLY for a QUEUED `merge`- or `worker`-kind " +
        "entry blocked by the per-repo admission guard. ASYMMETRIC: a queued `merge` is contended by ANY other " +
        "same-repo holder (merge or worker); a queued `worker` only by an active same-repo `merge` or a same-repo " +
        "`merge` QUEUED ahead of it (so worker self-checks cannot starve a waiting merge). Two same-repo workers " +
        "with no merge waiting never contend. `true` with a free `cap` lane is expected: it is waiting on the " +
        "REPO. `false` means this guard is not why it's queued (it may still be `cap` or the per-worktree guard, " +
        "which this field does not report). Always `false` while `running` or for `deploy`. " +
        "`attempt`/`priorAttemptMs` (`merge`-kind only, `null` on first admission) and `attemptStartedAt` (set on " +
        "every running entry, `null` while queued) describe a RETRY of the same op: the single-file retry and " +
        "transient-kill retry CONTINUE the SAME admission (slot and repo guard held through the gap, never " +
        "re-queued), so a retry reads `running` with `attempt:2`. `since` keeps the ORIGINAL admission time; " +
        "`attemptStartedAt` is when the CURRENT attempt began; `priorAttemptMs` is how long earlier attempts " +
        "ran. `attempt:3` (solo and batch) resumes the step(s) the original gate short-circuited past, after the " +
        "single-file retry passed. A `running`→`queued` swap for one op is not an expected retry shape: check " +
        "`gate_status` before concluding a retry was lost. " +
        "IMPORTANT: `queuePosition` and phase reflect only what the semaphore BELIEVES; a gate timeout can free " +
        "the slot without its process tree dying. So every entry with a `branch` carries `recentTimeoutStreak` " +
        "(integer ≥0, consecutive timeouts for that branch, from an independent tracker). A nonzero streak is a " +
        "reason to verify no orphaned process survives before treating that worktree as idle — a second data " +
        "point, not a verdict. " +
        "`repoGuardOnly` is a SEPARATE array: an inert-diff-skip merge holding or waiting on a same-repo " +
        "sibling's per-repo guard without admitting through the cap. Entry: {id, phase:\"holding\"|\"queued\", " +
        "since, elapsedMs, queuePosition, opId, projectId, projectName, repoPath?, taskId?, branch?, " +
        "workerLabel?, redacted?}. `repoPath` (absolute host path)/`taskId`/`branch`/`workerLabel` are " +
        "own-project only (simply absent for a foreign entry, which carries `redacted: true`). It explains a " +
        "queued `merge` showing `repoContended:true` with zero running merges on that repo. " +
        "`squashing` is a THIRD array: a `merge`-kind op whose gate command has finished (registry entry gone) " +
        "but which still holds its per-repo guard while the git squash runs. Without it every other array could " +
        "read empty during a live merge. Entry: {opId, projectId, projectName, since, elapsedMs, repoPath?, " +
        "taskId?, branch?, workerLabel?, redacted?}, same redaction as `repoGuardOnly`; `since`/`elapsedMs` run " +
        "from the instant the gate command settled (NOT admission). It likewise explains `repoContended:true` " +
        "with no matching `running` entry. " +
        "`declarations` is a FOURTH array: managers' advisory 'I intend to fire a gate at ~T' notes from " +
        "`gate_intent_declare`/`gate_intent_withdraw`. ⛔ ADVISORY ONLY: never admitted through the " +
        "GateSemaphore, can never block, delay or gate any fire, and nothing in `run_gate`/" +
        "`worker_merge_confirm`/deploy reads it. Entry: {projectId, projectName, declaredAt, firesAt, ageMs, " +
        "msUntilFire, gateType?, repoKey?, note?, declaredBy?} (server-stamped ISO times). `msUntilFire` is " +
        "never clamped: negative means the declared time passed and the intent likely fired. Rows self-expire " +
        "(rule in `gate_intent_declare`'s doc) and a dead seat's row is gone by the next read; no session id is " +
        "on the wire. Own-project entries also carry {repoKey?, note?, declaredBy?} (declaredBy = the " +
        "declaring manager's agent name); a foreign entry omits those three and carries `redacted: true`, " +
        "`gateType` visible either way. " +
        "⛔ Once a row leaves `queued`, NOTHING here recovers how long it waited. For a settled op's real span " +
        "read `gate_status(opId)`: `admittedAt`/`settledAt`/`totalDurationMs` cover the WHOLE op (worktree prep + " +
        "queue wait + command + squash; see that tool for what it includes). `gate_history` carries only " +
        "`durationMs`, the gate COMMAND span, so it cannot answer queue wait; it is for cross-op duration TRENDS. " +
        "Duration tiers: `run-summary` (test execution only) → `gate_history.durationMs` (build + guards + tests) " +
        "→ `gate_status.totalDurationMs` (command PLUS queue wait PLUS overhead). A SERIES (e.g. 'is the gate " +
        "getting slower') wants the COMMAND tier; `totalDurationMs` spikes with fleet busyness. Agreement between " +
        "two tiers on one op is not evidence you picked the right one (a never-queued op's tiers nearly coincide). " +
        "`waitingOnSelfCheck` is a FIFTH array: a `merge`-kind op still parked in its pre-admission wait for its " +
        "worker's `run_gate` self-check, so in none of the arrays above. Entry: {opId, blockingOpId, since, " +
        "elapsedMs, projectId, projectName, taskId?, branch?, workerLabel?, redacted?}, same redaction as " +
        "`repoGuardOnly`. `opId` is the MERGE's id: pass it to `gate_cancel` to abort the wait (the merge settles " +
        "`cancelled`). `blockingOpId` is the self-check's id, informational: cancelling the merge leaves the " +
        "self-check running, so cancel `blockingOpId` separately if its verdict should stop too. " +
        "Cancel a QUEUED one via `gate_cancel(opId)` - see that tool's own doc for the fallback " +
        "resolution it uses.",
      inputSchema: strictShape({}),
    },
    async () => {
      const projectId = db.getSession(sessionId)?.projectId;
      if (!projectId) return ok({ error: "no project for this session" });
      return ok(sessions.gateQueueForManager(projectId));
    },
  );
}

// @decision a5d1ae04 — never register gate_intent_declare/withdraw on the worker surface; a worker has
// no "intend to fire" phase (its only gate action is `run_gate`) and there is no use case for either.
//
// ⛔ STRUCTURALLY DECOUPLED FROM EVERY GATE-FIRING PATH, ON PURPOSE (DoD-4): neither handler below may ever
// call runWorkerGate/confirmWorkerMerge/deployOwnProject/GateSemaphore/gate-runner.ts — only declareGateIntent/
// withdrawGateIntent. test/gate-intent-no-firing-coupling.mjs asserts this mechanically.
function registerGateIntent(server: McpServer, sessions: SessionService, sessionId: string): void {
  server.registerTool(
    "gate_intent_declare",
    {
      description:
        "Declare (replacing any prior declaration of your own) that YOU intend to fire a gate at " +
        "roughly `Date.now() + inMs` — a structured, server-stamped fact a peer sees on the `gate_queue` " +
        "read they already make (in its `declarations` array), replacing the hand-written 'I'm about to " +
        "fire' letter this card's own PROVENANCE measured as routinely arriving AFTER the coordination " +
        "window it existed to protect. ⛔ ADVISORY DISCLOSURE ONLY, STRUCTURALLY — this call never touches " +
        "the GateSemaphore, and nothing in `run_gate`/`worker_merge_confirm`/deploy ever reads what you " +
        "declare here: it cannot block, delay, reorder, or otherwise affect any real gate admission, " +
        "including your own. Firing a gate WITHOUT ever declaring one, or firing one that contradicts an " +
        "active declaration, is completely unaffected either way — this tool exists purely so a peer has " +
        "advance notice, never as a commitment this daemon enforces. " +
        "`inMs` (required, integer, `0` to " + String(INTENT_MAX_LEAD_MS) + " — " + String(INTENT_MAX_LEAD_MS / 60_000) + " minutes) is a " +
        "RELATIVE offset, not an absolute timestamp — the daemon stamps `declaredAt`/`firesAt` itself " +
        "(`firesAt = declaredAt + inMs`), so there is never a clock-skew question between your session and " +
        "the daemon. An `inMs` outside that range is REJECTED with `{error}` (not clamped) — declare again " +
        "closer to the actual time instead. " +
        "`gateType` (optional, one of `merge`/`deploy`/`worker`) is the SAME kind enum `gate_queue`'s own " +
        "`running`/`queued` entries carry, and stays visible to a peer in a foreign project too (gate KIND " +
        "is already part of the sanctioned cross-project disclosure set — this doesn't widen it). `repoKey` " +
        "(optional — `null` for the project's primary repo, a key from your own project's repo registry " +
        "otherwise) and `note` (optional short freeform text) are BOTH own-project-only when read back via " +
        "`gate_queue` — a foreign caller never sees either, same redaction tier as `taskId`/`branch` on a " +
        "`GateQueueEntry`. " +
        "ONE LIVE DECLARATION PER SESSION — calling this again fully REPLACES your prior declaration " +
        "(including its `declaredAt`, which is re-stamped to now); it does not merge or extend it. A " +
        "declaration self-expires — you do not have to withdraw it for hygiene's sake, though " +
        "`gate_intent_withdraw` right after you actually fire is the courtesy that keeps a peer from seeing " +
        "a stale, already-fired intent linger (see `gate_queue`'s own `msUntilFire` doc for what a peer " +
        "reads instead if you don't). Returns `{entry}` (the same shape your OWN `gate_queue` read would " +
        "show for this row) on success, `{error}` on a bad `inMs` or an unresolvable caller session.",
      inputSchema: strictShape({
        inMs: z.number(),
        gateType: z.enum(["merge", "deploy", "worker"]).optional(),
        repoKey: z.string().nullable().optional(),
        note: z.string().optional(),
      }),
    },
    async ({ inMs, gateType, repoKey, note }) => {
      const result = sessions.declareGateIntent(sessionId, { etaMs: inMs, gateType: gateType as GateType | undefined, repoKey, note });
      if (!result.ok) return ok({ error: result.error });
      return ok({ entry: result.entry });
    },
  );
  server.registerTool(
    "gate_intent_withdraw",
    {
      description:
        "Withdraw YOUR OWN active gate-intent declaration (see `gate_intent_declare`), if any — the " +
        "courtesy call after you actually fire, so a peer's `gate_queue` read doesn't keep showing an " +
        "already-fired intent (which self-expires on its own regardless — see that tool's own doc — this " +
        "just does it immediately instead of waiting out the grace window). Idempotent: `{withdrawn: " +
        "false}` when you had nothing active is NOT an error, never throws. Takes no arguments — there is " +
        "at most one live declaration per session to withdraw, so none are needed to disambiguate.",
      inputSchema: strictShape({}),
    },
    async () => ok({ withdrawn: sessions.withdrawGateIntent(sessionId) }),
  );
}

// ColumnRole (shared) mirror for the board_column_* tools below — kept in lockstep with the ColumnRole
// union in shared/src/config.ts, same as mcp/platform.ts's own `columnRole` mirror.
const columnRole = z.enum([
  "intake", "defaultLanding", "workReady", "active", "review", "parked", "terminal", "mergeLanding",
]);

/** A stored column, carried through unchanged into a `sessions.updateBoardColumns` desired layout (no
 *  `prevKey` — that's set only by board_column_rename for the one column being renamed). */
const toDesiredColumn = (c: KanbanColumn): DesiredColumn => {
  const d: DesiredColumn = { key: c.key, label: c.label };
  if (c.role) d.role = c.role;
  if (c.accentColor !== undefined) d.accentColor = c.accentColor;
  if (c.wipLimit !== undefined) d.wipLimit = c.wipLimit;
  if (c.excludeFromIdleWatchdog !== undefined) d.excludeFromIdleWatchdog = c.excludeFromIdleWatchdog;
  return d;
};

/**
 * Orchestration MCP server (phase-2 §A2/§A3) — a ROLE-BASED surface, keyed by the URL-path
 * session id and resolved SERVER-SIDE (the agent never names "which session"):
 *   - manager → the full coordination surface (list/status/transcript/spawn/stop/message);
 *   - worker  → worker_report, my_context, its own run_gate/gate_cancel/gate_status/gate_queue self-check
 *               surface, and the read-only directive_status — but NEVER spawn/list/stop (so a worker
 *               cannot spawn/list/stop a sibling — the depth-1 tree holds at the tool surface, not just
 *               the role gate);
 *   - plain/unknown → 404 (no surface).
 * Stateless: a fresh McpServer+transport per request (the URL-path session id supplies the role
 * binding). No cached transport, so a dropped stream can't wedge the surface mid-session.
 */
/**
 * Loom Companion hooks, threaded from index.ts (generalized to MULTI-companion by the multi-companion
 * runtime card). The `chat_reply` tool is registered ONLY on an ENABLED companion session's MCP server —
 * checked via Set membership (`companionSessionIds.has(sessionId)`), so N concurrently-armed companions
 * each get it on their OWN session — every OTHER manager/worker spawn's surface stays byte-identical and
 * never sees a stray tool (the "fully additive" discipline). Absent/empty ⇒ no session gets chat_reply.
 */
export interface CompanionHooks {
  /** Every currently-ENABLED companion session id — chat_reply is registered iff this Set has the session
   *  being served. Undefined/empty ⇒ off for everyone. The sessionId tested is always the MCP server's OWN
   *  closed-over session (never agent-suppliable), so this is a per-session gate, not a routing decision —
   *  it can never let one companion's tool call act on another's behalf. */
  companionSessionIds?: ReadonlySet<string>;
  /** Deliver the agent's chat_reply(text, voice?) back OUT to the chat bound to the session
   *  (companion/chat-gateway.ts). `voice` is the agent's PER-REPLY voice request (VOICE-P4, card
   *  edd11203) — consulted ONLY when the route's pref mode is "auto"; ignored for "on"/"off". The
   *  controller dispatches this by `sessionId` to THAT session's own gateway — never cross-wired. */
  deliverReply?: (sessionId: string, text: string, voice?: boolean) => Promise<{ delivered: boolean; reason?: string }>;
  /** Deliver a local file to the chat bound to the session, as a native image/document (the `media-out`
   *  lever, card 3a81b0f2). Wired into `GrantOutbound.deliverMediaToOwner` exactly like `deliverReply` is
   *  wired into `GrantOutbound.deliverToOwner`. */
  deliverMedia?: (sessionId: string, filePath: string) => Promise<{ delivered: boolean; reason?: string }>;
  /**
   * SERVER-DERIVED route capture for reminder_create — the current turn's originating companion route (or
   * null), read at schedule time exactly like wake_me (orchestration/wake.ts). The agent never passes a
   * route/channel.
   */
  getActiveTurnOrigin?: (sessionId: string) => CompanionRoute | null;
  /**
   * (Re)arm/disarm the live reminder watcher for the bound companion session — ARM-ON-CREATE. Called after
   * reminder_create/reminder_cancel writes (with the caller's OWN bound sessionId) so a freshly-created
   * reminder starts firing immediately instead of waiting for an unrelated config write to reconcile
   * (companion/controller.ts CompanionReplyHooks) — scoped to that session, never touching a sibling
   * companion's reminder watcher.
   */
  rearmReminders?: (sessionId: string) => Promise<void>;
}

// `deriveAwaitingReview` (what decides whether a worker's last done/blocked report is still genuinely
// awaiting its manager) now lives in orchestration/report-resolution.ts — read there for the full doc. It's
// the SOLE source of truth, shared with the boot-time crash/restart-recovery notice's own `awaitingReview`
// derivation (orchestration/crash-orphaned-workers.ts, card 959a5fb7/db05e657) so the two surfaces can never
// independently decide "resolved" in different ways. Called by `reportedProjection` below.

/** @decision 3c39be30 — never hand-assemble a `DirectiveEventStream` from a freehand `Db` query; always go
 *  through workerDirectiveStream/workerLineageDirectiveStream/managerLineageDirectiveStream — anything
 *  else and `resolveDirectiveOutcome` throws, by design. */
const DIRECTIVE_STREAM_TAG: unique symbol = Symbol("directiveEventStream");
type DirectiveEventStream = OrchestrationEvent[] & { readonly [DIRECTIVE_STREAM_TAG]: true };
function tagDirectiveEventStream(events: OrchestrationEvent[]): DirectiveEventStream {
  Object.defineProperty(events, DIRECTIVE_STREAM_TAG, { value: true, enumerable: false });
  return events as DirectiveEventStream;
}
/** Worker-keyed, single session — mirrors `db.listEventsForWorker`'s own scope exactly. */
function workerDirectiveStream(db: Db, workerSessionId: string): DirectiveEventStream {
  return tagDirectiveEventStream(db.listEventsForWorker(workerSessionId));
}
/** Worker-keyed, widened across `workerSessionId`'s OWN recycle lineage (self + predecessors). */
function workerLineageDirectiveStream(db: Db, workerSessionId: string): DirectiveEventStream {
  return tagDirectiveEventStream(ownLineageIds(db, workerSessionId).flatMap((id) => db.listEventsForWorker(id)));
}
/** Manager(sender)-keyed, widened across `managerSessionId`'s OWN recycle lineage (self + predecessors). */
function managerLineageDirectiveStream(db: Db, managerSessionId: string): DirectiveEventStream {
  return tagDirectiveEventStream(ownLineageIds(db, managerSessionId).flatMap((id) => db.listEvents(id)));
}

/** @decision 35c96aa6 — never reimplement the give-up/re-mint chain walk at a second call site; reuse this
 *  function itself — a parallel reimplementation is exactly the drift risk this hoist closes. */
export function resolveDirectiveOutcome(
  events: DirectiveEventStream, rootDirective: OrchestrationEvent, rootMsgId: string,
):
  | { state: "parked"; msgId: string; parkedAt: string }
  | { state: "confirmed-after-park"; msgId: string; parkedAt: string; confirmedAt: string }
  | { state: "delivered"; msgId: string; deliveredAt: string; turnSeqAtDelivery: number }
  | { state: "pending"; msgId: string } {
  if (!(DIRECTIVE_STREAM_TAG in events)) {
    // Card 3c39be30: refuse outright rather than walk an array that cannot be trusted to contain the
    // evidence this chain depends on — the pre-fix failure mode was a CONFIDENT wrong "pending", never an
    // error, and that silence is the whole defect. Build `events` via workerDirectiveStream /
    // workerLineageDirectiveStream / managerLineageDirectiveStream instead of assembling it by hand.
    throw new Error(
      "resolveDirectiveOutcome: events must be built via workerDirectiveStream/workerLineageDirectiveStream/" +
      "managerLineageDirectiveStream (card 3c39be30) — a hand-assembled array cannot be trusted to contain " +
      "the session_message_delivered/session_message_gave_up rows this chain walk depends on.",
    );
  }
  let msgId = rootMsgId;
  const seen = new Set<string>();
  while (!seen.has(msgId)) {
    seen.add(msgId);
    const gaveUp = events.find((e) => e.kind === "session_message_gave_up" && e.detail?.msgId === msgId);
    if (!gaveUp) break;
    if (gaveUp.detail?.outcome === "parked") {
      // Card 3c712d4e: a "parked" outcome is NOT always terminal — `handleGiveUpConfirmed`
      // (sessions/service.ts) can append a LATER `session_message_gave_up` event for this SAME msgId,
      // `outcome: "confirmed-after-park"`, once a late-arriving confirming hook proves the engine
      // actually ran the turn Loom's own retry budget had already given up on (the 232s-lag scenario —
      // see memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`). Returning "parked"
      // unconditionally here — the pre-fix behavior — is exactly the defect this card fixes: a sender
      // re-reading worker_list/worker_status after that confirmation lands would still see a STICKY
      // parkedDirective and this tool's own "RE-SEND" advice, manufacturing a real duplicate of a
      // message that already landed. `events` is chronological (see this function's own callers), so a
      // `confirmed-after-park` row for this msgId can only appear AFTER the `parked` row `find` just
      // matched — checking for it here, not before, is deliberate.
      const confirmedAfter = events.find((e) =>
        e.kind === "session_message_gave_up" && e.detail?.msgId === msgId && e.detail?.outcome === "confirmed-after-park");
      if (confirmedAfter) {
        return { state: "confirmed-after-park", msgId, parkedAt: gaveUp.ts, confirmedAt: confirmedAfter.ts };
      }
      return { state: "parked", msgId, parkedAt: gaveUp.ts };
    }
    const remintedAs = gaveUp.detail?.remintedAs as string | undefined;
    // CR follow-up [8] (card 9da2a435): a malformed give-up (gave up, but neither "parked" nor a
    // usable `remintedAs`) must fail toward "pending", NEVER fall through to the delivered-check
    // below — this msgId DID give up; reporting it as cleanly delivered would resurrect the exact
    // lie this card exists to remove, just triggered by corrupted data instead of an optimistic stamp.
    if (!remintedAs) return { state: "pending", msgId };
    msgId = remintedAs;
  }
  // `msgId` is now the chain's current (not-yet-given-up) candidate. Only the ROOT msgId's own
  // message_worker event ever carries an immediate-delivery turnSeqAtDelivery; every OTHER msgId in
  // the chain (a remint) always takes the HELD path (handleGiveUpExhausted forces giveUpHeldUntil —
  // see its own doc), so its delivery record — if any — is a session_message_delivered event instead.
  if (msgId === rootMsgId && typeof rootDirective.detail?.turnSeqAtDelivery === "number") {
    return {
      state: "delivered", msgId, deliveredAt: rootDirective.ts,
      turnSeqAtDelivery: rootDirective.detail.turnSeqAtDelivery,
    };
  }
  const delivery = events.find((e) =>
    e.kind === "session_message_delivered" && e.detail?.msgId === msgId
    && typeof e.detail?.turnSeqAtDelivery === "number");
  if (!delivery) return { state: "pending", msgId }; // still queued/held, or mid-retry — nothing to judge yet
  return { state: "delivered", msgId, deliveredAt: delivery.ts, turnSeqAtDelivery: delivery.detail!.turnSeqAtDelivery as number };
}

/** @decision 3c39be30 — never let a caller of directiveByMsgId/peerMessageStatusByMsgId call
 *  `resolveDirectiveOutcome` directly; always go through this function's `findOrigin`, which guarantees a
 *  correctly-scoped stream — never re-duplicate the three-step walk in a future twin. */
function resolveMsgIdOutcome(
  events: DirectiveEventStream, ref: string,
  findOrigin: (events: DirectiveEventStream, ref: string) => { event: OrchestrationEvent; msgId: string } | undefined,
): { msgId: string; found: boolean; state: "pending" | "delivered" | "parked" | "confirmed-after-park" | null; at: string | null; sentAt: string | null } {
  const origin = findOrigin(events, ref);
  if (!origin) return { msgId: ref, found: false, state: null, at: null, sentAt: null };
  const outcome = resolveDirectiveOutcome(events, origin.event, origin.msgId);
  const at =
    outcome.state === "parked" ? outcome.parkedAt
    : outcome.state === "confirmed-after-park" ? outcome.confirmedAt
    : outcome.state === "delivered" ? outcome.deliveredAt
    : null;
  return { msgId: origin.msgId, found: true, state: outcome.state, at, sentAt: origin.event.ts };
}

/** @decision 867e64f1 — never conflate `found:false` (no event carries this root msgId at all) with
 *  `state:null` on a found root — the latter never actually occurs; every found root resolves via
 *  `resolveDirectiveOutcome` or defensively reads `pending`. */
function directiveByMsgId(
  db: Db, workerSessionId: string, msgId: string,
): { msgId: string; found: boolean; state: "pending" | "delivered" | "parked" | "confirmed-after-park" | null; at: string | null; sentAt: string | null } {
  return resolveMsgIdOutcome(workerDirectiveStream(db, workerSessionId), msgId, (events, ref) => {
    const directiveEvent = events.find((e) => {
      if (e.kind === "message_worker") return e.detail?.msgId === ref;
      if (e.kind === "redirect_worker") return e.detail?.queuedMsgId === ref;
      return false;
    });
    return directiveEvent ? { event: directiveEvent, msgId: ref } : undefined;
  });
}

/** Ownership is enforced BY CONSTRUCTION — every event this function consults comes from
 *  `managerLineageDirectiveStream` (the caller's OWN recycle lineage); NEVER a read into any other
 *  session's stream, peer or otherwise.
 *
 *  @decision 0f693dea — never merge in the recipient's own event
 *  stream to answer this sender-side question; a weaker cross-project ownership property, rejected. */
function peerMessageStatusByMsgId(
  db: Db, managerSessionId: string, ref: string,
): { msgId: string; found: boolean; state: "pending" | "delivered" | "parked" | "confirmed-after-park" | null; at: string | null; sentAt: string | null } {
  return resolveMsgIdOutcome(managerLineageDirectiveStream(db, managerSessionId), ref, (events, r) => {
    const originCandidates = events
      .filter((e): e is OrchestrationEvent & { detail: { msgId: string } } =>
        e.kind === "cross_project_message" && typeof e.detail?.msgId === "string")
      .map((e) => ({ id: e.detail.msgId, event: e }));
    const resolved = resolveIdPrefix(originCandidates, r);
    return resolved.kind === "found" ? { event: resolved.record.event, msgId: resolved.record.id } : undefined;
  });
}

/**
 * Card 35c96aa6 — walk `sessionId`'s OWN `recycledFrom` ancestor chain, self included, bounded/cycle-
 * guarded. Same shape as `lineageRootId` (sessions/lineage.ts), but returns the FULL chain
 * instead of just the root: `directiveDeliveriesForCaller` needs every ancestor's own event history, not
 * just an identity comparison. This IS the capability-widening argument for `directive_status` made
 * concrete — a caller can only ever reach rows keyed to itself or its own direct predecessors, never a
 * sibling worker, another project, or an arbitrary session id supplied as a parameter (there is no such
 * parameter).
 */
function ownLineageIds(db: Db, sessionId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    ids.push(current);
    current = db.getSession(current)?.recycledFrom ?? undefined;
  }
  return ids;
}

/** @decision 35c96aa6 — never match a worker-supplied `rootLabel` against the internal `rootMsgId`
 *  directly; always compute the comparison label via `possibleDuplicateRootLabel`. Never collapse
 *  `fromSession`/`receivedBy` into one field — their difference IS the recycle-boundary signal. */
const UNFILTERED_DELIVERY_CAP = 20;
function directiveDeliveriesForCaller(
  db: Db, callerSessionId: string, rootLabel?: string,
): {
  deliveries: Array<{ root: string; at: string; turnSeq: number | null; msgId: string; fromSession: string; receivedBy: string }>;
  currentTurnSeq: number;
  truncated: boolean;
} {
  // Card 3c39be30: built via the same worker-lineage stream constructor `resolveDirectiveOutcome` (called
  // below) now requires — see that function's own doc for the precondition this satisfies.
  const events = workerLineageDirectiveStream(db, callerSessionId);
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // msgId -> the TRUE internal rootMsgId this msgId's own chain was minted under (see this function's own
  // doc for why message_worker/redirect_worker's own msgId field is NOT reliable for this).
  const rootMap = new Map<string, string>();
  for (const e of events) {
    if (
      (e.kind === "session_message_queued" || e.kind === "session_message_gave_up")
      && typeof e.detail?.msgId === "string" && typeof e.detail?.rootMsgId === "string"
    ) {
      rootMap.set(e.detail.msgId, e.detail.rootMsgId);
    }
  }
  const deliveries: Array<{ root: string; at: string; turnSeq: number | null; msgId: string; fromSession: string; receivedBy: string }> = [];
  for (const d of events) {
    if (d.kind !== "message_worker" && d.kind !== "redirect_worker") continue;
    const ownMsgId = (d.kind === "message_worker" ? d.detail?.msgId : d.detail?.queuedMsgId) as string | undefined;
    if (typeof ownMsgId !== "string") continue; // defensive — mirrors staleDirectiveProjection's own guard
    const trueRoot = rootMap.get(ownMsgId) ?? ownMsgId;
    const label = possibleDuplicateRootLabel(trueRoot);
    if (rootLabel && label !== rootLabel) continue;
    const outcome = resolveDirectiveOutcome(events, d, ownMsgId);
    // CAUGHT IN REVIEW (manager, card 35c96aa6): this event's own `workerSessionId` is the RECIPIENT — the
    // lineage id it was delivered to — never the sender. `managerSessionId` is the sender (see
    // `messageWorker`/`deliverRedirect`, sessions/service.ts, which both stamp this event with BOTH fields
    // at once). An earlier draft read `workerSessionId` into a field literally named `fromSession`, which
    // is structurally guaranteed wrong: `db.listEventsForWorker` selects `WHERE worker_session_id = ?`, so
    // that value can only ever be one of `workerLineageDirectiveStream`'s own lineage ids — it could never
    // have named a sender.
    if (outcome.state === "delivered") {
      deliveries.push({ root: label, at: outcome.deliveredAt, turnSeq: outcome.turnSeqAtDelivery, msgId: outcome.msgId, fromSession: d.managerSessionId, receivedBy: d.workerSessionId ?? callerSessionId });
    } else if (outcome.state === "confirmed-after-park") {
      deliveries.push({ root: label, at: outcome.confirmedAt, turnSeq: null, msgId: outcome.msgId, fromSession: d.managerSessionId, receivedBy: d.workerSessionId ?? callerSessionId });
    }
  }
  deliveries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const truncated = !rootLabel && deliveries.length > UNFILTERED_DELIVERY_CAP;
  const bounded = rootLabel ? deliveries : deliveries.slice(-UNFILTERED_DELIVERY_CAP);
  const currentTurnSeq = db.getSession(callerSessionId)?.turnSeq ?? 0;
  return { deliveries: bounded, currentTurnSeq, truncated };
}

export class OrchestrationMcpRouter {
  // `pty` is OPTIONAL and LAST — added after the constructor's existing (db, sessions, companion) shape
  // was already load-bearing across every test call site (many positional, some omitting `companion`
  // entirely). Appending it here keeps every existing call site byte-identical; a caller that doesn't
  // pass it just gets `lastEngineOutputAt: null` on every row (see fleetView/worker_status below).
  // `gitWriteTimeouts` (card a3c3ade8, `git-push` lever) is appended AFTER `pty` for the same reason —
  // every existing call site (many of them test doubles omitting it) stays byte-identical. Mirrors
  // `PlatformMcpRouter`'s own constructor shape (mcp/platform.ts) so the companion's `git_commit`/
  // `git_push` tools bound a git op EXACTLY like the human REST git routes and the Lead's own git tools;
  // undefined ⇒ `GitWriter`'s own module-default timeouts (used by every existing test double).
  constructor(
    private db: Db,
    private sessions: SessionService,
    private companion: CompanionHooks = {},
    private pty?: PtyHost,
    private gitWriteTimeouts?: { gitLocalMs: number; gitPushMs: number },
  ) {}

  // Companion injection-guard Primitive C's pending-proposal store (card 8e511951) — ONE per router
  // instance (a stateless per-request buildServer would otherwise lose a pending proposal before the
  // owner's confirming reply arrives). No lever proposes/confirms yet — this just gives `attest` (built in
  // buildServer below) somewhere durable to keep state across requests once one does.
  private readonly ownerConfirmStore = new OwnerConfirmStore();

  // Direction (a), card 2b26035c ("inline authored-content grant"): ONE per router instance, same
  // lifetime/rationale as `ownerConfirmStore` above — an explicit, Primitive-C-confirmed grant must
  // survive across the propose call and the owner's later confirming call, both separate requests.
  private readonly authoredContentGrants = new AuthoredContentGrantStore();

  // Companion Trust Window (Framework Card 0) — ONE per router instance, same lifetime/rationale as
  // `ownerConfirmStore` above (in-memory, lost on restart is a fail-safe). Public so gateway/server.ts's
  // REST handlers can revoke every window for a session on the documented close paths (recycle/unbind/
  // binding-allowlist change/re-pair) via {@link closeCompanionTrustWindow} without reaching into the
  // instance directly.
  readonly trustWindow = new CompanionTrustWindow();

  /** Revoke every trust window held for `sessionId`, across every route/sender — called from the REST
   *  layer's own close paths (session recycle/unbind, a binding/allowlist change, a re-pair); a daemon
   *  restart closes every window automatically (in-memory). Also clears any inline authored-content
   *  grant (card 2b26035c) held for the same session — a grant must never outlive the session it was
   *  explicitly granted to, mirroring the trust window's own close-path lifetime. Also clears any
   *  OUTSTANDING (unconfirmed) Primitive-C proposal held for the same session — both the shared
   *  `OwnerConfirmStore` token/summary/expiry AND each ACT lever's own payload map (card 327bcaaa: before
   *  this, neither was cleared here, so a recycled/unbound/re-paired session's pending proposal became
   *  permanently-orphaned dead memory — never confirmable again since the session is gone, but genuine
   *  leaked state that only a daemon restart would clear). */
  closeCompanionTrustWindow(sessionId: string): void {
    this.trustWindow.closeAllForSession(sessionId);
    this.authoredContentGrants.clearSession(sessionId);
    this.ownerConfirmStore.clearSession(sessionId);
    clearPendingProposalsForSession(sessionId);
  }

  /** Role gate: returns the session's id + orchestration role, or null (→ 404) for plain/unknown.
   *  Admits the Companion (assistant) too — it reaches this surface for its MINIMAL toolset (my_context +
   *  the companion-gated chat_reply); buildServer restricts what it actually registers. */
  resolveRole(sessionId: string): { id: string; role: SessionRole } | null {
    const role = this.db.getSession(sessionId)?.role;
    return role === "manager" || role === "worker" || role === "assistant" ? { id: sessionId, role } : null;
  }

  /** @decision 89257222 — never re-derive or hardcode `timeoutMs` here; always read it through the same
   *  `resolveConfig(...).orchestration.gateCommandTimeoutMs` path the gate itself enforces, or a
   *  per-project override silently stops tracking.
   *
   *  TRUST BOUNDARY: this is READ-ONLY by design (PL Auditor finding #9). `gateCommand` runs arbitrary
   *  host shell at daemon privilege — HUMAN-only-to-SET; NO set/propose/confirm-queue surface exists here. */
  /** Card 6f13746c: the project's merge-gate cadence + ungated counter, READ-only (my_context / worker_merge review). */
  private resolvedMergeGate(projectId: string | undefined) {
    return projectId ? this.sessions.mergeGateAgentView?.(projectId) : undefined; // primary repo (a worker_merge review reports ITS repo)
  }
  private resolvedGateCommand(projectId: string | undefined):
    | { configured: true; command: string; timeoutMs: number }
    | { configured: false; command: null; note: string; timeoutMs: number } {
    const project = projectId ? this.db.getProject(projectId) : undefined;
    const resolved = resolveConfig(project?.config).orchestration;
    const command = resolved.gateCommand;
    const timeoutMs = resolved.gateCommandTimeoutMs;
    if (command && command.trim() !== "") return { configured: true, command, timeoutMs };
    return {
      configured: false,
      command: null,
      timeoutMs,
      note: "none configured — this project has no build/DoD gateCommand. Ask the OWNER to set one " +
        "(a HUMAN-only action; agents cannot set it). Do NOT hand-roll a gate command into a worker's DoD.",
    };
  }

  /**
   * READ-ONLY projection of the caller's project RESOLVED board columns (card bb95a379) — the SAME array
   * `currentColumns` builds and the three `board_column_*` mutators already return in their `{ok, columns,
   * warnings}` payload; no new shape. Folded into `my_context` so a manager can read the layout (and, in
   * particular, which columns carry `excludeFromIdleWatchdog`) WITHOUT issuing a mutating
   * board_column_rename/create/delete call just to see the response. Resolves through the SAME
   * `resolveConfig(...).kanbanColumns` expression `idle-watcher.ts`/`wake-impact.ts` themselves consume to
   * build `excludedColumnKeys` — so this read exposes exactly what both of those shared units act on, not a
   * parallel reimplementation that could drift. Answers BOTH the shipped-defaults case (no project
   * override — `currentColumns` resolves straight through to `PLATFORM_DEFAULTS.kanbanColumns`) and the
   * per-project-override case (an explicit `kanbanColumns` override, resolved in its place) — the same
   * `currentColumns` call handles both, so there is no separate default-vs-override branch here to omit
   * one of them.
   */
  private resolvedColumns(projectId: string | undefined): KanbanColumn[] {
    return projectId ? currentColumns(this.db, projectId) : resolveConfig(undefined).kanbanColumns;
  }

  /**
   * The caller's OWN measured context occupancy (server-derived from the URL-path session id — a
   * session can only ever read itself, so cross-session reads are impossible). Reuses the value the
   * Stop-time measurement path persists (`ctx_input_tokens`, via sessions/context.ts) — NO new
   * measurement. Returns `pct: null` + a note when not yet measured (never a fake 0%). Also folds in the
   * project's RESOLVED `gateCommand` (READ-ONLY — see resolvedGateCommand), the project's RESOLVED board
   * `columns` (READ-ONLY — see resolvedColumns), and, for a companion (`role === "assistant"`), its own
   * delivery/channel introspection (see companionIntrospection).
   */
  private myContext(sessionId: string): Record<string, unknown> {
    const s = this.db.getSession(sessionId);
    // Card 7fcb586a: `sessionId` (the URL-path id — see resolveRole) IS the daemon's own LOOM-namespaced
    // session row id; return it explicitly named `loomSessionId` so a session can self-report the id its
    // manager/durable rows actually use, rather than an ENGINE-namespaced id inferred from its own
    // scratchpad/transcript path (the two are indistinguishable well-formed uuids by shape alone).
    // `engineSessionId` is returned ALONGSIDE it (never omitted) so a reader can always tell which
    // namespace it's looking at; explicit `null` (not an absent key) when the SessionStart hook hasn't
    // captured it yet — `null` here is decidable ("not captured yet"), an absent key would not be.
    const loomSessionId = sessionId;
    const engineSessionId = s?.engineSessionId ?? null;
    const ctxInputTokens = s?.ctxInputTokens ?? null;
    const measuredAt = s?.ctxUpdatedAt ?? null;
    const gateCommand = this.resolvedGateCommand(s?.projectId);
    const mergeGate = this.resolvedMergeGate(s?.projectId);
    const columns = this.resolvedColumns(s?.projectId);
    const companion = s?.role === "assistant" ? this.companionIntrospection(sessionId) : undefined;
    // Card dcd8659c: the same PtyHost getter worker_list/worker_status read, folded in here so a
    // manager/worker can self-check whether ITS OWN composer is holding unsubmitted text — the gap named
    // in the card as not covered by the third-party worker_list/worker_status read. null (not 0) when the
    // session isn't live in this process — see getComposerDirtyLen's own doc for why a dead/never-live
    // session must never read as a measured-clean 0.
    // ⚠️ Card c148f118: `composerDirtyLen` is the CONSERVATIVE reading only — it never assumes a
    // defensive clear-prefix actually landed, so ALONE it cannot distinguish "a clear failed" from "a
    // clear worked but the fresh write after it hasn't confirmed yet." `composerDirtyLenBelieved` is the
    // OPTIMISTIC counterpart (same getter shape, same null-vs-0 discipline) — read them TOGETHER: equal
    // means nothing to doubt, `Believed < composerDirtyLen` means a clear is unresolved and the gap is
    // exactly how many characters are in doubt. See getComposerDirtyLen/getComposerDirtyLenBelieved's own
    // docs (pty/host.ts) for the full mechanics.
    const composerDirtyLen = this.pty?.getComposerDirtyLen(sessionId) ?? null;
    const composerDirtyLenBelieved = this.pty?.getComposerDirtyLenBelieved(sessionId) ?? null;
    // Card a33a72f7: the earlier-than-composerDirtyLen "delivery in flight, unconfirmed" signal — see
    // getPendingConfirmMs's own doc for exactly what it does/doesn't distinguish from composerDirtyLen.
    const unconfirmedDeliveryMs = this.pty?.getPendingConfirmMs(sessionId) ?? null;
    if (ctxInputTokens == null) {
      // Pre-first-turn: the transcript-derived `s.model` is still null (nothing measured yet), but the
      // CONFIGURED model is already known at spawn via the session's agent → Profile (`profile.model`,
      // the same value `resolveProfile` reads to pick --model). Reuse it so an unmeasured 1M-window
      // session reports its real window instead of the DEFAULT_CONTEXT_WINDOW fallback. `measured:false`
      // marks the reading explicit either way, so a genuine 200k (no profile / engine-default model —
      // truly unknown pre-turn) is never mistaken for a measured occupancy.
      const agent = s?.agentId ? this.db.getAgent(s.agentId) : undefined;
      const profile = agent?.profileId ? this.db.getProfile(agent.profileId) : undefined;
      const model = profile?.model ?? null;
      const contextWindow = contextWindowForModel(model);
      return {
        loomSessionId, engineSessionId,
        ctxInputTokens: null, contextWindow, pct: null, model, measuredAt, gateCommand, ...(mergeGate ? { mergeGate } : {}), columns, measured: false,
        note: "context not measured yet (no completed turn) — occupancy unknown; contextWindow/model " +
          "reflect the CONFIGURED profile model when set, else the DEFAULT_CONTEXT_WINDOW fallback",
        // Card c5b234aa — see ctxMidTurnFields's own doc (fleetView, mcp/orchestration.ts). Trivially
        // false here: ctxInputTokens is null, so there is no reading to be mid-turn OR stale.
        ctxMidTurn: ctxMidTurnFields(s ?? null).ctxMidTurn,
        composerDirtyLen,
        composerDirtyLenBelieved,
        unconfirmedDeliveryMs,
        ...(companion ? { companion } : {}),
      };
    }
    const model = s?.model ?? null;
    const contextWindow = contextWindowForModel(model);
    return {
      loomSessionId,
      engineSessionId,
      ctxInputTokens,
      contextWindow,
      pct: Math.round((ctxInputTokens / contextWindow) * 100),
      model,
      measuredAt,
      // Card c5b234aa — see ctxMidTurnFields's own doc (fleetView, mcp/orchestration.ts): true only while
      // `ctxInputTokens` above was measured DURING the turn that's still running.
      ctxMidTurn: ctxMidTurnFields(s ?? null).ctxMidTurn,
      gateCommand,
      ...(mergeGate ? { mergeGate } : {}),
      columns,
      composerDirtyLen,
      composerDirtyLenBelieved,
      unconfirmedDeliveryMs,
      ...(companion ? { companion } : {}),
    };
  }

  /**
   * READ-ONLY companion self-introspection (Companion Delivery Introspection — owner-directed, 2026-07-12):
   * the bound channel(s) + each one's effective voice-reply mode, plus the LAST reply this companion
   * actually delivered (channel, text, and whether it went out as a synthesized voice clip — `text` doubles
   * as that clip's transcript, since TTS speaks exactly the reply text, so there is nothing further to
   * store). Folded into `my_context` (assistant role only, see myContext above) so a companion asked "send
   * the transcript of your last voice message" or "what did you just send, and where" can answer from real
   * state instead of re-guessing/re-pasting from its own turn history.
   *
   * TRUST BOUNDARY: this is a READ over the caller's OWN session ONLY — `sessionId` is the URL-path id
   * (never agent-suppliable, see resolveRole), so a companion can never introspect another session's
   * bindings or deliveries. Voice mode is resolved with `senderId: null`, mirroring EXACTLY how
   * ChatGateway.tryDeliverVoice itself resolves the outbound pref (a DM's key; a group's per-sender pref is
   * a documented, separate limitation — see voice-prefs.ts) — so what this reports is what actually governs
   * delivery, never a guess. `chatId` (the external platform identity, e.g. a Telegram chat id) is
   * deliberately omitted from the bindings list — the companion only needs to know WHICH channels it's
   * reachable on and their voice mode, not the raw external route.
   */
  private companionIntrospection(sessionId: string): Record<string, unknown> {
    const bindings = this.db.getCompanionBindingsForSession(sessionId).map((b) => ({
      channel: b.channel,
      voiceReplies: this.db.getCompanionVoicePref(sessionId, b.channel, b.chatId, null)?.voiceReplies ?? "off",
    }));
    const last = this.db.getLastCompanionDelivery(sessionId);
    return {
      bindings,
      lastDelivery: last
        ? { channel: last.channel, text: last.text, viaVoice: last.viaVoice, sentAt: last.createdAt }
        : null,
    };
  }

  /** Register `my_context` — available to ANY role (manager + worker); read-only, no args, no gating. */
  // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
  // text (an end-user agent can't resolve a card/decision id):
  // @decision c5b234aa — ctxMidTurn mid-turn sampler race guard.
  // @decision 6f13746c — mergeGate cadence/interval semantics.
  // @decision c148f118 — composerDirtyLenBelieved is the optimistic counterpart to composerDirtyLen.
  // @decision d4b3fa6c — the composerDirtyLen GIVE-UP SUPPRESSED gap is a documented limitation.
  // @decision a33a72f7 — unconfirmedDeliveryMs never distinguishes still-retrying from already-gave-up.
  private registerMyContext(server: McpServer, sessionId: string): void {
    server.registerTool(
      "my_context",
      {
        description:
          "Read YOUR OWN context occupancy (no args — server-derived from your session). Returns " +
          "{loomSessionId, engineSessionId, ctxInputTokens, contextWindow, pct, model, measuredAt, " +
          "ctxMidTurn, gateCommand}: pct is your measured " +
          "context size as a percentage of your model's window. `ctxMidTurn` is true " +
          "only while `ctxInputTokens`/`pct` were measured DURING the still-running turn (Loom's mid-turn " +
          "sampler); false means you're idle (the reading is your last completed turn's, accurate while idle) " +
          "or the current turn hasn't been re-sampled yet (may be stale). APPROXIMATE: other writes (an error, " +
          "a process-state change, an engine-session-id rotation, a capability patch) also bump the same " +
          "`lastActivity`, so one `false` is not proof the reading is stale; it self-corrects on the next " +
          "sampler tick. Use it at a clean seam to self-assess — " +
          "a manager to decide whether to recycle_me, a worker to worker_report that it's getting heavy. " +
          "`loomSessionId` is the id the DAEMON uses for you (what managers, event rows and peer frames name " +
          "you by); state it when SELF-IDENTIFYING in a report. `engineSessionId` is the SEPARATE id the engine " +
          "assigns (your own scratchpad/transcript/tool-results paths are namespaced under it); explicit `null` " +
          "(never an absent key) until the SessionStart hook has captured it. Both are v4 uuids that look alike: " +
          "an id read off the ENGINE's transcript path or harness tool-results directory is ALWAYS the engine " +
          "one, and reporting it as \"my session\" silently fails to match Loom-stamped rows. Loom's OWN scratch " +
          "dir (`LOOM_SCRATCH_DIR`, where a spilled `rowsFile` lands) is keyed by the LOOM session id, a second " +
          "legitimate route. Prefer `loomSessionId` unless you mean the engine's id. " +
          "If not yet measured (no completed turn), pct is null and `measured:false` is set explicitly — " +
          "contextWindow/model then reflect your CONFIGURED profile model, not a fake reading. `mergeGate` " +
          "(READ-ONLY — cadence and interval are HUMAN-only) is " +
          "{cadence: \"every\"|\"interval\"|\"never\", interval: number|null, ungatedSinceLastPass, " +
          "nextLandingGated, gateOwed}: `every` = every merge runs the gate; `interval` = gate off but every " +
          "N-th landing still runs it (ungatedSinceLastPass counts branches landed WITHOUT a passing gate since " +
          "the last pass); `never` = gate off, no interval (ungatedSinceLastPass is the \"unverified on main\" " +
          "figure). `nextLandingGated` is whether the NEXT landing of ONE branch will run the gate; `gateOwed` " +
          "means a periodic gate failed (or a human asked) so every landing is gated until one passes. " +
          "`gateCommand` is the project's RESOLVED build/DoD gate, READ-ONLY: " +
          "{configured:true, command, timeoutMs} when set, else {configured:false, command:null, note, " +
          "timeoutMs} — when unconfigured, ASK THE OWNER to set one (a human-only action); never " +
          "hand-roll a gate command into a worker's DoD. `timeoutMs` is the RESOLVED gate timeout (what the gate " +
          "enforces); never guess or carry an inherited figure. Margin facts: " +
          "(1) a step is auto-extended past `timeoutMs` while it keeps producing output, so exceeding it does " +
          "NOT by itself mean failure; (2) the merge gate's retry-after-timeout runs with NO extension, so first " +
          "attempt = timeoutMs + one extension (~2x) while a retry is a HARD timeout — state (1) and (2) " +
          "together or the margin is computed against the wrong ceiling; (3) the extension is refused if the " +
          "child has been idle for a while; (4) a retry fires only for a non-genuine failure — a timeout is " +
          "retry-eligible, a clean non-zero exit (real test failure) never retries. `composerDirtyLen` " +
          "is a count of characters possibly still sitting UNSUBMITTED in YOUR OWN composer from an " +
          "earlier delivery that never confirmed (null when not live in this process; 0 means genuinely " +
          "clean, NOT unknown) — non-zero with no turn progressing MAY mean your last message never landed; " +
          "one Enter in your terminal (or worker_flush, if you're a worker) recovers a genuinely stranded one. " +
          "`composerDirtyLenBelieved` (same null-vs-0 discipline) is the OPTIMISTIC counterpart: " +
          "`composerDirtyLen` never assumes a defensive clear-prefix landed, `composerDirtyLenBelieved` always " +
          "does. Read them TOGETHER: equal means nothing to doubt; Believed LOWER means a clear was attempted " +
          "and is unresolved, the gap being how many characters are in doubt. ⚠️ NOT decisive alone: a GIVE-UP " +
          "SUPPRESSED mark (Loom believed your turn started because output followed its final Enter) has no " +
          "automatic clear path on its own generation and can read non-zero indefinitely with nothing stranded; " +
          "it clears when a LATER unrelated delivery confirms. Pressing Enter (or worker_flush) is the free " +
          "disambiguator. " +
          "`unconfirmedDeliveryMs` is an EARLIER signal: milliseconds since your CURRENT generation's Enter was " +
          "written, while it stays unconfirmed — null (an ABSENT signal, not a measured zero) when nothing is " +
          "outstanding or the session isn't live in this process; a number the INSTANT a write is outstanding. " +
          "It does NOT distinguish 'still within the retry budget' from 'already gave up, outcome unknown' " +
          "(giving up never resets it). Cross-check composerDirtyLen: zero there while this is non-null means " +
          "genuinely in-flight and never given up; non-zero is ambiguous (this generation's give-up, or stale " +
          "residue from an earlier one). If you are a " +
          "Companion (chat_reply is on your tool list), the response ALSO " +
          "includes `companion`: {bindings: [{channel, voiceReplies}], lastDelivery: {channel, text, " +
          "viaVoice, sentAt} | null} — your OWN bound channel(s) + effective voice-reply mode, and the last " +
          "reply you delivered (`text` IS the clip's transcript when `viaVoice` is true). " +
          "`columns` is your project's RESOLVED board layout — the SAME array the `board_column_create/" +
          "rename/delete` tools return, readable without a mutating call. Each " +
          "entry carries at least {key, label, role, excludeFromIdleWatchdog}; role and " +
          "excludeFromIdleWatchdog are OPTIONAL and ABSENT when not set (today's default: unroled / not " +
          "discounted from the idle watchdog), never a measured `false`.",
        inputSchema: strictShape({}),
      },
      async () => ok(this.myContext(sessionId)),
    );
  }

  /**
   * Loom Companion: register `chat_reply` ONLY on an ENABLED companion session's MCP server (multi-companion
   * runtime — `companionSessionIds` may hold several concurrently-armed sessions; each gets its OWN
   * chat_reply on its OWN server build). Placed BEFORE the role split so a companion bound to EITHER a
   * manager or a worker session gets it; a session that isn't in the enabled set never registers it, keeping
   * every other spawn's tool surface byte-identical. The tool routes to THIS session's own delivery path
   * (deliverReply, dispatched by `sessionId` to that session's own gateway — never another companion's) — it
   * does NOT submit a turn (that would loop the reply back into the agent).
   */
  private registerChatReplyIfCompanion(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;
    const deliverReply = this.companion.deliverReply;
    server.registerTool(
      "chat_reply",
      {
        description:
          "Reply to the user talking to you over the Loom Companion chat channel (e.g. Telegram). Pass " +
          "the reply `text`; it is delivered VERBATIM back to the chat you're bound to. This is your ONLY " +
          "way to reach that user — on an ordinary turn, the incoming chat message was injected as this " +
          "turn, and calling chat_reply is how your answer gets OUT (it does NOT loop back in as a new " +
          "turn). IT ALSO WORKS on a PROACTIVE turn you did NOT receive an incoming message for (a " +
          "heartbeat, a reminder, or an `[loom:alert]` push) — the daemon resolves the SAME bound channel " +
          "for that turn too, so there is nothing to wait for: if something in a proactive turn is worth " +
          "surfacing, call chat_reply with it directly instead of holding it back for the user to message " +
          "first. A `{delivered:false}` result (e.g. `no-target`) means there genuinely is no channel to " +
          "reach right now — that's the only case to hold back and wait. A `route-flagged-non-private` " +
          "reason is DIFFERENT and PERMANENT: this route was flagged because it does not confirm as a " +
          "private chat, and Loom will deliberately withhold every reply to it until a human re-binds it — " +
          "retrying chat_reply here will never succeed, so if you're bound to another channel, tell the " +
          "user there instead; otherwise there is nothing more to do this turn. A `route-unbound` reason " +
          "is ALSO PERMANENT for this attempt: the route has no live binding at all (it was never bound, " +
          "or its binding was revoked) — if this is your configured HOME route, the fix is for a human to " +
          "change it (not re-bind), so just like `route-flagged-non-private`, tell the user on another " +
          "channel if you're bound to one, otherwise there is nothing more to do. A `timeout` reason is " +
          "DIFFERENT from all of the above: it means the send did not CONFIRM within the bound, but it may " +
          "still have reached the chat (a late response can land after the cutoff) — treat it as UNKNOWN, " +
          "never as a confirmed failure. Do NOT automatically resend the same text on a `timeout` — if the " +
          "original did land late, a resend duplicates it for the user; instead wait for the user's own " +
          "next message, and only speak again if they indicate they didn't receive it. Mirrors " +
          "worker_report: emit one clean, final reply. Optional `voice:true` asks to SPEAK this reply " +
          "instead of texting it — it only has effect when the user's voice-reply setting is 'auto' (their " +
          "own on/off choice always wins otherwise); omit it (or pass false) to send plain text.",
        inputSchema: strictShape({ text: z.string(), voice: z.boolean().optional() }),
      },
      async ({ text, voice }) => {
        if (!deliverReply) return ok({ delivered: false, error: "companion transport not configured" });
        return ok(await deliverReply(sessionId, text, voice));
      },
    );
  }

  /**
   * Loom Companion (epic Phase 2): self-authored skills. Registered ONLY on an ENABLED companion session
   * (the SAME per-session gate as chat_reply) so every other manager/worker spawn's surface stays byte-identical.
   * The store is ISOLATED per companion under <LOOM_HOME>/companion-skills/<sessionId>/ (skills/companion-
   * store.ts): writes NEVER touch the global SKILLS_DIR and are NEVER injected into any session's
   * .claude/skills. Loading is ON-DEMAND — the companion consults skill_list (compact) then skill_read (full);
   * skill_author authors/refines-in-place (with a redundancy guard against near-duplicate NEW names) and
   * skill_remove curates.
   */
  private registerCompanionSkillTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;

    server.registerTool(
      "skill_author",
      {
        description:
          "Author or REFINE one of YOUR OWN personal skills (a reusable playbook, private to you and " +
          "isolated from Loom's shared skills). `content` is the FULL SKILL.md (frontmatter `name`/" +
          "`description` + body). Authoring an EXISTING `name` REWRITES it in place — supply the whole " +
          "improved content (no appending, keep it bounded and self-consistent). A NEW name that closely " +
          "duplicates an existing skill is REJECTED with a note telling you to refine the existing one " +
          "instead. Returns the updated compact skill list, or {error}.",
        inputSchema: strictShape({ name: z.string(), content: z.string() }),
      },
      async ({ name, content }) => {
        const r = authorCompanionSkill(sessionId, name, content);
        return ok(r.ok ? { authored: name, skills: r.skills } : { error: r.error });
      },
    );

    server.registerTool(
      "skill_list",
      {
        description:
          "List YOUR OWN personal skills as compact {name, description} entries. Consult this when a request " +
          "may match something you've learned before, then skill_read the one that fits to load it in full.",
        inputSchema: strictShape({}),
      },
      async () => ok({ skills: listCompanionSkills(sessionId) }),
    );

    server.registerTool(
      "skill_read",
      {
        description:
          "Read the FULL SKILL.md of one of YOUR OWN personal skills by name — the on-demand full load. Use " +
          "it after skill_list identifies a relevant skill, to load its steps before acting. Returns {name, " +
          "content}, or {error} if there's no such skill. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars " +
          "content spills to a scratch file instead of inlining, and the response becomes {name, " +
          "contentFile, contentChars, note}.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const content = readCompanionSkill(sessionId, name);
        if (content == null) return ok({ error: `no skill "${name}"` });
        // card 26134f1a: a self-authored skill's content is free-form and uncapped — the companion
        // (assistant role, a TRANSCRIPT_ROOT_DENY_ROLES member) could write/accumulate enough of it to
        // exceed the engine's own native tool-result threshold with no spill protection.
        const spill = spillTextIfLarge(sessionId, "skill-read-spills", name, content, SPILL_INLINE_BUDGET_CHARS);
        if (spill.inline) return ok({ name, content });
        return ok({ name, contentFile: spill.file, contentChars: spill.chars, note: `content is ${spill.chars} chars — too large to inline safely, so it was written to ${spill.file}. Read it directly, or grep it for a substring.` });
      },
    );

    server.registerTool(
      "skill_remove",
      {
        description:
          "Remove one of YOUR OWN personal skills by name (curation/dedup). Returns the updated compact skill " +
          "list, or {error} if there's no such skill.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const r = removeCompanionSkill(sessionId, name);
        return ok(r.ok ? { removed: name, skills: r.skills } : { error: r.error });
      },
    );
  }

  /**
   * Loom Companion (epic Phase 2): self-authored DURABLE MEMORY — the sibling surface of
   * registerCompanionSkillTools (SAME per-session gate), backed by companion-memory-store.ts
   * (MEMORY.md entries, isolated per companion under <LOOM_HOME>/companion-memory/<sessionId>/, never the
   * global SKILLS_DIR). Agent surface ONLY — this card does NOT touch recall/turn-formation; a memory
   * entry authored here is not yet injected into any prompt.
   */
  private registerCompanionMemoryTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;

    server.registerTool(
      "memory_write",
      {
        description:
          "Author or REFINE one of YOUR OWN durable memory entries (a fact worth remembering across " +
          "conversations, private to you). `content` is the FULL MEMORY.md (frontmatter `name`/" +
          "`description`/`pinned` + body). Authoring an EXISTING `name` REWRITES it in place — supply the " +
          "whole refined content (no appending, keep it bounded and self-consistent). A NEW name that " +
          "closely duplicates an existing memory is REJECTED with a note telling you to refine the " +
          "existing one instead. Returns the updated compact memory list, or {error}.",
        inputSchema: strictShape({ name: z.string(), content: z.string() }),
      },
      async ({ name, content }) => {
        const r = authorCompanionMemory(sessionId, name, content);
        return ok(r.ok ? { authored: name, memories: r.memories } : { error: r.error });
      },
    );

    server.registerTool(
      "memory_list",
      {
        description:
          "List YOUR OWN durable memory entries as compact {name, description, pinned} entries. Consult " +
          "this to see what you already remember before authoring a new entry or answering from memory.",
        inputSchema: strictShape({}),
      },
      async () => ok({ memories: listCompanionMemories(sessionId) }),
    );

    server.registerTool(
      "memory_read",
      {
        description:
          "Read the FULL MEMORY.md of one of YOUR OWN durable memory entries by name. Returns {name, " +
          "content}, or {error} if there's no such entry. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars " +
          "content spills to a scratch file instead of inlining, and the response becomes {name, " +
          "contentFile, contentChars, note}.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const content = readCompanionMemory(sessionId, name);
        if (content == null) return ok({ error: `no memory "${name}"` });
        // card 91fef05a, mirroring skill_read (card 26134f1a): a self-authored memory entry is free-form
        // and uncapped — the companion (assistant role, a TRANSCRIPT_ROOT_DENY_ROLES member) could write/
        // accumulate enough of it to exceed the engine's own native tool-result threshold with no spill
        // protection.
        const spill = spillTextIfLarge(sessionId, "memory-read-spills", name, content, SPILL_INLINE_BUDGET_CHARS);
        if (spill.inline) return ok({ name, content });
        return ok({ name, contentFile: spill.file, contentChars: spill.chars, note: `content is ${spill.chars} chars — too large to inline safely, so it was written to ${spill.file}. Read it directly, or grep it for a substring.` });
      },
    );

    server.registerTool(
      "memory_remove",
      {
        description:
          "Remove one of YOUR OWN durable memory entries by name (curation/dedup). Returns the updated " +
          "compact memory list, or {error} if there's no such entry.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const r = removeCompanionMemory(sessionId, name);
        return ok(r.ok ? { removed: name, memories: r.memories } : { error: r.error });
      },
    );
  }

  /**
   * Loom Companion Reminders (Companion Memory & Reminders Design, Surface 2 s4): the RECURRING reminders
   * engine's agent surface — the sibling of registerCompanionMemoryTools/registerCompanionSkillTools (SAME
   * per-session gate). Unlike those, there is NO spawn surface here either: a reminder only
   * ever targets the companion's OWN session (server-derived sessionId, never agent-passed — mirrors "the
   * agent never passes a projectId"). Cron is validated AT THE BOUNDARY (never relying on the watcher's
   * defensive catch), the route is captured SERVER-SIDE exactly like wake_me, and create/cancel drive
   * ARM-ON-CREATE via the injected `rearmReminders` hook so a freshly-created reminder starts firing
   * immediately instead of waiting on an unrelated config write's reconcile.
   */
  private registerCompanionReminderTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;
    const db = this.db;

    server.registerTool(
      "reminder_create",
      {
        description:
          "Create a RECURRING reminder that fires a proactive [loom:reminder] turn into YOUR OWN session on " +
          "a cron schedule (5-field cron expression) — distinct from the one-shot wake_me. `prompt` is what " +
          "you'll be re-prompted with EVERY time it fires; `label` is an optional human-facing name. The " +
          "reply route is captured SERVER-SIDE from your current turn (you never pass one), so a later fire " +
          "can chat_reply back to the SAME chat. Starts armed immediately. Returns {reminderId, nextFireAt}, " +
          "or {error} on an invalid cron expression.",
        inputSchema: strictShape({ cron: z.string(), prompt: z.string(), label: z.string().optional() }),
      },
      async ({ cron, prompt, label }) => {
        const now = new Date();
        try {
          nextFireAt(cron, now); // validate AT THE BOUNDARY — never rely on the watcher's defensive catch.
        } catch {
          return ok({ error: `invalid cron expression: ${cron}` });
        }
        const route = this.companion.getActiveTurnOrigin?.(sessionId) ?? null;
        const reminder: CompanionReminder = {
          id: randomUUID(), sessionId, cron, prompt, label: label ?? null,
          route, enabled: true, createdAt: now.toISOString(),
        };
        db.insertCompanionReminder(reminder);
        await this.companion.rearmReminders?.(sessionId); // ARM-ON-CREATE — must fire without a later config write.
        return ok({ reminderId: reminder.id, nextFireAt: reminderNextFireAt(db, reminder) });
      },
    );

    server.registerTool(
      "reminder_list",
      {
        description:
          "List YOUR OWN recurring reminders (any enabled state) as {id, cron, prompt, label, enabled, " +
          "nextFireAt}.",
        inputSchema: strictShape({}),
      },
      async () => {
        const reminders = db.listCompanionRemindersForSession(sessionId);
        // Single shared event-log scan for the whole list (CR#3 L3) instead of one scan per reminder.
        const nextFireById = reminderNextFireAtBySession(db, reminders);
        return ok(reminders.map((r) => ({
          id: r.id, cron: r.cron, prompt: r.prompt, label: r.label, enabled: r.enabled,
          nextFireAt: nextFireById.get(r.id) ?? null,
        })));
      },
    );

    server.registerTool(
      "reminder_cancel",
      {
        description:
          "Cancel one of YOUR OWN recurring reminders by id (scoped — can never touch another session's " +
          "reminder). Returns {cancelled}.",
        inputSchema: strictShape({ reminderId: z.string() }),
      },
      async ({ reminderId }) => {
        const r = db.getCompanionReminder(reminderId);
        if (!r || r.sessionId !== sessionId) return ok({ cancelled: false });
        db.deleteCompanionReminder(reminderId);
        await this.companion.rearmReminders?.(sessionId); // disarm too — a now-empty reminder set tears the watcher down.
        return ok({ cancelled: true });
      },
    );
  }

  private buildServer(sessionId: string, role: SessionRole, attributions?: Map<string, ToolAttributionResult>): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const pty = this.pty;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });
    instrumentServer(server, { router: "orchestration", sessionId, attributions }); // card 8ef582d0; bcef7e48
    // @decision 90dc3c8c — every tool registered on this server is auto-approved under codex
    // (CODEX_AUTO_APPROVE_MCP_SERVER_IDS, pty/host.ts) the instant it merges — no separate review.

    // Companion spike: additive, single-session-gated chat_reply (see registerChatReplyIfCompanion).
    this.registerChatReplyIfCompanion(server, sessionId);
    // Companion Phase 2: additive, single-session-gated self-authored skill tools (SAME gate as chat_reply).
    this.registerCompanionSkillTools(server, sessionId);
    // Companion Phase 2: additive, single-session-gated self-authored durable memory tools (SAME gate).
    this.registerCompanionMemoryTools(server, sessionId);
    // Companion Reminders s4: additive, single-session-gated RECURRING reminder tools (SAME gate).
    this.registerCompanionReminderTools(server, sessionId);
    // Companion Capability & Permission-Lever Framework §2: the ONE chokepoint for every opt-in lever
    // (session-status, …) — gated PER-CAPABILITY on a companion_capability_grants row for THIS session,
    // not on companionSessionIds (a lever can be granted even before/without the chat_reply gate, though
    // in practice today's only lever targets the same assistant-role companions). Zero grant rows ⇒ this
    // is a no-op for every session (additive, byte-identical to today). ALSO role-gated to "assistant"
    // (belt-and-suspenders — see registerCompanionCapabilities' doc).
    const attest = createOwnerAttestation(
      {
        getActiveTurnOwnerText: (sid) => pty?.getActiveTurnOwnerText(sid) ?? null,
        // Primitive A widening (card 2b26035c) — optional-chained on the METHOD too (not just `pty`): a
        // test double built before this card added getRecentOwnerTurns must not THROW here; it degrades
        // to an empty recent-turns window exactly like a real dead/unknown session would, never breaking
        // an existing test (isVerbatimOwnerText's current-turn check runs regardless — see its doc).
        getRecentOwnerTurns: (sid) => pty?.getRecentOwnerTurns?.(sid) ?? [],
      },
      this.ownerConfirmStore,
      this.authoredContentGrants,
    );
    // `pty` is optional on this router (see the constructor's own doc) — every method below degrades to a
    // harmless no-op/null when it's absent, exactly like the `attest` wiring just above. `outbound` wraps
    // `this.companion.deliverReply` — the SAME rail `chat_reply` uses (CompanionHooks.deliverReply →
    // ChatGateway.deliverReply), which resolves the delivery target from the CURRENT turn's own origin —
    // a lever never supplies/guesses a route. Missing/failed delivery degrades to `false` (fail closed);
    // never throws.
    registerCompanionCapabilities(server, sessionId, role, db, attest, {
      getActiveTurnOrigin: (sid) => pty?.getActiveTurnOrigin(sid) ?? null,
      // Optional-chained on the METHOD too (not just `pty`): a test double built before this card added
      // getActiveTurnSenderId (every existing companion-lever test's fake pty) must not THROW here — it
      // degrades to null exactly like a real dead/unknown session would, never breaking an existing test.
      getActiveTurnSenderId: (sid) => pty?.getActiveTurnSenderId?.(sid) ?? null,
      enqueueStdin: (sid, text, source, onDeliver, route, kind, questionId) =>
        pty?.enqueueStdin(sid, text, source, onDeliver, route, kind, questionId) ?? { delivered: false, reason: "session-dead" },
    }, {
      deliverToOwner: async (sid, text) => {
        try {
          const result = await this.companion.deliverReply?.(sid, text);
          if (!result) return false;
          if (result.delivered) return true;
          // Card b343c5f0 round 2: surface a timeout DISTINCTLY from a confirmed failure — GrantOutbound's
          // own doc on `deliverToOwner` is the contract for why (the send may have landed late).
          return result.reason === "timeout" ? "timeout" : false;
        } catch {
          return false; // fail closed — a throwing delivery path must never look like a successful send.
        }
      },
      // `media-out` lever's own outbound seam (card 3a81b0f2) — mirrors `deliverToOwner` but sends a file.
      // Unlike `deliverToOwner`'s boolean fail-closed contract, the lever needs to tell the difference
      // between "the channel just doesn't support media" (degrade gracefully) and an actual send failure,
      // so this returns the full `{delivered, reason?}` rather than collapsing it to a boolean.
      deliverMediaToOwner: async (sid, filePath) => {
        try {
          const result = await this.companion.deliverMedia?.(sid, filePath);
          return result ?? { delivered: false, reason: "unsupported-channel" };
        } catch {
          return { delivered: false, reason: "send-failed" }; // fail closed — never look like a success.
        }
      },
    }, {
      // `session-steer` lever's own seam (card 305a54fb) — a narrow, SCOPED slice of `SessionService`.
      // message/steer reuse the SAME durable cross-session delivery mechanics as the Platform Lead's own
      // `session_message`/`redirectWorker`, framed distinctly (`[loom:from-owner-via-companion]` /
      // `[loom:from-owner-via-companion:redirect]`); stop/resume reuse `stopSession`/`resume` UNCHANGED —
      // scope/roleFilter/Primitive-A enforcement all live in the lever, not here.
      messageSession: (sid, text, senderSessionId) => sessions.messageSessionAsCompanion(sid, text, senderSessionId),
      redirectSession: (sid, text, senderSessionId) => sessions.redirectSessionAsCompanion(sid, text, senderSessionId),
      stopSession: (sid, mode) => sessions.stopSession(sid, mode),
      resumeSession: (sid) => sessions.resume(sid),
      // `session-spawn` lever's own seam (Tier X, manager|plain ONLY) — the SAME SessionService spawn
      // the Platform Lead's own `session_spawn` uses (mcp/platform.ts). The role refusal is enforced in
      // the LEVER itself (before this is ever called); `senderSessionId` is threaded through for
      // traceability only, mirroring messageSession/redirectSession's own trailing param — the backing
      // op does not itself consume it. `role` is validated to "manager"|"plain" by the lever's own
      // spawnableRoleError guard before this is reachable, so the narrowing cast here is safe.
      // Card bba7a8ec: async so a manager spawn can take its deploy staleness from an off-loop pre-read.
      spawnSession: async (projectId, agentId, role, _senderSessionId) =>
        sessions.spawnSessionAsPlatform(projectId, agentId, role as "manager" | "plain", {
          deployStaleness: role === "manager" ? await sessions.resolveDeployStalenessAsync().catch(() => undefined) : undefined,
        }),
    }, this.trustWindow,
    // `git-push` lever's own seam (card a3c3ade8) — builds a bounded, non-interactive GitWriter for ONE
    // repo path, sharing the SAME boot-resolved timeouts the human git-write REST routes and the Platform
    // Lead's own git tools use (mcp/platform.ts's `gitWriterFor`). Undefined `gitWriteTimeouts` (every
    // existing test double) ⇒ GitWriter's own module-default timeouts.
    (repoPath) => new GitWriter(repoPath, this.gitWriteTimeouts));

    // Companion (epic Phase 1): the long-lived `assistant` role gets a NARROW, capability-gated surface —
    // NOT just `{my_context, chat_reply}` (a stale undercount that propagated into at least one defect
    // report, card 4fc458c1). The unconditional base is my_context + notify_lead (registered just below);
    // layered on top, gated on the companion binding/grants above (registerChatReplyIfCompanion,
    // registerCompanionSkillTools, registerCompanionMemoryTools, registerCompanionReminderTools,
    // registerCompanionCapabilities): chat_reply, the skill_*/memory_*/wake_*/reminder_*/board_* tools, and
    // the whole opt-in capability-lever framework (session-status, media-out, session-steer, session-spawn,
    // authored-content-grant). DELIBERATELY no manager spawn/stop/list surface and no unconditional writer
    // (least-privilege — the restricted tool profile is a later card). Returns before the manager
    // fall-through below.
    if (role === "assistant") {
      this.registerMyContext(server, sessionId);
      // Subordinate→lead relay (card 2db23c4d): the ONE narrow lever an owner-facing non-manager session
      // gets — a durable-queued message to ITS OWN project's live manager. NOT the full orchestration
      // surface (no spawn/list/stop/merge) — mirrors messagePeerManager's mechanics, same-project instead
      // of cross-project. See SessionService.notifyLead's own doc for the full trust-boundary rationale.
      server.registerTool(
        "notify_lead",
        {
          description:
            "Relay a message to YOUR OWN project's live manager/lead — the one bounded escalation lever an " +
            "owner-facing non-manager (assistant-role) session has. There is no target param: this always " +
            "reaches your own project's manager, never any other session or project. Delivers to the LIVE " +
            "manager session ONLY (never a worker or other role there); if no manager is live right now, the " +
            "message is durably BOARDED as a task on your project's OWN board instead of being dropped — its " +
            "manager will see it next time it attaches. Returns `deliveryStatus` (delivered-live | queued | " +
            "boarded) plus `taskId` when boarded. Rate-limited per session. The message is framed and " +
            "delivered as a SUBORDINATE RELAY, not an owner-authored instruction — the manager treats it as " +
            "a claim to weigh/verify (same treatment class as a worker_report), even when you're relaying " +
            "something the owner told you to pass along. Use this instead of writing 'lead, take note' into " +
            "shared memory or any other workaround — this is the sanctioned channel.",
          inputSchema: strictShape({ text: z.string() }),
        },
        async ({ text }) => {
          try {
            return ok(sessions.notifyLead(sessionId, text));
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );
      return server;
    }

    if (role === "worker") {
      this.registerMyContext(server, sessionId);
      // A worker's ENTIRE surface: report up to its manager. No spawn/list/stop.
      server.registerTool(
        "worker_report",
        {
          description: "Report your status up to your manager: moves your task (done→review, blocked→waiting) and notifies the manager. Call when done, blocked, or to checkpoint progress. Returns a `deliveryStatus` (delivered-live | queued | boarded | dropped): your manager got it now, it's queued for its next turn, or it's durably boarded for a parked/offline manager (Loom auto-wakes it) — all safe; only `dropped` means it reached nobody. The report is durably recorded the instant you call this tool, independent of delivery; `queued`/`boarded` survive a daemon restart (boot-reconcile redrives them), so do NOT re-send an already-reported status just because a restart hit before you saw it confirmed live. `noChanges` is an OPTIONAL flag on a `done` report for a LEGITIMATE no-op — you reviewed only, investigated and found nothing to change, or your deliverable lives outside this repo (e.g. a mockup) — where the CORRECT outcome is 0 commits. Set it and a 0-commit done skips the 'you likely forgot to commit' warning and auto-retires your session cleanly (frees your manager's concurrency slot, no worker_stop needed). Without it a 0-commit done still warns, so set it only when the no-op is intentional. `noChanges:true` is REFUSED (task stays in_progress, verified commit count named) when your assigned branch actually carries commits ahead of base; drop it and report the work honestly, or explain the discrepancy, then re-report. `awaiting` is an OPTIONAL hint on a `progress` report that says WHY you go idle: pass `\"background\"` when you're parking on a backgrounded command/sub-agent whose completion will bring you back — the daemon cannot see an in-flight background shell, so without it the `[loom:worker-idle]` watchdog assumes you await your manager's reply and invites a `worker_message` that would double-dispatch onto your still-running work. Omit it (or pass `\"manager\"`, the default) for a real checkpoint awaiting your manager's decision. Only meaningful on `progress`: `blocked` already means awaiting your manager and `done` means awaiting merge review, so don't set it on either.",
          inputSchema: strictShape({
            status: z.enum(["done", "blocked", "progress"]),
            summary: z.string(),
            prUrl: z.string().optional(),
            needs: z.string().optional(),
            noChanges: z.boolean().optional(),
            awaiting: z.enum(["manager", "background"]).optional(),
          }),
        },
        async ({ status, summary, prUrl, needs, noChanges, awaiting }) =>
          // Card 8d158088: attribute-and-ALWAYS-ALLOW, never refuse — worker_report is a worker's ONLY
          // channel up, so a wrongful refusal (or a refusal on the fail-open unknown/ambiguous states)
          // would strand it with no way to report at all, strictly worse than letting a sub-agent's call
          // through. The attribution (when confirmed-subagent) rides the durable report record instead —
          // see sessions.workerReport's own doc for where the manager actually sees it.
          ok(await sessions.workerReport(sessionId, { status, summary, prUrl, needs, noChanges, awaiting, subagentAttribution: attributions?.get("worker_report") })),
      );
      // run_gate (card 7f96aa09 — structural fix B for d5c5ccdf): run THIS gate through the daemon's
      // GateSemaphore instead of a raw Bash self-check, so N parallel workers can't structurally exceed
      // the total-lane budget. No args — it always runs YOUR OWN project's configured gateCommand in
      // YOUR OWN worktree; server-derived from your session id, never a param (mirrors worker_report).
      // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
      // text (an end-user agent can't resolve a card/decision id):
      // @decision a16c580b — outputFile is the cross-project-redaction wrapper's own full-output path.
      //
      // @decision a0d912f5 — a genuinely-admitted, worktree-moved op's re-attach is refused, not joined.
      //
      // The COST MODEL / merge-time reuse mechanism (card e50600d2, its false-claim correction card
      // b3c04b89): docs/adr/e50600d2-keep-run-gate-for-workers-and-lean-on-reuse.md. failingTestCount's
      // "floor, not a complete account" semantics (card 8fb09f4c): sessions/service.ts's own comments.
      server.registerTool(
        "run_gate",
        {
          description:
            "Run this project's build/DoD gate (the SAME `gateCommand` the merge gate itself runs, in YOUR " +
            "OWN worktree) as your DoD self-check — daemon-mediated and admitted through the SAME " +
            "GateSemaphore/`maxConcurrentGates` budget the merge/deploy gates already share, instead of an " +
            "unbounded raw-Bash self-check. Prefer this over running the gate yourself via Bash: it structurally " +
            "bounds total concurrent test-lanes across every worker + merge/deploy gate on the daemon (it also " +
            "pins LOOM_GATE_TEST_CONCURRENCY=3 on the spawned child, matching the merge gate's parallelism, so " +
            "don't set that env var yourself). " +
            "It shares one budget with merge/deploy gates, so on a busy fleet this call MAY queue behind another " +
            "in-flight gate before starting — expected, not a hang. " +
            "COST MODEL: a green self-check here CAN be reused and skip the merge gate's own re-run, IF at merge " +
            "time your branch is `freshBehindMain === 0` against main's then-current HEAD AND your worktree is " +
            "clean with no drift since this self-check settled (both re-derived fresh at merge time). THE FORFEIT " +
            "CONDITION IS YOUR OWN BRANCH FALLING BEHIND MAIN BETWEEN THIS SELF-CHECK AND YOUR MERGE, NOT A BUSY " +
            "GATE LANE: a saturated `maxConcurrentGates` does NOT by itself defeat reuse. Decision rule: the " +
            "self-check pays for itself when your branch is current with main and likely to STAY current until " +
            "you request merge, however busy `gate_queue` looks; it is wasted (~2 full gate runs) only when main " +
            "moves under your branch in that window, e.g. sibling branches landing while you wait. " +
            "`worker_merge_confirm`'s OWN re-call verdict cache is a SEPARATE mechanism (repeated confirms on the " +
            "SAME branch, not a prior run_gate), likewise defeated when the branch was behind main at admission; " +
            "see that tool's description and its `supersededBy` signal. " +
            "Returns {ran:false, " +
            "reason} if this project has no gateCommand configured at all — fall back to running your own " +
            "build/test command directly (still pin LOOM_GATE_TEST_CONCURRENCY=1 yourself in that case). Otherwise " +
            "returns {ran:true, passed, validatedHead, durationMs?, headCurrent?, headWarning?, steps?, " +
            "outputTail?, outputFile?, gateDetail?}. " +
            "`validatedHead` is stamped when this run was ISSUED, before it is admitted past the queue, NOT when " +
            "the command starts. Read `headCurrent` on EVERY settled result, pass or fail: `true` means " +
            "`validatedHead` is still your branch HEAD at settle time. `false` always comes with `headWarning` " +
            "saying WHICH of two shapes it is, and they call for DIFFERENT responses: a tree that moved during " +
            "the QUEUE WAIT was still fully present in what got built and tested (the sha just understates it; " +
            "trust the result); a tree that moved WHILE the command was RUNNING is genuinely unverified (possibly " +
            "an inconsistent mix of old and new files; don't trust it for your current code). Don't guess from " +
            "`validatedHead` alone. `durationMs` is wall-clock from admission past the semaphore to settle: the " +
            "trustworthy timing number to use instead of hand-running the suite (which opts out of the " +
            "concurrency cap). It EXCLUDES queue wait but NOT host/fleet load, nor time alongside another " +
            "concurrently-admitted gate when `maxConcurrentGates` is above 1: a real duration under real fleet " +
            "conditions, not an isolated benchmark. `durationMs`, `headCurrent` and `headWarning` are omitted on " +
            "the circuit-breaker short-circuit path, where no gate ran. `steps` (per-step {step, durationMs, " +
            "status}, diagnostic only — never compare against a threshold or each other) and a bounded " +
            "`outputTail` are set on EVERY `ran:true` result, PASS INCLUDED. `outputFile`, present alongside " +
            "`outputTail` whenever anything was captured, is an absolute path to the FULL captured output (also " +
            "re-readable later via `gate_status(opId)`) for when `outputTail`'s ~4KB/~16KB bound cut the " +
            "diagnostic mid-line. On a failure, gateDetail ADDITIONALLY " +
            "carries {phase, failedStep, failingTest, failingTestCount, " +
            "failingTestReason, stderrTail, exitCode, signal, timedOut} to tell a real test failure from a flake " +
            "without re-running blind. `failingTest` is `undefined` (never a guessed name) only when nothing " +
            "recognizable was found, and failingTestReason then says why (`stderrTail` is the same string as the " +
            "top-level `outputTail`). `failingTestCount` is how many lines matched that SAME winning tier " +
            "(`undefined` iff `failingTest` is): `1` means `failingTest` is a complete account; `>1` means it is " +
            "only the LAST of several and the rest go unnamed. NEVER size a fix from `failingTest` alone when the " +
            "count reads `>1` — run the file and enumerate; even at `1`, confirm. " +
            "The async [loom:gate-failed] nudge carries this SAME phase/failedStep/failingTest detail, and the " +
            "[loom:gate-done] PASS nudge states its duration and the per-step line (never the raw output tail); " +
            "both inline `headWarning` when set. If you missed a nudge, `gate_status(opId)` on a SETTLED op " +
            "returns the SAME verdict (passed/reason/durationMs/steps/outputTail/gateDetail): a recovery path, " +
            "not a substitute for waiting on the nudge. " +
            "CLIENT-TIMEOUT RESILIENT, same shape as worker_merge_confirm: a fast run returns the full " +
            "result inline (stamped with a correlation `opId`); a slow one instead returns " +
            "{opId, status:\"pending\", attachedToInFlight, staleAgainstWorktree}. " +
            "DO NOT POLL OR RE-CALL TO FETCH THE RESULT — worker_report progress with awaiting:\"background\" " +
            "and END YOUR TURN; the [loom:gate-done]/[loom:gate-failed] nudge (carrying this SAME opId) starts " +
            "your next turn with the result. A re-call is still safe, just not how you fetch a result: while the " +
            "gate is running it attaches to that SAME run (attachedToInFlight:true), and " +
            "`staleAgainstWorktree:true` means the worktree changed (a new commit or an uncommitted edit) since " +
            "THAT run started, so trust nothing it reports about your current code. Within a short grace window " +
            "AFTER a run settles, a re-call is USUALLY served that SAME settled result (same opId), EXCEPT when it " +
            "already carries `headCurrent:false`: a KNOWN-CONTAMINATED result is never re-served and a re-call " +
            "starts a genuinely new run. A settled-window reply is NOT re-checked against your worktree: a changed " +
            "commit shows as `validatedHead` differing from your HEAD, but an UNCOMMITTED edit made after a clean " +
            "settle is invisible to it, so if you've edited since the last run, don't trust a cached pass. " +
            "STALE RE-ATTACH IS REFUSED, NOT JOINED: a re-call that would attach to an in-flight op already known " +
            "to be GENUINELY ADMITTED (past the gate cap, not merely queued; a commit made while it was only " +
            "queued is harmless) and running against a worktree that has moved SINCE admission is refused: " +
            "{status:\"refused\", action:\"stale-attached\", opId, canCancel:true, note}. " +
            "`gate_cancel` is on YOUR OWN tool surface too — cancel that opId, then re-fire run_gate against your " +
            "current tree. `force:true` opts back into attaching anyway (e.g. to let the stale run finish rather " +
            "than pay for a fresh one); it has no effect unless there is a stale, admitted in-flight op, and is " +
            "always safe to pass.",
          inputSchema: strictShape({ force: z.boolean().optional() }),
        },
        async ({ force }) => {
          try {
            const r = await sessions.runWorkerGate(sessionId, { force });
            if ("refused" in r && r.refused) {
              return ok({
                status: "refused", action: "stale-attached", opId: r.op.opId, canCancel: true,
                note: `an earlier run_gate (${r.op.opId}) is genuinely ADMITTED and running, but the worktree fingerprint has changed since it was admitted (not merely while it was queued — that case is harmless and never refused), so its eventual result would not reliably describe your current code. Refused rather than attaching you to a result you'd have to discard. Cancel it yourself with gate_cancel(opId:"${r.op.opId}"), then re-fire run_gate against your current tree — or pass force:true here to attach to it anyway.`,
              });
            }
            if (!r.settled) {
              // ADDRESSED DIRECTIVE, NOT A PASSIVE NOTICE (card cfd11b13): a live specimen (worker
              // `684ff2c2`) read a bare `staleAgainstWorktree:true` WARNING correctly — it declined to
              // trust the attached result — but its only stated next step was to WAIT for the stale op to
              // settle on its own, holding one of only two daemon-global gate lanes for ~18 minutes. The
              // gap wasn't the detector; it was that NOTHING told the worker how to actually resolve it.
              // Card a0d912f5 closed that gap two ways: (1) the pre-emptive refusal above now catches this
              // exact shape BEFORE it ever reaches here for a plain re-call (no `force`) — this branch is
              // now only reached by the ORIGINATING call degrading past its own sync budget (nothing to
              // refuse — there's no earlier op to refuse attaching to, THIS call minted it) or by an
              // explicit `force:true` re-attach; and (2) `gate_cancel` is now on the WORKER's own tool
              // surface (see the `role === "worker"` branch above) — no manager round-trip needed either way.
              const note = r.staleAgainstWorktree
                ? `gate still running, but staleAgainstWorktree is true — your worktree has changed (a new commit or an uncommitted edit) since THIS run started, so do not trust its outcome for your current code. You can cancel it yourself: gate_cancel(opId:"${r.op.opId}"). Then re-fire run_gate against your current tree, or worker_report progress/blocked naming that opId if you'd rather let it finish first. Do not poll or re-call run_gate to fetch its result.`
                : `gate still running. Do NOT poll or re-call to fetch the result — worker_report progress with awaiting:"background" and END your turn; the [loom:gate-done]/[loom:gate-failed] nudge starts your next turn with the result.`;
              return ok({
                opId: r.op.opId, status: "pending", attachedToInFlight: r.attachedToInFlight, staleAgainstWorktree: r.staleAgainstWorktree,
                note,
              });
            }
            if (!r.ok) return ok({ error: r.error instanceof Error ? r.error.message : String(r.error) });
            return ok(r.value);
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );
      // gate_cancel (card a0d912f5): the WORKER-scoped half of the manager's own gate_cancel tool
      // (registered separately below, in the `role === "manager"` surface) — this closes the exact gap
      // named in run_gate's own doc above: a worker whose re-attach was refused as stale-attached used to
      // have no local remedy at all ("gate_cancel is manager-only — never registered on this role's own
      // tool surface", per the comment this card's fix superseded). Cancellable ONLY the caller's OWN
      // `run_gate` self-check (gateType "worker", sessionId === this worker) — SessionService.cancelGateOp
      // enforces this via `restrictToOwnerSessionId` (see that method's own doc for why gateType is part
      // of the check, not just sessionId: a "merge" gate op happens to be stamped with the SAME worker
      // sessionId, since it shares that worker's worktree key — without the gateType conjunct a worker
      // could accidentally cancel its OWN merge gate, a manager decision, never the worker's). A merge or
      // deploy op, or another session's op, is refused exactly like a cross-project attempt — see the
      // manager tool's own description for the full outcome vocabulary (cancelled/refused/not_found/
      // ambiguous/not_cancelled); this tool shares that SAME return shape and SAME cancellation mechanics,
      // just pre-scoped to "your own run_gate self-check" before either ever touches the semaphore.
      server.registerTool(
        "gate_cancel",
        {
          description:
            "Cancel YOUR OWN `run_gate` self-check, by the `opId` a `run_gate` pending/refused response or " +
            "`gate_queue` entry already named (full id or an unambiguous prefix). Scoped to ops YOU OWN — " +
            "your own worker self-check (gateType `worker`), queued or running — never a merge/deploy gate " +
            "or another session's op, which are refused exactly like a cross-project attempt. " +
            "Returns {outcome:\"cancelled\", phase:\"queued\"|\"running\", opId, gateType:\"worker\"} on " +
            "success — the op settles as a distinct `cancelled` outcome, never a failure, and you get the " +
            "`[loom:gate-cancelled]` nudge. " +
            "{outcome:\"refused\", reason} covers another project's op, a merge/deploy gate, or another " +
            "session's op. {outcome:\"not_found\"} means nothing LIVE matches (already settled — check the " +
            "nudge — or never existed). {outcome:\"ambiguous\", reason}: your opId prefix matches several of " +
            "your project's ops — pass more characters. {outcome:\"not_cancelled\", reason} covers a race with " +
            "natural completion, or a RUNNING self-check whose kill wasn't verified dead within a bounded window " +
            "(the run continues under its own timeout; the slot stays held). " +
            "`intent`/`reason` (both optional) are rendered into this call's return text AND your settled op's " +
            "`reason`, which your `[loom:gate-cancelled]` nudge reads out. " +
            "`intent` is a one-word next-step signal: `refire-when-clear`, `hold-for-instructions` (wait for " +
            "direction before re-firing), or `superseded` (a newer run replaces this one). `reason` is free text " +
            "for what the intent doesn't say.",
          inputSchema: strictShape({
            opId: z.string(),
            intent: z.enum(["refire-when-clear", "hold-for-instructions", "superseded"]).optional(),
            reason: z.string().optional(),
          }),
        },
        async ({ opId, intent, reason }) => {
          try {
            return ok(await sessions.cancelGateOp(sessionId, opId, { scope: { kind: "own", sessionId }, intent, reason }));
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );
      // gate_status (card fc243a43): a worker's ONLY instrument for "is my run_gate op alive?" used to be
      // re-calling run_gate itself — which is ALSO an action (it can attach to the in-flight op and return
      // staleAgainstWorktree, a result the caller must discard) and exposes no `elapsedMs`. This is the
      // read-only complement: SCOPED to this session's own ops (registerGateStatus's `scopeSessionId` AND,
      // since card e3e40167 added the durable-tombstone fallback, `scopeProjectId` too), so a worker can
      // check queued/running/settled/elapsed without starting anything and cannot probe another session's
      // run at EITHER the live-registry or tombstone layer.
      registerGateStatus(server, sessions, db, sessionId, () => db.getSession(sessionId)?.projectId);
      // gate_queue (card d04f9c76 — Codescape platform relay: a manager told a worker "confirm a lane is
      // free before firing", but the worker had no daemon-wide view of the shared gate cap and could only
      // ever fire `run_gate` blind). Same tool, same privacy shape as the manager's own — see
      // registerGateQueue's doc: redaction is keyed off the CALLER'S PROJECT (derived server-side from
      // `sessionId`), never the caller's role, so a worker sees exactly the same cross-project redaction a
      // manager on this project would, nothing more.
      registerGateQueue(server, sessions, db, sessionId);
      // directive_status (card 35c96aa6): the RECIPIENT half of the idempotency-key argument card
      // 3c712d4e built the SENDER half of. A worker that receives a `[loom:possible-duplicate root:…]`
      // tag (card 78e4b3f2) previously had only that visible marker to notice — an attention-dependent
      // fix for an attention-failure problem. This gives a mechanical answer instead, read from the SAME
      // durable event history `staleDirectiveProjection` already uses for the manager side (never
      // transcript text). `root` is OPTIONAL and deliberately so (CR follow-up on this card's own design
      // checkpoint): a REQUIRED root would still depend on the worker noticing the tag to call this at
      // all, inheriting that exact failure rate — omitting it lets a worker call this as a standing habit
      // at the start of any turn, not only when it happens to spot a marker.
      // @decision 78e4b3f2 — the `[loom:possible-duplicate root:XXXXXXXX]` tag marks only a redelivery.
      server.registerTool(
        "directive_status",
        {
          description:
            "Read your OWN durable delivery history — the mechanical complement to the visible " +
            "`[loom:possible-duplicate root:XXXXXXXX]` tag. Scoped server-side to YOUR session only (no " +
            "session/worker parameter): your own recycle lineage (this session plus any predecessor it was " +
            "recycled from), never another worker, another project, or message TEXT. " +
            "Call with NO argument for your most recent deliveries across every root in your lineage (the 20 most " +
            "recent; `truncated:true` means older ones exist — pass `root` for one label's full history), or " +
            "with `root` = the exact 8 lowercase-hex characters copied verbatim from a duplicate-tag. " +
            "A malformed `root` returns `{error}`, distinguishable from a well-formed root with zero matches. " +
            "Returns `{deliveries, deliveryCount, currentTurnSeq, truncated}`. Each entry is a DURABLE, " +
            "TURN-CONFIRMED hand-off (never a merely-queued or parked attempt) with: `root` (the label it " +
            "matched); `at` (when recorded); `msgId` (the id of the specific hop that delivered — NOT necessarily " +
            "the id in the tag you saw, which names the CHAIN's root); `turnSeq`; `fromSession` (who SENT it — a " +
            "manager, another session, or empty for a system-originated redirect); `receivedBy` (which session " +
            "in YOUR lineage took it — a value other than your current session id means a predecessor you were " +
            "recycled from received it, still part of your history). " +
            "HAVE-I-SEEN-THIS-BEFORE: `turnSeq < currentTurnSeq` means that delivery happened in an EARLIER turn. " +
            "`turnSeq` is `null` on a `confirmed-after-park` entry (Loom's retry budget gave up before a clean " +
            "stamp, and a late signal proved the engine ran it anyway): still a genuine delivery, but the " +
            "comparison doesn't apply; treat it as evidence you may have seen the content, not proof of an " +
            "earlier turn. `deliveryCount === 0` is a legitimate answer: Loom's history shows this content never " +
            "reached any of your turns, so the 'possible duplicate' framing was a false alarm. " +
            "KNOWN LIMITATION: matching is by the 8-character label, so an extremely rare collision could merge " +
            "two unrelated messages' history. " +
            "THE ONE THING THIS CANNOT TELL YOU: whether you ACTED on a prior delivery, only that the text " +
            "reached one of your turns. Use your own transcript/memory for that.",
          inputSchema: strictShape({ root: z.string().optional() }),
        },
        async ({ root }) => {
          if (root !== undefined && !/^[0-9a-f]{8}$/i.test(root)) {
            return ok({ error: "not a valid root label — expected exactly 8 lowercase hex characters, copied verbatim from a [loom:possible-duplicate root:XXXXXXXX] tag" });
          }
          const result = directiveDeliveriesForCaller(db, sessionId, root?.toLowerCase());
          return ok({ ...result, deliveryCount: result.deliveries.length });
        },
      );
      // The worker's tested depth-1 surface is now EXACTLY { directive_status, gate_cancel, gate_queue,
      // gate_status, my_context, run_gate, worker_report } (card a0d912f5 added gate_cancel) —
      // my-context-gate.mjs, idle-report.mjs, inbox-pull.mjs, gate-queue.mjs, mgmt-surface.mjs, and
      // (indirectly, via ORCH_WORKER_TOOLS in agents/promptLint.ts) orch-scope.mjs all pin this sorted
      // list; update ALL of them if this surface ever changes again.
      return server;
    }

    // role === "manager": the full coordination surface.
    const managerSessionId = sessionId;

    // Conditional-registration gates (card 60d0fca2 — trim the always-on manager floor): read the SAME
    // underlying data the gated tool's own execution relies on (`project_links` for peer_*, the resolved
    // config for deploy), via `db` directly rather than through `sessions` — buildServer must stay
    // callable with a bare service/db stub (several hermetic tests — my-context-gate.mjs's SURFACE test,
    // companion-loop.mjs's Part C — build a router with `{}` for db and/or sessions just to introspect
    // tool registration/schemas; buildServer must never throw just to decide what to register). So the
    // tool list is never stale relative to what actually runs. buildServer is already rebuilt fresh per
    // HTTP request (see handle() below, "no cached transport"), so a link/deployCommand added later is
    // picked up on the manager's very next tool call — no respawn needed.
    let hasPeerLinks = false;
    let deployCommandConfigured = false;
    try {
      const managerProjectId = db.getSession(managerSessionId)?.projectId;
      if (managerProjectId) {
        hasPeerLinks = db.listProjectLinks().some((l) => l.projectAId === managerProjectId || l.projectBId === managerProjectId);
        const project = db.getProject(managerProjectId);
        if (project) deployCommandConfigured = !!resolveConfig(project.config, db.getPlatformConfig()).orchestration.deployCommand;
      }
    } catch {
      // A stub db (see above) — degrade to "no peer links / no deployCommand configured" rather than
      // throw. A real Db never throws here.
    }

    this.registerMyContext(server, sessionId);

    // @decision 6641c3ab — never derive `awaitingReview` from "is the last event of any kind a
    // worker_report" — that false-negatives the instant ANY later worker-keyed row lands (e.g. a manager
    // merely reviewing the diff via `worker_merge`), even on a live, unmerged, never-messaged worker.
    const reportedProjection = (workerSessionId: string, pendingMerge: PendingOpView | null): {
      reportedState: "done" | "blocked" | null;
      awaitingReview: boolean;
      staleReport: { reportedAt: string; managerTurnsSinceReport: number } | null;
    } => {
      const events = db.listEventsForWorker(workerSessionId); // chronological (ts, rowid)
      const { reportedState, awaitingReview, reportEvent } = deriveAwaitingReview(events);
      if (!awaitingReview || !reportEvent) return { reportedState: null, awaitingReview: false, staleReport: null };
      let staleReport: { reportedAt: string; managerTurnsSinceReport: number } | null = null;
      const stampedAt = reportEvent.detail?.managerTurnSeqAtReport as number | undefined;
      if (stampedAt !== undefined && pendingMerge?.state !== "running") {
        const managerNowTurnSeq = db.getSession(managerSessionId)?.turnSeq ?? stampedAt;
        const turnsSinceReport = managerNowTurnSeq - stampedAt;
        if (turnsSinceReport >= STALE_REPORT_TURN_THRESHOLD) {
          staleReport = { reportedAt: reportEvent.ts, managerTurnsSinceReport: turnsSinceReport };
        }
      }
      return { reportedState, awaitingReview: true, staleReport };
    };

    // @decision 343441bd — never add a watchdog nudge on top of this signal; it is a deliberate PULL-only
    // read a manager makes on `worker_list`/`worker_status` — a nudge class was already tried and
    // retracted (`a4bfe6d9`→`8e0bd254`).

    // CR follow-up [2] (card 9da2a435): `directive` is the raw discriminator a manager can read
    // directly — "none" (never messaged) / "pending" (queued or mid give-up-retry, not yet resolved
    // either way) / "delivered" / "parked" / "confirmed-after-park" (card 3c712d4e) — always keyed to the
    // ROOT msgId the manager actually got back from its own worker_message OR worker_redirect call,
    // whichever is MOST RECENT (card 0fbb0507 widened this from worker_message-only; a mid-chain remint id
    // was never handed to the manager and would be meaningless to correlate against).
    // `staleDirective`/`parkedDirective` stay as derived ALARM flags layered on top (a manager scanning
    // worker_list for problems shouldn't have to branch on `directive` itself) — `directive` closes the
    // specific gap CR finding [2] named: without it, "never messaged" and "delivered, freshly, no problem"
    // were byte-identical (`{staleDirective:null, parkedDirective:null}`).
    const staleDirectiveProjection = (
      workerSessionId: string, currentTurnSeq: number,
    ): {
      directive: { msgId: string | null; state: "none" | "pending" | "delivered" | "parked" | "confirmed-after-park"; at: string | null };
      staleDirective: { msgId: string; deliveredAt: string; turnsSinceDelivery: number } | null;
      parkedDirective: { msgId: string; parkedAt: string } | null;
    } => {
      // Card 3c39be30: built via workerDirectiveStream — the constructor resolveDirectiveOutcome (called
      // below) now requires, see that function's own doc for the precondition this satisfies.
      const events = workerDirectiveStream(db, workerSessionId);
      // Card 0fbb0507: widens the "latest directive" scan from `message_worker` ONLY to `message_worker`
      // OR `redirect_worker` — `worker_redirect` routes through the SAME enqueueDurableMessage/enqueueStdin
      // path and can park exactly the same way, but a parked redirect used to surface NOTHING here (this
      // scan never even looked at redirect_worker events). PRECEDENCE, decided here: whichever of the two
      // kinds happened MOST RECENTLY (by ts) is the ONE tracked directive — never both at once. This is not
      // a new rule invented for redirects; it's the SAME "latest wins" precedent this scan already applied
      // within a single kind (see the (i)/(k2) cases in stale-directive-projection.mjs), just no longer
      // blind to the other kind. It also matches the actual runtime mechanics: `deliverRedirect` FLUSHES
      // and SUPERSEDES any message queued for the worker before its own redirect enqueues (see that
      // method's own doc), so a redirect always wins over an outstanding queued message at the moment it's
      // sent; the reverse (a plain worker_message sent after an outstanding — even parked — redirect) has no
      // such flush, but "latest wins" still gives the newer message_worker the tracked slot, which is the
      // only way `parkedDirective` was ever documented to clear (see the "sticky ... clears via a NEWER
      // message_worker" comment below, now read as "a newer directive of either kind").
      let directiveEvent: (typeof events)[number] | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.kind === "message_worker" || events[i]?.kind === "redirect_worker") { directiveEvent = events[i]; break; }
      }
      if (!directiveEvent) {
        return { directive: { msgId: null, state: "none", at: null }, staleDirective: null, parkedDirective: null };
      }
      // `message_worker` always stamps `detail.msgId` (even on immediate delivery — see messageWorker's own
      // doc). `redirect_worker` stamps the SAME correlatable id (`detail.queuedMsgId`, card 02621025) on
      // BOTH paths as of card 99339bcd — previously HELD-only, leaving an immediately-delivered redirect
      // (`delivered:true`, worker was idle) with nothing to walk a give-up/park chain against; `deliverRedirect`
      // (sessions/service.ts) now also stamps `turnSeqAtDelivery` on that same event when delivered, mirroring
      // messageWorker's own immediate-path stamp, so the walk below resolves an immediate redirect to
      // `"delivered"` on success and to `"parked"`/`"pending"` exactly like a held one when its hand-off
      // silently gives up.
      const rootMsgId = (
        directiveEvent.kind === "message_worker" ? directiveEvent.detail?.msgId : directiveEvent.detail?.queuedMsgId
      ) as string | undefined;
      if (!rootMsgId) {
        // Defensive only, post-99339bcd: production always mints and stamps a msgId on every fresh
        // message_worker/redirect_worker event now, on every path. This still guards a malformed record
        // (mirrors the pre-widening guard this replaces) and any PRE-FIX `redirect_worker` row already
        // persisted before this card's stamp landed — the DB is never migrated, so an old
        // immediately-delivered redirect logged before this change keeps reading exactly as it did before
        // (a plain `"delivered"` with `msgId:null`, nothing to walk) rather than being retroactively
        // reinterpreted.
        return directiveEvent.kind === "redirect_worker"
          ? { directive: { msgId: null, state: "delivered", at: directiveEvent.ts }, staleDirective: null, parkedDirective: null }
          : { directive: { msgId: null, state: "none", at: null }, staleDirective: null, parkedDirective: null };
      }

      const outcome = resolveDirectiveOutcome(events, directiveEvent, rootMsgId);

      if (outcome.state === "confirmed-after-park") {
        // Card 3c712d4e: the sender-visible THIRD state — distinguishes "Loom's own retry budget gave up,
        // but a late confirming hook proved the engine actually ran the turn" from a genuine "parked" that
        // stays ambiguous between still-queued-unread and truly-lost. Decidable by re-reading THIS SAME
        // worker_list/worker_status call at any later time, from the durable event history alone — never
        // dependent on the best-effort `[loom:redelivery-confirmed]` notice (handleGiveUpConfirmed) having
        // actually landed. `parkedDirective` is deliberately null here, NOT sticky like a genuine park —
        // this tool's own "RE-SEND" advice for a parked directive would manufacture a real duplicate of a
        // message that already landed if followed here.
        return {
          directive: { msgId: rootMsgId, state: "confirmed-after-park", at: outcome.confirmedAt },
          staleDirective: null,
          parkedDirective: null,
        };
      }
      if (outcome.state === "parked") {
        // CR follow-up [1] (card 9da2a435): STICKY, deliberately NOT cleared by a later worker_report.
        // The stale-delivered branch below treats a later report as an acknowledgement because the text
        // genuinely reached the worker — but a PARKED directive's text never reached it, so no report the
        // worker emits (about work it was already doing, or anything else) can possibly be an
        // acknowledgement of THIS directive; the two branches have opposite epistemics, not a shared rule.
        // It clears the way it honestly can while it STAYS parked: a NEWER message_worker OR worker_redirect
        // becomes the tracked directive (see the "latest wins across kinds" scan above) and this chain is
        // never walked again. Card 3c712d4e correction: that is no longer the ONLY way it clears — a later
        // `confirmed-after-park` event for this SAME msgId resolves it outright (see the branch above,
        // checked first); this branch is only ever reached when no such confirmation has arrived (yet).
        return {
          directive: { msgId: rootMsgId, state: "parked", at: outcome.parkedAt },
          staleDirective: null,
          parkedDirective: { msgId: rootMsgId, parkedAt: outcome.parkedAt },
        };
      }
      if (outcome.state === "pending") {
        // CR follow-up [7] (card 9da2a435): intentionally NO staleDirective/parkedDirective signal here —
        // accepted, not an oversight. The window is bounded (SUBMIT_MAX_ATTEMPTS's own retry cycle, then
        // GIVE_UP_HOLD_MS, then the reconcile tick), and letting it resolve into a clean parked/delivered
        // read is worth more than a transient mid-retry alarm that would just flap while Loom is still
        // working the redelivery on its own.
        return { directive: { msgId: rootMsgId, state: "pending", at: directiveEvent.ts }, staleDirective: null, parkedDirective: null };
      }

      const { deliveredAt, turnSeqAtDelivery } = outcome;
      const directive = { msgId: rootMsgId, state: "delivered" as const, at: deliveredAt };
      // Card bcdea586 (swept, deliberately NOT fixed): `e.ts > deliveredAt` is a raw ts comparison, same
      // class as the tie e2b6c434 proved elsewhere — a worker_report landing in the SAME millisecond as
      // delivery would read as unacknowledged. Direction is the opposite of e2b6c434 (and of this card's
      // sessions/service.ts sites): the failure mode is a FALSE "possibly stale directive" flag — an extra,
      // spurious nudge — never a suppressed/silently-dropped one. Left as-is.
      const acknowledged = events.some((e) => e.kind === "worker_report" && e.ts > deliveredAt);
      if (acknowledged) return { directive, staleDirective: null, parkedDirective: null };
      const turnsSinceDelivery = currentTurnSeq - turnSeqAtDelivery;
      if (turnsSinceDelivery < STALE_DIRECTIVE_TURN_THRESHOLD) return { directive, staleDirective: null, parkedDirective: null };
      // Reported against rootMsgId (never the resolved chain's current msgId) — the manager only ever saw
      // the ROOT msgId returned from its own worker_message call; a mid-chain remint id was never handed
      // to it and would be meaningless to correlate against.
      return { directive, staleDirective: { msgId: rootMsgId, deliveredAt, turnsSinceDelivery }, parkedDirective: null };
    };

    // Card ae0b7891: "archived without report" — the archived counterpart to reportedState's "awaiting
    // review" signal above. A worker whose pty exits without ever calling worker_report is archived by
    // archiveOnExit (sessions/service.ts) exactly like a worker that DID report and cleanly retired —
    // reportedState alone can't tell them apart (see reportedProjection's own freshness doc above: ANY
    // later event, including the noChanges auto-retire path's own bookkeeping stop_worker event, reads
    // reportedState back to null even after a genuine report). sessions.isArchivedWithoutReport reuses
    // notifyManagerOfExitedWorker's own gate instead (a durable worker_exited_without_report event,
    // written ONLY for a genuinely-unreported exit — never for an auto-retire's deliberate/`intended`
    // stop), re-checked live so it self-clears once the manager resolves it.
    const archivedWithoutReport = (workerSessionId: string): { archivedWithoutReport: boolean } => (
      { archivedWithoutReport: sessions.isArchivedWithoutReport(workerSessionId) }
    );

    // Card 93609ef3: a recycled SUCCESSOR manager (fresh sessionId via recycleManager) must still be able
    // to READ a worker its PREDECESSOR spawned — `recycleManager` only re-parents LIVE workers
    // (reparentLiveWorkers), so a worker that had already reported done/blocked/exited before the recycle
    // keeps `parentSessionId` pointing at the now-retired predecessor, and an exact-match guard locks the
    // successor out of exactly the findings it needs to act on. Scope READS by LINEAGE instead of exact
    // parent: walk both sessions' `recycledFrom` chains to their roots (the same `lineageRootId` helper the
    // Platform Lead resume-doc scoping already uses) and compare roots — same lineage ⇒ readable.
    const workerReadableByManager = (w: { parentSessionId?: string | null }): boolean => {
      if (!w.parentSessionId) return false;
      if (w.parentSessionId === managerSessionId) return true;
      const managerSession = db.getSession(managerSessionId);
      const parentSession = db.getSession(w.parentSessionId);
      if (!managerSession || !parentSession) return false;
      return lineageRootId(db, managerSession) === lineageRootId(db, parentSession);
    };

    // --- Fleet-lockout self-heal (P1: a manager locked out of its OWN live fleet) -------------------
    // SYMPTOM: worker_list returns a manager's workers (exact `parent_session_id` match, db.listWorkers),
    // but every per-id op (worker_status/worker_message/worker_redirect/worker_merge/...) rejected
    // "not your worker" — the WRITE ops (worker_stop/worker_message/worker_redirect/worker_set_mode/
    // worker_recycle/worker_merge/worker_merge_confirm, all via sessions.* in service.ts) do an EXACT
    // `worker.parentSessionId !== managerSessionId` check, unlike the lineage-tolerant read guard just
    // above. The ONLY previously-known recovery was a full daemon_restart (boot-reconcile's
    // reparentLiveWorkers, run only from recycleManager/boot — never on-demand for a LIVE manager whose
    // worker's parent_session_id has otherwise drifted from its own session id).
    //
    // Exact drift MECHANISM is still unconfirmed from source (see the worker task's write-up) — every
    // read of `sessionId` inside a single request is the same closure, and getSession/listWorkers are
    // uncached direct SQL, so the two guards SHOULD always agree from what's visible here. Ship the
    // self-heal as defense-in-depth regardless: it's cheap, safe (scoped to this manager's own lineage,
    // see workerReadableByManager above), and closes the "must restart the whole daemon" gap even if the
    // root cause turns out to be elsewhere (a race, a missed reparent on some other path, etc).
    //
    // FIX: before ANY per-id op reaches its exact-match guard, RE-DERIVE ownership by lineage (the same
    // tolerant check reads already use) and, if this manager's lineage genuinely owns the row but its
    // `parent_session_id` is stale, RELINK it in place (a scoped single-row update — never the bulk
    // process_state='live'-gated reparentLiveWorkers). The downstream exact-match guards in service.ts
    // are UNCHANGED — they still reject a non-owned worker exactly as before; this only ever repairs a
    // row this manager's OWN lineage already owns, so it can never grant access across managers/projects.
    // Logs the disagreement (op, worker id, both session ids) so a genuine repro finally pins the seam.
    // Every real caller below re-derives ownership itself (the exact-match `parentSessionId !==
    // managerSessionId` throw in each sessions.* method) — this helper never gates anything; it only
    // repairs the row before that independent check runs. Hence the name: self-heal, not a guard.
    // Card 164f7915: this is WHY the stale-parent/queued-self-check gap that card fixed (gating
    // confirmWorkerMergeTracked's supersedeQueuedSelfCheck call on isExactWorkerOwner) never surfaced via
    // `worker_merge_confirm` in production — this relink runs BEFORE that method is ever called, so its
    // exact-id check rarely has anything stale left to gate on for THIS entry point.
    // @decision 92c20eb9 — never relink a worker onto a caller superseded by recycle; it would undo
    // attemptManagerOwnershipTransfer's correct reparent onto the successor right before the caller is
    // hard-stopped, orphaning the worker from the successor's worker_list.
    const callerSupersededError = (): { error: string } | null => {
      if (!isSupersededByRecycle(db, managerSessionId)) return null;
      return { error: retiredCallerMessage(db, managerSessionId) };
    };

    const selfHealWorkerLink = (workerSessionId: string, op: string) => {
      const w = db.getSession(workerSessionId);
      if (!w || w.parentSessionId === managerSessionId) return w; // no row, or already correctly linked
      if (!workerReadableByManager(w)) return w; // genuinely not this manager's lineage — leave it to the "not your worker" guard
      if (callerSupersededError()) return w; // card 92c20eb9: never relink onto a retiring caller
      // @decision 92c20eb9 — never relink a worker AWAY from the caller's OWN successor, regardless of
      // supersession — a halted (genuinely not superseded, 386e4eb5) predecessor's own successor can
      // already own this worker too (halting only blocks RETIRING, not the reparent).
      const successor = db.getSuccessor(managerSessionId);
      if (successor && w.parentSessionId === successor.id) return w;
      console.warn(
        `[orchestration] worker/manager parent desync self-healed: op=${op} worker=${workerSessionId} ` +
        `managerSessionId(closure)=${managerSessionId} row.parentSessionId=${w.parentSessionId ?? "null"}`,
      );
      db.relinkWorkerToManager(w.id, managerSessionId);
      return { ...w, parentSessionId: managerSessionId };
    };

    // Card b4b246dd defect 2: a per-worker read tool used to collapse "no session row exists for this id
    // at all" and "a session row exists but belongs to someone else's lineage" into the SAME "not your
    // worker" message. `workerNotFoundHint` draws candidates ONLY from this manager's OWN scope — every
    // source below is already scoped to `managerSessionId`, so a match can never name another manager's
    // worker/op. Candidates: a live worker's own session id, its taskId, its in-flight merge opId, a
    // pending spawn's opId/taskId, a cap-queued entry's opId/taskId. An exact match always wins over a
    // prefix match; more than one DISTINCT hint of the same kind is ambiguous and refuses to guess
    // (`null`), mirroring `resolveIdPrefix`'s exact-wins/ambiguous-refuses semantics (id-prefix.ts) —
    // this can't reuse that helper directly since it scans several differently-shaped candidate pools
    // rather than one uniform list.
    const workerNotFoundHint = (ref: string): string | null => {
      if (ref.length < MIN_ID_PREFIX_LEN) return null;
      const hits: { exact: boolean; hint: string }[] = [];
      const add = (candidate: string | null | undefined, hint: string) => {
        if (!candidate) return;
        if (candidate === ref) hits.push({ exact: true, hint });
        else if (candidate.startsWith(ref)) hits.push({ exact: false, hint });
      };
      for (const w of db.listWorkers(managerSessionId)) {
        add(w.id, `did you mean worker session '${w.id}'?`);
        add(w.taskId, `did you mean worker '${w.id}', the session working on task '${w.taskId}'?`);
        const merge = sessions.peekPendingMerge(w);
        if (merge) add(merge.opId, `did you mean worker '${w.id}', which has an in-flight merge op '${merge.opId}'?`);
      }
      for (const op of sessions.listPendingSpawns(managerSessionId)) {
        const hint = op.taskId
          ? `task '${op.taskId}' has a spawn still in flight (op '${op.opId}') — poll worker_list for its workerSessionId once it's ready, there is no worker session id yet.`
          : `a taskless spawn is still in flight (op '${op.opId}') — poll worker_list for its workerSessionId once it's ready, there is no worker session id yet.`;
        add(op.opId, hint);
        add(op.taskId, hint);
      }
      for (const e of sessions.listCapQueuedSpawns(managerSessionId)) {
        const hint = e.taskId
          ? `task '${e.taskId}' is cap-queued (op '${e.opId}'), not spawned yet — there is no worker session id to use.`
          : `a taskless entry is cap-queued (op '${e.opId}'), not spawned yet — there is no worker session id to use.`;
        add(e.opId, hint);
        add(e.taskId, hint);
      }
      const exactHints = [...new Set(hits.filter((h) => h.exact).map((h) => h.hint))];
      if (exactHints.length === 1) return exactHints[0] ?? null;
      if (exactHints.length > 1) return null; // a genuine cross-pool collision — ambiguous, never guess
      const prefixHints = [...new Set(hits.map((h) => h.hint))]; // exactHints is empty here, so these are all prefix matches
      return prefixHints.length === 1 ? prefixHints[0] ?? null : null;
    };

    // Shared by worker_status/worker_transcript/worker_report_get (card b4b246dd defect 2) AND, since
    // card 03b0377e, the write tools worker_message/worker_stop/worker_redirect/worker_recycle/
    // worker_set_mode/worker_merge/worker_merge_confirm — the SAME split in one place so the
    // wording/logic can't drift across call sites. `w` is `selfHealWorkerLink`'s result: `undefined`
    // means no session row exists for `workerSessionId` at
    // all (genuinely unknown id); a defined-but-unreadable `w` means the row exists but belongs to a
    // different lineage (a REAL ownership mismatch) — these are DIFFERENT facts and must read differently.
    // (worker_revive is the one write tool deliberately left out — its own `reviveWorker` already makes
    // this exact split, in its own wording, and card 03b0377e's DoD left that alone rather than churn it.)
    const workerLookupError = (workerSessionId: string, w: Session | undefined): { error: string } => {
      if (w) return { error: "not your worker" };
      const hint = workerNotFoundHint(workerSessionId);
      return { error: `no such worker session '${workerSessionId}'${hint ? ` — ${hint}` : ""}` };
    };

    // The fleet view — the manager's direct children as a compact list. Shared by worker_list and the
    // no-arg worker_status call (a manager's reflexive `worker_status({})` aliases to this rather than
    // throwing a schema-validation error).
    // @decision fb8df559 — never read `pendingMerge.state:"running"` as "the gate is executing"; it flips
    // the instant the op is minted, well before admission. Represent a pending spawn as an additive
    // placeholder row, never a breaking change to worker_list's bare-array shape.
    //
    // @decision b16320bc — never treat a row with `busy:false` and no rate-limit context as proof a
    // worker is genuinely idle; check `rateLimitedUntil`/`rateLimitDeadline` first — a rate-limited park
    // reads identically to healthy idle without them.
    //
    // `lastEngineOutputAt`: an INTRA-TURN liveness signal, additive alongside the DB-persisted
    // `lastActivity` (which only moves at turn boundaries — hook events). Reads pty/host.ts's in-memory
    // `Live.lastOutputAt`, stamped on EVERY engine-output chunk (already fed to the busy-stale self-heal —
    // see healIfStuck) — so it keeps advancing THROUGH a single long turn and only goes stale once the
    // engine truly stops producing. Lets a manager tell "busy and emitting" (recent) from "silent, possibly
    // wedged" (stale) at a glance, without spending a worker_transcript pull.
    //
    // ⚠️ ON A `busy:true` ROW THIS IS ~NOW BY CONSTRUCTION, THEREFORE UNINFORMATIVE THERE — see
    // `PtyHost.getLastOutputAt`'s own doc (pty/host.ts) for the measured busy-vs-idle proof. Its actual
    // discriminating power lives entirely in the IDLE case (a STALE value on a row that isn't busy).
    //
    // @decision a1916267 — never widen `pty.getLastOutputAt` back to read every harness's live state; on
    // codex that resurrects a false "busy and emitting" reading driven by pure TUI repaint, worse than
    // the current absent (`null`) signal.
    //
    // WHAT IT DOES NOT PROVE: liveness is a property of the PROCESS, not the WORK — a retry loop, or a worker
    // re-reading the same file, moves this field identically to real progress. `lastActivity` advancing
    // (a turn boundary was crossed) is the strongest signal ON THIS ROW that an intra-turn wedge is ruled
    // out — a stuck turn cannot end — though a loop spanning several turns still crosses boundaries
    // normally, so it only clears the PREVIOUS turn, never vouches for the current one. Beyond the
    // control plane, actual progress shows up in the worker's own artifacts: a NAMED, distinct
    // deliverable is progress, the same shape repeated with only an index/timestamp changed is not; an
    // artifact whose existence presupposes an earlier phase succeeded is stronger evidence still (a loop
    // stuck before that phase structurally cannot produce it). Presence of such an artifact is strong
    // evidence; its ABSENCE is weak — a worker correctly converging toward a no-op result looks identical,
    // on this row, to one that's stuck, so never invert "no artifact yet" into "therefore stalled." And
    // any artifact is only evidence about the property it actually records — confirm it's downstream of
    // the thing being verified before trusting it.
    //
    // `undefined` (session not live in this process, e.g. exited/never spawned here) reads as `null`, same
    // as every other optional field on this row.
    //
    // `composerDirtyLen`: a PULL read of possibly-unsubmitted composer text, set synchronously at
    // give-up/heal-if-stuck.
    // @decision dcd8659c — never conflate `composerDirtyLen: 0` (measured clean) with `null` (session not
    // live in this process); treating an absent signal as a measured zero is the exact bug this closes.
    //
    // ⚠️ CONSERVATIVE reading only — cannot tell "a clear was attempted and failed" from "a clear worked
    // but hasn't confirmed yet"; read together with `composerDirtyLenBelieved`.
    // @decision c148f118 — never read `composerDirtyLen` alone as proof a clear-prefix failed; always pair
    // it with `composerDirtyLenBelieved`. Never reset the latter outside its three decisive-confirm sites.
    //
    // WHAT THIS DOES NOT COVER: a MANAGER's own composer going dirty mid-session (no third-party
    // read surface reaches a manager the way this reaches its workers — see `my_context`, which folds in
    // the same getter for self-checking), and a human glancing at the web UI (no REST/web surface exists
    // yet — unscoped, deliberately left as a follow-up card rather than bundled here).
    // @decision 008f33f1 — never read a `null` `gatePhase` as an error or "not in flight" — it just means
    // this disambiguation has nothing to add right now; check `pendingMerge.state` for in-flight status.
    const withGatePhase = (
      pm: (PendingOpView & { predecessorSessionId?: string }) | null,
    ): (PendingOpView & { predecessorSessionId?: string; gatePhase?: "queued" | "running" | null }) | null =>
      pm && pm.state === "running" ? { ...pm, gatePhase: sessions.gatePhaseForOpId(pm.opId) } : pm;

    // Card 31f3d047: a GENERIC, DERIVED view over the three named lastMismatch* pull-surfaces above — the
    // incident that motivated this card was a mismatch (an `[prompt-mismatch-unmatched-remainder]`
    // specimen — see `Live.lastMismatchUnmatched`'s own doc in pty/host.ts for what that broader
    // "unmatchable" population covers) that Loom classified correctly, in real time, but had NO worker_list/
    // worker_status projection for — `lastMismatchReplay`/`lastMismatchFusion` were both (correctly) null,
    // and a reader concluded "not detected" from "not a replay, not a fusion". Adding a THIRD stored field
    // for the unmatched class would only move the gap one class over — the same blind spot reappears for
    // whatever fourth class gets added next. This is DERIVED instead — computed at read time from the SAME
    // three getters already read below, never stored on `Live` itself — so "did any mismatch fire recently"
    // is answerable from ONE field without knowing every class name in advance, and covering a future
    // fourth named field only ever needs one line added to `candidates` here, not a new field threaded
    // through every worker_list/worker_status row shape.
    const deriveLastMismatch = (workerId: string): { kind: "replay" | "fusion" | "unmatched"; gen: number; at: number } | null => {
      if (!pty) return null;
      const replay = pty.getLastMismatchReplay(workerId);
      const fusion = pty.getLastMismatchFusion(workerId);
      const unmatched = pty.getLastMismatchUnmatched(workerId);
      const candidates: Array<{ kind: "replay" | "fusion" | "unmatched"; gen: number; at: number }> = [];
      if (replay) candidates.push({ kind: "replay", gen: replay.gen, at: replay.detectedAt });
      if (fusion) candidates.push({ kind: "fusion", gen: fusion.gen, at: fusion.detectedAt });
      if (unmatched) candidates.push({ kind: "unmatched", gen: unmatched.gen, at: unmatched.detectedAt });
      if (candidates.length === 0) return null;
      return candidates.reduce((latest, c) => (c.at > latest.at ? c : latest));
    };

    // @decision f797affb — never add a "likely lost"/"likely fine" verdict here; both readings are live
    // possibilities for the identical signature — flag the co-occurrence, never guess which is true. Never
    // shrink the correlation window assuming instant resolution; confirmation can lag minutes under load.
    const UNRESOLVED_CASCADE_WINDOW_MS = 10 * 60 * 1000;
    const deriveUnresolvedCascade = (
      parkedDirective: { msgId: string; parkedAt: string } | null,
      mismatch: { kind: "replay" | "fusion" | "unmatched"; gen: number; at: number } | null,
    ): { msgId: string; parkedAt: string; mismatchKind: "replay" | "fusion" | "unmatched"; mismatchAt: number; note: string } | null => {
      if (!parkedDirective || !mismatch) return null;
      const parkedAtMs = new Date(parkedDirective.parkedAt).getTime();
      if (Math.abs(mismatch.at - parkedAtMs) > UNRESOLVED_CASCADE_WINDOW_MS) return null;
      return {
        msgId: parkedDirective.msgId,
        parkedAt: parkedDirective.parkedAt,
        mismatchKind: mismatch.kind,
        mismatchAt: mismatch.at,
        // DoD-3: the disambiguation pointer travels WITH the flag, not in a separate doc a reader has to
        // already know to go find. DoD-4: never a refusal/block, never steers toward worker_stop/recycle —
        // bias toward waiting, name the one read that actually settles it.
        note: "UNRESOLVED — could not be determined whether this directive was lost or landed: Loom's own " +
          "redelivery budget for this message exhausted (parked, no individual CONFIRMED) with a " +
          "[prompt-mismatch] logged on this worker in the same window. This is NOT proof of either reading " +
          "— do not guess, and do not worker_stop/recycle on this alone. The one check that actually " +
          "settles it: read this worker's own transcript (worker_transcript) for a turn that acted on the " +
          "parked directive's content.",
      };
    };

    // Card e55371c1 — the path-keyed aliasing signal. `gen`/`recycledFrom` track RECYCLE CHAINS ONLY and
    // give NO evidence about worktree-path sharing (see db.listSessionsAtWorktreePath's own doc for the
    // mechanism); this is the real-property replacement. `null` when THIS row has no worktreePath of its
    // own yet (no worktree was ever created for it) — NOT DETERMINABLE, never a silent measured zero.
    // `0` means genuinely measured: this row's own worktreePath IS set and no other session row shares it.
    const worktreePathAliases = (worktreePath: string | null | undefined, selfId: string): number | null =>
      worktreePath ? db.listSessionsAtWorktreePath(worktreePath, selfId).length : null;

    // Card c8304714 fallout: guards the METHOD, not just `pty` itself — `pty?.` alone only protects
    // against `pty` being null/undefined, it does NOT protect against a present-but-PARTIAL pty stub
    // (several hermetic tests wire one, implementing only the getters their own scenario needs). A
    // real PtyHost always has this method; a hand-rolled test double may not, so `typeof` is checked
    // before calling rather than assuming its presence the way the sibling `pty?.getXxx(...)` reads do.
    // CONVENTION: guard every new `pty.<method>` call added to this file the same way — `typeof
    // pty?.<method> === "function"` — for the same reason (see the two below; card 0bf4c23c).
    const lastFlushAttribution = (workerId: string): { gen: number; attributable: boolean; reason: string; resolvedAt: number } | null =>
      typeof pty?.getLastFlushAttribution === "function" ? (pty.getLastFlushAttribution(workerId) ?? null) : null;

    // Card d8eaa381 (batch-gate finding): same METHOD guard as `lastFlushAttribution` above, for the
    // same reason — these two are new getters a real `PtyHost` always has, but a hermetic `pty` STUB
    // (several test files wire one implementing only the getters their own scenario needs) may not.
    const pendingQueueDepth = (workerId: string): number | null =>
      typeof pty?.getPendingQueueDepth === "function" ? (pty.getPendingQueueDepth(workerId) ?? null) : null;
    const currentTurnBusyForMs = (workerId: string): number | null =>
      typeof pty?.getCurrentTurnBusyForMs === "function" ? (pty.getCurrentTurnBusyForMs(workerId) ?? null) : null;

    // Card bba13405: same METHOD guard as `pendingQueueDepth`/`lastFlushAttribution` above — a real
    // `PtyHost` always has `getCodexBootStuck`, a hermetic stub built before this card may not.
    const codexBootStuck = (workerId: string): { at: number; timeoutMs: number; unmet: string[] } | null =>
      typeof pty?.getCodexBootStuck === "function" ? (pty.getCodexBootStuck(workerId) ?? null) : null;

    // @decision 8882e2ca — delegates to the shared predicate PLUS an extra filter (Code Review
    // 6a497b53's DECISION): non-null ONLY when the kickoff's own size earned an EXTENDED window
    // (`kickoffConfirmWindowMs(composerDirtyLen) > 0`) — an ordinary-sized kickoff reads null throughout.
    const kickoffConfirmPendingFor = (w: Pick<Session, "id" | "turnSeq">): { composerDirtyLen: number; windowMs: number } | null => {
      if (!pty) return null;
      const pending = withinKickoffConfirmWindow(pty, w.id, w.turnSeq);
      return pending && kickoffConfirmWindowMs(pending.composerDirtyLen) > 0 ? pending : null;
    };

    // @decision f8d53712 — never spread a raw `Session` row (`...w`) into a tool response; name every
    // returned field explicitly, so a future `Session` column can't reach an agent unreviewed.
    //
    // @decision 2961dd3b — never write this sentinel's values as the boolean literal; use the numeric `1`,
    // so this file's compiled output can't collide with `agent-runs-keys.mjs`'s G3 endpoint-flip scan.
    // @decision 08c81809 — reachedReadyAt is ALSO excluded: purely internal boot-reconcile machinery
    // (the durable settle-reconcile discriminator), never a field an agent-facing view should carry.
    // @decision 963462f5 — forcedPlain is excluded too, same posture: purely internal spawn machinery,
    // never a field an agent-facing view should carry.
    // @decision 0eaaa693 — cutBaseSha is excluded too, same posture: purely internal merge-safety
    // plumbing, never a field an agent-facing view should carry.
    // @decision aaacafe4 — reviewOfTaskId is excluded too, same posture: purely internal usage-
    // attribution plumbing (the usage sampler's own fallback), never a field an agent-facing view should carry.
    // @decision 2ef54430 — codexProvider is excluded too, same posture: the pinned endpoint is internal spawn
    // plumbing (a connection reference), never a field an agent-facing view should carry.
    const SESSION_ROW_FIELDS: Record<Exclude<keyof Session, "pendingMerge" | "reachedReadyAt" | "forcedPlain" | "cutBaseSha" | "reviewOfTaskId" | "codexProvider">, 1> = {
      id: 1, projectId: 1, agentId: 1, engineSessionId: 1, title: 1, cwd: 1, processState: 1,
      resumability: 1, busy: 1, createdAt: 1, lastActivity: 1, lastError: 1, role: 1,
      parentSessionId: 1, taskId: 1, worktreePath: 1, branch: 1, reviewBaseSha: 1, repoKey: 1,
      gen: 1, recycledFrom: 1, ctxInputTokens: 1, ctxTurns: 1, turnSeq: 1, ctxUpdatedAt: 1,
      model: 1, rateLimitedUntil: 1, rateLimitDeadline: 1, rateLimitBailedAt: 1, contextExhaustedAt: 1, browserTesting: 1, documentConversion: 1,
      restrictedTools: 1, noCommit: 1, skills: 1, connections: 1, vaultWrite: 1, companionLeadMode: 1,
      capabilities: 1, archivedAt: 1, scheduledSpawn: 1, harness: 1,
    };
    const SESSION_ROW_KEYS = Object.keys(SESSION_ROW_FIELDS) as (keyof Omit<Session, "pendingMerge" | "reachedReadyAt">)[];

    /** The wire-only shape `projectSessionRowFields` actually returns: identical to `Omit<Session,
     *  "pendingMerge" | "reachedReadyAt">` except `harness` is widened to include `null`, so an UNSET worker can be told
     *  apart from one explicitly holding the shipped default. This type exists ONLY for this
     *  projection's return value (never assigned back into a real `Session`, which stays
     *  `?: "claude" | "codex"` with no `null` member — see entityRowFields.ts's `ProfileWireView` for
     *  the identical shape on the Profile side). */
    type SessionWireView = Omit<Session, "pendingMerge" | "harness"> & { harness: "claude" | "codex" | null };

    // ONE list, not two: the sentinel's own keys ARE the field list this projects, so there is nothing to
    // keep in sync by hand. Behaviour-preserving against the prior object literal (same 39 keys) except
    // for card 41f35bfe's `harness` resolution below.
    // @decision 41f35bfe — never widen `Session` itself to carry `harness: null`; widen only this LOCAL,
    // wire-only view — `Session.harness` has no `null` member, and no Session UPDATE has a "leave as-is"
    // hazard the way `Profile.harness` does to justify touching the shared type.
    const projectSessionRowFields = (w: Session): SessionWireView => {
      const picked = pickKeys(w, SESSION_ROW_KEYS);
      return { ...picked, harness: picked.harness ?? null };
    };

    const fleetView = async () => {
      const workers = db.listWorkers(managerSessionId).map((w) => {
        const pendingMerge = withGatePhase(sessions.peekPendingMerge(w) ?? null);
        const mismatch = deriveLastMismatch(w.id);
        const directiveProjection = staleDirectiveProjection(w.id, w.turnSeq ?? 0);
        return {
          workerSessionId: w.id,
          taskId: w.taskId ?? null,
          processState: w.processState,
          busy: w.busy,
          branch: w.branch ?? null,
          ctxInputTokens: w.ctxInputTokens ?? null,
          // Card 808ee811: `ctxInputTokens` pre-divided by this worker's own model window — the SAME
          // null-vs-measured discipline (null exactly when ctxInputTokens is null, never a measured 0),
          // so a manager reads the recycle-relevant number directly instead of computing the ratio by
          // hand from ctxInputTokens+model. Null structurally for a codex-harness worker too (no
          // hook-based capture on that harness — see codex-adapter.ts's own doc).
          ctxPct: contextPercentFor(w.ctxInputTokens, w.model),
          // Card c5b234aa — see ctxMidTurnFields's own doc: tells a reader whether this ctxInputTokens
          // reading was taken DURING the turn that's still running (fresh) or carried over from before it
          // started (potentially stale — the exact gap card 8c7dfc65 exists to close).
          ...ctxMidTurnFields(w),
          // Card 5a8a74e1 — see contextTelemetryFor's own doc. `false` here is what makes a codex worker's
          // `ctxInputTokens`/`ctxPct`/`ctxTurns`/`model` null reads decidable as "never measurable on this
          // harness" instead of the ambiguous "not yet measured" a bare null (or `neverCompletedTurn`,
          // which is about TURN COUNT, not harness capability) would otherwise suggest.
          contextTelemetry: contextTelemetryFor(w.harness),
          neverCompletedTurn: (w.turnSeq ?? 0) === 0,
          model: w.model ?? null,
          lastActivity: w.lastActivity,
          lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
          composerDirtyLen: pty?.getComposerDirtyLen(w.id) ?? null,
          composerDirtyLenBelieved: pty?.getComposerDirtyLenBelieved(w.id) ?? null,
          unconfirmedDeliveryMs: pty?.getPendingConfirmMs(w.id) ?? null,
          // Card 8882e2ca — non-null only while this worker's turn-1 kickoff is unconfirmed AND still
          // inside its size-aware plausible-confirm window (see kickoffConfirmWindowMs's own doc); the
          // same predicate that softens the [loom:worker-spawn-broken] notice for a kickoff this size.
          kickoffConfirmPending: kickoffConfirmPendingFor(w),
          // Card d8eaa381: see pty.getPendingQueueDepth/getCurrentTurnBusyForMs's own doc comments for
          // the null-vs-measured discipline. `pendingQueueDepth` is AGNOSTIC (both harnesses);
          // `currentTurnBusyForMs` is CLAUDE-ONLY and reads null for a codex row, same convention as
          // `lastEngineOutputAt` (card a1916267).
          pendingQueueDepth: pendingQueueDepth(w.id),
          currentTurnBusyForMs: currentTurnBusyForMs(w.id),
          // Card bba13405: CODEX-ONLY (see pty.getCodexBootStuck's own doc) — non-null exactly while a
          // codex session's boot-readiness ceiling has fired and not yet been resolved by a late latch;
          // always null for a claude row, a codex row still within its boot window, or one not live here.
          codexBootStuck: codexBootStuck(w.id),
          lastMismatchReplay: pty?.getLastMismatchReplay(w.id) ?? null,
          lastMismatchFusion: pty?.getLastMismatchFusion(w.id) ?? null,
          // Card 79999395 — mirrors lastMismatchFusion's own null-vs-measured discipline; see worker_list's
          // own tool description for the full reading guide.
          lastMismatchPastedContentWrapReplay: pty?.getLastMismatchPastedContentWrapReplay(w.id) ?? null,
          lastMismatch: mismatch,
          lastMismatchNoticeSuppressed: pty?.getLastMismatchNoticeSuppressed(w.id) ?? null,
          lastPasteTripwireGiveUp: pty?.getLastPasteTripwireGiveUp(w.id) ?? null,
          lastFlushAttribution: lastFlushAttribution(w.id),
          pendingMerge,
          rateLimitedUntil: w.rateLimitedUntil ?? null,
          rateLimitDeadline: w.rateLimitDeadline ?? null,
          // Card 66ff7321: non-null means this worker's context is EXHAUSTED (the terminal "Prompt is
          // too long" api-error, detected by tick, never a hook) — busy is already false and any
          // queued direction is HELD, not drained; worker_recycle keeps its worktree/branch intact.
          contextExhaustedAt: w.contextExhaustedAt ?? null,
          worktreePathAliases: worktreePathAliases(w.worktreePath, w.id),
          ...reportedProjection(w.id, pendingMerge),
          ...directiveProjection,
          ...archivedWithoutReport(w.id),
          // Card f797affb — see deriveUnresolvedCascade's own doc above.
          unresolvedCascade: deriveUnresolvedCascade(directiveProjection.parkedDirective, mismatch),
        };
      });
      const pendingSpawns = sessions.listPendingSpawns(managerSessionId).map((op) => ({
        workerSessionId: null,
        taskId: op.taskId,
        processState: "starting" as const,
        busy: false,
        branch: null,
        ctxInputTokens: null,
        ctxPct: null,
        ...ctxMidTurnFields(null), // no worktree/pty exists yet — not determinable here
        contextTelemetry: null, // no worktree/pty exists yet — harness not determinable here, never a silent false
        neverCompletedTurn: true,
        model: null,
        lastActivity: op.startedAt,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        composerDirtyLenBelieved: null,
        unconfirmedDeliveryMs: null,
        kickoffConfirmPending: null, // no worktree/pty exists yet — not applicable (card 8882e2ca)
        pendingQueueDepth: null,
        currentTurnBusyForMs: null,
        codexBootStuck: null, // no worktree/pty exists yet — not applicable
        lastMismatchReplay: null,
        lastMismatchFusion: null,
        lastMismatchPastedContentWrapReplay: null,
        lastMismatch: null,
        lastMismatchNoticeSuppressed: null,
        lastPasteTripwireGiveUp: null,
        lastFlushAttribution: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        contextExhaustedAt: null,
        worktreePathAliases: null, // no worktree exists yet — not determinable, never a silent 0
        pendingSpawn: { opId: op.opId, startedAt: op.startedAt },
        reportedState: null,
        awaitingReview: false,
        staleReport: null,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
        unresolvedCascade: null,
        archivedWithoutReport: false,
      }));
      // A worker_spawn REJECTED purely because the concurrency cap was full gets its own ADDITIVE
      // placeholder row — distinct from `pendingSpawn` above (which is an IN-FLIGHT spawn still
      // provisioning): this one never started at all. `workerSessionId:null`,
      // `processState:"cap-queued"` (a value no real worker row ever has), `reportedState:null`,
      // `awaitingReview:false` — so an existing "count live workers" / "find one awaiting review"
      // consumer skips it exactly like a pendingSpawn row. See CapQueueRegistry's class doc: this is a
      // VISIBILITY marker only — nothing auto-dispatches it; the manager re-drives it via worker_spawn.
      const capQueued = sessions.listCapQueuedSpawns(managerSessionId).map((e) => ({
        workerSessionId: null,
        taskId: e.taskId,
        processState: "cap-queued" as const,
        busy: false,
        branch: null,
        ctxInputTokens: null,
        ctxPct: null,
        ...ctxMidTurnFields(null), // no worktree/pty exists yet — not determinable here
        contextTelemetry: null, // no worktree/pty exists yet — harness not determinable here, never a silent false
        neverCompletedTurn: true,
        model: null,
        lastActivity: e.queuedAt,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        composerDirtyLenBelieved: null,
        unconfirmedDeliveryMs: null,
        kickoffConfirmPending: null, // no worktree/pty exists yet — not applicable (card 8882e2ca)
        pendingQueueDepth: null,
        currentTurnBusyForMs: null,
        codexBootStuck: null, // no worktree/pty exists yet — not applicable
        lastMismatchReplay: null,
        lastMismatchFusion: null,
        lastMismatchPastedContentWrapReplay: null,
        lastMismatch: null,
        lastMismatchNoticeSuppressed: null,
        lastPasteTripwireGiveUp: null,
        lastFlushAttribution: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        contextExhaustedAt: null,
        worktreePathAliases: null, // no worktree exists yet — not determinable, never a silent 0
        capQueued: {
          opId: e.opId, agentId: e.agentId, taskId: e.taskId, kickoffLabel: e.kickoffLabel, queuedAt: e.queuedAt,
          // Card daf7dfa1: additive-only — omitted entirely for a non-review entry, so a normal cap-queued
          // placeholder's shape is byte-identical to before these fields existed. Makes a queued review's
          // target visible BEFORE it ever fires, not just discoverable after the fact.
          ...(e.reviewOfWorkerSessionId ? { reviewOfWorkerSessionId: e.reviewOfWorkerSessionId } : {}),
          ...(e.reviewOfTaskId ? { reviewOfTaskId: e.reviewOfTaskId } : {}),
        },
        reportedState: null,
        awaitingReview: false,
        staleReport: null,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
        unresolvedCascade: null,
        archivedWithoutReport: false,
      }));
      // @decision ae0b7891 — never scope this category by exact `parentSessionId` match; an
      // archived-without-report worker keeps its now-retired predecessor's id after a manager recycle, so
      // exact match would silently hide the exact finding this category exists to surface.
      const archivedUnreported = db.listWorkerSessionIdsWithEventKind(["worker_exited_without_report"])
        .map((id) => db.getSession(id))
        .filter((w): w is Session => !!w && workerReadableByManager(w) && sessions.isArchivedWithoutReport(w.id))
        .map((w) => ({
          workerSessionId: w.id,
          taskId: w.taskId ?? null,
          processState: w.processState,
          busy: false,
          branch: w.branch ?? null,
          ctxInputTokens: w.ctxInputTokens ?? null,
          ctxPct: contextPercentFor(w.ctxInputTokens, w.model),
          // busy:false forced above (this worker already exited) — mirror that here rather than reading
          // w.busy, so ctxMidTurn is deterministically false for this row regardless of stale DB state.
          ...ctxMidTurnFields({ busy: false, ctxUpdatedAt: w.ctxUpdatedAt, lastActivity: w.lastActivity }),
          contextTelemetry: contextTelemetryFor(w.harness),
          neverCompletedTurn: (w.turnSeq ?? 0) === 0,
          model: w.model ?? null,
          lastActivity: w.lastActivity,
          lastEngineOutputAt: null,
          composerDirtyLen: null,
          composerDirtyLenBelieved: null,
          unconfirmedDeliveryMs: null,
          kickoffConfirmPending: null, // not live in this process (card 8882e2ca)
          pendingQueueDepth: null,
          currentTurnBusyForMs: null,
          codexBootStuck: null, // not live in this process
          lastMismatchReplay: null,
          lastMismatchFusion: null,
        lastMismatchPastedContentWrapReplay: null,
          lastMismatch: null,
          lastMismatchNoticeSuppressed: null,
          lastPasteTripwireGiveUp: null,
          lastFlushAttribution: null,
          pendingMerge: null,
          rateLimitedUntil: null,
          rateLimitDeadline: null,
          contextExhaustedAt: null,
          worktreePathAliases: worktreePathAliases(w.worktreePath, w.id),
          reportedState: null,
          awaitingReview: false,
          staleReport: null,
          directive: { msgId: null, state: "none" as const, at: null },
          staleDirective: null,
          parkedDirective: null,
          unresolvedCascade: null,
          archivedWithoutReport: true,
        }));
      // Card ba41b402 defect 1: a STOPPED worker whose branch/worktree still holds unmerged work is
      // otherwise invisible here (see SessionService.getDanglingWorkers's own doc for the full
      // discriminator design — task-level mergedSha, not branch content/existence). ADDITIVE placeholder
      // row, same convention as pendingSpawns/capQueued above: `processState:"dangling"` is a value no
      // live/exited worker row ever has, so an existing "count live" / "find one awaiting review"
      // consumer skips it unchanged. `worktreePath` is new here (absent from every other row shape) —
      // the whole point of this row is to name where the recoverable work actually lives.
      const dangling = (await sessions.getDanglingWorkers(managerSessionId)).map((d) => ({
        workerSessionId: d.workerSessionId,
        taskId: d.taskId,
        processState: "dangling" as const,
        busy: false,
        branch: d.branch,
        ctxInputTokens: null,
        ctxPct: null,
        ...ctxMidTurnFields(null), // already stopped — not determinable here
        contextTelemetry: null, // harness isn't tracked on a DanglingWorkerEntry (already stopped) — not determinable here
        neverCompletedTurn: null,
        model: null,
        lastActivity: d.lastActivity,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        composerDirtyLenBelieved: null,
        unconfirmedDeliveryMs: null,
        kickoffConfirmPending: null, // already stopped, not live in this process (card 8882e2ca)
        pendingQueueDepth: null,
        currentTurnBusyForMs: null,
        codexBootStuck: null, // already stopped, not live in this process
        lastMismatchReplay: null,
        lastMismatchFusion: null,
        lastMismatchPastedContentWrapReplay: null,
        lastMismatch: null,
        lastMismatchNoticeSuppressed: null,
        lastPasteTripwireGiveUp: null,
        lastFlushAttribution: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        contextExhaustedAt: null,
        reportedState: null,
        awaitingReview: false,
        staleReport: null,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
        unresolvedCascade: null,
        archivedWithoutReport: false,
        worktreePath: d.worktreePath,
        worktreePathAliases: worktreePathAliases(d.worktreePath, d.workerSessionId),
      }));
      // Card 548a0c7e: live worker-concurrency snapshot — `{cap, live, inFlight, free}`, the SAME shape a
      // successful worker_spawn's own `capacity` field carries (see that tool's description); a plain
      // read holding no claim of its own — `getWorkerCapacity` no longer takes an exclusion argument at
      // all (card 16637a9e), since a spawn now releases its own claim before ever reading this. worker_list is a
      // DELIBERATE bare array (see worker-list-pending-ops.mjs's own "no {workers,...} wrapper" pin), so
      // this rides along as an ADDITIVE field on every row instead of restructuring the response — the
      // same convention every other cross-cutting fleet fact here already uses (pendingMerge, etc.). Known
      // gap: an entirely EMPTY fleet (zero rows of any kind) has no row to carry it — covered instead by
      // composeManagerStartupPrompt's boot-time orchestration block and by worker_spawn's own `capacity`
      // on the FIRST spawn, neither of which needs an existing row.
      // `?.` defends the same way the `pty?.` reads above do — several hermetic tests in this file's own
      // test suite wire a plain stub object (not a real SessionService) as `sessions`, and a stub that
      // predates this field would otherwise throw at runtime despite type-checking fine under `as any`.
      const capacity = sessions.getWorkerCapacity?.(managerSessionId) ?? { cap: 0, live: 0, inFlight: 0, free: 0 };
      return [...workers, ...pendingSpawns, ...capQueued, ...archivedUnreported, ...dangling].map((r) => ({ ...r, capacity }));
    };

    // Field-provenance pointers for worker_list's (and worker_status's shared fleet-view) description
    // below, relocated out of the agent-facing text (an end-user agent can't resolve a card/decision id).
    // Entries with a matching docs/decisions record use @decision, one per paragraph; a bare card id
    // below has no such record and is a plain provenance citation, not a decision-record anchor.
    //
    // card 548a0c7e — every row (real worker or placeholder) additively carries `capacity`.
    //
    // @decision 085d9422 — a PARKED directive is not proof it was never received; relocated here from
    // the (now-retired) per-event `[loom:redelivery-parked]` notice wording.
    //
    // card 4491bd3b — `staleReport`, the reconciliation detector for the manager-review direction.
    //
    // card 8a5bd0d0 — `worker_report_get`'s recoverability does not depend on engine session id
    // rotation, unlike `worker_transcript`.
    //
    // card 68d85015 — nor does it depend on transcript rendering never having dropped anything.
    //
    // @decision 479f449f — `pendingMerge.outcome:"unknown"` replaces the old "failed".
    //
    // @decision 99a1cf6f — `pendingMerge.outcome:"stale-base"`: a benign race, re-confirm gates for real.
    //
    // @decision c06f876a — re-calling `worker_merge_confirm` after the branch/mainline moved gates for
    // real instead of replaying the cached verdict.
    //
    // @decision 66ff7321 — `contextExhaustedAt`: context exhaustion clears busy via tick detection.
    //
    // card 0f15b692 — Platform Lead verification backing both `lastEngineOutputAt`'s "recent is
    // tautological on a busy row" framing and the turnSeq-vs-ctxTurns gap being the normal case.
    //
    // card 8d1abb7a — why the transcript-artifact check is the only one of the three progress checks
    // that works on a worker that has never completed a turn.
    //
    // card 5a8a74e1 — `turnSeq` counts Loom-turns, never a harness's own transcript-record count
    // (also backs `contextTelemetry`, the field that makes a null context reading decidable by cause).
    //
    // card 6198b93e — the p1 retraction that followed comparing `turnSeq` against `ctxTurns` directly.
    //
    // card 808ee811 — `ctxPct`, the pre-divided context-occupancy percentage.
    //
    // @decision c148f118 — `composerDirtyLen` is CONSERVATIVE ONLY.
    //
    // @decision d4b3fa6c — a GIVE-UP SUPPRESSED mark is NOT AUTHORITATIVE ALONE.
    //
    // @decision 8882e2ca — `kickoffConfirmPending`, the extended plausible-confirm window for a
    // large turn-1 kickoff.
    //
    // @decision 68459420 — `lastMismatchReplay`, the sender-directed arm of `[loom:prompt-mismatch]`.
    //
    // @decision b7158b99 — correction: a detected replay is a POSSIBLE loss, never an established one.
    //
    // card e59880fe — `wrapped:true`: a replay recognized via the engine's pasted-content wrap tag
    // framing rather than a bare byte-for-byte match.
    //
    // @decision f5f6515a — `lastMismatchFusion`, the fused counterpart with the opposite contract to
    // `lastMismatchReplay` (content always arrived; the risk is duplication, not loss).
    //
    // @decision 79999395 — `lastMismatchPastedContentWrapReplay`, a fourth, distinct mismatch signal.
    //
    // @decision dc92f4b6 — the confirmed-pasted-content-wrap-replay arm that field reads.
    //
    // @decision 1c7a5e12 — added that arm's `bare` framing discriminator.
    //
    // @decision c0323f8a — `lastMismatchNoticeSuppressed`: a byte-identical repeat notice was
    // suppressed rather than redelivered as a duplicate turn.
    //
    // @decision 72cab648 — `lastPasteTripwireGiveUp`: the bare-paste-placeholder tripwire's one-shot
    // auto-recovery re-injection also collapsed.
    //
    // card eef4883c — the paste-tripwire auto-recovery re-injection mechanism itself, unrelated to
    // detection, that `lastPasteTripwireGiveUp` reports the exhaustion of.
    //
    // @decision 0f9268cc — that same auto-recovery re-injection mechanism's own detection-then-recovery
    // design.
    //
    // @decision 47c11741 — the session+sender `enqueueSystemNudge` pull-surface companion to that field.
    //
    // @decision ac7884e3 — `lastFlushAttribution`, the fleet-scan read of `worker_flush`'s own verdict.
    //
    // card 31f3d047 — `lastMismatch`, a derived view over the three `lastMismatch*` fields — filed after
    // a real mismatch Loom classified correctly had no worker_list/worker_status projection.
    //
    // @decision f797affb — `unresolvedCascade`: a parked directive co-occurring with a logged mismatch.
    //
    // card 5c3db367 — the forensic close that proved that co-occurrence costs real archaeology to
    // rule out, motivating `unresolvedCascade`.
    //
    // @decision a33a72f7 — `unconfirmedDeliveryMs`, an earlier signal than `composerDirtyLen`.
    //
    // card d8eaa381 — `pendingQueueDepth` and `currentTurnBusyForMs`.
    //
    // card bba13405 — `codexBootStuck`, closing the gap where a wedged-before-boot codex session
    // reads identically to a healthy idle one on every other field.
    //
    // @decision ba41b402 — the "dangling" placeholder row for a stopped worker whose branch/worktree
    // still holds unmerged work.
    //
    // card 5ab3c664 — measured directly: a dangling row never blocks or delays a fresh worker_spawn.
    //
    // card e55371c1 — `worktreePathAliases`, the path-keyed worktree-aliasing signal.
    server.registerTool(
      "worker_list",
      { description: "List your direct-child workers (bare array). Every row (real worker or placeholder) carries `capacity:{cap,live,inFlight,free}` (same snapshot as worker_spawn's `capacity`). An empty array means live=0, free=cap; cap is in your startup Orchestration config block. `directive:{msgId,state,at}` is the state of your latest worker_message/worker_redirect (msgId is the one you got back): `\"none\"` (never messaged) | `\"pending\"` (queued or still being retried) | `\"delivered\"` | `\"parked\"` | `\"confirmed-after-park\"`. `staleDirective` and `parkedDirective` are alarm flags derived from it. `staleDirective` (`{msgId, deliveredAt, turnsSinceDelivery}`) flags a directive that was DELIVERED but has no worker_report since (`delivered:true` from worker_message/worker_redirect only proves hand-off, not that the engine confirmed or acted on it). It fires only after the worker completed several of its OWN turns with no report (never on one long turn) and clears when any worker_report lands or you send a newer worker_message/worker_redirect (tracking follows your latest directive of either kind, on both held and immediate redirect paths). `parkedDirective` (`{msgId, parkedAt}`) flags a directive Loom gave up REDELIVERING (hand-off never confirmed, retries exhausted), the case `staleDirective` cannot see (a parked directive never reaches the worker, so its turnSeq never advances). A park is NOT proof the directive was never received: the engine can confirm minutes late under load. `directive.state` MAY still resolve to `\"confirmed-after-park\"` (with `parkedDirective` back to `null`) if a late hook proves it landed, but its absence is NOT evidence the directive failed. Mutually exclusive with `staleDirective`. STICKY: a `worker_report` does NOT clear it (the text never reached the worker); it clears when you send a NEWER worker_message/worker_redirect or on a late confirmation; re-call this tool later to check. ⛔ On a directive that is STILL `parkedDirective`, RE-SEND (Loom will not retry it); on `confirmed-after-park` do NOT resend, the original landed and a resend is a duplicate turn. `reportedState` (done|blocked|null) + `awaitingReview` flag a worker that has called worker_report and is sitting idle awaiting your review (cleared once you worker_message/worker_redirect it, it's recycled or stopped, or its merge actually COMPLETES — merely reviewing its diff with worker_merge, or a rejected/cancelled merge, does NOT clear this; the worker is still awaiting your decision). `staleReport` (`{reportedAt, managerTurnsSinceReport}`) fires ONLY while `awaitingReview` is true, once YOUR OWN session has completed several further turns with THIS report still unresolved. It does not claim the report was lost, only that it sat unconsumed by your review/merge/message actions; if you don't recall it, pull `worker_report_get(workerSessionId)` (durably recorded, recoverable in full; `worker_transcript(lastN:2)` works in the common case but cannot recover a report transcribed to a pre-rotation transcript file). Clears the way `awaitingReview` does. `archivedWithoutReport:true` flags a worker whose pty EXITED WITHOUT EVER CALLING worker_report: it no longer counts against your cap, but it did not silently vanish (a real worker row; `processState` is its exit state); it appears ONLY for a genuinely unreported strand, never for a worker that reported (even `noChanges`) and auto-retired. Pull `worker_transcript` to see what it did, then `worker_merge` to review committed work, or re-dispatch. It clears once you resolve it (move the task off its active lane, or spawn/recycle a successor). `pendingMerge` (non-null) means a worker_merge_confirm is still in flight (`state:\"running\"`) or JUST settled (`state:\"done\"|\"failed\"` with `outcome` `\"merged\"|\"rejected\"|\"cancelled\"|\"unknown\"|\"stale-base\"|\"worktree-dirty\"`), a brief cosmetic display (a few seconds after settling); reverting to `null` does NOT mean the verdict is forgotten. `\"unknown\"` means a thrown exception mid-confirm could not determine the outcome: check the `[loom:merge-unknown]` nudge or `gate_status(opId)`'s `outcome:\"error\"` before assuming nothing landed. `\"stale-base\"` means the gate ran but canonical MAIN advanced during it, a BENIGN race distinct from `\"rejected\"` (a real test failure): re-confirming re-gates, nothing is wrong with the branch (see `worker_merge_confirm`). `state:\"running\"` is set the INSTANT the merge is minted, possibly well before the gate is admitted, so a long-`running` pendingMerge alone is not evidence of a wedge. While running, `gatePhase` separates WAITING from EXECUTING: `\"queued\"` = waiting on the daemon-global gate cap or a same-repo sibling (elapsed is WAIT time, see `gate_queue`), `\"running\"` = admitted and executing, `null` = not yet at gate admission (worktree prep/union-merge) or already past the gate (squash/finalize still running), a normal reading. Once `state` is no longer `\"running\"` the merge is DONE: read `outcome` here, no need to re-call. Re-calling worker_merge_confirm for a settled merge is ALWAYS SAFE at ANY delay: at the SAME commit and an unchanged mainline tip it returns the SAME cached verdict; if the branch has new commits or main advanced (any landing, docs-only included) it gates for real. The ONLY way to force a RE-RUN of the SAME commit (retrying a flake, finishing a nested-repo cleanup) is `forceRemoveWorktree:true` on the re-call; it always runs for real. `rateLimitedUntil`/`rateLimitDeadline` (non-null) mean the worker is PARKED ON A USAGE CAP — busy will read false but this is NOT a healthy idle worker; it resumes on its own once `rateLimitedUntil` passes (`rateLimitDeadline` is the give-up horizon). `contextExhaustedAt` (non-null) means the worker's CONTEXT IS EXHAUSTED — the engine rejected its next prompt as too long and no Stop/StopFailure hook ever fires for this failure, so busy was cleared by TICK detection, not a turn boundary; this is NOT a healthy idle worker either, and any queued direction is HELD, not drained, until you worker_recycle it (keeps the worktree/branch) — it clears on the successor's own first turn, never on this row again. `lastEngineOutputAt` is an INTRA-TURN liveness signal (advances on every chunk of engine output, unlike `lastActivity`, which moves only at turn boundaries). On a `busy:true` row \"recent\" is ~now by construction and uninformative; its value is a STALE reading on an IDLE row. Liveness is not convergence: a retry loop emits as steadily as real work. `lastActivity` advancing (a turn boundary crossed) is the strongest signal here, though a multi-turn loop still crosses boundaries. For actual progress, lead with a `worker_transcript` pull and look for a NAMED, distinct artifact (output, a file, a result that could not exist unless the new work ran); the same shape repeated with only an index/timestamp changed is not progress. It is the ONLY check that works on a worker that has never completed a turn. `ctxInputTokens` climbing across two reads and `git log`/`git status` on its branch are real signals only once past that point: on a never-completed-turn worker `ctxInputTokens` is `null`, and a healthy worker deep in a long first turn shows an identical `git status` across samples (flat means \"no commit yet\", not \"stalled\"). Check `neverCompletedTurn` first (`true` when `turnSeq` is still 0): `true` makes `ctxInputTokens: null` expected, not bad news; `false` with a still-`null` `ctxInputTokens` is the anomaly. `turnSeq` counts LOOM-TURNS (one submit → confirmed-idle cycle), never a harness's transcript-record count (on codex one Loom-turn renders as MANY records, so counting role-tagged records overcounts). ⛔ NEVER COMPARE `turnSeq` AGAINST `ctxTurns`: `ctxTurns` counts assistant lines including every tool round trip, `turnSeq` only completed turns, so a large gap (ctxTurns:1535 vs turnSeq:529) is normal for one long turn. `turnSeq` survives a daemon restart; `null` on the `\"dangling\"` placeholder means not tracked (already stopped). Never read `ctxInputTokens: null` as a measured `0`. `ctxPct` is `ctxInputTokens` divided by the worker's model context window, rounded to a whole percent, null exactly when `ctxInputTokens` is (including structurally for codex); read it when deciding continue-vs-recycle. `contextTelemetry` (boolean|null) says WHY a `ctxInputTokens`/`ctxPct`/`ctxTurns`/`model` is null: `false` = structurally unmeasurable on this harness (codex today), a persistent null is expected; `true` (claude) = only \"not yet measured\" (pair with `neverCompletedTurn`); `null` = not determinable from this placeholder row, never a measured `false`. `composerDirtyLen` counts characters possibly still sitting UNSUBMITTED in this worker's composer from an earlier delivery that never confirmed (null = session not live in this process; 0 = genuinely clean, NOT unknown). It is set when a give-up/heal fires, so it stays non-zero even when nothing further arrives; cleared by a confirming hook proving this generation's mark landed, or by a later unrelated delivery's clear-prefix confirming. It is conservative: read it with `composerDirtyLenBelieved` (same null-vs-0 discipline): equal = nothing to doubt, `composerDirtyLenBelieved` lower = an unresolved clear, the gap being the characters in doubt. NOT AUTHORITATIVE ALONE: a GIVE-UP SUPPRESSED mark (the engine produced output after Loom's final Enter, so the turn likely started) has no automatic clear on its own generation, so a stale non-zero can read against a verified-empty composer. Do NOT treat a non-zero value, even with a stalled `lastActivity`/`lastEngineOutputAt`, as proof the last message never arrived: call `worker_flush` FIRST (submit-only, writes nothing, a no-op on a clean composer) before trusting it or reaching for `worker_recycle`/`worker_stop`; the engine can confirm minutes late. `kickoffConfirmPending` (`{composerDirtyLen, windowMs}`) is non-null ONLY while the turn-1 kickoff is unconfirmed (turnSeq still 0) AND its size earns an extended confirm window (the same predicate that softens the notice from terminal `[loom:worker-spawn-broken]` to `[loom:kickoff-confirm-pending]`); `windowMs` is how long confirm stays plausible. `null` = the kickoff already confirmed, or it was an ordinary size (check `composerDirtyLen`/`unconfirmedDeliveryMs` instead). `lastMismatchReplay` (`{gen, replayedGen, reportedLen, intendedLen, detectedAt, explainedBenign, wrapped, wrapIdLen}`) is the sender-directed arm of the worker's `[loom:prompt-mismatch]` notice: what the engine submitted was a byte-for-byte REPLAY of an earlier generation (`replayedGen`) instead of the new content for `gen`. A POSSIBLE loss, not an established one. `explainedBenign` (`\"wrapper-deficit\"|\"ansi-strip\"|\"wrapper-aware-fusion\"|null`) names an independent classifier that also fired and established it as benign (`null` = none fired; the replay stays as loud as before). `wrapped:true` = recognized through the engine's pasted-content wrap tag framing around `replayedGen`'s write rather than a bare match (`wrapIdLen` = that tag id's length, else `null`); it changes nothing about severity or recovery and can co-occur with `explainedBenign`. The composer may still hold `gen`'s text and a LATER generation's submission can fuse it back in: a subsequent `lastMismatchFusion` naming `gen` in its `spanGens` means it was recovered. Do NOT re-send solely because this is non-null: first check whether a later `lastMismatchFusion` already names `gen`. STICKY (never cleared once set) and OVERWRITTEN by a later occurrence; `null` = none detected yet or session not live (not distinguished). `lastMismatchFusion` (`{gen, spanGens, reportedLen, intendedLen, detectedAt}`) has the OPPOSITE contract: the engine-reported content is a CONFIRMED CONCATENATION of several generations (`spanGens`, oldest-first). The span always ends with the CURRENT generation's write, so this turn's content ALWAYS arrived and there is nothing to re-send. The risk is DUPLICATION: an earlier generation in `spanGens` may have already run its own turn, so check whether that earlier directive's effects already happened; never re-send it. A given mismatch sets at most ONE of the two fields, so read both. `lastMismatchPastedContentWrapReplay` (`{gen, recognizedGen, reportedLen, intendedLen, detectedAt, bare}`) is a distinct signal: a LATE engine echo wraps an EARLIER generation's recorded write (`recognizedGen`) in the engine's paste-composer framing (`bare` says which framing) and this turn's intended text is CONTENT-IDENTICAL to that write. NOT A LOSS (the content arrived via `recognizedGen`'s echo; `gen`'s own write may still surface as a copy): do not re-send solely because this is non-null. Content identity only, not lineage. Sticky/overwritten like its siblings. `lastMismatchNoticeSuppressed` (`{gen, writtenHash, reportedHash, count, detectedAt}`) does NOT mean a mismatch was detected: this worker's `[loom:prompt-mismatch]` notice was about to be delivered a SECOND time, byte-identical (same gen, writtenHash, reportedHash), and Loom suppressed the duplicate turn. `count` accumulates across repeats of the same signature (suppressed once vs repeatedly). It is a defensive guard for a code-reachable path with no confirmed observed instance; non-null proves only that the guard fired. `lastPasteTripwireGiveUp` (`{gen, token, engineSessionId, detectedAt}`) is a different class: the bare-paste-placeholder tripwire's ONE-SHOT auto-recovery re-injection ALSO collapsed and Loom will not retry a third time. It is the sender pull-surface for that give-up (alongside the notice; do not rely on the notice alone). Sticky/overwritten. `lastFlushAttribution` (`{gen, attributable, reason, resolvedAt}`) is the fleet-scan read of the sticky verdict `worker_flush` returns (see that tool for the reading of `null`/`attributable:true`/`attributable:false, reason:\"marker-superseded-before-confirm\"`); use it to learn whether an EARLIER `worker_flush` resolved without re-calling it (a flush is read-only only when the composer is already clean). Sticky. `lastMismatch` (`{kind, gen, at}`, `kind` `\"replay\"|\"fusion\"|\"unmatched\"`) is a DERIVED view, computed at read time as whichever of `lastMismatchReplay`/`lastMismatchFusion`/`lastMismatchUnmatched` has the latest `detectedAt`; `\"unmatched\"` covers any mismatch matching no recognized shape. It answers \"did any mismatch fire recently, and roughly what kind\" from one field. `null` = none fired since the session went live, or session not live; a mismatch reconciled as benign (whitespace re-render, stale placeholder prefix, chunk-seam form feed) sets none of them. `unresolvedCascade` (`{msgId, parkedAt, mismatchKind, mismatchAt, note}`) flags `parkedDirective` non-null CO-OCCURRING with `lastMismatch` non-null within a bounded window around the park. It is pure wiring over those two fields: both 'silently lost' and 'landed anyway, just never individually confirmed' are live readings of this signature. ⛔ It NEVER guesses which: `note` says UNRESOLVED and names the one check that settles it, reading `worker_transcript` for a turn that acted on the content. Not a refusal or auto-remedy, and not a reason to stop or recycle: treat it like a plain `parkedDirective` (re-send only once you've ruled out that it already landed). Clears when a newer directive supersedes `parkedDirective` or the pair ages out of the correlation window; not sticky beyond that. `unconfirmedDeliveryMs` is an EARLIER signal than `composerDirtyLen`: milliseconds since this worker's CURRENT generation's Enter was written, while unconfirmed by a hook (non-null the instant a write is outstanding; `null` = nothing outstanding or session not live). It does not distinguish 'still within Loom's retry budget' from 'Loom gave up on this generation, outcome unknown'. Read with `composerDirtyLen`: zero there while this is non-null means genuinely in flight and never given up; non-zero there is ambiguous. `pendingQueueDepth` is how many messages sit in this worker's FIFO send queue (EVERY entry regardless of sender, for claude and codex alike; `null` = session not live, `0` = measured empty). One entry drains per completed turn, so a non-zero depth means your direction may take several more turns to land; it does NOT mean delivery is stuck. `currentTurnBusyForMs` is milliseconds since the CURRENT turn went busy (`null` if idle or not live; CLAUDE-ONLY, always `null` for codex). A LARGE value on a `busy:true` row is NOT evidence of a wedge: a healthy turn with heavy tool/subagent use can run tens of minutes (53 measured). Pair both with `lastEngineOutputAt` (recent = still emitting) before concluding anything is wedged. `codexBootStuck` (`{at, timeoutMs, unmet}`, `unmet` a subset of `[\"ready marker\", \"model-loaded\", \"trust-dialog-resolved\"]`) is CODEX-ONLY: a codex session wedged before booting reads `processState:\"live\"`, `resumability:\"resumable\"`, `busy:false`, exactly like a healthy idle worker. It goes non-null the instant the boot-readiness ceiling fires without latching (the `[loom:codex-boot-stuck]` moment, durably readable here); `unmet` names the conditions never simultaneously observed. If it stays quiet, intervene (inspect the session, `worker_message`/`worker_redirect`/`worker_stop`+respawn); it may still self-recover if codex was slow, and a late marker sighting clears it back to `null`. `null` does NOT mean healthy on its own (also the reading for claude rows, a codex row still in its boot window, or a session not live): read it with `processState`/`busy`/`pendingQueueDepth`. A worker_spawn still running past the sync-wait budget shows as an ADDITIVE placeholder row: `workerSessionId:null`, `pendingSpawn:{opId,startedAt}`, `processState:\"starting\"`; not a real worker yet. Poll here or re-call worker_spawn (same taskId/agentId/kickoffPrompt) to fetch the result. A worker_spawn REJECTED because the concurrency cap was full shows as another placeholder: `workerSessionId:null`, `processState:\"cap-queued\"`, `capQueued:{opId,agentId,taskId,kickoffLabel,queuedAt}`; the intent never started. While this daemon process keeps running it AUTO-FIRES (FIFO, oldest first) when a slot on this manager frees; you can still re-`worker_spawn` the same taskId/agentId by hand, which clears the marker. ⚠️ IT DOES NOT SURVIVE ANY DAEMON RESTART (crash, dev-watch reload, deliberate restart): the queue is in-memory only and a restart drops every entry silently. A graceful restart notifies EVERY affected manager/platform of what was dropped; a crash or dev-watch restart gives no notice. Re-`worker_spawn` by hand after ANY restart if the dispatch still matters. If an auto-fire fails for a real reason (task went terminal/held, worktree couldn't be created) you get `[loom:cap-queue-autofire-failed]` naming the opId/task/agent, and the entry is dropped (needs a fresh worker_spawn). To withdraw a queued entry before it fires, call `worker_stop({opId})`. A STOPPED (archived) worker whose branch/worktree still holds unmerged work shows as a placeholder: `processState:\"dangling\"`, `worktreePath` set (no other row carries it). It is a REAL past worker (`workerSessionId` is its actual id), already archived, and holds NO cap slot (the cap counts only `processState===\"live\"` rows). It is surfaced because its bound task has no recorded merge yet (taskless: its branch carries a commit not on the mainline), content-based so work that shipped under a different name never appears. Purely observational: pull `worker_transcript`/`git log` on its branch, then `worker_merge_confirm` or re-dispatch. `worktreePathAliases` is the count of OTHER session rows (any process state, any manager on this project) whose worktree_path is EXACTLY this row's, measured fresh each read. ⛔ `gen`/`recycledFrom` are NOT an aliasing check: they track recycle chains only, and `branch`/`worktreePath` are a pure function of `taskId`, so a plain re-spawn after a rejected merge lands a SECOND `gen:0`/`recycledFrom:null` row on the SAME path with no recycle in sight. `0` is a measured zero (worktreePath set, nothing else shares it); `null` = not determinable (the `\"starting\"`/`\"cap-queued\"` placeholders have no worktreePath yet), never a silent zero. A worktreePath includes the `projectId`, so this per-project count is the complete answer. It is a COUNT, never the aliasing rows' ids (a foreign manager's worker identity must not be widened), and a snapshot: a later re-spawn can raise it. Never count any of the three placeholders (`\"starting\"`, `\"cap-queued\"`, `\"dangling\"`) as live or awaiting review.", inputSchema: strictShape({}) },
      async () => ok(await fleetView()),
    );

    // Field-provenance pointers for worker_status's description below, additional to worker_list's own
    // block above (most of worker_status's fields are "see worker_list" pointers and share that
    // provenance; these are the ids cited directly in worker_status's own text).
    //
    // card 8a5bd0d0 — the rotated-engine-session-id caveat `worker_report_get` doesn't share.
    //
    // card 68d85015 — the rendered/truncated-transcript caveat `worker_report_get` doesn't share.
    //
    // card 5a8a74e1 — the real pilot misreading that backs `turnSeq`'s own semantics (see worker_list).
    server.registerTool(
      "worker_status",
      {
        description:
          "Get the full session record for one of your workers, by workerSessionId. Carries the same " +
          "fields as worker_list (read their definitions there) plus the derived `reportedState` " +
          "(done|blocked|null) and `awaitingReview`: set when the worker has called worker_report and is idle " +
          "awaiting your review; cleared when you worker_message/worker_redirect it, it is recycled or " +
          "stopped, or its merge COMPLETES (reviewing its diff with worker_merge, or a rejected/cancelled " +
          "merge, does NOT clear it). Differences and reading rules: " +
          "`staleReport` asserts NO cause, only that your session kept turning while the report sat " +
          "unconsumed; recover it with `worker_report_get(workerSessionId)` (durable event storage, without " +
          "`worker_transcript(lastN:2)`'s caveats: a rotated engine session id, a rendered/truncated " +
          "transcript). `ctxPct` is null exactly when `ctxInputTokens` is null, never a measured 0. " +
          "`contextTelemetry` (boolean|null) separates a null that is structurally unmeasurable on this " +
          "harness (codex) from not-yet-measured; pair with `neverCompletedTurn` (`true` while `turnSeq` is " +
          "0, so a null `ctxInputTokens` means \"no data yet\"). `turnSeq` counts LOOM-TURNS (submit → " +
          "confirmed-idle), never a harness's transcript-record count. `archivedWithoutReport` is true only " +
          "when the pty exited without ever calling worker_report and the strand is unresolved; never for a " +
          "worker that reported (even `noChanges`). " +
          "`directive` is the state of your latest worker_message/worker_redirect " +
          "(`\"none\"|\"pending\"|\"delivered\"|\"parked\"|\"confirmed-after-park\"`). `staleDirective`: a " +
          "delivered directive with no worker_report after several of the worker's real turns. " +
          "`parkedDirective`: a worker_message or HELD worker_redirect Loom gave up redelivering (retry/re-mint " +
          "budget exhausted, no confirmed hand-off); mutually exclusive with `staleDirective`, STICKY " +
          "(a worker_report does not clear it; only a newer worker_message/worker_redirect, or a late " +
          "confirming hook resolving it to `directive.state:\"confirmed-after-park\"`). Re-send it, UNLESS " +
          "`directive.state` already reads `\"confirmed-after-park\"` (the original landed; resending would " +
          "duplicate it). A worker_redirect is tracked this way on either delivery path. " +
          "`lastEngineOutputAt`: recent means the engine is alive and emitting, stale means it may be wedged; " +
          "neither proves the work is converging. `composerDirtyLen`: characters possibly still UNSUBMITTED in " +
          "the worker's composer from a delivery that never confirmed; null = not live here, 0 = measured " +
          "clean. It is conservative (never assumes a defensive clear-prefix landed); " +
          "`composerDirtyLenBelieved` is the optimistic counterpart (same null-vs-0 rule): equal = nothing to " +
          "doubt, lower = an unresolved clear, the gap being the characters in doubt. `unconfirmedDeliveryMs`: " +
          "ms since the current generation's Enter was written while a hook has not confirmed it; earlier " +
          "than `composerDirtyLen`, and does NOT distinguish still-retrying from gave-up (cross-check " +
          "`composerDirtyLen`). `pendingQueueDepth`: messages in the worker's FIFO send queue from every " +
          "sender; null = not live, 0 = measured empty; one entry drains per completed turn, so non-zero " +
          "means your direction may take several turns, not that delivery is stuck. `currentTurnBusyForMs`: " +
          "ms since the current turn went busy; null if idle, not live, or codex. A large value alone is not " +
          "a wedge; pair with `lastEngineOutputAt`. `codexBootStuck` (CODEX-ONLY): " +
          "`{at, timeoutMs, unmet}` exactly while the boot-readiness ceiling has fired without latching " +
          "(otherwise indistinguishable from a healthy idle session); null for claude, a codex row within " +
          "its boot window, or not live here; cleared if a late marker still latches. `kickoffConfirmPending`: " +
          "`{composerDirtyLen, windowMs}` only while the turn-1 kickoff is unconfirmed inside its size-aware " +
          "confirm window, else null. " +
          "`lastMismatchReplay` non-null = the worker's `[loom:prompt-mismatch]` notice identified a REPLAY of " +
          "an earlier generation: a POSSIBLE loss of what you last sent, not an established one; a later " +
          "`lastMismatchFusion` naming this `gen` means it was recovered; check before re-sending. " +
          "`lastMismatchFusion` (opposite contract) non-null = a CONFIRMED concatenation of several " +
          "generations (`spanGens`); the current turn's content arrived intact, so DO NOT re-send; check " +
          "whether an earlier named generation's directive already ran, to avoid acting on it twice. " +
          "`lastMismatchPastedContentWrapReplay`: a late engine echo wrapped an earlier generation's write in " +
          "paste-composer framing and this turn's text is CONTENT-IDENTICAL to it; NOT a loss, don't re-send " +
          "because of it (content identity only, never lineage). `lastMismatchNoticeSuppressed`: a " +
          "byte-identical repeat of the worker's `[loom:prompt-mismatch]` notice was suppressed (`count` for " +
          "the current signature); a defensive guard, not evidence the trigger is understood. " +
          "`lastPasteTripwireGiveUp`: pull-surface for the bare-paste-placeholder tripwire's give-up (its " +
          "one-shot recovery also collapsed; no third try); a different failure class from the " +
          "`lastMismatch*` fields; never cleared once set, overwritten by a later occurrence. " +
          "`lastFlushAttribution`: the sticky `worker_flush` verdict. `lastMismatch`: derived `{kind, gen, " +
          "at}` (kind `\"replay\"|\"fusion\"|\"unmatched\"`), whichever of those fired most recently by " +
          "`detectedAt`; null = none fired, or not live here. `unresolvedCascade` " +
          "`{msgId, parkedAt, mismatchKind, mismatchAt, note}`: non-null only when `parkedDirective` AND " +
          "`lastMismatch` fired within a bounded window of each other, an ambiguous cascade; `note` states it " +
          "is UNRESOLVED (never a guessed verdict) and names the one check that settles it (read the worker's " +
          "transcript for a turn acting on the content). It is NOT a refusal and does NOT mean stop or " +
          "recycle the worker. `worktreePathAliases`: count of OTHER session rows sharing this row's exact " +
          "worktree_path (`gen`/`recycledFrom` are not an aliasing check); `0` = measured, `null` = the row " +
          "has no worktreePath. " +
          "With NO workerSessionId it returns the fleet view (same as worker_list). Optional `msgId`: " +
          "`directive`/`staleDirective`/`parkedDirective` track only your MOST RECENT message/redirect, so an " +
          "older directive's resolution becomes invisible once you send a newer one. Pass the ROOT msgId a " +
          "prior worker_message/worker_redirect call returned (never a re-mint id) to get `queriedDirective: " +
          "{msgId, found, state, at}` for that directive: `found:false` = no record of that root msgId; " +
          "`found:true` gives its own `state` (`\"pending\"|\"delivered\"|\"parked\"|\"confirmed-after-park\"`). " +
          "This is the per-message consumed/not-consumed read; check it before treating a `parked` notice " +
          "about an earlier directive as a reason to recycle or re-spawn.",
        inputSchema: strictShape({ workerSessionId: z.string().optional(), msgId: z.string().optional() }),
      },
      async ({ workerSessionId, msgId }) => {
        // No id → fleet view (alias worker_list), so worker_status({}) never throws a schema error.
        if (!workerSessionId) return ok(await fleetView());
        const w = selfHealWorkerLink(workerSessionId, "worker_status");
        if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
        const pendingMerge = withGatePhase(sessions.peekPendingMerge(w) ?? null);
        const mismatch = deriveLastMismatch(w.id);
        const directiveProjection = staleDirectiveProjection(w.id, w.turnSeq ?? 0);
        return ok({
          ...projectSessionRowFields(w),
          // Card 808ee811 — see fleetView's identical field for the full doc.
          ctxPct: contextPercentFor(w.ctxInputTokens, w.model),
          // Card c5b234aa — see ctxMidTurnFields's own doc (fleetView); `ctxUpdatedAt` is already present
          // above via projectSessionRowFields, so only the derived boolean is added here (no ctxMeasuredAt
          // duplicate of a field this response already carries).
          ctxMidTurn: ctxMidTurnFields(w).ctxMidTurn,
          // Card 5a8a74e1 — see contextTelemetryFor's own doc (fleetView) for the full reading guide.
          contextTelemetry: contextTelemetryFor(w.harness),
          neverCompletedTurn: (w.turnSeq ?? 0) === 0,
          lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
          composerDirtyLen: pty?.getComposerDirtyLen(w.id) ?? null,
          composerDirtyLenBelieved: pty?.getComposerDirtyLenBelieved(w.id) ?? null,
          unconfirmedDeliveryMs: pty?.getPendingConfirmMs(w.id) ?? null,
          // Card 8882e2ca — see fleetView's identical field for the full doc.
          kickoffConfirmPending: kickoffConfirmPendingFor(w),
          // Card d8eaa381 — see fleetView's identical fields for the full doc.
          pendingQueueDepth: pendingQueueDepth(w.id),
          currentTurnBusyForMs: currentTurnBusyForMs(w.id),
          // Card bba13405 — see fleetView's identical field for the full doc.
          codexBootStuck: codexBootStuck(w.id),
          lastMismatchReplay: pty?.getLastMismatchReplay(w.id) ?? null,
          lastMismatchFusion: pty?.getLastMismatchFusion(w.id) ?? null,
          // Card 79999395 — mirrors lastMismatchFusion's own null-vs-measured discipline; see worker_list's
          // own tool description for the full reading guide.
          lastMismatchPastedContentWrapReplay: pty?.getLastMismatchPastedContentWrapReplay(w.id) ?? null,
          lastMismatch: mismatch,
          lastMismatchNoticeSuppressed: pty?.getLastMismatchNoticeSuppressed(w.id) ?? null,
          lastPasteTripwireGiveUp: pty?.getLastPasteTripwireGiveUp(w.id) ?? null,
          lastFlushAttribution: lastFlushAttribution(w.id),
          pendingMerge,
          worktreePathAliases: worktreePathAliases(w.worktreePath, w.id),
          ...reportedProjection(w.id, pendingMerge),
          ...directiveProjection,
          ...archivedWithoutReport(w.id),
          // Card f797affb — see deriveUnresolvedCascade's own doc above.
          unresolvedCascade: deriveUnresolvedCascade(directiveProjection.parkedDirective, mismatch),
          ...(msgId ? { queriedDirective: directiveByMsgId(db, w.id, msgId) } : {}),
        });
      },
    );

    // Provenance (card 8a5bd0d0) for the engine-session-id-rotation caveat in this tool's description
    // below — a standing, always-on caveat this tool's transcript read can't detect or recover from; see
    // context.ts/host.ts/context-exhaustion.ts's own comments for the mechanism.
    server.registerTool(
      "worker_transcript",
      {
        description:
          "Read one of your workers' transcript as clean ordered turns. PAGINATION: a large transcript " +
          "would overflow the tool-result cap, so reads are bounded to ONE page — the SAME envelope the " +
          "auditor's transcript_read uses. With NO paging arg a transcript that fits one page returns the " +
          "bare turns array; otherwise — or whenever you pass offset/limit/turnRange — it returns a page " +
          "envelope {turns, totalTurns, offset, returned, nextOffset}. Page deterministically by calling " +
          "again with offset:nextOffset until nextOffset is null (covers the whole transcript, no gaps/ " +
          "overlaps). `lastN` is a SEPARATE backward-compat shortcut for 'just the last N turns': it takes " +
          "PRECEDENCE over offset/limit/turnRange (pass one style or the other, not both) and always " +
          "returns the bare last-N array — but is ALSO bounded to the same page char budget, so a large " +
          "`lastN` may return fewer than N turns (always the MOST RECENT ones). A long offset->nextOffset " +
          "walk is capped in aggregate too: past ~10 pages, a page comes back with nextOffset:null and " +
          "truncated:true even though more remains — switch to a targeted turnRange read instead of " +
          "continuing to loop. An unknown param name (e.g. a guessed `tailLines`) is REJECTED naming the " +
          "bad key + the real ones above, instead of being silently ignored. OVERSIZED TURN: even within " +
          "one page, a SINGLE turn can itself be too large to inline safely (e.g. a batch of several " +
          "browser_snapshot calls landing in one message) — when that happens that turn's `text` is " +
          "TRUNCATED IN PLACE (head, an explicit `[TRUNCATED: showing N of M chars of this turn]` marker, " +
          "and a short tail when there's room); every other field and every other turn stays untouched, " +
          "and the response shape is still a `turns` array either way. Transcript content is NEVER " +
          "spilled to any file (not even a scratch dir) — that would reopen a cross-session read of " +
          "content this tool's own gates exist to protect; a page too large to fit inline is trimmed, " +
          "never redirected. Re-call with a narrower turnRange/limit/lastN if you need less truncation. " +
          "CAVEAT — engine session " +
          "id rotation: the Claude Code CLI can, rarely, fire a second SessionStart under " +
          "a DIFFERENT session id for the SAME live pty (most likely an internal auto-compact restarting " +
          "its own bookkeeping under a fresh transcript file) without any Loom-visible spawn/resume/fork. " +
          "When that happens this tool — like every transcript reader — can only see the CURRENT " +
          "post-rotation file; content written only to the abandoned pre-rotation file is NOT concatenated " +
          "in and is not recoverable through this tool. This is a STANDING, ALWAYS-ON caveat, not a flag " +
          "that fires only on an affected read — Loom keeps no per-session record of whether a rotation " +
          "ever happened, so a normal transcript that never rotated looks identical to one that silently " +
          "did; a shorter-than-expected or seemingly-incomplete history is the only observable symptom.",
        inputSchema: strictShape({
          workerSessionId: z.string(),
          lastN: z.number().optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().optional(),
          turnRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
        }),
      },
      async ({ workerSessionId, lastN, offset, limit, turnRange }) => {
        const w = selfHealWorkerLink(workerSessionId, "worker_transcript");
        if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
        const turns = w.engineSessionId ? readTranscript(w.cwd, w.engineSessionId, w.harness) : [];
        if (typeof lastN === "number" && lastN > 0) {
          return ok(spillableTurnsResponse(lastNTurns(turns, lastN), null));
        }
        const page = pageTranscript(turns, { offset, limit, turnRange });
        const explicit = offset !== undefined || limit !== undefined || turnRange !== undefined;
        if (!explicit && page.offset === 0 && page.nextOffset === null) {
          return ok(spillableTurnsResponse(page.turns, null));
        }
        const bounded = w.engineSessionId ? applyAggregateWalkCap(w.engineSessionId, page.offset, page) : page;
        const { turns: boundedTurns, ...meta } = bounded;
        return ok(spillableTurnsResponse(boundedTurns, meta));
      },
    );

    // Field-provenance pointers for this tool's description below:
    // card 68d85015 — reads the durable worker_report event directly, bypassing transcript rendering.
    // card 8a5bd0d0 — see worker_transcript's own provenance comment above for the rotation caveat.
    // card 36e43a98 — see the "Card 36e43a98" comment on the handler below for the refusal mechanism.
    server.registerTool(
      "worker_report_get",
      {
        description:
          "Read one worker_report your worker already FILED, straight from durable event storage: the " +
          "worker need not be alive, and no rendered transcript text is involved. The full body is " +
          "recorded verbatim the INSTANT the worker calls worker_report, so this is unaffected by " +
          "anything that degrades a transcript rendering (an oversized tool-call argument, a rotated " +
          "engine session id, a spilled/truncated page). THIS is the documented recovery path for a " +
          "`staleReport` (worker_list/worker_status); prefer it over `worker_transcript(lastN:2)`, " +
          "which also depends on the CURRENT engine transcript file still holding the turn. ALSO " +
          "reaches a report your worker FILED but Loom's pending-direction guard REFUSED: the refusal " +
          "records the full `summary`/`status`/`prUrl`/`needs`/`noChanges`/`awaiting` on its " +
          "`worker_report_rejected` event; such a result carries `rejected:true` plus " +
          "`reason`/`queued`/`msgIds`/`repeat`. A refused report was NEVER acted on, so treat it as " +
          "what the worker WOULD have reported, not as work landed. Returns the MOST RECENT " +
          "worker_report OR worker_report_rejected event for `workerSessionId` by default: " +
          "{eventId, ts, taskId, status, summary, prUrl, needs, noChanges, awaiting, warning, " +
          "managerTurnSeqAtReport} (unset fields are absent, never null/empty); pass `eventId` (full " +
          "id or unambiguous 8-char prefix) to read a SPECIFIC earlier report (accepted or refused). " +
          "`error` (a string) means nothing to read, never a partial result: 'not your worker' (the " +
          "session belongs to a different manager's lineage), 'no such worker session ...' (with a " +
          "did-you-mean when the id matches a taskId/opId in YOUR scope), 'no worker_report recorded " +
          "for this worker', an ambiguous-prefix message naming the matching ids, or 'no worker_report " +
          "event matching id …'. Also carries `subagentAttribution` ({agentId, agentType}) when " +
          "correlation POSITIVELY CONFIRMED the report was filed by a sub-agent call rather than the " +
          "worker's own top-level turn (advisory; absent means a genuine main-turn call OR a " +
          "correlation failure, never to be conflated). OVERSIZE: `summary` is never truncated; above " +
          "the SPILL_INLINE_BUDGET_CHARS inline cap (same as every spillable surface here) it is " +
          "written verbatim (UTF-8) to YOUR OWN scratch dir and replaced by {summaryFile, " +
          "summaryChars, note}; at or under the cap it is inline, byte-identical to what was filed.",
        inputSchema: strictShape({ workerSessionId: z.string(), eventId: z.string().optional() }),
      },
      async ({ workerSessionId, eventId }) => {
        const w = selfHealWorkerLink(workerSessionId, "worker_report_get");
        if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
        // Card 36e43a98: also match `worker_report_rejected` — the pending-direction guard's refusal
        // persists the worker's report content on that event (not a `worker_report` one, since the guard
        // returns BEFORE the genuine-report append below ever runs), so without this a refused report was
        // permanently unreachable here even though its content was durably recorded. Kept in the SAME
        // chronological list (not a separate lookup) so "most recent" still means most recent overall.
        const reports = db.listEventsForWorker(workerSessionId).filter((e) => e.kind === "worker_report" || e.kind === "worker_report_rejected");
        if (reports.length === 0) return ok({ error: "no worker_report (or worker_report_rejected) recorded for this worker" });
        let target: OrchestrationEvent;
        if (eventId) {
          const r = resolveIdPrefix(reports, eventId);
          if (r.kind === "ambiguous") return ok({ error: `ambiguous worker_report event id-prefix '${eventId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` });
          if (r.kind === "none") return ok({ error: `no worker_report event matching id ${eventId}` });
          target = r.record;
        } else {
          target = reports[reports.length - 1]!;
        }
        // Card 60b26261: this IS "the manager reads a report" — drop any still-queued
        // `[loom:worker-report]` nudge announcing THIS SAME report (tagged with `target.id` at enqueue —
        // see `workerReport`'s `reportEventId`) so it doesn't ALSO drain later as a wasted turn. Keyed on
        // the report's own event id, never the worker id, so an unread earlier report (e.g. a `progress`
        // filed before this `done`) is left untouched. Best-effort — never let a purge fault block the read.
        if (w.parentSessionId) {
          try { sessions.purgeQueuedWorkerReportNudge(w.parentSessionId, target.id); } catch { /* never block the read */ }
        }
        const detail = target.detail ?? {};
        const summary = typeof detail.summary === "string" ? detail.summary : "";
        const { summary: _omitSummary, ...restDetail } = detail;
        const spill = spillTextIfLarge(managerSessionId, "report-spills", target.id, summary, SPILL_INLINE_BUDGET_CHARS);
        return ok({
          eventId: target.id,
          ts: target.ts,
          taskId: target.taskId ?? null,
          // Explicit, not left for the caller to infer from the presence of `reason`/`queued`/`msgIds`:
          // a refused report was NEVER acted on (the task never moved, no merge happened) — content-wise
          // it's what the worker WOULD have reported, distinct from a genuine landed `worker_report`.
          ...(target.kind === "worker_report_rejected" ? { rejected: true } : {}),
          ...restDetail,
          ...(spill.inline
            ? { summary }
            : {
                summaryFile: spill.file,
                summaryChars: spill.chars,
                note:
                  `summary is ${spill.chars} chars — too large to inline safely, written to ${spill.file} as ` +
                  "plain UTF-8 text. Page it with Read or grep it for a keyword.",
              }),
        });
      },
    );

    server.registerTool(
      "worker_relink",
      {
        description:
          "Explicit self-heal backstop for ONE worker: re-derive its ownership by lineage and repair a " +
          "stale `parent_session_id` in place, WITHOUT a daemon restart. Every other per-worker tool " +
          "already runs this SAME repair automatically " +
          "before it acts, so you normally never need to call this directly — it exists as a standalone " +
          "diagnostic/backstop (e.g. to eagerly repair a worker, or confirm its link status, before " +
          "touching it any other way). Scoped to YOUR OWN lineage ONLY (walks the same recycledFrom-chain " +
          "check every read tool uses) — can never relink a worker belonging to another manager or another " +
          "project. `workerSessionId` accepts the FULL id OR an unambiguous 8-char id-prefix (same " +
          "resolution as tasks_get/worker_spawn's taskId/agent_get) — a bad-form/too-short/unmatched ref " +
          "returns found:false same as a genuinely nonexistent worker, but an AMBIGUOUS prefix (matches " +
          "more than one session) returns a DISTINCT `error` naming the candidate ids instead of silently " +
          "picking one or collapsing into the same found:false a real miss returns. Returns {found, " +
          "wasStale, relinked, parentSessionId} — relinked (and wasStale, always " +
          "equal) is true only if a stale link was actually repaired just now; false with found:true means " +
          "NOTHING was relinked — check `parentSessionId` to tell why: equal to your OWN session id means " +
          "it was already correctly linked, any other id means the worker genuinely isn't yours.",
        inputSchema: strictShape({ workerSessionId: z.string() }),
      },
      async ({ workerSessionId }) => {
        // @decision 92c20eb9 — refuse outright rather than relink-but-report-false; the caller is being
        // retired and no longer owns the fleet to relink anything onto.
        const superseded = callerSupersededError();
        if (superseded) return ok(superseded);
        // Resolve a full id OR an unambiguous 8-char id-PREFIX (mirrors transcript_read's own resolution
        // over db.findSessionsByIdPrefix): the exact-id fast path covers the common case; only a miss
        // falls back to a prefix scan. An ambiguous prefix gets its OWN distinct signal — never silently
        // resolved to either candidate, and never collapsed into the same found:false a genuine miss
        // returns (card ba41b402 defect 2: those two states used to be byte-identical to the caller).
        let before = db.getSession(workerSessionId);
        if (!before) {
          const r = resolveIdPrefix(db.findSessionsByIdPrefix(workerSessionId), workerSessionId);
          if (r.kind === "ambiguous") {
            return ok({
              found: false, wasStale: false, relinked: false, parentSessionId: null,
              error: `ambiguous workerSessionId id-prefix '${workerSessionId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id`,
            });
          }
          if (r.kind === "found") before = r.record;
        }
        if (!before) return ok({ found: false, wasStale: false, relinked: false, parentSessionId: null });
        const fullId = before.id;
        const alreadyLinked = before.parentSessionId === managerSessionId;
        const owned = workerReadableByManager(before);
        const after = selfHealWorkerLink(fullId, "worker_relink");
        return ok({
          found: true,
          wasStale: owned && !alreadyLinked,
          relinked: owned && !alreadyLinked,
          parentSessionId: after?.parentSessionId ?? before.parentSessionId ?? null,
        });
      },
    );

    // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // @decision 641cc62c — a merge/batch op in flight for a task refuses a respawn onto its worktree.
    // @decision 961da6c6 — HARNESS DEFAULT SKIPPED: a codex-incompatible profile falls back to claude.
    // card 47bbdc3f — REVIEW SPAWN (see git/worktrees.ts, sessions/service.ts, worker-prompt.ts).
    // card 548a0c7e — LIVE CAPACITY (see sessions/manager-prompt.ts, sessions/service.ts).
    server.registerTool(
      "worker_spawn",
      {
        description:
          "Spawn a worker: creates an isolated git worktree + branch and starts a worker session in it. " +
          "kickoffPrompt is the canonical param for the kickoff instructions; `kickoff` is an ALIAS (if both, " +
          "kickoffPrompt wins). agentId is REQUIRED and must be an explicit WORKER agent (e.g. Dev/Bugfix/QA/Docs), " +
          "NEVER your own manager agent; a manager/platform-role agent is rejected. agentId accepts the agent's " +
          "id OR its NAME/slug (resolved within your project; a bad value returns a 'did you mean' hint). " +
          "taskId is OPTIONAL: pass it to bind the worker to a board task (moves it to in_progress; accepts the " +
          "full id or an unambiguous 8-char prefix; an ambiguous prefix errors naming the candidates). OMIT it " +
          "for a TASKLESS spawn (an ad-hoc spike/no-commit worker with its own isolated worktree and no card). " +
          "A taskless worker reports via worker_report like a tasked one but never lands in a review lane, so " +
          "retire it yourself with worker_stop once you've read its report; worker_merge_confirm still works on " +
          "it if you want its commits landed (no card moves to done). The one-live-worker-per-task guard applies " +
          "only to a REAL taskId. A SECOND taskId guard refuses while a worker_merge_confirm or merge_batch op " +
          "for that SAME task is in flight, even with NO live worker holding it, because that op is still using " +
          "the identical deterministic worktree a respawn would reuse; the error names the in-flight opId, so " +
          "re-spawn once it settles. The same guard applies to worker_recycle (it reuses the predecessor's " +
          "worktree in place) and in REVERSE: a worker_merge_confirm/merge_batch mint refuses when a " +
          "worker_spawn is in flight for the task or has just claimed its worktree. The claim releases on the " +
          "real op's OWN completion, including an orphaned run a daemon-internal dead-owner sweep evicted " +
          "out from under a now-gone manager. " +
          "CLIENT-TIMEOUT RESILIENT: a fast spawn returns {workerSessionId,branch,worktreePath}; a slow one " +
          "returns {opId,status:\"pending\",taskId}. Poll worker_list (a placeholder row) or RE-CALL " +
          "worker_spawn with the SAME taskId (or omission)/agentId/kickoffPrompt. A TASKED retry is idempotent: " +
          "while in flight it attaches to the same spawn and never throws 'already in flight'. A TASKLESS REVIEW " +
          "retry (same agentId, same `reviewOfWorkerSessionId` or `reviewOfTaskId`, and the same kickoffPrompt) " +
          "is idempotent the same way; a different kickoffPrompt is a NEW review and spawns a new worker. A TASKLESS spawn WITHOUT a `reviewOf*` param has no stable identity and may start a " +
          "second worker (retire the extra with worker_stop). A TASKED or REVIEW " +
          "re-call after it settles, within ~" + sessions.spawnOpRetainMinutes + " min, is answered from the " +
          "ORIGINAL worker with `reused:true` plus `reusedNote`: the kickoff was NOT re-delivered, so use " +
          "worker_message for new direction. Past that window a same-args retry falls through to the " +
          "live-worker guard; read worker_list rather than re-calling blind. " +
          "HARNESS DEFAULT SKIPPED: when the platform/project default harness is codex but the worker's profile " +
          "needs something codex cannot honour (restrictedTools, browserTesting, documentConversion, or " +
          "capabilities), the worker spawns on claude and the result carries `harnessDefaultSkipped:{items,note}` " +
          "(omitted otherwise). " +
          "REVIEW SPAWN: pass EITHER `reviewOfWorkerSessionId` OR `reviewOfTaskId` (resolved to that task's own " +
          "deterministic branch; works after its worker exited): mutually exclusive, optional, orthogonal to " +
          "`taskId` (convention: a TASKLESS spawn, e.g. a Code Reviewer profile). The server resolves the " +
          "reviewed branch + its CURRENT tip and cuts this worker's fresh branch FROM that tip instead of HEAD, " +
          "so its worktree is byte-identical to what's under review; the branch+sha is injected into its " +
          "kickoff. An unresolvable `reviewOf*` id is a hard `{error}`, never a silent HEAD-forked spawn. It is " +
          "a PINNED SNAPSHOT: later pushes to the reviewed branch need a fresh review spawn. The result carries " +
          "`reviewOf:{branch,headSha}` (absent otherwise). " +
          "WASTED-DISPATCH ADVISORY (tasked spawns only): if the card's title appears verbatim (coerced to a " +
          "commit subject as a squash-merge would) as a commit in the mainline's recent history, the result " +
          "carries `shippedMatch:{sha,subject,mainBranch}` plus a `warning`. It NEVER blocks the spawn; verify " +
          "before letting it proceed. " +
          "REUSED-DIRTY-WORKTREE: when the spawn REUSED a worktree retained from a prior hard-stopped or " +
          "rejected-merge attempt that still has uncommitted work, the result carries " +
          "`reusedDirtyWorktree:true` plus `reusedDirtyWorktreeStatus:{statusSummary,fileCount,truncated}`. The " +
          "worktree is NEVER auto-cleaned and the worker's kickoff already carries a reconcile note. " +
          "DISCARDED-ON-RECUT: when the reused worktree's branch had 0 commits ahead of the mainline, Loom " +
          "re-cuts it onto current main before the spawn with a `git reset --hard` that DISCARDS its tracked " +
          "edits. If something was discarded, the result carries `discardedOnRecut:true`, " +
          "`discardedOnRecutStatus:{statusSummary,fileCount,truncated}` (captured before the reset) and " +
          "`discardedOnRecutWarning`. The opposite of REUSED-DIRTY-WORKTREE (the two never overlap): that work " +
          "SURVIVED and needs reconciling; this work is GONE. The kickoff already carries the fact. Absent for " +
          "a fresh, reattached-branch-only, already-clean, or >0-ahead recovery worktree (never recut). " +
          "STALE BRANCH BASE: when the spawn reused a task branch with prior-session commits whose base fell " +
          "behind the mainline, Loom first tries a CLEAN auto-forward (merging the mainline in, never a rebase, " +
          "never past a conflict); on success nothing is surfaced. Otherwise the result carries " +
          "`staleBase:{baseSha,behindBy,changedFiles,truncated}` plus `staleBaseWarning`; the kickoff already " +
          "carries a forward-merge instruction. " +
          "LIVE CAPACITY: a SUCCESSFUL spawn's result carries `capacity:{cap,live,inFlight,free}`: `cap` is the " +
          "project's RESOLVED `maxConcurrentWorkers`, `live` your current live-worker count (INCLUDING the " +
          "worker just spawned), `inFlight` your OTHER spawns still mid-provisioning, `free` = " +
          "`max(0, cap-live-inFlight)`. It is a live read at THIS call; don't hand-transcribe it anywhere that " +
          "outlives the next spawn/retirement; re-read it (or worker_list's `capacity`). `capacity` is `null` if " +
          "that read itself failed after a successful spawn: treat as \"unavailable right now\", never as " +
          "all-zero/no-free-capacity. " +
          "CONCURRENCY-CAP REJECTION: if the cap is full the result is `{error:\"concurrency cap reached (N)\"}` " +
          "PLUS `capQueued:{opId,taskId,queuedAt}`: the intent is recorded as a placeholder row in worker_list. " +
          "WHILE THIS DAEMON PROCESS KEEPS RUNNING it AUTO-FIRES (FIFO) when a slot on this manager frees, or " +
          "re-call worker_spawn with the same args yourself; either clears the marker. To withdraw it, " +
          "`worker_stop({opId})`. ⚠️ IT DOES NOT SURVIVE A DAEMON RESTART OF ANY KIND (a crash, a dev-watch " +
          "reload, a deliberate restart): the queue is in-memory only and a restart silently discards every " +
          "entry. A graceful restart notifies EVERY affected manager/platform what was dropped; a crash or " +
          "dev-watch restart gives no notice. Re-`worker_spawn` by hand after ANY restart if a dispatch you made " +
          "before it still matters.",
        inputSchema: strictShape({
          taskId: z.string().optional(),
          agentId: z.string(),
          kickoffPrompt: z.string().optional(),
          kickoff: z.string().optional(),
          reviewOfWorkerSessionId: z.string().optional(),
          reviewOfTaskId: z.string().optional(),
        }),
      },
      async ({ taskId, agentId, kickoffPrompt, kickoff, reviewOfWorkerSessionId, reviewOfTaskId }) => {
        // A usage-limit refusal carries a STRUCTURED retry-after deadline (PL Auditor finding #7) so the
        // manager can schedule a wake to it instead of guessing (and the daemon also auto-wakes it on
        // hold-clear). Surface `retryAfter` alongside the message — NOT a bare string. A concurrency-cap
        // refusal similarly carries the recorded cap-queued marker — surface `capQueued` alongside the
        // message so the caller knows the intent is now visible in worker_list, not lost. Neither
        // spawnWorkerTracked throws synchronously (a slow/attached call resolves through the registry
        // instead), so both are checked on BOTH the settled-failed result AND a defensive catch below.
        const asUsageLimitOrMessage = (e: unknown) =>
          e instanceof UsageLimitError ? { error: e.message, retryAfter: e.retryAfter }
          : e instanceof CapQueueRejectedError ? { error: e.message, capQueued: e.capQueued }
          : { error: e instanceof Error ? e.message : String(e) };
        // `kickoff` is accepted as an ALIAS for `kickoffPrompt` (card fix(mcp): accept arg-name aliases) —
        // a wrong-but-obvious first call shouldn't eat a failed round-trip.
        const resolvedKickoffPrompt = resolveAlias(kickoffPrompt, kickoff);
        if (resolvedKickoffPrompt === undefined) return ok({ error: "kickoffPrompt (or kickoff) is required" });
        try {
          const r = await sessions.spawnWorkerTracked(managerSessionId, { taskId, agentId, kickoffPrompt: resolvedKickoffPrompt, reviewOfWorkerSessionId, reviewOfTaskId });
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", taskId, note: `still spawning — no need to poll: if it fails before the worker starts, you'll get a [loom:spawn-failed] push naming this opId; otherwise poll worker_list (a pendingSpawn placeholder row) or re-call worker_spawn with the SAME taskId/agentId/kickoffPrompt within ~${sessions.spawnOpRetainMinutes} min of it becoming ready to fetch the result; after that, read worker_list instead.` });
          if (!r.ok) return ok(asUsageLimitOrMessage(r.error));
          const worker = r.value;
          // Card b1fcb6a7: additive-only — omitted entirely on a genuinely fresh spawn (r.cacheHit is
          // absent), so a normal spawn's result is byte-identical to before this field existed. A
          // re-call landing within the retain window is answered from cache: the WORKER already exists
          // and its kickoff was already delivered ONCE, at the original spawn — this call does NOT
          // re-deliver it, so a manager that wants to hand it something new must use worker_message.
          const reused = r.cacheHit
            ? { reused: true, reusedNote: "this worker already existed (re-call within the retain window) — its kickoff was NOT re-delivered; use worker_message for any new direction." }
            : {};
          // Wasted-dispatch advisory (card 7b5944fc): additive-only — omitted entirely on no match, so a
          // non-matching spawn's result is byte-identical to before this field existed.
          const shipped = worker.shippedMatch
            ? {
                shippedMatch: worker.shippedMatch,
                warning: `heads up: this card's title matches merged commit ${worker.shippedMatch.sha} ('${worker.shippedMatch.subject}') on ${worker.shippedMatch.mainBranch} — it may already be shipped; verify before proceeding.`,
              }
            : {};
          // Board card 2250836c: additive-only — omitted entirely when the worktree wasn't reused dirty
          // (fresh spawn, or a reused-but-clean worktree), so a non-dirty spawn's result is byte-identical
          // to before this field existed. The worker's OWN kickoff already carries a reconcile note; this
          // is the manager-facing mirror so it's visible without reading the worker's transcript.
          const dirty = worker.reusedDirtyWorktree
            ? {
                reusedDirtyWorktree: true,
                reusedDirtyWorktreeStatus: worker.reusedDirtyWorktree,
              }
            : {};
          // Board card 13cc2300: additive-only — omitted entirely when nothing was destroyed (fresh spawn,
          // reattached-branch-only worktree, reused-but-already-clean worktree, or a >0-ahead recovery
          // branch that was never recut). DISTINCT from `dirty` above and never merged into it: `dirty`
          // means "survived and is still dirty — go reconcile it"; this means the OPPOSITE — Loom's own
          // pre-spawn re-cut already discarded these tracked edits, so there is nothing left in the tree to
          // reconcile. The worker's OWN kickoff already carries this same fact (worker-prompt.ts's
          // `discardedBlock`); this is the manager-facing mirror so it's visible without reading the
          // worker's transcript.
          const discarded = worker.discardedOnRecut
            ? {
                discardedOnRecut: true,
                discardedOnRecutStatus: worker.discardedOnRecut,
                discardedOnRecutWarning: `heads up: this worktree was reused from a prior attempt, but its branch was 0 commits ahead of the mainline, so Loom re-cut it onto current main BEFORE this spawn — a \`git reset --hard\` that DISCARDED ${worker.discardedOnRecut.fileCount} prior tracked path(s) (see \`discardedOnRecutStatus\`). That prior work is gone, not merely uncommitted — factor it into your review; the worker's own kickoff already knows.`,
              }
            : {};
          // Card 5150fdc2: additive-only — omitted entirely when the branch was never behind, or a
          // clean auto-forward already caught it up, so a non-stale spawn's result is byte-identical to
          // before this field existed.
          const stale = worker.staleBase
            ? {
                staleBase: worker.staleBase,
                staleBaseWarning: `heads up: this branch's base is ${worker.staleBase.behindBy} commit(s) behind the current mainline (forked at ${worker.staleBase.baseSha}) and a clean auto-forward wasn't possible — the worker's kickoff already carries a forward-merge instruction, but factor it into your review.`,
              }
            : {};
          // Review-spawn marker (card 47bbdc3f): additive-only — omitted entirely on a non-review spawn,
          // so a normal spawn's result is byte-identical to before this field existed.
          const review = worker.reviewOf ? { reviewOf: worker.reviewOf } : {};
          // Card 961da6c6: additive-only — omitted entirely unless the fleet's codex default was SKIPPED for this worker
          // (its profile needs something codex cannot honour), so every other spawn's result is byte-identical.
          const harnessSkipped = worker.harnessDefaultSkipped && worker.harnessDefaultSkipped.length > 0
            ? { harnessDefaultSkipped: { items: worker.harnessDefaultSkipped, note: "the fleet default harness is codex, but this worker's profile needs something codex cannot honour, so it was spawned on claude instead — see items." } }
            : {};
          // Card 548a0c7e: live worker-concurrency snapshot ({cap, live, inFlight, free}) — the ONLY
          // caller-visible way this cap was previously observable was by provoking CapQueueRejectedError
          // (see that class's own message). This is the exact moment a manager decides whether to
          // dispatch again, so it's on the SUCCESS response, not just the rejection.
          return ok({ workerSessionId: worker.id, branch: worker.branch, worktreePath: worker.worktreePath, ...shipped, ...dirty, ...discarded, ...stale, ...review, ...harnessSkipped, ...reused, capacity: worker.capacity });
        } catch (e) {
          // Other refusals (paused / over-cap / bad task) stay a bare { error } string — same envelope as
          // the sibling lifecycle tools.
          return ok(asUsageLimitOrMessage(e));
        }
      },
    );

    server.registerTool(
      "worker_revive",
      {
        description:
          "Revive a MERGED worker of yours WITH ITS CONVERSATION CONTEXT to follow up on its own landed commit (a fix, or a small extension of that same work). The old worktree and branch are gone after a merge, so this FORKS the worker's engine conversation (the original transcript is left untouched) into a FRESH worktree + branch cut from the CURRENT mainline, as a NEW worker session bound to a follow-up card. " +
          "`taskId` is REQUIRED: file the follow-up card yourself first — its title becomes the fix's squash-commit subject and its body is the worker's instruction. `note` is optional extra direction. " +
          "The revived worker's first turn tells it that the earlier task merged (naming the landed commit), that every file path in its memory is stale, and which card/branch it now owns. It counts against your worker concurrency cap and is NOT cap-queued (a full cap refuses; retry when a slot frees). " +
          "REFUSED (nothing is created): a session that is not YOUR worker; one that is still live (message it instead); one with no `merge_done` (unmerged — it still has its worktree); a codex-harness worker (codex has no fork primitive); a source whose conversation transcript is missing or rotated (fall back to `worker_spawn` on the follow-up card with the offending commit sha in the kickoff); a `taskId` that is the worker's own MERGED card (reopening it would overwrite its ship-state) or that already has a live worker, is held, or is terminal. " +
          "The fork inherits the WHOLE source conversation, so each revive of a long-lived worker carries more history: for an unrelated follow-up, prefer a fresh `worker_spawn` (project memory carries the knowledge). " +
          "Result: `{workerSessionId, branch, worktreePath, revivedFrom, commitSha, capacity, sourceCtxPct}`; `sourceCtxPct` is the SOURCE session's measured context % (null when unmeasured). The result MAY carry a `contextWarning` string (advisory only, never a refusal) when that % is at or above the project's worker context warn ratio, or when a claude-harness source that completed turns has NO measured context (unknown — check before reviving). A slow spawn returns `{opId, status:\"pending\"}` exactly like `worker_spawn`. The revive is recorded as a `worker_revived` orchestration event ({fromSessionId, toSessionId, taskId, commitSha}).",
        inputSchema: strictShape({ workerSessionId: z.string(), taskId: z.string(), note: z.string().optional() }),
      },
      async ({ workerSessionId, taskId, note }) => {
        try {
          selfHealWorkerLink(workerSessionId, "worker_revive");
          const r = await sessions.reviveWorkerTracked(managerSessionId, { workerSessionId, taskId, note });
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", taskId, note: "still spawning — poll worker_list (a pendingSpawn placeholder row) or re-call worker_revive with the SAME arguments to fetch the result." });
          if (!r.ok) return ok({ error: r.error instanceof Error ? r.error.message : String(r.error) });
          const w = r.value;
          return ok({ workerSessionId: w.id, branch: w.branch, worktreePath: w.worktreePath, revivedFrom: w.revivedFrom, commitSha: w.commitSha, capacity: w.capacity, sourceCtxPct: w.sourceCtxPct, ...(w.contextWarning ? { contextWarning: w.contextWarning } : {}) });
        } catch (e) {
          return ok({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    );

    // Field-provenance pointers for this tool's description below:
    // card 7878e45a — opId short-id-prefix resolution (see cap-queue.ts/service.ts).
    // card dde0ce24 — {stopped:true} only when a live pty genuinely existed and was told to stop.
    // @decision 8882e2ca — kickoffConfirmPendingWarning: the kickoff-confirm window is announcement-only.
    server.registerTool(
      "worker_stop",
      {
        description: "ENDS one of your workers' sessions (graceful Ctrl-C by default, or hard kill) — this is TERMINAL, not a pause: the session is over and cannot resume mid-turn. If what you actually want is to HOLD it — pause it, make it stop what it's doing and wait for you, without ending it — use `worker_redirect` instead; this tool cannot do that. The worktree is retained. Stopping a worker this way also cancels any of its " +
        "pending `wake_me` wakes and bars it from EVERY automatic resume (a due wake, crash recovery, a " +
        "daemon restart's boot-resume) until a human resumes it manually from the app — only that manual " +
        "resume lifts the bar, and only for the epoch it starts; a later worker_stop/kill/auto-retire " +
        "re-arms it. Pass EITHER workerSessionId (a real, already-spawned worker) OR opId (a `cap-queued` placeholder row from worker_list — an intent that was recorded but never actually spawned because the concurrency cap was full) — exactly one is required. `workerSessionId` must be the FULL session id — unlike `opId` below, it does NOT accept a prefix. An unknown id errors \"no such worker session '<id>'\" with a did-you-mean hint; \"not your worker\" means the session belongs to a different manager's lineage. opId accepts the FULL id OR an unambiguous 8-char prefix; an AMBIGUOUS prefix returns `{error: \"ambiguous opId prefix '...' — it matches ...\"}` naming the candidates, never a silent pick. The opId path withdraws the queued intent (no pty yet): `{cancelled:true}` if a matching queued entry was removed, else `{cancelled:false, reason}` (a normal outcome, not an error; check the flag): `\"already-fired\"` (auto-fired once a slot freed), `\"reaped\"` (TTL-reaped), or `\"not-found\"` (wrong opId, or aged out of the registry's bounded memory). A queued entry auto-fires once a concurrency slot frees, for as long as THIS daemon process runs; cancel it BEFORE that if you no longer want it. ⚠️ The queue is in-memory only: any daemon restart discards it silently, so there is nothing left to cancel. The workerSessionId path returns `{stopped:true}` ONLY when a live pty actually existed and was told to stop. `{stopped:false, reason:\"no live pty for this session\"}` means nothing was running; the call still reconciles a stale `live` DB row to `exited`, releasing the per-task one-live-worker mutex so a re-spawn on that task is admitted right after. That path's result may ALSO carry `kickoffConfirmPendingWarning` (string): ADVISORY ONLY, never a refusal, present exactly when this worker's turn-1 kickoff was large enough to earn an EXTENDED plausible-confirm window and it was still open when you stopped it, so a real engine confirmation can still land after this call (a later [loom:redelivery-confirmed] notice names the worker as already-stopped). Absent for a never-started or already-exited worker.",
        inputSchema: strictShape({ workerSessionId: z.string().optional(), opId: z.string().optional(), mode: z.enum(["graceful", "hard"]).optional() }),
      },
      async ({ workerSessionId, opId, mode }) => {
        // @decision 92c20eb9 — refuse the whole tool (both the opId withdrawal and the workerSessionId
        // stop) once the caller is itself superseded by recycle; it no longer owns the fleet.
        const superseded = callerSupersededError();
        if (superseded) return ok(superseded);
        if (!workerSessionId && !opId) return ok({ error: "worker_stop requires either workerSessionId or opId" });
        if (workerSessionId && opId) return ok({ error: "worker_stop takes EITHER workerSessionId OR opId, not both" });
        if (opId) {
          const r = sessions.cancelCapQueuedSpawn(managerSessionId, opId);
          if (r.outcome === "ambiguous") {
            return ok({ error: `ambiguous opId prefix '${opId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` });
          }
          return ok(r.outcome === "cancelled" ? { cancelled: true } : { cancelled: false, reason: r.reason });
        }
        try {
          const w = selfHealWorkerLink(workerSessionId!, "worker_stop");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId!, w));
          return ok(await sessions.stopWorker(managerSessionId, workerSessionId!, mode ?? "graceful"));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_reap",
      {
        description:
          "Reap (kill) any OS process still lingering in one of your workers' worktree — a stuck test " +
          "runner, an escaped/detached vite/esbuild, a zombie left behind after a crash — WITHOUT " +
          "stopping the worker itself. Daemon-executed: the daemon killing its own children never routes " +
          "through Claude Code's own auto-mode safety classifier, so use this instead of asking the " +
          "worker (or yourself) to run a raw `kill`/`taskkill` Bash command that classifier may block. " +
          "STRICTLY SCOPED to processes rooted in that worker's OWN worktree (matched by executable " +
          "path/cwd/command line — never a bare image-name or port match), and it EXCLUDES the worker's " +
          "own live session — a routine reap can never end the worker you scoped it to; use `worker_stop` " +
          "for that. Returns `{killedPids:[]}` on a healthy worktree (nothing to reap) — an empty list is " +
          "success, not a failure.",
        inputSchema: strictShape({ workerSessionId: z.string() }),
      },
      async ({ workerSessionId }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          selfHealWorkerLink(workerSessionId, "worker_reap");
          return ok(await sessions.reapWorkerStrays(managerSessionId, workerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_set_mode",
      {
        description:
          "Drive one of your workers' permission mode to an ABSOLUTE target — the manual recovery override " +
          "for when a worker has landed in (or been pushed into) a bad mode. A worker can NEVER change its " +
          "own mode (Shift+Tab is a human TUI keystroke; ExitPlanMode/EnterPlanMode are disallowed for a " +
          "worker), so messaging it can't fix a bad mode — this is daemon-driven instead. mode is ONE of " +
          "acceptEdits|auto|plan, but `plan` is REJECTED for a worker (or any role that structurally cannot " +
          "self-exit plan mode — ExitPlanMode is disallowed for it): plan mode gates even the worker's OWN " +
          "worker_report tool behind an interactive permission prompt nobody can answer, so pushing a worker " +
          "into plan silently traps it — use a kickoff instruction for 'investigate first' instead. " +
          "(bypassPermissions and anything outside acceptEdits|auto|plan are REJECTED outright — a worker " +
          "must never be escalated out of its sandbox.) A spawned worker already DEFAULTS to `auto`; reach " +
          "for `acceptEdits` only for a rare edits-only worker (`acceptEdits` auto-approves file EDITS ONLY " +
          "— Edit/Write/NotebookEdit — while Bash/`gh`/build/test and any non-allowlisted MCP tool call " +
          "still prompt for confirmation nobody at an unattended worker's TUI can answer, so it stalls). " +
          "Pure keystroke injection: bypasses the busy/turn queue (~0 worker tokens), does not submit a " +
          "turn. Returns the FEEDBACK-VERIFIED landed mode (read off the footer after the cycle settles) " +
          "— may differ from `mode` if the cycle gave up early. `workerSessionId` must be the FULL session " +
          "id (no prefix support). An id matching no session anywhere in your scope errors \"no such " +
          "worker session '<id>'\" with a did-you-mean hint (your own worker ids / taskIds / in-flight op " +
          "ids); \"not your worker\" is reserved for a session that exists but belongs to a different " +
          "manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), mode: z.enum(["acceptEdits", "auto", "plan"]) }),
      },
      async ({ workerSessionId, mode }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          const w = selfHealWorkerLink(workerSessionId, "worker_set_mode");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          const landed = await sessions.setWorkerMode(managerSessionId, workerSessionId, mode);
          return ok({ landed });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // @decision 3e76ecad — the submit-only, writes-nothing-new flush affordance.
    // @decision 760f2874 — a codex worker has no bracketed-paste stranded-composer state at all.
    // @decision 29b3c396 — `recovered` distinguishes an unstuck retry-ladder give-up from still-stuck.
    // @decision ac7884e3 — lastFlushAttribution's gen-match is not causation proof.
    server.registerTool(
      "worker_flush",
      {
        description:
          "The SUBMIT-ONLY affordance for a stranded worker composer: press Enter on this worker's OWN " +
          "composer, WRITING NOTHING NEW. Reach for it when a worker looks stuck holding an already-" +
          "written turn that never got confirmed (a paste landed but the Enter never registered). It is " +
          "your THIRD option beside `worker_message` (APPENDS, compounding an already-oversized buffer) " +
          "and `worker_stop` + respawn (DISCARDS what the worker accumulated). " +
          "GENUINELY NON-WRITING: it only reasserts the paste boundary (zero body bytes) and sends the " +
          "Enter keystroke, so the composer's byte count is unchanged. " +
          "NO-OP ON A CLEAN COMPOSER: a genuinely empty composer returns `{ok:false, " +
          "reason:\"composer-empty\"}`, never a stray bare Enter that could start an empty turn. " +
          "NOT APPLICABLE TO A CODEX-HARNESS WORKER (no bracketed paste, no stranded-composer state): a " +
          "LIVE codex worker reports `{ok:false, reason:\"not-applicable-codex\"}`, distinct from the " +
          "`\"session-dead\"` a genuinely gone worker gets; check `worker_list`/`worker_status` for a " +
          "codex worker's liveness instead. " +
          "⚠️ A REMEDY TO TRY, NOT A GUARANTEED RECOVERY: `confirmed` reports honestly, after a bounded " +
          "wait, whether the Enter landed; `confirmed:false` means this attempt didn't land, not that " +
          "nothing can be done (worker_message/worker_stop remain escalations), and it is no evidence " +
          "for or against respawning. " +
          "`recovered` splits `confirmed:false`: `recovered:true` = this call's retry ladder gave up " +
          "waiting for a confirming hook and cleared busy, re-queuing what was stranded for the " +
          "worker's next natural drain: UNSTUCK, don't keep calling worker_flush. `recovered:false`/" +
          "absent = still unresolved (a real turn may still land the hook, or it's stuck and another " +
          "`worker_flush` or an escalation is worth trying). " +
          "`resumability` (\"dead\"|\"resumable\"|\"unknown\") is a SECOND, independent discriminator: a " +
          "\"dead\" worker makes a submit-only retry moot whatever `ok`/`confirmed` say; read both. " +
          "`lastFlushAttribution` (always present; `null` = no resolution yet or never called) answers " +
          "\"did this flush work?\": once non-null it is `{gen, attributable, reason, resolvedAt}`. " +
          "`attributable:true` (`reason:\"confirmed-while-flush-marker-live\"`) = this flush's targeted " +
          "generation went on to confirm: the best signal available, not physical keystroke proof (it " +
          "can't rule out a concurrent natural retry for the SAME generation). `attributable:false` " +
          "(`reason:\"marker-superseded-before-confirm\"`) = a definitive verdict, not \"unknown\": the " +
          "targeted generation was superseded (a fresh message, heal, redirect, stop) before it " +
          "confirmed. STICKY (only overwritten by a later resolution), so re-calling worker_flush on an " +
          "already-recovered worker is a cheap way to read the latest verdict (the call itself no-ops " +
          "with `composer-empty` on a clean composer).",
        inputSchema: strictShape({ workerSessionId: z.string() }),
      },
      async ({ workerSessionId }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          selfHealWorkerLink(workerSessionId, "worker_flush");
          return ok(await sessions.flushWorkerComposer(managerSessionId, workerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // Field-provenance pointers for this tool's description below:
    // @decision eac3464d — same-sender agent-message coalescing is deliberately bounded.
    // card 085d9422 — the resend auto-join is not unconditional (see service.ts/host.ts).
    server.registerTool(
      "worker_message",
      {
        description: "Send a message to one of your workers. `text` is the canonical param; `message` is accepted as an ALIAS for it — pass either one (if both, text wins). Submitted as a turn if the worker is idle; queued FIFO and delivered on its next turn boundary if it's mid-turn. By DEFAULT a queued message from a DIFFERENT sender is delivered ALONE as its own turn (one-per-turn ACROSS senders), but CONSECUTIVE messages from the SAME sender coalesce into ONE turn, in send order (bounded; a message that failed to confirm delivery is excluded from coalescing). The legacy full-coalesce (all senders mixed) applies only when the human has turned on the daemon-global `coalesceAgentMessages` setting (off by default). `delivered` NEVER changes meaning (true = HANDED OFF as a turn now); on `delivered:false`, `reason` is \"held\" (queued, will land) or \"session-dead\" (the worker is gone: DROPPED, not queued; re-dispatch or recycle instead of waiting). \"held\" is a SUCCESS and also carries `queued:true`, `landsAt:\"next-turn-boundary\"`, `position` (1-based), `busyForMs` (when known) and `msgId` (to correlate with a later durable record). ⚠️ CODEX-SPECIFIC: if a codex session is wedged before it finished booting (see `worker_status`'s `codexBootStuck`), `held` does NOT mean it will land: the text is durably queued but no turn is running to end, so the result carries an `advisory` instead of the ordinary `landsAt`; consider `worker_stop`/`worker_recycle` if it doesn't recover. ⚠️ `delivered:true` is NOT proof the worker ever saw it: it only means the text was handed to the engine as a turn attempt, and the engine's confirmation is asynchronous and can still GIVE UP afterwards. `deliveryState` (always present: `\"handed-off\"|\"queued\"|\"dropped\"`, one-to-one with the outcome) says so explicitly. To find out what actually happened, poll `worker_list`/`worker_status` and check this `msgId` against `directive`/`staleDirective` (delivered but unacknowledged after several of the worker's turns) or `parkedDirective` (Loom stopped auto-retrying; see its `state`). A resend of the SAME content is automatically joined to the original even without `resendOf`, but NOT unconditionally: (a) it matches the exact FRAMED text, which embeds YOUR OWN session id, so if you've been recycled since the original send it breaks; (b) the join window closes the instant Loom itself confirms the original landed, after which a resend is a genuine second turn. A reworded resend is always new. `resendOf` is an OPTIONAL explicit disambiguator (the `msgId`/`rootMsgId` of the earlier directive being re-sent); it doesn't change whether (a)/(b) apply. The result MAY carry a `contextWarning` string when the TARGET worker's live context is at or above this project's warn floor (e.g. \"worker at 64%: recycle it before sending a large round\"), or says so explicitly when the worker is CONTEXT-EXHAUSTED (see `worker_status`'s `contextExhaustedAt`, even with the floor disabled). ADVISORY ONLY: never blocks or alters the send. ABSENT when the worker's context was never measured (codex, or no completed turn yet; null is NEVER read as 0), the warn floor is disabled (ratio 0), or `deliveryState` is \"dropped\". `worker_recycle` keeps the worktree/branch/task if you act on it. `workerSessionId` must be the FULL session id (no prefix support). An unknown id errors \"no such worker session '<id>'\" with a did-you-mean hint; \"not your worker\" means the session belongs to a different manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), text: z.string().optional(), message: z.string().optional(), resendOf: z.string().optional() }),
      },
      async ({ workerSessionId, text, message, resendOf }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          const resolvedText = resolveAlias(text, message);
          if (resolvedText === undefined) return ok({ error: "text (or message) is required" });
          const w = selfHealWorkerLink(workerSessionId, "worker_message");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          return ok(sessions.messageWorker(managerSessionId, workerSessionId, resolvedText, resendOf));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // card 99339bcd — the directive projection tracks a redirect on EITHER the held or immediate path.
    server.registerTool(
      "worker_redirect",
      {
        description:
          "This is the HOLD tool — reach for it whenever your intent is hold · pause · stop what you're " +
          "doing · wait for me · don't do X · abandon that approach, or any other \"change course NOW\" " +
          "steer, including telling a worker to simply STOP and wait. It is NOT the same as `worker_stop` " +
          "(which ENDS the session outright) — this one interrupts the worker's CURRENT turn and REPLACES " +
          "its entire pending direction with this ONE instruction, delivered as its next turn, while the " +
          "session stays alive for you to resume it once you've decided what's next. Before you use it: " +
          "VERIFY WHAT THE WORKER IS ACTUALLY BUILDING before you hold/stop it. Check its real state " +
          "(e.g. its working tree via `git status`, not just a busy flag or your own tool-call log); an " +
          "unnecessary hold can abandon or clobber correct in-progress work. CONTRAST with " +
          "worker_message, which is ADDITIVE and NON-interrupting (queues behind the current turn); " +
          "prefer it for ordinary, non-urgent direction and reach for this tool only when you truly need " +
          "to interrupt now. CAUTION: the interrupt may land MID-EDIT, leaving the working tree partly " +
          "changed, so phrase `text` so the worker FIRST reconciles/inspects its working tree (e.g. " +
          "`git status`, finish or revert the half-done edit) BEFORE acting on the new direction. " +
          "Messages already queued for the worker are discarded (superseded), but 'queued' means Loom's " +
          "own pending FIFO, NOT the worker's terminal composer: this tool cancels the in-flight turn " +
          "(a single Esc) and replaces the QUEUE; it does not clear text already sitting in the " +
          "composer. If the worker is wedged by a stranded PASTE (unconfirmed, non-zero " +
          "`composerDirtyLen`), `discarded:0` only means the queue was empty, not that the composer is " +
          "clean, and this redirect's text can land ON TOP of the stranded text. For a stuck COMPOSER " +
          "use `worker_flush` first, and if it doesn't confirm after repeated tries escalate to " +
          "`worker_recycle` (keeps the worktree/branch/task) rather than this tool. " +
          "Returns {delivered}: true if it went out as a turn immediately (worker was idle, no Esc " +
          "fired), false if queued to land right after the interrupt clears. UNLIKE worker_message, " +
          "`delivered:false` here is NOT a plain FIFO hold: it carries `interrupting:true` and " +
          "`landsAt:\"after-interrupt\"` (not `\"next-turn-boundary\"`): the worker's current turn is being " +
          "cut short with an Esc right now and the redirect lands the instant that settles. Also " +
          "carries `position`, `busyForMs` and `msgId` like worker_message. " +
          "⚠️ Like worker_message, `delivered:true` is NOT proof the worker ever saw it (the engine's " +
          "confirmation is asynchronous and can still GIVE UP; see worker_message for `deliveryState`). " +
          "worker_list/worker_status's `directive`/`staleDirective`/`parkedDirective` projection tracks a " +
          "redirect on EITHER path (held or immediate; both carry a correlatable msgId). Whichever of " +
          "message or redirect was sent most recently is the ONE directive tracked: a redirect always " +
          "supersedes an outstanding queued message, and a later worker_message supersedes an " +
          "outstanding (even parked) redirect. " +
          "`text` is the canonical param; `message` is accepted as an ALIAS (if both, text wins). The " +
          "result MAY carry a `contextWarning` string when the TARGET worker's live context is at or " +
          "above this project's warn floor (e.g. \"worker at 64%: recycle it before sending a large " +
          "round\"), or says so explicitly when the worker is CONTEXT-EXHAUSTED (see `worker_status`'s " +
          "`contextExhaustedAt`, even with the floor disabled). ADVISORY ONLY: never blocks or alters " +
          "the redirect. ABSENT when the worker's context was never measured (codex, or no completed " +
          "turn yet; null is NEVER read as 0), the warn floor is disabled (ratio 0), or `deliveryState` " +
          "is \"dropped\". `worker_recycle` keeps the worktree/branch/task if you act on it. " +
          "`workerSessionId` must be the FULL session id (no prefix support). An unknown id errors " +
          "\"no such worker session '<id>'\" with a did-you-mean hint; \"not your worker\" means the " +
          "session belongs to a different manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), text: z.string().optional(), message: z.string().optional() }),
      },
      async ({ workerSessionId, text, message }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          const resolvedText = resolveAlias(text, message);
          if (resolvedText === undefined) return ok({ error: "text (or message) is required" });
          const w = selfHealWorkerLink(workerSessionId, "worker_redirect");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          return ok(sessions.redirectWorker(managerSessionId, workerSessionId, resolvedText));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "inbox_pull",
      {
        description:
          "Pull (return AND clear) every queued inbound message in YOUR inbox — worker reports and Loom " +
          "notifications that arrived while you were mid-turn and are waiting to be delivered. Use it when " +
          "you've ALREADY handled work proactively (e.g. you read a worker's worker_transcript and merged it): " +
          "those reports otherwise sit queued and later surface as a redundant wasted turn (coalesced into one). " +
          "Pulling consumes them in one shot so they won't re-surface; the underlying events stay recorded. " +
          "Returns {messages: string[]} (FIFO order, empty if your inbox is clear). If you DON'T pull, Loom " +
          "still delivers them the normal way — this is an optional fast-drain, not required.",
        inputSchema: strictShape({}),
      },
      async () => {
        try {
          return ok(sessions.pullManagerInbox(managerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager→human Requests object (card 8701bdbb, generalized by card 695ebab0) ---------------
    // ask (question_ask) is NON-BLOCKING by design: it inserts a 'pending' row and returns immediately
    // so an autonomous manager keeps orchestrating the rest of its fleet instead of stalling on a human
    // reply. The human answers it OUT OF BAND (the human-only REST endpoint in gateway/server.ts — the
    // web UI for that is a separate child B), which ALSO enqueues a one-time push nudge into this
    // manager's own pty (reusing the existing enqueueStdin(kind:"agent") rail — see gateway/server.ts).
    // pull (question_pull) is the manager's own pickup: it atomically reads+consumes every 'answered'
    // question so a durable answer survives a daemon restart and is still pullable after resume.
    server.registerTool(
      "question_ask",
      {
        description:
          "Ask the HUMAN something you need them for — NON-BLOCKING: creates a durable, answerable " +
          "request and returns IMMEDIATELY, so you keep orchestrating the rest of your fleet instead of " +
          "blocking this turn on a reply. `title`+`body` frame the ask (`body` is the canonical param; " +
          "`detail` — platform_escalate's name for the same concept — is accepted as an ALIAS for it, " +
          "pass either one, if both body wins). `type` picks the shape (defaults " +
          "to \"decision\"): \"decision\" — `options` is an OPTIONAL array of choices for the human to " +
          "pick between (omit for a pure blocker — free-text note only) and `recommendation` is an " +
          "OPTIONAL suggested answer shown as a nudge, not enforced. \"input\" — a freeform-text ask, no " +
          "options. \"notice\" — an FYI/status update that needs NO answer: it lands in the inbox in its OWN " +
          "terminal 'notice' state — NEVER 'pending', NEVER 'answered', NEVER returned by question_pull, and no " +
          "push nudge (that only fires for a real human answer). Rate-limited per agent lineage (a human-only, " +
          "per-project cap you cannot raise) — exceeding it REFUSES loudly, naming the limit; consolidate " +
          "repeated status updates into fewer notices. A notice is FYI only: anything the owner must answer " +
          "or DO needs the matching type, since a notice is never pulled back. A notice that also passes " +
          "`action`/`fulfillmentTarget` is still filed but the result carries an `advisory` string (those " +
          "fields are ignored on a notice); owner actions described only in the body are NOT detected, so " +
          "pick the type deliberately. \"permission\" — ask the human to authorize/deny an " +
          "irreversible/outward/spend action; `action` (REQUIRED) describes it, `scope` (\"once\"|\"standing\", " +
          "optional) is the requested grant lifetime, `expiresAt` (optional ISO timestamp) a requested expiry. " +
          "This is an ask/answer channel, not a second gate: it blocks nothing, so if the action must WAIT on " +
          "the answer, hold it yourself. Scope/expiry are your ASK-TIME REQUEST only; the human may grant " +
          "different or none (see question_pull's permission-entry shape). ADVISORY ONLY: Loom persists and " +
          "surfaces the decided grant (flagging it once expired) but never enforces, blocks or revokes it — " +
          "read the answer and honor it yourself. OPTIONAL " +
          "`fulfillmentTarget: {profileId, key, expectedValue?}` (\"permission\" only) declares a " +
          "LIVE-CHECKABLE profile field that would prove the authorized human-only write actually happened (an " +
          "approval is an AUTHORIZATION, not evidence the write landed), so the read side " +
          "(question_pull/requests_list/task_request_get) can tell the difference. `key` must name a real " +
          "Profile field; `expectedValue`, if given, is the exact value that counts as fulfilled (omit for a " +
          "\"no longer at its empty/off default\" presence check). It NEVER performs or enables the write — the " +
          "field stays human-only; it only tells the read side WHAT to observe. Omit it and fulfilment reads " +
          "\"unknown\" (see question_pull for the {state, detail} shape). \"credential\" — ask for a secret " +
          "(API key/token) under a NEVER-ECHO model: you NEVER receive the plaintext, only an ack once it's " +
          "provided; `envVar` (optional) names the env var/config key you'd like it stored under. It is NOT " +
          "auto-injected into any session; wiring it in is a separate human-only step. " +
          "`taskId` (optional) softly links this to a board task. `supersedes` (optional): the questionId of a " +
          "still-PENDING ask of yours that this new ask replaces — atomically cancels it via the SAME machinery " +
          "as `question_cancel` (your own agent lineage only; pending-only), landing `cancelled` with a reason " +
          "linking the new ask. The NEW ask is filed regardless of whether the supersede succeeds: if the named " +
          "ask was already answered/cancelled, unknown, or isn't yours, the cancel is refused (an answer the " +
          "human already gave is NEVER discarded) and the failure is reported in the response's `supersede` " +
          "field. You'll get a one-time push nudge when the human answers; call question_pull to fetch it. " +
          "Returns {questionId} — or, when `supersedes` was passed, {questionId, supersede: " +
          "{cancelled:true, questionId} | {error}}. A recycle predecessor stuck past its own settle timeout " +
          "(every OTHER fleet tool refused) is let through HERE ONLY, and the response ALSO carries {note} " +
          "naming the stuck successor + the human action that resolves it; such a question is auto-CANCELLED if " +
          "that successor later reaches ready on its own. OPTIONAL `attachments: [{path, label?}]` — files to " +
          "show the human alongside this ask (every type, including \"notice\"). `path` MUST be an ABSOLUTE " +
          "path under one of: the project repo root, this project's worker worktrees, work dir, vault root, or " +
          "registered multi-repo `repos[]` paths; a relative path is refused, as is any path under LOOM_HOME. " +
          "`label` defaults to the file's basename; kind/size/image dimensions/availability are DERIVED " +
          "server-side from the file itself. The whole call is rejected (nothing filed) if any path is outside " +
          "the allowed roots, doesn't exist, is a directory, or the count/size exceeds this project's " +
          "human-set caps.",
        inputSchema: strictShape(QUESTION_ASK_INPUT_SHAPE),
      },
      async (input) => {
        // @decision 92c20eb9 — a question filed in the settle window keeps session_id = predecessor
        // forever (reparentQuestions is a one-shot UPDATE at recycle time); see that record's own
        // section for what that breaks on the successor's side.
        // @decision 92c20eb9 — card ca0111a3: question_ask is the ONE tool carved out of the superseded
        // refusal below, and ONLY for the exact unresolved-settle-timeout window; every other refused
        // tool stays refused. Never widen this carve-out to any other tool on this surface.
        const unresolvedSuccessor = currentUnresolvedSettleSuccessor(db, managerSessionId);
        if (!unresolvedSuccessor) {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
        }
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const built = buildQuestionAsk(input, { sessionId: managerSessionId, projectId, db, role });
        if ("error" in built) return ok({ error: built.error });
        // Resolve+copy attachments and insert the NEW ask BEFORE superseding the old one (see
        // applySupersede's doc — the ordering, not a transaction, is what guarantees a failure never
        // loses the owner's prior pending ask).
        const finalized = await finalizeQuestionAsk(db, projectId, built.question, input.attachments);
        if ("error" in finalized) return ok({ error: finalized.error });
        const { question } = finalized;
        const supersede = input.supersedes
          ? applySupersede(db, managerSessionId, input.supersedes, question)
          : undefined;
        // Event-emit twin (attention-push signal source, Lead fork 2b) — additive, no existing consumer
        // (alert-webhook's events[] allowlist, web attention) lists this new kind, so this is inert for them.
        // Card c0c9ca4a: shared with the Platform Lead's own question_ask (mcp/platform.ts) via
        // appendQuestionAskedEvent — see that helper's own doc.
        appendQuestionAskedEvent(db, managerSessionId, question);
        // Card 788ed7f4: filing a Request is a disposition — clear any open "owner message left without a
        // disposition" episode for THIS session, by occurrence alone (no content matching).
        db.clearPendingOwnerMessage(managerSessionId);
        const result: { questionId: string; supersede?: typeof supersede; note?: string; advisory?: string } = { questionId: question.id };
        if (supersede !== undefined) result.supersede = supersede;
        const advisory = noticeOwnerActionAdvisory(input);
        if (advisory) result.advisory = advisory;
        // @decision 92c20eb9 — card ca0111a3: confirm to P why this call was let through and what to
        // actually put in the ask, reusing the SAME hint text retiredCallerMessage shows it elsewhere.
        if (unresolvedSuccessor) result.note = unresolvedSettleEscalationHint(unresolvedSuccessor);
        return ok(result);
      },
    );

    server.registerTool(
      "question_pull",
      {
        description:
          "Pull (return AND consume) every ANSWERED request you've asked via question_ask — your " +
          "requests-inbox pickup. A \"notice\" entry is NEVER returned here — it completes immediately at " +
          "ask time, with nothing to pull back. Each entry carries {questionId, title, type, ...}: a \"decision\"/" +
          "\"input\" entry has {chosenOption, note} (chosenOption is one of the options you offered, or " +
          "null); a \"permission\" entry has {approved, note, scope, expiresAt, lapsed, fulfillment} — " +
          "`scope`/`expiresAt` are the human's ACTUAL decided grant (null/null if they never chose one, " +
          "e.g. an older answer, or a denial), and `lapsed` is true only once `expiresAt` is set AND in " +
          "the past. ADVISORY ONLY: this is a display signal for YOU to check — Loom itself never " +
          "enforces, blocks, or revokes a standing grant, so re-read `lapsed` (e.g. after a recycle) " +
          "rather than assuming a prior 'standing' answer still holds. `fulfillment: {state, detail}` — " +
          "an APPROVAL IS AN AUTHORIZATION, NOT EVIDENCE THE HUMAN-ONLY WRITE IT AUTHORIZES ACTUALLY " +
          "HAPPENED; this reports whether it was OBSERVED, recomputed fresh on EVERY read (never cached, " +
          "so it self-corrects the moment the write lands): `state` is one of — \"unknown\" (you never " +
          "declared a `fulfillmentTarget` at ask time; today's default, unconditionally), \"unwritable\" " +
          "(a target was declared but can NEVER be observed — a bad profile key or a since-deleted " +
          "profile; `detail` names which), \"not_yet_done\" (a target was declared and checked, but the " +
          "live value doesn't match yet — a MEASURED false, never to be confused with \"unknown\"), or " +
          "\"fulfilled\" (it matches). See question_ask's `fulfillmentTarget` param for how to opt in; a \"credential\" entry has {ack} — NEVER " +
          "the secret itself. Pulling CONSUMES an entry (flips it to 'consumed') so it won't be returned " +
          "again — call this when you reach the point the request was blocking, or after the push nudge " +
          "tells you one was answered. Returns {questions: [...], remaining}: `remaining` is a count of " +
          "OTHER answered-but-not-yet-fetched requests — NEVER lost, NEVER consumed, still 'answered' " +
          "and still re-nudged. This happens ONLY when a single pull's answers would together be too " +
          "large to return safely; ordinary pulls always return everything in one call (remaining:0). " +
          "When remaining>0 a `note` also tells you to call question_pull again to fetch the rest — do " +
          "so; a still-'answered' request is not returned yet, but a still-'pending' one (never answered) " +
          "never will be — keep orchestrating and check back later for that case instead.",
        inputSchema: strictShape({}),
      },
      async () => {
        // Scoped by AGENT LINEAGE, not this exact session id (card f88e91f0) — so a fresh (non-recycle)
        // successor manager on the SAME agent still sees decisions its predecessor filed, not just a
        // recycle successor (which reparentQuestions already handles as a fast path).
        const asker = db.getSession(managerSessionId);
        if (!asker) return ok({ error: "session not found" });
        // card 91fef05a: BOUNDED, NO-LOSS pull — see pullQuestionsForAgent's own doc. `remaining` rows
        // stay exactly 'answered' (never touched here), so their push-nudges stay live too.
        const { items, consumedIds, remaining } = pullQuestionsForAgent(db, asker.agentId, new Date().toISOString());
        // Purge any OTHER still-queued answer-nudge for a question this same pull just consumed — a
        // multi-answer batch enqueues one nudge per answer, but this pull drains them all atomically, so
        // every nudge past the first is now stale (card bbc46336 follow-up). Does not touch the nudge for
        // whichever question drained AS this turn (it already delivered — never queued), NOR any nudge
        // for a `remaining` row this pull deliberately left 'answered'.
        if (consumedIds.length > 0) {
          sessions.purgeAnsweredQuestionNudges(managerSessionId, consumedIds);
        }
        const note = remaining > 0
          ? `${remaining} more answered request(s) exist but didn't fit this pull's inline budget — they stay 'answered' (not lost, not re-nudged); call question_pull again to fetch them.`
          : undefined;
        return ok(note !== undefined ? { questions: items, remaining, note } : { questions: items, remaining });
      },
    );

    // question_cancel (card feat(orchestration): question_cancel + dismiss) — the missing exit from a
    // moot/superseded ask: before this, a pending Request could ONLY leave the human's inbox by being
    // answered, so a re-asked-with-fresher-info question_ask left its predecessor sitting pending forever.
    // Agent-lineage-scoped exactly like question_pull/requests_list({mine:true}) — see
    // questionTool.ts's cancelQuestionForAgent, shared verbatim with the Lead surface (mcp/platform.ts) so
    // the ownership check + error shaping can never drift between the two callers.
    server.registerTool(
      "question_cancel",
      {
        description:
          "Cancel a request YOU asked via question_ask that's still PENDING — for a moot/superseded ask " +
          "(e.g. you're re-asking with fresher information) so it doesn't sit in the human's inbox forever. " +
          "Scoped to YOUR OWN agent lineage — you can never cancel a request asked by another agent. Only a " +
          "still-'pending' request can be cancelled: an already-'answered'/'consumed' one is REFUSED — " +
          "cancelling can never discard an answer the human already gave, so if it's answered you're told " +
          "to call question_pull instead, and if the answer races in between your decision and this call " +
          "landing, this fails the same way rather than clobbering it. Never hard-deletes — a cancelled " +
          "request lands in a terminal 'cancelled' state, retained in the human's Requests history with " +
          "your `reason`. `questionId` is required; `reason` is optional but recommended (shown in the " +
          "human's history). Returns {cancelled:true, questionId} or {error}.",
        inputSchema: strictShape({ questionId: z.string(), reason: z.string().optional() }),
      },
      async ({ questionId, reason }) => ok(cancelQuestionForAgent(db, managerSessionId, questionId, reason)),
    );

    // question_amend (card 5ea0153c) — update a still-PENDING ask IN PLACE instead of forcing a
    // cancel-and-refile: a pending request has by definition not been answered, so there is no answer to
    // invalidate. Agent-lineage-scoped exactly like question_cancel — see questionTool.ts's
    // amendQuestionForAgent, shared verbatim with the Lead surface (mcp/platform.ts) so the ownership check
    // + error shaping can never drift between the two callers. Fires a `question_amended` event (mirrors
    // question_ask's own `question_asked`) so the SAME notification machinery (attention-push) that pushed
    // the original ask re-notifies with the amended wording, instead of the row updating silently
    // underneath a stale push — the human sees the AMENDMENT, never a new row.
    server.registerTool(
      "question_amend",
      {
        description:
          "Update a request YOU asked via question_ask that's still PENDING — IN PLACE, instead of " +
          "cancel-and-refiling it as a new row. Use this when you have fresher information for an ask the " +
          "human hasn't answered yet: a pending request has by definition not been answered, so there is " +
          "no answer to invalidate. Scoped to YOUR OWN agent lineage — you can never amend a request asked " +
          "by another agent. Only a still-'pending' request can be amended: an already-'answered'/" +
          "'consumed'/'cancelled' one is REFUSED (call question_pull instead if it was just answered). " +
          "`title`/`body`/`options` are each OPTIONAL — an omitted field keeps its current value; at least " +
          "one must be given. `options` (an array; omit or pass empty to clear it) can only be amended on " +
          "a type:\"decision\" request — every other type never carries options. The human sees the " +
          "AMENDMENT, not a new row — it's re-surfaced via the same push nudge a fresh ask gets. Returns " +
          "{amended:true, questionId} or {error}.",
        inputSchema: strictShape({
          questionId: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          options: z.array(z.string()).optional(),
        }),
      },
      async ({ questionId, title, body, options }) => {
        const result = amendQuestionForAgent(db, managerSessionId, questionId, { title, body, options });
        if ("amended" in result) {
          db.appendEvent({
            id: randomUUID(), ts: new Date().toISOString(), managerSessionId,
            kind: "question_amended", detail: { questionId: result.questionId, title: result.title },
          });
        }
        return ok(result);
      },
    );

    // @decision 308259e5 — never resolve a pending request this way with agent-authored text; the note is
    // always server-captured owner text. Never cancel-and-refile a conversationally-answered question_ask.
    //
    // @decision ca341979 — never scan the whole owner-turn window for a match, and never concatenate
    // multiple owner turns into one string; always take the single most-recent turn (`[0]`) alone.
    server.registerTool(
      "question_resolve",
      {
        description:
          "Mark a still-PENDING request YOU asked via question_ask as ANSWERED, using the OWNER'S OWN " +
          "words from their most recent reply — for when the owner answers conversationally instead of " +
          "using the web Requests UI. You do NOT supply the answer text: the `note` recorded is always " +
          "the exact, server-captured text of the owner's current turn, or (if the current turn isn't " +
          "owner-authored) their single most recent owner-authored turn — never something you write or " +
          "paraphrase. This is what lets you resolve your OWN question without reopening the human-only " +
          "answer boundary. Refused if there is no owner-authored turn at all yet this session (nothing " +
          "to attest), if a reply typed directly in the terminal raced an in-flight agent turn and wasn't " +
          "captured (ask the owner to repeat it once nothing else is in flight, or use the web Requests " +
          "UI), if the request isn't yours (own agent lineage only) or isn't still 'pending', and " +
          "for type:\"credential\" (a secret must go through the secure REST answer flow, never chat " +
          "text). `chosenOption` is REQUIRED for type:\"permission\" (must be \"authorize\" or \"deny\"), " +
          "optional-but-validated for a \"decision\" that offers `options` (must be one of them), and " +
          "must be OMITTED for a question with no offered options — the owner's reply stands alone as " +
          "the note either way. Prefer this over question_ask-then-question_cancel whenever the owner " +
          "has already answered live in this chat. For type:\"permission\": unlike the REST inbox answer " +
          "path (which captures the human's chosen scope/expiry structurally into decidedScope/" +
          "decidedExpiresAt), this path has no structured scope/expiry input — the chat composer is " +
          "freeform prose — so a chat-resolved permission always surfaces decidedScope/decidedExpiresAt " +
          "null and lapsed false; the owner's actual scope/expiry (if they stated one) lives only in " +
          "`note` prose. A successor reading this answer must read `note` for a chat-answered grant's " +
          "lifetime rather than assuming no scope was given. Returns {resolved:true, questionId, " +
          "chosenOption, note} or {error}.",
        inputSchema: strictShape({ questionId: z.string(), chosenOption: z.string().optional() }),
      },
      async ({ questionId, chosenOption }) => {
        const { ownerText, raceDiscarded } = resolveOwnerTextForQuestionResolve(pty, managerSessionId);
        const result = resolveQuestionForAgent(db, managerSessionId, questionId, chosenOption, ownerText, raceDiscarded);
        // Card 788ed7f4: resolving a pending Request is a disposition — clear any open "owner message
        // left without a disposition" episode for THIS session, by occurrence alone (no content matching).
        if (!("error" in result)) db.clearPendingOwnerMessage(managerSessionId);
        return ok(result);
      },
    );

    // requests_list (card 988bb585 follow-up): a NON-CONSUMING, board-wide read of YOUR OWN project's
    // Requests — the gap between question_pull (consumes, answered-only, no taskId filter) and
    // task_requests_list/task_request_get (task-scoped only). Mirrors the Platform Auditor's cross-project
    // requests_list (mcp/audit.ts) — same filters, same per-type answer shaping (questionTool.ts's
    // auditRequestItem/questionAnswerByType) so the credential never-echo guarantee can't drift between the
    // two read surfaces — but scoped SERVER-SIDE to this manager's own project (no projectId param; a
    // manager can never read another project's requests, unlike the Auditor's platform-wide read).
    // card 5ea0153c — `stale` is a soft flag over the request's current routing target (see db.ts/
    // questionTool.ts/audit.ts). card 40f4cae9 — the `fields:[...]` projection (see db.ts/server.ts).
    server.registerTool(
      "requests_list",
      {
        description:
          "List Requests (decision/input/permission/credential asks) for YOUR OWN project, board-wide: " +
          "the non-consuming complement to question_pull (which returns only ANSWERED requests and " +
          "CONSUMES them). Survey pending/answered/consumed requests, including ones asked with no " +
          "taskId or by a predecessor manager. NON-CONSUMING: reading never drains or flips state. " +
          "Returns {items, total, returned, offset, hasMore}: each item is {id, projectId, " +
          "loomSessionId, filedBySessionId, agentId, taskId, type, title, state, createdAt, answeredAt, " +
          "consumedAt} plus an answer summary by type: chosenOption/note for decision|input; " +
          "approved/note/scope/expiresAt/lapsed/fulfillment for permission (see question_pull for " +
          "`fulfillment: {state, detail}`; an approval is an authorization, not evidence the human-only " +
          "write happened; recomputed on every read); ack ONLY for credential (NEVER the secret; a " +
          "pending row's answer fields read null). `loomSessionId` is the CURRENT routing target and " +
          "MUTATES on a manager/Lead recycle, so it does NOT identify the original filer; " +
          "`filedBySessionId` is the immutable filer (null on a row predating the field). `stale` is " +
          "true only for a still-'pending' row whose CURRENT routing target isn't live: a SOFT flag, " +
          "never an auto-cancel (amend it with question_amend or cancel it with question_cancel " +
          "yourself); always false for answered/consumed/cancelled/notice. `total` is the FULL " +
          "matching count; `hasMore` says whether `items` was truncated. Filters (all optional, " +
          "AND'd): state (pending|answered|consumed|cancelled|notice; \"cancelled\" = withdrawn via " +
          "question_cancel/dismiss, never an answer; \"notice\" = a self-terminal FYI never answered), " +
          "type (decision|input|permission|credential|notice), includeConsumed (default false; folds " +
          "in already-consumed AND cancelled requests plus every notice, dismissed or not; without it " +
          "a notice stays in the list until a human dismisses it in the Inbox (opening it does not " +
          "remove it), then drops out; an explicit " +
          "state:\"consumed\"/\"cancelled\"/\"notice\" always shows those), mine (default false; true " +
          "narrows to requests filed by YOUR OWN agent lineage, the scope question_pull consumes from, " +
          "so a successor session still sees them; it lists notices too, which question_pull never " +
          "returns). `mine:true` is the dedup read for a scheduled/autonomous agent: before a new " +
          "question_ask, check whether you or a predecessor already filed an equivalent request that's " +
          "pending or answered-but-unpulled. " +
          `Newest-first (createdAt DESC). Bounded to ${DEFAULT_REQUESTS_LIST_CAP} rows by default (see ` +
          "`hasMore`); pass an explicit limit/offset to page past it. `fields:[...]` (same contract as " +
          "`tasks_list`'s) projects each item to ONLY the given top-level keys, e.g. " +
          "fields:[\"id\",\"type\",\"title\",\"state\"]; others are genuinely ABSENT, unknown names are " +
          "silently ignored, `id` is NOT auto-added.",
        inputSchema: strictShape({
          state: z.enum(QUESTION_STATES).optional(),
          type: z.enum(QUESTION_TYPES).optional(),
          includeConsumed: z.boolean().optional(),
          mine: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          fields: z.array(z.string()).optional(),
        }),
      },
      async ({ state, type, includeConsumed, mine, limit, offset, fields }) => {
        const asker = db.getSession(managerSessionId);
        if (!asker?.projectId) return ok({ error: "no project for this session" });
        const all = db.listQuestionsForAudit({
          projectId: asker.projectId, state, type, excludeConsumed: !includeConsumed,
          agentId: mine ? asker.agentId : undefined,
        });
        // Card 40f4cae9: `pageRequests`'s own total/hasMore are already computed above (over the FULL
        // `all` set, before this slice) — projecting the sliced-and-shaped items afterwards never touches
        // either count, same ordering rule `tasks_list` established.
        const paged = pageRequests(all, { limit, offset }, DEFAULT_REQUESTS_LIST_CAP);
        const items = pickFields(paged.items.map((q) => auditRequestItem(q, db)), fields);
        return ok({ ...paged, items });
      },
    );

    // card a187fc9b — FAILURE SEMANTICS: see this handler's own "Card a187fc9b" comments below.
    server.registerTool(
      "worker_recycle",
      {
        description: "Recycle a worker whose context has grown too large: closes it and spawns a FRESH worker in the SAME git worktree (code state kept) seeded with your handoff summary (intent kept). Same task + branch; gen+1. Read worker_transcript first and write the summary. REFUSED while a worker_merge_confirm or merge_batch op for this SAME task is still in flight — recycleWorker reuses the predecessor's worktree IN PLACE (no createWorktree call), so a fresh pty would otherwise race that op's own union-merge/gate against the identical directory; the error names the in-flight opId, and retrying once it settles proceeds normally. `handoffSummary` is the canonical param; `continuationPrompt` (the sibling recycle_me tool's name for the same concept) is accepted as an ALIAS — pass either one (if both are given, handoffSummary wins). FAILURE SEMANTICS: the predecessor is hard-stopped BEFORE the fresh successor is ever spawned, so a failed recycle does NOT leave the old worker alive — never re-message it or wait for it to respond. On that failure the result names what actually happened: `predecessorStopped:true`, `worktreePath`/`branch` plus `worktreeExists` (a live `fs.existsSync` check on that path, taken at the moment this call fails — not an assumption), `cancelledWakes` (the predecessor's own pending wakes, cancelled so a due one can't resurrect it), and `queuedMessages` (what became of anything still queued for it — human/agent turns are forwarded to you as a separate `[loom:recycle-failed-queue]` notice, counted here as `forwardedToManager`/`contentCut`/`notShown`; moot Loom-operational nudges are counted as `droppedAsMoot`; anything durable is `durableUndelivered`, safe but not delivered). `recovery` names your next move: re-call `worker_recycle` on this SAME workerSessionId (verified — recreates a fresh successor without touching the worktree) is the SAFER retry; `worker_spawn` on the same task also works (same worktree/branch), but `createWorktree`'s reuse path re-cuts a branch with 0 commits ahead of main via a destructive `git reset --hard` (`recutStaleReusedBranch`, gated by `mayRecutOntoMain`) — flagged via `discardedOnRecut` when it happens, never silent, but avoidable by preferring the recycle retry, which never calls that path at all. This enrichment is BEST-EFFORT and requires the teardown to have genuinely run DURING this call — an error thrown before the predecessor was ever touched (a bad workerSessionId, a blank handoffSummary), or a stale recycle_failed event left over from an EARLIER failed call on the same predecessor, both fall back to the plain `{error}` shape, since neither means this call itself did any of the above. `workerSessionId` must be the FULL session id (no prefix support). A workerSessionId matching no session anywhere in your scope errors \"no such worker session '<id>'\" with a did-you-mean hint (your own worker ids / taskIds / in-flight op ids); \"not your worker\" is reserved for a session that exists but belongs to a different manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), handoffSummary: z.string().optional(), continuationPrompt: z.string().optional() }),
      },
      async ({ workerSessionId, handoffSummary, continuationPrompt }) => {
        const superseded = callerSupersededError();
        if (superseded) return ok(superseded);
        const summary = resolveAlias(handoffSummary, continuationPrompt);
        // Falsy check (NOT `=== undefined`) — restores the PRE-alias behavior where an empty string was
        // rejected at the tool boundary with this clear message, rather than passing through to the
        // service's own blank-guard (a confusingly different "must not be blank"/"not your worker" error
        // depending on link state). Unlike the 6 NEW aliases below (whose canonical was already a required
        // z.string() that always accepted ""), this tool's canonical/alias pair predates that convention —
        // restoring it here is a bugfix, not a behavior change worth re-litigating (CR minor 1).
        if (!summary) return ok({ error: "handoffSummary (or continuationPrompt) is required" });
        // Card a187fc9b, Code Review fix: captured BEFORE calling recycleWorker, so the catch below can
        // tell "this call's own teardown wrote a NEW recycle_failed event" apart from "a STALE event from
        // an earlier failed call on this same predecessor is still the latest one" — `recycledFrom`
        // matching `workerSessionId` alone can't distinguish those two, since a retried recycle on the
        // SAME predecessor that throws EARLY the second time (before any teardown) would otherwise still
        // see the first attempt's own event and misreport its counts as this call's own.
        const priorFailedEventId = db.getLatestEventForManagerByKind(managerSessionId, "recycle_failed")?.id;
        try {
          const w = selfHealWorkerLink(workerSessionId, "worker_recycle");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          const fresh = await sessions.recycleWorker(managerSessionId, workerSessionId, summary);
          return ok({ newWorkerSessionId: fresh.id, gen: fresh.gen, recycledFrom: fresh.recycledFrom });
        } catch (e) {
          const message = (e as Error).message;
          // Card a187fc9b: recycleWorker's own catch (sessions/service.ts) already hard-stopped the
          // predecessor, cancelled its wakes, and forwarded/dropped/counted its queued messages BEFORE
          // rethrowing — a bare {error} here left a manager unable to tell that apart from "nothing
          // happened yet, the old worker is still live". Recover the SAME facts recycleWorker's own
          // `recycle_failed` event already recorded (this manager's most recent one — an indexed point
          // lookup, not a history scan) instead of re-deriving them here.
          const failedEvent = db.getLatestEventForManagerByKind(managerSessionId, "recycle_failed");
          const detail = failedEvent?.detail as
            | {
                recycledFrom?: string; cancelledWakes?: number; carriedForwarded?: number; carriedDropped?: number;
                carriedContentCut?: number; carriedTruncated?: number; carriedDurableUndelivered?: number;
              }
            | undefined;
          // Only trust it when (a) it's a GENUINELY NEW event minted during THIS call — never the same
          // row `priorFailedEventId` already named, which would mean this call threw before any teardown
          // ran and the "latest" recycle_failed is really a leftover from an earlier attempt — and (b) it
          // actually names THIS call's own predecessor, guarding a same-manager race with an unrelated
          // recycle's own failure event. Both checks are needed: (a) alone would still misattribute a
          // stale event for the SAME predecessor; (b) alone would still misattribute a stale event when
          // no other recycle has run in between.
          if (failedEvent && failedEvent.id !== priorFailedEventId && detail?.recycledFrom === workerSessionId) {
            const predecessor = db.getSession(workerSessionId);
            const worktreePath = predecessor?.worktreePath ?? predecessor?.cwd ?? null;
            return ok({
              error: message,
              predecessorStopped: true,
              worktreePath,
              branch: predecessor?.branch ?? null,
              // OBSERVED, not asserted: a real fs.existsSync check at the moment of this failure, since
              // recycleWorker's failure path never itself removes the worktree — but nothing guarantees
              // some other actor hasn't (a manual cleanup, a concurrent worker_merge_confirm elsewhere).
              worktreeExists: worktreePath ? fs.existsSync(worktreePath) : null,
              cancelledWakes: detail.cancelledWakes ?? 0,
              queuedMessages: {
                forwardedToManager: detail.carriedForwarded ?? 0,
                droppedAsMoot: detail.carriedDropped ?? 0,
                contentCut: detail.carriedContentCut ?? 0,
                notShown: detail.carriedTruncated ?? 0,
                durableUndelivered: detail.carriedDurableUndelivered ?? 0,
              },
              recovery:
                "the predecessor is already stopped, not waiting for you — worker_recycle again on this SAME workerSessionId is the safer retry (recreates a fresh successor without touching the worktree); worker_spawn on the same task also works (same worktree/branch reused), but if that branch has 0 commits ahead of main createWorktree's reuse path re-cuts it with a destructive `git reset --hard` (surfaced via discardedOnRecut if it happens, never silent).",
            });
          }
          return ok({ error: message });
        }
      },
    );

    // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id):
    // @decision 13fc5227 — a HELD branch is reviewed and landed by its late-range, not the fork-point diff.
    // @decision bbccf470 — this call records the reviewed tip (commit-after-review-must-not-land-unreviewed).
    // @decision 6f13746c — mergeGate cadence/interval semantics (same record as my_context's own pointer).
    // @decision 5150fdc2 — STALE-BASE BACKSTOP: auto-forward attempt before the gate runs.
    // @decision b88704bb — PROSPECTIVE COMMIT SUBJECT preview.
    // @decision 7a1a76e9 — tasklessSubjectPreview derives from the branch's own tip commit.
    // @decision a32533a1 — BATCH-BOUND PREVIEW: merge_batch commits branch subjects verbatim, unrewritten.
    // @decision 591906ae — NON-TIP COMMITS: ownNonTipCommitSubjects covers what a batch landing can hide.
    server.registerTool(
      "worker_merge",
      {
        description:
          "STEP 1 of the merge gate: review a worker's branch diff. For a HELD (batch- or solo-retained) branch the result also carries `lateRange` {assembledTip, liveTip, filesChanged, insertions, deletions, files, commitSubjects, commits[{sha, subject, emptyOnMain}], note} — the NON-MERGE commits added after a merge landed the branch (assembledTip..liveTip) that main does not reach, and the diffstat of those commits cherry-picked onto current main; this is exactly what `worker_merge_confirm` lands instead of the fork-point diff (`emptyOnMain` = the commit changes nothing on current main and is skipped). If a commit does not apply cleanly onto main, a merge in the range carries content of its own or merges a branch that is not on main, or the range cannot be determined, a HELD BRANCH `warning` says so. This call ALSO records the tip it reviewed (its contract is stated once, in `worker_merge_confirm`'s description)." +
          "The result also carries `mergeGate` " +
          "({cadence, interval, ungatedSinceLastPass, nextLandingGated, gateOwed}, READ-ONLY; see " +
          "`my_context`) so you can see whether confirming will run the gate or land ungated. " +
          "By DEFAULT returns a bounded DIFFSTAT (changed files with per-file +/- and totals), so it " +
          "won't overflow on a large change; a renamed file's entry carries `renameFrom` (the real " +
          "pre-rename path). Pass fullDiff:true to ALSO get the full unified patch (unbounded; review " +
          "the diffstat first). Pass `files` (exact/substring path matches, reliable for nested paths: " +
          "'service.ts' matches 'src/sessions/service.ts') and/or `pathGlob` (e.g. 'src/mcp/*.ts'; a " +
          "bare pattern with no '/' such as '*service.ts' matches anywhere, as '**/*service.ts'; one " +
          "containing '/' scopes to that literal directory) to scope BOTH diffstat and patch to " +
          "matching file(s): pull one file's hunk at a time on a large change. A pathGlob matching 0 of " +
          "the changed files returns a `hint` listing them. Omit both for the full diff. A patch still " +
          "too large to inline is written to a scratch file (UTF-8, Read-pageable with offset/limit) " +
          "and the response carries patchFile/patchChars + a note instead. No merge happens; you must " +
          "review before confirming (there is no worker-side merge). STALE-BASE BACKSTOP: if the " +
          "branch is missing commits current main carries, the result carries `behindMain:<count>` and " +
          "a 'STALE BASE' clause in `warning`: confirm's union-merge will try to forward it before the " +
          "gate, but review with that in mind (a stale-based rebuild can silently overwrite or " +
          "conflict with a later change on main). Absent when caught up. PROSPECTIVE COMMIT SUBJECT: " +
          "for a worker with a task the result carries `commitSubject`, the EXACT subject that will be " +
          "committed if you confirm (your only chance to see it; confirm never re-shows it). If the " +
          "card's raw title was not already Conventional-Commits form it also carries `rawTitle` and " +
          "`coerced:true` (a type was inferred, bracket-mapped or defaulted to `chore:`; not a verdict " +
          "that the title is wrong). Retitle the card BEFORE confirming if `commitSubject` doesn't " +
          "describe what shipped. A taskless worker instead gets `tasklessSubjectPreview`, derived from " +
          "this branch's own tip commit. NECESSARY but NOT SUFFICIENT: it does not mean a QUEUED merge " +
          "announces the landed subject elsewhere (see `worker_merge_confirm`). BATCH-BOUND PREVIEW: " +
          "`commitSubject`/`tasklessSubjectPreview` preview ONLY the SOLO squash path; `merge_batch` " +
          "never rewrites or coerces, it commits each branch's OWN commit subjects verbatim. For EVERY " +
          "worker the result also carries `ownTipSubject` (the tip subject, UNCOERCED, exactly what a " +
          "batch would commit) and `ownTipSubjectConventional` (whether it is already Conventional-" +
          "Commits form), so you can title-check before routing into `merge_batch`; absent only when " +
          "the branch has no readable commit. NON-TIP COMMITS: for a branch with MORE THAN ONE commit, " +
          "`merge_batch` lands every earlier commit verbatim too, so the result carries " +
          "`ownNonTipCommitSubjects` (every OTHER commit subject, `<mergeBase>..<branch>`, oldest-" +
          "first, bounded; `ownNonTipCommitSubjectsTruncated:true` = older entries dropped) plus " +
          "`ownNonTipCommitSubjectsConventional` (whether every RETURNED subject is Conventional; when " +
          "truncated it covers only the visible entries). Absent for a single-commit branch. " +
          "`workerSessionId` must be the FULL session id (no prefix support) and resolves against your " +
          "OWN lineage even for an EXITED/archived worker (the common done-awaiting-review case). An " +
          "unknown id errors \"no such worker session '<id>'\" with a did-you-mean hint; \"not your " +
          "worker\" means the session belongs to a different manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), fullDiff: z.boolean().optional(), files: z.array(z.string()).optional(), pathGlob: z.string().optional() }),
      },
      async ({ workerSessionId, fullDiff, files, pathGlob }) => {
        try {
          const w = selfHealWorkerLink(workerSessionId, "worker_merge");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          return ok(await sessions.reviewWorkerMerge(managerSessionId, workerSessionId, { includePatch: fullDiff === true, files, pathGlob }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // UNION-MERGED (card 361520a0, merging main forward): main independently rewrote this SAME
    // description string to add the GATE OUTPUT ON A PASS TOO (card a1a8c5c4) paragraph while this
    // branch was adding the cancelled:true sentence — a naive "ours"/"theirs" resolution would have
    // silently dropped one side's whole addition. Both survive below: the cancelled:true sentence sits
    // where it did on this branch (right after ALREADY_MERGED/STAGE_EMPTY_RETRY), and the outputTail
    // paragraph sits where it did on main (right after the gate-rejection gateDetail sentence).
    //
    // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id) — most carry a real docs/decisions or
    // docs/adr record under the same id; follow it there for the full rationale.
    //
    // @decision 13fc5227 — a HELD branch is landed by its late-range, not the fork-point diff.
    //
    // @decision bbccf470 — the REVIEWED-TIP RULE contract.
    //
    // @decision 6f13746c — mergeGate cadence/interval; GATE INTERVAL skip semantics.
    //
    // @decision bd9a483b — OPTIONAL SAFETY NET ungatedLandingCheckCommand on an interval-skipped landing.
    //
    // @decision 2f0b2e57 — never a PASS line, from any tier, mistaken for a failure.
    //
    // card 8fb09f4c — failingTestCount is a floor, not a complete account, unless exactly 1 (see
    // worker_merge's own provenance comment above for the same id).
    //
    // @decision 6ffee3e2 — the failing step's output tail is content-selected, not positional.
    //
    // @decision b798e706 — ADMISSION-TIME RE-UNION re-derives the gate base at actual admission.
    //
    // @decision 92e960d1 — the per-repo merge-admission guard frees at sibling GATE finish, not squash.
    //
    // card c24dd48a — closing the sibling-squash gap needs holding the admission guard across squash too.
    //
    // @decision 99a1cf6f — a stale-base rejection is never served from cache, regardless of re-confirms.
    //
    // @decision 975c774b — DIRTY-WORKTREE REFUSAL: the gate verdict must describe a commit, not a tree.
    //
    // @decision a1a8c5c4 — GATE OUTPUT ON A PASS TOO: outputTail now covers both dominant outcomes.
    //
    // @decision db9b0130 — INERT-DIFF SKIP for a docs-only changed-path set.
    //
    // card 7a1a76e9 — the queued path's commitSubject reaches every surface, not just the sync return
    // (see worker_merge's own provenance comment above for the same id).
    //
    // @decision a2873f7e — GATE STEP DURATIONS widened to the rejection return too.
    //
    // @decision e2b6f900 — GATE CONCURRENCY triple on a pass too, not just a rejection.
    //
    // @decision c06f876a — a cached REJECTION is no longer replayed once main moves.
    //
    // @decision 615967c5 — FRESH-MINT ANNOUNCEMENT / CURRENT IDENTITY enrichment (this id is cited twice
    // below: once for the gate-queue-wait exception, once for the servedFromCache/supersededBy fields).
    //
    // @decision fb525c31 — a canonical-checkout-state refusal is never cached.
    //
    // @decision 7e5b23e7 — a confirmed-kill quarantine on a mutating merge git call.
    //
    // @decision 8d8fa497 — extends the quarantine shape to the squash/commit step itself.
    //
    // @decision 9f5ae011 — the squash cleanup's own confirmed-kill-timeout retry (soloMergeTransient).
    //
    // card afa80698 — on a preLanded re-confirm, a non-empty squash stage means main's content diverged
    // (most often a deliberate revert) — resolves landedContentDiverged:true, never cached or replayed.
    //
    // card fc7827e7 — the landed-content-diverged squash's own cleanup can itself collide with the
    // quarantine/transient exceptions above; whichever of THOSE two wins, the diverged-content fact
    // survives only in that winning exception's own reason/detailText prose, never a third flag.
    //
    // @decision c30952c1 — worktree-gone-landing-unconfirmed / worktree-missing-at-admission.
    //
    // @decision 7f86c02f — an UNKNOWN confirm-merge outcome is never cached.
    //
    // card 6325bc74 — the one exception: a NotYourWorkerError classifies not-your-worker instead,
    // also never cached (see orchestration/pending-ops.ts).
    //
    // card 4aedde84 — CACHE-HIT ANNOUNCEMENT: servedFromCache is always positive, never inferred from the
    // absence of supersededBy (see orchestration/pending-ops.ts).
    //
    // @decision cc9bce38 — a merged result is not always a finalized one (branchRetainedWarning).
    //
    // @decision f2b4d684 — a HELD branch with no late commit: the Loom-Landed-Tip trailer itself
    // could not be verified, so the confirm fails closed rather than asserting a late commit exists.
    //
    // Card 035fb673 — the description's own "WORKTREE-GC WARNING" covers a worktree-removal retry that
    // came back wedged, left-on-disk, or needsHuman (distinct from the nested-repo case above it).
    server.registerTool(
      "worker_merge_confirm",
      {
        description: "STEP 2: after reviewing, confirm the merge. HELD BRANCH: a branch a merge retained (commits added after it landed) is landed by exactly the NON-MERGE commits of `assembledTip..liveTip` that main does not reach (shown as `lateRange` by `worker_merge`), cherry-picked onto current main — so a late self-revert lands and a worker's own merge of main never hides it; a commit that does not apply cleanly, a merge in the range that carries content of its own or merges a non-main branch, or a range that cannot be determined (assembledTip unreadable or not an ancestor of the tip), REFUSES the confirm with guidance (never auto-resolved) and the branch stays held; a held branch in a repo with no gateCommand is refused too. The reviewed-tip rule below still applies unchanged. REVIEWED-TIP RULE: `worker_merge` records the tip you reviewed (latest review per branch+repo; a recycled successor shares it). Confirm REFUSES if the tip moved since (`merged:false`, never-cached `reviewedTipMoved`; re-review with `worker_merge`, then re-call). Checked at confirm start and again at the squash against the pinned landing tip. Loom's own union-merge of main is not a move. A never-reviewed branch is not refused; an unreadable tip fails closed. `merge_batch` applies the same rule at assembly.(If the project's human-only `orchestration.mergeGate` switch is \"off\", the gate command is SKIPPED: the merge still refuses on conflicts/dirty trees but lands without a gate and the result carries `skipped:true` + `skipReason:\"gate-disabled\"` + a warning — that is NOT a pass. The setting is read when a confirm STARTS: a merge already queued keeps its setting (gate_cancel it and re-confirm to apply a flip). GATE INTERVAL (human-only `orchestration.mergeGateInterval` = N, only while the gate is off): N landings may go ungated (`skipReason:\"gate-interval\"`), then the landing that would exceed N runs the REAL gate (fail-closed; a pass resets the counter; a red owes the next landing a gate). RED SELF-CHECK: an interval skip is also refused (the real gate runs instead) while the latest settled `run_gate` verdict on this branch's OWN tip (read from durable events, so it survives a daemon restart) is a failure; a later green on the same tip clears it, a cancelled or errored self-check carries no verdict and never blocks, and a NEW commit is a new tip this does not cover. To land such a tip ungated anyway, pass `overrideReason` (non-empty, bounded): it is RECORDED on the merge result, the merge event, the gate history row and the `[loom:merge-done]` nudge, is NOT authenticated, and never counts as a pass. With the gate switched off nothing is refused or forced — the result only carries a `redSelfCheckNote` warning. Read`mergeGate` on `worker_merge`/`my_context` for the counter; the result's `mergeGateNote` states \"ungated X/N\". On an interval-skipped landing only, a repo MAY set `ungatedLandingCheckCommand`: a short check run against the branch's own worktree (main not merged in) before the squash. RED refuses the landing (`ungated_landing_check_failed`/`ungated_landing_check_stale`, never cached) without counting as a gated pass; GREEN or unset proceeds as an ordinary ungated landing. It is recorded as its own `gate_history`/`gate_status` row (`landingCheckOnly:true`), distinct from the real `gateCommand`.) Runs the build/DoD gate, and ONLY if green merges the branch as ONE squash commit, removes the worktree, and moves the task to done. The staged set is re-derived at confirm time (never a stale snapshot), so a valid +N-commit branch merges on the FIRST call. Fail-closed: a failed gate or a conflict leaves the repo untouched and the worktree retained. A genuine no-op is distinguishable via emptyKind: ALREADY_MERGED (branch already in main → finished idempotently, merged:true) vs STAGE_EMPTY_RETRY (no diff to merge → merged:false, worktree retained). A THIRD, distinct outcome is `cancelled:true`: a manager's `gate_cancel` withdrew this confirm while it was still QUEUED, before the gate ever ran — `merged:false`, but this is NOT a rejection (no gate ran, nothing to diagnose, nothing held against the branch); `cancelKind` names how, and the async signal is `[loom:merge-cancelled]`, never `[loom:merge-failed]`. Re-call worker_merge_confirm when ready to retry for real. A gate rejection (reason:\"build gate failed\") carries `gateDetail: {phase, failedStep, failingTest, failingTestCount, stderrTail, exitCode, signal, timedOut, steps}` — the failing phase (typecheck|test|build) if derivable, the failed step's command, and the matching line of the highest-priority tier if extractable (never a line recording a PASS). `failingTestCount` is how many lines matched that tier (`undefined` iff `failingTest` is): `1` means `failingTest` is a complete account (still run the file to confirm); `>1` means it is only the LAST of several, so NEVER size a fix from `failingTest` alone. The failing step's output tail is content-selected: ~4KB of trailing output, or up to ~16KB when it recovers a per-file assertion body from a `test-daemon.mjs` `FAILURES:` block, so you can tell a real failure from a flake or a build break without re-running blind. The same detail is folded into the `[loom:merge-rejected]` notification. ADMISSION-TIME RE-UNION: the gate's base is re-derived when the merge is admitted off the gate queue, so a main that moved during the wait (out-of-band commit, cross-project noise, a sibling whose squash already landed) is re-unioned instead of self-aborting. It does NOT reliably cover a same-repo sibling whose squash lands after its gate: a merge admitted right behind it can still self-abort with `gate_base_invalidated` (benign; a plain re-confirm re-gates). If the re-union itself fails, the confirm is REJECTED with `union_conflict_at_admission` (a real conflict) or `union_merge_failed_at_admission` (a non-conflict git failure: investigate git/filesystem) — squash never reached, repo untouched, worktree retained; rebase/resolve. `gate_base_invalidated` is never cached (it depends on main, not the branch): a plain re-confirm genuinely re-gates, no `forceRemoveWorktree:true` needed (that flag is the only way to re-run an ORDINARY cached verdict, a real pass or test-failure rejection). DIRTY-WORKTREE REFUSAL: the gate runs in the worker's live worktree, stamped before every gate spawn and again at settle. A tree already dirty when the gate is about to spawn is refused up front (`reason` \"worktree has uncommitted changes when the gate was about to spawn\", gate never runs); a tree whose stamp CHANGED across the run has its PASS refused (nothing squashed) with `gateWorktreeDirty:{phase:\"before-gate\"|\"during-gate\",detail}` and `[loom:merge-rejected]` reason `gate_worktree_dirty`; a FAIL keeps its ordinary rejection with the same flag. These (`\"worktree-dirty\"`) are never cached: commit or discard the uncommitted changes, then re-confirm. An edit created and removed entirely inside the gate window is not detectable. A PASS is also refused when the BRANCH TIP moved after the gate spawned: nothing squashed, `gateTipMoved:{phase:\"pre-squash\"|\"in-lock\",gated,live}` + `[loom:merge-rejected]` reason `gate_tip_moved`, never cached (outcome `\"gate-tip-moved\"`); re-confirm re-gates the new tip. A FAIL on a run whose tip left the gated commit and came back (T1→T2→T1) is likewise never cached (`gateRoundTripFail:true`, outcome `\"gate-tip-moved\"`). A PASS is likewise refused (`gateTipMoved`) when the worktree HEAD was not the branch tip when ANY contributing gate run spawned (detached off the branch), reported as `gateTipMoved.headOffBranch:true` with the detached HEAD in `gateTipMoved.worktreeHead`; a `run_gate` self-check on such a worktree settles `headCurrent:false` and is never reused (reuse refusal `head-off-branch`). A REUSED green's squash is pinned to the tip the reuse proof saw: a commit landing before the squash lock is refused in-lock (`gateTipMoved.phase:\"in-lock\"`, `gateRan:false`). `gateTipMoved.live` is always the live tip; `unverifiedWhy` (`reflog`|`branch-read`) says why a could-not-verify refusal could not verify. A gate FAIL whose final run left the gated commit and did NOT come back, started on a detached HEAD (`gateIdentityVoid:true`), or whose reflog could not be read (`gateTipUnverified:true`, \"could not verify\", not \"moved\") is cached under an identity no later tip can equal: a re-confirm re-gates and announces identity-mismatch. GATE OUTPUT ON A PASS TOO: a plain gate-fail rejection or a plain successful merge (not reused, not gateless, not one of the rarer post-gate-pass rejections) also carries a top-level `outputTail` (~4KB on a PASS; up to ~16KB content-selected on a FAIL), persisted and readable later via `gate_status(opId)`. A rarer post-gate-pass rejection (merge conflict, `gate_base_invalidated`, orphaned/stage-empty no-op) returns no `outputTail` even though a gate ran: absence is NOT proof no gate ran; `gateExtended` (present, possibly `false`, whenever a gate spawned) is. With NO gateCommand configured, a successful merge carries {warning:\"unverified: ...\"}: it landed but no build/DoD gate checked it. INERT-DIFF SKIP: a gate IS configured but was skipped because the branch's ENTIRE changed-path set is under `docs/`: carries `gateRan:false` (no `reusedOpId`) plus {warning:\"merge gate skipped: ...\"}; one path outside that allowlist runs the full gate, fail-closed. A merge that created a NEW squash commit (not the ALREADY_MERGED no-op) echoes `commitSubject`, the subject `worker_merge` previewed at step 1; the common queued path returns `pending` instead, and the async `[loom:merge-done]` nudge (` subject=\"...\"`) and the settled `gate_status(opId)` carry it. GATE STEP DURATIONS: a merge that ran the gate carries `gateSteps: [{step, durationMs, status}, ...]` (one per `&&`-separated step; same shape as a rejection's `gateDetail.steps`), echoed in `[loom:merge-done]` as a `steps (diagnostic only — not a pass/fail signal)` line. Diagnostic only: durations swing with host load and a suite that silently runs less finishes EARLY, so never assert or threshold on one. GATE CONCURRENCY: the same two dominant outcomes also carry `gateCap`/`concurrentGates`/`concurrentGatesMax`, persisted and readable via `gate_status(opId)`; read its description for the span caveat (`concurrentGates` understates, `concurrentGatesMax` overstates) before comparing runs. NESTED-REPO SAFETY: after a successful merge the worktree is force-removed, but if it contains a nested git repository (own `.git`, possibly real unpushed work) the removal is REFUSED and the worktree RETAINED intact — the merge already landed; the result carries {warning} naming the nested path(s). Move/push that content out and re-confirm, or pass forceRemoveWorktree:true if it is disposable (default false); that call always runs for real, so it also retries the nested-repo case immediately. WORKTREE-GC WARNING: if the removal itself came back wedged (a held OS handle survived a force-kill), left-on-disk (transient handle-lag), or needsHuman (wedged past a long give-up bound), the result carries {warning} naming the path and what to do; non-blocking, the merge already landed. CLIENT-TIMEOUT RESILIENT: a fast confirm returns {merged,...,opId}; a slow one returns {opId,status:\"pending\",workerSessionId}. Rather than polling, wait for the async `[loom:merge-done]`/`[loom:merge-rejected]`/`[loom:merge-failed]` nudge, which carries the SAME opId (plus worker/task). For the answer sooner, poll the read-only `gate_status(opId)` (never starts a run) or worker_list's `pendingMerge`. RE-CALLING with the SAME workerSessionId is always safe at ANY delay: a re-call while the gate/merge is still running attaches to that SAME in-flight op, and a re-call after it settles, at the SAME commit, gets the SAME cached verdict instead of a fresh gate run (worker_list's `pendingMerge.state` may have reverted by then; cosmetic). If the branch has new commits, or canonical main advanced since the gate ran (a cached REJECTION is not replayed after main moves, so \"red because main was broken, main got fixed, re-call\" re-gates by itself), a re-call gates for real. A branch behind main is advanced by this call's own pre-gate union-merge, so a later re-call gates the new base. NEVER CACHED (a plain re-confirm at the same commit is a REAL re-attempt) — second exception: a refusal caused by the CANONICAL CHECKOUT's state (staged dirt, or dirty/untracked overlap on a path the branch touches: `canonical_staged_dirt`/`canonical_dirty_overlap`, at admission or squash) or by the squash failing (`conflict`/`merge_failed`); after the human cleans the checkout the gate re-runs (a re-call while still dirty is refused fast at admission, before any gate). Branch-level empty-merge refusals (`STAGE_EMPTY_RETRY`, orphaned-work) still replay from cache. THIRD: the canonical repo being QUARANTINED (an unconfirmed kill on one of this confirm's mutating merge git calls) resolves `{merged:false, quarantined:true, reason}` with reasons `\"quarantined\"` (entry-time backstop, before any union-merge or gate lane), `\"union_merge_quarantined\"` (the pre-gate union-merge), `\"union_merge_quarantined_at_admission\"` (the same, at admission inside a held gate slot), or `\"solo_merge_quarantined\"` (the squash/commit step; the squash MAY or may not have been attempted, so the result's own `reason` is the authority and names any staged residue a human must clear first). The canonical repo then refuses EVERY merge until a human clears it (`GET /internal/merge-quarantine/list`, then `POST /internal/merge-quarantine/clear-by-path`; the project-resolved `/clear` works only if a registered project's repo resolves to this entry); for every other quarantine reason the squash is never reached and the repo is untouched; worktree retained in all cases. `quarantined:true` is never cached: after the human clears it, a plain re-confirm is a REAL re-attempt. FOURTH: the squash/commit step's cleanup can itself be CONFIRMED kill-timed-out (retried once, only when it can first safely remove a leaked `.git/index.lock`), resolving `{merged:false, soloMergeTransient:true, reason}` with reason `\"solo_merge_transient\"`. Unlike a quarantine it does NOT latch the repo against other merges, but the canonical repo may carry STAGED uncommitted content from this squash, possibly with the leaked `.git/index.lock`; the `reason`/`detailText` name the checks to run (`git diff --cached`, whether `.git/index.lock` exists) before re-confirming, which refuses at the entry-time staged-dirt check until a human clears both. `soloMergeTransient:true` is never cached. FIFTH: on the preLanded re-confirm path (content already proven landed on main) the squash must stage nothing; a non-empty stage means main no longer carries that content (most often a human or the Platform Lead REVERTED the landed commit) and resolves `{merged:false, landedContentDiverged:true, reason}` with reason `\"landed_content_diverged\"`: the staged squash is reset, no commit lands, repo and worktree untouched (rarely the reverted content stays STAGED beside unrelated dirt the cleanup declined to discard; the `reason`/`detailText` say which and name `git diff --cached`). A human must decide: abandon this worker/card, or re-cut the branch if re-landing is intended. It is never cached (outcome `\"landed-content-diverged\"`); refusing again while main stays diverged is correct. If that squash's own cleanup goes quarantined or transient, the THIRD/FOURTH flag and outcome (`quarantined:true`/`\"quarantined\"`, `soloMergeTransient:true`/`\"solo_merge_transient\"`) wins and the result never carries both flags; the diverged-content fact survives only in that `reason`/`detailText` (\"previously-landed content is no longer on main\"), so read the text: clearing the quarantine or residue alone is not enough, a human must still decide abandon vs re-cut. SIXTH: the worker's worktree directory is gone AND no landing of this branch on main could be confirmed (lookup retried once) resolves `{merged:false, worktreeGoneLandingUnconfirmed:true, reason}` (`\"worktree-gone-landing-unconfirmed\"`); nothing touched. SEVENTH: the worktree vanished DURING the gate-queue wait, found at the admission re-union, resolves `{merged:false, worktreeMissingAtAdmission:true, reason}` (`\"worktree-missing-at-admission\"`). Neither is cached: if the worktree is permanently gone every re-confirm refuses identically until a human recreates it or re-tasks the work; if transient, a re-confirm can finish. EIGHTH: every throw this confirm can produce classifies as `\"unknown\"` (async `[loom:merge-unknown]`, never `[loom:merge-failed]`) except a `NotYourWorkerError` (`\"not-your-worker\"`); whether or not race-recovery ran, an `\"unknown\"` is inconclusive about the branch's real state and never cached in EITHER cache: a plain re-confirm re-attempts recovery and the gate. ANNOUNCING A FRESH GATE RUN: a call (pending or settled-fast) that ran a genuinely fresh gate carries `supersededBy: \"identity-mismatch\"|\"main-advanced\"|\"forced\"|\"genuinely-new\"`: `main-advanced` = the same commit's verdict was earned against an older mainline tip (carries `cachedVerdictMainTip`/`currentMainTip`); `identity-mismatch` = a cached verdict's identity didn't match (observed, not a cause: main advancing, a sibling's squash and a new worker commit all look the same); `forced` = you passed forceRemoveWorktree:true; `genuinely-new` = no cached verdict in THIS daemon process (the cache is process-local, so a restart also yields it). When known it also carries `cachedVerdictIdentity` and `currentIdentity`. CACHE-HIT ANNOUNCEMENT: a settled result served from the cache ALWAYS carries a positive `servedFromCache: true` plus a `note` naming the replayed opId, its identity when known, and that `forceRemoveWorktree:true` is the only path that re-runs an unchanged commit. `servedFromCache` and `supersededBy` never both appear: check `servedFromCache` directly, never infer a replay from `supersededBy` being absent. To force a RE-RUN of the SAME commit (retrying a flake, or finishing a nested-repo cleanup) pass forceRemoveWorktree:true: a one-shot that ALWAYS runs for real, bypassing any cached verdict. A MERGED RESULT IS NOT ALWAYS A FINALIZED ONE: the worker is alive between the squash and the cleanup, so a commit it makes in that window is NOT on main (never gated or reviewed). When finalize sees the tip moved from the tip that landed, it RETAINS the branch and worktree; the result stays merged:true with `branchRetainedWarning` (also in `warning`, echoed on `[loom:merge-done]`/`[loom:already-merged]`). Phase at-finalize = NOT finalized (no task move, no merge_done); ref-kept-after-finalize = finalized, only the branch ref kept. A `merge_branch_retained` event (source: solo) is recorded and the branch is HELD exactly like a merge_batch-retained one: review the new commit with worker_merge, then land it with worker_merge_confirm (a real squash of the live tip releases the hold). If that squash would be EMPTY (a late commit that only reverts part of the branch's own change) confirm is refused with cherry-pick guidance rather than finalizing, so the late commit is never deleted. A branch can ALSO be HELD with no late commit: its own `Loom-Landed-Tip` trailer could not be verified (transient git error, or a since-un-pruned `git gc`). The confirm fails closed like a real late commit, with wording \"could not verify the landed tip ... re-confirm once it clears\"; never cached, so a plain re-confirm re-derives once the fault clears. `workerSessionId` must be the FULL session id (no prefix support) and resolves against your OWN lineage even for an EXITED/archived worker (the common done-and-awaiting-confirm case); an id matching no session in your scope errors \"no such worker session '<id>'\" with a did-you-mean hint (your worker ids / taskIds / in-flight op ids); \"not your worker\" means the session exists in a different manager's lineage.",
        inputSchema: strictShape({ workerSessionId: z.string(), forceRemoveWorktree: z.boolean().optional(), overrideReason: OVERRIDE_REASON_SCHEMA.optional() }),
      },
      async ({ workerSessionId, forceRemoveWorktree, overrideReason }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          // Card 03b0377e: pre-check only, wording split — leaves confirmWorkerMergeTracked's own
          // lineage-tolerant pre-attach() ownership gate (decisions 656e326f/164f7915) untouched. An
          // exited/archived worker still in the caller's lineage must pass here exactly like it already
          // does there, so this reuses the SAME workerReadableByManager lineage check, never a narrower
          // db.listWorkers() (live-only) scope that would wrongly refuse the common
          // review-after-the-worker-exited case.
          const w = selfHealWorkerLink(workerSessionId, "worker_merge_confirm");
          if (!w || !workerReadableByManager(w)) return ok(workerLookupError(workerSessionId, w));
          const r = await sessions.confirmWorkerMergeTracked(managerSessionId, workerSessionId, forceRemoveWorktree, overrideReason !== undefined ? { overrideReason } : undefined);
          // FRESH-MINT ANNOUNCEMENT (card 615967c5): `r.freshMint` is set ONLY when this call's result came
          // from a genuinely fresh gate run (never a cache hit — see PendingOpRegistry's own doc), on BOTH
          // branches below (pending AND settled) — a caller must never read either shape as a replayed
          // cached verdict when this is present. Absent entirely on a cache hit (settled branch below stays
          // byte-identical to before this card in that case).
          const freshMintFields = freshMintResponseFields(r.freshMint);
          if (!r.settled) {
            const note = r.freshMint
              ? freshMintNote(r.freshMint)
              : "gate/merge still running — poll gate_status(opId) (read-only, never starts a new run) or worker_list (this worker's pendingMerge field). Re-calling worker_merge_confirm with the SAME workerSessionId is also safe at any delay: a re-call at the SAME commit AND unchanged main returns the cached verdict; a re-call after new commits on the branch, or after main advanced, gates for real — that is answering a different question, not a silent re-run. To force a re-run at the SAME commit (e.g. retrying a flake), pass forceRemoveWorktree:true.";
            return ok({ opId: r.op.opId, status: "pending", workerSessionId, ...freshMintFields, note });
          }
          // CACHE-HIT ANNOUNCEMENT (card 4aedde84): `r.cacheHit` is the mirror of `r.freshMint` above,
          // present ONLY on a settled result served from the registry's cache (never alongside freshMint —
          // see CacheHitInfo's own doc) — turns it into a POSITIVE `servedFromCache` field plus a note, so a
          // caller never has to notice the absence of `supersededBy` to learn that no gate ran.
          const cacheHitFields = cacheHitResponseFields(r.cacheHit);
          if (!r.ok) {
            const errNote = r.cacheHit ? cacheHitNote(r.cacheHit, undefined) : undefined;
            return ok({ error: r.error instanceof Error ? r.error.message : String(r.error), ...cacheHitFields, ...(errNote ? { note: errNote } : {}) });
          }
          const note = r.cacheHit ? cacheHitNote(r.cacheHit, r.value.opId) : undefined;
          return ok({ ...r.value, ...freshMintFields, ...cacheHitFields, ...(note ? { note } : {}) });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // Field-provenance pointers for this tool's description below, relocated out of the agent-facing
    // text (an end-user agent can't resolve a card/decision id) — most carry a real docs/decisions or
    // docs/adr record under the same id; follow it there for the full rationale. Several ids repeat
    // worker_merge/worker_merge_confirm's own citations (bbccf470, 6f13746c, a32533a1, 591906ae,
    // 99a1cf6f, 7f86c02f, 13fc5227) — see those tools' own provenance comments above, not restated here.
    //
    // @decision dbc6f660 — batching the merge gate; the fixed, non-agent-settable cap.
    //
    // @decision 6801c0a1 — a batch landing preserves each branch's own commits, never a squash.
    //
    // @decision d422e279 — the formatReducedGateWarning shared builder.
    //
    // card 72769424 — the import/scanner widening rules that fold a test file into the reduced gate.
    //
    // @decision fd0d34da — the K-degradation: one stray out-of-scope path voids the whole union's
    // reduce eligibility, by construction, fail-closed.
    //
    // @decision 2c16447b / card 37549d9b — fallback[].started means the per-branch confirm ran and
    // completed, not that the candidate landed or finalized (see git/batch-merge.ts).
    //
    // @decision 67030bb9 — the bounded multi-file retry on a red assembled-batch gate.
    //
    // @decision b801bad0 — a BRANCH DIVERT: the canonical checkout was found off mainline.
    //
    // @decision 043d83d2 — a BATCH HEAD MOVE: the batch worktree's own HEAD no longer matched.
    //
    // @decision 57f9cdd9 — a CANONICAL TRUST REFUSAL at the fast-forward.
    //
    // @decision 89c4c950 — the same trust refusal can also be detected and settled at gate admission.
    //
    // card b7f965d2 — strippedTrailerCount: a worker's own Claude-Session trailer stripped before
    // landing (see sessions/service.ts).
    //
    // @decision e8e98d43 — finishRefused: content landed but finalize was refused (an unrelated hold).
    //
    // @decision 13571c71 — CANCELLED via gate_cancel while still queued starts nothing.
    //
    // @decision f944d4e4 — this call is bounded; a client-timeout re-fire is cheap (supersedes an
    // earlier card's now-stale advice that a re-fire was NOT cheap).
    //
    // @decision 19256231 — gate_queue's fallbackOfBatchOpId marks a batch's own per-candidate fallback
    // merge; settled does not mean a fallback candidate's own merge has finished, only that it spawned.
    //
    // @decision 81d795de — settled means the batch op's own work is done, whatever the outcome.
    //
    // @decision d240fceb — a re-fire with the same resolved candidate set replays the cached op cheaply,
    // including a replayed finishRefused/retained entry, provided that candidate's tip hasn't moved.
    //
    // @decision 42daa283 — a LANDED entry is not always FINALIZED: branchAdvancedDuringGate.
    //
    // @decision 6796c9ea — uncommitted work made after assembly keeps the worktree/branch retained too.
    server.registerTool(
      "merge_batch",
      {
        description: "Reviewed-tip rule (see `worker_merge_confirm`): a candidate whose branch moved after its review is NOT assembled and is NEVER solo-confirmed on any path (including the `<2`, gate-off and no-gate returns); it is reported in `fallback[]` with `started:false` and the re-review message, and the rest of the batch proceeds. Assembly cherry-picks exactly the tip that was checked. If the human-only `orchestration.mergeGate` is \"off\" there is no gate to share: every candidate goes through the per-branch solo fallback with reason \"merge gate disabled\", landing as `skipReason:\"gate-disabled\"`. The setting is read when a call STARTS (gate_cancel a queued one and re-call to apply a flip). With the human-only `orchestration.mergeGateInterval` N the batch counts its K candidates ONCE: when ungated + K would exceed N it runs the real shared gate (a pass resets the counter); otherwise it takes the per-branch fallback with reason \"merge gate interval: not this landing's turn\", each landing as `skipReason:\"gate-interval\"`. Each per-branch landing is subject to the optional `orchestration.ungatedLandingCheckCommand` safety net (see `worker_merge_confirm`). PRE-MERGE TITLE CHECK: this call NEVER rewrites a candidate's commit subject; each branch's own commits land verbatim. Before calling, check `worker_merge`'s `ownTipSubject`/`ownTipSubjectConventional` (the tip commit's exact subject; complete for a single-commit branch) and, for a multi-commit branch, `ownNonTipCommitSubjects`/`ownNonTipCommitSubjectsConventional` (every other commit's subject, bounded). A branch that fails the check should merge solo instead: the solo squash uses the card title as the subject. BATCH THE MERGE GATE: gate up to the project's `orchestration.maxConcurrentWorkers` (resolved fresh; platform default 3) READY worker branches on ONE repo in a SINGLE run. The cap is fixed, not a parameter of this tool. Cuts a batch worktree off canonical main's tip and lands each candidate IN ORDER, EACH BRANCH'S OWN COMMITS INDIVIDUALLY (rebase/cherry-pick, NOT a squash: 3 commits land as 3; a solo worker_merge_confirm still squashes). No merge commits are created. Only a branch's LAST (tip) commit carries the `Loom-Worker-Branch` trailer. Runs the gate ONCE on the assembled tree and on green fast-forwards canonical main to it (main is mutated exactly once, there). That one gate run reduces to build + static guards + selected test file(s), the same smaller command a solo confirm substitutes, when the ASSEMBLED tree's union of changes proves eligible (e.g. every candidate is test-only); batch MEMBERSHIP is unaffected. Reduction degrades as batch size grows: the eligibility check returns on the FIRST changed path outside its four in-scope daemon areas (source/test/assets/scripts) that is not certified inert (`docs/**`, root `README.md`/`CHANGELOG.md`/`CODE_OF_CONDUCT.md`/`CONTRIBUTING.md`/`SECURITY.md`), so one stray path (shared-contract or web-UI source, or another root file such as `CLAUDE.md`) in ANY batched branch voids it for the whole union. This is correctly fail-closed, not a defect to work around: `gate_history` then reads `emitCompareReduced:null` with `emitCompareNotApplicableKind` `\"repo-out-of-domain\"` or `\"path-out-of-scope\"` (see that tool), routine at larger batch sizes. A landed result carries `reducedGateWarning` (sync return or async settle nudge) ONLY when reduction applied: it names any NOT_HERMETIC/inert-path exclusions and warns that the green covers every landed branch via test files run in ISOLATION (`--only=`). Every workerSessionId must be YOUR OWN worker on the SAME repo; a mismatch refuses the whole call before touching anything. Fewer than 2 eligible candidates (after stranded-work/cap filtering) falls straight to the ordinary per-branch path. A branch that won't land cleanly into the batch (a real conflict against an earlier candidate in this batch, or a merge commit that is NOT a pure main-forward: a non-first parent not already on the batch HEAD, or carrying conflict-resolution content; a clean automatic main-forward merge, e.g. the union-forward a solo confirm commits onto the branch, is skipped and its own commits land normally) is DROPPED WHOLESALE, never partially landed. It is recorded in `fallback` with its own reason (the merge sha and failed condition, or the conflicting commit), carried bounded in the [loom:merge-batch-*] nudge and filed as a `batch_merge_dropped` event; the batch proceeds and the dropped branch gets its own ordinary worker_merge_confirm. Each `fallback[]` entry carries `started`: `true` means its per-branch worker_merge_confirm was kicked off AND completed, NOT that it landed or finalized (a branch the confirm merely RETAINED also reads `started:true`; read its own `[loom:merge-*]` nudge or `worker_list`'s `pendingMerge`/`outcome`); `false` means the confirm never ran (refused at mint or thrown before starting; `reason` says why, e.g. the worker left this manager's recycle lineage) and the candidate needs a manual worker_merge_confirm. A RED gate on the assembled batch first tries a bounded multi-file retry (mirrors worker_merge_confirm's; see gate_status's `retriedFile`/`retryPassed` and gate_history's `retryDeclineReason`): if the failure names a small, identifiable set of re-runnable test files, those are re-run together in isolation once; a pass lands the WHOLE batch as a retry-assisted pass, WEAKER evidence than a clean pass (never bisected; every landed branch shares that one verdict). A gate that stays red (including one the retry declined or couldn't rescue) falls back to gating every original candidate individually. A FORFEIT (canonical main advanced between the batch cut and the fast-forward) is also a full fallback to individual gating, recorded as a `batch_merge_forfeited` event; it is the one failure mode batching makes strictly worse (one wasted gate becomes up to the cap), so watch for it when batching large groups. A BRANCH DIVERT (the canonical checkout was found on an unexpected, non-mainline branch before or after the fast-forward) resolves `{ok:false, branchDiverted:true}`, recorded as a `batch_merge_branch_diverted` event. Unlike a forfeit this is NOT a full fallback: nothing is started (`fallback` lists every candidate `started:false`, its reason naming observed vs expected branch), because the solo path pins only a sha and could land onto the same stray branch. RESTORE the canonical checkout to the mainline branch BEFORE calling `worker_merge_confirm` on ANY of these candidates; nudge `[loom:merge-batch-diverted]`. A BATCH HEAD MOVE (the batch worktree's HEAD or uncommitted state no longer matched the tip this call assembled, checked before the gate and again after it passes, before any fast-forward) resolves `{ok:false, batchHeadMoved:true}`, recorded as `batch_merge_head_moved`; NOTHING is started (every candidate `started:false`): the HEAD lives in the shared worker-writable `.git`, so the mismatch means possible tamper on that ref, not a problem with the candidates. Inspect the batch worktree by hand before re-firing; nudge `[loom:merge-batch-head-moved]`. A CANONICAL TRUST REFUSAL (the fast-forward's `--ff-only` or its pre-check HEAD read refused by a structural canonical-git trust condition, e.g. a commondir redirect or pin mismatch) resolves `{ok:false, canonicalTrustRefusal:true}`; it is NEVER cached (a re-fire after a human repairs the canonical repo re-attempts) and NOTHING is started (every candidate `started:false`): rebasing a candidate will not fix it. It can also settle at gate ADMISSION, when `gate_status(opId)` reads `outcome:\"skipped\"` with `skipReason:\"canonical-trust-refusal-at-admission\"`, never `outcome:\"pass\"` with `batchLanded:false`; result shape and nudge are identical. Nudge `[loom:merge-batch-trust-refusal]`. An UNVERIFIED FAST-FORWARD (the `--ff-only` did not throw but the re-read confirming where it landed failed) resolves `{ok:false, unverified:true}`, recorded as `batch_merge_ff_unverified`: the landing most likely happened. No per-candidate fallback starts (it could land twice); confirm with a plain `git log` on the mainline branch, then `worker_merge_confirm` finalizes each candidate via ALREADY_MERGED; nudge `[loom:merge-batch-unverified]`. CANDIDATE ORDER THROUGH THE FALLBACK is path-dependent: on a RED gate or FORFEIT, `fallback` routes in your ORIGINAL resolved order (a deliberate order is preserved); on a GREEN batch's own dropped/conflicted candidates it routes in the order the batch attempted them, OLDEST-AUTHOR-DATE-FIRST, not your call order. FALLBACK CANDIDATES ON THE SAME REPO CAN OVERLAP: their per-candidate `worker_merge_confirm` calls are dispatched only ~12s apart, well under a gate's run, so several can be gate-running at once. This is fail-closed: a losing candidate self-aborts at squash time with a benign `gate_base_invalidated`/`\"stale-base\"` rejection (see `worker_merge_confirm`), and a plain re-confirm re-gates. The cost is throughput: a fallback of K merges can burn MORE than K gate runs when overlapping ones forfeit, so size groups accordingly, especially when candidates are likely to conflict/drop together. `landed` names every branch that merged via the shared batch gate (workerSessionId, taskId, branch, sha, strippedTrailerCount): `sha` is the branch's TIP commit (the one carrying its trailer); `strippedTrailerCount` is how many of that branch's commits carried a `Claude-Session:` trailer that was stripped before landing (non-zero means a worker added one against this project's CLAUDE.md; worth a look). Each already went through the same finalize path (worktree cleanup, task move, notification) as a solo ALREADY_MERGED confirm; no separate action needed. `finishRefused` is a rarer shape: a candidate whose content the batch's fast-forward DID put on main (counted in `landedCount`) but whose finalize was REFUSED (today always because the branch is HELD by an unrelated retain whose release could not be confirmed): {workerSessionId, taskId, branch, sha, reason, heldRangeUnverifiable?}. It is NOT in `landed`: no cleanup ran, task/worktree/worker are untouched, the card is NOT cleanly done. `heldRangeUnverifiable:true` is a TRANSIENT read fault (retry worker_merge_confirm, or restart the daemon); its absence means a genuine hold to resolve by hand (inspect the branch, cherry-pick what is still owed onto a follow-up card's worker, as in `worker_merge_confirm`'s HELD BRANCH guidance). `fallback` names every OTHER candidate (dropped, over the cap, stranded, or on a red gate/forfeit the whole batch) that this call already routed through an ordinary worker_merge_confirm on your behalf; do not re-call it, read `fallback` for each outcome. `reason` is set on a top-level refusal (validation failure, nothing eligible, no gateCommand configured) or explains why the whole batch went to fallback. CANCELLED: a batch withdrawn via `gate_cancel` while still QUEUED resolves `{ok:false, cancelled:true}`: not a rejection, no gate ran, and NOTHING is started (every candidate listed in `fallback` with `started:false`); nudge `[loom:merge-batch-cancelled]`; no gate failure is recorded toward a merge-gate interval. Re-fire `merge_batch` if you still want it." +
          "CLIENT TIMEOUT ≠ FAILURE, AND A RE-FIRE IS CHEAP: like `worker_merge_confirm`, this call is BOUNDED: a slow batch returns `{opId, status:\"pending\"}` before it settles, so a client-side timeout does NOT mean the batch failed. To check a pending op read `gate_status(opId)` (read-only) or `gate_queue` for a `merge` row with `taskId:null`/`branch:null`/`workerLabel:\"Orchestrator\"` (a solo merge always carries a real `taskId`/`branch`). That predicate finds ONLY the batch's own gate, never its fallback: the per-branch fallback (on a red gate or forfeit EVERY chosen candidate; on a green batch its dropped/over-cap/stranded candidates) spawns one ordinary merge gate PER CANDIDATE, each with a real `taskId`/`branch`/`workerLabel`, so finding no `Orchestrator` row means the BATCH is done while up to the candidate count of individually-gated merges may still be live on the shared cap. Each fallback row carries `gate_queue`'s `fallbackOfBatchOpId` (equal to THIS op's `opId`; null/absent on a non-batch merge): read it rather than widening the predicate. `gate_status(opId).state===\"settled\"` for a batch op means the batch's OWN work (worktree cut, shared gate run, fast-forward, already-landed-branch finalize) is finished WHATEVER its outcome (on a RED gate or FORFEIT no fast-forward or finalize runs and the row still settles; it does not mean \"main advanced\"; read the sync return, settle nudge or `gate_status` verdict fields for the outcome). It does NOT wait for a fallback candidate's own merge to finish, only for this call to have SPAWNED it: fallback candidates run through `worker_merge_confirm` sequentially, each a bounded call that returns when it settles or its short sync-wait elapses, so a large fallback set can report this op `settled` while its individually-gated merges still run. Read `fallbackOfBatchOpId` (or poll each candidate's own `worker_merge_confirm`/`gate_status`) for their completion. RE-FIRING `merge_batch` with the SAME workerSessionIds is SAFE AND CHEAP: it is keyed by the calling manager plus the RESOLVED candidate set (after ownership/repo/stranded-work filtering); an unchanged set re-attaches to the running or just-settled op instead of cutting a second batch worktree or running a second gate, even when the cached verdict carries a `finishRefused` or retained (`branchAdvancedDuringGate`) entry, PROVIDED that candidate's tip has not moved (the re-fire replays that entry's historical fact). One exception: a batch that THREW classifies `\"unknown\"`, never cached (as `worker_merge_confirm`'s thrown-confirm case), so a re-fire re-assembles and re-gates every candidate. If a candidate's tip HAS moved, the re-fire runs fresh for the whole batch and never silently drops a late commit. A re-fire never notices a `worker_merge_confirm` you ran directly on a named candidate in between (confirming doesn't move its tip, so the re-fire keeps replaying the pre-confirm verdict for this process's lifetime): to recover a `finishRefused`/retained candidate's CURRENT state, call `worker_merge_confirm` ON IT DIRECTLY. If the resolved set itself changes between calls (a candidate drops out), the key differs and the retry runs fresh. An async settle nudge (`[loom:merge-batch-done]`/`[loom:merge-batch-failed]`/`[loom:merge-batch-unknown]`/`[loom:merge-batch-cancelled]`) fires once, only for a caller that observed the pending shape (a batch that settles inside the bounded wait returns the full result inline). A LANDED ENTRY IS NOT ALWAYS FINALIZED: one carrying `branchAdvancedDuringGate: {assembledTip, liveTip, phase}` means the batch landed what it assembled but the branch tip MOVED afterwards (`liveTip:null` = could not be verified); that extra commit is NOT on main and was NEVER gated. `phase:\"pre-stop\"`/`\"at-finalize\"`: NOT finalized (branch, worktree and worker kept; task stays where it was). `phase:\"ref-kept-after-finalize\"`: FINALIZED, only the branch ref kept. A `batch_merge_branch_retained` event is recorded either way. Next step for a not-finalized one: review the new commit with `worker_merge`, then land it with `worker_merge_confirm`. Re-firing merge_batch (also in a MIXED batch, and after a daemon restart) will NEVER assemble or fallback-confirm it: it returns in `fallback` with `started:false` and stays HELD (even if its branch gets further commits or is deleted) until released by a REAL `merge_done` newer than the retain (you landed it with `worker_merge_confirm`; a boot-reconciled merge_done for a card merely sitting in the terminal column does NOT release it) or by main carrying a later `Loom-Worker-Branch` commit for it (a failing git read keeps it held). Held candidates are not batch members and do not count toward batch size. The hold is keyed on the BRANCH (a `worker_recycle` successor on it is held too); boot reconcile, the ALREADY_MERGED finish paths and the branch-ref sweep will not finalize or delete a held branch. A retained branch is reviewed and landed by its LATE RANGE: `worker_merge` shows `assembledTip..liveTip` as `lateRange` (its ordinary diffstat is the fork-point diff, which includes what the batch already landed) and `worker_merge_confirm` lands exactly that range, including a late commit that reverts part of the branch's own change. If the range cannot be determined (assembledTip unreadable or no longer an ancestor) `worker_merge` warns, `worker_merge_confirm` refuses, and the branch stays held. UNCOMMITTED WORK IS RETAINED TOO: a `landed` entry carrying `worktreeRetainedDirty: {files, truncated, unverified}` was finalized (task moved, `merge_done` filed) but its WORKTREE (and branch ref) was KEPT because it holds uncommitted work made after assembly (`files`, capped); that work is NOT on main; `unverified:true` = status could not be read, kept fail-closed. It is NOT held (no `batch_merge_branch_retained` event): inspect/move the work out, then re-run `worker_merge_confirm` with `forceRemoveWorktree:true` (removing the directory by hand leaks the `loom/*` ref forever). Entries without the field were finalized normally. RED SELF-CHECK: while the interval would let this batch skip the gate, any candidate whose OWN tip carries a settled red `run_gate` self-check makes the batch run the real gate instead, unless that candidate has an entry in `overrideReasons` (a map of workerSessionId to a non-empty, bounded reason) — RECORDED on that candidate's landing, NOT authenticated, never a pass; see `worker_merge_confirm` for the full rule.",
        inputSchema: strictShape({ workerSessionIds: z.array(z.string()).min(1), overrideReasons: z.record(z.string(), OVERRIDE_REASON_SCHEMA).optional() }),
      },
      async ({ workerSessionIds, overrideReasons }) => {
        try {
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          for (const workerSessionId of workerSessionIds) selfHealWorkerLink(workerSessionId, "merge_batch");
          const r = await sessions.mergeBatchTracked(managerSessionId, workerSessionIds, overrideReasons);
          if (!r.settled) {
            return ok({
              opId: r.op.opId, status: "pending",
              note: "batch still running — poll gate_status(opId) (read-only, never starts a new run) or gate_queue for a merge row with taskId:null/branch:null (this finds the BATCH's OWN gate row only — card 19256231: a fallback candidate this batch spawns gates as an ordinary real-taskId/real-branch merge instead, tagged with gate_queue's fallbackOfBatchOpId===opId). state:\"settled\" genuinely means nothing about THIS op's own work — the gate run, the fast-forward onto canonical main, per-branch finalize — is still running, not just that the shared gate command finished (card 81d795de). ⚠️ card 19256231 correction: settled does NOT mean every fallback candidate's own worker_merge_confirm has itself finished — this call only awaits SPAWNING each one (a bounded, quickly-returning attach() call), so a fallback candidate's real gate/squash can still be genuinely running after this op reports settled; poll gate_queue's fallbackOfBatchOpId or that candidate's own worker_merge_confirm/gate_status for its real completion. Re-calling merge_batch with the SAME workerSessionIds is also safe at any delay: as long as the resolved candidate set is unchanged, it re-attaches to this SAME in-flight (or just-settled) op instead of starting a second one.",
            });
          }
          // Code Review, card cf803152 finding [3]: `r.cacheHit` (now real for this call — see
          // mergeBatchTracked's own `retainVerdictUntilSuperseded` opt) used to be silently dropped here,
          // the exact incident card 4aedde84 already fixed for the solo `worker_merge_confirm` handler —
          // mirror that fix rather than reintroducing the same silent-cache-hit gap on this call.
          const cacheHitFields = cacheHitResponseFields(r.cacheHit);
          if (!r.ok) {
            return ok({
              error: r.error instanceof Error ? r.error.message : String(r.error), ...cacheHitFields,
              ...(r.cacheHit ? { note: cacheHitNote(r.cacheHit, undefined, "worker_merge_confirm") } : {}),
            });
          }
          // Card d240fceb, m1 — merge_batch has no forceRemoveWorktree of its own (unlike worker_merge_confirm,
          // the solo call site above) — name the real per-candidate escape hatch instead.
          const cacheNote = r.cacheHit ? cacheHitNote(r.cacheHit, undefined, "worker_merge_confirm") : undefined;
          // Card 42daa283: a sync caller must get the explanation too, not only the async settle nudge.
          // Card d240fceb, m2 — mirror the async settle nudge's own causeUnverifiable suffix (service.ts,
          // the `branchAdvancedDuringGate` nudge text) so a transient, retry-worthy cause isn't silently
          // dropped from the sync path alone.
          const retainedBranches = (r.value.landed ?? []).filter((l) => l.branchAdvancedDuringGate).map((l) =>
            `${l.branch} (${l.branchAdvancedDuringGate?.phase})${describeBranchRetainedCauseUnverifiableSuffix(l.branchAdvancedDuringGate?.causeUnverifiable, l.workerSessionId)}`);
          const retainedNote = retainedBranches.length > 0
            ? `BRANCH TIP MOVED AFTER ASSEMBLY: ${retainedBranches.join(", ")} — the extra commit is NOT on main and was never gated (or the tip could not be verified). phase "ref-kept-after-finalize" = finalized, only the ref kept; otherwise NOT finalized — branch and worktree kept, worker kept. Review it with worker_merge, then land it with worker_merge_confirm. Re-firing merge_batch will NOT land it.`
            : undefined;
          const dirtyRetained = (r.value.landed ?? []).filter((l) => l.worktreeRetainedDirty).map((l) => `${l.branch}${l.worktreeRetainedDirty?.unverified ? " (status unreadable)" : ""}`);
          const dirtyNote = dirtyRetained.length > 0
            ? `WORKTREE RETAINED (uncommitted work, or its status could not be read): ${dirtyRetained.join(", ")} — the merge landed, but the worktree and branch ref were kept; see each landed entry's worktreeRetainedDirty.`
            : undefined;
          // Card e8e98d43: a sync caller must get this explanation too, not only the async settle nudge —
          // mirrors retainedNote/dirtyNote immediately above.
          const finishRefusedNote = buildFinishRefusedNote(r.value.finishRefused);
          const note = [cacheNote, retainedNote, dirtyNote, finishRefusedNote].filter((n): n is string => !!n).join(" ") || undefined;
          return ok({ ...r.value, ...cacheHitFields, ...(note ? { note } : {}) });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );
    // @decision a16c580b — never scope this call site to the caller's own project; deliberately unscoped
    // so a manager can resolve any project's settled op by opId, with redaction doing the access control.
    registerGateStatus(server, sessions, db, undefined, undefined, () => db.getSession(managerSessionId)?.projectId);
    registerGateQueue(server, sessions, db, managerSessionId);
    registerGateIntent(server, sessions, managerSessionId);

    // @decision 2a6a292a round 4 — manager-only, OWN project only (server-derived from managerSessionId,
    // never a projectId argument); never registered on the worker router. See that decision record's
    // "manager-checkout" section for the full trust-boundary rationale and what this reuses/refuses.
    // @decision 0eaaa693 — an EXITED worker's merge-time fork-point backstop is the net for an already-
    // removed worktree, not this tool's own unmerged-worker hard refusal (see below).
    server.registerTool(
      "project_checkout_branch",
      {
        description:
          "Switch YOUR OWN project's canonical repo to an EXISTING local branch, then re-point this " +
          "(project, repoKey)'s mainline watermark to the resulting {branch, sha}, so a later " +
          "worker_merge_confirm/merge_batch lands against the NEW branch instead of refusing with " +
          "branchDiverted. Touches no remote. `repoKey` (optional; null/omitted/\"primary\" = the primary " +
          "repo, else a key from your project's repo registry; an unknown key is rejected with {error}). " +
          "`create:true` makes a BRAND NEW branch instead: created at the CURRENT trusted tip (never a " +
          "caller-chosen start point), switched to, and trust-stamped immediately (no human adopt needed). " +
          "Refuses an existing name, an invalid branch name, or the reserved \"loom/\" worker-branch " +
          "prefix; `create` never mixes with switching to an existing branch. " +
          "WITHOUT `create`: calling this on the branch ALREADY checked out is a TRUE no-op " +
          "({ok:true, noop:true}) only when the watermark already agrees; if it disagrees, every refusal " +
          "below re-validates in-lock and, once clear, the watermark is RE-POINTED ({ok:true, " +
          "noop:false}) with no new git checkout. An EXISTING branch with no trusted baseline on record is " +
          "refused outright: create it with `create:true`, or ask the owner to check it out THEMSELVES " +
          "first and only then call the human-only reset route (it reads whatever is CURRENTLY checked " +
          "out, so checkout must come BEFORE the reset call, never after). " +
          "Branch names must be PLAIN: no leading \"-\", no \"@{\", no \"..\", no \"refs/\" prefix, only " +
          "letters, digits, \".\", \"_\", \"-\", and \"/\" between segments; rejected before any git call, for " +
          "both modes. Existence/collision checks use the real case-sensitive branch listing, never git " +
          "resolution: any path-prefix of the name that differs only in case from an EXISTING branch's " +
          "prefix (\"FEAT\" vs \"feat\", \"FEAT/x\" vs \"feat/y\", or the reverse) is refused, naming the real " +
          "branch. `create:true` also refuses a name starting (case-insensitively) with a configured " +
          "remote's full name + \"/\" (it would shadow that remote's tracking-ref namespace). On the SWITCH " +
          "path a remote-tracking shadow (no local ref, but `refs/remotes/<remote>/<branch>` exists) is " +
          "matched EXACTLY per remote, never by loose suffix. " +
          "HARD REFUSALS (no override; scoped to your WHOLE project, over-refusal intentional): (1) an " +
          "unresolved mainline alert exists for this repo; ask the owner to review and use the human-only " +
          "reset route first. (2) WITHOUT `create`, the branch is not a LOCAL ref (refused here, never " +
          "deferred to checkout; a same-named remote-tracking ref with no local one is a HARD refusal " +
          "with a HIGH-severity event filed). (3) the SWITCH TARGET's live tip does not EXACTLY match its " +
          "trust record's sha: any other tip is refused with a HIGH event and the reset route named, " +
          "including a descendant carrying a (forgeable) Loom merge trailer, a rewind/divergence or a " +
          "non-ancestor move; checked on the TARGET regardless of what's checked out. The trust record is " +
          "written only by a real Loom landing, this tool's own checkout/create success, and the reset " +
          "route's `adopt`. (4) any worker branch in this project not yet PROVEN merged that is LIVE or " +
          "whose worktree still exists on disk (an EXITED worker whose worktree is gone is excluded): " +
          "land it (worker_merge_confirm) or ask the owner to remove its worktree/branch by hand " +
          "(worker_stop retains it; no manager tool deletes a worktree); returns `unmergedWorkers`. " +
          "(5) any live/queued gate of ANY kind (merge/batch, deploy, a worker's run_gate) on this " +
          "project's repo(s): check gate_queue and retry; returns `liveGateOps`. (6) a worktree currently " +
          "being CUT (worker_spawn or batch assembly in flight). (7) tracked changes in the canonical " +
          "repo (untracked files don't block). " +
          "Returns {ok:true, noop, created?, branch, sha, repoKey, previousBranch} on success; on any of " +
          "the seven refusals {error, refused:true, liveGateOps?, unmergedWorkers?}; just {error} for an " +
          "invalid name, Loom's reserved/operational home (refused by the underlying checkout), or an " +
          "ordinary create failure (existing name, or no established watermark to branch from).",
        inputSchema: strictShape({ branch: z.string(), repoKey: z.string().nullable().optional(), create: z.boolean().optional() }),
      },
      async ({ branch, repoKey, create }) => ok(await sessions.checkoutProjectBranch(managerSessionId, { branch, repoKey, create })),
    );

    // @decision cc788ae4 — manager-only, OWN project only (server-derived from managerSessionId, never a
    // workerSessionId's own project trusted blindly); never registered on the worker/platform/setup/
    // auditor surfaces, and never callable from any automatic union-merge/gate path.
    server.registerTool(
      "worker_restamp_cut_base",
      {
        description:
          "Deliberately re-stamp a worker session's recorded cut-base (fork-point) sha to the canonical " +
          "repo's CURRENT mainline target tip: one of three remedies for a merge-time forkPointDiverged " +
          "refusal (the others: switch the canonical checkout back, or re-dispatch a fresh worker cut " +
          "from current mainline). Recycling or rebasing the worker alone can NEVER clear that refusal " +
          "(the recorded cut base is carried forward unchanged). Re-stamps ONLY after verifying against " +
          "the branch's CURRENT state: (A) the current mainline target tip is an ancestor of the worker " +
          "branch's tip, and (B) every commit beyond that tip has exactly one parent: ANY merge commit " +
          "in that range refuses outright, even a legitimate union-forward merge of the mainline (a " +
          "merge commit is the only way the OLD lineage could have entered the branch). If refused on " +
          "(B), rebase/cherry-pick the branch linearly onto the current target and retry. Neither check " +
          "inspects CONTENT (the merge gate and review of the real diff cover that), and (B) is " +
          "POINT-IN-TIME: never re-run at merge time. " +
          "`workerSessionId` must name a session in YOUR OWN project with a branch and a task not already " +
          "proven merged, and must be the NEWEST session row at that worktree path/branch (a superseded " +
          "row from an older recycle/respawn is refused, naming the newer session's id). `dryRun:true` " +
          "runs every check and reports the same shape with no write and no audit event. " +
          "HARD REFUSALS (no override): any live/queued gate op of ANY kind on this project's repo(s) " +
          "(wait for gate_queue to show it clear and retry; returns `liveGateOps`); check (A) failing " +
          "(`notAncestor:true`); check (B) failing on a merge commit (`mergeCommitSha`); or more commits " +
          "beyond the target than a fixed, non-configurable scan bound (`tooManyCommits:true` + " +
          "`branchExtraCount`). A same-state call (cut base already equals the current target tip) is a " +
          "TRUE no-op ({ok:true, noop:true}), no write, no audit event. " +
          "On success, re-stamps the cut base and files a durable audit event naming the old and new " +
          "sha, the branch and you as acting manager. Returns {ok:true, noop, dryRun?, branch, " +
          "oldCutBaseSha, newCutBaseSha, branchExtraCount, repoKey}, or {error, refused?, liveGateOps?, " +
          "notAncestor?, mergeCommitSha?, tooManyCommits?, branchExtraCount?} on refusal.",
        inputSchema: strictShape({ workerSessionId: z.string(), dryRun: z.boolean().optional() }),
      },
      async ({ workerSessionId, dryRun }) => ok(await sessions.restampWorkerCutBase(managerSessionId, { workerSessionId, dryRun })),
    );

    // @decision 753d9911 — never add a `projectId` argument to `gate_history`; the project is resolved
    // server-side from the caller's own session, so no argument shape can name a different project.
    //
    // @decision bb134d3e — never add `gate_history` to the worker tool surface; a worker resolves an opId
    // it already holds via the self-scoped `gate_status` — this is a manager-only concern, decided twice.
    //
    // Field-provenance pointers for the description below, relocated out of the agent-facing text (an
    // end-user agent can't resolve a card/decision id). Entries with a matching docs/decisions record use
    // @decision; a bare `card <id>` line has no such record and is a plain provenance citation.
    //
    // card 55cd3538 — `fallbackOfBatchOpId`, the durable, post-hoc counterpart to `gate_queue`'s live-only
    // field of the same name.
    //
    // @decision 19256231 — the live `fallbackOfBatchOpId` this durable field is the post-hoc counterpart
    // to.
    //
    // @decision 6ca4b1a0 — `emitCompareReduced`: a duration series built from this table must bucket on
    // this field before comparing durations; the reduced/full populations differ by an order of
    // magnitude or more.
    //
    // @decision 2db8a3dd — `notApplicable` and "ran the full suite" are distinct terminal states; the
    // first one reached wins, which is why `emitCompareReduced` can read `false` on a repo this
    // predicate can't evaluate.
    //
    // @decision fd0d34da — `emitCompareNotApplicableKind` is a coarse, path-free CATEGORY, never a path
    // or filename.
    //
    // card edbf9bd1 — the `[loom:merge-done]` nudge wording this field's selected-test-files arm mirrors.
    //
    // @decision 344ce950 — the bounded single-file retry's cost, and why a pass-after-retry is weaker
    // evidence than an ordinary clean pass.
    //
    // @decision 67030bb9 — `retryDeclineReason`/`retryWarning`'s three cases, corrected to be present on
    // a fail too; also backs the bounded multi-file retry and its batch-row extension.
    //
    // @decision 318ac7b2 — a single-file retry cancelled while still queued never loses attempt 1; this
    // shape is HISTORICAL since `attempt`/`priorAttemptMs` stopped re-queuing a retry.
    //
    // @decision 68155573 — a retry continues its original admission as a link of the SAME chain, never a
    // second one; the `durationMs`/`gateCap`/`concurrentGates` triple's pre- vs post- this change reading.
    //
    // @decision 3a6f04cc — `"cancelled"` is a distinct outcome, never a rejection; before this, a
    // cancelled `"worker"` row silently fell through to `outcome:"reject"`.
    //
    // @decision 518e7ff6 — the transient-kill retry's own cancel-while-queued case leaves a SEPARATE
    // `build_gate_retry` row, never reclassifying attempt 1's already-written row.
    //
    // @decision a0d1165c — `transientRetried` names which row is the retry, derived from the row's own
    // underlying event kind, never a stored detail field.
    //
    // @decision db9b0130 — `"skipped"` is also a distinct non-verdict, never a `"pass"`: an inert
    // (docs-only) branch never spawns a gate at all.
    //
    // @decision a228dfb5 — `gate_status(opId)` now also reports `"skipped"` for this exact row's `opId`,
    // where it used to collapse the same settled op into `outcome:"pass"`.
    //
    // @decision 3aec1df6 — this tool is the INDEX, not the full-detail surface; a merge row's
    // `failingTest` is not unconditionally `null`.
    //
    // @decision eb9348b0 — the correction to 3aec1df6: `failingTest` also reads the settled verdict
    // payload as a fallback, widening which rejections are diagnosable from this table alone.
    //
    // card 67c54f48 — the default page size, sized to fit an unprojected page inline under the
    // tool-result cap (the old default of 100 overflowed outright).
    //
    // card 40f4cae9 — `fields:[...]`, the same projection contract as `tasks_list`'s own `fields`.
    //
    // card eb62d585 — `countsOnly:true`, the same short-circuit contract as `tasks_list`'s own
    // `countsOnly`.
    //
    // @decision bd9a483b — the ungated-landing safety-net check this tool's `byGateType` tallies
    // separately as `"landingCheck"`, never folded into the `"worker"` bucket.
    //
    // @decision cee17efe — the automatic post-ungated-landing dist-importer advisory this tool's
    // `byGateType`/`byOutcome` tally separately as `"distImporterCheck"`/`"error"`.
    server.registerTool(
      "gate_history",
      {
        description:
          "Read-only, PAGINATED history of settled daemon-executed gate runs (merge/build gates, their " +
          "transient-kill retries, worker self-checks, deploys) for YOUR OWN project ONLY, REJECTED runs " +
          "included. `gate_queue`/`gate_status` describe only LIVE ops; use this for duration trends. " +
          "Returns {items, total, limit, offset, nextOffset}, `items` newest-first; each row is {id, gateType " +
          "(\"merge\"|\"worker\"|\"deploy\"), outcome (\"pass\"|\"reject\"|\"timeout\"|\"kill\"|\"cancelled\"|" +
          "\"skipped\"), passed (`outcome===\"pass\"`), gateRan, durationMs, gateCap, " +
          "concurrentGates, concurrentGatesMax, endedAt, failingTest, opId, taskId, branch, workerLabel, " +
          "sessionId, projectId, projectName, retriedFile, retryPassed, retryDeclineReason, transientRetried, " +
          "emitCompareReduced, emitCompareNotApplicableKind, emitCompareIdenticalCount, emitCompareTestFiles, fallbackOfBatchOpId}. " +
          "`fallbackOfBatchOpId`: the durable counterpart of `gate_queue`'s live-only field; non-null ONLY on " +
          "a row from `merge_batch`'s automatic per-branch fallback confirm, naming the batch op's `opId`. " +
          "`null` on the batch's own row (it self-identifies via `batched`/`batchBranches`), on solo merges, " +
          "and on rows from before the field shipped. Don't re-derive it from `gate_queue` (live ops only). " +
          "`emitCompareReduced`: bucket on it BEFORE comparing durations. A `\"merge\"` gate can run REDUCED " +
          "(build + static guards, ± selected test files: seconds) instead of the full suite, an order of " +
          "magnitude apart. Tri-state: `true` = ran reduced; `false` = a real gate spawned and was proven " +
          "NOT reduced (a genuine full run); `null` = no gate spawned, row predates the field, a " +
          "`\"worker\"`/`\"deploy\"` row (reduction is merge-only), or a full run on a repo layout the " +
          "predicate can't evaluate (`false` is reachable only on a project shaped like Loom's daemon " +
          "package). Never pool `null` with `false`: `null` means not determinable, not a known full run. " +
          "`emitCompareNotApplicableKind`: why `emitCompareReduced` is `null` when the predicate said " +
          "not-applicable; `null` for every other cause. `\"repo-out-of-domain\"` = none of the four scope " +
          "directories exist in the repo (checked via `git ls-tree`); `\"path-out-of-scope\"` = the predicate " +
          "applies to the repo but not (fully) to THIS diff (an out-of-scope path alongside an in-scope one, " +
          "or the repo has a scope directory this diff doesn't touch; see `merge_batch` for the batch-size " +
          "degradation); rarer mechanism failures: `\"harness-config-unavailable\"`/" +
          "`\"typescript-unresolvable\"`/`\"git-operation-failed\"`/`\"empty-diff\"`/`\"unparseable-diff\"`. " +
          "`emitCompareIdenticalCount`/`emitCompareTestFiles` are non-null ONLY with " +
          "`emitCompareReduced:true`; read them TOGETHER. `emitCompareIdenticalCount:0` is vacuous with a " +
          "NON-EMPTY `emitCompareTestFiles` (selected-test-files arm: a test-only diff has no compiled files " +
          "to compare, so 0 = nothing to check); with an EMPTY one it is the emit-identity arm, fully " +
          "informative (build + static guards only, no test files ran). The `[loom:merge-done]` nudge tells " +
          "the arms apart: \"…+ N selected test file(s)\" (N is the widened count, not the changed-file " +
          "count) vs \"…static guards only, skipped the full daemon test suite\". " +
          "`retriedFile`/`retryPassed` (bounded single-/multi-file retry, solo AND batch rows): a " +
          "`gateType:\"merge\"` row whose test step named up to `MULTI_FILE_RETRY_MAX` identifiable, " +
          "re-runnable files retried together once before the verdict. `retriedFile` is the comma-joined " +
          "retried name(s), `null` on most rows. A `\"pass\"` with non-null `retriedFile` is WEAKER than a " +
          "clean pass (the first attempt failed for real; only the isolated re-run was green, the shape an " +
          "order-dependent/pollution bug produces). `retryPassed:false` = the retry also failed and the row " +
          "rejected as if no retry existed. `retryDeclineReason` is present ONLY when a genuine failure " +
          "(never a kill/timeout attempt 1; the transient-kill retry owns those) was eligible but " +
          "`identifyRetriableTestFiles` declined: `\"no-fail-tier-match\"`|`\"count-mismatch\"`|" +
          "`\"over-cap\"`|`\"harness-not-executed\"`|`\"unparseable-name\"`|`\"file-not-found\"`|" +
          "`\"duplicate-name\"`. Mutually exclusive with non-null `retriedFile`; `undefined` on most rows " +
          "(never read it as \"eligible\"). It has NO `gate_status(opId)` equivalent: durable only here. " +
          "HISTORICAL exception: `retriedFile` non-null with `retryPassed:null` = a retry whose own " +
          "admission was cancelled while queued (`outcome:\"cancelled\"`); older rows only. On a non-null " +
          "`retriedFile` row the retry is a link of attempt 1's single admission: `durationMs` is attempt 1's " +
          "run time alone, `concurrentGates` its admission snapshot, `concurrentGatesMax` the max across the " +
          "chain, and `passed` the final retry-inclusive verdict (older rows' triple may describe the " +
          "retry's separate admission). " +
          "`\"cancelled\"` is a distinct outcome, NEVER a rejection: a withdrawn run (`gate_cancel`, queued or " +
          "running) reached no verdict. Compute pass/fail or REJECTION rates by filtering on " +
          "`outcome===\"reject\"`, never `passed===false` alone (`passed` is false for cancelled and skipped " +
          "rows too). Historical shape (older rows): a `\"reject\"` `build_gate` row followed (same `opId`) " +
          "by a `\"cancelled\"` `build_gate_retry` row is ONE unresolved op, not a rejection. `outcome` is " +
          "derived live from stored detail, so old rows are classified retroactively and trends compare " +
          "safely on it. `transientRetried`: `true` iff THIS row is the transient-kill retry's own " +
          "`build_gate_retry` row; `false` on every `build_gate`/`worker_gate`/`deploy` row; never both " +
          "truthy with `retriedFile`. `gate_status(opId).transientRetried` means something DIFFERENT (the " +
          "merged verdict was reached via the retry, a weaker pass); don't carry meaning across surfaces. " +
          "`\"skipped\"` is also a non-verdict, NEVER a pass: a merge whose whole changed-path set was " +
          "proven inert (docs-only) spawns no gate; `outcome` reads `\"skipped\"` and `passed` reads `false`. " +
          "Never count it as a pass or a rejection; filter on `outcome`. It pairs with `gateRan:false` but " +
          "differs from a REUSED self-check (also `gateRan:false`), which is a real prior verdict and stays " +
          "`\"pass\"`. `gate_status(opId)` reports `\"skipped\"` for the same op. " +
          "`gateRan`: did a gate PROCESS spawn for this row. `false` for a merge that reused a green worker " +
          "self-check, a skipped-as-inert merge, or a worker self-check cancelled before admission; `true` " +
          "otherwise (including cancelled while running). Use it to exclude non-runs from a duration series " +
          "(a non-run's `durationMs` is bookkeeping and biases averages toward \"faster\"). Never `null`, but " +
          "derived: exact for a `reused` row or one with an explicit `gateSpawned` stamp; older cancelled " +
          "rows fall back to `durationMs` presence (reliable, not guaranteed). " +
          "This tool is the INDEX, not the full-detail surface. A merge row's `failingTest` is read from the " +
          "settled verdict payload, so \"has test X failed before\" is answerable from these pages for most " +
          "merge rejections. It is `null` when that payload has nothing (an older row, a pass/cancelled/" +
          "skipped verdict, or output with no recognizable marker). For those, and for the fuller diagnostic " +
          "(`phase`/`stderrTail`/`outputTail`/`exitCode`/`signal`/`timedOut`), call `gate_status(opId)`. A " +
          "`\"worker\"` row's `failingTest` is populated inline and its `opId` is `null`; `opId` is also " +
          "`null` for `\"deploy\"` rows and rows from before the field shipped. " +
          "`concurrentGates` vs `concurrentGatesMax` answer DIFFERENT questions. `concurrentGates` is a " +
          "snapshot AT ADMISSION only (a run contended for 95% of its wall time can still read 1 if admitted " +
          "solo). `concurrentGatesMax` is the max admitted at once while the run was in flight: use it for " +
          "\"was this run actually contended\". `concurrentGatesMax` is never backfilled: `null` on rows " +
          "from before it shipped, independent of `concurrentGates` (a `null` Max beside a present " +
          "`concurrentGates` is the normal historical shape). `durationMs`/`gateCap`/`concurrentGates`/" +
          "`concurrentGatesMax` are each `null` only on rows from before THAT field was stamped (they shipped " +
          "separately, so no single date scopes all four) and never `null` on a REJECTED row once stamped. " +
          "`limit`/`offset` paginate (default " + DEFAULT_GATE_HISTORY_PAGE + ", clamped to " + MAX_GATE_HISTORY_PAGE + "). " +
          "The default is sized so an unprojected page (~900 chars/row) fits under the tool-result cap; for " +
          "more rows per page use `fields` FIRST (it shrinks each row) rather than raising `limit`. " +
          "`nextOffset` is `offset+items.length` while more rows remain, else `null`; page via " +
          "offset:nextOffset until null. There is NO `projectId` parameter: the project is always the " +
          "caller's own, resolved server-side, and foreign rows are never returned. `fields:[...]` (same " +
          "contract as `tasks_list`'s) keeps ONLY the named top-level keys of each row (others are absent, " +
          "unknown names are ignored, `id` is NOT auto-added), e.g. [\"outcome\",\"durationMs\",\"endedAt\"]. " +
          "`countsOnly:true` returns {total, byGateType, byOutcome} instead of {items,...} over the WHOLE " +
          "project-scoped matching set; `limit`/`offset`/`fields` are ignored. `byGateType`: " +
          "\"merge\"|\"worker\"|\"deploy\"|\"landingCheck\"|\"distImporterCheck\" (the last two are the " +
          "ungated-landing safety-net check and the automatic dist-importer advisory: not real gates, tallied " +
          "separately so they never inflate \"worker\"). `byOutcome`: " +
          "\"pass\"|\"reject\"|\"timeout\"|\"kill\"|\"cancelled\"|\"skipped\"|\"error\" (\"error\" = the " +
          "dist-importer check's own mechanism failure, never a real test red). A rejection-rate reader " +
          "must apply the cancelled-retry pairing above and never fold \"error\" into the rate.",
        inputSchema: strictShape({
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          fields: z.array(z.string()).optional(),
          countsOnly: z.boolean().optional(),
        }),
      },
      async ({ limit, offset, fields, countsOnly }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        if (countsOnly) return ok(db.countGateEvents({ projectId }));
        const off = offset ?? 0;
        const page = db.listGateEvents({ projectId, limit: limit ?? DEFAULT_GATE_HISTORY_PAGE, offset: off });
        // Card 40f4cae9: nextOffset is derived from page.items.length/page.total BEFORE projection — fields
        // narrows what's IN each row, never how many rows there are (same ordering rule as tasks_list).
        const nextOffset = off + page.items.length < page.total ? off + page.items.length : null;
        const items = pickFields(page.items as unknown as Record<string, unknown>[], fields);
        return ok({ items, total: page.total, limit: page.limit, offset: off, nextOffset });
      },
    );

    // @decision 60c1fff8 — never hand-copy the unknown-`kind` rejection predicate here; reuse
    // `eventsSearchQuery` verbatim, the same query path the Platform surface's own registration uses.
    // Never add a `projectId` parameter — the project is always the caller's own, resolved server-side.
    // @decision ab1d1129 — never COALESCE two session-id columns that can independently hold `""` without
    // `NULLIF`-normalizing first — `""` is treated as present and wins over a real id in the other column.
    //
    // ⚠️ A SEPARATE, still-live quirk this does NOT touch — COALESCE prefers the worker/target session for
    // attribution even when it resolves, so a `cross_project_message` sender can't see its own outbound
    // sends here — is documented on the tool description below (this comment is why, not what).
    // card eec70b79 — SPILL to NDJSON (see spill.ts). card eb62d585 — countsOnly short-circuit (see
    // db.ts/mcp/eventsSearch.ts).
    server.registerTool(
      "events_search",
      {
        description:
          "A BOUNDED, newest-first page of orchestration_events for YOUR OWN project ONLY: the general " +
          "sibling of `gate_history` (settled GATE runs only), for forensics beyond gate-run kinds (e.g. " +
          "kill_switch/recycle_begin/merge_rejected/platform_escalate). `kind` optionally narrows to " +
          "specific event kinds (omitted = every kind). An UNRECOGNIZED kind is an EXPLICIT error naming " +
          "the bad value(s), never a silent `[]` (which would misread as \"never occurred\"). Valid kind " +
          "values: " + EVENT_SEARCH_VALID_KINDS_LIST + ". PROJECT-SCOPED SERVER-SIDE, NOT BY ARGUMENT: " +
          "no `projectId` parameter; the project is always the CALLER's own. `sessionId` (the DAEMON's " +
          "Loom-namespaced session id, e.g. `loomSessionId` from `my_context` or the `id` from " +
          "`list_all_sessions`, never the engine's own id) matches an event where that session is " +
          "EITHER the manager or the worker. `taskId` matches the event's linked task. Each event " +
          "returns {id, ts, kind, detail, taskId, taskTitle, loomSessionId, projectId, projectName, " +
          "agentName, branch}; `detail` is the raw kind-specific payload (operational metadata, not " +
          "transcript content). limit/offset paginate (default " + DEFAULT_EVENTS_SEARCH_CAP +
          ", clamped to " + MAX_EVENTS_SEARCH_PAGE + "); the result is ALWAYS the {events, total, " +
          "returned, offset, nextOffset, limit} envelope; page via offset:nextOffset until null. " +
          "`limit` echoes the EFFECTIVE, clamped limit: if it differs from what you passed, `returned` " +
          "is NOT the whole matching set even though `total` may say otherwise. " +
          "SPILL: an `events` array too large to inline is written as NDJSON (one event per line, " +
          "UTF-8) to your scratch dir; `events` is then ABSENT, replaced by `eventsFile`/`eventsChars`/" +
          "`eventsCount`/`note` beside the same total/returned/offset/nextOffset/limit; page it with " +
          "Read (offset/limit are LINE-based) or grep, like tasks_list's `rowsFile`. " +
          "⚠️ For a `cross_project_message` event, project-scoping prefers the WORKER/target session " +
          "over the sender's, so a manager can be structurally unable to see its own outbound peer " +
          "messages here (they scope to the RECIPIENT project); never read a `0`/missing result on " +
          "this class as \"never happened\": check the recipient project's read. ⚠️ " +
          "`session_message_delivered` events carry no project attribution (no resolvable session, no " +
          "linked task) and are invisible to EVERY project-scoped read, this one included; a " +
          "`0`/missing result on that kind is likewise no proof it didn't happen. `fields:[...]` (same " +
          "contract as `tasks_list`'s) projects each event to ONLY the given top-level keys, e.g. " +
          "fields:[\"ts\",\"kind\",\"taskId\"]; others are genuinely ABSENT, unknown names are silently " +
          "ignored, `id` is NOT auto-added. `countsOnly:true` (same contract as `tasks_list`'s) " +
          "short-circuits before any row fetch or spill and returns {total, byKind} for the WHOLE " +
          "matching set (already `kind`-filtered if you passed one); `limit`/`offset`/`fields` are " +
          "ignored.",
        inputSchema: strictShape({
          kind: z.array(z.string()).optional(),
          sessionId: z.string().optional(),
          taskId: z.string().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          fields: z.array(z.string()).optional(),
          countsOnly: z.boolean().optional(),
        }),
      },
      async ({ kind, sessionId, taskId, limit, offset, fields, countsOnly }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        if (countsOnly) return ok(eventsCountQuery(db, { kind, projectId, sessionId, taskId }));
        const result = eventsSearchQuery(db, { kind, projectId, sessionId, taskId, limit, offset, fields });
        if ("error" in result) return ok(result);
        // Card eec70b79: proactively spill the `events` array as NDJSON (same shape tasks_list/
        // list_all_tasks already spill) instead of letting a wide page fall through to the host
        // engine's own opaque single-line overflow-spill, which is unpageable. Key hashes the
        // effective query so two different filters never collide on one scratch file.
        const spillKey = `events-${createHash("sha1")
          .update(JSON.stringify({ kind: kind ?? null, sessionId: sessionId ?? null, taskId: taskId ?? null, limit: limit ?? null, offset: offset ?? 0, fields: fields ?? null }))
          .digest("hex").slice(0, 10)}`;
        const spill = spillRowsIfLarge(managerSessionId, "events-search-spills", spillKey, result.events, SPILL_INLINE_BUDGET_CHARS);
        if (spill.inline) return ok(result);
        const { events, ...rest } = result;
        return ok({ ...rest, eventsFile: spill.file, eventsChars: spill.chars, eventsCount: spill.rowCount, note: spill.note });
      },
    );

    // gate_cancel (card 8d585277): the manual cancel/supersede escalation for a case auto-supersede-on-
    // merge does NOT cover — no merge decision exists yet (a known-failing base, a stale/UNVERIFIED
    // self-check, a force-push, a worker recycled mid-run). Firing `worker_merge_confirm` already
    // reclaims a QUEUED self-check for free (see confirmWorkerMergeTracked); this tool is for everything
    // else, and the one case a QUEUED cancel can't help with — an ALREADY-RUNNING worker self-check.
    // @decision b9e07a4a — ALSO REACHES a repo-guard-only wait (gate_queue's repoGuardOnly array).
    // @decision 59986602 — ALSO REACHES a merge waiting on its worker's own self-check.
    // @decision a0d912f5 — intent/reason render into the cancelled op's own settle text.
    server.registerTool(
      "gate_cancel",
      {
        description:
          "Withdraw/cancel ONE of your OWN project's gate ops, by the `opId` a `run_gate`/" +
          "`worker_merge_confirm` pending response or `gate_queue` entry already named (full id or an " +
          "unambiguous prefix). Use this for a case firing `worker_merge_confirm` doesn't already cover — " +
          "e.g. the branch's base is known-failing, its last self-check settled `headCurrent:false` (UNVERIFIED), " +
          "it was superseded by a new commit, or the worker was recycled mid-run — with no merge decision in " +
          "sight to auto-reclaim it. A worker's own `run_gate` self-check (gateType `worker`) is cancellable " +
          "queued OR running. A `merge` gate is cancellable ONLY while QUEUED (nothing was spawned for it); a " +
          "RUNNING merge gate is refused, because interrupting it can leave staged residue in the canonical " +
          "checkout that fails closed and needs a HUMAN to clear before any further merge on that repo " +
          "succeeds. A `deploy` gate is refused in EITHER phase (it has no clean cancelled outcome). " +
          "Returns {outcome:\"cancelled\", phase:\"queued\"|\"running\", opId, gateType, note?} on success " +
          "(`note` ONLY for the waiting-on-self-check branch below). A cancelled QUEUED merge settles its " +
          "`worker_merge_confirm` op as a distinct `cancelled` outcome — not merged, not rejected — via a " +
          "`[loom:merge-cancelled]` nudge, never `[loom:merge-failed]`; a cancelled QUEUED `merge_batch` gate " +
          "likewise settles `cancelled` (`[loom:merge-batch-cancelled]`) and starts NO per-candidate fallback " +
          "merges. A cancelled worker self-check or queued merge is never a failure: the " +
          "`[loom:gate-cancelled]`/`[loom:merge-cancelled]` nudge says so, so don't read one as a red to chase. " +
          "{outcome:\"refused\", reason} means the op belongs to a DIFFERENT project. {outcome:\"not_found\"} " +
          "means nothing LIVE to cancel — this tool acts only on the live GateSemaphore registry (plus the two " +
          "fallbacks below), never durable history, so it can't say whether the op already settled or never " +
          "existed; call `gate_status(opId)` (which distinguishes `settled` from `never_existed`) and rely on the " +
          "`[loom:gate-*]`/`[loom:merge-*]` nudge for a settled op's real outcome. " +
          "{outcome:\"ambiguous\", reason} means your opId prefix matches more than one op in YOUR project — " +
          "pass more characters. {outcome:\"not_cancelled\", reason} covers every other miss: the op left the " +
          "queue or finished in the moments before this call (a genuine race, never fabricated as cancelled), " +
          "a RUNNING merge gate or a deploy gate (unsupported), or a RUNNING self-check whose kill was issued " +
          "but whose process tree's death could not be VERIFIED within a bounded window — reported NOT " +
          "cancelled on purpose (the run continues under its own timeout) rather than freeing a slot over work " +
          "that may still run. " +
          "{outcome:\"cancel_signalled\", reason, opId, gateType} is the SAME situation for the automatic " +
          "dist-importer advisory check only (a `distImporterCheckOnly` entry): the abort WAS delivered, but " +
          "that run only observes a cancel between its worktree-cut / build / test phases, so it may take " +
          "minutes to leave the queue — re-check `gate_queue` rather than re-cancelling. " +
          "ALSO REACHES a repo-guard-only wait (an inert-diff-skip merge waiting on a same-repo sibling's guard, " +
          "in gate_queue's `repoGuardOnly` array): tried automatically when the opId matches nothing in the " +
          "ordinary registry, same ambiguity handling. A QUEUED one cancels like a queued merge; a " +
          "currently-HOLDING one is refused like a RUNNING merge gate (same staged-residue hazard). `gateType` on " +
          "a successful cancel here always reads \"merge\". " +
          "ALSO REACHES a merge waiting on its worker's self-check (`gate_queue`'s `waitingOnSelfCheck` array): " +
          "tried automatically when the opId matches neither the ordinary registry nor a repo-guard-only wait. " +
          "Pass the MERGE's own opId (never the self-check's): that ends the wait with zero process risk and " +
          "settles the merge as a clean `cancelled`. The self-check is LEFT RUNNING untouched (its verdict may " +
          "still be wanted), so `note` names its opId; cancel that separately if you want it stopped too. " +
          "`gateType` there also reads \"merge\". " +
          "`intent`/`reason` (both optional) are rendered into the `reason` text this call returns AND into the " +
          "cancelled op's settle text, which the `[loom:gate-cancelled]`/`[loom:merge-cancelled]` nudge reads out " +
          "to whoever is parked on that op. `intent` is a one-word next-step signal: `refire-when-clear` (re-fire " +
          "once whatever you're clearing makes way, e.g. a merge about to land), `hold-for-instructions` (don't " +
          "re-fire yet), or `superseded` (a newer run replaces this one). `reason` is free text for anything the " +
          "intent doesn't say. Omitting both still cancels, with the generic nudge wording.",
        inputSchema: strictShape({
          opId: z.string(),
          intent: z.enum(["refire-when-clear", "hold-for-instructions", "superseded"]).optional(),
          reason: z.string().optional(),
        }),
      },
      async ({ opId, intent, reason }) => {
        // @decision 92c20eb9 — a retiring predecessor must not cancel a gate op its successor now owns.
        const superseded = callerSupersededError();
        if (superseded) return ok(superseded);
        try {
          return ok(await sessions.cancelGateOp(managerSessionId, opId, { scope: { kind: "project" }, intent, reason }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // @decision 81331b0e — register only when isSupervised(), never isLoomDev(): an npm manager must
    // never see a tool that always refuses, and the two flags can diverge either way (isLoomDev() alone
    // would miss that).
    if (isSupervised()) server.registerTool(
      "daemon_restart",
      {
        description:
          "SELF-HOSTING ONLY (orchestrating Loom with Loom): rebuild + restart the Loom daemon so merged " +
          "daemon-`src` code goes LIVE in the running process. Use after you've merged worker branch(es) that " +
          "change the daemon and you need the new behavior actually running (e.g. to end-to-end verify it). " +
          "Loom REBUILDS FIRST: if the build fails it does NOT restart and returns the error (stays up — fix it " +
          "and retry). On a green build the daemon restarts: EVERY live session across ALL projects is dropped " +
          "— not just your own pty and your live workers', but the whole fleet — then the whole fleet (you and " +
          "your live workers included) is AUTOMATICALLY resumed with a note once it's back. Returns " +
          "{restarting:true} on success, or {restarting:false, error} if unsupervised, a live restart " +
          "supervisor process can no longer be confirmed (card 83718377 — it re-checks the live OS process " +
          "table on every call, not just whether this process was ONCE spawned under one; refuses rather " +
          "than exit into an orphan nothing would relaunch — retry if the error says the CHECK itself " +
          "failed, ask a human to restart the supervisor if it says the supervisor is actually gone), or " +
          "build failed. If the " +
          "deploy going live also touches scripts/daemon-supervisor.mjs (the OUTER process that spawned this " +
          "daemon and is NOT re-execed by this restart), the success result additionally carries " +
          "{supervisorChanged:true, supervisorWarning} — those lines are silently inert until a human does a " +
          "manual `pnpm daemon:stable`; never report that part of the change as fully live. Card 2e84a250: if " +
          "that check ITSELF fails (e.g. git unavailable) the result instead carries " +
          "{supervisorCheckFailed:true, supervisorWarning} — a DIFFERENT, mutually-exclusive pair of fields, " +
          "never folded into supervisorChanged/false — treat this as UNKNOWN whether the supervisor script " +
          "changed, not as a confirmed-clean deploy; the SAME distinction also appears on the post-restart " +
          "resume nudge you receive once the fleet comes back (this immediate response returns into a " +
          "session about to be killed by the restart itself, so that nudge is your reliable read of it). " +
          "Card 062fa934: the " +
          "post-restart resume nudge you receive may likewise WITHHOLD its usual 'your merged daemon code is " +
          "now LIVE' assurance if the freshly-restarted process's own build signature can't be confirmed " +
          "(`deploySignatureMismatch` — a turbo cache-replay signature; see `served_status`) — that is a notice " +
          "about what's KNOWN, not a failed restart; verify behavior directly rather than assuming the merge landed. " +
          "LIVE GATES ARE NOT ORPHANED BY DEFAULT: after the build, if any real gate/merge op (a worker's run_gate " +
          "self-check, a merge gate — in ANY project; advisory dist-importer checks don't count) is still in flight, " +
          "the restart WAITS up to ~2 minutes for them to settle (new worker run_gate calls are refused with " +
          "'retry in ~1 min' meanwhile, and the owning managers of other projects are told), then REFUSES with " +
          "{restarting:false, liveOpsRefused:[{opId,kind,projectId}], error} and the daemon stays up — park and " +
          "retry once they settle (`gate_queue`'s restartSafe:true is the same check). Override ONLY when an " +
          "urgent restart can't wait for another project's gate (a full-suite gate can run for hours): pass " +
          "proceedDespiteLiveOps:true AND a non-empty proceedReason — the wait is skipped, those ops ARE orphaned " +
          "(their verdict is lost and never re-fired; the opIds come back in `orphanedOps` and are recorded in the " +
          "restart intent) and every owning manager, in every project, gets a [loom:restart-orphaning] nudge " +
          "naming its opIds before the exit.",
        inputSchema: strictShape({ reason: z.string(), proceedDespiteLiveOps: z.boolean().optional(), proceedReason: z.string().max(500).optional() }),
      },
      async ({ reason, proceedDespiteLiveOps, proceedReason }) => {
        // @decision 92c20eb9 — a retiring predecessor must not trigger a fleet-wide restart mid-settle.
        const superseded = callerSupersededError();
        if (superseded) return ok(superseded);
        if (proceedDespiteLiveOps && !(proceedReason ?? "").trim()) {
          return ok({ restarting: false, error: "proceedDespiteLiveOps:true requires a non-empty proceedReason (why orphaning the live gate/merge ops is acceptable) — nothing was restarted." });
        }
        try {
          return ok(await sessions.requestDaemonRestart(managerSessionId, reason, proceedDespiteLiveOps ? { proceedDespiteLiveOps: proceedReason!.trim() } : {}));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // Field-provenance pointers for this tool's description below:
    // @decision 1069c8e1 — the additive-only rotation guard protects all three fields.
    // card eba7a6f7 — rotationLiveCommitmentsMarker anchors on an explicit token (see rotation-check.ts).
    // card 3c30258f — rulesPath unions markers against a non-rotating rules file (see rotation-check.ts).
    // @decision e312b207 — the LIVE-COMMITMENTS floor is unioned with the rules file too.
    // @decision 870edbcf — rulesCheck.ok does not drive the overall ok.
    // @decision f6985338 — rulesPaths dedupes rule sources by resolved path.
    // @decision cd0c85f1 — a marker being FOUND is not evidence its content survived.
    server.registerTool(
      "resume_doc_check",
      {
        description:
          "Check YOUR OWN resume doc's rotation integrity against this project's configured " +
          "protected-marker set (orchestration.rotationMarkers) and, if configured, its LIVE-COMMITMENTS-" +
          "style numbered-section floor (orchestration.rotationLiveCommitmentsHeading/" +
          "rotationLiveCommitmentsFloor). Reads your ACTIVE resume doc ITSELF: there is NO path argument " +
          "for it, so it can't be mis-aimed (the resolved doc follows project_update's " +
          "config.orchestration.resumeDocFilename if yours has a non-default name). No arguments = " +
          "lint-mode (markers + floor only). ⚠️ `configured:false` = this seat has set up NO protection: " +
          "its `ok:true` is VACUOUS (nothing was checked). Add markers with project_update's " +
          "orchestration.rotationMarkers, an array of `{token: string, caseSensitive?: boolean, note?: " +
          "string}` objects, NOT bare strings (additive-only from this session; ask a human/Lead to " +
          "remove one). " +
          "The LIVE-COMMITMENTS section is normally found by the first heading line CONTAINING " +
          "`rotationLiveCommitmentsHeading`, so an earlier heading that merely CITES that text can win. " +
          "Set `orchestration.rotationLiveCommitmentsMarker` (e.g. `<!-- loom:live-commitments -->` on " +
          "its own line above the heading or inline on it) to anchor on that token instead; once set " +
          "there is NO fallback to heading search. A marker occurring more than once yields " +
          "`liveCommitments.markerAmbiguous`/`markerOccurrences` plus a top-level " +
          "`markerAmbiguityWarning`, never a silent first-match. " +
          "⚠️ HONEST LIMIT: every check is an exact-substring grep: it proves literal text survived, not " +
          "that no meaning was lost to rewording. A green is a candidate set, never a verdict; still read " +
          "the real diff. At an actual ROTATION pass `archivePath` to verify the archive file exists and " +
          "is non-empty (must resolve INSIDE this project's vaultPath, else refused; conventionally a " +
          "`<name>.archive/<date>.md` sibling of the active doc). Pass `preEditBytes` (a byte count YOU " +
          "measured before editing) to verify the doc shrank: CUT-scoped, omit it for an ordinary " +
          "rotation (a replacement). " +
          "`rulesPath` also union-checks markers against a NON-ROTATING rules file (e.g. an Orchestrator " +
          "Rules.md): a marker is satisfied if present in the ACTIVE doc OR the rules file (a union, " +
          "NEVER a replacement; a marker in NEITHER still fails). It also unions the LIVE-COMMITMENTS " +
          "floor: the numbered section is counted in the active doc first, the rules file only when the " +
          "active doc has no such heading at all. `liveCommitments.source` (\"active\"|\"rules\"|null) names " +
          "which file the count came from (null only with a hard failure: heading in NEITHER file). Like " +
          "`archivePath`, `rulesPath` must resolve INSIDE this project's vaultPath (refused otherwise). " +
          "⚠️ If `rulesPath` is supplied but unreadable (e.g. vault-ROOT-relative instead of this " +
          "project's vaultPath), the union degrades to active-only: `ok` is unaffected only while the " +
          "active doc alone satisfies everything; once the LIVE COMMITMENTS section has moved, the floor " +
          "(and `ok`) genuinely FAILS, by design. Always check `rulesCheck` when you pass this: " +
          "`rulesCheck.ok:false` names the exact resolved path that could not be read, so a red `ok` is " +
          "diagnosable as 'rulesPath unreadable', not 'the section is gone'. ⚠️ If the LIVE COMMITMENTS " +
          "heading is found in BOTH the active doc and the rules file (the active doc's count wins), the " +
          "response carries a top-level `ambiguityWarning`: expected transient residue of a doc " +
          "mid-migration; resolve it. " +
          "`rulesPaths` (an array; even one entry) unions against MULTIPLE rules files and switches to an " +
          "EXTENDED response shape: `markerSources` values and `liveCommitments.source` become the " +
          "resolved path instead of \"rules\", ambiguity yields `liveCommitments.otherSources` (every OTHER " +
          "place found) instead of `otherCount`/`otherDiagnostic`, and each entry is independently " +
          "vault-contained and reported in `rulesChecks` (a missing/unreadable file is a REAL entry with " +
          "`ok:false`, never dropped from the union). " +
          "A marker being FOUND is NOT evidence its content survived: a line that merely NAMES it reads " +
          "identical in `markerSources`/`ok`. The response also carries `markerHits` (per FOUND marker: " +
          "every line in its winning source containing the token, each with a match-centered excerpt, " +
          "and `sharedLineMarkers` naming any OTHER configured marker on that line) and a top-level " +
          "`markersNeedingReview` (tokens whose hits carry `multipleHits` or a non-empty " +
          "`sharedLineMarkers`): 'inspect these', never a verdict, never folded into `ok`. Read the " +
          "excerpts yourself to tell a meta-mention from real content.",
        inputSchema: strictShape({
          archivePath: z.string().optional(),
          rulesPath: z.string().optional(),
          rulesPaths: z.array(z.string()).optional(),
          preEditBytes: z.number().int().positive().optional(),
        }),
      },
      async ({ archivePath, rulesPath, rulesPaths, preEditBytes }) => {
        const managerProjectId = db.getSession(managerSessionId)?.projectId;
        const project = managerProjectId ? db.getProject(managerProjectId) : undefined;
        if (!project) return ok({ error: "no project bound to this session" });
        const resolved = resolveConfig(project.config, db.getPlatformConfig());
        const resumeDocPath = resolveResumeDocPath(project.vaultPath ?? "", resolved.orchestration.resumeDocFilename);
        if (!resumeDocPath) return ok({ error: "this project has no vaultPath — no resume doc to check" });
        // Code review (🟡): contain a caller-supplied archivePath under this project's own vaultPath —
        // see containUnderVault's own doc for why (it's a real host path reaching fs.statSync).
        let containedArchivePath: string | null = null;
        if (archivePath) {
          const contained = containUnderVault(project.vaultPath ?? "", archivePath);
          if (!contained.ok) return ok({ error: contained.error });
          containedArchivePath = contained.value;
        }
        // Card 3c30258f: rulesPath is a THIRD caller-supplied host path (reaches fs.readFileSync) — same
        // vault containment treatment as archivePath, never a third unguarded path.
        let containedRulesPath: string | null = null;
        if (rulesPath) {
          const contained = containUnderVault(project.vaultPath ?? "", rulesPath, "rulesPath");
          if (!contained.ok) return ok({ error: contained.error });
          containedRulesPath = contained.value;
        }
        // Card f6985338: rulesPaths — same containment as rulesPath, applied to each entry independently
        // so one bad entry names itself in the refusal rather than a generic "one of these is wrong".
        const containedRulesPaths: string[] = [];
        if (rulesPaths) {
          for (let i = 0; i < rulesPaths.length; i++) {
            const contained = containUnderVault(project.vaultPath ?? "", rulesPaths[i]!, `rulesPaths[${i}]`);
            if (!contained.ok) return ok({ error: contained.error });
            containedRulesPaths.push(contained.value);
          }
        }
        return ok(
          runResumeDocCheck({
            resumeDocPath,
            markers: resolved.orchestration.rotationMarkers,
            commitmentsHeading: resolved.orchestration.rotationLiveCommitmentsHeading,
            commitmentsFloor: resolved.orchestration.rotationLiveCommitmentsFloor,
            commitmentsMarker: resolved.orchestration.rotationLiveCommitmentsMarker,
            archivePath: containedArchivePath,
            rulesPath: containedRulesPath,
            rulesPaths: containedRulesPaths.length > 0 ? containedRulesPaths : null,
            preEditBytes: preEditBytes ?? null,
          }),
        );
      },
    );

    // Registered ONLY when this project has a configured deployCommand (see deployCommandConfigured
    // above, which resolves via the EXACT SAME `resolveConfig(project.config, db.getPlatformConfig())
    // .orchestration.deployCommand` call — and the same falsy/"" check — that sessions.deployOwnProject
    // itself uses to decide whether to refuse) — a project with none would just get {deployed:false,"no
    // deployCommand configured"} every time, so most projects (deployCommand is human-only, opt-in) never
    // need this in their floor.
    // card 720bb7ad — opId correlates this run to the deploy audit event + gate-timing NDJSON row.
    // @decision bed91595 — deploy resolves durably via gate_status(opId)'s pending_gate_ops tombstone.
    if (deployCommandConfigured) {
      server.registerTool(
        "deploy",
        {
          description:
            "Deploy/push YOUR OWN project — least-privilege, no promotion to a cross-project Lead needed. " +
            "Runs the project's HUMAN-configured `orchestration.deployCommand` (a build script, `git push`, " +
            "or a deploy webhook curl — whatever the owner set up) in the project's own repo, bounded by a " +
            "per-project timeout. There is NO projectId/host/branch/repo param — the project is always YOUR " +
            "OWN, derived server-side from this session; you can never deploy anything else. Refuses with " +
            "{deployed:false,reason} if you've hit the per-manager deploy rate " +
            "limit. `reason` is a short note for the audit trail only — it is never part of the command run. " +
            "On success returns {deployed:true,opId}; on a failed run returns {deployed:false,reason,exitCode," +
            "outputTail,opId} with a bounded stdout+stderr tail to diagnose from. `opId` " +
            "correlates this run to the daemon's own `deploy` audit event and, if the project's gate command " +
            "shells out to a per-package test runner (e.g. `npm test`, or a monorepo tool scoped to one package), to that run's own gate-timing NDJSON " +
            "row — absent only when refused before any host exec was attempted (unconfigured/rate-limited). " +
            "It also durably resolves via `gate_status(opId)` — the same result this call " +
            "already returned, recoverable later, across a restart, without having to have caught it here.",
          inputSchema: strictShape({ reason: z.string() }),
        },
        async ({ reason }) => {
          // @decision 92c20eb9 — a retiring predecessor must not unilaterally deploy on the fleet's behalf.
          const superseded = callerSupersededError();
          if (superseded) return ok(superseded);
          try {
            const r = await sessions.deployOwnProject(managerSessionId, reason);
            // Card bed91595: `deployOwnProject` now writes its own durable `pending_gate_ops` tombstone —
            // no in-process recording needed here any more (card 8052977a's cache is removed).
            return ok(r);
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );
    }

    // GAP 2: a deploy/served-state read so post-daemon_restart verification doesn't need curl. Minimal by
    // design — just what's trivially available server-side: the umbrella package version, the served web
    // bundle's asset filename (Vite hashes it, e.g. "index-Ab12Cd34.js", so a changed hash after a restart
    // proves the NEW web build actually went live — null if the dist isn't built/found), this daemon
    // process's uptime, and a cross-project live-session count (a coarse "the fleet is still here"
    // sanity check, not a per-project breakdown — worker_list/worker_status already cover that scoped view).
    //
    // Field-provenance pointers for the description below, relocated out of the agent-facing text (an
    // end-user agent can't resolve a card/decision id). Entries with a matching docs/decisions record use
    // @decision; a bare `card <id>` line has no such record and is a plain provenance citation.
    //
    // @decision 5e30c4bd — `version`/`webBundle` are BOTH byte-identical before/after a daemon-src-only
    // deploy; never use either as a staleness proxy.
    //
    // @decision 3d7dccb9 — a sha mismatch alone is not an authoritative "did my deploy land" signal;
    // `builtContentMatchesHead` is the fix, and `deploySignatureMismatch` can ALSO be the same cry-wolf
    // case rather than a genuine cache-replay.
    //
    // @decision 404bfc75 — the ancestor-path content check backing `builtContentMatchesHead`'s
    // behavioural-equivalence sub-case, and why a `commitsBehind > 0` reading alongside `stale:false` is
    // a legitimate combination once it proves every commit inert.
    //
    // card 7a44e7a1 — `stale`/`commitsBehind` reading clean while `processBuiltShaMatchesHead` reads
    // false is the deliberate cry-wolf control case, not a contradiction.
    //
    // @decision 9aa4e2c9 — `processStartedAt` reads `performance.timeOrigin` once at process start, unlike
    // the mtime/git-derived fields that legitimately differ read to read.
    //
    // @decision e8697dd3 — bundled skills are excluded from `stale`/`commitsBehind`'s restart-relevant
    // scoping; `skillStoreStaleness` is the separate signal for that subtree.
    //
    // @decision d3d4d432 — `reasonKind` splits "not applicable" (no `.git`) from "could not measure" (a
    // reachable check that failed); the two are not interchangeable.
    //
    // @decision 13965c93 — neither `pendingRestart` nor `pendingAdopt` means "every agent now has it";
    // splits the store/session-copy/agent-has-opened-it facts apart.
    //
    // @decision bb76b8d8 — `skillStoreStaleness` never consults git; `skillAssetsGitStatus` is the
    // missing git-aware half (an uncommitted shipped-asset edit reads as a clean bill otherwise).
    //
    // card 9775559c — `scratchRootBytes`/`scratchRootOverCeiling`, the shared per-session scratch root's
    // WARN-only footprint signal.
    //
    // card 1a686bad — `scratchGcSweep`, the boot GC's own last-sweep outcome as a four-state record.
    //
    // card 0e701396 — `scratchLargestDirs`, naming which dir is actually driving the scratch-root total.
    //
    // @decision 5eace211 — `projectsWorkRootBytes`/`projectsWorkRootOverCeiling`/`projectsWorkRootTruncated`,
    // the analogous fleet-wide figure for the per-project work root.
    //
    // @decision ad34efb5 — `staleWorktreeLeftovers` is deliberately count-only on this hot path; the byte
    // total lives behind a separate, explicitly-called REST route.
    //
    // @decision 3b65028c — `orphanedProjectWorkDirs`: visibility only, nothing here is ever auto-deleted.
    //
    // @decision f26339d7 — the baked-sha fields are the POSITIVE signal, split from the derived clock
    // fields they disagree with when a rebuild lands with no restart.
    //
    // @decision c3ce92ea — `webStale`/`webCommitsBehind` is a separate, independent signal from the
    // daemon's own `stale`; a web-only staleness reading means rebuild web, never restart the daemon.
    //
    // @decision 8ff7ccde — `distBuiltAt` is an on-disk artifact clock that can be NEWER than the code
    // this process is actually executing; `stale`/`commitsBehind` are computed against `runningCodeBuiltAt`
    // instead, never the raw `distBuiltAt`.
    server.registerTool(
      "served_status",
      {
        description:
          "Read what THIS daemon process is actually serving right now, for post-restart verification " +
          "without curl. Returns {version (the loom/loomctl package version), webBundle (the served " +
          "assets/index-<hash>.js filename, or null if the web dist isn't built/found), uptimeSeconds, " +
          "liveSessionCount (ACROSS ALL projects; use worker_list for your own fleet), deployStaleness, " +
          "skillStoreStaleness}. `version` and `webBundle` are byte-identical before/after a " +
          "daemon-`src`-only deploy: do NOT use either as a staleness proxy. " +
          "`deployStaleness` is the real signal for THE DAEMON PROCESS: " +
          "{available, stale, commitsBehind, distBuiltAt, processStartedAt, runningCodeBuiltAt, " +
          "distAheadOfProcess, mainlineHeadSha, mainlineHeadDate, webStale, webCommitsBehind, webDistBuiltAt, " +
          "distBuiltSha, distBuiltDirty, processBuiltSha, processBuiltDirty, distBuiltShaDiffersFromProcess, " +
          "processBuiltShaMatchesHead, deploySignatureMismatch, builtContentMatchesHead, webBuiltSha, " +
          "webBuiltDirty, reason?}. ⛔ `processBuiltSha`/`mainlineHeadSha` are NOT on their own an " +
          "authoritative \"did my deploy land\" pair: a sha MISMATCH (`processBuiltShaMatchesHead:false`, even " +
          "`deploySignatureMismatch:true`) can be a FALSE ALARM when a different, non-ancestor commit (e.g. a " +
          "worker worktree's union-forward merge commit) has a SHIPPED TREE byte-identical to mainline HEAD. " +
          "`builtContentMatchesHead` resolves it, by one of two comparisons: (a) `processBuiltSha` NOT an " +
          "ancestor of `mainlineHeadSha`: `true` = a byte diff scoped to the shipped paths was empty, the " +
          "mismatch is cosmetic; (b) `processBuiltSha` IS an ancestor AND `stale` is already `true`: it proves " +
          "BEHAVIOURAL equivalence (transpile-identity of every changed restart-relevant `.ts` file), so " +
          "`true` = a comment-only/inert diff, genuinely NOT stale despite `commitsBehind > 0`. Either " +
          "sub-case's `true` already overrides `stale` to `false` in the response; don't re-derive it. " +
          "`false` = the comparison ran and found a REAL difference (still stale). `null` = undetermined " +
          "(git/typescript couldn't resolve a side, the diff exceeded the file cap, or the soundness " +
          "precondition failed) OR neither sub-case applies (ancestor AND `stale` already `false`; no extra " +
          "check ran). When `processBuiltShaMatchesHead` is `false`, check `builtContentMatchesHead` before " +
          "concluding the deploy is stale. " +
          "The baked signal answers TWO questions: `distBuiltSha`/`distBuiltDirty` are a FRESH read of " +
          "`dist/build-info.json` on every call (what's on disk now; a rebuild changes it with no restart); " +
          "`processBuiltSha`/`processBuiltDirty` are captured ONCE at THIS PROCESS's start (what it is " +
          "executing; only a restart changes them). `null` when built outside a git checkout (e.g. a " +
          "packaged install) or unresolvable, never fabricated; these four survive `available:false`. " +
          "`dirty:true` (or `null`) means the build ran from an uncommitted checkout and the sha doesn't " +
          "represent what was compiled, so `processBuiltShaMatchesHead` reads `true` ONLY when " +
          "`processBuiltDirty` is exactly `false`. `distBuiltShaDiffersFromProcess:true` is a content-based " +
          "\"a rebuild landed that this process hasn't picked up\", stronger than the mtime-based " +
          "`distAheadOfProcess` (which a cache-replay's mtime bump can fool). `processBuiltShaMatchesHead` is " +
          "often `false` in healthy operation (mainline moves on unrelated docs/web/assets commits), so it is " +
          "NOT a staleness signal; `stale:false`/`commitsBehind:0` beside it `false` is not a contradiction " +
          "(restart-relevant paths only vs an exact sha match on any file). `deploySignatureMismatch:true` is " +
          "the defect detector worth acting on: the date clock says `stale:false` BUT `processBuiltSha`'s " +
          "commit date proves a restart-relevant commit landed after it. It can also be the false-alarm case " +
          "above, so check `builtContentMatchesHead` before treating it as confirmed staleness. " +
          "`webBuiltSha`/`webBuiltDirty` are the web analogue of `distBuiltSha`/`distBuiltDirty` (fresh every " +
          "call; informational only, no mismatch detector). The same payload is reachable from OUTSIDE any " +
          "agent session on the unprivileged loopback `GET /api/deploy-status`, for when the daemon itself is " +
          "under suspicion. Derived fields are fresh on every call (never cached); `processStartedAt` reads " +
          "`performance.timeOrigin` once per boot, so it is stable and joinable across reads of one boot. " +
          "`stale`/`commitsBehind` are scoped to ONLY this daemon's backend/shared-contract source commits " +
          "(\"does the daemon PROCESS need a restart\"). ⛔ Do NOT read that as \"an assets-only merge never " +
          "needs a restart\": see `skillStoreStaleness` below. `stale:true` = mainline HEAD carries " +
          "`commitsBehind` daemon-src/shared commit(s) this process was not built with AND " +
          "`builtContentMatchesHead` did not prove them inert; a restart (`daemon_restart` where your surface " +
          "has it, else a human relaunch) is needed, affecting every project this daemon serves. " +
          "`commitsBehind > 0` with `stale:false` is legitimate (`builtContentMatchesHead:true` proved them " +
          "inert, e.g. a comment-only anchor addition). `distBuiltAt` is an on-disk clock and can be NEWER than " +
          "the code the process runs; `stale`/`commitsBehind` are computed against `runningCodeBuiltAt` " +
          "(`min(distBuiltAt, processStartedAt)`), so never compute staleness from `distBuiltAt` alone (it " +
          "can UNDERSTATE it). `distAheadOfProcess:true` = the artifact was rebuilt since this process " +
          "started and not yet picked up. `webStale`/`webCommitsBehind` are the SEPARATE web signal: " +
          "`webStale:true` means REBUILD web, NOT restart the daemon (the bundle is served live from disk, " +
          "and a restart drops every live session across ALL projects for no reason). " +
          "`available:false` (with `reason`) means this daemon isn't running from a Loom source checkout " +
          "(e.g. a packaged `loomctl` install) or the check failed; not a claim of freshness either way. " +
          "`reasonKind` says which: `\"not-applicable\"` (no `.git`; never meaningful here, so silence is " +
          "forever correct) vs `\"could-not-measure\"` (a step failed, e.g. a build race or git error); not " +
          "interchangeable. It applies to BOTH deployStaleness signals together; `skillStoreStaleness` " +
          "never touches git or dist and degrades independently. " +
          "`skillStoreStaleness` {stale, pendingRestart, pendingAdopt} is a THIRD, INDEPENDENT signal " +
          "`deployStaleness` cannot give you. A bundled skill reaches sessions from the Loom-owned STORE " +
          "(`<LOOM_HOME>/skills/<name>/SKILL.md`), never live from `assets/`, and the store re-syncs from " +
          "merged assets only on daemon boot/restart, so a clean `deployStaleness` after an assets-only merge " +
          "does NOT mean nothing needs to happen. `pendingRestart` names every PRISTINE bundled skill with a " +
          "shipped update waiting; a restart (`daemon_restart` where your surface has it, else a human " +
          "relaunch) auto-advances these IN THE STORE. `pendingAdopt` names every CUSTOMIZED skill (user-edited " +
          "store copy) with a shipped update; a restart will NOT advance these (protecting the edit), each " +
          "needs an explicit adopt (Skills UI or `POST /api/skills/<name>/adopt`). Neither list means \"every " +
          "agent now has it\": a live session reflects the store only on ITS OWN next resume/fork/recycle, and " +
          "`SKILL.md` is read ambiently while `references/**` is read on demand, so a current store or " +
          "injected copy doesn't mean any agent opened a changed reference. `stale` is true whenever EITHER " +
          "list is non-empty; computed fresh on every call. It compares the store against the shipped " +
          "asset's WORKING-TREE content, so an UNCOMMITTED edit to a shipped SKILL.md reads as fully clean " +
          "though it exists in no commit. `skillAssetsGitStatus` {available, uncommitted, uncommittedPaths, " +
          "reason?, reasonKind?} is the git-aware half: `uncommitted:true` = the bundled skill assets dir has a " +
          "staged/unstaged change or new untracked file relative to HEAD. `available:false` (packaged " +
          "install, or git failure) never means clean; check `reasonKind` as for `deployStaleness`. " +
          "VISIBILITY ONLY, never a blocking check. `skillAssetsSyncState` is one verdict: `\"stale\"` " +
          "(skillStoreStaleness.stale, checked first), `\"uncommitted\"` (store in sync but the shipped asset " +
          "isn't committed), `\"clean\"`, or `\"undetermined\"` (git status unreadable; never read as clean). " +
          "`scratchRootBytes`/`scratchRootOverCeiling`: the shared per-session scratch root's " +
          "(`~/.loom/tmp/scratch`) on-disk footprint and whether it exceeds a WARN-only ceiling (nothing is " +
          "evicted for it); a fresh uncached walk on every call. `scratchGcSweep`: the boot GC's last-sweep " +
          "outcome (`not-started`/`in-progress`/`completed`/`failed`, with `scanned`/`reaped`/`wedged` once " +
          "settled), telling a sweep that reaped 0 from one that threw. `scratchLargestDirs`: the largest " +
          "scratch dirs, `{id, bytes, ageDays, resumability}`, naming WHICH dir drives the total. " +
          "`resumability` is the real GC sweep's classification (`\"no-row\"`/`\"live\"`/`\"no-engine-id\"`/" +
          "`\"resumable\"`/`\"unresumable\"`); a `\"resumable\"` dir is NEVER reaped, by design; only a human " +
          "deleting it removes it. Cached and background-refreshed, so it may read `[]` before the first " +
          "refresh (\"not computed yet\", never fabricated). `projectsWorkRootBytes`/" +
          "`projectsWorkRootOverCeiling`/`projectsWorkRootTruncated`: the fleet-wide figure for the per-project " +
          "work root, summed across every KNOWN project (active and archived) and excluding unrelated " +
          "directories under that root. `overCeiling` is PER-PROJECT (any single project over its own " +
          "ceiling), not a check on the sum; `truncated:true` = the walk hit its entry/time bound for at least " +
          "one project, so the figure is a partial sum. Cached; may read `0`/`false` before the first " +
          "refresh. `staleWorktreeLeftovers` `{count, oldestStaleSinceMs}`: renamed-aside stale worktree dirs " +
          "(`<path>.stale-<ts>`) under `WORKTREES_DIR` that were never auto-deleted and that no session row " +
          "names (`oldestStaleSinceMs` is `null` when `count` is 0). COUNT-ONLY (read on every call); for byte " +
          "totals see `GET /api/worktrees/stale-leftovers`. `orphanedProjectWorkDirs` `{count, entries, " +
          "truncated}`: a BOUNDED `{dirName}` list of top-level directories under `PROJECTS_WORK_ROOT` whose " +
          "name matches NO project row (active or archived), e.g. a permanent project delete whose work-dir " +
          "removal failed. `count` is the TRUE total and can exceed `entries.length`; `truncated:true` = the " +
          "scan hit its entry bound, so even `count` may be partial. VISIBILITY ONLY, never auto-deleted. " +
          "Cached; may read `{count:0, entries:[], truncated:false}` before the first refresh. " +
          "`claudeSettingsRouting` `{available, reason?, findings:[{file, keys}]}`: claude's own USER-level " +
          "settings files (`settings.json`/`settings.local.json`) that carry `ANTHROPIC_*`-style routing env " +
          "keys or an `apiKeyHelper` and so can redirect or re-bill every session. Key NAMES only, never " +
          "values. `available:false` = the scan failed or has not landed yet (`reason` says why), UNKNOWN, " +
          "NOT clean. Covers user-level files only; worktree-level hits are logged at spawn, not served here.",
        inputSchema: strictShape({}),
      },
      async () => ok(await buildServedStatusAsync(db)),
    );

    server.registerTool(
      "recycle_me",
      {
        description:
          "Recycle YOURSELF before your context fills up — hand off to a fresh successor manager. " +
          "Loom nudges you when you near your context limit; when you get that nudge: FIRST run /loom-session-end " +
          "(log progress to the vault) and take stock, THEN call this with a self-contained continuationPrompt " +
          "for your successor — current goal, what's done, your in-flight workers and their tasks/status, the " +
          "next steps, and key decisions. Loom boots a fresh manager seeded with this agent's warm-up + your " +
          "continuationPrompt, re-parents your live workers onto it, and then closes you — UNLESS the " +
          "ownership handoff (workers/wakes/questions/event-triggers/poll-jobs/webhooks/pending-queue) is " +
          "STILL failing after one retry, in which case you are NOT closed and remain fully live: the " +
          "result carries `halted:true` + `failedSteps` naming exactly what didn't transfer, and both of " +
          "you are durably nudged with who owns what now. `continuationPrompt` " +
          "is the canonical param; `handoffSummary` (the sibling worker_recycle tool's name for the same " +
          "concept) is accepted as an ALIAS — pass either one (if both are given, continuationPrompt wins).",
        inputSchema: strictShape({ continuationPrompt: z.string().optional(), handoffSummary: z.string().optional() }),
      },
      async ({ continuationPrompt, handoffSummary }) => {
        const prompt = resolveAlias(continuationPrompt, handoffSummary);
        // Falsy check (NOT `=== undefined`) — see the matching comment on worker_recycle above (CR minor 1):
        // restores the pre-alias behavior of rejecting an empty string at the tool boundary.
        if (!prompt) return ok({ error: "continuationPrompt (or handoffSummary) is required" });
        try {
          const fresh = await sessions.recycleManager(managerSessionId, prompt);
          // @decision f1969787 — a halt leaves `fresh` live but NOT retiring the caller; surface it via the
          // durable recycle_ownership_transfer_failed event rather than silently reporting success.
          const haltEvent = db.listEventsForSession(fresh.id).find((e) => e.kind === "recycle_ownership_transfer_failed");
          if (haltEvent) {
            return ok({ newManagerSessionId: fresh.id, gen: fresh.gen, halted: true, failedSteps: haltEvent.detail?.failedSteps ?? [] });
          }
          return ok({ newManagerSessionId: fresh.id, gen: fresh.gen });
        } catch (e) {
          const message = (e as Error).message;
          // Round 2 (Code Review 70d926b8, suggestion): the bare start-refusal text ("refusing to start a
          // manager session: ...") reads like a transient tool failure — give an ACTIONABLE message
          // instead: this is permanent for the current project, recycling will keep refusing, and the
          // caller's own options are end_me (once safe) or escalating to a human/the Lead to rebind the
          // project. resume()/startNew/startManager's OWN refusal text is left untouched — only this
          // caller-facing wrapper is reworded.
          if (message === MANAGER_SESSION_BARRED_ERROR) {
            return ok({
              error: `${message} — this project is barred for manager sessions (a reserved/system project, ` +
                `or its repoPath is the workspace home or an ancestor of it); recycling will keep being ` +
                `refused until a human rebinds the project's repoPath or un-reserves it. You are NOT closed ` +
                `and remain fully live. If your live workers can be safely stopped/handed off, consider ` +
                `end_me once that's done; otherwise escalate this to the human/Platform Lead.`,
            });
          }
          return ok({ error: message });
        }
      },
    );

    // recycle_reattempt — card dfc3b014: a halted predecessor's own remedy for recycle_me's `halted:true`
    // result, which nothing ever automatically retries. Self-scoped: always targets managerSessionId.
    server.registerTool(
      "recycle_reattempt",
      {
        description:
          "Retry (or reclaim) a HALTED recycle's still-split ownership handoff — call this when you are " +
          "the PREDECESSOR of a recycle_me that returned `halted:true` (or you got a " +
          "'[loom:recycle-ownership-transfer-failed]' nudge) and want another shot at reuniting. `handoffNote` " +
          "is REQUIRED (mirrors recycle_me's own continuationPrompt) — delivered to your successor ONLY if " +
          "ownership comes out whole (see the resolved outcome below); give it the same care as a real " +
          "recycle_me handoff even though it's unused for the other two outcomes. Three outcomes depending " +
          "on your successor's health: if it's alive and has reached SessionStart, this retries the same " +
          "worker/wake/question/event-trigger/poll-job/webhook/pending-queue reparent steps for your " +
          "still-failed categories, and — once everything is clean — delivers `handoffNote` to your " +
          "successor and retires you, exactly like an ordinary recycle_me would have " +
          "({outcome:\"resolved\", reparentedWorkers, successorId}) — you are RETIRED once this returns, " +
          "not merely freed. If your successor has since died AND is not itself durably resumable, this " +
          "instead reclaims everything it held back onto you, so you keep going " +
          "({outcome:\"reclaimed\", successorId}) — your ordinary recycle_me guard then allows you to " +
          "recycle again fresh. If categories are still failing after the retry, you remain live with " +
          "nothing changed about what you still own ({outcome:\"still-split\", failedSteps, successorId}). " +
          "Refuses ({error}) if you aren't a genuinely still-halted predecessor, if your successor exists " +
          "but hasn't reached SessionStart yet (try again shortly), if your successor has reached " +
          "SessionStart but its own stop() is currently in flight (wait for it to settle, then retry — " +
          "proceeding would hand the fleet to a successor guaranteed to exit shortly, stranding it dark " +
          "until a human resumes it; refusing costs nothing, since you remain the live, untouched owner), " +
          "or if your successor is down but still durably resumable — reclaiming it here would permanently " +
          "discard its context, so this never does. That refusal names what to actually do next: if crash " +
          "recovery is genuinely still pending for it, \"wait for its automatic recovery, then retry\"; " +
          "otherwise (an intentional stop, crash recovery exhausted or disabled, or a restart that didn't " +
          "cover this shape) \"nothing will recover it automatically — escalate: a human must resume " +
          "successor <id>, then retry\".",
        inputSchema: strictShape({ handoffNote: z.string() }),
      },
      async ({ handoffNote }) => {
        try {
          return ok(await sessions.reattemptManagerOwnershipTransfer(managerSessionId, handoffNote));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // end_me — the no-successor sibling of recycle_me (card 3b015fc7). Self-scoped: NO target arg, always
    // ends managerSessionId (the URL-path session), never another. Two gates (queued inbound / live
    // workers) may REFUSE — see SessionService.endMe's doc for the full contract.
    server.registerTool(
      "end_me",
      {
        description:
          "Request graceful termination of YOUR OWN session — a terminal exit, NO successor (unlike " +
          "recycle_me, which hands off to a fresh one). Takes no argument: Loom always ends the session " +
          "calling this tool, never another. Loom runs two safety checks first and REFUSES (does not stop) " +
          "if either trips: (1) you have unconsumed inbound direction queued (manager redirect/message, a " +
          "human composer turn, companion inbound you haven't acted on yet) → {stopped:false, " +
          "reason:\"queued-inbound\", pending:N} — end this turn so it drains into your next turn, act on " +
          "it, THEN re-call end_me; (2) you have ≥1 LIVE worker → {stopped:false, reason:\"live-workers\", " +
          "count:N} — recycle_me or worker_stop them first, then re-call end_me. On pass: your session " +
          "gracefully stops (Ctrl-C×2, clean, resumable — the row lands on Archive) and this tool's own " +
          "reply is delivered before your pty dies.",
        inputSchema: strictShape({}),
      },
      async () => {
        try {
          return ok(sessions.endMe(managerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // card 788ed7f4 — unhandledOwnerMessage (see db.ts/service.ts/gateway/server.ts).
    server.registerTool(
      "idle_report",
      {
        description:
          "Tell Loom's idle watchdog your disposition so it stops nudging you — call it when you end a " +
          "turn with no active work. `state`: 'working' = back at it (resumes normal watching); 'waiting' " +
          "= nothing to do until something lands — optionally snooze for `minutes` (defaults to the " +
          "per-project idle snooze); an explicit `minutes` above 1440 (24h) is CLAMPED to 1440, never " +
          "silently — the response's `snoozeClamped`/`snoozeMinutes` tell you it fired; 'done' = this " +
          "agent's work is complete. If you need the human, file " +
          "a Request via `question_ask` instead. Always clears your unanswered-nudge counter. Pass a " +
          "short `detail` to say why (recorded for the human). `state` is the canonical param; `status` " +
          "is accepted as an ALIAS for it — pass either one (if both, state wins). " +
          "On a 'waiting'/'done' call (never 'working'), the response may ALSO carry `unhandledOwnerMessage` " +
          "({excerpt, at, ageMinutes, count}) + a loud `warning` string: the owner sent you " +
          "a message via chat and, since then, none of tasks_create/platform_escalate/question_ask/" +
          "question_resolve has fired for this session — a park with no visible disposition. `excerpt` is " +
          "the FIRST such message (never a later one), `count` is how many have landed since. This fires " +
          "ONCE per open episode — surfacing it clears it, so read it now: file a card, escalate, ask/" +
          "resolve a Request, or (if you already answered it in chat) just note that and move on. A NEW " +
          "owner message starts a fresh episode. Both fields are ABSENT when nothing is pending.",
        inputSchema: strictShape({
          state: z.enum(["working", "waiting", "done"]).optional(),
          status: z.enum(["working", "waiting", "done"]).optional(),
          detail: z.string().optional(),
          minutes: z.number().optional(),
        }),
      },
      async ({ state, status, detail, minutes }) => {
        const resolvedState = resolveAlias(state, status);
        if (resolvedState === undefined) return ok({ error: "state (or status) is required" });
        try {
          return ok(sessions.recordIdleReport(managerSessionId, resolvedState, { detail, minutes }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager self-service management surface (Task 3de74275, Option B) -------------------------
    // Additive, MANAGER-ONLY tools (registered only on this branch) so an autonomous run can provision
    // its own rigs + structure instead of stalling on a human. The boundary (Option B): managers
    // ASSIGN existing human-authored profiles and create/edit STRUCTURE, but NEVER mint capabilities —
    // profile/skill/allowlist/gateCommand CREATE/edit stay human-only. gateCommand stays rejected on
    // this agent path (project_update routes config through validateAgentProjectConfigOverride). Each
    // tool re-checks the manager role server-side in the service (defense in depth).

    // Read-only agent directory (same scoping posture as worker_list): list the project's agents so a
    // manager can resolve a recycle/handoff's agent-id PREFIX (e.g. "b5d7304f…") to a full id, and pick
    // the right worker agent for worker_spawn — WITHOUT raw loom.db or REST. Project is derived
    // SERVER-SIDE from this manager's session (the agent passes no projectId), so it can never list
    // another project's agents. `role` is the agent's resolved PROFILE role (resolveProfile — the
    // canonical mechanism, exactly as the platform page derives it); null for a plain/profile-less agent.
    // browserTesting/documentConversion/restrictedTools are the SAME resolveProfile output profile_get/
    // profile_list already surface (mcp/platform.ts) — reused here so a manager can match a worker prompt
    // to real provisioning without a spawn-and-inspect round-trip (Auditor finding 64430a50).
    // harness (card 97ddbe6d) is projected the same way — pre-spawn vendor-CLI discovery, distinct from
    // the SESSION-tier harness worker_status/worker_list already return for a worker that already exists.
    server.registerTool(
      "agent_list",
      {
        description:
          "List the agents (rigs) in YOUR project — read-only. Use it to resolve a recycle/handoff's " +
          "agent-id PREFIX (e.g. 'b5d7304f…') to a full id, and to choose the right worker agent for " +
          "worker_spawn. Your project is derived SERVER-SIDE from your session (you pass NO projectId, so " +
          "you can never list another project's agents — same scoping as worker_list). Returns each agent's " +
          "{id, name, role (resolved from its bound profile — null for a plain agent), profileId, position, " +
          "browserTesting, documentConversion, restrictedTools (resolved from the assigned/default " +
          "profile — same resolution profile_get/profile_list use; false when profile-less or the profile " +
          "leaves a flag unset), harness ('claude' | 'codex' | null — the EFFECTIVE vendor CLI this agent " +
          "would spawn as, resolved the same way as the flags above; null means unset — either the agent is " +
          "profile-less or its bound profile never set harness — and an unset WORKER spawns the human-set " +
          "default-harness config (project ?? platform ?? 'claude'), so null is NOT the same as an explicit " +
          "'claude', and this field is the PROFILE's value only, not that default)}, ordered by position.",
        inputSchema: strictShape({}),
      },
      async () => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        return ok(db.listAgents(projectId).map((a) => {
          const resolved = resolveProfile(a, a.profileId ? db.getProfile(a.profileId) : undefined);
          return {
            id: a.id,
            name: a.name,
            role: resolved.role,
            profileId: a.profileId,
            position: a.position,
            browserTesting: resolved.browserTesting,
            documentConversion: resolved.documentConversion,
            restrictedTools: resolved.restrictedTools,
            harness: resolved.harness,
          };
        }));
      },
    );

    // Single-record FULL read (Task GAP 1): agent_list's summary deliberately drops startupPrompt (some
    // are large, e.g. ~6.6KB for a Code Reviewer rig — inlining every prompt into the fleet view would
    // bloat it), so a manager needing to SEE one agent's full prompt before a safe read-modify-write
    // (agent_update) previously had to fall back to curl'ing the human REST surface. agentId resolution
    // mirrors worker_spawn/agent_list: exact id, else an unambiguous 8-char id-PREFIX (resolveIdPrefix) —
    // both scoped to THIS manager's OWN project (agents.find/resolveIdPrefix search only db.listAgents
    // (projectId) results), so an id from another project simply doesn't match (falls through to
    // "agent not found", never leaking cross-project existence).
    server.registerTool(
      "agent_get",
      {
        description:
          "Read ONE agent in YOUR project — the FULL record INCLUDING its startupPrompt (agent_list's " +
          "summary deliberately drops it — some prompts are large), " +
          "PLUS its resolved browserTesting/documentConversion/restrictedTools capability flags AND harness " +
          "('claude' | 'codex' | null — the EFFECTIVE vendor CLI this agent would spawn as; null means " +
          "unset, either profile-less or its profile never set harness, and an unset WORKER spawns the human-set " +
          "default-harness config (project ?? platform ?? 'claude'), so null is NOT the same as an explicit " +
          "'claude' and this is the PROFILE's value only) (all resolved from its " +
          "assigned/default profile — same resolution profile_get/profile_list use; false/null when profile-less " +
          "or the profile leaves a flag unset). Use this before a safe read-modify-write via agent_update " +
          "(its appendToStartupPrompt mode lets you add to what you read here without retyping the whole " +
          "prompt, and its replaceInStartupPrompt mode lets you edit one clause mid-document the same way), " +
          "and to check an agent's real provisioning before assuming it from its prompt. agentId " +
          "accepts the full id OR an unambiguous 8-char id-prefix (same resolution as worker_spawn/" +
          "agent_list). Your project is derived SERVER-SIDE (you pass no projectId) — an agent outside YOUR " +
          "project resolves as not-found, same scoping as worker_list/agent_list. Error if unknown or an " +
          "ambiguous prefix (the error names the candidate ids).",
        inputSchema: strictShape({ agentId: z.string() }),
      },
      async ({ agentId }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const agents = db.listAgents(projectId);
        const withResolvedFlags = (a: (typeof agents)[number]) => {
          const resolved = resolveProfile(a, a.profileId ? db.getProfile(a.profileId) : undefined);
          return {
            ...a,
            browserTesting: resolved.browserTesting,
            documentConversion: resolved.documentConversion,
            restrictedTools: resolved.restrictedTools,
            harness: resolved.harness,
          };
        };
        // Card bf0fd0f3: startupPrompt gets the same single-large-value spill treatment as tasks_get's
        // body — never the host engine's own opaque overflow-spill. Below the cap this is a no-op
        // (byte-identical to before); key is the resolved agent's own id so repeated reads overwrite.
        const spillable = (a: ReturnType<typeof withResolvedFlags>) => spillableAgentGet(managerSessionId, "agent-get-spills", a.id, a);
        const exact = agents.find((a) => a.id === agentId);
        if (exact) return ok(spillable(withResolvedFlags(exact)));
        const r = resolveIdPrefix(agents, agentId);
        if (r.kind === "found") return ok(spillable(withResolvedFlags(r.record)));
        if (r.kind === "ambiguous") {
          return ok({ error: `ambiguous agent id-prefix '${agentId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` });
        }
        return ok({ error: "agent not found" });
      },
    );

    server.registerTool(
      "agent_assign_profile",
      {
        description:
          "Assign an EXISTING (human-authored) profile to an agent, or clear it (profileId: null). The " +
          "profile supplies role/model/allowlist/skills/browser at the agent's next NEW session. You can " +
          "only ASSIGN a profile a human already created — you cannot create or edit one (profile authoring " +
          "is human-only). A non-existent profileId is rejected. Use this to provision a rig (e.g. assign the " +
          "human-authored 'QA Tester' browser profile) without waiting on a human. The target agent must be in " +
          "YOUR project (an agent outside it is REJECTED). agentId accepts the full id OR an unambiguous " +
          "8-char id-prefix (same resolution as agent_get) — an ambiguous prefix errors naming the candidate " +
          "ids, never resolving to an arbitrary match. REJECTED if the rebind would remove this agent's " +
          "restrictedTools restriction — that axis can never be silently widened this way. When the rebind " +
          "widens anything else (e.g. a role change), the response carries a `rebindReach` field " +
          "({addedKeys, roleChange?}) — RELAY this to the human; it's the only signal they get.",
        inputSchema: strictShape({ agentId: z.string(), profileId: z.string().nullable() }),
      },
      async ({ agentId, profileId }) => {
        try {
          return ok(sessions.assignAgentProfile(managerSessionId, agentId, profileId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "agent_update",
      {
        description:
          "Update an agent's name (title) and/or startupPrompt (the project-specific brief that LEADS the " +
          "opening of its next NEW session — prepended ahead of any dynamic kickoff/handoff; an empty brief " +
          "leaves the opening as the dynamic part alone). Structural edit only — to change the agent's rig use " +
          "agent_assign_profile. THREE ways to touch startupPrompt, mutually exclusive (pick at most one): " +
          "`startupPrompt` REPLACES it wholesale (as before); `appendToStartupPrompt` CONCATENATES onto the " +
          "EXISTING prompt (joined with a blank line); `replaceInStartupPrompt: {old, new}` edits ONE clause " +
          "mid-document WITHOUT retyping the whole prompt — `old` is matched against the agent's CURRENT " +
          "server-side prompt (not a value you have to hold/paste yourself) and REJECTED with no write unless " +
          "it occurs EXACTLY ONCE (0 matches = not found; 2+ = ambiguous, add more surrounding context). Use " +
          "this instead of a full `startupPrompt` retype whenever you're changing one line/clause of a large " +
          "brief — a full retype has no diff instrument at the call site, so a dropped clause or mangled line " +
          "has no natural detector; a single-occurrence replace can't silently lose anything else in the " +
          "prompt. Read the current prompt first with agent_get. Passing more than one of the three modes in " +
          "the same call is REJECTED. The target agent must be in YOUR project (an agent outside it is " +
          "REJECTED). agentId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as " +
          "agent_get) — an ambiguous prefix errors naming the candidate ids, never resolving to an arbitrary " +
          "match. Omitted fields are left as-is.",
        inputSchema: strictShape({
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          appendToStartupPrompt: z.string().optional(),
          replaceInStartupPrompt: z.object({ old: z.string(), new: z.string() }).optional(),
        }),
      },
      async ({ agentId, name, startupPrompt, appendToStartupPrompt, replaceInStartupPrompt }) => {
        try {
          return ok(sessions.updateAgentPreset(managerSessionId, agentId, { name, startupPrompt, appendToStartupPrompt, replaceInStartupPrompt }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "agent_delete",
      {
        description:
          "PERMANENTLY delete one of YOUR project's agents (an agentId outside your project is REJECTED — " +
          "reuses sessions.deleteAgentAsManager, which calls the SAME service path as the human DELETE " +
          "/api/agents/:id and the Platform Lead's agent_delete: db.deleteAgent cascades the agent's " +
          "sessions/schedules/runs and best-effort drops their transcript snapshots). Refuses while any of " +
          "the agent's sessions is still LIVE (\"stop the fleet first\" — same guard as the human path); stop " +
          "it first. 404 (\"agent not found\") if the id is unknown. FULL id required (no 8-char prefix — " +
          "deliberately stricter than agent_update/agent_assign_profile, which accept a prefix, since this " +
          "is a destructive action). Returns { deleted:true, agentId, sessions:<n> }.",
        inputSchema: strictShape({ agentId: z.string() }),
      },
      async ({ agentId }) => {
        try {
          return ok(sessions.deleteAgentAsManager(managerSessionId, agentId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // @decision be447b3f — grantReach: deleting a profile can widen reach for agents still bound to it.
    server.registerTool(
      "profile_delete",
      {
        description:
          "PERMANENTLY delete a Profile (rig) by id — HAZARD: profiles are SHARED across projects, so this " +
          "REFUSES (naming the blocking agents/projects) unless the profile is referenced ONLY by agents in " +
          "YOUR OWN project (or by none at all) — a single-project manager can never delete a rig another " +
          "project depends on. The scan covers ARCHIVED foreign projects too (archived is soft/restorable, " +
          "not gone — a reference there still blocks). Reuses sessions.deleteProfileAsManager, which calls the SAME db.deleteProfile " +
          "the human DELETE /api/profiles/:id and the Platform Lead's profile_delete use — a reference confined " +
          "to your own project does NOT block delete (matches the human path's safe-by-design cascade: a " +
          "dangling profileId resolves to the plain backstop) EXCEPT one case: REFUSED when an agent bound to it carries its own human-set connections/capabilities grant and the profile's role is non-null or it has restrictedTools:true, since deleting it would drop that agent to no role or remove its tool restriction (ask the human). 404 (\"profile not found\") if the id is unknown. " +
          "FULL id required (no 8-char prefix). BLAST-RADIUS SIGNAL: that backstop can itself " +
          "WIDEN reach for any agent still bound to this profile IN YOUR OWN PROJECT (the only ones delete " +
          "can ever reach, by the in-use guard above) — deleting a `restrictedTools:true` profile un-restricts " +
          "them, and deleting a non-null-role profile re-roles them, on their NEXT session. The response then " +
          "carries a `grantReach` field ({addedKeys, agentCount, agents[], roleChange?}) naming exactly who; " +
          "RELAY THIS the same way you would any other newly-widened trust boundary — there is no human-facing " +
          "confirm on this surface. Returns { deleted:true, profileId, grantReach? }.",
        inputSchema: strictShape({ profileId: z.string() }),
      },
      async ({ profileId }) => {
        try {
          return ok(sessions.deleteProfileAsManager(managerSessionId, profileId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "project_update",
      {
        description:
          "Update a project's structural fields (name / vaultPath) and/or its config override — YOUR project " +
          "only (a projectId outside your own is REJECTED; platform_escalate is your one cross-project write). " +
          "config is schema-validated on the AGENT path: orchestration.gateCommand (host-RCE), orchestration.mergeGate (turns the merge gate off), orchestration.mergeGateInterval (lets N landings skip it while off) and unknown keys " +
          "are REJECTED (that capability stays human-only); permission.mode:\"bypassPermissions\"/\"default\"/\"plan\" " +
          "are REJECTED too (each would make every future session this project spawns boot into a mode with " +
          "no permission gate, or with no way for an unattended session to proceed, not just yours). If the " +
          "project's STORED permission.mode is already one only a human could have set (outside this " +
          "allowlist — including a stored \"bypassPermissions\"), a patch setting permission.mode is " +
          "REJECTED outright, even to \"acceptEdits\" — you cannot change or remove a human-set mode in " +
          "either direction, tighten or loosen; use the REST config PATCH / Settings UI. " +
          "permission.deny only ever GROWS through this tool — a patch that narrows or omits an existing entry " +
          "does not remove it: the call still reports success, but the entry is silently RETAINED (merged as an " +
          "additive union); permission.allow has no such floor and is a plain replace. repoPath is not editable here. Omitted top-level " +
          "fields (name / vaultPath / config) are left as-is — but config ITSELF is a deep MERGE onto the " +
          "project's existing override, not a replace: a key you omit inside config (including a human-only " +
          "one like gateCommand you cannot even name) is PRESERVED, not dropped.",
        inputSchema: strictShape({
          projectId: z.string(),
          name: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        }),
      },
      async ({ projectId, name, vaultPath, config }) => {
        try {
          return ok(await sessions.updateProjectStructural(managerSessionId, projectId, { name, vaultPath, config }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "project_archive",
      {
        description:
          "Soft-archive a project: it disappears from the active project list, but its rows and sessions are " +
          "retained (not deleted). Structural, reversible-by-a-human. YOUR project only — a projectId outside " +
          "your own (e.g. the reserved platform home board) is REJECTED.",
        inputSchema: strictShape({ projectId: z.string() }),
      },
      async ({ projectId }) => {
        try {
          return ok(sessions.archiveProjectAsManager(managerSessionId, projectId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "schedule_create",
      {
        description:
          "Create a cron schedule that autonomously boots a manager session in an agent on each tick (5-field " +
          "cron). enabled defaults to true. An invalid cron expression is rejected. Low-risk autonomous wake — " +
          "the same kind of self-scheduling agents already do via wake_me. The target agent must be in YOUR " +
          "project (an agent outside it is REJECTED). Optional `prompt` is a custom task description, APPENDED " +
          "to the agent's own startupPrompt (agent prompt first, then this as a clearly-delimited block) when " +
          "the schedule fires — omit for today's behavior (agent prompt only). Optional `name` is a " +
          "human-facing label shown in the Schedules UI; omit it and a friendly default is derived from " +
          "the cron (e.g. \"Every day at 9:00 AM\"). The cron fields are evaluated in the DAEMON's LOCAL " +
          "timezone, NOT UTC — the response's `nextFireAtLocal` is the reliable human-readable cross-check; " +
          "never assume the bare `nextFireAt`/`cron` are UTC.",
        inputSchema: strictShape({ agentId: z.string(), cron: z.string(), enabled: z.boolean().optional(), prompt: z.string().optional(), name: z.string().optional() }),
      },
      async ({ agentId, cron, enabled, prompt, name }) => {
        try {
          return ok(withScheduleTimeEcho(sessions.createSchedule(managerSessionId, { agentId, cron, enabled, prompt, name })));
        } catch (e) {
          return ok({ error: (e as Error).message, ...nowEcho() });
        }
      },
    );

    server.registerTool(
      "schedule_update",
      {
        description:
          "Update a schedule's cron, enabled flag, and/or custom prompt. A changed cron recomputes the next " +
          "fire (rejected if invalid); enabled toggles the Scheduler on/off for this row; prompt is appended to " +
          "the agent's own startupPrompt on fire (pass an empty string to clear it). The schedule's agent must " +
          "be in YOUR project (a schedule outside it is REJECTED). Omitted fields are left as-is; a blank " +
          "`name` is ignored (a schedule always keeps a name). The cron fields are evaluated in the DAEMON's " +
          "LOCAL timezone, NOT UTC — the response's `nextFireAtLocal` is the reliable human-readable check. " +
          "scheduleId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as schedule_get/" +
          "schedule_list, worker_spawn's agentId, tasks_get's taskId) — a well-formed prefix naming a real " +
          "schedule in YOUR project now resolves instead of returning 'schedule not found' as if it had been " +
          "deleted. A ref shorter than 8 characters gets its OWN error naming it too short, distinct from a " +
          "genuinely-unresolvable id.",
        inputSchema: strictShape({ scheduleId: z.string(), cron: z.string().optional(), enabled: z.boolean().optional(), prompt: z.string().optional(), name: z.string().optional() }),
      },
      async ({ scheduleId, cron, enabled, prompt, name }) => {
        try {
          return ok(withScheduleTimeEcho(sessions.updateScheduleAsManager(managerSessionId, scheduleId, { cron, enabled, prompt, name })));
        } catch (e) {
          return ok({ error: (e as Error).message, ...nowEcho() });
        }
      },
    );

    // card 52b812c6: schedule_list/schedule_get — the read-affordance half of a manager's schedule
    // surface. A manager previously had schedule_create/schedule_update (both WRITES) and no read at
    // all — "I can create schedules I can't enumerate." The cross-project Platform variant
    // (list_all_schedules/schedule_get on mcp/platform.ts) is UNCHANGED — this is the project-scoped
    // mirror, same isolation as agent_get/agent_list.
    server.registerTool(
      "schedule_list",
      {
        description:
          "List cron schedules in YOUR project (each {id, name, agentId, cron, enabled, nextFireAt, " +
          "nextFireAtLocal, lastFiredAt, lastFiredAtLocal, lastDeferredAt, lastDeferredReason, kind, prompt}). " +
          "`cron`/`nextFireAt` are evaluated/expressed in the DAEMON's LOCAL timezone, NOT UTC — " +
          "`nextFireAtLocal` is the reliable human-readable cross-check, never assume `nextFireAt`'s ISO " +
          "instant reads as UTC-intuitive wall-clock time. `lastDeferredReason` is non-null when a fire was " +
          "held back by a budget/owner gate OR missed entirely while the daemon was down — see events_search " +
          "(kind: schedule_fire_deferred/schedule_fire_missed) for the full history. Your project is " +
          "derived SERVER-SIDE (no projectId param) — this is the read half of schedule_create/schedule_update, " +
          "closing the gap where a manager could create a schedule it had no way to enumerate. Read-only.",
        inputSchema: strictShape({}),
      },
      async () => {
        try {
          return ok(sessions.listSchedulesAsManager(managerSessionId).map((s) => withScheduleTimeEcho(s)));
        } catch (e) {
          return ok({ error: (e as Error).message, ...nowEcho() });
        }
      },
    );

    server.registerTool(
      "schedule_get",
      {
        description:
          "Read ONE schedule in YOUR project by id — the FULL record ({id, name, agentId, cron, enabled, " +
          "nextFireAt, nextFireAtLocal, lastFiredAt, lastFiredAtLocal, lastDeferredAt, lastDeferredReason, " +
          "kind, prompt}). `cron`/`nextFireAt` are evaluated/expressed in the DAEMON's LOCAL timezone, NOT " +
          "UTC — `nextFireAtLocal` is the reliable human-readable cross-check. scheduleId accepts the full id " +
          "OR an unambiguous 8-char id-prefix (same resolution as schedule_update/worker_spawn's agentId) — " +
          "an ambiguous prefix errors naming the candidate ids, never resolving to an arbitrary match; a ref " +
          "shorter than 8 characters gets its own 'too short' error instead. A schedule outside YOUR project " +
          "resolves as a plain not-found (never distinguishable from a genuinely nonexistent id), same " +
          "scoping as agent_get/worker_list. Read-only.",
        inputSchema: strictShape({ scheduleId: z.string() }),
      },
      async ({ scheduleId }) => {
        try {
          return ok(withScheduleTimeEcho(sessions.getScheduleAsManager(managerSessionId, scheduleId)));
        } catch (e) {
          return ok({ error: (e as Error).message, ...nowEcho() });
        }
      },
    );

    // --- Manager→Platform escalation (Platform Manager P4) ----------------------------------------
    // The ONE upward channel: a project manager reports a discovered Loom bug / friction UP to the
    // Platform Lead. DURABLE by design — it files a structured TASK onto whichever platform-tier home
    // is actually live (`resolveLiveLeadHome` — the dev "Loom Platform" home on a dev install, the
    // end-user "Platform" home otherwise; the Lead's inbox either way), which survives the common case
    // where no Lead session is live.
    // This is ONE of the manager's two structured cross-project writes (the other is peer_message, below):
    // the target board here is HARDCODED to the live Lead home server-side (the manager never names a
    // projectId), so it can never become a general cross-project task-write. Down-tree messaging stays
    // parent-scoped (worker_message); session_message (the Lead's un-scoped delivery) is the PLATFORM
    // surface, not here.
    // card 5b221bf2 — tasks_create's own cross-channel duplicate check (see mcp/tasks.ts).
    server.registerTool(
      "platform_escalate",
      {
        description:
          "Escalate a discovered Loom bug or friction UP to the Platform Lead, or notify it of a status/" +
          "completion it asked to hear about. This is the ONE durable channel for anything the Lead " +
          "needs to know; an ad hoc 'I'll ping you' reaches no one reliably. Files a DURABLE, structured " +
          "task on your own reserved platform home board (the Lead's inbox; it survives whether or not " +
          "a Lead session is live), capturing your origin project + this manager session, the title, " +
          "the detail/evidence and a severity. The target is the Platform board, fixed server-side " +
          "(you cannot pick a project); for a LINKED peer project's manager use peer_message. Returns " +
          "the created Platform task id plus a `deliveryStatus` (delivered-live | queued | boarded | " +
          "suppressed-duplicate | dropped): `boarded` = no Lead session was live but the task is " +
          "durably filed (the normal, safe case); a live Lead is nudged immediately. " +
          "`suppressed-duplicate` is DIFFERENT: a Lead IS live but its nudge was withheld because it " +
          "already saw this content (today: a completion report naming a deploy SHA it was already " +
          "told about); the task is still filed and someone IS watching. Only `dropped` warrants " +
          "concern. DEDUPED: re-escalating the SAME title with an unchanged-or-lower severity while " +
          "your prior escalation is still UNRESOLVED (pending, or being worked but not resolved) reuses " +
          "that task: the response carries `deduped: true` and no fresh nudge is sent; check " +
          "escalation_status instead of re-escalating on a timer. A HIGHER severity on a still-open " +
          "title reuses the same task but files a fresh event and a fresh Lead nudge. SCOPE: dedup is " +
          "PER-ORIGIN-PROJECT, by title only against THIS project's prior escalations; another " +
          "project escalating the same finding lands as its own card, and a card filed by hand " +
          "(tasks_create) or via peer_message for the same finding is invisible to it (see " +
          "tasks_create's cross-channel duplicate check). Use it for platform-level problems (a Loom " +
          "bug, a confusing tool/skill, friction that slowed your workers) or a completion/status " +
          "update the Lead is waiting on, NOT for your own project's board (use tasks_create). " +
          "`detail` is the canonical param; `body` is accepted as an ALIAS (if both, detail wins).\n" +
          "⚠️ SAME TITLE IS NOT A CONTRACT for landing on a specific existing thread: it is a " +
          "best-effort heuristic (title + severity + still-open) that silently stops matching once " +
          "the Lead closes the card, and a same-title follow-up then files a brand-new, unlinked card " +
          "with nothing in the response saying so. Pass `followUpOn:<taskId>` (the Platform task id " +
          "THIS escalation returned, full id or unambiguous 8-char prefix) whenever you mean 'append " +
          "to that thread': it appends UNCONDITIONALLY (even to a card the Lead closed), always files a " +
          "durable board task, and (unless the completion-SHA dedup suppresses it) nudges a live Lead; " +
          "read `deliveryStatus`, never assume a nudge happened. Rejected with {error} if the id isn't " +
          "one of YOUR OWN project's previously filed escalations. Check the response's `outcome` " +
          "(\"created\" | \"appended\") rather than inferring it from the title. When `followUpOn` was " +
          "honored the response also carries `followedUp:true`, and `targetWasTerminal:true` if you " +
          "just reopened a card the Lead had closed.",
        inputSchema: strictShape({
          title: z.string(),
          detail: z.string().optional(),
          body: z.string().optional(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
          followUpOn: z.string().optional(),
        }),
      },
      async ({ title, detail, body, severity, followUpOn }) => {
        const resolvedDetail = resolveAlias(detail, body);
        if (resolvedDetail === undefined) return ok({ error: "detail (or body) is required" });
        try {
          const result = sessions.platformEscalate(managerSessionId, { title, detail: resolvedDetail, severity, followUpOn });
          // Card 788ed7f4: a successful escalation is a disposition — clear any open "owner message left
          // without a disposition" episode for THIS session, by occurrence alone (no content matching).
          db.clearPendingOwnerMessage(managerSessionId);
          return ok(result);
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager↔manager cross-project channel ------------------------------------------------------
    // @decision 2349d90c — never give an agent an MCP path to create/modify a `project_links` row; links
    // are owner-declared, human-only — a manager can only USE a link the owner already made.
    if (hasPeerLinks) {
      server.registerTool(
        "peer_message",
        {
          description:
            "Message a LINKED peer project's manager — the sanctioned manager↔manager cross-project channel " +
            "(replaces hand-relaying contract Q&A through the Platform Lead). `targetProjectId` MUST be a " +
            "project the owner has explicitly LINKED to yours (ask the owner to link them first if not — " +
            "there is no way to link projects yourself). Rejected if: the target is your own project, the " +
            "target project doesn't exist, the two projects aren't linked, or you're sending too fast (a " +
            "per-session rate limit). Delivers to the target project's LIVE manager session ONLY — never a " +
            "worker or any other role there. If no manager session is live in the target project right now, " +
            "the message is durably BOARDED as a task on that project's OWN board instead of being dropped — " +
            "its manager will see it next time it attaches. Returns `deliveryStatus` (delivered-live | queued " +
            "| boarded) plus `taskId` when boarded. This is DATA delivery only — the recipient acts on it " +
            "within its OWN project and gains no reach into yours except replying through this same primitive. " +
            "The delivered frame ([loom:from-manager · <name> · projectId:<id> · sessionId:<id>]) stamps YOUR " +
            "project id and this manager session's id, so a recipient can reply with peer_message using that " +
            "projectId as ITS targetProjectId — no need to ask the owner to relay it. Also returns `msgId` " +
            "(when the target project has a live manager — omitted on a `boarded` send, which has no " +
            "redelivery chain to track): pass it to `peer_message_status` LATER to check whether this " +
            "specific send actually landed, independent of anything you send afterward — the primitive that " +
            "closes the gap a `[loom:redelivery-parked]` notice used to leave open for a cross-project sender " +
            "(\"may have failed, and you have no way to check\"). `targetSessionId` differing from an EARLIER " +
            "send's to the SAME targetProjectId is EXPECTED, not a fault — the resolved target is always the " +
            "peer's CURRENT live manager, which legitimately changes across a recycle at the target; when " +
            "that happens this call also returns `recycledSincePriorSend:true` plus an `advisory` naming the " +
            "old/new session prefixes, so you don't have to rediscover that the hard way. A `queued` " +
            "(not-yet-delivered) result ALSO carries an `advisory`: the peer project's manager may recycle " +
            "before draining its queue, in which case a SUCCESSOR session reads this, not necessarily the one " +
            "you've been talking to — write it to be understood cold either way. DO NOT re-send your own " +
            "prior content just because you're unsure it landed — check `peer_message_status` instead. If " +
            "your new `text` starts with the EXACT text of your own last peer_message to this SAME " +
            "targetProjectId (a growing, accumulated resend), Loom detects this itself: an identical repeat " +
            "is NOT re-sent at all (`deliveryStatus:\"suppressed-duplicate\"`, nothing delivered), and a " +
            "genuine extension has the already-sent prefix trimmed before delivery — only the new suffix " +
            "goes out, tagged `loom:redelivery-trimmed` so the recipient knows content was cut, and the " +
            "response carries `trimmedRedeliveredBytes` plus an `advisory` saying so.",
          inputSchema: strictShape({ targetProjectId: z.string(), text: z.string() }),
        },
        async ({ targetProjectId, text }) => {
          try {
            return ok(sessions.messagePeerManager(managerSessionId, targetProjectId, text));
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );

      // peer_list: the read-only complement to peer_message — lets a manager DISCOVER its linked peers
      // instead of only ever replying to one that already messaged it. Scoped server-side to the caller's
      // own project (no projectId param — mirrors requests_list); reuses the exact same project_links gate
      // peer_message checks, so it returns exactly the set peer_message would accept as a targetProjectId.
      server.registerTool(
        "peer_list",
        {
          description:
            "List the projects the owner has LINKED to yours — the read-only complement to peer_message, " +
            "letting you DISCOVER a linked peer's project id before it has ever messaged you (peer_message " +
            "requires a targetProjectId, and nothing else exposes a linked project's id proactively). Scoped " +
            "SERVER-SIDE to YOUR OWN project — no projectId param, so you can never enumerate another " +
            "project's links. Returns exactly the target set peer_message would accept right now: " +
            "[{projectId, name}], one entry per owner-linked peer, excluding any peer that's since been " +
            "archived. Non-mutating — exposes only the projectId + display name, nothing else about the " +
            "peer project.",
          inputSchema: strictShape({}),
        },
        async () => {
          try {
            return ok({ peers: sessions.listPeerProjects(managerSessionId) });
          } catch (e) {
            return ok({ error: (e as Error).message });
          }
        },
      );

      // peer_message_status: card 0f693dea DoD-2, the PRIMARY ask — a sender-side delivery read keyed to
      // a peer_message's own msgId, closing the dead end a `[loom:redelivery-parked]` notice used to leave
      // a cross-project sender in ("may have failed, and you have no way to check"). Scoped to YOUR OWN
      // recycle lineage's event stream (peerMessageStatusByMsgId's own doc, above) — so this can only ever
      // resolve a msgId your own (or a direct predecessor's own) peer_message calls minted; never a probe
      // into another manager's sends or the peer's own state.
      server.registerTool(
        "peer_message_status",
        {
          description:
            "Check whether a PRIOR peer_message you sent actually landed: the sender-side delivery read " +
            "peer_message's `[loom:redelivery-parked]` notice points you to. Pass the `msgId` a PRIOR " +
            "peer_message call returned (the FULL id or an unambiguous 8-char prefix, the same " +
            "resolution as `tasks_get`/`agent_get`/`worker_relink`; never a value you invent). Returns " +
            "`{msgId, found, state, at, sentAt}` (`msgId` is always the FULL resolved id). " +
            "`found:false` = not one of YOUR OWN peer_message sends: a typo, an ambiguous prefix, or " +
            "the send BOARDED (a boarded send has no redelivery chain; check the target project's " +
            "board). `found:true` gives `state`: `\"pending\"` (still queued/being redelivered, or " +
            "CARRIED across a recipient recycle awaiting the successor; unresolved), `\"delivered\"` " +
            "(handed off as a turn, your original or the carried copy on the recipient's successor; NOT " +
            "proof the recipient acted on it), `\"parked\"` (Loom exhausted its redelivery budget with no " +
            "confirmed hand-off; NOT proof it was never received, the engine can confirm minutes late; " +
            "treat as uncertain, not failed), or `\"confirmed-after-park\"` (a late hook proved the " +
            "original DID land: do NOT resend, it would be a real duplicate turn). `at` is when the " +
            "state producing this reading occurred (null while `\"pending\"`). `sentAt` is when the " +
            "ORIGINAL msgId was sent (unaffected by recycle-carry hops); diff it against now to tell " +
            "\"pending for 3 seconds\" from \"pending for 16 minutes\". " +
            "A STILL-`\"pending\"`/`\"parked\"` READ AFTER A WHILE is no proof of non-delivery: do NOT " +
            "resend, and prefer NOT to restate the owed content in your next message either (it " +
            "delivers the same material twice if the read is wrong). With a live channel back to the " +
            "recipient and something already owed, fold ONE line asking directly, e.g. \"<msgId> still " +
            "reads pending — did it reach you? If not, say so and I'll restate\"; the recipient is the " +
            "only party who knows. Restate outright only when you won't be around to hear the answer " +
            "(going silent, recycling, nothing else owed). Resolvable across YOUR OWN recycle lineage " +
            "too. Returns ONLY a delivery bit for YOUR OWN message, never the peer's transcript, " +
            "internals or any other surface into that project (the peer stays a PRIVATE product). " +
            "Non-mutating; safe to re-call any time.",
          inputSchema: strictShape({ msgId: z.string() }),
        },
        async ({ msgId }) => ok(peerMessageStatusByMsgId(db, managerSessionId, msgId)),
      );
    }

    server.registerTool(
      "escalation_status",
      {
        description:
          "READ-ONLY: check whether the Platform Lead has picked up / triaged / resolved an escalation YOUR " +
          "PROJECT filed via platform_escalate — closes the gap where a manager re-escalates work the Lead " +
          "already claimed. Pass `taskId` (the id platform_escalate returned, OR an unambiguous 8-char " +
          "id-prefix — the paste-able short id Loom displays) to check one escalation; omit it to LIST your " +
          "project's escalations. The list defaults to OPEN escalations only — status pending, in_progress, " +
          "or triaged — most-recent first; pass `includeResolved:true` to get the full history back (every " +
          "escalation ever filed, including resolved/closed). Scoped server-side to YOUR OWN project's " +
          "origin — a taskId outside that set (another project's escalation, or unknown) returns " +
          "`{found:false}` uniformly, never an error, so this can't be used to probe another project's " +
          "escalations; an AMBIGUOUS prefix that matches more than one of YOUR OWN escalations returns a " +
          "\"did you mean\" error naming the candidates (pass more characters or the full id).\n" +
          "The list is DEDUPED to one row per DISTINCT taskId (a card re-escalated via `followUpOn` files a " +
          "fresh event per follow-up, but shows here only ONCE, keyed on its latest event) — each row's " +
          "`count` is how many platform_escalate events collapsed into it (1 for a card escalated exactly " +
          "once).\n" +
          "Each escalation reports its CURRENT title (the Lead may have refined it — itself a sign it was " +
          "seen), a `status` of pending (still in the landing lane — not yet picked up), in_progress (moved " +
          "into a working lane — picked up), triaged (the Lead verified it and filed the fix as a card " +
          "elsewhere — see `triagedTo` — but that destination card is NOT yet proven merged), resolved " +
          "(the destination card IS git-verified merged — DERIVED, never asserted from the Platform board's " +
          "own column), or closed (the escalation task itself was deleted/archived), its columnKey, and " +
          "updatedAt.\n" +
          "READ `triaged` CAREFULLY: it means \"verified and filed, fix not yet PROVEN landed\" — it does " +
          "NOT mean \"confirmed still broken\". `triagedTo.merged` is git-derived (the same check " +
          "project_task_get/tasks_get expose): null there means not proven merged, which covers three very " +
          "different cases — genuinely not fixed yet, fixed but landed outside the merge-detection scan " +
          "window, or a transient git-read failure — never treat a `triaged` reading as proof the underlying " +
          "defect is still present. `triagedTo` (present once the Lead has linked a destination via " +
          "`resolvesEscalation` — either at create time, or afterward via `project_task_update`'s " +
          "same-named param) names {projectId, projectName, taskId, taskTitle, " +
          "merged} so you can go verify the real state yourself instead of trusting this field alone. No writes.",
        inputSchema: strictShape({ taskId: z.string().optional(), includeResolved: z.boolean().optional() }),
      },
      async ({ taskId, includeResolved }) => {
        try {
          return ok(await sessions.escalationStatus(managerSessionId, { taskId, includeResolved }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager-driven board column create/rename/delete (owner-approved capability expansion) ------
    // Three thin wrappers around the SAME atomic writer the human REST column editor uses
    // (sessions.updateBoardColumns → planColumnLayout + db.applyBoardColumnLayout) — ZERO new mutation or
    // validation logic. Each reads the project's CURRENT resolved columns (currentColumns), splices in the
    // one create/rename/delete change, and delegates. Every hard invariant (no-orphan, ≥1-column floor,
    // exactly-one-required-role, removed-column cards re-keyed to defaultLanding) is enforced by that
    // shared writer, not here. MANAGER-ONLY: registered here (mcp/orchestration.ts), deliberately NOT on
    // the worker-shared mcp/tasks.ts surface — a worker must never restructure a shared board.
    server.registerTool(
      "board_column_create",
      {
        description:
          "Create a new board column in YOUR project — an alternative to platform_escalate-ing for a new " +
          "lane. `key` must be unique (not already used by an existing column); `label` is the human-facing " +
          "name; optional `role` assigns it a lifecycle role (intake/defaultLanding/workReady/active/review/" +
          "parked/terminal/mergeLanding) — at most one column may hold a given role (except a NEW column " +
          "can't claim defaultLanding/terminal since exactly one column must already hold each of those; " +
          "board_column_rename has no `role` param and always preserves a column's existing role, so moving " +
          "defaultLanding/terminal off its current holder is HUMAN-only, via the board UI column editor — " +
          "no agent MCP tool can do it). The new " +
          "column is appended after the existing ones. Delegates to the SAME atomic writer the human column " +
          "editor uses — every existing card is untouched. Returns {ok:true, columns, warnings} or " +
          "{ok:false, error} on a hard reject (e.g. a duplicate key).",
        inputSchema: strictShape({ key: z.string(), label: z.string(), role: columnRole.optional() }),
      },
      async ({ key, label, role }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ ok: false, error: "no project for this session" });
        const current = currentColumns(db, projectId);
        const desired: DesiredColumn[] = [...current.map(toDesiredColumn), { key, label, ...(role ? { role } : {}) }];
        return ok(sessions.updateBoardColumns(projectId, desired));
      },
    );

    server.registerTool(
      "board_column_rename",
      {
        description:
          "Rename a board column's key and/or label in YOUR project. `key` must name an EXISTING column; " +
          "pass `newKey` to change its key (every card on it follows old→new — never orphaned) and/or " +
          "`newLabel` to change its display name (at least one of the two must be given). The column's role/" +
          "accent/WIP-limit are preserved unchanged. Delegates to the SAME atomic writer the human column " +
          "editor uses. Returns {ok:true, columns, warnings} or {ok:false, error} (e.g. `key` not found, or " +
          "`newKey` collides with another existing column).",
        inputSchema: strictShape({ key: z.string(), newKey: z.string().optional(), newLabel: z.string().optional() }),
      },
      async ({ key, newKey, newLabel }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ ok: false, error: "no project for this session" });
        if (!newKey && !newLabel) return ok({ ok: false, error: "pass newKey and/or newLabel" });
        const current = currentColumns(db, projectId);
        if (!current.some((c) => c.key === key)) return ok({ ok: false, error: `no such column '${key}'` });
        const desired: DesiredColumn[] = current.map((c) => {
          if (c.key !== key) return toDesiredColumn(c);
          const d = toDesiredColumn(c);
          d.key = newKey ?? c.key;
          d.label = newLabel ?? c.label;
          if (d.key !== key) d.prevKey = key;
          return d;
        });
        return ok(sessions.updateBoardColumns(projectId, desired));
      },
    );

    server.registerTool(
      "board_column_delete",
      {
        description:
          "Delete a board column in YOUR project. `key` must name an EXISTING column. Every card still on " +
          "it is re-keyed to the board's defaultLanding column (never orphaned) — the SAME safe re-key the " +
          "human column editor performs. Deleting a column that holds a REQUIRED role (defaultLanding or " +
          "terminal) is HARD-REJECTED unless another column already carries that role — no agent MCP tool " +
          "can move that role onto another column (board_column_rename has no `role` param and always " +
          "preserves it), so reassigning it first means the HUMAN board UI column editor. A board must " +
          "always keep at least one column. Returns {ok:true, columns, warnings} or {ok:false, error}.",
        inputSchema: strictShape({ key: z.string() }),
      },
      async ({ key }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ ok: false, error: "no project for this session" });
        const current = currentColumns(db, projectId);
        if (!current.some((c) => c.key === key)) return ok({ ok: false, error: `no such column '${key}'` });
        const desired: DesiredColumn[] = current.filter((c) => c.key !== key).map(toDesiredColumn);
        return ok(sessions.updateBoardColumns(projectId, desired));
      },
    );

    return server;
  }

  /**
   * HTTP entry for /mcp-orch/:sessionId. `body` is the Fastify-parsed JSON (or undefined). `attributions`
   * (card 8d158088) — see TaskMcpRouter.handle's own doc; same thread-don't-requery contract, same
   * optional/fail-open default for any existing test that calls `.handle()` directly.
   */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown, attributions?: Map<string, ToolAttributionResult>): Promise<void> {
    const resolved = this.resolveRole(sessionId);
    if (!resolved) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no orchestration surface for this session" }));
      return;
    }

    // Stateless per request (see TaskMcpRouter): no cached transport to be deleted on a transient
    // onclose, so the worker_* surface can't vanish mid-session. Rebuilt each call from the role.
    const server = this.buildServer(sessionId, resolved.role, attributions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      // `close` also fires on a NORMAL completed response (after res.end()) AND on the transport's
      // OPTIONAL long-lived GET/SSE push stream — that one is BY DESIGN left open (never res.end()'d)
      // until the client tears it down, so its ordinary teardown must not warn either (a real client
      // opens one on every connect(), and its later close is routine, not a drop). So gate on BOTH:
      // POST only (the GET stream would otherwise false-positive on every normal disconnect), and
      // `writableEnded` false (flips true synchronously when transport.handleRequest() calls
      // res.end(), so false here means the connection dropped before we finished responding).
      if (req.method === "POST" && !res.writableEnded) {
        const rpc = body as { method?: unknown; params?: { name?: unknown } } | undefined;
        const method = typeof rpc?.method === "string" ? rpc.method : undefined;
        const tool = typeof rpc?.params?.name === "string" ? rpc.params.name : undefined;
        console.warn(
          `[orchestration] /mcp-orch request aborted before completion (sessionId=${sessionId}` +
            (method ? `, method=${method}` : "") +
            (tool ? `, tool=${tool}` : "") +
            ")",
        );
      }
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
