# e29923e3 — the MCP-enable-prompt Esc dismiss is a single write; never infer dismissal from screen output

## Background

The old single-shot dismiss (card 850eb55c) detected the "N new MCP servers found" dialog and cleared
`Live.dialogStuckScan` TWICE on the optimistic assumption that the Esc write would land: once immediately
at detection, before any Esc had been written at all, and again inside the 300ms-deferred write's own
callback, to wipe out any repaint residue the dialog emitted while waiting. A single fire-and-forget Esc
can silently drop on Windows ConPTY (card dacb8571). If it dropped and the dialog stayed genuinely static
(no repaint, no further pty output at all), nothing ever re-populated either cleared buffer, so
`isBlockedOnUnresolvedBootDialog` read `false` while the dialog was still on screen — the kickoff and its
terminating Enter could then be typed into a dialog nobody reviewed.

## Round 1 and round 2 (superseded by round 3 below — kept here as the "do not re-try this" history)

Round 1 replaced the optimistic clear with a bounded, spaced retry loop keyed on "dismissal evidence":
each attempt wrote Esc, then checked pty output received strictly after that write for the ABSENCE of the
recognized signature, retrying (up to a cap) on no evidence and releasing the hold once evidence of a
clean repaint arrived.

Round 2 (Code Review 1571046e) found two Majors in that evidence check itself: contentless output
(sync-frame markers, zero `collapseBoot`'d chars) was counted as evidence on its RAW length; and a
DIFFERENT recognized dialog appearing after the MCP prompt was matched by the generic
`detectBlockingDialogSignature` and misread as "still the MCP prompt," keeping the retry going. Round 2's
fix (`classifyMcpDismissEvidence`, a four-way classification with a 96-char "substantial content"
threshold) closed both.

Round 3 (Code Review 7d53af22) found the SAME failure one level up: a 96-char threshold is itself
crossed by non-dismissal content — summed status/clock ticks accumulating across several short chunks,
OSC hyperlink/title frames, or a partial row repaint of the STILL-OPEN dialog (the recognized signature
needs "reject all," which renders only on the footer row — a repaint that hasn't reached that row yet is
real screen content that still isn't evidence of anything). Two rounds of refining "how much/what kind of
output counts as evidence" each independently reproduced the same class of bug.

## Do not infer dismissal from screen output

Screen output cannot reliably prove the dialog left — raising or re-deriving the "substantial content"
threshold again just reproduces this bug a third time with a different counterexample. The round 3 fix
removes the entire evidence-inference mechanism:

- `PtyHost.dismissMcpPrompt` (`pty/host.ts`) writes exactly ONE Esc, after `MCP_DISMISS_INITIAL_DELAY_MS`,
  and does nothing further — no retry, no verify step, no classification of what arrives afterward.
- `dialogStuckScan` is cleared ONLY by the `SessionStart` hook case (`isPastBoot`) — never by
  `dismissMcpPrompt`, for any reason.
- `classifyMcpDismissEvidence`/`McpDismissEvidence`, `MCP_DISMISS_SUBSTANTIAL_CHARS`,
  `MCP_DISMISS_MAX_ATTEMPTS`, and `MCP_DISMISS_RETRY_SPACING_MS` are deleted — there is nothing left that
  reads them. `Live.dialogStuckScanTotalBytesFed` is deleted too (it existed only to diff bytes across
  retry attempts).
- This also fixes a Minor the same review found: the old retry loop was NOT role-gated (only
  `dialogStuckTimer`/the hold are, via `LOOM_DRIVEN_ROLES`), so a manager/plain session showing the MCP
  dialog could get up to 3 Esc writes. A single write is now the same for every role.

## Accepted residual (documented, not coded)

If the single Esc drops (card dacb8571), or the dialog genuinely dismisses but the session's own
`SessionStart` hook is itself missed, the kickoff hold stays engaged — nothing re-populates or re-checks
`dialogStuckScan` after the one write. The existing one-shot `dialogStuckTimer` backstop still fires at
`CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS` (150s default) and notifies for manager intervention — detect +
notify only, never auto-answered, per card 01160ae3. This is a deliberate fail-safe: never type a kickoff
into a dialog nobody reviewed, even at the cost of sometimes waiting out the full alarm window for a
genuinely rare (dropped Esc) case. Measured rarity (850eb55c investigation, reconfirmed for round 3): 0
MCP-prompt readiness-fallback firings in the observed log window.

Round 3 also considered, and explicitly declined for this card, making `dialogStuckTimer`'s own alarm
name the NEWEST (most-recently-appeared) blocking-dialog signature rather than whichever
`detectBlockingDialogSignature` matches first in its fixed priority order. Judged not cheap:
`mcp-server-enable` is a compound match (`/mcpserver/i` AND `/rejectall/i`, independently), unlike the
other three signatures' single-pattern tests, so there is no single "last match position" to rank a
compound signature against a simple one. Carded separately (card `44fcf9ba`, discoveredFrom this card)
rather than folded into this scope-cut.

## Round 4 (delta Code Review `07a334ed`, Minor 1)

Round 3 (above) kept a `this.isPastBoot(boundLive)` bail at the top of `dismissMcpPrompt`, on the
reasoning that a session already past boot has moved on and an Esc landing there could cancel something
unrelated. That bail itself rests on an unverified ordering assumption — that the CLI never fires
`SessionStart`/any hook while the MCP-enable dialog is still genuinely open — and the hold's own release
path (`isBlockedOnUnresolvedBootDialog`) already depends on that exact same assumption. Round 4 removes
the bail: a single Esc landing harmlessly at the main prompt is an acceptable cost against a skipped Esc
on a dialog that's genuinely still open, which is not. `dismissMcpPrompt` now writes unconditionally once
its identity (`boundLive`) and liveness (`alive`/`killed`) checks pass.

## Do not

- Do not reintroduce ANY form of "is this output substantial/clean/signature-free enough" check to decide
  whether the MCP dialog dismissed — that is the exact shape that failed twice (round 1's raw-length
  check, round 2's 96-char collapsed-length threshold). The only thing that ever clears `dialogStuckScan`
  is `isPastBoot` via the `SessionStart` hook case.
- Do not add a retry loop back to `dismissMcpPrompt` — one Esc, then nothing. If a dropped Esc turns out
  to matter in practice, the fix is PREVENTING the drop (or a differently-shaped proof the dialog is
  gone), not re-trying blind.
- Do not let `dismissMcpPrompt` act (write Esc) without first checking `this.live.get(sessionId) ===
  boundLive` by identity — a same-id respawn during the `MCP_DISMISS_INITIAL_DELAY_MS` wait must never let
  a stale generation's deferred write land on, or be attributed to, the new generation's Live (same
  discipline as `scheduleKickoffGuarantee`/`logLandedMode`, card 096231e8).
- Do not reintroduce an `isPastBoot(boundLive)` bail into `dismissMcpPrompt` (round 4 ruling, delta Code
  Review `07a334ed`, Minor 1). Round 3 shipped exactly that bail, reasoning a session already past boot
  has moved on and an Esc there could cancel something unrelated — but that rests on an UNVERIFIED
  ordering assumption: that the CLI never fires `SessionStart`/any hook while the MCP-enable dialog is
  still genuinely on screen. The hold itself (`isBlockedOnUnresolvedBootDialog`) still relies on that same
  assumption to release — it is a known, pre-existing premise this card does not verify, not a new one. A
  single Esc landing at the main prompt is harmless; a skipped Esc on a dialog that's genuinely still open
  is not, so the write now goes out unconditionally once the identity/liveness checks pass.
- Do not gate the single Esc write's role — it intentionally fires for EVERY claude session kind (not just
  `LOOM_DRIVEN_ROLES`), matching the pre-850eb55c single-shot behavior; only the alarm/hold
  (`dialogStuckTimer`/`isBlockedOnUnresolvedBootDialog`) are role-gated.
