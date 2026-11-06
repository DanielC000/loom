# 742e8b02 — redact transformed echoes of a connection secret

`authenticated_request` used to redact only the EXACT secret from a response's body, header values and `location`. A target that echoes the credential transformed (4xx pages, debug reflections) leaked it to the agent, for every placement: `X-API-Key`, a custom `apiKeyHeader`, bearer and OAuth2 (all four reach one function, `performAuthenticatedRequest`, and one redaction seam).

## What is redacted now (`connections/redact.ts`)

A redactor is built per request from the decrypted secret and applied to the body, every header value and `location`; every covered span is replaced by the fixed text `[REDACTED]`. It is decode-then-match, with no regex built from the secret (an earlier per-character regex backtracked exponentially on a run of backslashes in the secret, and was quadratic on periodic secrets). Three searches, all linear literal searches (KMP):

**1. Decoded stream.** The text is tokenized ONCE, left to right, into decoded characters, each keeping its source span, so any MIX of styles within one echo matches (partial encoding, `&quot;` beside `&#x27;`, `quote(safe='/')`). Forms decoded (literal comparison is case-exact):

- `%hh` with either hex case, UTF-8 multi-byte sequences joined into one character (this subsumes every unescaped-set convention: encodeURIComponent, RFC 3986, quote/quote_plus, urlencode, alnum-only);
- `+` as a space. A raw `+` is ambiguous (plus or space), so a secret holding both `' '` and `'+'` is searched under both readings; an echo that uses a raw `+` for BOTH meanings is not matched;
- HTML: named `&amp; &lt; &gt; &quot; &apos;`, decimal `&#N;` and hex `&#xN;` (either `x`/hex case, up to 16 leading zeros, at most 7 decimal / 6 hex significant digits). Any code point decodes, not just the five markup characters;
- JSON: `\uXXXX` (a high+low pair joins into one character), `\/`, `\"`, `\\`.

A hit in the decoded stream is mapped back to its source span. An encoded-looking sequence is always decoded in the mixed view, so a literal `%41` in the body reads as `A`. That usually ADDS redaction around a real match, but the greedy mixed decoder can also REMOVE a match: (a) a stray escape lead right before a transformed echo consumes the secret's first characters (secret `4Ab/cd9`, body `x%4Ab\/cd9y`: `%4A` decodes to `J`); (b) a secret that itself holds an encoded-looking sequence, echoed under a DIFFERENT transform that leaves that sequence alone (secret `ab%41/cd`, body `ab%41\/cd`).

**Single-scheme views.** To recover those, the same decoded-secret search ALSO runs over each single-scheme decode of the body: `%`/`+` only, HTML only, JSON only (same tokenizer, same offset maps; a view is skipped when its lead character is absent, since it would equal the raw pass). The search is therefore: mixed decode + three single-scheme decodes + the raw pass, with all spans merged. What this still does NOT catch: a secret echoed through two DIFFERENT schemes at once whose mixed decode is itself broken by a stray lead or by an encoded-looking sequence in the secret (e.g. an encoded-looking secret echoed with both a `\/` and a `%2F`).

**2. Exact secret in the RAW text.** Guarantees exact redaction even for a secret that itself contains `%41`, `\\` or `&amp;` and is echoed verbatim (the decoder reads those differently).

**3. Base64.** The whole secret, padded and unpadded, standard and url alphabet (these are as long as the exact secret, so they carry no floor); and three alignment "cores" for a secret EMBEDDED in a larger base64 payload: the base64 of the secret at byte offset 0, 1 and 2 (mod 3) with the 1-2 boundary characters that depend on neighbouring bytes trimmed, both alphabets. This catches `base64("user:" + secret)` (Basic style) and `base64("Bearer " + secret)` at any alignment.

`Basic base64(user:secret)` is not sent by any path of this tool (bearer and oauth2 send `Bearer`, api-key sends the bare secret in a header), but an echo that base64-embeds the secret is caught by the cores regardless.

## Decisions

- **Exact redaction is never weakened.** It applies to a secret of any length.
- **No length floor on the decoded match or the whole-secret base64 forms.** An earlier version skipped derived variants shorter than 8 characters on an over-redaction rationale. That rationale did not hold: a derived form is never shorter than the exact secret, so redacting it costs no more than redacting the exact secret already does.
- **A floor of 8 characters on the base64 CORES only.** A core is a fragment of the secret's base64, so for a short secret the trimmed core can be a few characters that occur by chance in unrelated base64 and would shred it. 8 characters (48 bits) is not found by chance. A secret whose cores are shorter simply has no core needle; its whole-secret base64 forms still apply. This is a floor on a different, separate needle, and it is why a 1-2 byte secret's base64 *core* is absent while its whole-secret base64 form is still redacted (test D asserts that deliberately).
- **Cost: O(text x needles), independent of the secret's content.** One decode pass (O(1) work per position: entity padding and digits are bounded) plus one KMP pass per needle (the decoded secret, the raw exact secret, up to 4 whole-base64 forms, up to 6 cores; at most ~12 needles), plus an O(text) difference-array merge (overlapping AND adjacent spans become one marker). The three single-scheme decodes add a constant factor of at most 3 decode+search passes. It is NOT "linear by construction" in the strict sense: it is linear in the text for a fixed needle count, and memory is a few `Int32Array`s of text length. A secret holding both `' '` and `'+'` adds one more decoded-stream pass. Measured solo: every adversarial shape at 1 MB is below ~160 ms (backslash-run secret, 4095-char periodic secret, `%25`/`&amp;`/`&#38;` periodic secret). The pre-fix regex took 34 s (n=24) / 1.9 s (n=20) on the backslash run and 14 s on a 1023-char periodic secret against 200 KB.
- **Defence in depth: a fail-closed time budget.** Each redact call carries a wall-clock budget (`REDACT_BUDGET_MS`); past it the redactor throws `RedactionBudgetExceeded` and `authenticated_request` returns a fixed error, NEVER the unredacted response. Not expected to trip.

## Out of scope (deliberately)

- Double encoding (percent-encoded base64, base64 of a percent-encoded form, HTML-of-JSON).
- Partial or truncated echoes of the secret. For an embedded secret the 1-2 untrimmed boundary characters of its base64 and any `=` padding can remain visible (a few bits).
- Other transforms: hashes, ROT13, reversal, MIME-wrapped (line-broken) base64, other base encodings, HTML entities for characters other than `& < > " '`, JSON short escapes other than `\/ \" \\`.
- A base64 core of a secret too short to yield a core of 8 characters (only the whole-secret forms apply).
- Header NAMES and `Set-Cookie` (which is dropped outright).

## Do not

- Do not skip the exact secret because it is short.
- Do not re-introduce a length floor on the decoded match or the whole-secret base64 forms.
- Do not build a regex from the secret again, and do not make the match case-insensitive: it would over-redact.
- Do not drop the raw exact-secret pass because the decoded pass "also finds it": a secret that looks encoded is only found there.
- Do not grow the needle set ad hoc to chase one target's quirk; each addition widens over-redaction risk for every secret.

Tests: `packages/daemon/test/connections-redact-variants.mjs`.
