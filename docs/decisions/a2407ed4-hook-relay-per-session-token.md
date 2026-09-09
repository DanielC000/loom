# a2407ed4 — hook relay gated by a per-session token, not the shared loopback bearer secret

## Narrative

`/internal/hook` (the SessionStart hook relay, `assets/hook-relay.mjs`) is invoked by a child of the vendor CLI on every session start/resume — high-frequency, not human-driven — so it has no straightforward way to hold or present a shared secret the way a human-driven `loom stop`/browser caller can. Card `93249b52` considered and rejected extending `isGuardedInternalWrite` (the loopback-secret bearer guard used for `/internal/shutdown` + `/internal/update`) to cover this route too, for exactly that reason: gating it wrong breaks every spawn on the daemon.

That exclusion left `body.sessionId` CALLER-SUPPLIED with no requirement at all — `deliverHook` (`pty/host.ts`) early-returns only on an unknown id or a non-"claude" kind, so any co-resident caller (loopback + a guessable/enumerable sessionId — card `9ccedbee` gates only non-GET `/api/*`, so `GET /api/sessions` stays open) could forge a hook against any live session it had no relationship to. `verifyHookToken` closes that zero-effort path with a DIFFERENT mechanism than the bearer guard: a per-session token minted at spawn (see `Live.hookToken`'s own doc), baked into the relay's own command line alongside the sessionId/port already there — so the relay never needs to hold or read a shared secret, only present the value it was already invoked with.

This is NOT "hooks are now authenticated" and does not achieve isolation — under same-OS-user co-residency with no sandbox, a caller that deliberately reads the TARGET session's own `settings.json` (where the token rides) can still extract it; that ceiling is inherited from card `93249b52`, not closed here. What changed: targeting a session now requires a deliberate, per-target read instead of a bare guess, and a leaked token is scoped to the one session it belongs to — never a fleet-wide bypass.

## Do not

- Do not extend the loopback-secret bearer guard (`isGuardedInternalWrite`) to cover `/internal/hook` — it is high-frequency and not human-driven; gating it wrong breaks every spawn.
- Do not read a fix here as closing the same-OS-user co-residency ceiling — a caller that reads the target session's own `settings.json` can still extract its token.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`POST /internal/hook`, lines 2749-2771 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
