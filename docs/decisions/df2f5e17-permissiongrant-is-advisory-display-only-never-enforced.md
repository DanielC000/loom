# sha:df2f5e17 — a permission grant's `{scope, expiresAt, lapsed}` is advisory-display only, never enforced

## Narrative

Commit `df2f5e17` (`fix(mcp): persist and surface permission-request scope/expiry (or honestly document it as advisory)`) resolves a choice named in its own subject: build real server-side enforcement of a decided grant's scope/expiry, or leave it a display-only signal and document that honestly. It chose the latter.

`permissionGrant` (`packages/daemon/src/mcp/questionTool.ts`) derives `{scope, expiresAt, lapsed}` from the human's ANSWER-TIME `decidedScope`/`decidedExpiresAt` — never the ask-time `permissionScopeHint`/`permissionExpiresAt` hint, which is a separate, unenforced REQUEST the asking manager made (see both fields' own doc on `Question`). `lapsed` is a READ-TIME-derived boolean only (`decidedExpiresAt` is set AND in the past) — a "once" or no-expiry grant (`decidedExpiresAt: null`) is `lapsed:false`, not a null-comparison artifact.

NULL-SAFE for a row answered before this card shipped (both `decided*` fields null — never captured at all): surfaces `{scope:null, expiresAt:null, lapsed:false}`, so an absent grant record is never mistaken for an expired one.

ADVISORY ONLY: `lapsed` is a display signal — Loom never itself revokes, blocks, or re-checks a live grant against it. The asking (or a recycled successor) manager must read `lapsed` and honor it, the same posture as `provisionTo`'s "stating intent only."

## Do not

- Do not derive a permission grant's `{scope, expiresAt}` from the ask-time hint (`permissionScopeHint`/`permissionExpiresAt`) — always the answer-time `decidedScope`/`decidedExpiresAt`; the hint is a separate, unenforced request the manager made.
- Do not have Loom itself enforce, revoke, or re-check a live grant against `lapsed` — it is a display signal only; the manager holding the grant is responsible for reading and honoring it.
- Do not treat a null `decidedExpiresAt` (a "once" or no-expiry grant) as `lapsed` — only an explicit expiry that has passed counts.

## Source

Inline comment in `packages/daemon/src/mcp/questionTool.ts`, above `permissionGrant` (lines 215-229, pre-tranche-2 numbering), as of this tranche's HEAD. No board card cited anywhere in the block; keyed to the introducing commit per the extraction program's sha-grammar carve-out. Sourced via `git blame`, then `git rev-parse --verify df2f5e17515d4497672831aa7051b76bf273218e` (`fix(mcp): persist and surface permission-request scope/expiry (or honestly document it as advisory)`) — a genuine feature commit, not a bulk move.
