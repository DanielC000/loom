# 64a30c79 — a merge touching `assets/skills/**` is not live at merge time; say so, both surfaces

## Narrative

Card 64a30c79: a branch editing `packages/daemon/assets/skills/<name>/**` can pass the gate, squash-merge,
and move its card to done while reaching ZERO agents at that moment — `skills/inject.ts` delivers from
the STORE (`<LOOM_HOME>/skills/<name>/SKILL.md`), not from `assets/`, and the store only advances at the
next daemon restart (for a `customized:false` pristine skill) or an explicit adopt (for a
`customized:true` skill, which a restart never advances). Nothing in the merge flow said either thing, so
the manager had every reason to believe the change had shipped.

MEASURED INSTANCE: card `a4b146bc` (a p1 stash-safety rule, itself filed because a bare `git stash` had
already destroyed a sibling's WIP) merged as `5de26606` at 03:39Z; the store's own text stayed unchanged
(`grep -c "refs/stash"` returned 0 continuously) until a `daemon_restart` at 04:49Z flipped it — a
**~70-minute window** in which the merge was green, the card was done, and every worker spawned in that
window read the OLD, additionally-wrong text.

CORRECTED SAME DAY: an earlier version of this card suppressed the warning for `customized:false`
(pristine) skills, reasoning they "genuinely auto-advance on restart." That is true but not the point —
"auto-advances on restart" is not "is live at merge time," and the measured instance above WAS a pristine
skill that auto-advanced 70 minutes late. Both cases are not-live-at-merge-time; only the remedy differs.

REMEDY SITS IN THE ACTION PATH, NOT AN ADVISORY: per memory `shipping-a-detector-is-not-someone-reading-it`,
a passive advisory was acted on 0 times across a measured sample; this warning rides the merge result and
nudge the manager is already reading, naming the skill(s) and the correct next step read from the ACTUAL
`customized` flag (never guessed) — pristine ⇒ "live at the next daemon restart"; customized ⇒ "needs an
explicit adopt; a restart will NOT advance it." Never blocks or refuses the merge — the merge is correct
and wanted; only the "...and therefore it is live" inference was wrong.

## Echoed on the async `[loom:merge-done]` nudge too (site: `confirmWorkerMergeTracked`)

The same `skillWarning` the sync result carries is echoed on the async settle nudge as `skillNote`, so a
manager who only reads the async nudge — the common case for a slow gate — still sees it, not only a
manager who happened to read the original tool-call return. Absent (empty string) for every merge that
never touched `packages/daemon/assets/skills/**`, byte-identical to before this card.

## Do not

- Do not suppress this warning for a `customized:false` (pristine) skill — it still auto-advances only at
  the next restart, not at merge time; the measured incident was exactly this case.
- Do not guess a skill's next-step wording — read the real `customized` flag per skill.
- Do not block or refuse the merge over this — it is a truthful-reporting fix, not a new gate.
- Do not leave this warning only on the sync return — echo it on the async nudge too, or a manager who
  only reads the nudge (the common case for a slow gate) never sees it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeTracked`'s async settle
callback (`skillNote`), as of this tranche's HEAD, plus board card `64a30c79`'s own body (filed by mgr
#130, 2026-08-06, from the measured `a4b146bc` instance).
