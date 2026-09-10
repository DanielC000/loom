# c3ce92ea — `packages/web` gets its own independent `webStale` signal, not folded into `stale`

## Narrative

`packages/web` is deliberately excluded from `stale`/`commitsBehind` — a web-only merge must never advise a `daemon_restart`, which drops every live session across ALL projects. But it isn't ignored: the daemon serves `packages/web/dist` LIVE FROM DISK on every request (`@fastify/static`'s `root`, `gateway/server.ts` — confirmed by reading that registration, not assumed), so a web-only change needs only a REBUILD, never a restart. That gets its own independent signal, `webStale`/`webCommitsBehind`, comparing `packages/web/src` commits against `packages/web/dist`'s own build clock.

A prior version of this module's doc claimed `served_status`'s `webBundle` hash check already covered this. It does not: `webBundle` only proves a hash changed AFTER a rebuild — it has no notion of "commits landed since the last rebuild" and cannot answer "is a rebuild needed right now", which is what `webStale` answers instead.

## Do not

- Do not fold web-source changes into `stale`/`commitsBehind` — that would trigger a fleet-wide restart for a rebuild-only change.
- Do not treat `served_status`'s `webBundle` hash as a substitute for `webStale` — a hash proves a change happened, not that one is still pending.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
