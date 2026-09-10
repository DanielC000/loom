# 319ae2cc — vault-read opt-out marker + BOM-strip placement

## Narrative

`hasCompanionReadOptOut` (`packages/daemon/src/companion/capabilities.ts`) implements a per-note opt-out
for the `vault-read` companion lever: a leading `---\n…\n---` frontmatter block setting
`companion-read: false` (or `no`/`off`, quoted or bare, case-insensitive) excludes that note from
`vault_lookup` even though it isn't otherwise secret-shaped.

`companion-read: false` is a convention this lever introduces — no existing vault sensitivity/exclusion
marker was found in `vault-lint.mjs` or `vault/browser.ts` (checked before building this). A future vault
sensitivity feature should adopt/rename this marker rather than add a second, competing one.

The match is deliberately narrow (a falsy-literal match, not a full YAML parse) — this tool has no other
use for frontmatter.

## CR fix: BOM stripped here, not in the shared reader

`readVaultFile` reads utf8 without stripping a leading BOM (`﻿`), which is realistic on this
Windows-primary host (VSCode/PowerShell commonly write one). An un-stripped BOM sits before the `---` and
silently defeats the `^---` anchor, so a BOM-prefixed opt-out note would get searched anyway. The fix
strips a single leading BOM before matching, here — the only place this content is inspected for
frontmatter — rather than at the shared `readVaultFile` reader, which has other callers that should not
have their content silently mutated on this file's account.

## Source

Introduced by commit `319ae2cc` ("feat(companion): vault-read lever (vault_lookup, secret-excluded,
scoped)", 2026-07-09). No board card in the commit message; this is why the anchor is keyed on the commit
sha rather than a card id (see CLAUDE.md's `sha:` decision-anchor sigil).
