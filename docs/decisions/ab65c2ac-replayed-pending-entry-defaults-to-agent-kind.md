# sha:ab65c2ac — a replayed pending snapshot carries no per-entry kind; ambiguous replay defaults to "agent"

## Narrative

The pre-restart pending-inbound snapshot (`getPersistablePendingSnapshot`) carries only each entry's
TEXT, not its original warning/agent classification — the snapshot format predates that discriminator.
The set `resumeFleetOnBoot` replays on resume can therefore be a mix of worker reports / manager
direction (which should classify as `"agent"`) and idle/resume nudges (which should classify as
`"warning"`) that happened to be pending at restart time, with no way to recover which was which from the
snapshot alone.

Commit `ab65c2ac` (`fix(pty): deliver agent messages one-per-turn; coalesce only Loom system/warning
injections`) resolved the ambiguity by biasing every replayed entry to `"agent"`, per the classification's
own default rule — because a warning wrongly replayed one-per-turn only costs a few extra benign turns,
while an agent message wrongly coalesced away is a real loss.

## Do not

- Do not bias an ambiguous replayed pending entry to `"warning"` — bias to `"agent"`; the cost of
  guessing wrong is asymmetric (a few extra benign turns vs. a coalesced-away agent message).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s
`replayPending`: lines 4420, 4422-4425 (line 4421 later touched by commit `c32c232ccd`, a wording edit
only — not a second decision), introduced by commit `ab65c2ac`; verified via
`git cat-file -t ab65c2ac` ⇒ `commit`. No board card exists for this decision — sourced from `git blame`
at extraction time (tranche 12).
