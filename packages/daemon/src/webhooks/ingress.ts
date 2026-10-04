/**
 * Inbound webhook ingress — the Tier-2 public route handler (agent-tooling epic P5b, card 8fbedcac).
 * Registers `POST /hooks/:endpointPath` on an ALREADY-ENCAPSULATED Fastify sub-plugin (see
 * `registerWebhookIngress` below) so the raw-body content-type parser it installs never leaks into any
 * other route's default JSON parsing.
 *
 * Verify-before-any-work ordering (must-fix, card 8fbedcac): every step below that can reject a request
 * (1-2 unknown/disabled endpoint, 3 signature verify) runs BEFORE any state-mutating call — the
 * idempotency-dedupe INSERT, the per-endpoint rate-cap consumption, and the wake/spawn fire are all
 * downstream of a PASSED verify. Cross-tier isolation is structural, not enforced here: the trust-tier
 * onRequest hook (gateway/server.ts) never reads an Authorization header at all for a Tier-2 route, so a
 * Tier-1 gateway token has no code path that could matter on this route in the first place.
 */
import type { FastifyInstance } from "fastify";
import type { Db, WebhookEndpointRow } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import { decryptWebhookSecret } from "./store.js";
import { verifyWebhookSignature, webhookDeliveryRetentionMs, type WebhookHeaders } from "./verify.js";
import { formatWebhookEventBlock } from "./format.js";
import { SlidingWindowCounter } from "../gateway/remote-rate-limit.js";

/** 1 MB — the spike's guidance is 64-256KB; 1MB is a safe practical ceiling that still covers a
 *  realistic large GitHub push payload while bounding the memory-DoS surface on a public endpoint (must-
 *  fix: body-size-cap-BEFORE-buffer — this is a Fastify route-level `bodyLimit`, enforced by Fastify's own
 *  request lifecycle before the raw-body content-type parser below ever buffers the body). A per-endpoint
 *  override is a reasonable future seam, not v1. */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
/** Default per-endpoint spawn-rate cap (fires/min) — a flood of AUTHENTIC (signature-valid) events must
 *  not spawn unbounded sessions. A per-endpoint override is a reasonable future seam, not v1. */
const DEFAULT_SPAWN_RATE_PER_MIN = 10;

export interface WebhookIngressDb {
  getWebhookEndpointByPath: Db["getWebhookEndpointByPath"];
  hasWebhookDelivery: Db["hasWebhookDelivery"];
  recordWebhookDelivery: Db["recordWebhookDelivery"];
  deleteWebhookDelivery: Db["deleteWebhookDelivery"];
  updateWebhookEndpointLastFired: Db["updateWebhookEndpointLastFired"];
  /** Card a21f5c9e — the wake-mode target's role, so `fireWebhookTarget` can pass it to
   *  `SessionService.enqueueDurableNudge` (it needs to know whether to gate on `waitForMcpSeen`). */
  getSession: Db["getSession"];
}

export interface WebhookIngressDeps {
  db: WebhookIngressDb;
  sessions: Pick<SessionService, "startNew" | "resume" | "enqueueDurableNudge">;
  pty: Pick<PtyHost, "isAlive">;
  /** Envelope key file override — test seam only (mirrors connections/store.ts's `keyPath`). */
  keyPath?: string;
  /** Injectable per-endpoint spawn-rate limiter — test seam (mirrors createRemoteRateLimiter's own shape
   *  in gateway/remote-rate-limit.ts, which this reuses directly rather than a bespoke counter). */
  spawnRateLimiter?: SlidingWindowCounter;
  spawnRatePerMin?: number;
  /** Injectable clock — test seam (mirrors spawnRateLimiter's own shape), so a test can pin `now` to a
   *  fixed instant instead of depending on the real wall clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Card a21f5c9e — injectable per-(endpoint,deliveryId) replay-cooldown limiter — test seam, same shape
   *  as `spawnRateLimiter`. See `REPLAY_COOLDOWN_MS`'s own doc for what this bounds and why. */
  replayCooldownLimiter?: SlidingWindowCounter;
  replayCooldownMs?: number;
}

/** Card a21f5c9e — at most ONE fire ATTEMPT per (endpoint, deliveryId) per this window (checked BEFORE the
 *  dedupe row is recorded, same shape as the per-endpoint spawn-rate cap just below it). Without it, a
 *  captured delivery replayed against a permanently-broken target would undo-and-refire on every single
 *  replay, bounded only by the per-endpoint spawn-rate cap (`DEFAULT_SPAWN_RATE_PER_MIN`) — up to 10
 *  dedupe-row write/delete cycles a minute, and for spawn mode, 10 new (immediately-exited) session rows a
 *  minute, indefinitely, for as long as the target stays broken. A replay blocked by this gate never
 *  records a dedupe row at all (mirrors the rate-limiter's own "never record a dropped delivery" rule), so
 *  it is ALWAYS harmless to a later genuine redelivery — the fire's own `.catch()` still ALWAYS undoes the
 *  dedupe row on failure, unconditionally; this gate bounds how often that cycle can repeat, it never skips
 *  the undo itself. See the decision record for why a per-id attempt CAP was rejected in favor of this
 *  cooldown, and what a legitimately-retrying sender experiences. */
export const REPLAY_COOLDOWN_MS = 60_000;

/** Deliver an already-verified, already-deduped event to its endpoint's wake/spawn target.
 *
 *  @decision 72c58b1c — every branch must reject on a failure that means NO delivery effect happened, and
 *  only that; the caller's `.catch()` undoes the dedupe row on that basis alone. See the decision record
 *  for the full rule, the two throw/no-throw branches' individual guarantees, and known residuals.
 *  @decision a21f5c9e — wake mode now converges onto the SAME MCP-seen-gated durable
 *  `SessionService.enqueueDurableNudge` path `EventTriggerService.fire` uses (card 90b9e904); "reject"
 *  here no longer means the same thing it used to — see the decision record for the full rule. */
async function fireWebhookTarget(deps: WebhookIngressDeps, endpoint: WebhookEndpointRow, kickoff: string, nowIso: string): Promise<void> {
  if (endpoint.mode === "wake") {
    const sessionId = endpoint.targetSessionId!;
    if (!deps.pty.isAlive(sessionId)) await deps.sessions.resume(sessionId);
    const role = deps.db.getSession(sessionId)?.role ?? null;
    await new Promise<void>((resolve, reject) => {
      deps.sessions.enqueueDurableNudge(sessionId, role, kickoff, null, {
        kind: "agent",
        onOutcome: (outcome) => {
          // `dispatched:false` is the ONE case the enqueue itself never landed — nothing is sitting in
          // the recipient's pty state AND no durable record survived either — reject so the caller undoes
          // the dedupe row, same as the pre-convergence "dropped" rejection. `dispatched:true` (even for an
          // underlying "dropped" `deliveryState`, or a post-effect durability write that failed on an
          // already-landed "queued" enqueue — see the decision record's Round 3) means something real
          // survives the attempt; it is NOT the same guarantee as immediate delivery.
          if (outcome.dispatched) resolve();
          else reject(new Error(`enqueueDurableNudge never dispatched the webhook nudge for session ${sessionId} (the enqueue itself never landed)`));
        },
      });
    });
  } else {
    deps.sessions.startNew(endpoint.agentId!, { kickoffPrompt: kickoff });
  }
  // @decision 72c58b1c — best-effort, deliberately OUTSIDE the failure that undoes the dedupe row: a
  // failure here (SQLITE_BUSY, a closed db) must never make an already-successful fire look like it failed.
  try {
    deps.db.updateWebhookEndpointLastFired(endpoint.id, nowIso);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[webhook] endpoint ${endpoint.id} (${endpoint.name}) failed to stamp lastFiredAt after a successful fire (informational only, not fatal):`, (e as Error).message);
  }
}

/**
 * Register the Tier-2 webhook ingress route on `app`. Call ONCE from `buildServer` — the encapsulation
 * (`app.register(async (instance) => ...)`) is what scopes the raw-body content-type parser to ONLY this
 * route; every other POST route on `app` keeps Fastify's default JSON parsing untouched.
 */
export function registerWebhookIngress(app: FastifyInstance, deps: WebhookIngressDeps): void {
  const rateLimiter = deps.spawnRateLimiter ?? new SlidingWindowCounter();
  const spawnRatePerMin = deps.spawnRatePerMin ?? DEFAULT_SPAWN_RATE_PER_MIN;
  const now = deps.now ?? Date.now;
  const replayCooldownMs = deps.replayCooldownMs ?? REPLAY_COOLDOWN_MS;
  const replayCooldownLimiter = deps.replayCooldownLimiter ?? new SlidingWindowCounter(replayCooldownMs);
  // Deprecation warning for a generic endpoint still on the LEGACY (pre-07af871d) signature format —
  // logged ONCE per endpoint id (disclosure-safe: no payload/secret/signature content), so a human running
  // the daemon notices without the log line repeating on every single delivery.
  const legacyFormatWarned = new Set<string>();

  app.register(async (instance) => {
    // RAW-body capture (must-fix): overrides the JSON parser ONLY within this encapsulated plugin — HMAC
    // is computed over these EXACT bytes, never a re-serialized req.body (the #1 webhook-verify bug: a
    // JSON.stringify(parsed) round-trip can byte-differ from what the sender actually signed).
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    instance.post("/hooks/:endpointPath", { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
      const { endpointPath } = req.params as { endpointPath: string };
      const endpoint = deps.db.getWebhookEndpointByPath(endpointPath);
      // Unknown OR disabled endpoint → the SAME 404 either way (don't leak existence/status).
      if (!endpoint || !endpoint.enabled) return reply.code(404).send({ error: "not found" });

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let secret: string;
      try {
        secret = decryptWebhookSecret(endpoint, deps.keyPath);
      } catch {
        // Corrupt/undecryptable stored secret — never a 5xx that hints at server-side state; the caller
        // gets the SAME rejection shape as a bad signature.
        return reply.code(401).send({ error: "verification failed" });
      }

      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const result = verifyWebhookSignature(endpoint.sourceType, secret, rawBody, req.headers as WebhookHeaders, nowMs);
      // A rejection can carry its own status (e.g. 400 for a malformed X-Loom-Delivery-Id) — anything
      // else defaults to 401, the historical "verification failed" shape for every other case.
      if (!result.ok) return reply.code(result.httpStatus ?? 401).send({ error: "verification failed" });
      const deliveryId = result.deliveryId!;
      if (deliveryId.startsWith("generic:legacy:") && !legacyFormatWarned.has(endpoint.id)) {
        legacyFormatWarned.add(endpoint.id);
        // eslint-disable-next-line no-console
        console.warn(`[webhook] endpoint ${endpoint.id} is using the deprecated pre-07af871d generic signature format (delivery id not bound into the signature) — see docs/decisions/07af871d-webhook-delivery-dedupe-signed-value.md to migrate`);
      }

      // Idempotency (must-fix): a provider's at-least-once retry of the SAME delivery is ACK'd and
      // dropped, never a second spawn.
      if (deps.db.hasWebhookDelivery(endpoint.id, deliveryId)) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      // Per-endpoint spawn-rate cap (must-fix), checked BEFORE the dedupe row is written (card 07af871d):
      // a flood of AUTHENTIC events must not spawn unbounded sessions. Still ACK 2xx (so the provider
      // doesn't retry-storm on a non-2xx) but drop the fire — and, critically, NEVER record the dedupe
      // row for a delivery that was dropped here. Recording it anyway would permanently swallow a genuine
      // delivery: any later redelivery of the SAME id (a provider's manual "resend" button, or the same
      // delivery arriving again once capacity frees up) would then dead-end on the dedupe check above
      // instead of getting a chance to actually fire.
      if (!rateLimiter.allow(`webhook:${endpoint.id}`, spawnRatePerMin, nowMs)) {
        return reply.code(200).send({ ok: true, rateLimited: true });
      }

      // Replay-cooldown gate (card a21f5c9e), checked BEFORE the dedupe row is written — SAME shape and
      // SAME reasoning as the rate-limit check just above: a target that fails EVERY fire must not let a
      // replayed delivery undo-and-refire unboundedly (bounded only by the rate cap above). At most one
      // fire ATTEMPT per (endpoint, deliveryId) per `replayCooldownMs`; a replay blocked here records NO
      // dedupe row, so it never swallows a genuine later redelivery — it just gets a fresh chance once the
      // cooldown elapses. Keyed on the COMPOSITE `${endpoint.id}:${deliveryId}`, never deliveryId alone
      // (collision across unrelated endpoints) or endpoint.id alone (that's the rate limiter's job).
      // @decision a21f5c9e — a cooldown-blocked replay is NEVER `duplicate:true` (it reaches this gate
      // only after a prior fire failed and undid its own row) — 429 + Retry-After + `{replayCooldown:true}`.
      if (!replayCooldownLimiter.allow(`${endpoint.id}:${deliveryId}`, 1, nowMs)) {
        const retryAfterSec = Math.max(1, Math.ceil(replayCooldownLimiter.retryAfterMs(`${endpoint.id}:${deliveryId}`, nowMs) / 1000));
        // eslint-disable-next-line no-console
        console.warn(`[webhook] endpoint ${endpoint.id} replay cooldown`);
        return reply.code(429).header("Retry-After", String(retryAfterSec)).send({ replayCooldown: true });
      }

      let payload: unknown;
      try { payload = JSON.parse(rawBody.toString("utf8")); } catch { payload = rawBody.toString("utf8"); }
      // The untrusted-DATA envelope (must-fix) — reuses poll-format.ts's established framing.
      const kickoff = formatWebhookEventBlock(endpoint.sourceType, endpoint.name, payload);

      // ACK 2xx FAST + spawn OUT-OF-BAND (must-fix): the response is sent BEFORE the wake/spawn fire, so
      // a session boot never holds the provider's HTTP connection open.
      reply.code(200).send({ ok: true });

      // PER-SCHEME retention (Code Reviewer fix, card 8fbedcac): a timestampless scheme's dedupe row is
      // its ONLY replay defense (see webhookDeliveryRetentionMs's doc) — sweeping it on the same short
      // window a timestamp-bearing scheme uses would let a captured GitHub delivery replay successfully
      // once some LATER delivery on this endpoint triggers a sweep past that point.
      //
      // @decision 72c58b1c — record immediately before the fire, with no `await` introduced between the
      // `hasWebhookDelivery` check above and this INSERT; the fire's own `.catch()` below is the ONE undo
      // point for every failure downstream of this line.
      const cutoffIso = new Date(nowMs - webhookDeliveryRetentionMs(endpoint.sourceType)).toISOString();
      deps.db.recordWebhookDelivery(endpoint.id, deliveryId, nowIso, cutoffIso);

      fireWebhookTarget(deps, endpoint, kickoff, nowIso).catch((err) => {
        // A failed fire (resume/startNew throwing, or enqueueStdin/enqueueDurableNudge reporting a drop —
        // see fireWebhookTarget's own doc) must not leave this delivery permanently deduped for the rest of
        // the retention window (card 72c58b1c) — undo the row recorded above so a genuine redelivery of the
        // SAME event gets a real chance to fire. The original fire error is logged FIRST and
        // unconditionally: a failure to remove the row (SQLITE_BUSY, a closed db at shutdown) must never
        // suppress the record of what actually broke.
        // eslint-disable-next-line no-console
        console.error(`[webhook] endpoint ${endpoint.id} (${endpoint.name}) fire failed:`, (err as Error).message);
        try {
          deps.db.deleteWebhookDelivery(endpoint.id, deliveryId);
        } catch (deleteErr) {
          // eslint-disable-next-line no-console
          console.error(`[webhook] endpoint ${endpoint.id} (${endpoint.name}) failed to remove its dedupe row after the fire failure above — this delivery stays deduped until retention sweeps it:`, (deleteErr as Error).message);
        }
      });
    });
  });
}
