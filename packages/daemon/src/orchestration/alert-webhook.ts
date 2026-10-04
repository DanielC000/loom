// Outbound alert-webhook emitter (Richer-notifications, external delivery). Hooks the single
// orchestration-event chokepoint (`Db.appendEvent` via `Db.setEventListener`) and, for each event
// whose project has a HUMAN-configured `orchestration.alertWebhook` matching the event kind, POSTs a
// small JSON payload to that URL — so the human is alerted OUTSIDE the UI while away.
//
// CONTRACT — best-effort + bounded, never in the critical path:
//   - delivery is fire-and-forget (the event-path caller never waits on the network);
//   - a per-POST timeout bounds a slow/hung endpoint;
//   - ALL errors (bad config, DNS, non-2xx, timeout) are swallowed/logged — a delivery fault must
//     NEVER throw into the orchestration event path.
//
// SECURITY: the webhook URL is read from the resolved project config, which the agent-facing config
// validator REJECTS (it's a data-exfiltration vector — human-set only, like gateCommand). This module
// only READS that config; it mints nothing.
import { resolveConfig } from "@loom/shared";
import type { OrchestrationEvent, Project, Session } from "@loom/shared";
import { guardedFetch } from "../connections/boundedFetch.js";

/** The network primitive (injectable for tests). Resolves on completion; rejects on error/timeout. */
export type WebhookPoster = (url: string, body: unknown, timeoutMs: number) => Promise<void>;

/**
 * Default poster: routed through the shared `guardedFetch` helper (card 731aa517 round 2) — the
 * human-set `hook.url` IS itself the secret here (e.g. a Slack incoming-webhook URL), so a redirect must
 * never be auto-followed and a hung endpoint is bounded. `treatRedirectAsError` stays at its default
 * (`true`): no known webhook provider legitimately redirects a POST target. The response body is never
 * read — `onEvent`'s caller logs (never retries) on a throw, but a large/slow 2xx body still has no use
 * here, so success is judged by HTTP status alone and the unread body is cancelled rather than
 * buffered-and-capped, instead of letting a slow/oversized-but-delivered body turn into a throw.
 */
export const defaultPost: WebhookPoster = async (url, body, timeoutMs) => {
  const guarded = await guardedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!guarded.ok) {
    // Distinct, diagnosable reasons per kind — status code only, NEVER the Location header or the URL
    // itself (the URL is the secret here).
    if (guarded.kind === "redirect") throw new Error(`alert webhook refused a redirect (HTTP ${guarded.status})`);
    throw new Error(guarded.error);
  }
  const status = guarded.response.status;
  await guarded.response.body?.cancel().catch(() => {});
  guarded.cancelTimeout();
  if (status < 200 || status >= 300) throw new Error(`alert webhook endpoint returned ${status}`);
};

/** The DB reads the emitter needs (narrowed for testability — only a project/session lookup). */
type DbReads = {
  getSession(id: string): Session | undefined;
  getProject(id: string): Project | undefined;
};

export interface AlertWebhookDeps {
  db: DbReads;
  /** Network primitive override (tests inject a stub). Defaults to a bounded fetch POST. */
  post?: WebhookPoster;
  /**
   * Per-POST timeout in ms (bounds a hung endpoint). TEST OVERRIDE only: when set it wins, so a test
   * can pin the bound deterministically. In production this is LEFT UNSET and the timeout is read
   * RESOLVE-LIVE per event from the project's `orchestration.alertWebhookTimeoutMs` (default 5000) —
   * so a human PATCH to that value takes effect with no daemon restart.
   */
  timeoutMs?: number;
  /** Optional structured log sink for swallowed delivery errors (defaults to console.warn). */
  onError?: (message: string) => void;
}

export class AlertWebhookEmitter {
  private readonly db: DbReads;
  private readonly post: WebhookPoster;
  /** Test override; undefined in production (the per-project resolved timeout is used instead). */
  private readonly timeoutMs: number | undefined;
  private readonly onError: (message: string) => void;

  constructor(deps: AlertWebhookDeps) {
    this.db = deps.db;
    this.post = deps.post ?? defaultPost;
    this.timeoutMs = deps.timeoutMs;
    this.onError = deps.onError ?? ((m) => console.warn(`[alert-webhook] ${m}`));
  }

  /**
   * The `Db.setEventListener` callback. Fire-and-forget: kicks off delivery and returns its
   * error-guarded promise WITHOUT the caller needing to await it. Returns the promise (already
   * `.catch`-guarded so it never rejects) purely so tests can deterministically await delivery.
   */
  onEvent(evt: OrchestrationEvent): Promise<void> {
    return this.deliver(evt).catch((err) => {
      this.onError(`delivery failed for ${evt.kind}: ${(err as Error).message}`);
    });
  }

  /** Resolve config, gate on the configured webhook + matching kind, then POST the payload. */
  private async deliver(evt: OrchestrationEvent): Promise<void> {
    const project = this.resolveProject(evt);
    if (!project) return;
    // RESOLVE-LIVE: read the webhook AND its per-POST timeout fresh from the project config each event,
    // so a human PATCH to either takes effect with no daemon restart. A test-injected `timeoutMs` wins.
    const orchestration = resolveConfig(project.config).orchestration;
    const hook = orchestration.alertWebhook;
    if (!hook?.url || !hook.events.includes(evt.kind)) return; // not configured / kind not subscribed
    const timeoutMs = this.timeoutMs ?? orchestration.alertWebhookTimeoutMs;
    // Payload the human's endpoint receives. Matches the card shape ({event, project, ts, detail})
    // plus the lineage ids so an alert says WHICH worker/task it concerns.
    const payload = {
      event: evt.kind,
      project: { id: project.id, name: project.name },
      ts: evt.ts,
      detail: evt.detail ?? null,
      managerSessionId: evt.managerSessionId,
      workerSessionId: evt.workerSessionId ?? null,
      taskId: evt.taskId ?? null,
    };
    await this.post(hook.url, payload, timeoutMs);
  }

  /** Every event carries a managerSessionId; derive its project (server-side, never agent-supplied). */
  private resolveProject(evt: OrchestrationEvent): Project | undefined {
    const session = this.db.getSession(evt.managerSessionId);
    if (!session) return undefined;
    return this.db.getProject(session.projectId);
  }
}
