import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { contextWindowForModel, resolveConfig, resolveProfile, QUESTION_STATES, QUESTION_TYPES, type SessionRole, type KanbanColumn, type Session, type OrchestrationEvent } from "@loom/shared";
import { QUESTION_ASK_INPUT_SHAPE, buildQuestionAsk, questionPullItem, auditRequestItem, pageRequests, cancelQuestionForAgent, resolveQuestionForAgent, applySupersede } from "./questionTool.js";
import { DEFAULT_REQUESTS_LIST_CAP } from "./audit.js";
import { resolveAlias, strictShape } from "./arg-alias.js";
import { currentColumns, type DesiredColumn } from "../tasks/columns.js";
import type { Db } from "../db.js";
import { MAX_GATE_HISTORY_PAGE } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { possibleDuplicateRootLabel } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import { readTranscript, pageTranscript, lastNTurns, applyAggregateWalkCap, spillableTurnsResponse } from "../sessions/transcript.js";
import { UsageLimitError } from "../orchestration/usage-awareness.js";
import { CapQueueRejectedError } from "../orchestration/cap-queue.js";
import { nextFireAt } from "../orchestration/cron.js";
import { withScheduleTimeEcho, nowEcho } from "../orchestration/time-echo.js";
import { reminderNextFireAt, reminderNextFireAtBySession } from "../companion/reminders.js";
import type { CompanionReminder, CompanionRoute } from "../companion/types.js";
import { resolveIdPrefix, MIN_ID_PREFIX_LEN } from "../id-prefix.js";
import { resolveWebDistDir } from "../paths.js";
import { loomVersion } from "../version.js";
import { computeDeployStaleness } from "../deploy-staleness.js";
import { lineageRootId } from "../sessions/platform-lead-prompt.js";
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

// Same envelope as the task MCP server (mcp/server.ts).
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

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
 * `gate_status(opId)` (card edc1ec12, Platform-Audit finding 7afa6ea9; generalized by card e3e40167) — a
 * read-only status lookup. Registered on BOTH the manager and worker surfaces (card fc243a43 added the
 * worker variant), with the worker's own call SCOPED to opIds it owns (`scopeSessionId`/`scopeProjectId`,
 * threaded straight through to `SessionService.gateStatus` → BOTH `GateSemaphore.findByOpId` (the live
 * registry) AND `Db.findPendingGateOpByOpId` (the durable tombstone table it now falls back to) — see
 * their docs for why this is a candidate-set filter, not a post-hoc check: a worker's lookup never even
 * SEES another session's op at EITHER layer, so it cannot learn one exists). The manager call site
 * (scopes omitted) is unchanged from before this card. Still has NO PASS/FAIL outcome path of its own —
 * it only ever answers "still queued / still running / [a terminal CLASSIFICATION, never pass-or-fail] /
 * gone (worded differently by scope — see below) / ambiguous prefix" (see SessionService.gateStatus's doc
 * for the full state list and why there's no live output tail). `opId` accepts a full id or an unambiguous
 * 8-char prefix (card 225bc7bd).
 *
 * TWO DIFFERENT "gone" WORDS FOR TWO DIFFERENT CERTAINTY LEVELS (review-caught, card e3e40167): the
 * UNSCOPED manager path can honestly return `"never_existed"` — a POSITIVE assertion, since nothing was
 * ever filtered out of its view. The SCOPED worker path can NEVER honestly say that: a miss there could
 * mean the id genuinely never existed, OR that it exists but belongs to someone else — the scoping filter
 * deliberately can't tell those apart (that's what makes it safe), so claiming `never_existed` for a
 * scoped miss would be a confident, false, positive-nonexistence claim — the EXACT conflation this card
 * removed from `not_found`, reintroduced one layer down. The worker path instead returns `"unknown"` — see
 * SessionService.gateStatus's doc for the full reasoning.
 *
 * `elapsedMs` here and `gate_queue`'s `since`/`elapsedMs` read the SAME underlying value
 * (`GateSnapshotEntry.since`, set by `GateSemaphore.snapshot`'s `toEntry`) — both are PHASE-SCOPED, not a
 * fixed admission clock: `enqueuedAt` while `queued`, RE-BASING to `startedAt` the moment the entry is
 * admitted. Card 5450ed3e (Codescape peer mgr #5, corroborated from Loom's own reads of the same
 * transition): a reader who assumes `since`/`elapsedMs` measure time-since-admission will misread a
 * deeply-queued entry's large `elapsedMs` as "this has been running a long time" when it hasn't started —
 * the exact wrong-direction misread that invites cancelling a healthy gate. Both tools document this
 * explicitly in their descriptions below; keep them in sync if either changes. `elapsedMs` is `null` for
 * every tombstone-fallback state (`settled`/`evicted-dead-owner`/`orphaned-by-restart`/`pending`) — there
 * is no live admission clock to read once the op is no longer in the live registry.
 *
 * `idleMs`/`extended`: `elapsedMs` (however large) is frequently HEALTHY BY DESIGN and cannot by itself
 * answer "is this wedged?" — `gate-runner.ts`'s own `runGateStep` extends a step's timeout, rather than
 * killing it, precisely WHEN it's still producing output (see `GATE_EXTEND_IDLE_MS`'s doc), so a long
 * `elapsedMs` is routinely just "working hard", not "hung". `idleMs` (`Date.now() - lastOutputAt`, the
 * SAME liveness clock that extension decision itself reads — never a second, independently-computed one)
 * is the signal that actually tells the two apart; `extended` (whether the CURRENT step already used its
 * one-time auto-extend) is the directly-relevant fact about how much runway is left before a stall would
 * actually be killed. Both are documented on `gate_status`/`gate_queue` below; keep them in sync too.
 */
function registerGateStatus(server: McpServer, sessions: SessionService, scopeSessionId?: string, getScopeProjectId?: () => string | undefined): void {
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
      "\"ambiguous\", gateType, elapsedMs, idleMs, extended?, error?, admittedAt?, passed?, cancelled?, reason?, " +
      "durationMs?, validatedHead?, headWarning?, steps?, outputTail?, gateDetail?, proximity?}. `admittedAt` (ISO, when " +
      "the op was minted) is present whenever a row exists at all — live or settled — not gated on a " +
      "recorded verdict. `queued`/`running` mean it's still " +
      "LIVE. `settled` means the op reached a normal terminal result (pass, fail, error, or cancelled). " +
      "The `[loom:gate-done]`/`[loom:gate-failed]` nudge is still the PRIMARY, unprompted way you learn the " +
      "outcome — but once `state` reads `settled`, this tool NOW ALSO reports it directly: `passed:true` " +
      "(a green run) or `passed:false` (a real failure, with `reason` + `gateDetail` — the SAME " +
      "phase/failedStep/failingTest/exitCode/signal/timedOut diagnosis the failure nudge embeds) are set " +
      "together with `durationMs`/`validatedHead`/`headWarning`/`steps` (the same per-step timings the " +
      "green merge nudge already carries) and a bounded `outputTail` (present on BOTH a pass and a fail — " +
      "a passing run used to retain none of this at all). `proximity` ({nearBudget, step, fraction}, card " +
      "3407caad) is a WARN-BEFORE-BREACH signal — unlike `extended` (which only ever tells you a run " +
      "ALREADY consumed its one-time auto-extend, i.e. already breached budget), `proximity.nearBudget:true` " +
      "means the worst step's `durationMs` crossed a threshold set well above this project's own healthy " +
      "steady state, so it's worth raising `gateCommandTimeoutMs`, splitting the suite, or investigating " +
      "what got slower — BEFORE the next run actually times out. `fraction` is ALWAYS against the RAW, " +
      "configured `gateCommandTimeoutMs` — the HARD ceiling a post-timeout retry enforces with NO " +
      "auto-extend (card 24642c3d) — never the ~2× effective ceiling a FIRST attempt's own one-time " +
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
      "`settled`: no verdict was ever reached, re-run `run_gate` if you still need one. `pending` is rare: " +
      "the op is known to exist but isn't visible in the live registry yet (a narrow just-started or " +
      "post-restart window) — wait and re-check rather than treating it as stuck. `unknown` covers BOTH " +
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
      "poll it on a timer."
    : "Read-only status for ONE merge-gate run, by the `opId` a `worker_merge_confirm` " +
      "{status:\"pending\"} response returned — lets you check whether that run is still queued behind the " +
      "daemon's gate concurrency cap, actually executing, or has already reached a terminal state, WITHOUT " +
      "waiting for the eventual completion nudge. `opId` accepts the FULL id OR an unambiguous 8-char " +
      "id-prefix (the short id Loom displays everywhere else — same resolution as `tasks_get`/" +
      "`worker_spawn`/`escalation_status`). Returns {state:\"queued\"|\"running\"|\"pending\"|\"settled\"|" +
      "\"evicted-dead-owner\"|\"orphaned-by-restart\"|\"never_existed\"|\"ambiguous\", gateType, elapsedMs, " +
      "idleMs, extended?, error?, admittedAt?, settledAt?, totalDurationMs?, outcome?, proximity?}. `queued`/`running` " +
      "mean it's still LIVE. `settled` means the op reached a normal terminal " +
      "result (merged, rejected, or errored) — rely on the `[loom:merge-done]`/`[loom:merge-rejected]`/" +
      "`[loom:merge-failed]` nudge for the ACTUAL rejection/failure diagnosis (phase, failing test, " +
      "stderr — this tool never reports that level of detail itself), but a settled op now retains a " +
      "durable, queryable RECORD too: `admittedAt` (ISO, when the op was minted — present whenever a row " +
      "exists at all, live or settled) and, once settled, `outcome` (`\"pass\"`|`\"fail\"`|`\"error\"`|" +
      "`\"cancelled\"` — `\"pass\"` means merged, `\"fail\"` means a resolved rejection, `\"error\"` means a " +
      "thrown exception mid-confirm), `settledAt` (ISO) and `totalDurationMs` (`settledAt - admittedAt`, " +
      "the FULL op wall time — worktree prep + union-merge + gate + squash, not just the gate step itself; " +
      "strictly ≥ the `steps` line the completion nudge carries, which is only ever a FLOOR on the real " +
      "total). `extended` here means something different from the LIVE `extended` below: once settled, it " +
      "reports whether ANY step of the gate this op actually ran ever consumed its one-time auto-extend — " +
      "`undefined` (not `false`) when no gate spawned for this op at all (gateless project, or a REUSED " +
      "self-check), so `extended:true` paired with `outcome:\"fail\"` is the specific \"this run was over " +
      "budget AND it failed\" signal worth flagging, distinct from either fact alone. `proximity` " +
      "({nearBudget, step, fraction}, card 3407caad) is a WARN-BEFORE-BREACH companion to `extended` — " +
      "unlike `extended` (which only ever fires AFTER a breach), `proximity.nearBudget:true` fires while " +
      "a run is still comfortably PASSING, once its worst step's duration crosses a threshold set well " +
      "above this project's own healthy steady state — worth raising `gateCommandTimeoutMs`, splitting " +
      "the suite, or investigating what got slower BEFORE the next run actually times out. `fraction` is " +
      "ALWAYS against the RAW, configured `gateCommandTimeoutMs` — the HARD ceiling a post-timeout retry " +
      "enforces with NO auto-extend (card 24642c3d) — never the ~2× effective ceiling a FIRST attempt's " +
      "own one-time auto-extend can reach; a `fraction` over `1` means this step already needed more than " +
      "the hard ceiling and only survived because it was a first attempt. Same " +
      "`undefined`-for-no-gate-spawned discipline as `extended`. These settled- " +
      "record fields are OMITTED, never fabricated, for a settled op that predates this capability. " +
      "`evicted-dead-owner` means the op's OWNING MANAGER died before it settled and a later confirm force-" +
      "evicted it — its own run() may STILL be executing unreachable in the background; no verdict was " +
      "ever delivered for it, treat it like `settled` for planning purposes and just re-run " +
      "`worker_merge_confirm`. `orphaned-by-restart` means a daemon restart killed this run before it could " +
      "finish — you should already have received a synthetic `[loom:merge-failed]` nudge for it at boot; " +
      "re-run `worker_merge_confirm`. `pending` is rare: the op is known to exist but isn't visible in the " +
      "live registry yet (a narrow just-started or post-restart window) — wait and re-check rather than " +
      "treating it as stuck. `never_existed` is a POSITIVE assertion the id was never minted at all — never " +
      "confuse it with `settled` (a real op DID run, you just don't have its outcome from this tool). " +
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
      "given another reprieve.";
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
        return ok(sessions.gateStatus(opId, scopeSessionId, getScopeProjectId?.()));
      } catch (e) {
        return ok({ error: (e as Error).message });
      }
    },
  );
}

// gate_queue (card fa359824 — Codescape manager escalation 530e59a0; exposed to the WORKER surface too by
// card d04f9c76 — Codescape platform relay: a worker told "confirm a lane is free before firing" had no
// daemon-wide view of its own and could only ever fire `run_gate` blind into a saturated cap). gate_status
// only ever answers "what is MY op doing", so a caller with no op of its own to poll (or one whose op has
// been queued a long time) had no way to tell healthy contention apart from a leaked slot short of
// cross-project DB access no worker/manager surface grants. This is the ONE-read answer: cap + every
// running/queued gate run. READ-ONLY — it cannot mutate the cap, cancel, or reorder anything; it only
// reads the live GateSemaphore registry (see SessionService.gateQueueForManager's doc for the
// cross-project scoping: a row from a DIFFERENT project is named by project + kind + age only, never its
// task title/branch). Privacy is keyed off the CALLER'S PROJECT (derived server-side from `sessionId`,
// same as every other tool here), never the caller's ROLE — `gateQueueForManager` takes only a
// `callerProjectId` and redacts by comparing each entry's OWN projectId against it, so a worker sees
// EXACTLY the same cross-project redaction a manager on the same project would (verified: gate-queue.mjs's
// redaction checks now run against BOTH a manager AND a worker session on the same project, see (unit-worker)
// below). `recentTimeoutStreak` (escalation 4f151331, filed while the manager card was in flight — a REAL
// incident: two concurrent daemon-executed gates under cap 1, one worktree's fixtures already running while
// its op still read "queued") is a SECOND, independently-tracked signal alongside the semaphore's own
// belief — see SessionService.gateQueueForManager's doc for why the two are surfaced side by side, never
// merged.
function registerGateQueue(server: McpServer, sessions: SessionService, db: Db, sessionId: string): void {
  server.registerTool(
    "gate_queue",
    {
      description:
        "Read-only snapshot of the WHOLE daemon-global gate queue — the resolved concurrency cap plus " +
        "every gate run currently `running` or `queued` (merge/deploy/worker-self-check alike), so you can " +
        "answer 'why is my gate queued, who holds the slot, how deep am I' from ONE read instead of " +
        "guessing or polling gate_status per-opId, or firing `run_gate` blind to find out. Returns {cap, " +
        "activeCount, queuedCount, running: " +
        "GateQueueEntry[], queued: GateQueueEntry[]} — `queued` is already in real admission order (all " +
        "high-priority merge/deploy waiters before low-priority worker self-checks, FIFO within each " +
        "tier), so its array index + 1 IS each entry's queue position (also echoed as `queuePosition`). " +
        "Each entry carries {opId, gateType, projectId, projectName, since, elapsedMs, idleMs, extended, " +
        "queuePosition, repoContended} — " +
        "`since`/`elapsedMs` are PHASE-SCOPED to whichever array the entry is in, not a fixed admission " +
        "clock: for a `queued` entry they measure time WAITING (since it was enqueued); once admitted, the " +
        "SAME entry RE-BASES to admission time and they measure time RUNNING instead. Don't read a `queued` " +
        "entry's `elapsedMs` as run time — a deeply-queued op can show a large `elapsedMs` while it has done " +
        "zero seconds of actual work, and mistaking that for a hung run is exactly backwards: it lands " +
        "hardest on the op that's MOST expensive to wrongly cancel. ⚠️ AND EVEN A `running` ENTRY'S LARGE " +
        "`elapsedMs` IS NOT EVIDENCE OF A WEDGE — it is routinely HEALTHY BY DESIGN: the gate auto-extends a " +
        "step's timeout, rather than killing it, for as long as the step keeps producing output (see " +
        "`GATE_EXTEND_IDLE_MS` in gate-runner.ts), so a long-running gate is frequently just working hard, " +
        "not hung. `idleMs` (`Date.now()` minus that run's last liveness event — started, or produced a " +
        "stdout/stderr byte — " +
        "the SAME liveness clock the gate's own auto-extend decision reads, never a second, " +
        "independently-computed number) is the signal that actually tells \"working hard\" apart from " +
        "\"hung\": non-null once the run has genuinely started (normally the same instant it's admitted " +
        "into `running`, though a brief real pre-flight gap can still read `null` too), `null` while " +
        "`queued` or otherwise not live. A small `idleMs` means recent, active output regardless of how " +
        "large `elapsedMs` has grown; `idleMs` approaching this project's gate-idle threshold is the real " +
        "warning sign. `extended` (always `true`/`false`) tells you whether the CURRENT step already used " +
        "its one-time auto-extend — `true` means the NEXT deadline is a real kill, not another reprieve. " +
        "Both `idleMs`/`extended` are present on EVERY entry regardless of project — unlike `taskId`/" +
        "`branch`/`workerLabel` below, they carry no more than the age a cross-project entry already " +
        "exposes, so cross-project redaction doesn't apply to them. `opId` is the SAME id `gate_status(opId)` accepts (full or an " +
        "unambiguous 8-char prefix), so you can chain into a live per-op read if you want one. An entry " +
        "belonging to YOUR OWN project ALSO " +
        "carries {taskId, branch, workerLabel} (\"<agent> · <short task title>\"); an entry from a " +
        "DIFFERENT project omits those three fields entirely (never redacted-to-null) — named only by " +
        "project + gate kind + age, which is enough to tell 'someone else legitimately holds the slot' " +
        "apart from 'this looks leaked' without exposing another project's task/branch identity. " +
        "`repoContended` (bool, every entry) is `true` ONLY for a QUEUED `merge`-kind entry whose target " +
        "repo is currently held by another RUNNING merge gate (card 92e960d1's per-repo merge-admission " +
        "guard — at most one merge gate per canonical repo runs at once, so two same-repo merges never " +
        "race to squash and burn a gate run each) — a queued merge can show this `true` even while `cap` " +
        "has a free lane, which is expected, not a bug: it's waiting on the REPO, not the cap. `false` " +
        "means this specific guard isn't why it's queued (still possibly `cap`, or the older, separate " +
        "per-worktree guard from card 8d585277, which this field does NOT report on). Always `false` " +
        "while `running` or for a non-`merge` entry. It's a LIVE read, recomputed on every call — it can " +
        "flip on a still-queued entry as sibling ops settle. " +
        "IMPORTANT — `phase`/`queuePosition` reflect only what the semaphore BELIEVES, which can diverge " +
        "from reality: a gate timeout can settle (freeing the slot) without its process tree actually " +
        "dying, leaving an orphan the registry no longer tracks. So an OWN-project entry with a `branch` " +
        "ALSO carries `recentTimeoutStreak` (an integer ≥0) — how many consecutive timeouts that branch " +
        "has recorded, from an INDEPENDENT tracker that survives exactly the eviction the live registry " +
        "doesn't. A nonzero streak on a 'queued' or 'running' entry is a reason to verify no orphaned " +
        "process survives from an earlier attempt before treating this worktree as otherwise idle — treat " +
        "it as a second data point, not a verdict this tool merges into `phase` itself. This tool is cheap " +
        "(an in-memory read bounded by cap + queue depth, never a real scan) — safe to call BEFORE firing " +
        "`run_gate`/`worker_merge_confirm` to confirm a lane is actually free instead of firing blind into " +
        "a saturated cap, and again right after either comes back `pending` to see the full picture instead " +
        "of only your own op's state.",
      inputSchema: strictShape({}),
    },
    async () => {
      const projectId = db.getSession(sessionId)?.projectId;
      if (!projectId) return ok({ error: "no project for this session" });
      return ok(sessions.gateQueueForManager(projectId));
    },
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
 *   - worker  → worker_report + the read-only my_context ONLY (so a worker CANNOT spawn/list/stop —
 *               the depth-1 tree holds at the tool surface, not just the role gate);
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

/**
 * Event kinds that genuinely CLOSE a standing `worker_report(done|blocked)` — i.e. actually move the
 * manager past "this worker needs my review", not merely "some worker-keyed row landed after it." Read
 * by `reportedProjection` below. An ALLOWLIST, not a denylist, and deliberately so (card 6641c3ab):
 * `orchestration_events.worker_session_id` is reused across this codebase as a generic "subject of this
 * event" column by plenty of things that are NOT a review being resolved — `merge_request`
 * (reviewWorkerMerge, fired at REVIEW-START, before any merge decision is even made — this is what
 * actually caused the bug: a manager merely looking at a worker's diff via `worker_merge` cleared
 * `awaitingReview` before `worker_merge_confirm` was ever called), `merge_rejected`/`merge_cancelled` (a
 * decision was made, but not the "merged" the doc promises clears this), `worker_stuck` (a watchdog
 * advisory), crash-recovery triggers, etc. A denylist would have to name every one of those AND every
 * future one — missing just one silently reintroduces this exact bug, which is how `merge_request` did,
 * undetected, before this card. An allowlist fails in the SAFE direction instead: a kind missing from
 * this set just means a manager looks at a worker that didn't actually need looking at (self-correcting
 * the instant they look), never a finished worker sitting unnoticed indefinitely (the bug this fixes).
 *
 * `message_worker`/`redirect_worker` are a PROXY for the doc's actual stated condition ("resumes a
 * turn"), not the thing itself — Loom records the SEND here, not a confirmed turn resumption. Right in
 * the common case, but a message that gets durably queued and then PARKED (never delivered — see memory
 * `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`) breaks the proxy: the worker never
 * actually resumed, yet this would still read as resolved. Known, accepted gap — building
 * parked-message detection into this projection is out of scope here.
 */
const REPORT_RESOLVED_EVENT_KINDS: ReadonlySet<OrchestrationEvent["kind"]> = new Set<OrchestrationEvent["kind"]>([
  "merge_done", "message_worker", "redirect_worker", "recycle_begin", "stop_worker",
]);

/**
 * Resolve ONE directive's (a `message_worker`/`redirect_worker` send's) current fate from durable event
 * history alone, walking its give-up/re-mint chain from `rootMsgId` forward. Card 35c96aa6: hoisted out of
 * `buildServer`'s `staleDirectiveProjection` closure to MODULE scope (unchanged logic — it never closed
 * over anything but its own three parameters; `events`' type was previously spelled via
 * `ReturnType<typeof db.listEventsForWorker>` purely for convenience, now the equivalent `OrchestrationEvent[]`)
 * so a second caller — the worker-facing `directive_status` tool below — can reuse the EXACT SAME walk
 * instead of a parallel reimplementation that could silently drift from it. `staleDirectiveProjection`'s own
 * call site is untouched; this is a pure scope move, not a behavior change.
 *
 * Each msgId gives up AT MOST ONCE (a give-up either re-mints to a brand-new msgId or parks terminally —
 * see handleGiveUpExhausted's doc) — so walking msgId -> its one give-up event -> the next msgId cannot
 * loop; `seen` is a cheap defensive bound, not a real cycle guard.
 */
export function resolveDirectiveOutcome(
  events: OrchestrationEvent[], rootDirective: OrchestrationEvent, rootMsgId: string,
):
  | { state: "parked"; msgId: string; parkedAt: string }
  | { state: "confirmed-after-park"; msgId: string; parkedAt: string; confirmedAt: string }
  | { state: "delivered"; msgId: string; deliveredAt: string; turnSeqAtDelivery: number }
  | { state: "pending"; msgId: string } {
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

/**
 * Card 867e64f1 DoD-3 — the manager-facing per-message consumed/not-consumed read, keyed to a SPECIFIC
 * `msgId` rather than "whichever directive is most recent" (`staleDirectiveProjection`'s own `directive`
 * field). Both `staleDirectiveProjection` and the worker-facing `directive_status` tool already resolve a
 * chain via `resolveDirectiveOutcome`; what neither offers is a way to re-check an OLDER root msgId once a
 * NEWER worker_message/worker_redirect has become "the tracked directive" — `staleDirectiveProjection`
 * scans backward and keeps only the LATEST `message_worker`/`redirect_worker` event by design (see its own
 * "latest wins" doc), so an earlier directive's own resolution is invisible there the moment a second one
 * is sent, even though its OWN durable event chain (give-up/re-mint/park/confirmed-after-park) keeps
 * existing and keeps resolving independently. That is exactly the incident shape this card measured: a
 * manager sent directive #2 before directive #1 had resolved, and had no way — while #2 was outstanding —
 * to re-ask "did #1 specifically land?"
 *
 * `msgId` here is the ROOT msgId a manager's own worker_message/worker_redirect call returned to it —
 * the SAME id `resolveDirectiveOutcome`'s callers already key on (see that function's own doc: a mid-chain
 * remint id is never handed to the sender and would be meaningless to query). `found:false` means this
 * worker has no `message_worker`/`redirect_worker` event carrying that exact root msgId at all — a
 * distinct signal from `state:null` on a msgId that WAS sent but has no further resolution (there is no
 * such case: every found root either resolves via `resolveDirectiveOutcome` or is defensively `pending`).
 */
function directiveByMsgId(
  events: OrchestrationEvent[], msgId: string,
): { msgId: string; found: boolean; state: "pending" | "delivered" | "parked" | "confirmed-after-park" | null; at: string | null } {
  const directiveEvent = events.find((e) => {
    if (e.kind === "message_worker") return e.detail?.msgId === msgId;
    if (e.kind === "redirect_worker") return e.detail?.queuedMsgId === msgId;
    return false;
  });
  if (!directiveEvent) return { msgId, found: false, state: null, at: null };
  const outcome = resolveDirectiveOutcome(events, directiveEvent, msgId);
  const at =
    outcome.state === "parked" ? outcome.parkedAt
    : outcome.state === "confirmed-after-park" ? outcome.confirmedAt
    : outcome.state === "delivered" ? outcome.deliveredAt
    : null;
  return { msgId, found: true, state: outcome.state, at };
}

/**
 * Card 35c96aa6 — walk `sessionId`'s OWN `recycledFrom` ancestor chain, self included, bounded/cycle-
 * guarded. Same shape as `lineageRootId` (sessions/platform-lead-prompt.ts), but returns the FULL chain
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

/**
 * Card 35c96aa6 — the read behind the worker-facing `directive_status` tool: "which durable, turn-
 * confirmed hand-offs, of a message whose root label matches `rootLabel` (or of ANY root, when
 * `rootLabel` is omitted), has `callerSessionId` — or a predecessor in its own recycle lineage — ever
 * received?" DELIVERY history only, never a claim about action — see the tool's own description for the
 * explicit non-claim.
 *
 * Reuses `resolveDirectiveOutcome` per directive event (same function `staleDirectiveProjection` calls,
 * see its own doc) rather than re-deriving chain state, applied to EVERY `message_worker`/`redirect_worker`
 * event found in scope — not just the latest one `staleDirectiveProjection` tracks — because a manual
 * resend (`resendOf`) can create a SEPARATE top-level directive event sharing the SAME true root, and each
 * must be walked on its own.
 *
 * LABEL, not internal id: a worker only ever sees the 8-hex-char label `framePossibleDuplicate` puts in a
 * `[loom:possible-duplicate root:…]` tag — never the raw internal `rootMsgId` — so matching must use
 * `possibleDuplicateRootLabel` (pty/host.ts), the SAME function that produced the tag, not a re-derived
 * approximation. A directive's TRUE internal root (needed to compute that label) is recovered from
 * `session_message_queued`/`session_message_gave_up` events' own `detail.rootMsgId` field — NOT from
 * `message_worker`/`redirect_worker`'s own `detail.msgId`/`detail.queuedMsgId`, which is always a FRESH
 * per-call mint (see `enqueueDurableMessage`, sessions/service.ts) and only coincidentally equals the true
 * root for a plain first-ever send with no `resendOf`. A directive event whose own msgId is absent from
 * that map (never queued, never gave up — a clean first-ever immediate delivery) self-roots to its own
 * msgId and is never tagged — but NOT because `framePossibleDuplicate` itself refuses a self-root (it
 * applies the tag UNCONDITIONALLY whenever called; there is no such guard inside it — see that function's
 * own doc, and card fb5d2220's gate-time audit). The real guarantee is CALL-SITE DISCIPLINE: every actual
 * caller (the `giveUpGen`-gated write in `joinSubmittedText`, `handleGiveUpExhausted`'s re-mint, the
 * kickoff give-up re-mint, and Path D's `redriveQueuedMessage`, pty/host.ts + sessions/service.ts) only
 * ever invokes it on a message that WAS queued or gave up. Path D's redrive (bcaeab8d) frames
 * UNCONDITIONALLY, but only ever redrives a row with an existing `session_message_queued` record — so the
 * "never queued" case stays unreachable through it too, and the guarantee survives, on that narrower basis
 * rather than the function-level one this comment used to cite. A real worker-supplied label can never
 * legitimately match one — harmless.
 *
 * Only `state: "delivered"` and `state: "confirmed-after-park"` outcomes ever produce a delivery record —
 * `"parked"`/`"pending"` never reached any turn, so they carry no information relevant to "have I seen
 * this before". A `confirmed-after-park` entry's `turnSeq` is `null` (no hand-off was ever cleanly
 * stamped — that's the whole shape of the bug it corrects) but is STILL a genuine, durably-recorded prior
 * delivery. CAUGHT IN SELF-AUDIT: an earlier draft of this doc claimed such an entry "always predates the
 * caller's current turn" — NOT verified. The confirming hook that produces it fires asynchronously off
 * engine-side evidence (see `onGiveUpConfirmed`'s own doc, pty/host.ts), and this function has no way to
 * establish it can never resolve mid-way through the very turn that's asking. The turnSeq-comparison
 * technique above simply does not apply to a null entry — its presence is evidence of a genuine delivery,
 * not evidence of WHEN relative to the caller's current turn; don't claim more than that.
 *
 * Each entry carries BOTH `fromSession` (the event's own `managerSessionId` — the actual SENDER) and
 * `receivedBy` (the event's own `workerSessionId` — which id in the CALLER's OWN lineage actually took the
 * hand-off; may be a predecessor, never anyone outside the lineage). Do not collapse these into one field:
 * `receivedBy` differing from the live caller's own sessionId is precisely the recycle-boundary signal
 * DoD-3 exists to make visible — "a predecessor of mine received this, not me."
 *
 * Bounded to the 20 MOST RECENT deliveries when `rootLabel` is omitted (an unfiltered call is meant to be
 * a cheap standing habit, not a full-history dump); a single-label filtered call returns its complete
 * history uncapped (inherently small — one logical chain's own deliveries).
 */
const UNFILTERED_DELIVERY_CAP = 20;
function directiveDeliveriesForCaller(
  db: Db, callerSessionId: string, rootLabel?: string,
): {
  deliveries: Array<{ root: string; at: string; turnSeq: number | null; msgId: string; fromSession: string; receivedBy: string }>;
  currentTurnSeq: number;
  truncated: boolean;
} {
  const lineage = ownLineageIds(db, callerSessionId);
  const events = lineage.flatMap((id) => db.listEventsForWorker(id));
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
    // that value can only ever be one of `lineage`'s own ids — it could never have named a sender.
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

  /**
   * READ-ONLY projection of the caller's project RESOLVED gateCommand (the build/DoD gate run in a
   * worker's worktree before merge), folded into `my_context` so a manager/worker can SEE the gate
   * without a new tool. Resolved through the ONE config mechanism (`resolveConfig`) — never the default
   * ad hoc — so a per-project override or human PATCH is reflected with no daemon restart.
   *
   * `timeoutMs` is resolved through the SAME `resolveConfig(...).orchestration.gateCommandTimeoutMs`
   * path the gate itself enforces (`sessions/service.ts` confirmWorkerMerge + the worker `run_gate`
   * call-site) — never re-derived or hardcoded — so it tracks a per-project override, not the platform
   * default (card 89257222: an unreadable timeout was propagating as manager-to-manager folklore instead
   * of being read from the artifact). Reported unconditionally, even when no gateCommand is configured,
   * since the timeout still governs whatever gate a project later sets.
   *
   * TRUST BOUNDARY — this is READ-ONLY by design (PL Auditor finding #9, signed off on option (b)).
   * `gateCommand` runs arbitrary host shell at daemon privilege, so it stays HUMAN-only-to-SET (same
   * class as the vault/git writers + alertWebhook). NO set/propose/confirm-queue surface exists here.
   * When NO gate is configured (the platform default is the empty string), this returns an explicit
   * `configured:false` + a note so the manager ASKS THE OWNER to set one (a human action) rather than
   * hand-rolling a gate string into a worker's DoD.
   */
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
    const ctxInputTokens = s?.ctxInputTokens ?? null;
    const measuredAt = s?.ctxUpdatedAt ?? null;
    const gateCommand = this.resolvedGateCommand(s?.projectId);
    const columns = this.resolvedColumns(s?.projectId);
    const companion = s?.role === "assistant" ? this.companionIntrospection(sessionId) : undefined;
    // Card dcd8659c: the same PtyHost getter worker_list/worker_status read, folded in here so a
    // manager/worker can self-check whether ITS OWN composer is holding unsubmitted text — the gap named
    // in the card as not covered by the third-party worker_list/worker_status read. null (not 0) when the
    // session isn't live in this process — see getComposerDirtyLen's own doc for why a dead/never-live
    // session must never read as a measured-clean 0.
    const composerDirtyLen = this.pty?.getComposerDirtyLen(sessionId) ?? null;
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
        ctxInputTokens: null, contextWindow, pct: null, model, measuredAt, gateCommand, columns, measured: false,
        note: "context not measured yet (no completed turn) — occupancy unknown; contextWindow/model " +
          "reflect the CONFIGURED profile model when set, else the DEFAULT_CONTEXT_WINDOW fallback",
        composerDirtyLen,
        unconfirmedDeliveryMs,
        ...(companion ? { companion } : {}),
      };
    }
    const model = s?.model ?? null;
    const contextWindow = contextWindowForModel(model);
    return {
      ctxInputTokens,
      contextWindow,
      pct: Math.round((ctxInputTokens / contextWindow) * 100),
      model,
      measuredAt,
      gateCommand,
      columns,
      composerDirtyLen,
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
  private registerMyContext(server: McpServer, sessionId: string): void {
    server.registerTool(
      "my_context",
      {
        description:
          "Read YOUR OWN context occupancy (no args — server-derived from your session). Returns " +
          "{ctxInputTokens, contextWindow, pct, model, measuredAt, gateCommand}: pct is your measured " +
          "context size as a percentage of your model's window. Use it at a clean seam to self-assess — " +
          "a manager to decide whether to recycle_me, a worker to worker_report that it's getting heavy. " +
          "If not yet measured (no completed turn), pct is null and `measured:false` is set explicitly — " +
          "contextWindow/model in that case reflect your CONFIGURED profile model (still accurate), not a " +
          "fake reading. `gateCommand` is the project's RESOLVED build/DoD gate, READ-ONLY: " +
          "{configured:true, command, timeoutMs} when set, else {configured:false, command:null, note, " +
          "timeoutMs} — when unconfigured, ASK THE OWNER to set one (a human-only action); never " +
          "hand-roll a gate command into a worker's DoD. `timeoutMs` is the RESOLVED gate timeout (the " +
          "same number the gate itself enforces, per-project override or platform default — never guess " +
          "or carry an inherited figure). Read all four facts about it before reasoning about margin: " +
          "(1) a step is auto-extended past `timeoutMs` while it keeps producing output, so exceeding " +
          "this number does NOT by itself mean failure — but (2) the merge gate's retry-after-timeout " +
          "runs with NO extension (allowExtend:false, deliberately) — so first attempt = timeoutMs + one " +
          "extension (~2x), while a retry is a HARD timeout with no net; state (1) and (2) together, " +
          "never (1) alone, or the reader computes margin against the wrong ceiling. (3) The extension " +
          "is refused if the child has been idle for a while (it rescues 'working hard', never " +
          "'stalled'). (4) A retry only fires when the failure is classified non-genuine — a timeout is " +
          "retry-eligible, a clean non-zero exit (a real test failure) never retries. `composerDirtyLen` " +
          "is a count of characters possibly still sitting UNSUBMITTED in YOUR OWN composer from an " +
          "earlier delivery that never confirmed (null when not live in this process; 0 means genuinely " +
          "clean, NOT unknown) — a non-zero value here, with no turn progressing, means your own last " +
          "message may never have actually landed; one Enter in your terminal recovers it. " +
          "`unconfirmedDeliveryMs` (card a33a72f7) is an EARLIER signal than composerDirtyLen: " +
          "milliseconds since your CURRENT generation's Enter was written, for as long as it stays " +
          "unconfirmed — null when nothing is outstanding (never submitted, or already confirmed) OR " +
          "when the session isn't live in this process — an ABSENT signal, not a measured zero, same " +
          "discipline as composerDirtyLen's own null; a " +
          "number the INSTANT a write is outstanding (no dependency on the give-up/heal budget actually " +
          "firing, unlike composerDirtyLen). It does NOT distinguish 'still within Loom's own retry " +
          "budget' from 'Loom already gave up on this exact generation, outcome still unknown' — giving " +
          "up never resets it. Cross-check composerDirtyLen: zero there while this is non-null means " +
          "genuinely in-flight and never given up; non-zero there is ambiguous (may be this generation's " +
          "own give-up, or stale residue from an earlier one). If you are a " +
          "Companion (chat_reply is on your tool list), the response ALSO " +
          "includes `companion`: {bindings: [{channel, voiceReplies}], lastDelivery: {channel, text, " +
          "viaVoice, sentAt} | null} — your OWN bound channel(s) + effective voice-reply mode, and the last " +
          "reply you actually delivered (`text` IS that clip's transcript when `viaVoice` is true). Use it " +
          "to answer 'what did you just send / on which channel / was it spoken' from real state. " +
          "`columns` is your project's RESOLVED board layout — the SAME array the `board_column_create/" +
          "rename/delete` tools already return in their own {ok, columns, warnings} payload, so THIS is " +
          "the read-only way to see it without issuing a mutating call just to read the response. Each " +
          "entry carries at least {key, label, role, excludeFromIdleWatchdog} — role and " +
          "excludeFromIdleWatchdog are OPTIONAL and ABSENT when not set on that column, meaning today's " +
          "default (unroled / not discounted from the idle watchdog), never a measured `false`. Use it to " +
          "audit which lanes are discounted from the idle watchdog (`excludeFromIdleWatchdog: true`) " +
          "instead of guessing from a census that can't see them.",
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
          "reach right now — that's the only case to hold back and wait. Mirrors " +
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
          "content}, or {error} if there's no such skill.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const content = readCompanionSkill(sessionId, name);
        return ok(content == null ? { error: `no skill "${name}"` } : { name, content });
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
          "content}, or {error} if there's no such entry.",
        inputSchema: strictShape({ name: z.string() }),
      },
      async ({ name }) => {
        const content = readCompanionMemory(sessionId, name);
        return ok(content == null ? { error: `no memory "${name}"` } : { name, content });
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

  private buildServer(sessionId: string, role: SessionRole): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const pty = this.pty;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });

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
          return result?.delivered === true;
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
      spawnSession: (projectId, agentId, role, _senderSessionId) =>
        sessions.spawnSessionAsPlatform(projectId, agentId, role as "manager" | "plain"),
    }, this.trustWindow,
    // `git-push` lever's own seam (card a3c3ade8) — builds a bounded, non-interactive GitWriter for ONE
    // repo path, sharing the SAME boot-resolved timeouts the human git-write REST routes and the Platform
    // Lead's own git tools use (mcp/platform.ts's `gitWriterFor`). Undefined `gitWriteTimeouts` (every
    // existing test double) ⇒ GitWriter's own module-default timeouts.
    (repoPath) => new GitWriter(repoPath, this.gitWriteTimeouts));

    // Companion (epic Phase 1): the long-lived `assistant` role gets a MINIMAL surface — the read-only
    // my_context PLUS (only when this IS the bound companion session) the chat_reply registered just above.
    // DELIBERATELY no manager spawn/stop/list surface and no writer (least-privilege — the restricted tool
    // profile is a later card). Returns before the manager fall-through below.
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
          description: "Report your status up to your manager: moves your task (done→review, blocked→waiting) and notifies the manager. Call when done, blocked, or to checkpoint progress. Returns a `deliveryStatus` (delivered-live | queued | boarded | dropped): your manager got it now, it's queued for its next turn, or it's durably boarded for a parked/offline manager (Loom auto-wakes it) — all safe; only `dropped` means it reached nobody. `noChanges` is an OPTIONAL flag on a `done` report for a LEGITIMATE no-op — you reviewed only, investigated and found nothing to change, or your deliverable lives outside this repo (e.g. a mockup) — where the CORRECT outcome is 0 commits. Set it and a 0-commit done skips the 'you likely forgot to commit' warning and auto-retires your session cleanly (frees your manager's concurrency slot, no worker_stop needed) — the same clean exit a declared no-commit role gets. Omit it (or a done that DID commit) and behavior is unchanged; a 0-commit done without it still warns, so don't set it unless the no-op is genuinely intentional. `awaiting` is an OPTIONAL hint on a `progress` report that disambiguates WHY you then go idle: pass `\"background\"` when you're parking because you kicked off a backgrounded command/sub-agent and are relying on its own completion (or the harness's on-completion re-invoke) to bring you back — the daemon cannot see an in-flight background shell, so without this flag the `[loom:worker-idle]` watchdog defaults to assuming you're awaiting your manager's reply, which wrongly invites a `worker_message` that would double-dispatch onto your still-running work. Omit it (or pass `\"manager\"`, the default) for a real checkpoint where you genuinely are waiting on your manager's decision — that case is unaffected and still reads as awaiting-reply. Only meaningful on `progress`: a `blocked` report already means you're waiting on your manager's decision (self-contradictory with `\"background\"`), and a `done` report means you're awaiting merge review, not a reply — don't set it on either.",
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
          ok(await sessions.workerReport(sessionId, { status, summary, prUrl, needs, noChanges, awaiting })),
      );
      // run_gate (card 7f96aa09 — structural fix B for d5c5ccdf): run THIS gate through the daemon's
      // GateSemaphore instead of a raw Bash self-check, so N parallel workers can't structurally exceed
      // the total-lane budget. No args — it always runs YOUR OWN project's configured gateCommand in
      // YOUR OWN worktree; server-derived from your session id, never a param (mirrors worker_report).
      server.registerTool(
        "run_gate",
        {
          description:
            "Run this project's build/DoD gate (the SAME `gateCommand` the merge gate itself runs, in YOUR " +
            "OWN worktree) as your DoD self-check — daemon-mediated and admitted through the SAME " +
            "GateSemaphore/`maxConcurrentGates` budget the merge/deploy gates already share, instead of an " +
            "unbounded raw-Bash self-check. Prefer this over running the gate yourself via Bash: it structurally " +
            "bounds total concurrent test-lanes across every worker + merge/deploy gate on the daemon (it also " +
            "pins LOOM_GATE_TEST_CONCURRENCY=2 on the spawned child itself (matching the merge gate's own default " +
            "parallelism — semaphore-admitted, so this is structurally safe), so you don't need to set that " +
            "env var). " +
            "Because it shares one budget with merge/deploy gates, a busy fleet MAY mean this call queues behind " +
            "another in-flight gate before it even starts — that's expected, not a hang. Returns {ran:false, " +
            "reason} if this project has no gateCommand configured at all — fall back to running your own " +
            "build/test command directly (still pin LOOM_GATE_TEST_CONCURRENCY=1 yourself in that case). Otherwise " +
            "returns {ran:true, passed, validatedHead, durationMs?, headCurrent?, headWarning?, steps?, " +
            "outputTail?, gateDetail?} — " +
            "`validatedHead` is stamped when this run was ISSUED, before it's even admitted past the queue — " +
            "NOT when the build/test command actually starts. Read `headCurrent` on EVERY settled result, pass " +
            "or fail, not just on a failure: `true` means `validatedHead` is still your branch HEAD as of " +
            "settle time — nothing to check. `false` always comes with `headWarning` explaining WHICH of two " +
            "shapes it is, and they call for DIFFERENT responses: a tree that moved during the QUEUE WAIT " +
            "(before the command was admitted) was still fully present in what actually got built and tested — " +
            "the reported sha just understates it, trust the result; a tree that moved WHILE the command was " +
            "already RUNNING is genuinely unverified — the run may have read an inconsistent mix of old and " +
            "new files, don't trust it for your current code. `headWarning`'s own wording tells you which one " +
            "you're looking at — don't guess from `validatedHead` alone. `durationMs` is wall-clock from the moment THIS run was " +
            "admitted past the semaphore to the moment it settled — this is the trustworthy timing number to " +
            "reach for instead of hand-running the suite yourself for one (that bypass is exactly what silently " +
            "opts out of the concurrency cap this tool exists to enforce). Read it precisely: it EXCLUDES queue " +
            "wait (a run that sat behind another gate isn't penalized for that wait), but it does NOT exclude " +
            "general host/fleet load, and — if `maxConcurrentGates` is configured above 1 — it does NOT exclude " +
            "time spent running alongside another concurrently-admitted gate. This is a real duration under " +
            "real fleet conditions, not an isolated benchmark; don't report it as one. `durationMs`, " +
            "`headCurrent`, and `headWarning` are all omitted (undefined) on the circuit-breaker short-circuit " +
            "path, where no gate actually ran. `steps` (per-step {step, durationMs, status}, diagnostic only — " +
            "never compare these against a threshold or each other) and a bounded `outputTail` are set on " +
            "EVERY `ran:true` result, PASS INCLUDED — a passing run used to retain neither at all, leaving a " +
            "green self-check with nothing durable behind a bare pass/fail bit. On a failure, gateDetail " +
            "ADDITIONALLY " +
            "carries {phase, failedStep, failingTest, " +
            "failingTestReason, stderrTail, exitCode, signal, timedOut} so you can diagnose a real test failure " +
            "vs. a flake without re-running blind — failingTest is `undefined` (never a guessed name) only when " +
            "nothing recognizable was found, and failingTestReason then says why (gateDetail's own `stderrTail` " +
            "is the SAME string as the top-level `outputTail`, just alongside the rest of the failure diagnosis). " +
            "The async [loom:gate-failed] " +
            "nudge (see below) carries this SAME phase/failedStep/failingTest detail in its own text, not just a " +
            "raw stderr tail — you don't need the sync result in hand to get the diagnosis. The [loom:gate-done] " +
            "PASS nudge likewise now states its duration and the SAME per-step diagnostic line (never the raw " +
            "output tail — that stays in the queryable side channel, see below). Both the " +
            "[loom:gate-done] AND [loom:gate-failed] nudges also inline `headWarning` when it's set, so an " +
            "async-settled gate's HEAD-currency signal reaches you the same way the sync result does. If you " +
            "missed the nudge or need to re-check after the fact, `gate_status(opId)` on a SETTLED op now " +
            "returns this SAME verdict (passed/reason/durationMs/steps/outputTail/gateDetail) directly — see " +
            "its own tool description; it's a recovery path, not a substitute for waiting on the nudge. " +
            "CLIENT-TIMEOUT " +
            "RESILIENT, same shape as worker_merge_confirm: a fast run returns the full " +
            "result inline (stamped with a correlation `opId`); a genuinely slow one (a real multi-minute test " +
            "suite) instead returns {opId, status:\"pending\", attachedToInFlight, staleAgainstWorktree}. " +
            "DO NOT POLL OR RE-CALL TO FETCH THE RESULT — worker_report progress with awaiting:\"background\" " +
            "and END YOUR TURN; the [loom:gate-done]/[loom:gate-failed] nudge (carrying this SAME opId) starts " +
            "your next turn with the result. A re-call IS still safe and well-defined, just not how you fetch a " +
            "result: while the gate is still running, a re-call attaches to that SAME run (attachedToInFlight:" +
            "true) instead of starting a second one — `staleAgainstWorktree:true` on that reply means the " +
            "worktree changed (a new commit or an uncommitted edit) since THAT run started, so trust nothing it " +
            "reports about your current code. Within a short grace window AFTER a run settles, a re-call is " +
            "USUALLY served that SAME settled result (same opId) instead of starting a fresh run — EXCEPT when " +
            "that settled result itself already carries `headCurrent:false` (the worktree moved WHILE the gate " +
            "was running): a KNOWN-CONTAMINATED result is never re-served — a re-call in that case always starts " +
            "a genuinely new run against your current tree, same as outside the window. CAVEAT on an ordinarily- " +
            "served settled-window reply: it is NOT re-checked against your worktree's current state — you can " +
            "still tell if the commit changed by comparing its `validatedHead` to your own HEAD, but an " +
            "UNCOMMITTED edit you make AFTER an already-clean settle, before your re-call, is invisible to it. " +
            "If you've edited since the last run_gate call, don't trust a cached pass — wait out the grace " +
            "window (or just act on your own judgment) before treating it as current.",
          inputSchema: strictShape({}),
        },
        async () => {
          try {
            const r = await sessions.runWorkerGate(sessionId);
            if (!r.settled) {
              const staleWarning = r.staleAgainstWorktree
                ? " WARNING: staleAgainstWorktree is true — your worktree has changed since this run started, so do not trust its outcome for your current code."
                : "";
              return ok({
                opId: r.op.opId, status: "pending", attachedToInFlight: r.attachedToInFlight, staleAgainstWorktree: r.staleAgainstWorktree,
                note: `gate still running.${staleWarning} Do NOT poll or re-call to fetch the result — worker_report progress with awaiting:"background" and END your turn; the [loom:gate-done]/[loom:gate-failed] nudge starts your next turn with the result.`,
              });
            }
            if (!r.ok) return ok({ error: r.error instanceof Error ? r.error.message : String(r.error) });
            return ok(r.value);
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
      registerGateStatus(server, sessions, sessionId, () => db.getSession(sessionId)?.projectId);
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
      server.registerTool(
        "directive_status",
        {
          description:
            "Read your OWN durable delivery history — the mechanical complement to the visible " +
            "`[loom:possible-duplicate root:XXXXXXXX]` tag (card 78e4b3f2). Scoped server-side to YOUR " +
            "session only (there is no session/worker parameter): reads YOUR OWN recycle lineage (this " +
            "session plus any predecessor it was recycled from) and nothing else — never another worker, " +
            "another project, or message TEXT. " +
            "Call with NO argument to see your most recent known deliveries across every root in your " +
            "lineage (bounded to the 20 most recent — `truncated:true` means older ones exist; call with " +
            "`root` for one label's complete history). Call with `root` set to the exact 8 lowercase-hex " +
            "characters copied verbatim from a duplicate-tag you just received to filter to that one label. " +
            "A malformed `root` (not 8 hex chars) returns `{error}` — distinguishable from a well-formed " +
            "root that legitimately has zero matches, never silently identical to it. " +
            "Returns `{deliveries, deliveryCount, currentTurnSeq, truncated}`. Each entry in `deliveries` " +
            "is a DURABLE, TURN-CONFIRMED hand-off (never a merely-queued or parked attempt, those carry no " +
            "signal about what you've seen) with fields: `root` (the label it matched); `at` (when this " +
            "hand-off/confirmation was recorded); `msgId` (the internal id of the specific hop that actually " +
            "delivered — NOT necessarily the id printed in the tag you saw, which names the CHAIN's root, " +
            "not this particular hop); `turnSeq` (see below); `fromSession` (the session that actually SENT " +
            "it — a manager, another session, or occasionally empty for a system-originated redirect); " +
            "`receivedBy` (which session in YOUR OWN lineage took the hand-off — this session, OR a " +
            "predecessor you were recycled from; it is NOT always you, and a value other than your own " +
            "current session id is exactly the recycle-boundary case: a predecessor of yours received this, " +
            "not you personally, but it is still genuinely part of your own history). " +
            "HAVE-I-SEEN-THIS-BEFORE, mechanically: compare each entry's `turnSeq` against the `currentTurnSeq` " +
            "this same reply carries — `turnSeq < currentTurnSeq` means that delivery happened in an EARLIER " +
            "turn than this one. `turnSeq` is `null` on a `confirmed-after-park` entry (Loom's own retry " +
            "budget gave up before a hand-off was cleanly stamped, and a late independent signal proved the " +
            "engine ran it anyway) — its presence is still a genuine, durably-recorded delivery, but the " +
            "turnSeq-comparison technique above does not apply to it: Loom cannot mechanically place it " +
            "relative to your current turn. Treat it as evidence you may have seen this content before, not " +
            "as proof it was an EARLIER turn specifically. " +
            "`deliveryCount === 0` is a legitimate, expected answer: despite the tag you may have seen, " +
            "Loom's own durable history shows no record of this content having reached any of your turns " +
            "before — the sender-side 'possible duplicate' framing was a false alarm for this instance. " +
            "KNOWN LIMITATION: matching is by the 8-character LABEL you see in the tag, not by the full " +
            "internal id the label is derived from — an extremely rare label collision could in principle " +
            "merge two unrelated messages' history into one answer. " +
            "THE ONE THING THIS CANNOT TELL YOU: whether you actually ACTED on a prior delivery — only that " +
            "the text reached one of your turns. Delivery is recorded; action is not. Use your own " +
            "transcript/memory to judge whether you already acted on it.",
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
      // The worker's tested depth-1 surface is now EXACTLY { directive_status, gate_queue, gate_status,
      // my_context, run_gate, worker_report } — my-context-gate.mjs, idle-report.mjs, inbox-pull.mjs,
      // gate-queue.mjs, mgmt-surface.mjs, and (indirectly, via ORCH_WORKER_TOOLS in agents/promptLint.ts)
      // orch-scope.mjs all pin this sorted list; update ALL of them if this surface ever changes again.
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

    // Additive "reported / awaiting-review" projection (read-only — never touches report DELIVERY).
    // A worker that called worker_report(done|blocked) ends its turn and sits at busy:false —
    // indistinguishable in the raw session record from a plain idle-live worker. Derive it from the
    // worker's orchestration_events so a manager can SEE "reported, awaiting review" in
    // worker_status/worker_list without reading the transcript.
    //
    // Card 6641c3ab (fix): find this worker's MOST-RECENT `worker_report` event (any status — a LATER
    // worker_report(progress) after a done/blocked one correctly means "not awaiting" here, same as
    // before). If its status isn't done/blocked, nothing is awaiting. Otherwise, "still awaiting" iff NO
    // event in REPORT_RESOLVED_EVENT_KINDS (see its own doc — an ALLOWLIST, not a denylist, and why)
    // landed strictly after that report. This REPLACES the old "is the chronological LAST event of ANY
    // kind a worker_report" check — that check went null the instant ANY later worker-keyed row landed,
    // including a `merge_request` fired by a manager merely reviewing the diff (`worker_merge`) before
    // ever deciding whether to merge — the actual cause of this card's false negatives on a LIVE,
    // unmerged, never-messaged worker. reportedState carries the live state when awaiting, else null
    // (kept consistent with awaitingReview so a non-null reportedState always means "waiting on my
    // review right now").
    const reportedProjection = (workerSessionId: string): {
      reportedState: "done" | "blocked" | null;
      awaitingReview: boolean;
    } => {
      const events = db.listEventsForWorker(workerSessionId); // chronological (ts, rowid)
      let lastReportIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.kind === "worker_report") { lastReportIdx = i; break; }
      }
      if (lastReportIdx === -1) return { reportedState: null, awaitingReview: false };
      const status = events[lastReportIdx]!.detail?.status as string | undefined;
      if (status !== "done" && status !== "blocked") return { reportedState: null, awaitingReview: false };
      const resolvedSince = events.slice(lastReportIdx + 1).some((e) => REPORT_RESOLVED_EVENT_KINDS.has(e.kind));
      return resolvedSince
        ? { reportedState: null, awaitingReview: false }
        : { reportedState: status, awaitingReview: true };
    };

    // Card 343441bd: "delivered vs. apparently acted upon" — a manager-facing signal, distinct from the
    // synchronous `{delivered:true}` a worker_message call returns, which only proves the text was
    // submitted-or-durably-queued (see the card body's `39cbe5b5` incident: that receipt was truthful and
    // useless — the fix-pass it described was never executed, and the manager only found out by grepping
    // the branch HEAD). PULL, not a nudge (deliberately no watchdog here — see the card's own steer against
    // reintroducing a false-alarm nudge class, `a4bfe6d9`→`8e0bd254`): a sibling of reportedProjection,
    // read only when a manager actually looks at worker_list/worker_status.
    //
    // "Acknowledged" = the worker's next worker_report (ANY status) with a `ts` after the directive's
    // recorded HAND-OFF (see the `deliveryState`/hand-off-vs-confirmation caveat below — "delivery" here
    // means the recorded hand-off point, not an engine-confirmed receipt) — the cheapest of the card's own
    // candidate definitions, deliberately NOT a semantic match against the directive's text. Only applies
    // to the `delivered` outcome below — see Card 9da2a435's note on why a `parked` outcome can NEVER be
    // acknowledged this way. Scoped to the LATEST `message_worker` OR `redirect_worker` event (mirrors
    // reportedProjection's own "latest wins" scan, now widened across both kinds — card 0fbb0507). Before
    // that widening this was `worker_message` ONLY; `worker_redirect` already carried a correlatable
    // `queuedMsgId` on its held path (card 02621025) and the widening was deliberately deferred to keep
    // 9da2a435 minimal — see staleDirectiveProjection's own doc below for how the two kinds correlate.
    //
    // turnSeqAtDelivery was stamped by messageWorker (immediate delivery) or resolveQueuedMessage (held —
    // stamped at HAND-OFF, never at enqueue); see both call sites' docs. A directive still sitting in the
    // queue (held, not yet delivered) has no turnSeqAtDelivery anywhere yet — nothing to judge staleness
    // against, so it reads as null exactly like an acknowledged one.
    //
    // Card 9da2a435: hand-off is NOT confirmed delivery (see enqueueStdin's EnqueueResult doc) — a submit
    // that hands off optimistically can still GIVE UP asynchronously, and `handleGiveUpExhausted`
    // (sessions/service.ts) either re-mints it under a FRESH msgId (chainDepth+1) or terminally PARKS it,
    // appending a `session_message_gave_up` event either way. The OLD version of this function never
    // looked for that event: a parked directive never gets a worker_report (nothing was ever handed to the
    // worker to act on) AND never advances the worker's own turnSeq (no turn ran), so `turnsSinceDelivery`
    // stayed 0 forever and `staleDirective` read `null` — indistinguishable from "recently delivered, no
    // problem yet". `resolveDirectiveOutcome` walks the give-up chain first so a parked directive is
    // reported as parked, never silently as "no signal". Card 35c96aa6: hoisted to MODULE scope (was a
    // closure-local `const` here) so the worker-facing `directive_status` tool can call the SAME chain
    // walk instead of reimplementing it — this call site is unchanged, only where the function lives moved.

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
      const events = db.listEventsForWorker(workerSessionId);
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
    const selfHealWorkerLink = (workerSessionId: string, op: string) => {
      const w = db.getSession(workerSessionId);
      if (!w || w.parentSessionId === managerSessionId) return w; // no row, or already correctly linked
      if (!workerReadableByManager(w)) return w; // genuinely not this manager's lineage — leave it to the "not your worker" guard
      console.warn(
        `[orchestration] worker/manager parent desync self-healed: op=${op} worker=${workerSessionId} ` +
        `managerSessionId(closure)=${managerSessionId} row.parentSessionId=${w.parentSessionId ?? "null"}`,
      );
      db.relinkWorkerToManager(w.id, managerSessionId);
      return { ...w, parentSessionId: managerSessionId };
    };

    // The fleet view — the manager's direct children as a compact list. Shared by worker_list and the
    // no-arg worker_status call (a manager's reflexive `worker_status({})` aliases to this rather than
    // throwing a schema-validation error).
    //
    // CLIENT-TIMEOUT RESILIENCE (card fb8df559 Part 1): each real worker row gains a `pendingMerge`
    // field (non-null while a worker_merge_confirm for it is still running its gate, and briefly after it
    // settles — see PendingOpRegistry's "RETAINED TERMINAL VIEW" doc, card d1aee5f1 follow-up) — read-only,
    // never consumed by this view. worker_list's TOP-LEVEL shape stays a BARE ARRAY (no breaking change): a
    // pending worker_spawn has no worker row yet (inserted only once createWorktree resolves), so it's
    // appended as an ADDITIVE PLACEHOLDER row instead — `workerSessionId:null`, `pendingSpawn` set,
    // `processState:"starting"`, `reportedState:null`, `awaitingReview:false`, so an existing "count live
    // workers" / "find one awaiting review" consumer skips it rather than miscounting a phantom worker.
    //
    // `rateLimitedUntil`/`rateLimitDeadline` (card b16320bc): additive — a non-limited worker's row is
    // otherwise unchanged, both fields simply read null. Without this, a worker parked on a usage cap
    // (§19c — detectUsageLimit's StopFailure signal, or the weekly/account TEXT-sentinel fallback in
    // pty/host.ts) showed as plain `busy:false` here, indistinguishable from a healthy idle worker; a
    // manager had to worker_status(id) — or read the transcript — to discover the park. worker_status(id)
    // already surfaced both fields (it returns the full session record), so this closes the SAME gap for
    // the fleet view without adding a new field/scanner.
    //
    // `lastEngineOutputAt`: an INTRA-TURN liveness signal, additive alongside the DB-persisted
    // `lastActivity` (which only moves at turn boundaries — hook events). Reads pty/host.ts's in-memory
    // `Live.lastOutputAt`, stamped on EVERY engine-output chunk (already fed to the busy-stale self-heal —
    // see healIfStuck) — so it keeps advancing THROUGH a single long turn and only goes stale once the
    // engine truly stops producing. Lets a manager tell "busy and emitting" (recent) from "silent, possibly
    // wedged" (stale) at a glance, without spending a worker_transcript pull.
    //
    // WHAT IT DOES NOT PROVE (card docs(orchestration): lastEngineOutputAt's description over-claims
    // progress): liveness is a property of the PROCESS, not the WORK — a retry loop, or a worker
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
    // `composerDirtyLen` (card dcd8659c): a PULL read of `Live.composerDirtyLen` (pty/host.ts, card
    // 3ce3fa39) — a count of characters possibly still sitting UNSUBMITTED in this worker's composer from
    // an earlier delivery whose confirmation never arrived. Same getter shape as `lastEngineOutputAt`
    // above (`pty?.getComposerDirtyLen(id) ?? null`) — read-only, never touches submit()/enqueueStdin/
    // drainPending/the pty. SET synchronously the moment a give-up/heal-if-stuck fires (no dependency on
    // any later write), so it stays non-zero and readable indefinitely when nothing further ever arrives —
    // exactly the stuck case this exists to catch, not just the case where a later write happens to
    // surface it. `0` means the composer is genuinely clean; `null` means this session isn't live in this
    // process — never conflate the two (an absent signal read as a measured zero is the bug this card
    // closes). WHAT THIS DOES NOT COVER: a MANAGER's own composer going dirty mid-session (no third-party
    // read surface reaches a manager the way this reaches its workers — see `my_context`, which folds in
    // the same getter for self-checking), and a human glancing at the web UI (no REST/web surface exists
    // yet — unscoped, deliberately left as a follow-up card rather than bundled here).
    const fleetView = async () => {
      const workers = db.listWorkers(managerSessionId).map((w) => ({
        workerSessionId: w.id,
        taskId: w.taskId ?? null,
        processState: w.processState,
        busy: w.busy,
        branch: w.branch ?? null,
        ctxInputTokens: w.ctxInputTokens ?? null,
        neverCompletedTurn: (w.turnSeq ?? 0) === 0,
        model: w.model ?? null,
        lastActivity: w.lastActivity,
        lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
        composerDirtyLen: pty?.getComposerDirtyLen(w.id) ?? null,
        unconfirmedDeliveryMs: pty?.getPendingConfirmMs(w.id) ?? null,
        pendingMerge: sessions.peekPendingMerge(w.id) ?? null,
        rateLimitedUntil: w.rateLimitedUntil ?? null,
        rateLimitDeadline: w.rateLimitDeadline ?? null,
        ...reportedProjection(w.id),
        ...staleDirectiveProjection(w.id, w.turnSeq ?? 0),
        ...archivedWithoutReport(w.id),
      }));
      const pendingSpawns = sessions.listPendingSpawns(managerSessionId).map((op) => ({
        workerSessionId: null,
        taskId: op.taskId,
        processState: "starting" as const,
        busy: false,
        branch: null,
        ctxInputTokens: null,
        neverCompletedTurn: true,
        model: null,
        lastActivity: op.startedAt,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        unconfirmedDeliveryMs: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        pendingSpawn: { opId: op.opId, startedAt: op.startedAt },
        reportedState: null,
        awaitingReview: false,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
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
        neverCompletedTurn: true,
        model: null,
        lastActivity: e.queuedAt,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        unconfirmedDeliveryMs: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        capQueued: { opId: e.opId, agentId: e.agentId, taskId: e.taskId, kickoffLabel: e.kickoffLabel, queuedAt: e.queuedAt },
        reportedState: null,
        awaitingReview: false,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
        archivedWithoutReport: false,
      }));
      // Archived-without-report workers (card ae0b7891): the archived counterpart to the three
      // categories above — a worker that genuinely vanished (exited without ever calling worker_report)
      // instead of silently disappearing from the fleet view once archiveOnExit stamps archivedAt.
      // listWorkerSessionIdsWithEventKind is the existing "which sessions ever had event kind X" lookup
      // (built for the crash-recovery watcher, already indexed) — reused here rather than adding a new
      // SQL join. Bounded/self-clearing: isArchivedWithoutReport re-checks live, so this only ever holds
      // workers still worth the manager's attention (see its own doc for why).
      //
      // LINEAGE, not exact parent match (card 93609ef3's own reasoning applies verbatim here): an
      // archived-without-report worker is by definition exited and was never re-parented by
      // reparentLiveWorkers (which only moves LIVE workers on recycle), so after a manager recycle it
      // keeps parentSessionId pointing at the now-retired predecessor. An exact match would silently
      // hide it from the successor manager — exactly the finding this category exists to surface. Unlike
      // the real `workers` list above (deliberately exact-match, per workerReadableByManager's own doc),
      // this NEW category has no such precedent to preserve, so it uses the lineage-tolerant read guard.
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
          neverCompletedTurn: (w.turnSeq ?? 0) === 0,
          model: w.model ?? null,
          lastActivity: w.lastActivity,
          lastEngineOutputAt: null,
          composerDirtyLen: null,
          unconfirmedDeliveryMs: null,
          pendingMerge: null,
          rateLimitedUntil: null,
          rateLimitDeadline: null,
          reportedState: null,
          awaitingReview: false,
          directive: { msgId: null, state: "none" as const, at: null },
          staleDirective: null,
          parkedDirective: null,
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
        neverCompletedTurn: null,
        model: null,
        lastActivity: d.lastActivity,
        lastEngineOutputAt: null,
        composerDirtyLen: null,
        unconfirmedDeliveryMs: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        reportedState: null,
        awaitingReview: false,
        directive: { msgId: null, state: "none" as const, at: null },
        staleDirective: null,
        parkedDirective: null,
        archivedWithoutReport: false,
        worktreePath: d.worktreePath,
      }));
      return [...workers, ...pendingSpawns, ...capQueued, ...archivedUnreported, ...dangling];
    };

    server.registerTool(
      "worker_list",
      { description: "List the workers you (this manager) have spawned — your direct children. `directive` (`{msgId, state, at}`, state one of `\"none\"|\"pending\"|\"delivered\"|\"parked\"|\"confirmed-after-park\"`) is your MOST RECENT worker_message OR worker_redirect's raw resolved state (whichever you sent most recently), always keyed to the msgId YOU got back — `\"none\"` means you've never messaged or redirected this worker; `\"pending\"` means it's still queued or Loom is still retrying its redelivery internally, not yet resolved either way; `\"delivered\"`/`\"parked\"` are explained by `staleDirective`/`parkedDirective` below, which are derived ALARM flags layered on top of this same state (read those for the \"is something wrong\" signal; read `directive` when you need the raw state, e.g. to tell a fresh `\"pending\"` apart from a worker you've simply never messaged). `staleDirective` (non-null: `{msgId, deliveredAt, turnsSinceDelivery}`) flags a worker_message OR worker_redirect directive that was DELIVERED but has no worker_report since — distinct from the `{delivered:true}` worker_message/worker_redirect itself returns, which only proves the text was HANDED OFF as a turn attempt (or durably queued), never that the engine confirmed it or that it was acted on — see worker_message's own docs for why `delivered:true` is not a delivery guarantee. Fires only once the worker has completed several of its OWN real turns with no report at all since delivery (never on a single long-running turn, however long); clears the instant any worker_report lands, or once you send a newer worker_message OR worker_redirect (tracking always follows your MOST RECENT directive of EITHER kind — a `worker_redirect` is tracked the same way a `worker_message` is, INCLUDING going stale/parked, on BOTH its held and immediately-delivered paths; see worker_redirect's own docs). `parkedDirective` (non-null: `{msgId, parkedAt}`) is the THIRD state alongside `staleDirective` — a directive Loom gave up REDELIVERING entirely: your worker_message's (or a worker_redirect's, on either path — held or immediately-delivered, see worker_redirect's own docs) hand-off never confirmed, Loom retried it internally (in-session, then across several re-mint attempts) and exhausted its budget, so it PARKED — a PARK is NOT proof the directive was never received: the engine can confirm a write minutes late under load, so the original may still land on its own; `directive.state` MAY still resolve to `\"confirmed-after-park\"` (below) if a late confirming hook proves that, but that resolution is not guaranteed even when the directive genuinely did land, so its absence is NOT evidence the directive failed (card 085d9422, relocated here from the `[loom:redelivery-parked]` notice, which used to spell this hedge out per-event) — this is the case `staleDirective` alone cannot see (a parked directive never reaches the worker, so the worker's own turnSeq never advances and `staleDirective` would otherwise read `null` forever, indistinguishable from \"nothing wrong\"). Mutually exclusive with `staleDirective` (a directive is either delivered-but-unacknowledged, or never-actually-delivered). ⚠️ STICKY, unlike `staleDirective`: a `worker_report` does NOT clear it — the text never reached the worker, so nothing the worker reports can be an acknowledgement of it. It clears the same way `directive` itself moves on — once you send a NEWER worker_message OR worker_redirect — OR on its own, the instant a LATE confirming hook proves the original hand-off actually ran (Loom's own retry budget can give up minutes before the engine does — see memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`): that shows up as `directive.state:\"confirmed-after-park\"` with `parkedDirective` back to `null` — a DIFFERENT, decidable resolution from a still-genuinely-parked directive, checkable by simply re-calling this tool later, no notice required. ⛔ On a directive that is STILL `parkedDirective` (not `confirmed-after-park`), RE-SEND — Loom will not retry it for you; but if you see `directive.state:\"confirmed-after-park\"`, do NOT resend — the original already landed and a resend would create a real duplicate turn. `reportedState` (done|blocked|null) + `awaitingReview` flag a worker that has called worker_report and is sitting idle awaiting your review (cleared once you worker_message/worker_redirect it, it's recycled or stopped, or its merge actually COMPLETES — merely reviewing its diff with worker_merge, or a rejected/cancelled merge, does NOT clear this; the worker is still awaiting your decision). `archivedWithoutReport:true` flags a worker whose pty EXITED WITHOUT EVER CALLING worker_report — it no longer counts against your concurrency cap, but it did NOT silently vanish: this row is a distinct ADDITIVE category (a real worker row, `processState` reflects its actual exit state) that appears ONLY for a genuinely-unreported strand, never for a worker that reported (even `noChanges`) and cleanly auto-retired — pull `worker_transcript` to see what it did, then `worker_merge` to review/merge any committed work, or re-dispatch the task. It clears on its own once you resolve it (move the task off its active lane, or spawn/recycle a successor). `pendingMerge` (non-null) on a row means a worker_merge_confirm for it is either still in flight (`state:\"running\"` — poll the read-only `gate_status(opId)`, which never starts a new run, or watch here) OR has JUST settled (`state:\"done\"|\"failed\"` with an `outcome` of `\"merged\"|\"rejected\"|\"cancelled\"|\"failed\"` — a brief, COSMETIC display of the terminal result, visible here for only a few seconds after settling; it reverting to `null` does NOT mean the verdict is forgotten, see below). Once `state` is no longer `\"running\"` the merge is ALREADY DONE — read `outcome` here directly, no need to re-call worker_merge_confirm just to learn it. Re-calling worker_merge_confirm for a settled merge is ALWAYS SAFE, at ANY delay — seconds, minutes, or hours, long after this row has reverted to `null` — because the verdict is cached separately from this display window: at the SAME commit it returns that SAME cached verdict; if the branch has picked up new commits since, it gates them for real instead — a different question, never a silent re-run of the SAME question. The ONLY way to force a genuine RE-RUN of the SAME commit (e.g. retrying a flake, or completing a nested-repo worktree cleanup) is `forceRemoveWorktree:true` on the re-call — name it explicitly: it is the deliberate retry escalation, not merely a worktree-cleanup option, and it always runs for real. `rateLimitedUntil`/`rateLimitDeadline` (non-null) mean the worker is PARKED ON A USAGE CAP — busy will read false but this is NOT a healthy idle worker; it resumes on its own once `rateLimitedUntil` passes (`rateLimitDeadline` is the give-up horizon). `lastEngineOutputAt` is an INTRA-TURN liveness signal, distinct from `lastActivity` (which only moves at turn boundaries): it advances on every chunk of engine output, so it keeps moving THROUGH a single long turn — a recent `lastEngineOutputAt` on a `busy:true` row means the engine is alive and emitting; a stale one means it may be wedged. LIVENESS is not CONVERGENCE: a retry loop, or a worker re-reading the same file, emits just as steadily as real work, so recent output alone never proves progress. `lastActivity` advancing (a turn boundary crossed) is the strongest signal this row carries toward that — a wedged turn cannot complete — though a loop spanning several turns still crosses boundaries normally, so it only clears the turn that just ended. For actual progress, order your checks by WHICH CASE EACH ONE CAN ACTUALLY ANSWER, not by cost — a cheap check that silently fails on the hard case is worse than no check, because it still hands back an answer. Lead with a `worker_transcript` pull and look for a NAMED, distinct artifact — output, a file, a result that could not exist unless the new work actually ran; the same shape repeated with only an index/timestamp changed is not progress. This is the ONLY one of the three checks here that still works on a worker that has never completed a turn — precisely the class where \"is it progressing?\" gets asked most urgently (card 8d1abb7a). `ctxInputTokens` climbing across two reads and `git log`/`git status` on its branch are real signals once a worker is past that point, but BOTH return FALSE NEGATIVES on a never-completed-turn worker, and neither says so on its face: `ctxInputTokens` reads `null` until a turn actually completes (see `neverCompletedTurn` below — that null is a decidable, EXPECTED state on such a worker, never a sign of trouble), and a healthy worker deep in a long first turn legitimately shows a byte-identical `git status`/`--numstat` across samples minutes apart, because nothing has landed yet — flat means \"no commit yet,\" never \"stalled.\" Check `neverCompletedTurn` first: while it's `true`, only the transcript-artifact check can discriminate; once it's `false`, all three are meaningful and the cheaper two are fine to lead with. `neverCompletedTurn` (`true` when this worker's `turnSeq` is still 0 — it has not finished a single turn yet) is what makes `ctxInputTokens: null` decidable instead of a bare null a reader might mistake for a broken measurement: `true` means \"expected, no data yet, absence is not bad news\"; `false` alongside a still-`null` `ctxInputTokens` would itself be the anomalous case worth investigating, not the routine one. `null` on the `\"dangling\"` placeholder row means not tracked (that worker is already stopped, not mid-turn). Never read `ctxInputTokens: null` as a measured `0` — it isn't occupancy, it's absence of a measurement. `composerDirtyLen` is a count of characters possibly still sitting UNSUBMITTED in this worker's composer from an earlier delivery that never confirmed (null when not live in this process; 0 means genuinely clean, NOT unknown — never read an absent signal as a measured zero) — SET synchronously the moment a give-up/heal fires, so it stays non-zero and readable even when nothing further ever arrives (the exact stuck case this exists to catch); CLEARED only once a SUBSEQUENT delivery attempt goes on to confirm. A non-zero value with a stalled `lastActivity`/`lastEngineOutputAt` is a strong signal this worker's last message never actually reached it — a `worker_message` re-nudge (which itself lands in the composer) will not fix a truly stuck one; see memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` for the fuller failure picture and recovery guidance. `null` means the session isn't live in this daemon process. `unconfirmedDeliveryMs` (card a33a72f7) is an EARLIER signal than `composerDirtyLen`: milliseconds since this worker's CURRENT generation's Enter was written, for as long as it stays unconfirmed by a hook — non-null the INSTANT a write is outstanding, with no dependency on `composerDirtyLen`'s own give-up/heal budget (30s-plus) ever firing; `null` means nothing is currently outstanding (never submitted, or already confirmed) or the session isn't live. It does NOT distinguish 'still within Loom's own retry budget' from 'Loom already gave up on this exact generation, outcome still unknown' — a give-up never resets it. Read it together with `composerDirtyLen`: zero there while this is non-null means genuinely in-flight and never given up (the one case this adds unambiguous new information); non-zero there is ambiguous either way (may be this generation's own give-up, or stale residue from an earlier superseded one still awaiting its confirm-driven clear). A worker_spawn still running past the sync-wait budget shows up as an ADDITIVE placeholder row: `workerSessionId:null`, `pendingSpawn:{opId,startedAt}`, `processState:\"starting\"` — not a real worker yet, so don't count it as live or awaiting review; poll here or re-call worker_spawn (same taskId/agentId/kickoffPrompt) to fetch the result. A worker_spawn REJECTED outright because the concurrency cap was full ALSO shows up as an ADDITIVE placeholder row — distinct from the pending one above: `workerSessionId:null`, `processState:\"cap-queued\"`, `capQueued:{opId,agentId,taskId,kickoffLabel,queuedAt}` — the intent never started at all. It AUTO-FIRES on its own (FIFO — oldest queued first) the next time a concurrency slot on this manager actually frees, with no re-call needed; you can still re-`worker_spawn` the same taskId/agentId by hand if you don't want to wait, which clears the marker the same way it always did. If an auto-fire attempt itself fails for a real reason (its task went terminal/held, its worktree couldn't be created, …) you get a `[loom:cap-queue-autofire-failed]` message naming the opId/task/agent — the entry is dropped at that point and needs a fresh worker_spawn. To withdraw a queued entry BEFORE it fires, call `worker_stop({opId})` (see worker_stop's own docs) — it never auto-dispatches after that. A STOPPED (archived) worker whose branch/worktree still holds unmerged work (card ba41b402) ALSO shows up as an ADDITIVE placeholder row: `processState:\"dangling\"`, `worktreePath` set (a field no other row carries) — this is a REAL past worker (`workerSessionId` is its actual id, not null), surfaced because its bound task has no recorded merge yet (or, for a taskless worker, its branch carries at least one commit not on the mainline) — content-based, not branch-existence-based, so a branch whose work already shipped under a different name/fix never appears here. It is purely observational (nothing here deletes or merges anything); pull `worker_transcript`/`git log` on its branch to see what it holds, then `worker_merge_confirm` or re-dispatch as you would any other unmerged work. Never count any of the three placeholders (`\"starting\"`, `\"cap-queued\"`, `\"dangling\"`) as live or awaiting review.", inputSchema: strictShape({}) },
      async () => ok(await fleetView()),
    );

    server.registerTool(
      "worker_status",
      {
        description: "Get the full session record for one of your workers, by workerSessionId. Includes the derived `reportedState` (done|blocked|null) + `awaitingReview` flag — set when the worker has called worker_report and is idle awaiting your review, cleared once you worker_message/worker_redirect it, it's recycled or stopped, or its merge actually COMPLETES (merely reviewing its diff with worker_merge, or a rejected/cancelled merge, does NOT clear this). Also includes `neverCompletedTurn` (see worker_list) — `true` while this worker's `turnSeq` is still 0 (it has not finished a single turn yet), which makes a `null` `ctxInputTokens` decidable (\"no data yet\", not a broken measurement) instead of a bare, ambiguous null. Also includes `archivedWithoutReport` (see worker_list) — true only when this worker's pty EXITED WITHOUT EVER CALLING worker_report and the strand is still unresolved; NEVER true for a worker that reported (even `noChanges`) and cleanly auto-retired. Also includes `directive` (see worker_list) — your most recent worker_message OR worker_redirect's raw resolved state (`\"none\"|\"pending\"|\"delivered\"|\"parked\"|\"confirmed-after-park\"`), whichever you sent most recently. Also includes `staleDirective` (see worker_list) — a delivered worker_message or worker_redirect with no worker_report since, once several of the worker's own real turns have passed with no report. Also includes `parkedDirective` (see worker_list) — a worker_message or HELD worker_redirect Loom gave up redelivering entirely (exhausted its internal retry/re-mint budget with no confirmed hand-off); mutually exclusive with `staleDirective`, STICKY (a worker_report does NOT clear it — only a newer worker_message or worker_redirect does — OR a late confirming hook resolving it to `directive.state:\"confirmed-after-park\"`, see worker_list's own docs for that third state), and the signal that catches a directive that never reached the worker at all — re-send it, UNLESS `directive.state` already reads `\"confirmed-after-park\"`, in which case the original landed and resending would duplicate it. (A worker_redirect is tracked this way on either delivery path — held or immediately-delivered; see worker_redirect's own docs.) Also includes `lastEngineOutputAt`, the intra-turn liveness signal (see worker_list) — recent means the engine is alive and emitting, stale means it may be wedged; neither proves the work is actually converging (see worker_list for why, and what to check instead). Also includes `composerDirtyLen` (see worker_list) — a count of characters possibly still sitting UNSUBMITTED in this worker's composer from an earlier delivery that never confirmed; null when not live in this process, 0 means genuinely clean (never read an absent signal as a measured zero). Also includes `unconfirmedDeliveryMs` (see worker_list) — an EARLIER signal than `composerDirtyLen`: milliseconds since this worker's current generation's Enter was written, for as long as it stays unconfirmed by a hook; non-null the instant a write is outstanding, unlike `composerDirtyLen` which needs a give-up/heal to actually fire first. Does NOT by itself distinguish still-retrying from already-gave-up-outcome-unknown — cross-check `composerDirtyLen` (see worker_list for the full reading guide). Called with NO workerSessionId, it returns the fleet view (same as worker_list) so a reflexive no-arg call just works. OPTIONAL `msgId`: `directive`/`staleDirective`/`parkedDirective` above only ever track your MOST RECENT worker_message/worker_redirect to this worker — the instant you send a newer one, an OLDER directive's own resolution becomes invisible there even though it keeps resolving on its own. Pass the ROOT msgId a PRIOR worker_message/worker_redirect call returned to you (never a re-mint id — you were never handed one) to get `queriedDirective: {msgId, found, state, at}` for THAT SPECIFIC directive regardless of what you've sent since: `found:false` means this worker has no record of that root msgId at all; `found:true` gives its own `state` (`\"pending\"|\"delivered\"|\"parked\"|\"confirmed-after-park\"`) independent of the tracked `directive` field. This is the per-message consumed/not-consumed read — check a specific earlier directive before treating a `parked` notice about it as a reason to recycle or re-spawn, even after you've since sent something newer to the same worker.",
        inputSchema: strictShape({ workerSessionId: z.string().optional(), msgId: z.string().optional() }),
      },
      async ({ workerSessionId, msgId }) => {
        // No id → fleet view (alias worker_list), so worker_status({}) never throws a schema error.
        if (!workerSessionId) return ok(await fleetView());
        const w = selfHealWorkerLink(workerSessionId, "worker_status");
        if (!w || !workerReadableByManager(w)) return ok({ error: "not your worker" });
        return ok({
          ...w,
          neverCompletedTurn: (w.turnSeq ?? 0) === 0,
          lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
          composerDirtyLen: pty?.getComposerDirtyLen(w.id) ?? null,
          unconfirmedDeliveryMs: pty?.getPendingConfirmMs(w.id) ?? null,
          pendingMerge: sessions.peekPendingMerge(w.id) ?? null,
          ...reportedProjection(w.id),
          ...staleDirectiveProjection(w.id, w.turnSeq ?? 0),
          ...archivedWithoutReport(w.id),
          ...(msgId ? { queriedDirective: directiveByMsgId(db.listEventsForWorker(w.id), msgId) } : {}),
        });
      },
    );

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
          "browser_snapshot calls landing in one message) — when that happens `turns` is REPLACED by " +
          "{turnsFile, turnsChars, note} pointing at a scratch file instead (any page envelope fields " +
          "stay inline). The file is PLAIN TEXT (not JSON) — one '=== turn N [role] ===' section per " +
          "turn, real line breaks, UTF-8 — so a tool result's own multi-line content (e.g. YAML) is " +
          "genuinely grep-able and Read-pageable (offset/limit are LINE-based there). Re-call with a " +
          "narrower turnRange/limit/lastN to try to get it back inline instead.",
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
        if (!w || !workerReadableByManager(w)) return ok({ error: "not your worker" });
        const turns = w.engineSessionId ? readTranscript(w.cwd, w.engineSessionId) : [];
        if (typeof lastN === "number" && lastN > 0) {
          return ok(spillableTurnsResponse(managerSessionId, `${workerSessionId}-lastN`, lastNTurns(turns, lastN), null));
        }
        const page = pageTranscript(turns, { offset, limit, turnRange });
        const explicit = offset !== undefined || limit !== undefined || turnRange !== undefined;
        if (!explicit && page.offset === 0 && page.nextOffset === null) {
          return ok(spillableTurnsResponse(managerSessionId, `${workerSessionId}-0`, page.turns, null));
        }
        const bounded = w.engineSessionId ? applyAggregateWalkCap(w.engineSessionId, page.offset, page) : page;
        const { turns: boundedTurns, ...meta } = bounded;
        return ok(spillableTurnsResponse(managerSessionId, `${workerSessionId}-${bounded.offset}`, boundedTurns, meta));
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

    server.registerTool(
      "worker_spawn",
      {
        description: "Spawn a worker: creates an isolated git worktree + branch and starts a worker session in it. kickoffPrompt is the canonical param for the worker's kickoff instructions; `kickoff` is accepted as an ALIAS for it — pass either one (if both, kickoffPrompt wins). agentId is REQUIRED and must be an explicit WORKER agent (e.g. Dev/Bugfix/QA/Docs) — NEVER your own manager agent. Spawning under a manager/platform-role agent is rejected. agentId accepts EITHER the agent's id OR its NAME/slug (resolved within your project; a bad value returns a 'did you mean' hint). taskId is OPTIONAL — pass it to bind the worker to a board task (moves the task to in_progress; accepts EITHER the full id OR an unambiguous 8-char id-prefix, resolved within your project; an ambiguous prefix errors naming the candidate ids); OMIT it for a TASKLESS spawn — an ad-hoc spike/no-commit worker that gets its own isolated worktree with no board card to falsify or hijack. A taskless worker reports up via worker_report exactly like a tasked one, just with no card to move — it never lands in a review lane, so retire it yourself with worker_stop once you've read its report. If it produced commits you actually want landed, worker_merge_confirm still works on it (the branch merges onto main; there's just no card to move to done, since it never had one) — task it for real instead if you want the normal review-lane flow. The one-live-worker-per-task guard only ever applies to a REAL taskId — a taskless spawn never competes for it (two taskless spawns never collide with each other either). CLIENT-TIMEOUT RESILIENT: a fast spawn returns {workerSessionId,branch,worktreePath}; a slow one (worktree provisioning taking a while) instead returns {opId,status:\"pending\",taskId} — poll via worker_list (a placeholder row) or RE-CALL worker_spawn with the SAME taskId (or the same omission)/agentId/kickoffPrompt (idempotent-retryable for a TASKED retry: it attaches to the SAME in-flight spawn rather than starting a second one, and never throws 'already in flight'; a TASKLESS retry has no stable identity to dedupe against and may start a second taskless worker — retire the extra with worker_stop if so). REVIEW SPAWN (card 47bbdc3f): pass EITHER `reviewOfWorkerSessionId` (an existing worker session id) OR `reviewOfTaskId` (a task id, resolved to that task's own deterministic branch — works even if its worker has since exited) — mutually exclusive, both OPTIONAL, and orthogonal to `taskId` (the review convention is a TASKLESS spawn: pass a `reviewOf*` and omit `taskId`, e.g. for a Code Reviewer profile). Server-resolves the reviewed branch + its CURRENT tip sha and cuts THIS worker's own fresh branch FROM that tip instead of from the repo's HEAD — so its worktree's content is byte-identical to what's under review at spawn time (ordinary Read/Grep is correct by construction; no `git show`/hand-typed-branch step needed), and the resolved branch+sha is mechanically injected into its kickoff. A bad/unresolvable `reviewOf*` id is a hard `{error}` — it never silently falls back to a HEAD-forked spawn. This is a PINNED SNAPSHOT: a later push to the reviewed branch is not reflected without a fresh review spawn. The result ALSO carries `reviewOf:{branch,headSha}` when this was a review spawn (absent otherwise). WASTED-DISPATCH ADVISORY (tasked spawns only): if the card's title already appears — verbatim, once coerced to a commit subject the same way a squash-merge coerces one — as a commit on the project's mainline within its recent history, the result ALSO carries `shippedMatch:{sha,subject,mainBranch}` plus a human-readable `warning` naming the matching commit; this NEVER blocks the spawn (the worker still starts) — it's a flag for YOU to verify before letting it proceed, since the fix may already be shipped. Absent on a non-match, a taskless spawn, or any other spawn shape. REUSED-DIRTY-WORKTREE FLAG: when this spawn REUSED a worktree retained from a PRIOR hard-stopped or rejected-merge attempt on this task AND it still carries real leftover uncommitted work, the result ALSO carries `reusedDirtyWorktree:true` plus `reusedDirtyWorktreeStatus:{statusSummary,fileCount,truncated}` (a bounded `git status`-derived summary) — the worktree is NEVER auto-cleaned (Loom never silently discards a hard-stopped worker's edits), and the new worker's own kickoff already carries a reconcile note pointing at the same leftover paths, so you don't need to hand-instruct one yourself. Absent for a fresh worktree or a reused-but-clean one. STALE BRANCH BASE FLAG: when this spawn reused/reattached a task branch that carries prior-session commits (a recovery branch) AND that branch's base has since fallen behind the project's current mainline, Loom first tries a CLEAN auto-forward (merging the mainline into the branch — never a rebase, never past a conflict); if that succeeds the branch is simply caught up and nothing is surfaced. Only when a clean auto-forward wasn't possible does the result ALSO carry `staleBase:{baseSha,behindBy,changedFiles,truncated}` plus a human-readable `staleBaseWarning` — the worker's own kickoff already carries a matching forward-merge instruction, so you don't need to hand-instruct one yourself, but you may want to factor it into your review. Absent for a fresh branch, a branch that was never behind, or one that auto-forwarded cleanly. CONCURRENCY-CAP REJECTION: if the cap is full, the result is `{error:\"concurrency cap reached (N)\"}` PLUS `capQueued:{opId,taskId,queuedAt}` — the intent was recorded and is now visible as a placeholder row in worker_list, so it's never silently lost. It AUTO-FIRES on its own (FIFO) the next time a slot on this manager frees — no re-call needed — or re-call worker_spawn with the same args yourself if you don't want to wait; either clears the marker. To withdraw it instead, `worker_stop({opId})`.",
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
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", taskId, note: "still spawning — poll worker_list (a pendingSpawn placeholder row) or re-call worker_spawn with the SAME taskId/agentId/kickoffPrompt to fetch the result once ready." });
          if (!r.ok) return ok(asUsageLimitOrMessage(r.error));
          const worker = r.value;
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
          return ok({ workerSessionId: worker.id, branch: worker.branch, worktreePath: worker.worktreePath, ...shipped, ...dirty, ...stale, ...review });
        } catch (e) {
          // Other refusals (paused / over-cap / bad task) stay a bare { error } string — same envelope as
          // the sibling lifecycle tools.
          return ok(asUsageLimitOrMessage(e));
        }
      },
    );

    server.registerTool(
      "worker_stop",
      {
        description: "ENDS one of your workers' sessions (graceful Ctrl-C by default, or hard kill) — this is TERMINAL, not a pause: the session is over and cannot resume mid-turn. If what you actually want is to HOLD it — pause it, make it stop what it's doing and wait for you, without ending it — use `worker_redirect` instead; this tool cannot do that. The worktree is retained. Pass EITHER workerSessionId (a real, already-spawned worker) OR opId (a `cap-queued` placeholder row from worker_list — an intent that was recorded but never actually spawned because the concurrency cap was full) — exactly one is required. The opId path withdraws the queued intent instead of stopping a pty (there's no pty yet): it returns `{cancelled:true}` if a matching queued entry was found and removed, or `{cancelled:false}` if not (already auto-fired once a slot freed, already TTL-reaped, or the opId was wrong) — that's a normal outcome, not an error, so check the flag rather than assuming success. A queued entry otherwise auto-fires on its own once a concurrency slot frees (no daemon restart needed) — cancel it BEFORE that happens if you no longer want it. The workerSessionId path returns `{stopped:true}` ONLY when a live pty actually existed and was told to stop — NEVER unconditionally (card dde0ce24: a worker_spawn that failed during process creation used to leave a phantom `live` row with no engine, and this tool used to report `{stopped:true}` for it without having stopped anything, a false success a manager could not route around). `{stopped:false, reason:\"no live pty for this session\"}` means there was nothing running to stop — the call still reconciles a stale `live` DB row to `exited` as a side effect, releasing the per-task one-live-worker mutex, so a re-spawn on that task is admitted right after.",
        inputSchema: strictShape({ workerSessionId: z.string().optional(), opId: z.string().optional(), mode: z.enum(["graceful", "hard"]).optional() }),
      },
      async ({ workerSessionId, opId, mode }) => {
        if (!workerSessionId && !opId) return ok({ error: "worker_stop requires either workerSessionId or opId" });
        if (workerSessionId && opId) return ok({ error: "worker_stop takes EITHER workerSessionId OR opId, not both" });
        if (opId) return ok({ cancelled: sessions.cancelCapQueuedSpawn(managerSessionId, opId) });
        try {
          selfHealWorkerLink(workerSessionId!, "worker_stop");
          return ok(sessions.stopWorker(managerSessionId, workerSessionId!, mode ?? "graceful"));
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
          "— may differ from `mode` if the cycle gave up early.",
        inputSchema: strictShape({ workerSessionId: z.string(), mode: z.enum(["acceptEdits", "auto", "plan"]) }),
      },
      async ({ workerSessionId, mode }) => {
        try {
          selfHealWorkerLink(workerSessionId, "worker_set_mode");
          const landed = await sessions.setWorkerMode(managerSessionId, workerSessionId, mode);
          return ok({ landed });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_flush",
      {
        description:
          "The SUBMIT-ONLY affordance for a stranded worker composer (card 3e76ecad) — press Enter on " +
          "this worker's OWN composer, WRITING NOTHING NEW. Reach for this when a worker looks stuck and " +
          "you suspect it's holding an already-written turn that just never got confirmed (a paste landed " +
          "but the Enter never registered) — the daemon-driven analogue of what a human does at the raw " +
          "terminal in exactly that situation, which has recovered a session that sat apparently dead for " +
          "~29 minutes with nothing more than pressing Enter. This is your THIRD option alongside " +
          "`worker_message` (which APPENDS — compounding an already-oversized buffer if the worker is " +
          "already holding a large unconfirmed payload) and `worker_stop` + respawn (which DISCARDS " +
          "whatever the worker had accumulated): neither of those is a submit, and until this tool existed " +
          "there was no way to just submit what's already there. " +
          "GENUINELY NON-WRITING: this never appends so much as an empty string or a newline to the " +
          "composer — it only reasserts the paste boundary (zero body bytes) and sends the Enter keystroke " +
          "itself, so the composer's own byte count is unchanged by this call, unlike worker_message. " +
          "NO-OP ON A CLEAN COMPOSER: if the worker's composer looks genuinely empty (nothing outstanding, " +
          "no possibly-stranded residue), this is a documented no-op — `{ok:false, reason:\"composer-empty\"}` " +
          "— never a stray bare Enter that could start an empty turn. " +
          "⚠️ A REMEDY TO TRY, NOT A GUARANTEED RECOVERY: the Enter can succeed, OR it can fail to confirm " +
          "exactly as it did the first time — `confirmed` reports which, honestly, after a bounded wait; a " +
          "`confirmed:false` result means this attempt didn't land, not that nothing can be done (you still " +
          "have worker_message/worker_stop as escalations). This tool alone does NOT prove a worker is " +
          "recoverable in general — respawning is a SEPARATE, more destructive escalation with its own " +
          "tradeoffs (see worker_stop's own docs), not something this tool's success or failure should be " +
          "read as evidence for or against. " +
          "Also returns `resumability` (\"dead\"|\"resumable\"|\"unknown\") as a SECOND, independent " +
          "discriminator alongside the flush outcome — a \"dead\" worker's process/transcript is already " +
          "confirmed gone, which makes a submit-only retry moot regardless of what `ok`/`confirmed` say; " +
          "read the two together, not `confirmed` alone, before deciding what to do next.",
        inputSchema: strictShape({ workerSessionId: z.string() }),
      },
      async ({ workerSessionId }) => {
        try {
          selfHealWorkerLink(workerSessionId, "worker_flush");
          return ok(await sessions.flushWorkerComposer(managerSessionId, workerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_message",
      {
        description: "Send a message to one of your workers. `text` is the canonical param; `message` is accepted as an ALIAS for it — pass either one (if both, text wins). Submitted as a turn if the worker is idle; queued FIFO and delivered on its next turn boundary if it's mid-turn. By DEFAULT each queued message is delivered ALONE as its own turn — one-per-turn, so distinct directives are never mashed together — even if several stack up while the worker is busy; the legacy full-COALESCE-into-one-turn behavior (FIFO order, newest last) only applies when the human has turned on the daemon-global `coalesceAgentMessages` setting (off by default). `delivered` NEVER changes meaning (true = HANDED OFF as a turn now); on `delivered:false`, `reason` tells you which: \"held\" (queued, will land) vs \"session-dead\" (the worker is gone — DROPPED, not queued; re-dispatch or recycle instead of waiting). A `\"held\"` result is a SUCCESS, not a failure — it ALSO carries `queued:true`, `landsAt:\"next-turn-boundary\"`, `position` (1-based queue position), `busyForMs` (how long the worker has been mid-turn, when known), and `msgId` (to correlate with a later durable record), so you can read the outcome as the honest queue-and-will-land it is instead of inferring that from a bare `false`. ⚠️ `delivered:true` is NOT proof the worker ever saw it: it only means the text was handed to the engine as a turn attempt. `deliveryState` (always present, `\"handed-off\"|\"queued\"|\"dropped\"`, one-to-one with the actual outcome) spells that out explicitly instead of leaving it to be inferred from `delivered`/`reason`/`queued` — on `delivered:true` it reads `\"handed-off\"`, a REMINDER that the engine's own confirmation is asynchronous and can still GIVE UP after this call already returned (this happened in production — a `delivered:true` message never reached the worker's transcript and it sat idle for 26 minutes with no signal anything was wrong). To find out what actually happened, poll `worker_list`/`worker_status` and check this `msgId` against `directive`/`staleDirective` (delivered but unacknowledged after several of the worker's own turns) or `parkedDirective` (Loom stopped auto-retrying it — see its own `state` for what that does and doesn't prove; a resend of the SAME content is automatically recognized and joined to the original even if you don't pass `resendOf` — but that auto-join is NOT unconditional (card 085d9422, relocated from the `[loom:redelivery-parked]` notice, which used to spell this out per-event): (a) it matches on the exact FRAMED text, which embeds YOUR OWN session id, so it breaks if you've been recycled since the original send; (b) the join window closes the instant Loom itself confirms the original landed — resend AFTER that and it becomes a genuine second turn instead of joining. A reworded resend is always treated as new either way). `resendOf` is an OPTIONAL explicit disambiguator — the exact `msgId`/`rootMsgId` of an earlier directive this message re-sends — for when you know it; it does not change whether (a)/(b) apply, only removes the guesswork of which chain you mean.",
        inputSchema: strictShape({ workerSessionId: z.string(), text: z.string().optional(), message: z.string().optional(), resendOf: z.string().optional() }),
      },
      async ({ workerSessionId, text, message, resendOf }) => {
        try {
          const resolvedText = resolveAlias(text, message);
          if (resolvedText === undefined) return ok({ error: "text (or message) is required" });
          selfHealWorkerLink(workerSessionId, "worker_message");
          return ok(sessions.messageWorker(managerSessionId, workerSessionId, resolvedText, resendOf));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

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
          "VERIFY WHAT THE WORKER IS ACTUALLY BUILDING before you hold/stop it — check its real state " +
          "(e.g. its working tree via `git status`, not just a busy flag or your own tool-call log), since " +
          "a control-plane signal alone can misread what's actually in flight, and an unnecessary hold can " +
          "abandon or clobber correct in-progress work. CONTRAST with worker_message, " +
          "which is ADDITIVE and NON-interrupting (it queues behind the current turn, delivered ALONE as its " +
          "own turn by default — coalesced with other pending messages into one turn only if the human has " +
          "turned on the legacy daemon-global `coalesceAgentMessages` setting); prefer worker_message for " +
          "ordinary, non-urgent direction and reach for this tool only when you truly need to interrupt now. " +
          "CAUTION: the interrupt may land MID-EDIT, leaving the worker's working tree partly changed — so " +
          "phrase `text` so the worker FIRST reconciles/inspects its working tree (e.g. `git status`, finish " +
          "or revert the half-done edit) BEFORE acting on the new direction. Any messages that were queued for " +
          "the worker are discarded (superseded by this one). Returns {delivered} — true if it went out as a " +
          "turn immediately (worker was idle), false if queued to land right after the interrupt clears. " +
          "UNLIKE worker_message, a `delivered:false` here does NOT mean a plain FIFO hold: it carries " +
          "`interrupting:true` and `landsAt:\"after-interrupt\"` (not `worker_message`'s `\"next-turn-boundary\"`) " +
          "— the worker was busy, its current turn is being cut short with an Esc right now, and this redirect " +
          "lands the instant that settles. Also carries `position`, `busyForMs`, and `msgId` like worker_message. " +
          "An idle worker (delivered:true) had nothing to interrupt — no Esc fires. " +
          "⚠️ Like worker_message, `delivered:true` is NOT proof the worker ever saw it — only that the " +
          "text was handed to the engine as a turn attempt; the engine's own confirmation is asynchronous " +
          "and can still GIVE UP after this call already returned (see worker_message's own docs for the " +
          "`deliveryState` field and the production incident behind this caveat). worker_list/worker_status's " +
          "`directive`/`staleDirective`/`parkedDirective` projection tracks a redirect on EITHER path (card " +
          "99339bcd) — a HELD redirect (delivered:false here) the same way it tracks a held worker_message, AND " +
          "an IMMEDIATELY-delivered redirect (delivered:true here, the worker was idle) the same way an " +
          "immediate worker_message is tracked: both carry a real correlatable msgId, so if THIS hand-off " +
          "silently gives up later (the same async-confirmation risk described above), it still resolves to " +
          "`parkedDirective`/`staleDirective` exactly like a held one would — no residual blind spot on either " +
          "path. Whichever kind (message or redirect) was sent most recently is the ONE directive the " +
          "projection tracks — a redirect always supersedes an outstanding queued message (this tool flushes " +
          "it), and a later worker_message likewise supersedes an outstanding (even parked) redirect. " +
          "`text` is the canonical param; `message` is accepted as an ALIAS for it — pass either one (if " +
          "both, text wins).",
        inputSchema: strictShape({ workerSessionId: z.string(), text: z.string().optional(), message: z.string().optional() }),
      },
      async ({ workerSessionId, text, message }) => {
        try {
          const resolvedText = resolveAlias(text, message);
          if (resolvedText === undefined) return ok({ error: "text (or message) is required" });
          selfHealWorkerLink(workerSessionId, "worker_redirect");
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
          "options. \"permission\" — ask the human to authorize/deny an irreversible/outward/spend " +
          "action; `action` (REQUIRED) describes it, `scope` (\"once\"|\"standing\", optional) is the " +
          "requested grant lifetime, `expiresAt` (optional ISO timestamp) is a requested expiry — this is " +
          "an ask/answer channel, not a second gate: it does not itself block anything, so if the action " +
          "must actually WAIT on the answer, hold it yourself. These are your ASK-TIME REQUEST only — the " +
          "human may grant a different scope/expiry, or none; see question_pull's permission-entry shape " +
          "for what was actually decided. ADVISORY ONLY: Loom persists + surfaces the decided grant (and " +
          "flags it once its expiry has passed) but never itself enforces, blocks, or revokes it — you " +
          "must read the answer and honor it yourself (this tool's `provisionTo`, below, is the same " +
          "STATES-INTENT-ONLY posture for credentials). \"credential\" — ask for a secret " +
          "(API key/token) under a NEVER-ECHO model: you will NEVER receive the plaintext, only an ack " +
          "once it's provided; `envVar` (optional) names the env var/config key you'd like it stored " +
          "under. It is NOT auto-injected into any session — wiring it in is a separate, human-only step " +
          "(outside this tool) that must happen before an agent session can use it. " +
          "`taskId` (optional) softly links this to a board task. `supersedes` (optional): the questionId " +
          "of a still-PENDING ask (asked by you) that this new ask replaces — atomically cancels it via " +
          "the SAME machinery as `question_cancel` (your own agent lineage only; pending-only) and lands " +
          "it `cancelled` with a reason linking this new ask, so a moot/superseded Request never has to " +
          "sit in the human's inbox waiting on a separate cancel call. This NEW ask is filed regardless " +
          "of whether the supersede succeeds — if the named ask was already answered/cancelled, unknown, " +
          "or isn't yours, the cancel is refused (an answer the human already gave is NEVER discarded) " +
          "and that failure is reported back in the response's `supersede` field, never silently " +
          "swallowed. You'll get a one-time push nudge into " +
          "your own session when the human answers; call question_pull to fetch the answer. Returns {questionId} — or, when `supersedes` was " +
          "passed, {questionId, supersede: {cancelled:true, questionId} | {error}}.",
        inputSchema: strictShape(QUESTION_ASK_INPUT_SHAPE),
      },
      async (input) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const built = buildQuestionAsk(input, { sessionId: managerSessionId, projectId, db, role });
        if ("error" in built) return ok({ error: built.error });
        const { question } = built;
        // Insert the NEW ask BEFORE superseding the old one (see applySupersede's doc — the ordering, not a
        // transaction, is what guarantees a failure never loses the owner's prior pending ask).
        db.insertQuestion(question);
        const supersede = input.supersedes
          ? applySupersede(db, managerSessionId, input.supersedes, question)
          : undefined;
        // Event-emit twin (attention-push signal source, Lead fork 2b) — additive, no existing consumer
        // (alert-webhook's events[] allowlist, web attention) lists this new kind, so this is inert for them.
        db.appendEvent({
          id: randomUUID(), ts: question.createdAt, managerSessionId,
          kind: "question_asked", detail: { questionId: question.id, title: question.title },
        });
        return ok(supersede !== undefined ? { questionId: question.id, supersede } : { questionId: question.id });
      },
    );

    server.registerTool(
      "question_pull",
      {
        description:
          "Pull (return AND consume) every ANSWERED request you've asked via question_ask — your " +
          "requests-inbox pickup. Each entry carries {questionId, title, type, ...}: a \"decision\"/" +
          "\"input\" entry has {chosenOption, note} (chosenOption is one of the options you offered, or " +
          "null); a \"permission\" entry has {approved, note, scope, expiresAt, lapsed} — `scope`/" +
          "`expiresAt` are the human's ACTUAL decided grant (null/null if they never chose one, e.g. an " +
          "older answer, or a denial), and `lapsed` is true only once `expiresAt` is set AND in the past. " +
          "ADVISORY ONLY: this is a display signal for YOU to check — Loom itself never enforces, blocks, " +
          "or revokes a standing grant, so re-read `lapsed` (e.g. after a recycle) rather than assuming a " +
          "prior 'standing' answer still holds; a \"credential\" entry has {ack} — NEVER " +
          "the secret itself. Pulling consumes them in one shot (flips them to 'consumed') so they won't " +
          "be returned again — call this when you reach the point the request was blocking, or after the " +
          "push nudge tells you one was answered. Returns {questions: [...]} (empty if none are answered " +
          "yet — a still-'pending' request is NOT returned; keep orchestrating and check back later).",
        inputSchema: strictShape({}),
      },
      async () => {
        // Scoped by AGENT LINEAGE, not this exact session id (card f88e91f0) — so a fresh (non-recycle)
        // successor manager on the SAME agent still sees decisions its predecessor filed, not just a
        // recycle successor (which reparentQuestions already handles as a fast path).
        const asker = db.getSession(managerSessionId);
        if (!asker) return ok({ error: "session not found" });
        const answered = db.pullAnsweredQuestionsForAgent(asker.agentId, new Date().toISOString());
        // Purge any OTHER still-queued answer-nudge for a question this same pull just consumed — a
        // multi-answer batch enqueues one nudge per answer, but this pull drains them all atomically, so
        // every nudge past the first is now stale (card bbc46336 follow-up). Does not touch the nudge for
        // whichever question drained AS this turn (it already delivered — never queued).
        if (answered.length > 0) {
          sessions.purgeAnsweredQuestionNudges(managerSessionId, answered.map((q) => q.id));
        }
        return ok({ questions: answered.map(questionPullItem) });
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

    // question_resolve (card feat(mcp): let an owner chat reply resolve a pending Request as answered,
    // origin finding 308259e5) — closes the file-then-cancel gap: when the owner answers a pending
    // question_ask CONVERSATIONALLY in this manager's own chat instead of the web Requests UI, this lets
    // the manager mark it 'answered' with the owner's own words captured as the note, rather than filing
    // a durable question_ask and tearing it down one turn later with question_cancel (which lands it
    // 'cancelled'/moot — losing the owner's reasoning to chat scrollback). Shares resolveQuestionForAgent
    // (mcp/questionTool.ts) verbatim with the Lead surface (mcp/platform.ts) — see its doc for the
    // anti-fabrication invariant (the note is ALWAYS server-captured owner text, never agent-authored)
    // and why this skips the Companion's propose/confirm friction ladder.
    //
    // ownerText source (card fix(mcp): let question_resolve accept mid-turn-tool composer answers,
    // origin finding ca341979): falls back from the CURRENT turn to the single most-recent owner-authored
    // turn (PtyHost.getRecentOwnerTurns[0]) when the current turn isn't owner-formed — e.g. the manager
    // spawned workers, ended its own turn, and only gets to question_resolve on a LATER turn triggered by
    // something else (a worker report drain, an idle nudge). Same bounded, never-cleared-at-Stop ring
    // companion/attestation.ts's isVerbatimOwnerText already widens onto (card 2b26035c) — [0] only (not a
    // scan of the whole window), so the note always attests the owner's LATEST word, never an older one
    // stitched in to make a match.
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
          "to attest), if the request isn't yours (own agent lineage only) or isn't still 'pending', and " +
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
      async ({ questionId, chosenOption }) =>
        ok(resolveQuestionForAgent(
          db, managerSessionId, questionId, chosenOption,
          pty?.getActiveTurnOwnerText(managerSessionId) ?? pty?.getRecentOwnerTurns?.(managerSessionId)?.[0] ?? null,
        )),
    );

    // requests_list (card 988bb585 follow-up): a NON-CONSUMING, board-wide read of YOUR OWN project's
    // Requests — the gap between question_pull (consumes, answered-only, no taskId filter) and
    // task_requests_list/task_request_get (task-scoped only). Mirrors the Platform Auditor's cross-project
    // requests_list (mcp/audit.ts) — same filters, same per-type answer shaping (questionTool.ts's
    // auditRequestItem/questionAnswerByType) so the credential never-echo guarantee can't drift between the
    // two read surfaces — but scoped SERVER-SIDE to this manager's own project (no projectId param; a
    // manager can never read another project's requests, unlike the Auditor's platform-wide read).
    server.registerTool(
      "requests_list",
      {
        description:
          "List Requests (decision/input/permission/credential asks) for YOUR OWN project, board-wide — " +
          "the non-consuming complement to question_pull (which only returns ANSWERED requests and " +
          "CONSUMES them). Use this to survey pending/answered/consumed requests, including ones asked " +
          "with no taskId or asked by a predecessor manager on this project. NON-CONSUMING — reading NEVER " +
          "drains or flips state; calling it twice returns the same records. Returns {items, total, " +
          "returned, offset, hasMore}: `items` per row is {id, projectId, sessionId, agentId, taskId, type, " +
          "title, state, createdAt, answeredAt, consumedAt} plus an answer summary by type — chosenOption/" +
          "note for decision|input, approved/note for permission, ack ONLY for credential (NEVER the secret " +
          "— a pending row's answer fields read null rather than a misleading false-ish value). `total` is " +
          "the FULL matching count and `hasMore` tells you whether `items` was truncated. Filters (all optional, AND'd): state " +
          "(pending|answered|consumed|cancelled — \"cancelled\" is a moot/superseded ask you or a human " +
          "withdrew via question_cancel/dismiss, never an answer), type (decision|input|permission|" +
          "credential), includeConsumed (false by default — folds already-consumed AND already-cancelled " +
          "requests in alongside the rest; an explicit state:\"consumed\"/\"cancelled\" always shows those " +
          "regardless of this flag), mine (false by default — " +
          "when true, narrows to ONLY requests filed by YOUR OWN agent lineage, the same ownership scope " +
          "question_pull consumes from, so a fresh successor session on the same agent still sees them). " +
          "`mine:true` is the dedup read for a scheduled/autonomous agent: before filing a new " +
          "question_ask, call this to check whether you (or a predecessor session on your agent) already " +
          "filed an equivalent request that's still pending or answered-but-unpulled, instead of re-filing " +
          `a duplicate every cycle. Newest-first (createdAt DESC). Bounded to ${DEFAULT_REQUESTS_LIST_CAP} ` +
          "rows by default (see `hasMore`) — pass an explicit limit/offset to page past it.",
        inputSchema: strictShape({
          state: z.enum(QUESTION_STATES).optional(),
          type: z.enum(QUESTION_TYPES).optional(),
          includeConsumed: z.boolean().optional(),
          mine: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        }),
      },
      async ({ state, type, includeConsumed, mine, limit, offset }) => {
        const asker = db.getSession(managerSessionId);
        if (!asker?.projectId) return ok({ error: "no project for this session" });
        const all = db.listQuestionsForAudit({
          projectId: asker.projectId, state, type, excludeConsumed: !includeConsumed,
          agentId: mine ? asker.agentId : undefined,
        });
        const paged = pageRequests(all, { limit, offset }, DEFAULT_REQUESTS_LIST_CAP);
        return ok({ ...paged, items: paged.items.map(auditRequestItem) });
      },
    );

    server.registerTool(
      "worker_recycle",
      {
        description: "Recycle a worker whose context has grown too large: closes it and spawns a FRESH worker in the SAME git worktree (code state kept) seeded with your handoff summary (intent kept). Same task + branch; gen+1. Read worker_transcript first and write the summary. `handoffSummary` is the canonical param; `continuationPrompt` (the sibling recycle_me tool's name for the same concept) is accepted as an ALIAS — pass either one (if both are given, handoffSummary wins).",
        inputSchema: strictShape({ workerSessionId: z.string(), handoffSummary: z.string().optional(), continuationPrompt: z.string().optional() }),
      },
      async ({ workerSessionId, handoffSummary, continuationPrompt }) => {
        const summary = resolveAlias(handoffSummary, continuationPrompt);
        // Falsy check (NOT `=== undefined`) — restores the PRE-alias behavior where an empty string was
        // rejected at the tool boundary with this clear message, rather than passing through to the
        // service's own blank-guard (a confusingly different "must not be blank"/"not your worker" error
        // depending on link state). Unlike the 6 NEW aliases below (whose canonical was already a required
        // z.string() that always accepted ""), this tool's canonical/alias pair predates that convention —
        // restoring it here is a bugfix, not a behavior change worth re-litigating (CR minor 1).
        if (!summary) return ok({ error: "handoffSummary (or continuationPrompt) is required" });
        try {
          selfHealWorkerLink(workerSessionId, "worker_recycle");
          const fresh = await sessions.recycleWorker(managerSessionId, workerSessionId, summary);
          return ok({ newWorkerSessionId: fresh.id, gen: fresh.gen, recycledFrom: fresh.recycledFrom });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge",
      {
        description:
          "STEP 1 of the merge gate: review a worker's branch diff. By DEFAULT returns a bounded DIFFSTAT — " +
          "the list of changed files with per-file +/- and the insertion/deletion totals — so it will NOT " +
          "overflow the display on a large change (where the full patch is biggest/riskiest). Pass " +
          "fullDiff:true to ALSO get the full unified patch for line-level review (the full patch is " +
          "unbounded and may itself overflow on a very large change — review the diffstat first, then pull " +
          "the patch). Pass `files` (an array of exact/substring path matches — RELIABLE for nested paths, " +
          "e.g. 'sessions/service.ts' matches 'packages/daemon/src/sessions/service.ts') and/or `pathGlob` " +
          "(a glob like 'packages/daemon/src/mcp/*.ts'; a bare pattern with no '/', e.g. '*service.ts', is " +
          "auto-matched anywhere as if written '**/*service.ts' — but a pattern that DOES contain '/' " +
          "scopes to that literal directory and won't match elsewhere) to scope BOTH the diffstat and the " +
          "patch to matching file(s) — pull one file's hunk at a time on a large multi-file change instead " +
          "of the whole patch. A pathGlob matching 0 of the actually-changed files returns a `hint` " +
          "explaining the miss (with the list of changed files) instead of a silent, empty-looking result. " +
          "Omit both for the full unfiltered diff. If the (possibly filtered) patch is still too " +
          "large to inline safely, it's written to a scratch file instead — UTF-8, real line breaks, " +
          "Read-pageable with offset/limit — and the response carries patchFile/patchChars + a note in " +
          "place of the inline patch. No merge happens; you must review before confirming (there is no " +
          "worker-side merge). STALE-BASE BACKSTOP (card 5150fdc2 part 4): if this branch's history is " +
          "missing commits current main carries, the result ALSO carries `behindMain:<count>` plus a " +
          "'STALE BASE' clause folded into `warning` — confirmWorkerMerge's own union-merge will attempt to " +
          "forward it automatically before the gate runs, but this is a heads-up to review the diff with " +
          "that in mind; a stale-based rebuild can silently overwrite or conflict with a change that landed " +
          "on main after the branch was cut. Fires independent of whether this worker's spawn already " +
          "surfaced a `staleBase` (it may have been spawned before that fix, or fallen behind mid-session). " +
          "Absent when the branch is caught up. PROSPECTIVE COMMIT SUBJECT (card b88704bb): when this worker " +
          "has a task, the result ALSO carries `commitSubject` — the EXACT, byte-for-byte subject that will " +
          "be committed if you confirm (this is your only chance to see it before it's permanent — " +
          "confirmWorkerMerge derives and commits it, it never re-shows it for approval). If the card's raw " +
          "title was NOT already Conventional-Commits form, the result also carries `rawTitle` (the " +
          "original) and `coerced:true` — a factual flag that a type was inferred (bracket-mapped or " +
          "defaulted to `chore:`), not a judgment that the title is wrong. Retitle the card now (before " +
          "confirming) if `commitSubject` doesn't actually describe what shipped. Absent entirely for a " +
          "taskless worker (no card to preview a title from).",
        inputSchema: strictShape({ workerSessionId: z.string(), fullDiff: z.boolean().optional(), files: z.array(z.string()).optional(), pathGlob: z.string().optional() }),
      },
      async ({ workerSessionId, fullDiff, files, pathGlob }) => {
        try {
          selfHealWorkerLink(workerSessionId, "worker_merge");
          return ok(await sessions.reviewWorkerMerge(managerSessionId, workerSessionId, { includePatch: fullDiff === true, files, pathGlob }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge_confirm",
      {
        // UNION-MERGED (card 361520a0, merging main forward): main independently rewrote this SAME
        // description string to add the GATE OUTPUT ON A PASS TOO (card a1a8c5c4) paragraph while this
        // branch was adding the cancelled:true sentence — a naive "ours"/"theirs" resolution would have
        // silently dropped one side's whole addition. Both survive below: the cancelled:true sentence sits
        // where it did on this branch (right after ALREADY_MERGED/STAGE_EMPTY_RETRY), and the outputTail
        // paragraph sits where it did on main (right after the gate-rejection gateDetail sentence).
        description: "STEP 2: after reviewing, confirm the merge. Runs the build/DoD gate, and ONLY if green merges the branch as ONE squash commit, removes the worktree, and moves the task to done. The staged set is re-derived at confirm time (never a stale snapshot), so a valid +N-commit branch merges on the FIRST call. Fail-closed: a failed gate or a conflict leaves the repo untouched and the worktree retained. A genuine no-op is distinguishable via emptyKind: ALREADY_MERGED (branch already in main → finished idempotently, merged:true) vs STAGE_EMPTY_RETRY (no diff to merge → merged:false, worktree retained). A THIRD, distinct outcome is `cancelled:true` (card 361520a0): a manager's `gate_cancel` withdrew this confirm while it was still QUEUED, before the gate ever ran — `merged:false`, but this is NOT a rejection (no gate ran, nothing to diagnose, nothing held against the branch); `cancelKind` names how, and the async signal is `[loom:merge-cancelled]`, never `[loom:merge-failed]`. Re-call worker_merge_confirm when ready to retry for real. A gate rejection (reason:\"build gate failed\") carries `gateDetail: {phase, failedStep, failingTest, stderrTail, exitCode, signal, timedOut, steps}` — the failing phase (typecheck|test|build) if derivable, the failed step's own command, the first recognizable failing-test/assertion line if extractable, and a bounded (~4KB) stdout+stderr tail — so you can diagnose a real test failure vs. a flake vs. a build break without re-running the gate blind; the same detail is also folded into the `[loom:merge-rejected]` notification text. ADMISSION-TIME RE-UNION (card b798e706): the base this gate validates is re-derived the instant this merge is actually admitted off the shared gate queue, not frozen from before the wait — if canonical main moved during that wait, it re-unions against the CURRENT main tip and can still land on its first pass instead of always self-aborting with a stale-base refusal; a merge whose base never moved is unaffected, byte-identical to before this existed. HONEST SCOPE (Code Review correction): this closes the gap for main moving during the wait for reasons OTHER than a same-repo sibling's own squash — an out-of-band/REST commit, cross-project queueing noise, a sibling whose squash happened to land before this op's own admission — and is never worse than doing nothing. It does NOT reliably close the more common same-repo-sibling case: the per-repo admission guard (card 92e960d1) frees the instant a sibling's GATE finishes, before that sibling's OWN squash lands (which runs after, outside that guard) — so a merge admitted right behind a sibling typically re-derives against a main that sibling hasn't squashed onto YET, runs its own full gate, and can still self-abort with `gate_base_invalidated` once that sibling's squash lands mid-run. Closing that case needs holding the admission guard across the squash phase too — a larger, separate change, carded as `c24dd48a`. If the re-derivation ITSELF hits a real git conflict (main advanced in a way that no longer merges cleanly with this worktree's already-unioned tree), the confirm is REJECTED with reason `union_conflict_at_admission` (or `union_merge_failed_at_admission` for a non-conflict git failure, worded WITHOUT asserting main-advanced as the cause — that framing is only earned by an actual conflict) — squash phase never reached, canonical repo untouched, worktree retained; this is a real failure needing your attention (rebase/resolve, or investigate a possible transient git/filesystem issue for the non-conflict case), distinct from the benign, purely-informational `gate_base_invalidated` race described below, which needs only a plain re-confirm. GATE OUTPUT ON A PASS TOO (card a1a8c5c4): on the two DOMINANT outcomes — a plain gate-fail rejection, or a plain successful merge (not reused, not gateless, and not one of the rarer post-gate-pass rejections below) — the result ALSO carries a top-level `outputTail`, the SAME bounded (~4KB) last-step tail, persisted durably (readable later via `gate_status(opId)` even after this call's own response is long gone). Before this card a PASSING merge gate's output was retained NOWHERE at all, closing off the one question every gate investigation eventually needs: whether some condition seen in a failing run ALSO occurred in a passing one. A rarer post-gate-pass rejection (a merge conflict, `gate_base_invalidated`, an orphaned/stage-empty no-op) still returns no `outputTail` even though a gate genuinely ran — its absence there is NOT proof no gate ran; `gateExtended` (present, possibly `false`, whenever a gate spawned) is what actually proves that. If the project has NO gateCommand configured, a successful merge carries {warning:\"unverified: ...\"} — the merge landed but was NOT checked by any build/DoD gate. A successful merge that created a NEW squash commit (i.e. not the ALREADY_MERGED no-op path) also echoes `commitSubject` — the exact subject it just committed — so a transcript reader can see what landed without a separate `git log`; this is the SAME subject worker_merge previewed at step 1. GATE STEP DURATIONS (card a2873f7e): a merge that actually ran the gate (not reused, not gateless) ALSO carries `gateSteps: [{step, durationMs, status}, ...]` — one entry per `&&`-separated gate step — echoed into the `[loom:merge-done]` notification as a line prefixed `steps (diagnostic only — not a pass/fail signal): ...`. `steps` is the SAME shape on a rejection's `gateDetail` too, so a step's duration is comparable across a green run and a red one. This is DIAGNOSTIC ONLY — a prompt to look, never evidence to assert or threshold against; a duration swings with host load and a suite that silently runs less finishes EARLY, which reads as good news, not a red flag. NESTED-REPO SAFETY: after a successful merge, the worktree is force-removed (it always carries expected ephemeral untracked content — node_modules, dist, build caches). If the worktree ALSO contains a nested git repository (a subdirectory with its own `.git` — e.g. something cloned into it, which can hold real unpushed work), the removal is REFUSED and the worktree is RETAINED intact — the merge itself already landed, only the cleanup is deferred; the result carries {warning} naming the nested path(s). Move/push that content out yourself and re-confirm, or pass forceRemoveWorktree:true if you've confirmed the nested content is disposable (default false — the safe choice) — a forceRemoveWorktree:true call ALWAYS runs for real (see below), so this is also how you retry the nested-repo case even moments after the first confirm. CLIENT-TIMEOUT RESILIENT: a fast confirm returns {merged,...,opId} (stamped with a correlation `opId`); a slow one (the gate genuinely takes a while) instead returns {opId,status:\"pending\",workerSessionId} — rather than polling, wait for the async `[loom:merge-done]`/`[loom:merge-rejected]`/`[loom:merge-failed]` nudge, which carries this SAME opId (plus the worker/task) so you can match it to this call even with several merges pending at once. If you need the answer sooner, poll the READ-ONLY `gate_status(opId)` (never starts a new run) or worker_list (this worker's `pendingMerge` field). RE-CALLING worker_merge_confirm with the SAME workerSessionId is ALSO always safe, at ANY delay — idempotent-retryable like worker_spawn: a re-call while the gate/merge is STILL running attaches to that SAME in-flight op (never a second one), and a re-call landing AFTER it settles, at the SAME commit — seconds, minutes, or hours later, it makes no difference — gets the SAME cached verdict instead of starting a fresh gate run (worker_list's `pendingMerge.state` may have already reverted to nothing by then — that's a cosmetic display window only, unrelated to this dedupe) — never throws 'already in flight'. If the branch has picked up new commits since the cached verdict, a re-call gates them for real instead of serving the stale answer — that is answering a different question, not a silent re-run of the old one. To force a genuine RE-RUN of the SAME commit — retrying a flake, or completing a nested-repo worktree cleanup — pass forceRemoveWorktree:true: a deliberate, named, one-shot escalation that ALWAYS runs for real, bypassing any cached verdict from an earlier call (so re-confirming WITH it set is the correct way to retry the identical commit — whether moments after a plain confirm, e.g. the nested-repo case above, or long after).",
        inputSchema: strictShape({ workerSessionId: z.string(), forceRemoveWorktree: z.boolean().optional() }),
      },
      async ({ workerSessionId, forceRemoveWorktree }) => {
        try {
          selfHealWorkerLink(workerSessionId, "worker_merge_confirm");
          const r = await sessions.confirmWorkerMergeTracked(managerSessionId, workerSessionId, forceRemoveWorktree);
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", workerSessionId, note: "gate/merge still running — poll gate_status(opId) (read-only, never starts a new run) or worker_list (this worker's pendingMerge field). Re-calling worker_merge_confirm with the SAME workerSessionId is also safe at any delay: a re-call at the SAME commit returns the cached verdict; a re-call after new commits on the branch gates them for real — that is answering a different question, not a silent re-run. To force a re-run at the SAME commit (e.g. retrying a flake), pass forceRemoveWorktree:true." });
          if (!r.ok) return ok({ error: r.error instanceof Error ? r.error.message : String(r.error) });
          return ok(r.value);
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );
    registerGateStatus(server, sessions);
    registerGateQueue(server, sessions, db, managerSessionId);

    // gate_history (card 753d9911): `listGateEvents` (db.ts) already reads the complete, paginated,
    // JOIN-enriched settled-gate-run series — INCLUDING rejected runs, whose `durationMs`/`gateCap`/
    // `concurrentGates` are stamped unconditionally, before any pass/fail branching — but until now it was
    // wired to exactly one consumer, the human-only web Gates page (`gateway/server.ts` `/api/gates/
    // history`). A manager had no read path to it at all and, on card `99fb882e`, spent weeks treating a
    // fully-recorded series as unrecoverable. This is that read path: a THIN wrapper, no new query — same
    // `db.listGateEvents` the web endpoint calls, reused verbatim.
    // CROSS-PROJECT SCOPING (the load-bearing risk this card called out): unlike the web endpoint, which
    // takes an optional `projectId` and defaults to the WHOLE PLATFORM, this tool takes NO projectId
    // argument at all — the project is resolved SERVER-SIDE from the caller's OWN session
    // (`db.getSession(managerSessionId)?.projectId`), the same pattern `registerGateQueue` above uses, so
    // there is no argument shape through which a caller could ask for a different project's rows. This is
    // STRICTER than `gate_queue`'s own redaction (which still returns a foreign project's row with
    // taskId/branch/workerLabel omitted): `gate_history` never returns a foreign-project row at all, so it
    // cannot widen anything `gate_queue` already exposes.
    server.registerTool(
      "gate_history",
      {
        description:
          "Read-only, PAGINATED history of settled daemon-executed gate runs for YOUR OWN project ONLY " +
          "(merge/build gates, their transient-kill retries, worker self-checks, and deploys) — INCLUDING " +
          "REJECTED runs, which carry the same `durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax` " +
          "a passed run does (recorded unconditionally, before any pass/fail branching — the exact data " +
          "`gate_queue` and `gate_status` cannot give you, since both only ever describe LIVE ops, never " +
          "settled history). Use this to recover a real gate-duration trend (e.g. \"is the floor climbing\") " +
          "instead of hand-maintaining a readings table from nudge text. Returns {items: GateHistoryRow[], " +
          "total, limit, offset, nextOffset} — `items` is newest-first; each row is {id, gateType " +
          "(\"merge\"|\"worker\"|\"deploy\"), outcome (\"pass\"|\"reject\"|\"timeout\"|\"kill\"), passed " +
          "(the same outcome as a plain boolean — `outcome===\"pass\"`), durationMs, gateCap, " +
          "concurrentGates, concurrentGatesMax, endedAt, failingTest, taskId, branch, workerLabel, " +
          "sessionId, projectId, projectName}. " +
          "⚠️ `concurrentGates` vs `concurrentGatesMax` — DO NOT CONFUSE THESE, they answer DIFFERENT " +
          "questions: `concurrentGates` is a SNAPSHOT AT ADMISSION ONLY — \"how many gates were admitted " +
          "together the instant this one started\" — and says NOTHING about a second gate joining 30s " +
          "later; a run that spent 95% of its wall time contended can still read `concurrentGates:1` " +
          "(uncontended-looking) if it happened to be admitted solo. `concurrentGatesMax` is the TRUE " +
          "max-over-run figure — how many were ever admitted at once while this run was in flight — and is " +
          "the field to reach for when the question is \"was this run actually contended\", never " +
          "`concurrentGates` alone. `concurrentGatesMax` is ALSO NEVER BACKFILLED: it is `null` for every " +
          "row recorded before that field shipped and populated only from that point forward, INDEPENDENTLY " +
          "of `concurrentGates`'s own availability — a `null` `concurrentGatesMax` on a row that DOES carry " +
          "`concurrentGates` is the NORMAL historical shape, not a data-quality problem, and neither field's " +
          "presence may be assumed from the other's. " +
          "`durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax` are each `null` only for a row " +
          "recorded before THAT SPECIFIC field was stamped — the four were NOT all added in the same " +
          "change, so there is no single date/card that scopes all of them at once; a caller that needs to " +
          "reason about when a particular field became reliable should check that field's own history, not " +
          "assume the others share it. Never null for a REJECTED row once the field in question is being " +
          "stamped at all — a rejection carries the same fields a pass does. `limit`/`offset` paginate " +
          "(default 100, clamped to " +
          MAX_GATE_HISTORY_PAGE + "); `nextOffset` is `offset+items.length` when more rows remain, else " +
          "`null` — page deterministically via offset:nextOffset until it is null, same contract as " +
          "`events_search`. " +
          "PROJECT-SCOPED SERVER-SIDE, NOT BY ARGUMENT: there is no `projectId` parameter — the project is " +
          "always the CALLER's own, resolved from this session, exactly like `gate_queue`. A caller cannot " +
          "request another project's rows through any input this tool accepts, and a foreign-project row " +
          "is never returned at all (not merely redacted), so this cannot expose anything `gate_queue`'s " +
          "own cross-project redaction doesn't already allow. Reuses `db.listGateEvents` verbatim — no " +
          "duplicate query logic.",
        inputSchema: strictShape({
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        }),
      },
      async ({ limit, offset }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const off = offset ?? 0;
        const page = db.listGateEvents({ projectId, limit: limit ?? 100, offset: off });
        const nextOffset = off + page.items.length < page.total ? off + page.items.length : null;
        return ok({ items: page.items, total: page.total, limit: page.limit, offset: off, nextOffset });
      },
    );

    // gate_cancel (card 8d585277): the manual cancel/supersede escalation for a case auto-supersede-on-
    // merge does NOT cover — no merge decision exists yet (a known-failing base, a stale/UNVERIFIED
    // self-check, a force-push, a worker recycled mid-run). Firing `worker_merge_confirm` already
    // reclaims a QUEUED self-check for free (see confirmWorkerMergeTracked); this tool is for everything
    // else, and the one case a QUEUED cancel can't help with — an ALREADY-RUNNING worker self-check.
    server.registerTool(
      "gate_cancel",
      {
        description:
          "Withdraw/cancel ONE of your OWN project's gate ops, by the `opId` a `run_gate`/" +
          "`worker_merge_confirm` pending response or `gate_queue` entry already named (full id or an " +
          "unambiguous prefix). Use this for a case firing `worker_merge_confirm` doesn't already cover — " +
          "e.g. you've learned the branch's base is known-failing, its last self-check settled " +
          "`headCurrent:false` (self-reported UNVERIFIED), it was superseded by a new commit, or the worker " +
          "was recycled mid-run — with no merge decision in sight to auto-reclaim it. Cancellable EITHER " +
          "queued or running for a worker's own `run_gate` self-check (gateType `worker`). A `merge` gate " +
          "(gateType `merge`) is cancellable ONLY while QUEUED — zero process risk, nothing was ever " +
          "spawned for it, same as a queued self-check; a RUNNING merge gate is refused (interrupting one " +
          "risks leaving staged residue in the canonical checkout that fails closed and needs a HUMAN to " +
          "clear it by hand before any further merge on that repo succeeds — these two phases are " +
          "deliberately NOT the same). A `deploy` gate is refused in EITHER phase (no `GateCancelledError` " +
          "catch exists for it yet, so cancelling one would surface as a misleading crash-shaped failure " +
          "instead of a clean outcome). " +
          "Returns {outcome:\"cancelled\", phase:\"queued\"|\"running\", opId, gateType} on success. A " +
          "cancelled QUEUED merge settles its `worker_merge_confirm` op as a distinct `cancelled` outcome — " +
          "not merged, not rejected — via a `[loom:merge-cancelled]` nudge, never `[loom:merge-failed]`. " +
          "{outcome:\"refused\", reason} means the op belongs to a DIFFERENT project — you cannot cancel " +
          "another project's gate op. {outcome:\"not_found\"} means there is nothing LIVE to cancel — this " +
          "tool only ever acts on the live GateSemaphore registry, never the durable op history, so it can't " +
          "itself tell you whether that's because the op already settled or never existed at all; call " +
          "`gate_status(opId)` separately if you need to tell those apart (it now distinguishes `settled` " +
          "from `never_existed`) — rely on the `[loom:gate-*]`/`[loom:merge-*]` nudge for a settled op's " +
          "real pass/fail outcome either way. " +
          "{outcome:\"ambiguous\", reason} means your opId prefix matches more than one op WITHIN YOUR OWN " +
          "PROJECT — pass more characters. {outcome:\"not_cancelled\", reason} covers every other miss: it " +
          "left the queue/finished running in the moments before this call landed (a genuine race with " +
          "natural completion — never fabricated as cancelled over a real result), a RUNNING merge gate or a " +
          "deploy gate in either phase (unsupported, see above), or — the one hazard this tool takes " +
          "seriously — a RUNNING self-check where the kill was issued but the process tree's death could not " +
          "be VERIFIED within a bounded window: that is reported as NOT cancelled on purpose (the run " +
          "continues under its own existing timeout) rather than risking a freed slot over work that may " +
          "still be running. A cancelled worker self-check or QUEUED merge settles as a distinct `cancelled` " +
          "outcome, never a failure — the `[loom:gate-cancelled]`/`[loom:merge-cancelled]` nudge says so " +
          "explicitly, so don't read one as a red to chase.",
        inputSchema: strictShape({ opId: z.string() }),
      },
      async ({ opId }) => {
        try {
          return ok(await sessions.cancelGateOp(managerSessionId, opId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
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
          "{restarting:true} on success, or {restarting:false, error} if unsupervised / build failed. If the " +
          "deploy going live also touches scripts/daemon-supervisor.mjs (the OUTER process that spawned this " +
          "daemon and is NOT re-execed by this restart), the success result additionally carries " +
          "{supervisorChanged:true, supervisorWarning} — those lines are silently inert until a human does a " +
          "manual `pnpm daemon:stable`; never report that part of the change as fully live.",
        inputSchema: strictShape({ reason: z.string() }),
      },
      async ({ reason }) => {
        try {
          return ok(await sessions.requestDaemonRestart(managerSessionId, reason));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // Registered ONLY when this project has a configured deployCommand (see deployCommandConfigured
    // above, which resolves via the EXACT SAME `resolveConfig(project.config, db.getPlatformConfig())
    // .orchestration.deployCommand` call — and the same falsy/"" check — that sessions.deployOwnProject
    // itself uses to decide whether to refuse) — a project with none would just get {deployed:false,"no
    // deployCommand configured"} every time, so most projects (deployCommand is human-only, opt-in) never
    // need this in their floor.
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
            "On success returns {deployed:true}; on a failed run returns {deployed:false,reason,exitCode," +
            "outputTail} with a bounded stdout+stderr tail to diagnose from.",
          inputSchema: strictShape({ reason: z.string() }),
        },
        async ({ reason }) => {
          try {
            return ok(await sessions.deployOwnProject(managerSessionId, reason));
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
    server.registerTool(
      "served_status",
      {
        description:
          "Read what THIS daemon process is actually serving right now — for post-daemon_restart " +
          "verification without falling back to curl. Returns {version (the loom/loomctl package version), " +
          "webBundle (the served assets/index-<hash>.js filename, or null if the web dist isn't built/found " +
          "— a changed hash after a restart proves the new web build is live), uptimeSeconds (this process's), " +
          "liveSessionCount (ACROSS ALL projects — a coarse sanity signal; use worker_list for your own " +
          "fleet), deployStaleness}. ⚠️ Card 5e30c4bd, measured first-hand across a real deploy: `version` " +
          "and `webBundle` are BOTH byte-identical before/after a daemon-`src`-only deploy (no package bump, " +
          "no web rebuild) — do NOT use either as a staleness proxy. `deployStaleness` is the real signal: " +
          "{available, stale, commitsBehind, distBuiltAt, processStartedAt, runningCodeBuiltAt, " +
          "distAheadOfProcess, mainlineHeadSha, mainlineHeadDate, webStale, webCommitsBehind, webDistBuiltAt, " +
          "reason?} — DERIVED fresh on every call (stat this daemon's own built entry + `git log` mainline, " +
          "never cached/persisted). `stale`/`commitsBehind` are scoped to ONLY `packages/daemon/src`/" +
          "`packages/shared/src` commits (an assets/docs/vault-only merge does NOT need a restart and never " +
          "counts): `stale:true` means mainline HEAD carries `commitsBehind` daemon-src/shared commit(s) " +
          "this running process was not built with — a `daemon_restart` (or a human `pnpm daemon:stable` " +
          "relaunch) is needed before they take effect, for every project this daemon serves. Card 8ff7ccde: " +
          "`distBuiltAt` is an ON-DISK ARTIFACT clock (newest dist mtime) and can be NEWER than the code " +
          "this process is actually executing — a rebuild that lands without a restart advances it while " +
          "the process keeps running whatever it loaded at its own start. `stale`/`commitsBehind` are " +
          "computed against `runningCodeBuiltAt` (= `min(distBuiltAt, processStartedAt)`, the honest bound " +
          "on what this process could actually be executing), NOT the raw `distBuiltAt` — do not compute " +
          "your own staleness from `distBuiltAt` alone, it can UNDERSTATE it. `distAheadOfProcess:true` " +
          "means the on-disk artifact has been rebuilt since this process started and it hasn't picked that " +
          "rebuild up yet (a restart would additionally pick it up), surfaced as its own field so it's " +
          "legible even when `commitsBehind` itself still reads 0. `webStale`/`webCommitsBehind` (card " +
          "c3ce92ea) are the SEPARATE web signal — " +
          "`packages/web/src` commits not yet reflected in the served `packages/web/dist`. `webStale:true` " +
          "means REBUILD web, NOT restart the daemon: the daemon serves `packages/web/dist` live from disk, " +
          "so a rebuilt file is served on the very next request — do not advise a `daemon_restart` for a " +
          "web-only staleness reading; that drops every live session across ALL projects for no reason. " +
          "`available:false` (with `reason`) means this daemon isn't running from a Loom source checkout " +
          "(e.g. a packaged `loomctl` install) or the check failed — not a claim of freshness either way, " +
          "and it applies to BOTH signals together (never one without the other).",
        inputSchema: strictShape({}),
      },
      async () => {
        const webDist = resolveWebDistDir();
        let webBundle: string | null = null;
        try {
          const assetsDir = path.join(webDist, "assets");
          webBundle = fs.readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f)) ?? null;
        } catch { /* dist not built / no assets dir — webBundle stays null */ }
        const liveSessionCount = db.listAllSessions().filter((s) => s.processState === "live").length;
        return ok({
          version: loomVersion(),
          webBundle,
          uptimeSeconds: Math.round(process.uptime()),
          liveSessionCount,
          deployStaleness: computeDeployStaleness(),
        });
      },
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
          "continuationPrompt, re-parents your live workers onto it, and then closes you. `continuationPrompt` " +
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
          return ok({ newManagerSessionId: fresh.id, gen: fresh.gen });
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

    server.registerTool(
      "idle_report",
      {
        description:
          "Tell Loom's idle watchdog your disposition so it stops nudging you — call it when you end a " +
          "turn with no active work. `state`: 'working' = back at it (resumes normal watching); 'waiting' " +
          "= nothing to do until something lands — optionally snooze for `minutes` (defaults to the " +
          "per-project idle snooze); 'done' = this agent's work is complete. If you need the human, file " +
          "a Request via `question_ask` instead. Always clears your unanswered-nudge counter. Pass a " +
          "short `detail` to say why (recorded for the human). `state` is the canonical param; `status` " +
          "is accepted as an ALIAS for it — pass either one (if both, state wins).",
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
          "leaves a flag unset)}, ordered by position.",
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
          "PLUS its resolved browserTesting/documentConversion/restrictedTools capability flags (from its " +
          "assigned/default profile — same resolution profile_get/profile_list use; false when profile-less " +
          "or the profile leaves a flag unset). Use this before a safe read-modify-write via agent_update " +
          "(its appendToStartupPrompt mode lets you add to what you read here without retyping the whole " +
          "prompt), and to check an agent's real provisioning before assuming it from its prompt. agentId " +
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
          };
        };
        const exact = agents.find((a) => a.id === agentId);
        if (exact) return ok(withResolvedFlags(exact));
        const r = resolveIdPrefix(agents, agentId);
        if (r.kind === "found") return ok(withResolvedFlags(r.record));
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
          "ids, never resolving to an arbitrary match.",
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
          "agent_assign_profile. Two ways to touch startupPrompt: `startupPrompt` REPLACES it wholesale (as " +
          "before); `appendToStartupPrompt` CONCATENATES onto the EXISTING prompt (joined with a blank line) " +
          "so you never have to round-trip the full text for a small addition — read the current prompt first " +
          "with agent_get. Passing BOTH in the same call is REJECTED (pick one). The target agent must be in " +
          "YOUR project (an agent outside it is REJECTED). agentId accepts the full id OR an unambiguous " +
          "8-char id-prefix (same resolution as agent_get) — an ambiguous prefix errors naming the candidate " +
          "ids, never resolving to an arbitrary match. Omitted fields are left as-is.",
        inputSchema: strictShape({
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          appendToStartupPrompt: z.string().optional(),
        }),
      },
      async ({ agentId, name, startupPrompt, appendToStartupPrompt }) => {
        try {
          return ok(sessions.updateAgentPreset(managerSessionId, agentId, { name, startupPrompt, appendToStartupPrompt }));
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
          "dangling profileId resolves to the plain backstop). 404 (\"profile not found\") if the id is unknown. " +
          "FULL id required (no 8-char prefix). Returns { deleted:true, profileId }.",
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
          "config is schema-validated on the AGENT path: orchestration.gateCommand (host-RCE) and unknown keys " +
          "are REJECTED (that capability stays human-only). repoPath is not editable here. Omitted top-level " +
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
          return ok(sessions.updateProjectStructural(managerSessionId, projectId, { name, vaultPath, config }));
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
          "your own (e.g. the reserved Loom Platform home) is REJECTED.",
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
          "the cron (e.g. \"Every day at 9:00 AM\").",
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
          "`name` is ignored (a schedule always keeps a name).",
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

    // --- Manager→Platform escalation (Platform Manager P4) ----------------------------------------
    // The ONE upward channel: a project manager reports a discovered Loom bug / friction UP to the
    // Platform Lead. DURABLE by design — it files a structured TASK onto the reserved "Loom Platform"
    // project's board (the Lead's inbox), which survives the common case where no Lead session is live.
    // This is ONE of the manager's two structured cross-project writes (the other is peer_message, below):
    // the target board here is HARDCODED to the reserved home server-side (the manager never names a
    // projectId), so it can never become a general cross-project task-write. Down-tree messaging stays
    // parent-scoped (worker_message); session_message (the Lead's un-scoped delivery) is the PLATFORM
    // surface, not here.
    server.registerTool(
      "platform_escalate",
      {
        description:
          "Escalate a discovered Loom bug or friction UP to the Platform Lead — or notify it of a status/" +
          "completion it asked to hear about. This is the " +
          "ONE durable channel for anything the Lead needs to know; don't invent an ad hoc 'I'll ping you' — " +
          "that reaches no one reliably. Files a DURABLE, structured task on the reserved Loom Platform " +
          "board (the Lead's inbox — it survives whether or not a Lead session is live), capturing your " +
          "origin project + this manager session, the title, the detail/evidence, and a severity. The target " +
          "is the Platform board, fixed server-side (you cannot pick a project) — for a LINKED peer " +
          "project's manager instead, use peer_message. Returns the created Platform task id plus a " +
          "`deliveryStatus` (delivered-live | queued | boarded | dropped): `boarded` means no Lead session " +
          "was live but the board task is durably filed (the normal, safe case) — a live Lead is nudged " +
          "immediately (even one that's currently parked waiting on exactly this); only `dropped` warrants " +
          "concern. DEDUPED: re-escalating the SAME title with an unchanged-or-lower severity while your " +
          "prior escalation is still UNRESOLVED (pending, unclaimed on the board — OR already being worked, " +
          "moved off the landing lane but not yet resolved) reuses that task instead of filing a duplicate " +
          "— the response carries `deduped: true` and no fresh Lead nudge is sent; check escalation_status " +
          "instead of re-escalating on a timer. A HIGHER severity than what's on file for that still-open " +
          "title is NOT deduped — it reuses the same task (no duplicate card) but files a fresh event and a " +
          "fresh Lead nudge, since the severity change is genuinely new information. SCOPE: this dedup is " +
          "PER-ORIGIN-PROJECT, against THIS PROJECT's own prior escalations by title only — a different " +
          "project escalating the SAME underlying finding is not deduped against yours and will land as " +
          "its own card (both are legitimate signals the Lead can triage independently), and it has no " +
          "visibility into a card filed by hand (tasks_create) or via peer_message for the SAME underlying " +
          "finding either, so a peer describing one incident in their own words can still land as a second, " +
          "unlinked card (see tasks_create's own cross-channel duplicate check, card 5b221bf2). Use it for " +
          "platform-level problems (a Loom bug, a confusing tool/skill, friction that " +
          "slowed your workers) or a completion/status update the Lead is waiting on — NOT for your own " +
          "project's task board (use tasks_create there). `detail` is the canonical param; `body` is " +
          "accepted as an ALIAS for it — pass either one (if both, detail wins).",
        inputSchema: strictShape({
          title: z.string(),
          detail: z.string().optional(),
          body: z.string().optional(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        }),
      },
      async ({ title, detail, body, severity }) => {
        const resolvedDetail = resolveAlias(detail, body);
        if (resolvedDetail === undefined) return ok({ error: "detail (or body) is required" });
        try {
          return ok(sessions.platformEscalate(managerSessionId, { title, detail: resolvedDetail, severity }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager↔manager cross-project channel (board card 2349d90c) --------------------------------
    // The manager's OTHER structured cross-project write, alongside platform_escalate above. Unlike that
    // hardcoded-target escalation, `targetProjectId` here is caller-chosen but gated server-side on
    // `project_links` — an owner-declared, HUMAN-only table with NO MCP path (an agent can never create a
    // link itself, only use one the owner already made). Delivers ONLY to the target project's LIVE
    // manager session (never a worker/platform/auditor); when none is live, the message is durably boarded
    // on the target project's own board instead of dropped. Reuses the same framed, kind:"agent",
    // one-per-turn delivery channel as worker_message/session_message — a data message only, no privilege
    // travels with it. Rate-limited per calling manager session.
    //
    // Both peer_message and peer_list are registered ONLY when this project has ≥1 project_links row
    // (hasPeerLinks above, `db.listProjectLinks()` read directly — a deliberate SUPERSET of what
    // sessions.listPeerProjects/peer_list actually returns, which ALSO drops an archived/missing peer via
    // `.filter(p => !p.archivedAt)`). Safe either way: hasPeerLinks:false means NO link touches this
    // project at all, so peer_list is guaranteed empty and peer_message would always reject "not linked" —
    // a working peer tool is never hidden. It's only slightly over-inclusive when this project's SOLE link
    // points to an archived/missing peer: both tools stay registered but peer_list still reports zero
    // peers and peer_message still rejects "not linked" — the exact pre-trim always-registered behavior,
    // just no longer the common case. So most projects (linking is an owner-only, opt-in action) never
    // need either tool in their floor. A link added later appears on the manager's very next tool call
    // (buildServer is
    // rebuilt fresh per request — see handle() below).
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
            "projectId as ITS targetProjectId — no need to ask the owner to relay it.",
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
    }

    server.registerTool(
      "escalation_status",
      {
        description:
          "READ-ONLY: check whether the Platform Lead has picked up / resolved an escalation YOUR PROJECT " +
          "filed via platform_escalate — closes the gap where a manager re-escalates work the Lead already " +
          "claimed. Pass `taskId` (the id platform_escalate returned, OR an unambiguous 8-char id-prefix — " +
          "the paste-able short id Loom displays) to check one escalation; omit it to LIST your project's " +
          "escalations. The list defaults to OPEN escalations only — status pending or in_progress — most-" +
          "recent first; pass `includeResolved:true` to get the full history back (every escalation ever " +
          "filed, including resolved/closed). Scoped server-side to YOUR OWN project's origin — a taskId " +
          "outside that set (another project's escalation, or unknown) returns `{found:false}` uniformly, " +
          "never an error, so this can't be used to probe another project's escalations; an AMBIGUOUS " +
          "prefix that matches more than one of YOUR OWN escalations returns a \"did you mean\" error " +
          "naming the candidates (pass more characters or the full id) — " +
          "Each escalation reports its CURRENT title (the Lead may have refined it — " +
          "itself a sign it was seen), a `status` of pending (still in the landing lane — not yet picked " +
          "up), in_progress (moved into a working lane — picked up), resolved (in a done/terminal column), " +
          "or closed (the task was deleted/archived), its columnKey, and updatedAt. No writes.",
        inputSchema: strictShape({ taskId: z.string().optional(), includeResolved: z.boolean().optional() }),
      },
      async ({ taskId, includeResolved }) => {
        try {
          return ok(sessions.escalationStatus(managerSessionId, { taskId, includeResolved }));
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
          "reassign via board_column_rename on the existing holder first if you want to move one). The new " +
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
          "terminal) is HARD-REJECTED unless another column already carries that role (reassign it first via " +
          "board_column_rename, or on the column you're keeping, before deleting this one). A board must " +
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

  /** HTTP entry for /mcp-orch/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    const resolved = this.resolveRole(sessionId);
    if (!resolved) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no orchestration surface for this session" }));
      return;
    }

    // Stateless per request (see TaskMcpRouter): no cached transport to be deleted on a transient
    // onclose, so the worker_* surface can't vanish mid-session. Rebuilt each call from the role.
    const server = this.buildServer(sessionId, resolved.role);
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
