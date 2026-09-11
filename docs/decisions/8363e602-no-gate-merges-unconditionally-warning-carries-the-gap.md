# 8363e602 — a merge with no `gateCommand` configured still lands unconditionally; `warning` now says so

## Narrative

Before this finding, a successful merge into a repo with no `gateCommand` configured silently rubber-stamped — the manager had no way to tell "verified, gate passed" apart from "never checked at all". The fix: `confirmWorkerMergeTracked`'s plain-GREEN return now sets `gateWarning` naming the gap explicitly ("unverified: no gateCommand is configured for … — the merge was NOT checked by any build/DoD gate") whenever no gate ran for the target repo, instead of returning cleanly with no signal either way.

Made repo-aware by multi-repo epic `49136451` phase 2 (see `docs/decisions/49136451-repokey-axis-disambiguates-worktree-dirs-across-repos.md`): `gate` is `targetRepo.gateCommand`, resolved per-repo — a gateless REGISTRY repo now warns exactly like a gateless PROJECT already did before this phase, through the SAME variable/warning path, and the message names which repo when it isn't the primary, so the warning stays honest instead of blaming "this project" for a gap specific to one registry entry.

`notified` is left `undefined` on this branch (unlike every other confirm-outcome branch): the GREEN path sends no direct push of its own for this warning, so `confirmWorkerMergeTracked`'s generic `[loom:merge-done]` echo is the sole terminal signal a manager gets — no dedicated nudge mechanism was built for this specific warning.

## Do not

- Do not read a clean (no-`warning`) GREEN return as proof a gate ran and passed — a gateless repo/project returns cleanly-shaped success too, just carrying this warning instead; check `gateRan` or the presence of `gateWarning`.
- Do not assume this warning pushes its own nudge — it rides the existing `[loom:merge-done]` echo; no dedicated push exists for it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`confirmWorkerMergeTracked`'s plain-GREEN return, the `gateWarning` derivation), as of this tranche's HEAD. Framing corroborated by `packages/daemon/test/merge-confirm-stale-retry-idempotent.mjs`'s own header comment ("THE OTHER BUG (8363e602)").
