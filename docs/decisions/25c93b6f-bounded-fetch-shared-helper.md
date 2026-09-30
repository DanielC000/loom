# 25c93b6f — one shared bounded-fetch helper for every secret-bearing outbound call under `connections/`

## Background

`connections/oauth.ts`'s token-endpoint POST used the bare default `fetch`: `redirect: "follow"` (a
307/308 from the token endpoint re-POSTs `client_secret` + `refresh_token`/`code_verifier` to the
`Location`, even cross-origin — credential exfiltration), no `AbortSignal` timeout (a hung token endpoint
pinned `inFlightRefresh` forever, wedging every later `authenticated_request`/poll on that connection),
and an unbounded `.text()` read whose first 500 chars were then returned straight to the agent on error.
Meanwhile `connections/request.ts` already had all three protections, independently implemented.

`connections/boundedFetch.ts` is the one shared implementation now used by `oauth.ts`, `request.ts`, and
`sonarqube.ts`'s pre-save credential probe — the three fetch call sites under `connections/`.

CR follow-up (Code Review `da2484d9` of the first landing, `2b7cf184`): that commit's `request.ts` change
only threaded `guard` into `ensureFreshOAuthToken` — it still had its own duplicate `readBoundedBody` and
its own hand-rolled `fetch`/`AbortController`/`redirect:"manual"` block, never actually calling
`boundedFetch`. Fixed in the same PR before merge: `request.ts`'s `performAuthenticatedRequest` now calls
`boundedFetch(url, {..., treatRedirectAsError:false})` directly, and the duplicate `readBoundedBody` is
deleted. `authenticated-request.mjs` stayed green throughout, including test "1f" (a 3xx is surfaced as
`{status,location}` data, never followed).

Same follow-up also caught that `sonarqube.ts` had reordered its status-vs-body-cap check: the ORIGINAL
code checked `response.status === 401/403` before ever touching the body, so an oversized 401 body could
never mask the "token rejected" message. `boundedFetch` always attempts to read/cap the body as part of
one call, regardless of status, so a naive "check `result.ok` first" port would misreport an oversized
401 as a byte-cap failure. Fixed by giving `BoundedFetchResult`'s error variant an optional `status` field
(populated whenever a real response arrived — redirect, oversized, or a body-read timeout) and having
`sonarqube.ts` check `result.status` for 401/403 BEFORE branching on `result.ok`. An over-cap 2xx body is
a deliberate, explicit failure (never silently truncated then parsed) — see the "Do not" list.

## Do not

- Do not add a fourth outbound `fetch`/`fetchImpl` call anywhere under `connections/` that bypasses
  `boundedFetch` — every one of them carries a secret (a bearer/API-key header, an OAuth
  client_secret/refresh_token, or a credential being validated pre-save) and needs all three guarantees
  (manual redirect, timeout, streamed byte cap), not a subset re-derived by hand.
- Do not let `treatRedirectAsError: false` become the default, or spread beyond `request.ts`'s
  `authenticated_request` tool. That tool surfaces a 3xx as `{status, location}` to its caller by
  deliberate, tested design (`authenticated-request.mjs` test 1f) — the credential is still never resent
  to the redirect target either way (`redirect: "manual"` is unconditional), but every OTHER call site
  under `connections/` (a token endpoint, a pre-save probe) treats a 3xx as a hard error, since there is
  no legitimate reason for a credential-bearing token/validation endpoint to redirect at all.
- Do not read a token-endpoint redirect as `recoverable: true` in `oauth.ts` — it marks the connection
  `needsReauth` (see `postTokenRequest`) rather than silently retrying, since a persistent
  misconfiguration or an actual redirect-based attack won't self-heal on a retry with the SAME refresh
  token, and the human should see it.
- Do not branch on `result.ok` before checking `result.status` in a caller that needs a status-specific
  message even when the body couldn't be read (`sonarqube.ts`'s 401/403 check is the concrete case) — an
  oversized or redirected response still carries a real status on `BoundedFetchResult`'s error variant;
  checking `ok` first silently downgrades a specific, actionable status-based message to a generic
  byte-cap/redirect one.
- Do not change an over-cap 2xx body from a hard `oversized` failure back to a silent truncate-then-parse
  — that was the pre-existing `sonarqube.ts` behavior and it produced a flaky, misleading "did not return
  the expected JSON" error instead of naming the real cause. A genuine `/api/users/current` (or a real
  OAuth token) response is always small; an oversized one is itself anomalous and should fail loudly,
  same posture as a redirect.

Full record: docs/decisions/25c93b6f-bounded-fetch-shared-helper.md
