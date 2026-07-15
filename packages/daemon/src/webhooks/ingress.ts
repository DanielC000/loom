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
  updateWebhookEndpointLastFired: Db["updateWebhookEndpointLastFired"];
}

export interface WebhookIngressDeps {
  db: WebhookIngressDb;
  sessions: Pick<SessionService, "startNew" | "resume">;
  pty: Pick<PtyHost, "isAlive" | "enqueueStdin">;
  /** Envelope key file override — test seam only (mirrors connections/store.ts's `keyPath`). */
  keyPath?: string;
  /** Injectable per-endpoint spawn-rate limiter — test seam (mirrors createRemoteRateLimiter's own shape
   *  in gateway/remote-rate-limit.ts, which this reuses directly rather than a bespoke counter). */
  spawnRateLimiter?: SlidingWindowCounter;
  spawnRatePerMin?: number;
}

/** Deliver an already-verified, already-deduped event to its endpoint's wake/spawn target — mirrors
 *  `EventTriggerService.fire`'s own wake/spawn branching exactly (gateway/../orchestration/event-triggers.ts). */
async function fireWebhookTarget(deps: WebhookIngressDeps, endpoint: WebhookEndpointRow, kickoff: string, nowIso: string): Promise<void> {
  if (endpoint.mode === "wake") {
    const sessionId = endpoint.targetSessionId!;
    if (!deps.pty.isAlive(sessionId)) await deps.sessions.resume(sessionId);
    // kind:"agent" — a webhook-driven nudge is its own turn, never mashed with anything else queued.
    deps.pty.enqueueStdin(sessionId, kickoff, "system", undefined, undefined, "agent");
  } else {
    deps.sessions.startNew(endpoint.agentId!, { kickoffPrompt: kickoff });
  }
  deps.db.updateWebhookEndpointLastFired(endpoint.id, nowIso);
}

/**
 * Register the Tier-2 webhook ingress route on `app`. Call ONCE from `buildServer` — the encapsulation
 * (`app.register(async (instance) => ...)`) is what scopes the raw-body content-type parser to ONLY this
 * route; every other POST route on `app` keeps Fastify's default JSON parsing untouched.
 */
export function registerWebhookIngress(app: FastifyInstance, deps: WebhookIngressDeps): void {
  const rateLimiter = deps.spawnRateLimiter ?? new SlidingWindowCounter();
  const spawnRatePerMin = deps.spawnRatePerMin ?? DEFAULT_SPAWN_RATE_PER_MIN;

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

      const result = verifyWebhookSignature(endpoint.sourceType, secret, rawBody, req.headers as WebhookHeaders, Date.now());
      if (!result.ok) return reply.code(401).send({ error: "verification failed" });
      const deliveryId = result.deliveryId!;

      // Idempotency (must-fix): a provider's at-least-once retry of the SAME delivery is ACK'd and
      // dropped, never a second spawn.
      if (deps.db.hasWebhookDelivery(endpoint.id, deliveryId)) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      // PER-SCHEME retention (Code Reviewer fix, card 8fbedcac): a timestampless scheme's dedupe row is
      // its ONLY replay defense (see webhookDeliveryRetentionMs's doc) — sweeping it on the same short
      // window a timestamp-bearing scheme uses would let a captured GitHub delivery replay successfully
      // once some LATER delivery on this endpoint triggers a sweep past that point.
      const cutoffIso = new Date(nowMs - webhookDeliveryRetentionMs(endpoint.sourceType)).toISOString();
      deps.db.recordWebhookDelivery(endpoint.id, deliveryId, nowIso, cutoffIso);

      // Per-endpoint spawn-rate cap (must-fix): a flood of AUTHENTIC events must not spawn unbounded
      // sessions. Still ACK 2xx (so the provider doesn't retry-storm on a non-2xx) but drop the fire.
      if (!rateLimiter.allow(`webhook:${endpoint.id}`, spawnRatePerMin, nowMs)) {
        return reply.code(200).send({ ok: true, rateLimited: true });
      }

      let payload: unknown;
      try { payload = JSON.parse(rawBody.toString("utf8")); } catch { payload = rawBody.toString("utf8"); }
      // The untrusted-DATA envelope (must-fix) — reuses poll-format.ts's established framing.
      const kickoff = formatWebhookEventBlock(endpoint.sourceType, endpoint.name, payload);

      // ACK 2xx FAST + spawn OUT-OF-BAND (must-fix): the response is sent BEFORE the wake/spawn fire, so
      // a session boot never holds the provider's HTTP connection open.
      reply.code(200).send({ ok: true });
      fireWebhookTarget(deps, endpoint, kickoff, nowIso).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[webhook] endpoint ${endpoint.id} (${endpoint.name}) fire failed:`, (err as Error).message);
      });
    });
  });
}
