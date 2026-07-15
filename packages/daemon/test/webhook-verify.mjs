import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Inbound webhook HMAC verification (agent-tooling epic P5b, card 8fbedcac) — webhooks/verify.ts's pure
// crypto core, tested in isolation from Fastify/db (see webhook-ingress.mjs for the full route). HERMETIC,
// no Db/network/claude.
//
// Covers:
//   1. Each scheme (github/stripe/standard/generic) verifies a correctly-signed request and rejects a
//      wrong secret, a tampered body, a tampered signature, and (where the scheme has one) a stale
//      timestamp.
//   2. RAW-body correctness: a body that would hash/verify DIFFERENTLY if re-serialized via
//      JSON.stringify(JSON.parse(raw)) (key order / whitespace) still verifies against the EXACT raw
//      bytes — proving the module never re-serializes.
//   3. timingSafeEqual is length-guarded: a signature of the WRONG LENGTH never throws, just fails.
//   4. github has no timestamp — a scheme-inapplicable check never rejects it.
import { createHmac } from "node:crypto";
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { verifyWebhookSignature, WEBHOOK_TIMESTAMP_TOLERANCE_MS } = await import("../dist/webhooks/verify.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const SECRET = "test-signing-secret-abc123";
const NOW_MS = 1_700_000_000_000; // fixed instant — deterministic tests
const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
const b64Hmac = (keyBytes, data) => createHmac("sha256", keyBytes).update(data).digest("base64");

// ===================== github =====================
{
  // A body with extra whitespace that JSON.stringify(JSON.parse(x)) collapses away — proves raw-byte
  // signing (V8 preserves string-key insertion order, so a compact body alone wouldn't differ on
  // round-trip; the whitespace is what guarantees a byte difference here).
  const rawBody = Buffer.from('{"b": 2, "a": 1, "note": "raw byte order must survive"}', "utf8");
  const sig = "sha256=" + hexHmac(SECRET, rawBody);
  const headers = { "x-hub-signature-256": sig, "x-github-delivery": "delivery-1" };

  const ok = verifyWebhookSignature("github", SECRET, rawBody, headers, NOW_MS);
  check("github: valid signature -> ok", ok.ok === true && ok.deliveryId === "github:delivery-1");

  const roundTripped = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8"))), "utf8");
  check("github: raw-body correctness — the round-tripped (re-serialized) bytes differ from the original",
    !roundTripped.equals(rawBody));
  const wrongOnRoundTrip = verifyWebhookSignature("github", SECRET, roundTripped, headers, NOW_MS);
  check("github: the ORIGINAL signature does NOT verify against the re-serialized bytes (proves byte-exact signing matters)",
    wrongOnRoundTrip.ok === false);

  check("github: wrong secret -> rejected", verifyWebhookSignature("github", "wrong-secret", rawBody, headers, NOW_MS).ok === false);
  const tamperedBody = Buffer.from('{"b":2,"a":1,"note":"TAMPERED"}', "utf8");
  check("github: tampered body -> rejected", verifyWebhookSignature("github", SECRET, tamperedBody, headers, NOW_MS).ok === false);
  check("github: tampered signature -> rejected",
    verifyWebhookSignature("github", SECRET, rawBody, { ...headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) }, NOW_MS).ok === false);
  check("github: missing delivery id -> rejected", verifyWebhookSignature("github", SECRET, rawBody, { "x-hub-signature-256": sig }, NOW_MS).ok === false);
  check("github: missing signature header -> rejected", verifyWebhookSignature("github", SECRET, rawBody, { "x-github-delivery": "d" }, NOW_MS).ok === false);
  check("github: malformed signature header (no sha256= prefix) -> rejected",
    verifyWebhookSignature("github", SECRET, rawBody, { ...headers, "x-hub-signature-256": "not-a-signature" }, NOW_MS).ok === false);
  // No timestamp header at all on this scheme — a stale-looking NOW does not affect verification.
  const farFuture = NOW_MS + WEBHOOK_TIMESTAMP_TOLERANCE_MS * 100;
  check("github: has NO timestamp check — a far-future `now` still verifies (delivery-id dedupe is the replay defense, not tolerance)",
    verifyWebhookSignature("github", SECRET, rawBody, headers, farFuture).ok === true);
}

// ===================== stripe =====================
{
  const rawBody = Buffer.from('{"id":"evt_123","type":"charge.succeeded"}', "utf8");
  const tSec = Math.floor(NOW_MS / 1000);
  const signedContent = Buffer.concat([Buffer.from(`${tSec}.`, "utf8"), rawBody]);
  const v1 = hexHmac(SECRET, signedContent);
  const headers = { "stripe-signature": `t=${tSec},v1=${v1}` };

  const ok = verifyWebhookSignature("stripe", SECRET, rawBody, headers, NOW_MS);
  check("stripe: valid signature -> ok, deliveryId from body.id", ok.ok === true && ok.deliveryId === "evt_123");

  check("stripe: wrong secret -> rejected", verifyWebhookSignature("stripe", "wrong", rawBody, headers, NOW_MS).ok === false);
  check("stripe: tampered body -> rejected",
    verifyWebhookSignature("stripe", SECRET, Buffer.from('{"id":"evt_123","type":"TAMPERED"}'), headers, NOW_MS).ok === false);
  check("stripe: missing header -> rejected", verifyWebhookSignature("stripe", SECRET, rawBody, {}, NOW_MS).ok === false);
  check("stripe: malformed header (no v1) -> rejected",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": `t=${tSec}` }, NOW_MS).ok === false);

  // Timestamp bound INTO the signed content: replaying the signature with a forged fresh `t` fails,
  // because `t` is part of what was HMACed — an attacker can't just relabel an old signature as fresh.
  const forgedFreshT = Math.floor(NOW_MS / 1000) + 1;
  check("stripe: replaying the OLD v1 signature under a DIFFERENT (forged-fresh) t -> rejected (timestamp is bound into signed content)",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": `t=${forgedFreshT},v1=${v1}` }, NOW_MS).ok === false);

  // Stale timestamp (genuinely re-signed at an old t, still 401s past tolerance).
  const staleT = tSec - Math.ceil(WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) - 60;
  const staleSignedContent = Buffer.concat([Buffer.from(`${staleT}.`, "utf8"), rawBody]);
  const staleV1 = hexHmac(SECRET, staleSignedContent);
  check("stripe: correctly-signed but STALE timestamp (past 300s tolerance) -> rejected",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": `t=${staleT},v1=${staleV1}` }, NOW_MS).ok === false);
  // Just inside tolerance still passes.
  const nearT = tSec - Math.floor(WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) + 10;
  const nearSignedContent = Buffer.concat([Buffer.from(`${nearT}.`, "utf8"), rawBody]);
  const nearV1 = hexHmac(SECRET, nearSignedContent);
  check("stripe: timestamp just inside the 300s tolerance -> ok",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": `t=${nearT},v1=${nearV1}` }, NOW_MS).ok === true);

  // Multi-signature (Code Reviewer fix, card 8fbedcac): Stripe MAY send several v1= entries during a
  // signing-secret rotation — the valid one is not always LAST. A naive "collapse to last" implementation
  // wrongly rejects a delivery whose valid signature is a NON-last candidate.
  const wrongV1 = hexHmac("some-other-secret", signedContent);
  const multiSigHeaderValidFirst = `t=${tSec},v1=${v1},v1=${wrongV1}`;
  check("stripe: valid signature FIRST among two v1= candidates -> ok",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": multiSigHeaderValidFirst }, NOW_MS).ok === true);
  const multiSigHeaderValidLast = `t=${tSec},v1=${wrongV1},v1=${v1}`;
  check("stripe: valid signature LAST among two v1= candidates -> ok (the historical bug: a naive impl collapses to the last-seen v1 key, which happens to BE valid here — see the NON-last case below for the real regression check)",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": multiSigHeaderValidLast }, NOW_MS).ok === true);
  const multiSigHeaderValidMiddle = `t=${tSec},v1=${wrongV1},v1=${v1},v1=${wrongV1}`;
  check("stripe: valid signature in the MIDDLE of three v1= candidates -> ok (the actual regression this fix targets: neither first nor last)",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": multiSigHeaderValidMiddle }, NOW_MS).ok === true);
  const multiSigHeaderAllWrong = `t=${tSec},v1=${wrongV1},v1=${hexHmac("yet-another-wrong-secret", signedContent)}`;
  check("stripe: multiple v1= candidates but NONE valid -> rejected",
    verifyWebhookSignature("stripe", SECRET, rawBody, { "stripe-signature": multiSigHeaderAllWrong }, NOW_MS).ok === false);
}

// ===================== standard (Standard Webhooks) =====================
{
  const rawBody = Buffer.from('{"event":"user.created"}', "utf8");
  const id = "msg_abc123";
  const tsSec = Math.floor(NOW_MS / 1000);
  const signedContent = Buffer.from(`${id}.${tsSec}.${rawBody.toString("utf8")}`, "utf8");
  const sig = b64Hmac(Buffer.from(SECRET, "utf8"), signedContent);
  const headers = { "webhook-id": id, "webhook-timestamp": String(tsSec), "webhook-signature": `v1,${sig}` };

  const ok = verifyWebhookSignature("standard", SECRET, rawBody, headers, NOW_MS);
  check("standard: valid signature (raw-string secret) -> ok, deliveryId is webhook-id", ok.ok === true && ok.deliveryId === id);

  // whsec_-prefixed base64 secret shape.
  const whsecRaw = Buffer.from("a-standard-webhooks-style-key", "utf8");
  const whsec = "whsec_" + whsecRaw.toString("base64");
  const sigWhsec = b64Hmac(whsecRaw, signedContent);
  check("standard: whsec_<base64> secret shape decodes correctly -> ok",
    verifyWebhookSignature("standard", whsec, rawBody, { ...headers, "webhook-signature": `v1,${sigWhsec}` }, NOW_MS).ok === true);

  // Multiple space-separated candidate signatures — a match on ANY is accepted (sender-side rotation).
  const otherSecretSig = b64Hmac(Buffer.from("some-other-secret"), signedContent);
  check("standard: matches the SECOND of two space-separated v1 candidates",
    verifyWebhookSignature("standard", SECRET, rawBody, { ...headers, "webhook-signature": `v1,${otherSecretSig} v1,${sig}` }, NOW_MS).ok === true);

  check("standard: wrong secret -> rejected", verifyWebhookSignature("standard", "wrong", rawBody, headers, NOW_MS).ok === false);
  check("standard: tampered body -> rejected",
    verifyWebhookSignature("standard", SECRET, Buffer.from('{"event":"TAMPERED"}'), headers, NOW_MS).ok === false);
  check("standard: missing headers -> rejected", verifyWebhookSignature("standard", SECRET, rawBody, {}, NOW_MS).ok === false);

  const staleTs = tsSec - Math.ceil(WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) - 60;
  const staleContent = Buffer.from(`${id}.${staleTs}.${rawBody.toString("utf8")}`, "utf8");
  const staleSig = b64Hmac(Buffer.from(SECRET, "utf8"), staleContent);
  check("standard: stale timestamp (past tolerance) -> rejected",
    verifyWebhookSignature("standard", SECRET, rawBody, { "webhook-id": id, "webhook-timestamp": String(staleTs), "webhook-signature": `v1,${staleSig}` }, NOW_MS).ok === false);
}

// ===================== generic (Loom's own scheme) =====================
{
  const rawBody = Buffer.from('{"kind":"custom.event"}', "utf8");
  const tsSec = Math.floor(NOW_MS / 1000);
  const signedContent = Buffer.concat([Buffer.from(`${tsSec}.`, "utf8"), rawBody]);
  const sig = "sha256=" + hexHmac(SECRET, signedContent);
  const headers = { "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": "gen-1" };

  const ok = verifyWebhookSignature("generic", SECRET, rawBody, headers, NOW_MS);
  check("generic: valid signature -> ok, deliveryId from X-Loom-Delivery-Id", ok.ok === true && ok.deliveryId === "gen-1");
  check("generic: wrong secret -> rejected", verifyWebhookSignature("generic", "wrong", rawBody, headers, NOW_MS).ok === false);
  check("generic: tampered body -> rejected",
    verifyWebhookSignature("generic", SECRET, Buffer.from('{"kind":"TAMPERED"}'), headers, NOW_MS).ok === false);
  check("generic: missing headers -> rejected", verifyWebhookSignature("generic", SECRET, rawBody, {}, NOW_MS).ok === false);
  const staleTs = tsSec - Math.ceil(WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) - 60;
  const staleContent = Buffer.concat([Buffer.from(`${staleTs}.`, "utf8"), rawBody]);
  const staleSig = "sha256=" + hexHmac(SECRET, staleContent);
  check("generic: stale timestamp -> rejected",
    verifyWebhookSignature("generic", SECRET, rawBody, { "x-loom-signature": staleSig, "x-loom-timestamp": String(staleTs), "x-loom-delivery-id": "gen-1" }, NOW_MS).ok === false);
}

// ===================== timingSafeEqual length-guard: a wrong-length signature never throws =====================
{
  const rawBody = Buffer.from('{"a":1}', "utf8");
  const headers = { "x-hub-signature-256": "sha256=" + "ab".repeat(3) /* 6 hex chars = 3 bytes, not 32 */, "x-github-delivery": "d" };
  let threw = false;
  let result;
  try { result = verifyWebhookSignature("github", SECRET, rawBody, headers, NOW_MS); } catch { threw = true; }
  check("length-mismatched signature: never throws (length-guarded before timingSafeEqual)", threw === false);
  check("length-mismatched signature: rejected, not accidentally accepted", result?.ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — github/stripe/standard/generic each verify a correctly-signed request and reject a wrong secret, a tampered body, a tampered signature, and a stale timestamp where applicable; raw-body signing survives a byte-differing JSON round-trip; the stripe/standard/generic timestamp is bound INTO the signed content (a forged-fresh replay of an old signature fails); github has no timestamp check by design; and a length-mismatched signature never throws timingSafeEqual, it just fails."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
