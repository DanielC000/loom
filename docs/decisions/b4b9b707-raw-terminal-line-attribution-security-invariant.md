# b4b9b707 — a raw-terminal-typed line is attributable ONLY from `writeStdin`, TTL-bounded, and always consumed

## Narrative

Card `b4b9b707`: at `UserPromptSubmit`, a non-null `live.pendingRawOwnerSubmit` is attributed to `live.ownerText` for the just-confirmed turn. SECURITY INVARIANT (see `Live.pendingRawOwnerSubmit`'s own doc): `submit()` clears this field FIRST, before writing a single byte, so a non-null value here can ONLY have originated from `writeStdin` — never from any Loom-issued `submit()` (kickoff/nudge/redirect/worker-report drain/rate-limit replay/companion/composer). That ordering is what makes the field trustworthy as a raw-terminal signal at all.

TTL-bounded (`RAW_OWNER_SUBMIT_TTL_MS`): a raw Enter that lands on a non-composer TUI surface (a permission/resume-gate prompt) never itself starts a new turn, so nothing clears or overwrites the field afterward. If it sits unconsumed past the TTL, discard it rather than risk attributing stale human text to a later, unrelated prompt.

Consumed (read + cleared) either way — attributed or discarded as stale, it must never survive this check into a later turn. Freshness alone is not sufficient for attribution either: a fresh line raced in during a submit()'s own outstanding-Enter window is still discarded, not attributed — see `fca6af6d`'s `submitWasOutstanding` check, which runs first and gates this one.

## Do not

- Do not attribute `pendingRawOwnerSubmit` without checking it against `RAW_OWNER_SUBMIT_TTL_MS` — an unconsumed stale line can misattribute to an unrelated later prompt.
- Do not skip clearing `pendingRawOwnerSubmit`/`pendingRawOwnerSubmitAt` regardless of outcome (attributed or discarded) — leaving either set risks a second, wrong attribution on a later hook.
- Do not attribute on freshness alone — a fresh but raced-in line (submit() outstanding, see `fca6af6d`) is not this turn's own attestation.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `UserPromptSubmit` case in `deliverHook`), as of `main` `0cac46b89a9d2ad236117c355fb93d43f4f0f03f` (this tranche's starting HEAD). Extracted by card `7f448888` (tranche 19 on `pty/host.ts`). `b4b9b707` is cited earlier in the same hook at `fca6af6d`'s discriminator capture; see that record for the producing side.
