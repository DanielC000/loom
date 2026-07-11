import { randomUUID } from "node:crypto";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { PollJob } from "@loom/shared";
import type { AuthenticatedRequestResult } from "../connections/request.js";
import type { OrchestrationControl } from "./control.js";
import { isLikelyNearClaudeUsageLimit } from "./usage-awareness.js";
import { formatPollItemsBlock } from "./poll-format.js";

/** The slice of PtyHost PollService needs (mirrors WakePty, minus companion-route capture — a poll fire
 *  is never companion-origin). */
export interface PollPty {
  isAlive(sessionId: string): boolean;
  enqueueStdin(
    sessionId: string,
    text: string,
    source?: "human" | "system",
    onDeliver?: () => void,
    route?: undefined,
    kind?: "warning" | "agent",
  ): { delivered: boolean; position?: number };
}

export interface PollServiceDeps {
  db: Db;
  /**
   * Perform ONE poll job's fetch. Prod-wired to call the EXISTING P2 `performAuthenticatedRequest`
   * directly (server-side — there is no agent turn here, so this never goes through the MCP layer):
   * `performAuthenticatedRequest({db, keyPath, fetchImpl}, [job.connectionId], guard, {connection:
   * job.connectionId, path: job.path, method: job.method})`. Passing `[job.connectionId]` as the
   * session-allowlist is NOT a gating bypass: the job's use of ITS OWN connection was authorized by the
   * HUMAN who created the poll job over the human-only REST surface — the same trust posture as a human
   * granting a profile a connection. The secret is injected/redacted entirely inside that call and never
   * reaches this service, the db row, or the woken/spawned session. The test injects a stub (hermetic —
   * never a real network call).
   */
  request: (job: PollJob) => Promise<AuthenticatedRequestResult>;
  pty: PollPty;
  /** §17a safety rails: the SAME global pause/kill switch Scheduler/EventTriggerService gate on — a poll
   *  fire can spawn/wake a claude session exactly like a worker_spawn, so it MUST stop under a global
   *  pause too. */
  control: OrchestrationControl;
  /** Re-spawn a stopped-but-resumable wake-mode target. Prod-wired to SessionService.resume. */
  resume: (sessionId: string) => unknown;
  /**
   * Spawn a fresh spawn-mode session, handing it `kickoffPrompt` (the untrusted-framed DATA block, as
   * plain text — NOT yet composed with the agent's own brief) as its kickoff. Prod-wired to
   * `(agentId, kickoffPrompt) => sessions.startNew(agentId, { kickoffPrompt })`, which composes it with
   * the target agent's own startup prompt via the existing `composeWorkerStartupPrompt` shape (brief +
   * "---" + dynamic part) — reused verbatim, no new compose path.
   */
  spawn: (agentId: string, kickoffPrompt: string) => unknown;
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly. */
  intervalMs?: number;
  /** Same whole-tick usage-limit gate the Scheduler uses (a poll fire can wake/spawn a claude session,
   *  the same capped resource) — injectable for a deterministic test. */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
}

/** Poll cadence floor (anti-hammer, mirrors WakeService's MIN_DELAY_SECONDS) — enforced at REST create
 *  time, not here; the tick loop trusts the stored row. */
export const MIN_POLL_INTERVAL_MS = 60_000;
/** Cap on new items bundled into a single fire — an overflow note names how many more were dropped. */
const MAX_ITEMS_PER_FIRE = 20;
/** Backoff ceiling: a chronically-failing job's cadence never stretches past interval_ms * this. */
const MAX_BACKOFF_MULTIPLIER = 32; // 2^5

/** Resolve a dot-path (`"a.b.c"`) against a parsed JSON value; `""` means "the value itself". */
function getByPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  return dotPath.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

interface ExtractedItem { id: string | null; raw: unknown }

/** Parse a poll response body and pull out its items (via `itemsPath`) + each item's stable id (via
 *  `idPath`). A non-JSON body or an `itemsPath` that doesn't resolve to an array is a hard failure
 *  (routed through the same backoff path as a network error) — a missing per-item id is NOT a hard
 *  failure here (the caller's misconfig guard handles that; a partial id-miss is common on a real feed). */
function extractItems(bodyText: string, itemsPath: string, idPath: string): { ok: true; items: ExtractedItem[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: "poll response body was not valid JSON" };
  }
  const arr = getByPath(parsed, itemsPath);
  if (!Array.isArray(arr)) {
    return { ok: false, error: `itemsPath '${itemsPath || "(root)"}' did not resolve to an array` };
  }
  const items = arr.map((raw): ExtractedItem => {
    const v = getByPath(raw, idPath);
    return { id: v == null ? null : String(v), raw };
  });
  return { ok: true, items };
}

/**
 * PollService — the trigger layer for local poll jobs (agent-tooling epic P3). Mirrors Scheduler/
 * WakeService's shape: its own tick()/start()/stop(), CLAIM-FIRST (advance next_poll_at before the
 * fetch — Scheduler's finding-2 anti-double-fire), per-job try/catch (one bad job never blocks another
 * or crashes the tick). On a due tick it fetches through the EXISTING P2 authenticated_request path
 * (never a second outbound-HTTP path — already bounded + secret-redacted there), diffs the result against
 * the PREVIOUS poll's item-id snapshot (a snapshot-diff cursor: never accumulated, so storage stays
 * O(items-per-poll)), and on genuinely new items either wakes an existing session or spawns a fresh one
 * with the item(s) as an explicitly-untrusted kickoff.
 */
export class PollService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: PollServiceDeps) {}

  /**
   * One trigger pass over every due, enabled poll job. See the class doc for the overall shape; the
   * per-job try/catch commits the cursor/next_poll_at on SUCCESS but — for a job that has something new
   * to deliver — only AFTER delivery succeeds, so a throwing spawn/resume never silently drops the item
   * (the next successful poll re-detects the same fresh item(s) and retries, instead of a straight fetch
   * failure which never reaches the cursor at all).
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = this.deps.db.listDuePollJobs(now.toISOString());
    if (due.length === 0) return;
    // Pause gate (§17a global kill/pause switch, mirrors Scheduler.tick()/EventTriggerService.tick()):
    // hold everything while globally paused — every job's next_poll_at stays put, re-checked next tick.
    if (this.deps.control.pausedScopes().includes("global")) return;
    const recencyWindowMs = resolveConfig(undefined, this.deps.db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    if ((this.deps.isUsageLimited ?? isLikelyNearClaudeUsageLimit)(now, recencyWindowMs)) return;

    for (const job of due) {
      // Structural guards BEFORE the claim/fetch: a job whose connection or wake/spawn target is GONE
      // can never fire again — disable it instead of retrying forever (mirrors Scheduler's deleted-agent
      // handling, which disables rather than endlessly re-trying an un-fireable schedule).
      if (!this.deps.db.getConnection(job.connectionId)) {
        this.deps.db.updatePollJob(job.id, { enabled: false });
        // eslint-disable-next-line no-console
        console.error(`[poll] job ${job.id} disabled — connection ${job.connectionId} no longer exists`);
        continue;
      }
      if (job.mode === "wake" && !this.deps.db.getSession(job.sessionId ?? "")) {
        this.deps.db.updatePollJob(job.id, { enabled: false });
        // eslint-disable-next-line no-console
        console.error(`[poll] job ${job.id} disabled — target session ${job.sessionId} no longer exists`);
        continue;
      }
      if (job.mode === "spawn" && !this.deps.db.getAgent(job.agentId ?? "")) {
        this.deps.db.updatePollJob(job.id, { enabled: false });
        // eslint-disable-next-line no-console
        console.error(`[poll] job ${job.id} disabled — target agent ${job.agentId} no longer exists`);
        continue;
      }

      // CLAIM FIRST (Scheduler finding-2): advance next_poll_at BEFORE the fetch, so a throwing/hanging
      // fetch can't leave the slot un-advanced and double-fetch next tick. Overwritten again below once
      // the real outcome (success, or a backed-off failure) is known.
      const claimedNextPollAt = new Date(now.getTime() + job.intervalMs).toISOString();
      this.deps.db.claimPollJob(job.id, claimedNextPollAt);

      try {
        const result = await this.deps.request(job);
        if (!result.ok) throw new Error(result.error);
        const extracted = extractItems(result.body, job.itemsPath, job.idPath);
        if (!extracted.ok) throw new Error(extracted.error);

        // MISCONFIG GUARD: items are present but most lack an extractable id — a stable diff is
        // impossible, so firing would re-fire the SAME list every tick forever. Skip (neither a success
        // nor a backed-off failure — a human config fix is what resolves this, not a retry cadence);
        // next_poll_at stays at the plain claimed cadence (no backoff) and cursor/failures are untouched.
        const withId = extracted.items.filter((i) => i.id !== null).length;
        if (extracted.items.length > 0 && withId < extracted.items.length / 2) {
          this.emit("", now, "poll_id_guard_tripped", { pollJobId: job.id, itemCount: extracted.items.length, withIdCount: withId });
          continue;
        }

        // NOTE: this snapshot-diff is an AT-LEAST-ONCE property, not exactly-once — an item that scrolls
        // out of the feed window (evicted from a later poll's response) and later reappears is no longer
        // in the committed snapshot, so it re-fires. That's the deliberate O(items-per-poll) tradeoff (see
        // the class doc) — a re-fire on a rare reappearance is fine; silently losing an item is not.
        const currentIds = extracted.items.filter((i) => i.id !== null).map((i) => i.id as string);
        const cursorJson = JSON.stringify(currentIds);

        if (job.cursorJson === null) {
          // First successful poll: seed the baseline and fire NOTHING — a fresh job must never replay
          // the entire existing backlog as "new".
          this.deps.db.markPolled(job.id, { lastPolledAt: now.toISOString(), nextPollAt: claimedNextPollAt, cursorJson });
          this.emit("", now, "poll_baseline_seeded", { pollJobId: job.id, itemCount: currentIds.length });
          continue;
        }

        const prevIds = new Set(JSON.parse(job.cursorJson) as string[]);
        const fresh = extracted.items.filter((i) => i.id !== null && !prevIds.has(i.id));

        if (fresh.length === 0) {
          this.deps.db.markPolled(job.id, { lastPolledAt: now.toISOString(), nextPollAt: claimedNextPollAt, cursorJson });
          continue;
        }

        // Deliver BEFORE committing the cursor: if delivery throws, the cursor stays at the OLD
        // snapshot, so the SAME fresh item(s) are re-detected (and re-attempted) on the next successful
        // poll — a transient spawn/resume failure never silently drops an item.
        const capped = fresh.slice(0, MAX_ITEMS_PER_FIRE);
        const overflowItems = fresh.slice(MAX_ITEMS_PER_FIRE);
        const { sessionId } = await this.fire(job, capped.map((i) => i.raw), overflowItems.length);
        // Commit the cursor EXCLUDING the still-undelivered overflow tail: an item is only marked "seen"
        // once it has actually been delivered (the SAME at-least-once principle as the delivery-failure
        // path above, applied per-item instead of per-tick) — so the overflow re-surfaces as "fresh" again
        // next poll and DRAINS MAX_ITEMS_PER_FIRE-per-cadence until caught up, instead of being silently
        // dropped by being marked seen without ever having been delivered.
        const overflowIds = new Set(overflowItems.map((i) => i.id as string));
        const deliveredCursorJson = JSON.stringify(currentIds.filter((id) => !overflowIds.has(id)));
        this.deps.db.markPolled(job.id, { lastPolledAt: now.toISOString(), nextPollAt: claimedNextPollAt, cursorJson: deliveredCursorJson });
        this.emit(sessionId, now, "poll_fired", { pollJobId: job.id, itemCount: capped.length, mode: job.mode });
      } catch (e) {
        // Capped exponential backoff (never disable — a transient network/auth/rate-limit failure must
        // not permanently kill a cadence, mirrors the Scheduler's own reasoning for a thrown spawn).
        const failures = job.consecutiveFailures + 1;
        const backoffMultiplier = Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER);
        const nextPollAt = new Date(now.getTime() + job.intervalMs * backoffMultiplier).toISOString();
        this.deps.db.markPollFailed(job.id, { nextPollAt, error: (e as Error).message });
        this.emit("", now, "poll_fire_failed", { pollJobId: job.id, error: (e as Error).message, consecutiveFailures: failures });
        // eslint-disable-next-line no-console
        console.error(`[poll] job ${job.id} failed:`, (e as Error).message);
      }
    }
  }

  /** Deliver one already-deduped, already-capped fire: wake the existing session, or spawn a fresh one.
   *  Throws (never internally swallowed) so the caller's single failure/backoff path covers this too. */
  private async fire(job: PollJob, items: unknown[], overflow: number): Promise<{ sessionId: string }> {
    const conn = this.deps.db.getConnection(job.connectionId)!; // existence already checked this tick
    const block = formatPollItemsBlock(items, conn.host, overflow);

    if (job.mode === "wake") {
      const sessionId = job.sessionId!;
      if (!this.deps.pty.isAlive(sessionId)) await this.deps.resume(sessionId); // throws → caller's backoff path
      // kind:"agent" — a poll-triggered nudge is its own turn, never mashed with anything else queued.
      this.deps.pty.enqueueStdin(sessionId, `[loom:poll] New item(s) detected by a poll job.\n\n${block}`, "system", undefined, undefined, "agent");
      return { sessionId };
    }

    const session = (await this.deps.spawn(job.agentId!, `New item(s) detected by a poll job.\n\n${block}`)) as { id: string };
    return { sessionId: session.id };
  }

  private emit(
    sessionId: string,
    now: Date,
    kind: "poll_fired" | "poll_fire_failed" | "poll_baseline_seeded" | "poll_id_guard_tripped",
    detail: Record<string, unknown>,
  ): void {
    this.deps.db.appendEvent({ id: randomUUID(), ts: now.toISOString(), managerSessionId: sessionId, kind, detail });
  }

  /** Start ticking. Fires an immediate pass (mirrors WakeService) so a job overdue across a daemon
   *  restart doesn't wait a full cadence for its first retry. */
  start(now: Date = new Date()): void {
    void this.tick(now).catch(() => { /* never let a bad tick kill the loop */ });
    this.timer = setInterval(() => { void this.tick().catch(() => { /* never let a bad tick kill the loop */ }); }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
