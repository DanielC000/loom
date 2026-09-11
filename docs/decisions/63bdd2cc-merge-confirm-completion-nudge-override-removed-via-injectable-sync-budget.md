# 63bdd2cc — `merge-confirm-completion-nudge.mjs` no longer needs a timeout override

## Narrative

`merge-confirm-completion-nudge.mjs` used to carry a `TEST_TIMEOUT_OVERRIDES` entry too (measured
83-84s standalone, dominated by 6 deliberately real, un-injectable ~13s gate waits).

Card `63bdd2cc` made `SessionService`'s sync-wait budget injectable — the `syncAttachBudgetMs`
constructor option, built as card `0faaaa55`'s DI seam (see that card's own investigation,
`docs/investigations/0faaaa55-daemon-suite-real-fix/findings.md`, for the seam's own mechanics and
an earlier, reverted attempt at this exact file) — so each real gate wait in this test only needs
to outlive a shrunk budget instead of the full 12s production one.

Measured 3/3 standalone runs (single lane, post-`e082bf4d`-rebase build, commit `88915101`):
33.5-33.8s — no measurable cost at the resolution that matters, ~3.5x under the 120s blanket
`TEST_TIMEOUT_MS`. The override entry for this file was removed entirely, not merely lowered.

## Do not

- Do not re-add a `TEST_TIMEOUT_OVERRIDES` entry for this test without first checking whether
  `syncAttachBudgetMs` is still being passed a shrunk value in the test's own setup — the fix that
  made the override unnecessary lives there, not in this file.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `TEST_TIMEOUT_OVERRIDES`
definition (originally ~lines 850-855, within the block ~830-849). Card `63bdd2cc`. Related:
`0faaaa55` (built the DI seam this card uses; see its own investigation for the earlier revert),
`cc595ca7` (the umbrella per-test-override design this test used to participate in).
