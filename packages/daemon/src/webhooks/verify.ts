/**
 * Inbound webhook HMAC verification (agent-tooling epic P5b, card 8fbedcac) — the security-critical core
 * of the Tier-2 public ingress. Pure functions, no Fastify/db dependency, so the crypto is unit-testable
 * in isolation from the route plumbing (mirrors gateway/trust-tier.ts's own pure-function posture).
 *
 * Per-scheme signed content is bound to a TIMESTAMP wherever the provider sends one (stripe/standard/
 * generic) — this is what makes the 300s tolerance check meaningful: an attacker who captures a valid
 * signature can't replay it with a forged, in-window timestamp, because the timestamp is PART of what was
 * signed. GitHub sends no timestamp at all; its replay defense is delivery-id dedupe alone (the caller's
 * job, via `Db.hasWebhookDelivery`/`recordWebhookDelivery` — see webhooks/ingress.ts), not this module.
 *
 * Every comparison is `timingSafeEqual` over DECODED bytes, length-checked FIRST (timingSafeEqual throws
 * on a length mismatch rather than returning false) — never a `===` string compare, which would leak
 * timing information proportional to the number of matching leading bytes.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { WebhookSourceType } from "@loom/shared";

/** ±5 minutes — the verify recipe's replay-window bound, baked into every timestamp-bearing scheme's
 *  signed content (see module doc). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 300_000;

/** How long a delivery-id dedupe row (webhook_deliveries) must be RETAINED before it's eligible for the
 *  opportunistic sweep (see webhooks/ingress.ts / Db.recordWebhookDelivery) — deliberately PER-SCHEME
 *  (Code Reviewer fix, card 8fbedcac): for stripe/standard/generic, the timestamp bound into the signed
 *  content is the REAL replay defense (a captured signature can't be replayed with a forged-fresh
 *  timestamp), so a short retention tied to that same tolerance window is enough. GitHub sends no
 *  timestamp at all — its delivery-id dedupe row is its ONLY replay defense, so sweeping it away after a
 *  mere 600s would let a captured, validly-signed GitHub delivery replay successfully (a SECOND spawn) the
 *  moment some LATER delivery on the same endpoint triggers a sweep past that point. GitHub rows are
 *  retained far longer instead — still BOUNDED (never literally unbounded), just on a long horizon a
 *  captured delivery is very unlikely to still be replayed against. */
export const WEBHOOK_DELIVERY_SHORT_RETENTION_MS = WEBHOOK_TIMESTAMP_TOLERANCE_MS * 2; // 10 minutes
export const WEBHOOK_DELIVERY_LONG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Source types with NO timestamp in their signed content — see WEBHOOK_DELIVERY_LONG_RETENTION_MS's doc. */
const TIMESTAMPLESS_SOURCE_TYPES: ReadonlySet<WebhookSourceType> = new Set(["github"]);

/** The dedupe-row retention window for `sourceType` — the caller (webhooks/ingress.ts) computes its sweep
 *  cutoff from this rather than a single hardcoded window. */
export function webhookDeliveryRetentionMs(sourceType: WebhookSourceType): number {
  return TIMESTAMPLESS_SOURCE_TYPES.has(sourceType) ? WEBHOOK_DELIVERY_LONG_RETENTION_MS : WEBHOOK_DELIVERY_SHORT_RETENTION_MS;
}

export interface WebhookVerifyResult {
  ok: boolean;
  /** Present only when ok:true — the id this delivery dedupes on (see webhooks/ingress.ts). */
  deliveryId?: string;
  /** Present only when ok:false — a short, non-sensitive reason (never echoes secret/signature material). */
  reason?: string;
  /** Present only when ok:false, for a rejection that isn't a verification failure at all (e.g. a
   *  malformed X-Loom-Delivery-Id) — the caller (webhooks/ingress.ts) uses this instead of the default
   *  401 "verification failed". Absent means 401, the historical/default behavior for every other case. */
  httpStatus?: number;
}

/** Fastify's `req.headers` shape: a header may be absent, a single string, or (rarely) an array. Always
 *  takes the FIRST value — mirrors the existing Sec-WebSocket-Protocol handling in gateway/server.ts. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;
function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time equality over two byte buffers — length-guarded (timingSafeEqual throws on unequal
 *  lengths rather than returning false), so a length mismatch is itself decided in constant time relative
 *  to the SHORTER input rather than crashing the request. */
function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hmacSha256(secret: string | Buffer, data: Buffer): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** Best-effort delivery id for a scheme with no dedicated header — parses `.id` out of the JSON body
 *  (Stripe's Event object shape); falls back to a content hash so dedupe still functions on a payload
 *  that unexpectedly lacks one (never throws). */
function deliveryIdFromBody(rawBody: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    /* fall through to the hash fallback below */
  }
  return createHash("sha256").update(rawBody).digest("hex");
}

function verifyGithub(secret: string, rawBody: Buffer, headers: WebhookHeaders): WebhookVerifyResult {
  const sigHeader = header(headers, "x-hub-signature-256");
  const deliveryId = header(headers, "x-github-delivery");
  if (!sigHeader || !deliveryId) return { ok: false, reason: "missing X-Hub-Signature-256 or X-GitHub-Delivery header" };
  const m = /^sha256=([0-9a-f]+)$/i.exec(sigHeader.trim());
  if (!m) return { ok: false, reason: "malformed X-Hub-Signature-256 header" };
  const expected = hmacSha256(secret, rawBody);
  const provided = Buffer.from(m[1]!, "hex");
  if (!timingSafeEqualBuf(expected, provided)) return { ok: false, reason: "signature mismatch" };
  // GitHub sends no timestamp — no tolerance check applies to this scheme (see module doc); the dedupe
  // key is the replay defense here instead, and it's a hash of the SIGNED body bytes, never the raw
  // (unsigned) X-GitHub-Delivery header, so a replay under a fresh, never-seen delivery id still dedupes
  // to the SAME key. Card 07af871d.
  return { ok: true, deliveryId: `github:${createHash("sha256").update(rawBody).digest("hex")}` };
}

function verifyStripe(secret: string, rawBody: Buffer, headers: WebhookHeaders, nowMs: number): WebhookVerifyResult {
  const sigHeader = header(headers, "stripe-signature");
  if (!sigHeader) return { ok: false, reason: "missing Stripe-Signature header" };
  let t: string | undefined;
  // Stripe sends exactly one `t=`, but MAY send SEVERAL `v1=` entries during a signing-secret rotation
  // (Code Reviewer fix, card 8fbedcac) — collect every candidate rather than collapsing to the last one,
  // so a delivery whose valid signature isn't the LAST v1= in the header isn't wrongly rejected.
  const v1Candidates: string[] = [];
  for (const piece of sigHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1") v1Candidates.push(value);
  }
  if (!t || v1Candidates.length === 0 || !/^\d+$/.test(t)) return { ok: false, reason: "malformed Stripe-Signature header" };
  const tsMs = Number(t) * 1000;
  if (Math.abs(nowMs - tsMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) return { ok: false, reason: "timestamp outside tolerance" };
  const signedContent = Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]);
  const expected = hmacSha256(secret, signedContent);
  for (const v1 of v1Candidates) {
    if (!/^[0-9a-f]+$/i.test(v1)) continue;
    const provided = Buffer.from(v1, "hex");
    if (timingSafeEqualBuf(expected, provided)) return { ok: true, deliveryId: deliveryIdFromBody(rawBody) };
  }
  return { ok: false, reason: "signature mismatch" };
}

/** Standard Webhooks (standardwebhooks.com) — `webhook-id`/`webhook-timestamp`/`webhook-signature`
 *  headers; signed content is `${id}.${timestampSeconds}.${rawBody}`; the secret is the standard
 *  `whsec_<base64>` shape (prefix stripped + base64-decoded to raw key bytes); `webhook-signature` may
 *  carry several space-separated `v1,<base64sig>` candidates (secret-rotation support on the SENDER
 *  side) — any match is accepted. */
function verifyStandard(secret: string, rawBody: Buffer, headers: WebhookHeaders, nowMs: number): WebhookVerifyResult {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sigHeader = header(headers, "webhook-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing webhook-id/webhook-timestamp/webhook-signature header" };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: "malformed webhook-timestamp header" };
  const tsMs = Number(ts) * 1000;
  if (Math.abs(nowMs - tsMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) return { ok: false, reason: "timestamp outside tolerance" };
  const keyMaterial = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
  const signedContent = Buffer.from(`${id}.${ts}.${rawBody.toString("utf8")}`, "utf8");
  const expected = hmacSha256(keyMaterial, signedContent);
  const candidates = sigHeader.split(/\s+/).filter(Boolean);
  for (const candidate of candidates) {
    const comma = candidate.indexOf(",");
    if (comma === -1) continue;
    const version = candidate.slice(0, comma);
    const sigB64 = candidate.slice(comma + 1);
    if (version !== "v1") continue;
    let provided: Buffer;
    try { provided = Buffer.from(sigB64, "base64"); } catch { continue; }
    if (timingSafeEqualBuf(expected, provided)) return { ok: true, deliveryId: id };
  }
  return { ok: false, reason: "signature mismatch" };
}

// @decision 07af871d — this charset gates the CURRENT (v1) attempt ONLY, never LEGACY: a `.` in the id
// would make CURRENT's id/ts/body split ambiguous (Shape B), but LEGACY doesn't sign the id at all, so an
// existing legacy sender's id (which may contain '.' or run long) must not be broken by this rule.
const GENERIC_DELIVERY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Loom's own scheme for a provider with no established convention — `X-Loom-Signature: sha256=<hex>` +
 *  `X-Loom-Timestamp: <unix seconds>` + `X-Loom-Delivery-Id: <string>`. Two accepted signed-content
 *  formats, CURRENT and LEGACY (accepted indefinitely — see the decision record for why).
 *
 *  CURRENT signs `v1.${id}.${ts}.${body}`; the `v1.` literal can never collide with LEGACY's
 *  `${ts}.${body}` (ts is digits-only, so it can never start with "v1"), and the id charset above removes
 *  the same-format re-split ambiguity — together these close both relabel shapes a Code Review found. A
 *  LEGACY match still dedupes on a hash of what was signed, never the raw header. */
function verifyGeneric(secret: string, rawBody: Buffer, headers: WebhookHeaders, nowMs: number): WebhookVerifyResult {
  const sigHeader = header(headers, "x-loom-signature");
  const ts = header(headers, "x-loom-timestamp");
  const deliveryId = header(headers, "x-loom-delivery-id");
  if (!sigHeader || !ts || !deliveryId) return { ok: false, reason: "missing X-Loom-Signature/X-Loom-Timestamp/X-Loom-Delivery-Id header" };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: "malformed X-Loom-Timestamp header" };
  const tsMs = Number(ts) * 1000;
  if (Math.abs(nowMs - tsMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) return { ok: false, reason: "timestamp outside tolerance" };
  const m = /^sha256=([0-9a-f]+)$/i.exec(sigHeader.trim());
  if (!m) return { ok: false, reason: "malformed X-Loom-Signature header" };
  const provided = Buffer.from(m[1]!, "hex");

  // CURRENT (v1) — only attempted when the id satisfies the charset. A legacy sender's id was never
  // charset-restricted (see GENERIC_DELIVERY_ID_RE's own decision comment), so a charset-invalid id must
  // not be rejected outright here — it just can't reach the v1 branch; LEGACY below is still tried regardless.
  const idValidForCurrent = GENERIC_DELIVERY_ID_RE.test(deliveryId);
  if (idValidForCurrent) {
    const currentSignedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${ts}.`, "utf8"), rawBody]);
    if (timingSafeEqualBuf(hmacSha256(secret, currentSignedContent), provided)) {
      return { ok: true, deliveryId: `generic:${deliveryId}` };
    }
  }

  const legacySignedContent = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), rawBody]);
  if (timingSafeEqualBuf(hmacSha256(secret, legacySignedContent), provided)) {
    // Namespaced "generic:legacy:" (vs. "generic:") is also how the caller (webhooks/ingress.ts) detects
    // a legacy-format match, to log its once-per-endpoint deprecation warning.
    const legacyKey = createHash("sha256").update(legacySignedContent).digest("hex");
    return { ok: true, deliveryId: `generic:legacy:${legacyKey}` };
  }

  // Neither format matched. If the id was never even eligible for CURRENT, surface that specifically
  // (400 — a format problem, not a forged-signature attempt) rather than the generic 401.
  if (!idValidForCurrent) return { ok: false, reason: "invalid X-Loom-Delivery-Id format for the v1 (current) signature format", httpStatus: 400 };
  return { ok: false, reason: "signature mismatch" };
}

/**
 * Verify an inbound webhook request's signature against `secret` (the endpoint's decrypted signing
 * secret) and `rawBody` (the EXACT bytes received — never a re-serialized `JSON.stringify(parsedBody)`,
 * which can byte-differ from what was actually signed on key order / whitespace / number formatting and
 * silently break verification, or worse, verify against bytes the sender never actually sent).
 */
export function verifyWebhookSignature(
  sourceType: WebhookSourceType,
  secret: string,
  rawBody: Buffer,
  headers: WebhookHeaders,
  nowMs: number,
): WebhookVerifyResult {
  switch (sourceType) {
    case "github": return verifyGithub(secret, rawBody, headers);
    case "stripe": return verifyStripe(secret, rawBody, headers, nowMs);
    case "standard": return verifyStandard(secret, rawBody, headers, nowMs);
    case "generic": return verifyGeneric(secret, rawBody, headers, nowMs);
  }
}
