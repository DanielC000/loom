# b8ae239e — a collidingRecords exemption is per-instance verified citation, never store-shape alone

## Narrative

`comment-anchor-lint.mjs`'s `collidingRecords` check (card `a4b83fb7`) flagged id `c469d54e` at a
permanent `count: 1`: `docs/decisions/c469d54e-ready-fallback-reanchored-to-sessionstart-dispatch.md`
(the winner, by store precedence) and `docs/investigations/c469d54e-ready-fallback-race/findings.md`
(dark — unreachable by `decision-records.mjs`'s `resolveRecord()`, which checks `docs/adr` then
`docs/decisions` before ever looking at `docs/investigations`). Measured harm: none — the dark file has
zero `Do not` headings, so no live anchor loses a prohibition (unlike the `ccb407eb` shape this check
exists to catch, where a reader silently got a DIFFERENT record's guard extract). The actual cost is a
check that never reads `0` training readers to stop trusting the number.

Three remedies were on the table: (1) teach the check to never flag a decisions/adr + investigations
pairing at all, (2) merge the investigation's substance into the decision record, (3) mint the
investigation a new id. (3) was rejected outright — the id is the board card id, and inventing a second
one for the same card's own supporting evidence would violate this repo's "never write an id you weren't
handed" rule. (2) was rejected on inspection: the investigation
(`docs/investigations/c469d54e-ready-fallback-race/`) is directory-shaped by necessity, not convenience —
it ships a re-runnable measurement script (`scripts/analyze-fallback-race.mjs`) and a reproducibility
anchor (a frozen log path + md5) that a flat `docs/decisions/*.md` file structurally cannot hold. Folding
its prose into the decision record would either strip that tooling or force restructuring `docs/decisions`
to support sibling files — out of scope, and a worse document either way (a decision record's job is the
compressed narrative + `Do not`, not incident-investigation methodology).

(1) — blanket-exempting the store-shape — was measured and rejected too: across this repo's full corpus,
**46 of the 47** `docs/investigations/<id>-*/` directories have **no** paired `docs/decisions` or
`docs/adr` record at all (checked by extracting every investigations dir's leading 8-hex id and testing it
against every `docs/adr`/`docs/decisions` filename). `c469d54e` is the sole exception. A check that always
believed "decisions + investigations sharing an id is fine" would be blind to a *future accidental*
collision of the exact same shape — precisely the failure this check exists to prevent recurring (`CLAUDE.md`,
card `a4b83fb7`: this collision shape "recurred across three independent lanes in one afternoon").

The adopted fix (`isVerifiedInvestigationCrossReference` in `comment-anchor-lint.mjs`) is narrower than
either extreme: a decisions/adr + investigations collision is exempted from `collidingRecords.count` only
when the winning record's OWN text contains the dark investigations path verbatim — i.e. the decision
record already carries a deliberate "See also" pointer to its supporting investigation, proving the
pairing was authored knowingly rather than discovered by accident. `c469d54e`'s winner already carried
exactly that pointer ("See also the fuller incident write-up at
`docs/investigations/c469d54e-ready-fallback-race/findings.md`"), so no source edit was needed — only the
checker's blindness to a verified pairing. The exempted item still surfaces, under
`collidingRecords.verified`, so it stays visible rather than silently dropped (this project's own standing
rule: shipping a detector is not someone reading it, and a detector that goes quiet without a visible trace
is worse than one that stays loud).

## Do not

- Do not exempt a decisions/adr + investigations collision from `collidingRecords.count` by STORE SHAPE
  alone (i.e. "any decisions+investigations pairing is fine") — measured at 46/47 unpaired, this pairing is
  the rare exception, not the convention, and a shape-only exemption would blind the check to a genuine
  future accidental collision of the same shape.
- Do not fold `docs/investigations/c469d54e-ready-fallback-race/`'s content into the decisions record — it
  is directory-shaped for a real reason (a re-runnable measurement script + a reproducibility-anchored
  frozen-log path that a flat `.md` decision record cannot carry).
- Do not mint a new id for the investigation to "re-key" around the collision — the id is the board card
  id; both artifacts legitimately belong to card `c469d54e`, and inventing a second id for the same card's
  own evidence violates this repo's "never write an id you weren't handed" rule.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs`, `isVerifiedInvestigationCrossReference` (added by card
`b8ae239e`, 2026-09-22), called from `computeReport`'s `collidingRecords` assembly.
