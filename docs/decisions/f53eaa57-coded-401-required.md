# f53eaa57 — a 401 is `invalid` only when it carries the daemon's own coded body

From the CR of `a6d7bf36`. `classifyCredentialProbe` (`web/src/lib/credentialVerify.ts`) used to treat
ANY 401 as `"invalid"`, including one authored by an intermediary (a reverse proxy or corporate gateway
in front of a remote daemon). That was benign while the outcome only gated a token STORE — a wrongly
rejected paste just left the user able to retry. After `a6d7bf36` an `"invalid"` outcome can permanently
STOP a page's socket retry ladder, so a non-daemon 401 could brick a page's reconnects until a human
re-pasted the credential, with no daemon-side cause to fix.

This mirrors the rule the gateway path already applied to its coded 429 (card `a1ec70a6`): the daemon's
failed-auth 429 (card `cf9ebab9`) only ever rides `GATEWAY_TOKEN_REQUIRED_BODY`, so a bare 429 (an
intermediary's own throttle) stayed `"unknown"`. 401 gets the same treatment now, on both credential
paths.

## The two coded bodies

- **Gateway/remote** (`gateway/trust-tier.ts`'s `GATEWAY_TOKEN_REQUIRED_BODY`): `{ error: "unauthorized",
  code: "gateway-token-required", hint: … }`, sent on a 401 OR the coded 429. `isGatewayTokenRequired`
  already keyed on this `code` for 429; it now keys the 401 case too.
- **Loopback** (`gateway/server.ts`): `{ error: "unauthorized — see \`loom open\` for how to obtain the
  local access credential" }` — no `code` field, keyed on the message via `isCredentialGuardMessage`.

## Do not

- **Do not classify a 401 as `"invalid"` without consulting `provesRefusal`.** `classifyCredentialProbe`
  no longer short-circuits on `response.status === 401` — every status, 401 included, goes through the
  same `provesRefusal` consult as a path's own second refusal status (the gateway's 429). A path with no
  `provesRefusal` can never claim a 401 refusal at all.
- **Do not let a path's `provesPassage` be asked about a 401.** The classifier excludes it explicitly
  (`response.status !== 401 && provesPassage(...)`) so a loose passage predicate (e.g. loopback's `status
  < 500`) can never turn a refusal into a success.
- **Do not widen either path's `provesRefusal` to a bare status check.** The gateway predicate still
  requires `isGatewayTokenRequired`'s `code` match; the loopback predicate still requires the `loom open`
  message. A status-only widening reopens exactly the bug this card fixes, in the other direction.
