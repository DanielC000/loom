# d0c1e76d — a `default` permission-mode climb is confirmed from the post-press window, failing toward `unknown`

`default` has no footer label. `detectPermissionMode` takes the last labeled token in the 8KB ring, so after the third press (auto → default) the older `auto` label still wins: a DROPPED final press and a successful one both read `auto`, the cycle ended `footer-unchanged`, and a session left in `auto` (more permissive than `default`) was indistinguishable from success.

## The rule

`runCycleToMode` records a monotonic output counter (`Live.ring.total`, bumped by `appendRing`, never shrinks on ring rotation) at the instant it writes each Shift+Tab, and `awaitChange` classifies ONLY the bytes written after that mark with `detectPermissionModeSince`:

- Collapse the window (ANSI stripped, whitespace removed, lowercased). The LAST of {a mode label token, a COMPLETE unlabeled default footer} wins.
- A complete default footer is exactly `(shift+tabtocycle)` immediately followed by `·←foragents`, AND positive absence of a label before it: some preceding text must exist in the window (a hint+tail alone is a partial repaint), and the ~24 collapsed chars before the hint must hold NO label residue (a ⏵/⏸ glyph, "mode", "edits", "permission", or ending in "on", which also rejects corrupted forms like `automde on`). A labeled footer carries the same tail, so "not directly preceded by one of four exact tokens" was NOT enough (it failed open on corrupted/glyph-only residue; code-review finding).
- **The default-footer shape is SYNTHETIC.** It is built from the string `test/resume-mode-detect.mjs` records, not from a raw-bytes capture of the real `default` footer.
- Everything else is `unknown`: a hint fragment from a partial repaint, the wrap-dropped `tabocycle` variant, a hint cut off before its tail, a spinner, unrelated output, an empty window.

`unknown` never counts as success. A cycle whose target is `default` and which ends anywhere but a positive `default` (`footer-unchanged`, `press-cap`, `footer-unreadable`, `modal-blocked`) files the durable mismatch through the existing `reportModeMismatch` (`claude_boot_dialog_stuck`, `detail.modeMismatch {target, landed}`, once per Live); no new channel. On `footer-unchanged` with an empty/unreadable window `landed` is the last positively-read mode (`prev`, e.g. `auto`), never a guess. The cycle's outcome is kept on `Live.lastModeCycle`, and `logLandedMode` prefers it over its whole-ring read for a `default` target (the ring cannot confirm `default`); a non-healable role then gets the `[loom:mode-unconfirmed]` notice even for a more-permissive (`auto`) or `unknown` landing.

For a NON-default target the cycle only advances on a LABELED post-press reading; a `default` or `unknown` reading keeps polling and ends `footer-unchanged` at `prev` (a misread `default` would otherwise overshoot). The one exception: `default` may advance when `prev` is `auto`, since auto → default is a legitimate intermediate step of a `worker_set_mode` to `plan`/`acceptEdits` (`pty-mode-race.mjs` walks it). `logLandedMode` uses the cycle outcome only when it is definite (`matched=-`), else the ring read restricted to a labeled result; a healable role (no `ExitPlanMode`) that landed `auto` with a `default` target is healed through `cycleToMode`; `unknown` never heals.

`modeUnconfirmedNotice(landed, target)` is direction-aware: a landing more permissive than the target says "MORE permissive … fewer approval prompts than configured"; otherwise the "blocked from writes" advice stays.

## Known residual

- The `· ← for agents` tail and the preceding-context rule are heuristics on a synthetic shape. If the real default footer omits the tail, or is repainted as hint+tail alone, a genuine default climb ends `unknown` and files a mismatch (visible, never silent). Verify against a real captured default footer when one exists (follow-up card).
- A mismatch event filed by a failed climb has no `_resolved` pair if a LATER heal succeeds (code-review finding #5); nothing closes it.

## Do not

- Do not read `default` from "no label seen" or from a bare hint fragment; a partial `auto` repaint carries the same fragment.
- Do not classify a press's outcome from the whole ring or from a wider window than the bytes after the press; the ring still holds the older label.
- Do not treat `unknown` as success for a `default` target.
- Do not add a new notification channel for this; reuse `reportModeMismatch`.
- Do not let `detectPermissionMode` (whole-ring, labeled-or-default) replace the post-press read inside the cycle. It remains right for an unlabeled boot read.
