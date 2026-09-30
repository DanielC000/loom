# 07af871d — webhook delivery dedupe keys off a SIGNED value; generic id gets bound into its signature; rate-check runs before the dedupe write

## Round 3 — Round 2's charset check broke an EXISTING legacy sender (backward-compat regression)

Round 2 (below) added `GENERIC_DELIVERY_ID_RE` and rejected a charset-violating `X-Loom-Delivery-Id` with
`httpStatus:400` **before either signed-content attempt** — i.e. unconditionally, for both CURRENT and
LEGACY. That broke exactly the population Round 2's own sunset removal was trying to protect: LEGACY
never had a charset rule (a legacy sender never agreed to one), and LEGACY's dedupe key never reads the id
at all — so an already-deployed legacy sender whose id happens to contain `.` (not unusual — an id that
embeds a timestamp, like `evt.1790783769`, is exactly the shape Shape B's example used) or exceeds 128
chars would now get a hard 400 on every delivery, with no warning and no migration path. This is precisely
the owner-facing break dropping the hard sunset was meant to avoid — reintroduced by the very fix that
closed Shape A/B.

**The fix:** the charset check now gates the CURRENT (v1) attempt ONLY. `verifyGeneric` first checks
`GENERIC_DELIVERY_ID_RE.test(deliveryId)`; if it passes, the v1 HMAC is attempted as before. If the id
fails the charset (or the v1 HMAC doesn't match), LEGACY is tried regardless — LEGACY's signed content
never includes the id, so there is nothing for the charset to protect there. Only if BOTH attempts fail
does the function return — `httpStatus:400` if the id was charset-invalid (so CURRENT was never even
attempted), else the ordinary `401`/"signature mismatch" for a real verification failure.

**Why this stays safe (Shape A/B remain closed):** Shape B's entire mechanism depended on a dotted id
being accepted as a genuine CURRENT delivery in the first place, so its signature could later be replayed
under a shorter id. A charset-invalid id can now NEVER reach the `v1.` branch — the precondition for
Shape B still cannot occur, exactly as Round 2 intended, just via a narrower gate. Shape A is unaffected
either way — it never depended on the id's charset, only on the `v1.` prefix breaking the cross-format
byte collision (Round 2, point 1), which is unchanged.

Tests added: a legacy-signed delivery with a dotted (and separately, a 129-char) id still verifies and
dedupes on the legacy key, both at the pure-function level (`webhook-verify.mjs`) and end to end through
the real route (`webhook-ingress.mjs`'s `(13c)`) — confirmed RED on commit `16aa36b9` (the same dotted-id
delivery 400'd and never fired) and GREEN after this fix. A v1-signed delivery with a dotted id is still
rejected (the mirror case, proving the charset restriction still fully applies to CURRENT). Shape A/B's
existing tests were re-run unchanged and still pass, confirming no regression to the relabel closure.

## Round 2 — Code Review e089cd2b found two cross-format/re-split relabel attacks in Round 1's fix

Round 1 (below) bound the generic delivery id into the signed content as `${id}.${ts}.${body}` and gated
LEGACY-format acceptance behind a hard sunset (`GENERIC_LEGACY_SIGNATURE_SUNSET_MS`, 2027-01-01). Code
Review reproduced two ways to relabel a captured, validly-signed CURRENT-format delivery under a
DIFFERENT dedupe key — WITHOUT knowing the secret — by exploiting ambiguity in how `.` delimits
`id`/`ts`/`body`:

- **Shape A (current→legacy relabel):** a delivery with a NUMERIC id `T` that is itself within the
  timestamp tolerance window (so `T` "looks like" a fresh unix-seconds value) can be resubmitted with
  `ts_header = T` and `body' = ${TS0}.${B}` (the real ts prepended to the real body), reusing the
  UNCHANGED signature. The LEGACY check recomputes `${ts_header}.${body'}`, which reconstructs the exact
  bytes that were actually signed under CURRENT (`${T}.${TS0}.${B}`) — so it verifies as LEGACY, under a
  completely different (hash-based) dedupe key. Round 1's CURRENT format had no way to distinguish "this
  is CURRENT-shaped content" from "this is LEGACY-shaped content" — both were just byte strings.
- **Shape B (same-format re-split relabel):** an id containing a literal `.` (e.g. one that happens to
  embed the delivery's own timestamp, like `evt.1790783769`) lets the id/ts boundary itself move: resubmit
  a SHORTER id (`evt`) plus a body that absorbs the removed suffix (`1790783769.` + body), reconstructing
  byte-identical CURRENT-format signed content under a DIFFERENT (shorter) id — again, a different dedupe
  key for the same underlying bytes.

**The fix, ruled by Code Review:**

1. **A version prefix on CURRENT's signed content:** `v1.${id}.${ts}.${body}` (was `${id}.${ts}.${body}`).
   LEGACY's ts field is required to be all-digits (`/^\d+$/`), so it can never start with the literal `v1`
   — a CURRENT-signed byte string can therefore never be re-split into a valid LEGACY `(ts, body)` pair.
   This closes Shape A structurally, not by pattern-matching the attack.
2. **X-Loom-Delivery-Id charset restriction:** `^[A-Za-z0-9_-]{1,128}$` — no `.`. Since a CURRENT id can
   never contain `.`, the FIRST `.` after `v1.` is unambiguously the id/ts boundary — no alternate (id, ts)
   split of the same prefix bytes can ever be valid, closing Shape B structurally (proof: if two distinct
   dot-free ids id1≠id2 produced the same `id.ts.` prefix, the first `.` would have to sit at both
   `len(id1)` and `len(id2)`; if those differ, the shorter id's boundary `.` would have to fall INSIDE the
   longer id, which can't contain a `.` — contradiction). The precondition for Shape B (a dotted id ever
   being genuinely accepted as CURRENT so its signature could be captured) no longer exists.
   ⚠️ **As originally shipped this round, the charset check ran unconditionally — before EITHER
   signed-content attempt — which broke an existing LEGACY sender. See "Round 3" above for the fix: the
   charset now gates the CURRENT (v1) attempt only; `httpStatus:400` (a NEW field on
   `WebhookVerifyResult`, defaulting to 401 everywhere else) is returned only once BOTH the v1 attempt
   (skipped or failed) and the LEGACY attempt have failed, and only when the id was the reason CURRENT
   was unreachable.**
3. **Hard sunset DROPPED — legacy accepted indefinitely.** A fixed 2027-01-01 cutoff was an undisclosed
   breaking change for a human-configured sender (nothing in this repo describes the generic scheme to a
   human sender at all — see Round 1's finding below), and it's no longer needed: legacy already dedupes
   on a signed value (Round 1), and the v1 prefix (this round) makes a legacy signature structurally
   unable to also verify as CURRENT. `GENERIC_LEGACY_SIGNATURE_SUNSET_MS` and its tests are removed.
   Instead, a disclosure-safe deprecation warning (endpoint id only — no payload/secret/signature content)
   is logged ONCE per endpoint (`legacyFormatWarned`, a per-`registerWebhookIngress`-call `Set`) the first
   time that endpoint's traffic is seen verifying via LEGACY.
4. **Ingress clock is now injectable** (`WebhookIngressDeps.now?: () => number`, defaults to `Date.now`) —
   a general test seam (mirrors `spawnRateLimiter`), used so the Shape A/B and legacy-replay ingress tests
   pin a fixed instant rather than depending on the real wall clock (removes the same "time bomb" shape
   the hard sunset itself was — a passing test whose result depends on which YEAR it happens to run in).

**Accepted trade-offs, stated explicitly (Code Review ruling — these are NOT bugs, don't "fix" them here):**

- **Record-before-fire is pre-existing and out of scope.** A rate-dropped delivery is never recorded
  (Round 1's fix), so a holder of a captured, valid signature can fire it ONE MORE TIME later — for
  GitHub, unbounded in time (GitHub has no expiry on its dedupe defense beyond the 30-day retention
  window); for a timestamp-bearing scheme, bounded by the ±300s tolerance (or, for generic LEGACY,
  effectively the same ±300s bound since legacy signs the timestamp). This is a SEPARATE, already-filed
  card — not fixed here.
- **GitHub collapses two distinct deliveries with byte-identical bodies for up to 30 days** (its dedupe
  retention window) — an accepted consequence of keying dedupe on a body hash rather than the (unsigned)
  delivery-id header; GitHub sends no timestamp, so there is no signed value to disambiguate two
  legitimately-identical bodies.
- **Standard Webhooks is out of scope.** It already shares the `id.ts.body` signed-content shape (per its
  own spec) and was not touched by either round of this fix.

## Round 1 — Narrative

Code review of `packages/daemon/src/webhooks/{verify,ingress}.ts` found three related gaps:

1. **GitHub** (`verifyGithub`) dedupes on the raw, UNSIGNED `X-GitHub-Delivery` header. GitHub sends no
   timestamp, so this header is the *entire* replay defense for the scheme — and it's attacker-controlled.
   An attacker who captures one valid delivery can replay it forever, just by sending a fresh, never-seen
   header value each time; each replay fires a fresh wake/spawn, up to the per-endpoint rate cap.
2. **Generic** (`verifyGeneric`, Loom's own scheme) signs `${timestampSeconds}.${rawBody}` but dedupes on
   the raw, UNSIGNED `X-Loom-Delivery-Id` header. The timestamp bound into the signature limits the replay
   window to ±300s (`WEBHOOK_TIMESTAMP_TOLERANCE_MS`) rather than forever, but within that window the same
   attack applies: a captured delivery replayed under a fresh header fires again.
3. **Ingress ordering** (`registerWebhookIngress`): the dedupe row (`Db.recordWebhookDelivery`) was written
   BEFORE the per-endpoint spawn-rate check. A genuine delivery that lands past the cap gets ACK'd `200
   {rateLimited:true}` (so the provider never retries — a 2xx is terminal) AND has its dedupe row written,
   even though it never actually fired. Any later legitimate redelivery of that SAME id — a provider's
   manual "resend" button, or the same delivery arriving again once capacity frees up — then dead-ends on
   the dedupe check instead of getting a chance to fire. The event is lost permanently.

`stripe` and `standard` were already sound: both bind their delivery-relevant value into the signed
content (stripe dedupes on the event body's own `.id`; standard signs `${id}.${ts}.${body}`), so neither
needed a change.

## The fix

**GitHub**: the dedupe key is now `github:${sha256hex(rawBody)}` — a hash of the bytes that were actually
signed, never the header. A replay under a different `X-GitHub-Delivery` value still hashes to the same
key. Structural, not a workaround: GitHub's signature already covers the whole body, so this needed no
protocol change, only reading a different input for the key.

**Generic — CURRENT format**: the signed content is `v1.${deliveryId}.${timestampSeconds}.${rawBody}`
(Round 2 added the `v1.` prefix — see above). Binding the id into the signature means a captured delivery
can't be relabeled under a fresh header at all — the signature itself fails to verify, before dedupe is
even consulted. `X-Loom-Delivery-Id` must match `^[A-Za-z0-9_-]{1,128}$` (Round 2) — rejected with
`httpStatus:400` otherwise. `verifyGeneric` returns `deliveryId: \`generic:${deliveryId}\`` (namespaced,
matching the `github:` convention).

**Generic — LEGACY format, accepted indefinitely**: a generic endpoint's signing secret is configured by a
human on an external, Loom-unaware sender. An already-deployed sender may still be signing the OLD content
(`${timestampSeconds}.${rawBody}`, no id, no `v1.` prefix). `verifyGeneric` tries CURRENT first, then falls
back to LEGACY — accepted with **no expiry** (Round 2 dropped the original hard sunset; see above for why).
The legacy path **never** dedupes on the raw header — it dedupes on
`generic:legacy:${sha256hex(timestampSeconds + "." + rawBody)}`, a hash of the content that WAS signed.
This closes the same replay-with-a-fresh-header hole on the legacy path without requiring the sender to
change anything: the hash is stable across a header change even though the header itself isn't trusted.
The FIRST legacy-format delivery on a given endpoint logs one disclosure-safe deprecation warning
(endpoint id only) via `console.warn` — never repeated for that endpoint.

**Migration guidance for a generic sender still on the old format** (no forced deadline, but should
migrate): re-sign as `HMAC-SHA256(secret, \`v1.${deliveryId}.${timestampSeconds}.${rawBody}\`)` (the same
`X-Loom-Signature: sha256=<hex>` header shape, just a different signed-content string — note the `v1.`
literal prefix), and ensure `X-Loom-Delivery-Id` contains only `[A-Za-z0-9_-]`. No header shape changed —
only what's fed into the HMAC, and the allowed characters in one header value. No user-facing docs or
settings copy describe the generic scheme's header/signing format anywhere in this repo (checked: only
`verify.ts`, its own test, and this record reference it) — the migration guidance above is authoritative
on its own, and the once-per-endpoint deprecation log line is the only in-product nudge a human running
the daemon gets today.

**Ingress ordering**: the per-endpoint rate check now runs BEFORE the dedupe row is written. A rate-limited
delivery still gets `200 {rateLimited:true}` (unchanged — still ACK'd so the provider doesn't retry-storm
on a non-2xx) but its dedupe row is never recorded. A later delivery of the SAME id — once capacity frees
up, or via a provider's manual redelivery — is therefore not blocked by a dedupe row for an event that
never actually fired. Chose reordering over the other DoD-offered option (a retryable 429 + Retry-After)
because it's a smaller, more local change that doesn't alter the provider-facing contract (every scheme
already documents "still ACK 2xx on rate-limit, never retry-storm the provider" as deliberate) and it
directly targets the actual defect (a false permanent record), not just its symptom.

## Do not

- Do not dedupe GitHub or generic on a raw request header — `X-GitHub-Delivery` and `X-Loom-Delivery-Id`
  are both attacker-controlled and unsigned (generic's legacy format only) inputs.
- Do not remove the `v1.` prefix from generic CURRENT's signed content, and do not allow `.` in an id that
  reaches the CURRENT (v1) attempt — together these are what makes Shape A (current→legacy relabel) and
  Shape B (same-format re-split relabel) structurally impossible; removing either reopens one of them. See
  "Round 2" above for the exact mechanics and the reproduction shapes Code Review found.
- Do not apply the `X-Loom-Delivery-Id` charset check UNCONDITIONALLY (i.e. before the LEGACY attempt) —
  that is the exact Round 3 regression: LEGACY never had a charset rule and never reads the id, so gating
  LEGACY on it breaks an already-deployed sender with no warning. The charset gates the CURRENT (v1)
  attempt ONLY; LEGACY is always tried regardless of the id's shape.
- Do not reintroduce a hard sunset on generic LEGACY-format acceptance without a fresh owner-facing
  disclosure plan — Round 1's `GENERIC_LEGACY_SIGNATURE_SUNSET_MS` was removed in Round 2 specifically
  because it was an undisclosed breaking change for a human-configured sender, and it is no longer needed
  for the reasons stated in "Round 2" above.
- Do not write a webhook dedupe row for a delivery that was dropped by the rate cap — that permanently and
  silently swallows a genuine delivery the moment its `X-*-Delivery-Id` is ever seen again. This has a
  known, ACCEPTED residual (see "Round 2 — Accepted trade-offs" above): a rate-dropped delivery's captured
  signature can still be fired once more later. That residual is tracked on a separate card, not here.
- Do not change stripe or standard — both already bind their dedupe-relevant value into the signed
  content and were not part of this fix (standard shares generic CURRENT's `id.ts.body` shape by its own
  spec, and was never vulnerable to either relabel shape).

## Source

`webhooks/verify.ts`: `verifyGithub`, `verifyGeneric`, `GENERIC_DELIVERY_ID_RE`.
`webhooks/ingress.ts`: `registerWebhookIngress`'s route handler (rate-check-before-dedupe-write ordering,
`result.httpStatus` handling, the once-per-endpoint legacy deprecation warning, the injectable `now` seam
on `WebhookIngressDeps`).
Tests: `webhook-verify.mjs` (github/generic-current/generic-legacy replay-under-a-fresh-header cases, the
CURRENT-only delivery-id charset/400 cases, the LEGACY-sender-with-a-dotted/129-char-id backward-compat
cases, and the Shape A/B relabel cases at the pure-function level), `webhook-ingress.mjs` (`(10)`
end-to-end replay dedupe for github and generic-legacy on a fixed clock; `(11)` the
rate-limit-then-successful-resend round trip; `(12)` Shape A/B end to end, proving at most one spawn;
`(13a)`/`(13b)` the CURRENT-format charset/400 rejection and the once-per-endpoint deprecation warning;
`(13c)` a LEGACY sender with a dotted id still fires + dedupes, end to end). All three rounds confirmed
RED on their respective pre-fix source (temporarily reverted) and GREEN after restoring the fix.
