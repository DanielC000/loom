# f2bb9dbe — SETTINGS_DIR_READ_DENY_RULE resolves the real path, closing the configured-LOOM_HOME-is-an-alias case

## Background

Discovered during `30039c88`'s investigation (worker `5ce9fa20`) and left acknowledged only in a source
comment, untracked by any card or decision record: `SETTINGS_DIR_READ_DENY_RULE`
(`pty/claude-settings.ts`) was built from the RAW, unresolved `SETTINGS_DIR` string. `LOOM_HOME`'s own
broader write deny (`pty/loom-home-deny.ts`) already resolved through `canonicalizeExistingPath` for
exactly this reason; its own doc comment said so explicitly and named the SETTINGS_DIR read deny as the
one place that gap was never repaired.

The exposure this card actually closes: when the CONFIGURED `LOOM_HOME` (or `tmp/settings` itself) is
behind a junction (Windows) or symlink (POSIX), the pre-fix raw-string-only glob names only the configured
(alias) path — a read of `<sid>.mcp-config.json` (which can hold a decrypted capability secret, and the
per-session MCP token, for up to ~45s pre-`markReady` — see `ed0757d6`) issued via the REAL, unaliased
path went unmatched. See "What stays open" below for a distinct, NOT-closed shape this is easy to
conflate it with.

## Is closing the tool-level path worth it, given arbitrary Bash already bypasses this deny?

Yes. `SETTINGS_DIR_READ_DENY_RULE` is `permission.deny`-based — a tool-DISPATCH pattern match, not a
filesystem boundary — so arbitrary `Bash` CODE (`node -e "fs.readFileSync(...)"`) already bypasses it
regardless of this fix; that residual is accepted and unchanged (per `ed0757d6`/`2be634f2`).

But `restrictedTools` (the Companion blast-radius control, `pty/host.ts`'s `RESTRICTED_NATIVE_TOOLS`)
removes `Bash` from the model's tool list ENTIRELY via `--disallowedTools` — not merely a permission
denial, the tool is absent. For a `restrictedTools` session, the Bash-code bypass is not merely harder,
it is structurally unavailable: `Read`/`Glob` (left unrestricted — "a companion needs context", per
`RESTRICTED_NATIVE_TOOLS`'s own doc) is the ONLY surviving native-tool surface that could ever reach
another session's settings-dir secret file. For that role, the junction/symlink-alias gap in the raw-
string-only rule was NOT a redundant backup to an already-open Bash bypass — it was the single remaining
path. That alone makes the fix worth building, independent of any other role's posture.

## Fix

`pty/claude-settings.ts` now exports `SETTINGS_DIR_REAL` (SETTINGS_DIR resolved via the SAME
`canonicalizeExistingPath` helper `pty/loom-home-deny.ts`'s `LOOM_HOME_REAL` uses — the one shared
resolver, not forked) and `SETTINGS_DIR_READ_DENY_RULES` (the raw rule plus a second rule rooted at the
resolved real path, emitted only when the two differ under `comparisonKey`, case-folded on win32).
`SETTINGS_DIR_READ_DENY_RULE` (singular, raw-only) is kept exported, unchanged, for the existing callers/
tests that reference that exact string; `withSettingsDirDenyForSpawn` now unions in whichever of
`SETTINGS_DIR_READ_DENY_RULES` is still missing from `.deny`, so an un-aliased `LOOM_HOME` (the common
case — real path equals raw path) still emits exactly the one rule, byte-identical to before this card.

Resolving the whole `SETTINGS_DIR` path (rather than joining a candidate onto `LOOM_HOME_REAL`) catches a
junction/symlink planted at either the `LOOM_HOME` level or the `tmp/settings` level itself, since
`fs.realpathSync.native` resolves every segment of the path chain.

Safe when `LOOM_HOME`/`tmp/settings` doesn't exist yet at spawn (a fresh install, before the first
`ensureDirs()` call has run): `canonicalizeExistingPath` catches a realpath failure and falls back to
`path.resolve`, so `SETTINGS_DIR_REAL` degrades to the raw path rather than throwing — identical posture
to `LOOM_HOME_REAL`'s own existing fallback. Because both `SETTINGS_DIR_REAL` and `SETTINGS_DIR_READ_DENY_RULES`
are computed ONCE at module load, a daemon boot this early degrades to the pre-fix raw-only rule for its
whole process lifetime — not re-resolved later in that same run once `ensureDirs()` creates the directory —
and only picks up the real-path rule on the NEXT restart, after the directory already exists. Same
first-boot residual `LOOM_HOME_REAL` already carries; not new to this card.

## What stays open

This fix resolves the CONFIGURED `SETTINGS_DIR` to its own real target — nothing more. It does NOT cover
a read issued through some OTHER, third alias path that also happens to resolve to the same real
directory (one that already exists elsewhere on the host — e.g. a profile-redirection junction, a
subst'd drive, a Dev Drive mount — or one an attacker plants). Such a read is matched by NEITHER the raw
rule (named for the configured path) NOR the new real-path rule (named for `SETTINGS_DIR`'s own resolved
target), UNLESS the CLI itself canonicalises a requested path before matching it against `permission.deny`
globs — which this card has NOT verified either way. Treat that as unverified, not as "the CLI doesn't do
this" or "the CLI does do this."

For a `restrictedTools` role specifically (see "Is closing the tool-level path worth it" above), this
residual narrows further: creating a NEW junction/symlink needs a native filesystem-write primitive
(`Bash`, or an equivalent shell/file-write tool), and that role has none — `Bash`/`Edit`/`Write` are all
disallowed. So that role cannot PLANT a third alias itself; only an ALREADY-EXISTING one (not of its own
making) could still matter for it. A role that keeps `Bash` (most roles, when `restrictedTools` is off)
remains able to plant one, but for that population the already-accepted Bash-code-bypass residual
(`ed0757d6`/`2be634f2`) already dominates — reading the real file directly via `node -e` needs no alias
at all.

## Do not

- Do not read this as closing the Bash-code bypass — it is a different, already-accepted residual
  (`ed0757d6`/`2be634f2`), unchanged by this card. This closes only the tool-dispatch (`Read`/`Glob`)
  path.
- Do not remove `SETTINGS_DIR_READ_DENY_RULE` (the raw-only singular export) — existing callers/tests
  reference that exact string; `SETTINGS_DIR_READ_DENY_RULES` (plural) is additive, not a replacement.
- Do not join a candidate onto `LOOM_HOME_REAL` instead of resolving `SETTINGS_DIR` directly — a junction
  could be planted at the `tmp/settings` level itself, not only at `LOOM_HOME`'s own root; resolving the
  full path catches both.
- Do not change `SETTINGS_DIR_READ_DENY_RULE`'s glob prefix form (single leading slash, no `//` prefix)
  as part of this fix — that is a deliberately separate, not-yet-built card (`8d0ba38b`, per
  `37310431`'s own "Ruling A"); conflating the two changes would make either one harder to review or
  revert independently.
- Do not claim this closes the general "any alias that reaches the real directory" case — it closes only
  the CONFIGURED-path-is-an-alias case. A third, unrelated alias pointing at the same real directory is
  covered only if the CLI canonicalises the requested path before matching `permission.deny`, which is
  UNVERIFIED — do not assert either way without first measuring it against a real spawn.
