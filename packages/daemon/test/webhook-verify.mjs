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
//   5. (card 07af871d) github's dedupe key is a hash of the SIGNED body, not the raw X-GitHub-Delivery
//      header — replaying an identical, validly-signed body under a FRESH delivery-id header must
//      dedupe to the SAME key.
//   6. (card 07af871d) generic's CURRENT format (`v1.${id}.${ts}.${body}`) binds the delivery id into the
//      signed content; its LEGACY format (id unsigned, accepted indefinitely) still dedupes on a hash of
//      the signed content, never the raw header — the same replay-with-a-fresh-header case as (5).
//   7. (Code Review e089cd2b, card 07af871d) the `v1.` prefix + the X-Loom-Delivery-Id charset restriction
//      (no `.`) together close TWO cross-format/re-split relabel attacks the review found: a captured
//      CURRENT signature can never be re-verified as LEGACY (Shape A), and no id/ts/body split within
//      CURRENT itself is ambiguous (Shape B).
import { createHmac, createHash } from "node:crypto";
import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { verifyWebhookSignature, WEBHOOK_TIMESTAMP_TOLERANCE_MS } = await import("../dist/webhooks/verify.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const SECRET = "test-signing-secret-abc123";
const NOW_MS = 1_700_000_000_000; // fixed instant — deterministic tests
const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const b64Hmac = (keyBytes, data) => createHmac("sha256", keyBytes).update(data).digest("base64");

// ===================== github =====================
{
  // A body with extra whitespace that JSON.stringify(JSON.parse(x)) collapses away — proves raw-byte
  // signing (V8 preserves string-key insertion order, so a compact body alone wouldn't differ on
  // round-trip; the whitespace is what guarantees a byte difference here).
  const rawBody = Buffer.from('{"b": 2, "a": 1, "note": "raw byte order must survive"}', "utf8");
  const sig = "sha256=" + hexHmac(SECRET, rawBody);
  const headers = { "x-hub-signature-256": sig, "x-github-delivery": "delivery-1" };

  const expectedDeliveryId = `github:${sha256Hex(rawBody)}`;
  const ok = verifyWebhookSignature("github", SECRET, rawBody, headers, NOW_MS);
  check("github: valid signature -> ok, deliveryId is a hash of the SIGNED body (not the raw header)",
    ok.ok === true && ok.deliveryId === expectedDeliveryId);

  // (card 07af871d) THE FIX: an identical, validly-signed body replayed under a FRESH, never-seen
  // X-GitHub-Delivery header must dedupe to the SAME key — the header is unsigned and must never be
  // the dedupe key on its own, or a captured delivery could be replayed forever under a new id each time.
  const replayHeaders = { "x-hub-signature-256": sig, "x-github-delivery": "delivery-NEVER-SEEN-BEFORE" };
  const replay = verifyWebhookSignature("github", SECRET, rawBody, replayHeaders, NOW_MS);
  check("github: SAME signed body replayed under a DIFFERENT delivery-id header -> still verifies",
    replay.ok === true);
  check("github: ...and dedupes to the EXACT SAME key as the original (varying only the delivery-id header)",
    replay.deliveryId === expectedDeliveryId);

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

// ===================== generic (Loom's own scheme) — CURRENT format: v1.id.ts.body =====
{
  const rawBody = Buffer.from('{"kind":"custom.event"}', "utf8");
  const tsSec = Math.floor(NOW_MS / 1000);
  const deliveryId = "gen-1";
  const signedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${tsSec}.`, "utf8"), rawBody]);
  const sig = "sha256=" + hexHmac(SECRET, signedContent);
  const headers = { "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId };

  const ok = verifyWebhookSignature("generic", SECRET, rawBody, headers, NOW_MS);
  check("generic (current): valid signature -> ok, deliveryId is namespaced + carries X-Loom-Delivery-Id",
    ok.ok === true && ok.deliveryId === "generic:gen-1");
  check("generic (current): wrong secret -> rejected", verifyWebhookSignature("generic", "wrong", rawBody, headers, NOW_MS).ok === false);
  check("generic (current): tampered body -> rejected",
    verifyWebhookSignature("generic", SECRET, Buffer.from('{"kind":"TAMPERED"}'), headers, NOW_MS).ok === false);
  check("generic (current): missing headers -> rejected", verifyWebhookSignature("generic", SECRET, rawBody, {}, NOW_MS).ok === false);
  const staleTs = tsSec - Math.ceil(WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) - 60;
  const staleContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${staleTs}.`, "utf8"), rawBody]);
  const staleSig = "sha256=" + hexHmac(SECRET, staleContent);
  check("generic (current): stale timestamp -> rejected",
    verifyWebhookSignature("generic", SECRET, rawBody, { "x-loom-signature": staleSig, "x-loom-timestamp": String(staleTs), "x-loom-delivery-id": deliveryId }, NOW_MS).ok === false);

  // (card 07af871d) THE FIX: the id is now bound INTO the signature, so an attacker who captures this
  // valid request can no longer relabel it under a fresh delivery-id header without invalidating the
  // signature entirely — structurally impossible, not just deduped-away.
  const relabeled = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": "gen-NEVER-SEEN-BEFORE" }, NOW_MS);
  check("generic (current): the SAME signature replayed under a DIFFERENT delivery-id header -> rejected outright (id is part of what's signed)",
    relabeled.ok === false);

  // (Code Review e089cd2b) X-Loom-Delivery-Id charset: a '.' (or any char outside [A-Za-z0-9_-]) is
  // rejected outright with httpStatus:400 — never reaches signature verification at all.
  const dotIdSignedContent = Buffer.concat([Buffer.from(`v1.has.a.dot.${tsSec}.`, "utf8"), rawBody]);
  const dotIdSig = "sha256=" + hexHmac(SECRET, dotIdSignedContent);
  const dotIdResult = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": dotIdSig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": "has.a.dot" }, NOW_MS);
  check("generic (current): X-Loom-Delivery-Id containing '.' -> rejected", dotIdResult.ok === false);
  check("generic (current): ...with httpStatus:400 (a format violation, not a verification failure)", dotIdResult.httpStatus === 400);
  const spaceIdResult = verifyWebhookSignature("generic", SECRET, rawBody, { ...headers, "x-loom-delivery-id": "has a space" }, NOW_MS);
  check("generic (current): X-Loom-Delivery-Id containing a space -> rejected with httpStatus:400", spaceIdResult.ok === false && spaceIdResult.httpStatus === 400);
  check("generic (current): a normal alnum/underscore/hyphen id is unaffected by the charset check (sanity, reusing the original valid request)", ok.ok === true);
}

// ===================== generic — LEGACY format: ts.body (id unsigned), accepted INDEFINITELY =====
{
  // A sender still signing the pre-07af871d content (`${ts}.${body}`, no id) — accepted forever (Code
  // Review ruling: a hard sunset is an undisclosed breaking change for a human-configured sender, and
  // isn't needed now that (a) legacy already dedupes on a signed value and (b) the v1 prefix + id charset
  // make a legacy signature structurally unable to also verify as CURRENT — see the decision record).
  const rawBody = Buffer.from('{"kind":"legacy.event"}', "utf8");
  const tsSec = Math.floor(NOW_MS / 1000);
  const legacySignedContent = Buffer.concat([Buffer.from(`${tsSec}.`, "utf8"), rawBody]);
  const legacySig = "sha256=" + hexHmac(SECRET, legacySignedContent);
  const expectedLegacyKey = `generic:legacy:${sha256Hex(legacySignedContent)}`;
  const headers = { "x-loom-signature": legacySig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": "legacy-gen-1" };

  const ok = verifyWebhookSignature("generic", SECRET, rawBody, headers, NOW_MS);
  check("generic (legacy): a pre-migration signature verifies -> ok", ok.ok === true);
  check("generic (legacy): ...and its deliveryId is a hash of the SIGNED content (timestamp+body), never the raw header",
    ok.deliveryId === expectedLegacyKey);
  check("generic (legacy): its deliveryId is DIFFERENT from what the raw (unsigned) header value would have been",
    ok.deliveryId !== "legacy-gen-1" && ok.deliveryId !== "generic:legacy-gen-1");

  // (card 07af871d) THE FIX, legacy path: the id is unsigned in this format, so an attacker CAN still
  // relabel the header without invalidating the signature (the format is accepted for exactly this
  // reason) — but the dedupe key must be unaffected by that relabeling, because it never reads the header.
  const replayHeaders = { "x-loom-signature": legacySig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": "legacy-gen-NEVER-SEEN-BEFORE" };
  const replay = verifyWebhookSignature("generic", SECRET, rawBody, replayHeaders, NOW_MS);
  check("generic (legacy): SAME legacy signature replayed under a DIFFERENT delivery-id header -> still verifies (legacy format doesn't sign the id)",
    replay.ok === true);
  check("generic (legacy): ...and dedupes to the EXACT SAME key as the original (varying only the delivery-id header)",
    replay.deliveryId === expectedLegacyKey);

  // Far in the future — a legacy signature still verifies (no sunset; only the ±300s timestamp tolerance
  // applies, so this must be checked against a FRESH ts relative to the "now" under test).
  const farFutureMs = NOW_MS + 1000 * 365 * 24 * 60 * 60 * 1000; // ~1000 years out
  const farFutureTsSec = Math.floor(farFutureMs / 1000);
  const farFutureContent = Buffer.concat([Buffer.from(`${farFutureTsSec}.`, "utf8"), rawBody]);
  const farFutureSig = "sha256=" + hexHmac(SECRET, farFutureContent);
  const farFutureResult = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": farFutureSig, "x-loom-timestamp": String(farFutureTsSec), "x-loom-delivery-id": "legacy-gen-3" }, farFutureMs);
  check("generic (legacy): a fresh legacy signature FAR in the future still verifies -> ok (no hard sunset, by design)",
    farFutureResult.ok === true);

  // A legacy-signed request never satisfies the CURRENT (id-bound) check, and vice versa — the two
  // signatures are cryptographically distinct, so a sender's format doesn't leak/cross-verify.
  const currentFormatContent = Buffer.concat([Buffer.from(`v1.legacy-gen-1.${tsSec}.`, "utf8"), rawBody]);
  const wouldBeCurrentSig = "sha256=" + hexHmac(SECRET, currentFormatContent);
  check("generic: a legacy-format signature never equals what the current-format signature would be (distinct signed content)",
    legacySig !== wouldBeCurrentSig);
}

// ===================== (Code Review, backward-compat fix) legacy sender with a charset-violating id =====
// THE REGRESSION (found on commit 16aa36b9): the X-Loom-Delivery-Id charset check ran BEFORE either
// signed-content attempt, so an EXISTING legacy sender whose id happens to contain '.' (or exceed 128
// chars) — legacy never had any charset rule, and legacy dedupe never reads the id at all — got a hard
// 400 instead of the acceptance it had before this whole card. That's exactly the owner-facing break
// dropping the hard sunset was meant to avoid. Fix: the charset now gates the v1 (CURRENT) attempt ONLY;
// LEGACY is always tried regardless of the id's shape.
{
  const rawBody = Buffer.from('{"kind":"legacy-dotted-id.event"}', "utf8");
  const tsSec = Math.floor(NOW_MS / 1000);
  const dottedId = "legacy.sender.id.with.dots.1790783769"; // never valid for CURRENT; always fine for LEGACY
  const legacySignedContent = Buffer.concat([Buffer.from(`${tsSec}.`, "utf8"), rawBody]);
  const legacySig = "sha256=" + hexHmac(SECRET, legacySignedContent);
  const expectedLegacyKey = `generic:legacy:${sha256Hex(legacySignedContent)}`;
  const headers = { "x-loom-signature": legacySig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": dottedId };

  const result = verifyWebhookSignature("generic", SECRET, rawBody, headers, NOW_MS);
  check("generic (legacy, charset-violating id): a legacy-signed delivery whose id contains dots -> still ACCEPTED (legacy never had a charset rule)",
    result.ok === true);
  check("generic (legacy, charset-violating id): ...deduped on the LEGACY key (id never read), not rejected as a bad id",
    result.deliveryId === expectedLegacyKey);

  // A 129-char id (one over GENERIC_DELIVERY_ID_RE's length cap) — also must not break an existing legacy
  // sender, for the same reason.
  const longId = "a".repeat(129);
  const longIdSignedContent = Buffer.concat([Buffer.from(`${tsSec}.`, "utf8"), rawBody]);
  const longIdSig = "sha256=" + hexHmac(SECRET, longIdSignedContent);
  const longIdResult = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": longIdSig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": longId }, NOW_MS);
  check("generic (legacy, 129-char id): still accepted via legacy (length cap also only gates CURRENT)", longIdResult.ok === true);

  // The mirror case: the SAME dotted id, but genuinely v1-signed (a sender attempting CURRENT with an
  // invalid id) -> rejected. The charset restriction still fully applies to CURRENT.
  const v1Content = Buffer.concat([Buffer.from(`v1.${dottedId}.${tsSec}.`, "utf8"), rawBody]);
  const v1Sig = "sha256=" + hexHmac(SECRET, v1Content);
  const v1Result = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": v1Sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": dottedId }, NOW_MS);
  check("generic (CURRENT, dotted id): a v1-signed delivery with a dotted id -> rejected (charset fully applies to CURRENT)",
    v1Result.ok === false && v1Result.httpStatus === 400);
}

// ===================== (Code Review e089cd2b) generic cross-format/re-split relabel attacks =====
// The Code Reviewer reproduced two ways to relabel a captured, validly-signed generic delivery under a
// DIFFERENT dedupe key by manipulating only the ts/body/id split — WITHOUT knowing the secret. Both must
// be structurally impossible after the v1-prefix + id-charset fix, and both are proven RED against the
// pre-fix (commit 4cfebb15) shape by reasoning: this block only exercises the FIXED verifyGeneric, but the
// ingress-level tests in webhook-ingress.mjs independently confirm a second spawn cannot happen end to end.
{
  // ----- Shape A: current -> legacy relabel -----
  // A delivery with a NUMERIC id T that is itself within the timestamp tolerance window (T "looks like" a
  // fresh unix-seconds value) can, on the PRE-FIX (no v1 prefix) format, be re-split so the id becomes the
  // legacy ts and the original ts+body get folded into the legacy body. The v1 prefix prevents this
  // structurally: the legacy path's ts field must be all-digits (`/^\d+$/`), and CURRENT's signed content
  // now always starts with the literal "v1." — a legacy ts can never equal "v1", so no CURRENT-signed byte
  // string can ever be re-split into a valid legacy (ts, body) pair.
  const rawBody = Buffer.from('{"kind":"shapeA.event"}', "utf8");
  const nowSec = Math.floor(NOW_MS / 1000);
  const T = String(nowSec); // numeric id, itself a fresh-looking unix-seconds value
  const TS0 = String(nowSec - 5); // the real timestamp, also fresh
  const originalSignedContent = Buffer.concat([Buffer.from(`v1.${T}.${TS0}.`, "utf8"), rawBody]);
  const originalSig = "sha256=" + hexHmac(SECRET, originalSignedContent);

  const relabeledBody = Buffer.concat([Buffer.from(`${TS0}.`, "utf8"), rawBody]); // body' = TS0. + B
  const shapeA = verifyWebhookSignature("generic", SECRET, relabeledBody,
    { "x-loom-signature": originalSig, "x-loom-timestamp": T, "x-loom-delivery-id": "shapeA-attacker-chosen-id" }, NOW_MS);
  check("Shape A (current->legacy re-split): the captured signature, resubmitted with ts=T and body=TS0.+B, does NOT verify",
    shapeA.ok === false);

  // ----- Shape B: same-format re-split relabel -----
  // An id containing a literal '.' (e.g. embedding a timestamp) would let the id/ts boundary itself be
  // ambiguous: a SHORTER id + a body absorbing the removed suffix can reconstruct byte-identical signed
  // content under a DIFFERENT (shorter) id -> a different CURRENT dedupe key. The fix is NOT "reject the
  // replay" (algebraically, once you already hold a signature over dotted-id content, a same-bytes
  // resubmission under the shorter id DOES still verify — expected, since HMAC only checks byte equality
  // of what was actually signed). The fix is that the DOTTED id itself is rejected outright at the ONLY
  // point it could ever be legitimately accepted, so no such signature is ever produced by a real accepted
  // delivery to capture in the first place — the "collision" this shape relies on can never come from two
  // genuinely-fired deliveries. Proven here at the unit level (the dotted id never gets past intake); the
  // end-to-end "only one spawn ever happens" round trip is in webhook-ingress.mjs's Shape B test.
  const ts0 = String(nowSec);
  const originalId = `evt.${ts0}`; // deliberately contains the same digits as the real ts — the coincidence that enables the re-split
  const shapeBOriginalContent = Buffer.concat([Buffer.from(`v1.${originalId}.${ts0}.`, "utf8"), rawBody]);
  const shapeBOriginalSig = "sha256=" + hexHmac(SECRET, shapeBOriginalContent);
  const shapeBOriginalResult = verifyWebhookSignature("generic", SECRET, rawBody,
    { "x-loom-signature": shapeBOriginalSig, "x-loom-timestamp": ts0, "x-loom-delivery-id": originalId }, NOW_MS);
  check("Shape B: the dotted original id is rejected outright (charset, httpStatus:400) — it can never be a genuinely-accepted delivery",
    shapeBOriginalResult.ok === false && shapeBOriginalResult.httpStatus === 400);
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
  ? "\n✅ ALL PASS — github/stripe/standard/generic each verify a correctly-signed request and reject a wrong secret, a tampered body, a tampered signature, and a stale timestamp where applicable; raw-body signing survives a byte-differing JSON round-trip; the stripe/standard/generic timestamp is bound INTO the signed content (a forged-fresh replay of an old signature fails); github has no timestamp check by design; a length-mismatched signature never throws timingSafeEqual, it just fails; github's and generic's dedupe keys are hashes of the SIGNED content (never the raw, unsigned delivery-id header), so a replay under a fresh header still dedupes to the same key; generic's CURRENT format signs `v1.${id}.${ts}.${body}` (a relabeled replay is rejected outright) and the X-Loom-Delivery-Id charset rejects a dot with httpStatus:400; generic's LEGACY format is accepted indefinitely (no sunset); and the v1 prefix + id charset together close both the current-to-legacy relabel (Shape A) and the same-format re-split relabel (Shape B) a Code Review found."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
