# abeac33a — `detectPastePlaceholderLengthLoss`'s `gen` discriminator: a naive check fires on a correct send

## Narrative

`detectPastePlaceholderLengthLoss` (card `b68d1f5b`'s DoD-1 — see
[[b68d1f5b-window-sizing-and-calibration]]) works from the RECORDED/delivered side alone: a
`[Pasted text #N +M lines]` token surviving into the transcript's recorded turn text always means those M
lines never reached the engine, regardless of who wrote the text.

⛔ HARD CONSTRAINT (card `abeac33a`, folded into `b68d1f5b` 2026-08-04): a naive version of this check —
"placeholder present ⇒ report a loss" — FIRES ON A CORRECT SEND. A stale placeholder TOKEN can be a
CLI-side rendering ghost: an EARLIER delivery's own placeholder (already fully delivered, at an OLDER
`gen`) re-rendering into a LATER, unrelated, correctly-delivered turn's recorded text. Nothing daemon-side
replayed it — the re-render is CLI-side — so by the time this check runs, the M lines it names were never
actually missing FROM THIS TURN; they were already accounted for, earlier.

✅ THE `gen` DISCRIMINATOR: `findExplainingWrittenGen` searches a bounded, `gen`-ordered history of Loom's
OWN writes (`Live.recentWrittenLineCounts`) for ANY entry — current gen or an older one — whose own line
count matches the placeholder's stated M. A match means this occurrence is EXPLAINED, one of two ways, and
either way this check must stay silent:

- Matches the CURRENT gen's own entry → this is a real, FRESH collapse of THIS turn's own submission — but
  `detectBarePastePlaceholderTripwire` (card `0f9268cc`/`2c58bdd3` — see
  [[0f9268cc-paste-tripwire-detection-then-recovery]]) already owns that case (full-text comparison,
  already gen-safe by construction, already wired to one-shot recovery). Flagging it again here would be a
  duplicate alarm, not a new finding.
- Matches an OLDER gen's entry → the stale-token ghost. That gen's content is already known-delivered
  (Loom wrote it and, if it had actually collapsed back then, the tripwire above would have already caught
  and recovered THAT turn) — this later re-appearance is a harmless CLI-side artifact, not a new loss.

Only a placeholder matching NO entry in the history is genuinely UNEXPLAINED. A raw `writeStdin` turn never
pushes into this history — only `submit()` does — so a raw-terminal placeholder never has an entry to
match against here, REGARDLESS of whether Loom actually captured its content elsewhere (see card `183de1a4`
— [[183de1a4-lastrawsubmit-retention-is-one-turn-only-never-persisted]] — it usually did, in
`Live.lastRawSubmit`, and `detectBarePastePlaceholderTripwire` already caught + recovered the CURRENT-gen
case using it). What genuinely has no explanation left ANYWHERE by the time it reaches here is a STALE
re-render of an OLDER raw turn, whose one-turn `lastRawSubmit` snapshot is long since overwritten — that's
the case this check exists to surface.

## Do not

- Do not treat "placeholder present" alone as sufficient evidence of a loss — a stale CLI-side re-render of
  an already-delivered, older generation's own placeholder will trip a naive check on a fully correct send.
- Do not flag a CURRENT-gen match here — `detectBarePastePlaceholderTripwire` already owns that case; a
  duplicate alarm is not a new finding.

## Source

Inline comment in `packages/daemon/src/orchestration/paste-tripwire.ts`
(`detectPastePlaceholderLengthLoss`'s function doc). Relocated by card 26afc9eb (tranche 1 on
`orchestration/paste-tripwire.ts`); no wording changed beyond compressing wrapped source lines into flowing
paragraphs and stripping `/** */`/`*` comment markers.
