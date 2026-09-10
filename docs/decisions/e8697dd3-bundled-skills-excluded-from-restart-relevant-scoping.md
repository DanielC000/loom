# e8697dd3 — `assets/skills/**` is excluded from the restart-relevant reasoning, not covered by it

## Narrative

`assets/skills/**` is DIFFERENT from the other assets `deploy-staleness.ts` deliberately ignores (`hook-relay.mjs`, `vault-lint/**`, both read live per-use with no restart needed): a bundled skill is delivered to sessions from a separate STORE (`<LOOM_HOME>/skills/<name>/SKILL.md` — see `skills/inject.ts`), and that store only re-syncs from `assets/skills/**` on daemon boot/restart (`seedGlobalSkills()`).

`stale`/`commitsBehind` correctly never counts an assets-only merge either way, because the question they answer is "does the daemon PROCESS need a restart", not "does anything need a restart". Their silence on `assets/skills/**` must not be read as "that subtree needs no restart too" — it needs one for a different reason (the skill store), tracked by its own independent signal.

## Do not

- Do not generalize this module's silence on `assets/skills/**` into "no restart needed there" — see `skills/store.ts`'s `skillStoreStaleness()` for the signal that actually answers that question, surfaced on `served_status` as its own field.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
