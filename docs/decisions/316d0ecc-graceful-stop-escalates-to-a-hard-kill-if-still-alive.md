# 316d0ecc — a graceful stop that fails to exit escalates to a hard kill

## Narrative

Card `316d0ecc` (board bug): a double Ctrl-C EXITS an IDLE `claude` (the second press exits from an empty prompt), but on a session that's mid-turn the two Ctrl-Cs only INTERRUPT the running turn — the pty stays alive at a (now) idle prompt and, because no Stop hook fires after the interrupt, the busy flag stays stale. So the operator saw a "stopped" session that was actually still live+busy until a follow-up hard stop killed it.

Fix (`pty/host.ts`'s `escalateGracefulStop`): after the initial interrupt sequence, if the pty is STILL alive, RE-SEND the exit sequence (the turn has since unwound to an idle prompt, where the double Ctrl-C exits); and if it STILL refuses to exit within a hard bound (a wedged TUI / a tool call that swallows Ctrl-C), ESCALATE to a hard `pty.kill()` (node-pty Job Object — orphan-free, kills the tree). An IDLE session exits on the very FIRST sequence, so the escalation timers always find `!alive` and are pure no-ops — its graceful stop is byte-for-byte unchanged. Hard stop is untouched.

All three timings are env-overridable so a hermetic test drives the whole escalation in milliseconds (default unset = production behaviour: the first two Ctrl-Cs keep their original 600ms gap):
- `GAP` — gap between the two Ctrl-Cs of one exit sequence (was the inline 600ms literal)
- `RETRY` — re-send the exit sequence at this point if the session is still live after the interrupt
- `KILL` — hard bound after which an un-exited pty is killed (`RETRY+GAP < KILL`, so the re-send gets a full window to land before the kill)

Exit clears busy + sets `processState=exited` (`index.ts`'s `onExit`), so the fix resolves both the stuck live state and the stale busy flag.

Verified by a hermetic test (`test/graceful-stop.mjs`, fake-pty seam): a busy session that swallows Ctrl-C reaches exited via the hard-kill backstop; an idle session exits on the first double Ctrl-C with no hard kill (exactly two Ctrl-Cs written); a busy session exits on the re-sent sequence without needing the backstop.

## Do not

- Do not remove the re-send/escalation timers on the theory that "a double Ctrl-C always exits" — it only exits an IDLE session; a mid-turn session needs the re-send once it unwinds, and the hard kill as a backstop if it never does.
- Do not shrink `RETRY+GAP` below `KILL` — the re-send needs a full window to land before the hard kill fires.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the graceful-stop escalation top-of-block doc), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); the card id was recovered from the introducing commit's own body (`ed8c45e9ef3e10b9f2470f9f476ed6b05335be36`, "board 316d0ecc") — the block itself and the rest of the file cite no id. No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
