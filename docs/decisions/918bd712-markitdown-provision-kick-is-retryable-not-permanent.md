# 918bd712 — `kickMarkitdownProvision` is RETRYABLE, not a permanent one-shot

## Narrative

`kickMarkitdownProvision` kicks BACKGROUND provisioning of the shared venv's markitdown (async `child_process.spawn` under the hood, never `spawnSync`), so the heavy venv-create + pip install runs OFF the event loop.

The dedupe guard (`markitdownProvisionInFlight`) is deliberately scoped to ONLY a genuinely in-flight install, so concurrent `documentConversion` spawns never launch parallel pip installs — but after a TERMINAL outcome (ready/failed) the in-flight flag clears and a fresh kick is allowed. So a profile-save pre-warm, a later spawn, or an explicit `POST /api/python/provisioning/retry` all actually retry.

This replaces an earlier, PERMANENT `markitdownProvisionTried` flag that dead-ended every retry until a daemon restart — a failed install could never be retried without a full restart, regardless of how many later spawns or explicit retry calls asked for one. That defect is what this card fixes.

On success the kick lands the resolved binary into the `markitdownBin` memo (subsequent spawns inject it) and the status flips to `ready`; on failure it warn-logs the SPECIFIC classified reason + captured tail and the status flips to `failed` (documentConversion sessions keep spawning WITHOUT the MCP, best-effort), retryable as above.

## Do not

- Do not reintroduce a permanent one-shot "already tried" flag for markitdown provisioning — it dead-ends every retry (profile-save pre-warm, a later spawn, the explicit retry endpoint) until a daemon restart. The dedupe guard must be scoped to genuinely in-flight only.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`kickMarkitdownProvision`'s function doc), as of this tranche's HEAD (commit `1d2e8e78`). No card id anywhere in the block, the file, or `git blame`'s introducing commits — sourced via the `sha:` grammar. Bulk of the block (the retryable-dedupe narrative) introduced by commit `918bd7128849010cb2c72979054346d26284b139`; the opening/closing lines by `4190609d5b62c9dc3d700483a9f1b672bf68f2a3`. Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
