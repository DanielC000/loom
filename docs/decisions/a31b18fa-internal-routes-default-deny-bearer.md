# a31b18fa — `/internal/*` is default-deny under the loopback-secret guard

The guard used to be an allow-list (`POST` + five named routes), so any other `/internal` route was reachable by any loopback caller without the secret. `GET /internal/merge-quarantine/list` (canonical repo paths + quarantine reasons) was one; the test-mode `/internal/test/*` routes were others. Found by the Rust judge.

Now every method on every route under `/internal/` requires `Authorization: Bearer <loopbackSecret>` unless the pattern is in `INTERNAL_BEARER_EXEMPT` (`gateway/server.ts`), today only `/internal/hook` (own per-session `hookToken`, @decision a2407ed4).

## Why `/internal` GETs are gated while `/api` GETs are not

214caa53 settled that `/api/*` GETs stay ungated: they are the web viewport's read API, filesystem access already grants the same view, and gating them costs the UI/CLI/health probes. `/internal/*` is the operator/admin surface (lifecycle, quarantine, test oracles), not the viewport's read API; nothing in the UI reads it, so default-deny costs no legitimate caller.

## Do not

- Do not add an `INTERNAL_BEARER_EXEMPT` entry without an equivalent credential on the route.
- Do not turn this back into a per-route allow-list of guarded `/internal` routes.
- Do not extend this to `/api/*` GETs; that stays governed by 214caa53.
- E2E: the fetch patch in `packages/web/e2e/fixtures/daemon.ts` attaches the bearer to every `/internal/*` request, any method; keep it matching the server rule.
