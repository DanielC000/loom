# 4729d007 — back off on 429, send Retry-After, and size the per-token remote cap to a real UI

Card `4729d007` (found by `3fbb590a` on the web e2e fixture daemon). Three changes: the shared fetch layer backs off on 429, the daemon's limiter 429s carry `Retry-After`, and `perTokenPerMin` goes 120 → 600.

## What was wrong

One remote page load makes 25-34 `/api/` requests, and an idle open page makes 85-115 a minute. A remote browser holding a valid token is metered by `perTokenPerMin` (`gateway/server.ts` `allowToken`), default 120, so a single idle tab sat at the cap and any navigation tipped it over. The UI then retried each refused read straight away (one specimen: 88 requests, 68 of them 429) and the vault tree rendered "Empty vault folder." for a tree that never loaded. Refused requests are not recorded in the sliding window (`SlidingWindowCounter.allow` only records an allowed hit), so the immediate retries did not burn the window, but they never recovered either and hid the failure.

## Measurements (2026-11-05, web e2e proxy rig, real daemon, caps raised so nothing throttled, one seeded project)

Counted with `page.on("request")` on `/api/` paths, throwaway spec, since deleted:

- Full page load, 6s settle: 25-34 per route across 17 routes (`/settings` 55 is the outlier).
- Idle open page, 60s steady state: `/` 91, `/overview` 115, `/board` 99, `/platform` 85. Dominated by `GET /api/orchestration/events` at about 65/min and `/api/questions` at 20/min.
- Eight client-side route changes at 5s each: 131 requests in 40s (about 196/min, including the idle poll baseline).

Scope: one browser, one seeded project, an otherwise empty daemon. A busier project polls more.

## Decisions

1. **Client** (`web/src/lib/rateLimitBackoff.ts`, wired once in `guardedFetch`): an idempotent read (GET/HEAD) that gets a 429 waits and retries. The wait is the server's `Retry-After` (capped 60s) when present, else 1,2,4,8,16,30s, plus up to 25% jitter, never below the floor. With no header that is 61s of waiting across 6 retries, one full server window. The daemon always sends `Retry-After` now, so the header-path bound is min(Retry-After, 60s) × up to 1.25 per retry: ≤ 75s each and ≤ 7.5 min worst case across 6 retries. The backoff honours `init.signal`, but react-query's abort signal is not threaded through `lib/api.ts` today, so a cancelled or unmounted query still runs its backoff sleep and its request (follow-up: card `6ef3a2bc`). (Card `11d20bf5` chose to document this bound rather than cap total elapsed time, which would turn a recoverable saturation into a surfaced error sooner than the server window allows). Exhaustion throws `RateLimitedError` (message keeps the `<url> -> 429` shape) so a pane sees an error, never empty data. A banner (`RateLimitBanner`) says "rate limited, retrying in Ns" while any request sleeps. react-query's own 3 retries are skipped for `RateLimitedError` so the two budgets do not multiply.
2. **Server**: every limiter 429 in the trust-tier hook sets `Retry-After` = `ceil(retryAfterMs / 1000)`, floor 1, from `SlidingWindowCounter.retryAfterMs` for the bucket that refused (`RemoteRateLimiter.retryAfterSecs`). Body and status are unchanged; no test pinned the 429 headers. The failed-auth 429 reports its own 600s window.
3. **Default**: `perTokenPerMin` 120 → 600 (`shared/src/config.ts` `PLATFORM_DEFAULTS.remoteAccess.rateLimit`, and the duplicate defensive fallback in `gateway/server.ts` which must stay in sync). `perIpPerMin` stays 120. 600 is about 3x the navigation rate, 5-6x one idle tab, and leaves room for 3-5 tabs or devices on one token. Still human-overridable.

## Security trade-off

- A valid-token UI never draws on the per-ip bucket (verify-first: `verifyThenThrottle` returns after `allowToken` for a verified token), so raising `perIpPerMin` would only widen the unauthenticated and webhook ceiling for no measured benefit. It was left at 120.
- Raising `perTokenPerMin` only loosens the request budget of a caller who already holds a valid token. It cannot help a guesser: a wrong or absent token never reaches `allowToken`.
- Brute force is bounded by the failed-auth throttle, not by the request caps: 5 presented-but-invalid attempts per 10 minutes per ip on the direct listener (`authFailLockout`, `allowIpFailedAuth`), 30 a minute on the shared proxy bucket (`PROXY_FAILED_AUTH_PER_MIN`), and gateway tokens are 256-bit (`@decision 4cbbc343`). None of that moved.
- `Retry-After` discloses only the remaining window length of the caller's own bucket.

## PLATFORM_DEFAULTS method (grep of the old value)

`git grep perTokenPerMin` and `perIpPerMin` across `packages`, plus `120` / `120_000` forms near rate wording, 2026-11-05: the only default-value sites are `config.ts` and the `server.ts` fallback (both changed). Every test hit is an explicit override or a validator bound (200, 120, 1000, 60, 50, 3), none equal to 600; `platform-forensics-reads.mjs` carries an explicit 120/120 override and asserts the echo of that override, not the default, so it is unchanged. The `120_000` hits in `config.ts` are unrelated millisecond bounds.

## Other panes that render "empty" with no error branch (listed, NOT fixed here)

Heuristic only (file-level: uses `useQuery(`, has empty-state wording, and no `isError` / `.error` reference at all), not a per-pane audit: `components/AtlasShell.tsx`, `AtlasTree.tsx`, `SessionNode.tsx`, `SessionQueue.tsx`, `SessionWakes.tsx`, `Sidebar.tsx`, `TerminalCard.tsx`, `TranscriptPane.tsx`, `projectSchedules.tsx`, `workspaceReplay.tsx`, `pages/AgentsNode.tsx`, `MissionControl.tsx`, `PlatformFindings.tsx`, `ProjectHome.tsx`, `WorkspaceHome.tsx`. Files with some `isError` reference may still have an unguarded pane. The shared banner now makes a rate-limited state visible app-wide, but these panes can still read "nothing here" during a failure or a pending load.

## Not done

The idle `/api/orchestration/events` poll (about 65/min) is the real cost driver; moving it to the websocket delta push is a separate card.

### Do not

- Do not retry a 429 immediately, retry a non-idempotent request, or retry the coded failed-auth 429 (a bad token is not fixed by waiting).
- Do not raise `perIpPerMin` to fix UI rate limiting; the UI is metered by `perTokenPerMin`.
- Do not let the `gateway/server.ts` fallback literal drift from the `PLATFORM_DEFAULTS` value.
- Do not render "empty" for a query that is pending or errored.
