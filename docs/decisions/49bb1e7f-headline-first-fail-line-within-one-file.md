# 49bb1e7f — `computeFailureTail` headlines the FIRST FAIL line within one file, not the last

## Narrative

`computeFailureTail` (`packages/daemon/scripts/test-daemon.mjs`) picks the one line of a failing test
file's own stdout/stderr worth surfacing inline on its `FAILURES:` bullet line — the full stdout still
prints below it, unabridged. Card `3a9e5a18` chose to prefer a `FAIL  <label>` line over a blind last
line of stdout (this project's `check(label, cond)` helper doesn't throw on a failed assertion, so a run
failing an early check can still print later PASSING ones) — but among multiple FAIL lines, it picked the
LAST one.

The Platform Auditor (finding `4be406ac`, item B) observed that choice sending three manager generations
down the wrong mechanism: within one file's own sequential stream, the FIRST FAIL line is usually the
actual root cause, and any FAIL lines after it are usually that cause's own downstream consequences
(a later assertion dereferencing state the first one already proved broken). Headlining the last one
surfaces the cascade's symptom, not its cause.

This is deliberately **not** a re-litigation of done card `52bc5d52`, which rejected "first" for a
different, CROSS-FILE case: when multiple test files run concurrently on separate lanes, there is no
meaningful ordering between their failures at all (the lanes race), so "first" there would be exactly as
arbitrary as "last". This card's case is different in kind — one file's own stdout, produced by one
sequential process, where "first" and "after" are real, meaningful positions.

When more than one FAIL line exists, the headline appends a `(+N more)` count (N = total FAIL lines minus
the one shown), so a reader knows the shown line isn't the whole story before they scroll to the full
output below it.

## Do not

- Do not revert to headlining the LAST FAIL line within one file's stream — that resurfaces the
  cascade-symptom-not-cause defect this card fixed.
- Do not read this as overturning `52bc5d52`'s cross-file "first is equally arbitrary" finding — that
  finding is about concurrent, unordered lanes and is untouched; this fix applies only within one file's
  own sequential output.

## Source

Card `49bb1e7f`, filed by the Platform Lead from Platform Auditor finding `4be406ac` (item B), against
main `fa18032d`. Parent decisions: card `3a9e5a18` (chose "prefer a FAIL line over blind-last-line", this
card only reverses its first-vs-last tiebreak within one file); done card `52bc5d52` (the cross-file case
this card explicitly does not revisit).
