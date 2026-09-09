# 93249b52 — `/internal/shutdown` and `/internal/update` covered by the loopback-secret bearer guard

## Narrative

### Graceful shutdown control hook

`POST /internal/shutdown` is the cross-platform stop path for `loom stop`: Windows detached processes have no real SIGTERM, so the management CLI can't signal a backgrounded daemon into its graceful teardown and POSTs here instead. This triggers the SAME path the SIGINT/SIGTERM handlers run (snapshot live transcripts → stop every watcher → exit 0). Exits 0 (clean stop), NOT 75 (75 is the supervisor's RESTART sentinel — a stop must never relaunch).

Trust posture: loopback-gated (the explicit `!LOOPBACK` → 403 check), NOT an agent MCP tool, unreachable by any agent session (same boundary as the gate/vault/git writers) — AND, closing the gap card `9ccedbee`'s own Code Review flagged (this route fetches nothing but STOPS the daemon, a real capability an unauthenticated co-resident agent should not have), additionally covered by the SAME loopback-secret bearer guard as every `/api/*` write, via the `isGuardedInternalWrite` check in the onRequest hook above — this route's own `!LOOPBACK` check stays as the fail-closed backstop for a non-loopback caller and for the (test-only) case where `deps.loopbackSecret` is unset. `bin/loom.mjs` (`loom stop`) reads the SAME secret file the browser reads (`readLoopbackSecret`) and sends it as `Authorization: Bearer <secret>` — see that file's `postShutdown`.

This is a DIFFERENT mechanism than `/internal/hook`'s (card `a2407ed4`): that route is gated by a per-session token instead of this shared bearer secret, because its caller (a child of the vendor CLI, invoked on every hook of every session) has no straightforward way to hold or present a shared secret the way this human-driven (`loom stop`) / browser caller can. Neither implies the other; each caller shape got the mechanism that actually fits it.

We ack 202 first and defer the exit one tick so the response flushes before the process dies (the CLI reads the ack, then polls the port until it stops answering).

### Self-update control hook

`POST /internal/update` (Epic 2c-2, UI half) is the "Update & restart" button's target. Trust posture: loopback-gated (the explicit `!LOOPBACK` → 403 check), NOT an agent MCP tool, unreachable by any agent session (same boundary as `gateCommand` / the vault+git writers) — AND (this card) ALSO covered by the loopback-secret bearer guard, same as `/internal/shutdown`: this route FETCHES AND INSTALLS CODE on a packaged install, a strictly larger blast radius than any `/api/*` write the guard already covered, so leaving it on the old loopback-only posture was the larger gap.

The browser is the only real-world caller (`packages/web/src/lib/api.ts`'s `triggerUpdate`) and already sends the same bearer header every other write does (`authHeaders()`) — `bin/loom.mjs`'s `loom update` CLI command does NOT call this route at all, it drives its own stop→npm-install→start cycle directly (verified by reading `bin/loom.mjs`: no `/internal/update` reference anywhere in it), so no CLI change was needed here (contrast `/internal/shutdown`, which the CLI DOES call).

PACKAGED-ONLY (load-bearing): the npm reinstall is valid only for an npm-global `loomctl` install — npm-installing over a checkout would be wrong — so a from-source daemon REFUSES with 409 and a clear message (and its banner never shows anyway: `GET /api/update-status` reports `packaged:false`). On a packaged install we ack 202 and defer the spawn one tick so the response flushes first; the detached `loom update` (E2c-1) then runs stop→install→start. A packaged end-user daemon runs NO supervisor, so the exit-75 restart sentinel never applies here — the stop→install→start cycle is the restart path.

## Do not

- Do not leave `/internal/shutdown` or `/internal/update` gated by loopback-IP alone — both must also pass the shared loopback-secret bearer guard (`isGuardedInternalWrite`); either route's real capability (stop the daemon / install+restart code) is too large a blast radius for co-resident-agent reach.
- Do not let `/internal/update` run the npm reinstall against a from-source (non-packaged) daemon — refuse with 409; only a packaged `loomctl` install may reinstall.
- Do not respond to either route before deferring the actual shutdown/update by a tick — the ack must flush before the process dies or the spawn begins.

## Source

Inline comments in `packages/daemon/src/gateway/server.ts` (`POST /internal/shutdown`, lines 2786-2808; `POST /internal/update`, lines 2815-2831, as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
