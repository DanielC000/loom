# 5b55149b — the shared reader never fell back to the legacy `token` field when `tokens` was an EMPTY array

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 5b55149b (Code Review of 7a7e041b, reviewer 47f5c0e3) — the shared reader never fell back to the legacy `token` field when `tokens` was an EMPTY array

Both minor, non-blocking, fail-closed.

1. **Legacy token lost.** `readSurvivingOnDiskTokens`'s own array-type guard — `Array.isArray(parsed.tokens)
   && parsed.tokens.every(...)` — treats `tokens: []` as a VALID (if empty) string array, so it never fell
   through to the `token` singular fallback at all; that fallback only ever fired when `tokens` was missing
   or malformed. For `{tokens: [], token: "x"}`, `raw` came back `[]`. The one caller that matters most here
   is `protectOccupantContentBeforeDelete`: its own skip condition (`rawTokens.length > 0 &&
   survivingTokens.length === 0`) never fires when `rawTokens` is itself empty, so it fell through to
   `tokens = survivingTokens.length > 0 ? survivingTokens : [randomUUID()]` and minted a BRAND-NEW random
   token standing in for the real legacy one — `x`'s own holder can no longer clear it by token, and only a
   human full-clear can lift it. Reachability was essentially nil (no current writer emits `token:` or
   `tokens: []`), but the fallback shape itself was simply wrong.
2. **Test overstated its coverage.** `7a7e041b-mixed`'s own narrative (this record, Follow-up `7a7e041b`,
   Tests section) claimed keepTok survives "in-process and across a reboot" — but every reboot check in
   that scenario ran AFTER keepTok was already cleared, so survival across a reboot while still held was
   never actually asserted.

### The fix

1. `readSurvivingOnDiskTokens` (merge-quarantine.ts) now requires `parsed.tokens.length > 0` as part of
   the array-type guard, so an empty array falls through to the `token` singular fallback exactly like a
   missing or malformed one — the `clearedTokens` subtraction is unchanged.
   **Correction (card `25f6a7dc`) — this was NOT "both existing callers."** At the time this fix landed,
   SIX call sites already routed through the shared reader and got this fix for free, since none
   re-derives the parse itself: `differentUnresolvableOccupantRepoPathAt` (~L712),
   `readFinalOnDiskSurvivingTokens` (~L825, itself called by `survivingTokenHolderRepoPaths`),
   `tombstoneIfNotSurviving` (~L847), `foldInOnDiskTokensIfMarked`/`reconcileMarkedBasenameBeforeWrite`
   (~L928), `protectOccupantContentBeforeDelete` (~L1658), and `resolveRaiseOverwrite`'s own
   "resolvable ⇒ safe" branch (~L1852). THREE further inline parsers — `unincorporatedOccupantRepoPathAt`
   (~L751), `markedFinalFullyCoveredByClear` (~L1318), and `resolveRaiseOverwrite`'s own "already
   incorporated" check (~L1856) — re-derived the SAME parse independently and so did NOT get this fix for
   free; they drifted from the shared reader's own `length > 0` fallback until card `25f6a7dc` routed all
   three through it too (see "Follow-up 25f6a7dc" below).
2. `merge-quarantine-raise-protect-failure.mjs`'s `7a7e041b-mixed` scenario gained a fresh-import reboot
   check — BEFORE either token is cleared — asserting keepTok is present (with `repoPath === d`) and
   deadTok is absent, closing the coverage gap in finding 2.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`7a7e041b-b2`** — the reviewer's own probe B2: `final` hand-written as `{tokens: [], token:
  "legacy-live-tok-..."}`(the legacy singular shape with an empty array, never the array form). Asserts
  the legacy token survives `protectOccupantContentBeforeDelete`'s own copy-aside (never replaced by a
  freshly-minted random token), survives a fresh-import reboot BEFORE any clear, and is still clearable BY
  TOKEN afterward — in-process and after a second reboot.
- **`7a7e041b-mixed`** — unchanged setup; added a fresh-import reboot check right after the raise (before
  either `clearMergeQuarantineByToken` call) asserting keepTok is present with `repoPath === d` and deadTok
  is absent, per finding 2 above.

Both of `7a7e041b-b2`'s own new assertions proven RED on `HEAD` (pre-fix) and GREEN after, via
`scripts/negative-control.mjs` — the RED phase fails exactly those two assertions with the build
succeeding on both sides, so the RED is behavioral, not a build failure. All 33 `merge-quarantine*.mjs`
files re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30). Line endings re-verified CR==LF via the `tr -dc` recipe.
