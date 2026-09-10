# 637558ca — `stale`/`commitsBehind` scoped to restart-relevant paths only (cry-wolf precedent)

## Narrative

`stale`/`commitsBehind` are deliberately scoped to ONLY the paths whose changes actually require a rebuild+RESTART of the daemon process to take effect — `packages/daemon/src` and `packages/shared/src` (see `DEPLOY_PACKAGES`). `assets/hook-relay.mjs` and `assets/vault-lint/**` are read live per-use straight from the package dir with NO restart needed, and a vault/docs-only merge needs no restart either — these must never trip this signal: a signal that cries stale on those gets ignored within a day, which is worse than no signal at all.

This is the reason `commitsBehind` is NOT comparable 1:1 with an unscoped "any file changed" check (e.g. `processBuiltShaMatchesHead`) — reading `0` here while that unscoped check is `false` is not a contradiction, it means mainline moved on a non-restart-relevant commit.

## Do not

- Do not widen `stale`/`commitsBehind` to count docs/assets/scripts/tests changes — that reintroduces the cry-wolf failure mode this card exists to prevent.

## Source

Inline module-doc comment (`DoD #2`) in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
