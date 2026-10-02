# 17237fba — `isTrusted`'s fast path was dead: drop `hasCompletedProjectOnboarding`

## Background

`ensureTrusted` (`pty/claude-config.ts`) was designed (commit `f0541107`, May 2026) to be a no-op "at
most once per project dir" — once a project entry carried `{hasTrustDialogAccepted: true,
hasCompletedProjectOnboarding: true}`, `isTrusted`/`isFullyDecided` would skip the locked
read-modify-write of `~/.claude.json` entirely. At the time, this was exactly what clicking "Yes, I
trust this folder" persisted.

## What changed, and how it was found

A Code Review of card `e789ef3b` (2026-10-02) did a static decompilation of the installed `claude-cli`
2.1.287 bundle and a read-only census of the real `~/.claude.json`. Two things fell out:

1. The CLI's own config-save normalizer (minified `La(e)` in the bundle) unconditionally strips
   `history`, `projectOnboardingSeenCount`, `hasCompletedProjectOnboarding`, and `devIntentsDetected`
   from **every** project entry on **every** save it performs — not just the entry currently being
   touched.
2. The real census confirmed the practical effect: **0 of 8858** project entries in the live file
   carried `hasCompletedProjectOnboarding`, including entries Loom itself had written it into moments
   earlier. The field never survives the next save by *any* `claude` process, on *any* project.

So `isTrusted`'s `hasCompletedProjectOnboarding === true` half could structurally never be observed
true once any `claude` process had saved the file afterward — the fast path was dead, and every single
Loom spawn was paying the locked read-modify-write of an ~8.8k-project file.

Separately confirmed by the same decompilation: the CLI's own trust gate (`m0()`/`us()` in the bundle)
never reads `hasCompletedProjectOnboarding` at all — only `hasTrustDialogAccepted`. The field was never
load-bearing for the CLI's actual trust decision; it was only ever load-bearing for Loom's own (now
stale) assumption about what persists.

## The fix

`isTrusted` now checks `hasTrustDialogAccepted === true` only. `hasTrustDialogAccepted` is **not** in
the CLI's strip list and is durable (measured: 8775/8858 total entries, 4633/4633 `.loom-worktrees`
entries carry it as `true`).

This does not skip anything load-bearing: `isFullyDecided` independently re-checks the external-import
decision (`isExternalImportDecided`, keyed at the canonical root) and MCP-disable coverage
(`disabledMcpjsonServers` containing every discovered server) before treating an entry as fully decided
— each has its own presence check, not merely "trust implies everything." An entry that is
trusted-but-otherwise-undecided (the realistic steady-state shape now that this fast path actually
fires) still reaches the lock and gets whatever it's still missing. See the "upgrade path" tests in
`test/claude-config.mjs`, including the one proving a `hasTrustDialogAccepted`-only entry (no onboarding
flag at all — the real CLI-stripped shape) with no import decision still gets the decline written.

## Do not

- Do not reintroduce a check against `hasCompletedProjectOnboarding`, `history`,
  `projectOnboardingSeenCount`, or `devIntentsDetected` as a trust/decided signal anywhere in this file
  — the CLI strips all four from every project entry on every save; none of them can be relied on to
  persist.
- Do not assume `isTrusted` alone gates the whole fast path — `isFullyDecided` composes it with the
  import-decision and MCP-disable checks; a future addition to what `ensureTrusted` writes needs its own
  presence check threaded into `isFullyDecided`, not folded into `isTrusted`.
- Do not assume this generalizes past the measured CLI version (2.1.287) — `La()`'s strip list was found
  by decompiling an unmangled bundle, not a published API; re-verify after any `claude` CLI upgrade.
