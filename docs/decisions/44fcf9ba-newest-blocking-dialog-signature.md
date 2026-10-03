# 44fcf9ba — name the boot-dialog-stuck alarm's newest signature, not the priority-first match

## Background

`dialogStuckTimer`'s fire-time alarm (`pty/host.ts`) named the signature via
`detectBlockingDialogSignature(collapseBoot(l.dialogStuckScan))`, which checks the four known
blocking-dialog signatures in a FIXED priority order (external-imports, workspace-trust,
mcp-server-enable, enter-esc-footer) and returns the FIRST match. `dialogStuckScan` is a cumulative
rolling buffer (cleared only by a real `SessionStart`), so once dialog A has appeared its text stays in
the buffer even after dialog B replaces it on screen. If A sorts earlier in the priority list than B, the
alarm named A even though B is what was actually on screen when the alarm fired — reporting a stale
signature to whoever reads the event.

## The fix

`detectNewestBlockingDialogSignature` (`pty/host.ts`) ranks the three SPECIFIC signatures
(external-imports, workspace-trust, mcp-server-enable) by the LAST position each is provably present at
in the collapsed buffer, and returns whichever ranks latest — "most recently appeared" instead of
"highest priority". It is used ONLY at the alarm's fire-time log/event site; `detectBlockingDialogSignature`
itself is untouched and keeps being used everywhere else (notably `isBlockedOnUnresolvedBootDialog`, which
only needs "matched at all" — ranking never matters there).

No new state was added. The function is pure, computed from the EXISTING `dialogStuckScan` buffer, which
is already correctly scoped (reset to `""` on every fresh spawn/resume/fork/recycle, per the `Live` object
literal) — so there is no new per-`Live` field to leak a stale signature across a respawn.

mcp-server-enable (`isMcpServerEnableSignature`) is COMPOUND — two independent sub-patterns
(`/mcpserver/i`, `/rejectall/i`) that can land at different buffer positions, so it has no single match to
rank by. Its position is the LATER of its two sub-patterns' own last positions: both sub-patterns must be
present for the signature to hold at all, so the later of the two is the earliest point by which it's
actually, fully satisfied — i.e. its own most-recent "became true" point.

## Why `enter-esc-footer` is excluded from the ranking pool

The generic `enter-esc-footer` catch-all (`/entertoconfirm/i` AND `/esctocancel/i`) is checked only as a
FALLBACK, after the three specific signatures find no match — never ranked as a peer candidate.

At least two of the three specific dialogs render that SAME generic "Enter to confirm · Esc to cancel"
footer as part of their own screen, trailing their own distinguishing text (confirmed against this
project's own existing fixtures — `claude-boot-dialog-stuck.mjs`'s external-imports and workspace-trust
unit-test text both end in that exact footer; its mcp-server-enable fixture, and every other
mcp-server-enable fixture in this repo — `kickoff-readiness-fallback.mjs`, `pty-boot-timer-kill-race.mjs`
— deliberately omit it, consistent with the dismiss log line `"Esc = reject all"`: Esc performs the
"Reject all" menu action directly for that dialog, it isn't a generic confirm/cancel footer).

If the catch-all were ranked as a peer candidate, its own last-match position would almost always sit at
or after whichever specific footer-bearing dialog's text appears last in the buffer (the footer trails the
identifying content within each dialog's own render). So it would spuriously "win" the most-recent ranking
under its own generic name every time two or more footer-bearing dialogs ever appeared — discarding the
specific name the alarm exists to report, and even misnaming a SINGLE still-pending specific dialog (its
own trailing footer would otherwise outrank its own identifying text against itself).

## Do not

- Do not rank `enter-esc-footer` as a peer candidate in `detectNewestBlockingDialogSignature` — it must
  stay a fallback checked only once none of the three specific signatures match at all. Two of the three
  specific dialogs share that exact generic footer text, so ranking it as a peer regresses the fix this
  card exists to ship (see "Why `enter-esc-footer` is excluded" above).
- Do not use `detectNewestBlockingDialogSignature` for `isBlockedOnUnresolvedBootDialog` or any other
  boolean "is something blocking" check — it exists only to NAME the alarm's signature; the boolean gate
  only needs "matched at all" and stays on `detectBlockingDialogSignature`.
- Do not assume the mcp-server-enable dialog renders the generic "Enter to confirm · Esc to cancel" footer
  without first re-checking against a real captured screen — every fixture in this repo (and the "Esc =
  reject all" dismiss-log wording) is consistent with it NOT doing so, but that has never been confirmed
  against a real `claude` CLI screen capture, only against hand-written test fixtures.
