# eccd874c — `projectFields` masks `orchestration.alertWebhook.url`, with an echo-reject guard at the write chokepoint

## Context

Full review lane 6 (`edc931d8`) raised, as a policy question the lead ruled on: `orchestration.alertWebhook.url`
is a bearer credential (a Slack/Discord incoming-webhook URL) and is already human-only to WRITE
(`agentOrchestrationOverride` omits it; `validateAgentProjectConfigOverride` rejects it), but
`projectFields` (`mcp/entityRowFields.ts`) masked only `config.sessionEnv` — so every agent-facing MCP
read of a project (`project_get`/`project_update`/`list_all_projects`, on both the Platform Lead and
Setup Assistant routers, plus the operator's own `my_project`) returned the webhook URL verbatim. A
manager, Setup Assistant, or Platform Lead session that can merely *read* a project now gets a credential
it could never have obtained by writing.

## Decision

Mask `orchestration.alertWebhook.url` at the same chokepoint `bb267ade` used for `sessionEnv`:
`projectFields` (`mcp/entityRowFields.ts`), via a new shared primitive `redactAlertWebhookInConfig`
(`@loom/shared`, beside `redactSessionEnvInConfig`). The mask is `maskAlertWebhookUrl` —
`<scheme>//<host>/***` — which keeps a non-secret "configured, pointed at this host" indicator (the
`events` list is untouched) while stripping the path/query, which is where a Slack/Discord incoming
webhook actually carries its secret.

**REST is deliberately left alone.** `gateway/server.ts`'s project-returning routes are human-only
Settings REST (loopback-trusted, used by the Settings UI to let a human edit the stored webhook) — unlike
`sessionEnv` (which the UI only ever *writes*, never displays), the Settings webhook editor needs the
real value to show what's configured, so `redactSessionEnvForRead` stays scoped to `sessionEnv` only and
is NOT extended to mask `alertWebhook` too.

**The masked value is ALSO an accepted write payload on one surface**, and that surface needed its own
guard before this masking was safe to ship — same shape as `a253cec8` for `sessionEnv`. The Platform
Lead's `project_configure` (`mcp/platform.ts`) is the one write path that is BOTH reachable by a session
that can read a masked `alertWebhook.url` (via `project_get`/`list_all_projects`) AND validated by the
FULL human-equivalent validator (`validateProjectConfigOverride`), which — unlike the ordinary agent
validator — accepts `orchestration.alertWebhook`. Feeding a masked read straight back through
`project_configure` would silently overwrite the real webhook URL with the masked placeholder. Fixed by
adding an echo-reject check to `setProjectConfigSafe` (`tasks/columns.ts`), the one write chokepoint every
config writer already shares: `isMaskedAlertWebhookUrlEcho(newUrl, priorUrl)` rejects a write whose
`alertWebhook.url` is *exactly* `maskAlertWebhookUrl(priorUrl)`. Unlike `sessionEnv`'s same-length-bullet
mask (a SHAPE check), this mask is a deterministic function of the prior URL alone, so the echo check is
an exact-match comparison, not a shape check.

The ordinary agent validator (manager `project_update`, Setup Assistant `project_configure`) already
rejects `orchestration.alertWebhook` outright (schema `.strict()`, unrecognized key) — confirmed by
execution, unchanged by this card.

## Scope widened by lead ruling: `project_configure`'s own write-response (platform.ts AND setup.ts)

The first pass of this card masked only the chokepoint `projectFields` uses for READS. But both
`project_configure` handlers (`mcp/platform.ts`, `mcp/setup.ts`) build their OWN response manually —
destructuring `sessionEnv` out of the final stored config and reshaping it into `sessionEnvKeys` (card
`5d6e0ace`), but passing the REST of that config straight through, `alertWebhook.url` included. That
response is an ordinary READ of this project's `config` as a side effect of a write — including on
`setup.ts`, whose agent validator can never WRITE `alertWebhook` but still echoes a PRE-EXISTING one
set by a human or the Lead. So an agent that can only make a benign change (e.g. `docLint`) could still
read the credential back through this path, which defeats the whole point of masking it at `projectFields`.

Fixed by routing `configSansSessionEnv` through the SAME `redactAlertWebhookInConfig` on both sites,
right before it's returned — one masking rule for reads and write-responses alike. Both sites keep the
existing `isMaskedAlertWebhookUrlEcho` guard in `setProjectConfigSafe` as the backstop against a masked
response fed back as a later write (platform.ts's full validator accepts `alertWebhook`; setup.ts's
agent validator rejects it outright regardless, as before).

## ROUND 2 (lead gen 388, 2026-10-02) — Code Review 583a7641: APPROVE with two Minors fixed before merge

**1. The echo guard had a fixed-point lockout.** `isMaskedAlertWebhookUrlEcho` compared the incoming
`url` against `maskAlertWebhookUrl(priorUrl)` by EXACT STRING MATCH. Round 1's mask kept the host
(`<scheme>//<host>/***`), so a stored URL whose own path already happened to equal `/***` was a FIXED
POINT of its own mask — `url === priorUrl === maskAlertWebhookUrl(priorUrl)` all held at once, and the
guard rejected it as an "echo" even though the writer never touched `alertWebhook` at all (an unrelated
config merge just round-trips the stored, unchanged value). That blocked **every** config write to the
project forever, once such a URL was ever stored — human REST included, since `setProjectConfigSafe` is
the one write chokepoint every writer shares. Fixed two ways in `isMaskedAlertWebhookUrlEcho`
(`shared/src/config.ts`): (a) `url === priorUrl` is now checked first and never flagged, regardless of
mask shape — an unchanged value is never a clobber; (b) past that, the function matches the mask by
SHAPE (host exactly `***`, or — for a client still holding a stale pre-round-2 masked read — a path of
exactly `/***` once a trailing slash is stripped) instead of an exact string match, so a case or
trailing-slash variant of the mask (e.g. `HTTPS://***/`) is also caught, not just the one literal string
`maskAlertWebhookUrl(priorUrl)` would have produced.

**2. Mask the host too.** `<scheme>//<host>/***` still leaked the credential for a provider that puts the
secret in the subdomain rather than the path (e.g. Pipedream's `https://<token>.m.pipedream.net`). New
masked form: `maskAlertWebhookUrl` now returns `<scheme>//***` — only the scheme survives as the
"configured" indicator. Malformed input still falls back to the fixed `"***"`, as before.

**3. `redactAlertWebhookInConfig`'s doc comment now lists its real callers** (it previously claimed
`projectFields` was the ONE caller): `projectFields` (`mcp/entityRowFields.ts`), and `project_configure`'s
own write-response on both `mcp/platform.ts` and `mcp/setup.ts`.

**4. The limit this masking does NOT close, stated plainly:** human/loopback REST GETs
(`/api/projects`, `/api/projects/:id`, `/config/history`) still return `orchestration.alertWebhook.url`
unmasked, by design (settled policy `214caa53` — the Settings UI needs the real value to let a human edit
it, see the original "REST is deliberately left alone" decision above). A session with SHELL access (a
`run`/plain session, or any role whose profile grants `shell`/`gateCommand`) can reach those same loopback
REST routes via `curl`, or read the SQLite DB file directly, and get the real URL that way regardless of
what any MCP tool masks. **This masking protects shell-less agent roles and in-transcript disclosure on
the MCP surface — it is not a confidentiality boundary against a session that can run arbitrary commands
on the host.**

## Do not

- Do not revert `projectFields` to a raw pass-through of `config.orchestration.alertWebhook.url` — that
  reopens every MCP project-read site at once, since they share this one chokepoint.
- Do not extend `redactSessionEnvForRead` (`gateway/server.ts`) to also mask `alertWebhook` — the human
  Settings REST surface is the deliberate exception (the UI needs the real value to let a human edit it).
- Do not remove or weaken `setProjectConfigSafe`'s `alertWebhook.url` echo-reject check, and do not
  duplicate it at an individual MCP tool instead of routing through that one chokepoint — same reasoning
  as `a253cec8`'s guard for `sessionEnv`.
- Do not assume the ordinary agent validator rejecting `alertWebhook` makes the echo-reject guard
  redundant — the Platform Lead's `project_configure` uses the FULL validator, which accepts it; that is
  exactly the path the echo-reject guard exists to close.
- Do not assume a surface that can never WRITE `alertWebhook` is therefore safe to leave unmasked on its
  own READ-shaped responses (including a write-response that echoes config as a side effect, like
  `project_configure`) — `setup.ts`'s agent validator rejects writing it, but its `project_configure`
  response still echoed a pre-existing value until this card widened; "can't write it" and "can't read
  it back" are independent guarantees, and masking only covers the ones it's actually applied to.
- Do not revert `isMaskedAlertWebhookUrlEcho` back to an exact-string match against
  `maskAlertWebhookUrl(priorUrl)` — that is the round-2 fixed-point lockout above, and it also misses a
  case/trailing-slash variant of the mask.
- Do not treat this masking as a defense against a shell-capable session — it is not, and the "REST GETs
  are unmasked by design" limit above is deliberate, not an oversight to close here.
