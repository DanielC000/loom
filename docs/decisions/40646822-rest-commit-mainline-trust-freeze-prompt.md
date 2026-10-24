# 40646822 — prompt a reset-with-adopt after a human REST commit on mainline

Follow-up to `8418479f` (`docs/decisions/8418479f-human-rest-commit-does-not-advance-trust.md`), which
decided **NO** on making the human REST `git_commit` route a mainline trust writer, and named the
remaining gap as UX only: "the REST `git_commit` response, or the web UI, could proactively suggest
calling the reset route — tracked as a separate card, not a trust-boundary change." This card is that
separate card.

## What ships

`POST /api/projects/:id/git/commit` (`gateway/server.ts`) now carries `willFreezeMainlineTrust: true` on
a successful (`ok:true`) response when the commit just landed on the branch the mainline watermark for
this project's primary repo currently trusts. The field is **omitted entirely** (not `false`) when it
doesn't apply — absence means "no risk", presence means "the next real landing will freeze trust here".

The web Git page (`packages/web/src/pages/Git.tsx`) shows that plainly next to a successful commit
result and offers a one-click "Re-adopt this head" button that calls the existing
`POST /api/projects/:id/mainline-watermark/reset` route. The button **never** fires on its own — only an
explicit click calls it, exactly as `8418479f`'s own "Decision: NO" requires ("never auto-call it").

## How "mainline" is determined — reused, not re-derived

Per `8418479f`'s own "What happens today" section and `Db.purgeMainlineWatermarkState`
(`db.ts`), the fact this feature needs is already split across two existing, independent reads — this
card does not introduce a third way to decide what counts as mainline:

1. **The live checked-out branch** of the project's primary canonical repo — `readMainlineHead(repoPath,
   …)` (`git/mainline-watch.ts`). This is the exact same read the `mainline-watermark/reset` route already
   performs to build its own `adopt` parameter.
2. **The branch Loom currently trusts** for `(projectId, repoKey)` — the mainline watermark row itself,
   read via `parseMainlineWatermark(db.getMeta(mainlineWatermarkKey(projectId, repoKey)))`. This is the
   same row `Db.purgeMainlineWatermarkState` (shared by `resetMainlineWatermark`/`repointMainlineWatermark`)
   already reads.

`commitWillFreezeMainlineTrust` (`gateway/server.ts`, right above the commit route) compares (1) against
(2)'s `branch` field. Three outcomes:

- **No watermark yet** (`(projectId, repoKey)` never established a trusted baseline) — first sight,
  nothing to freeze, since the next landing's `checkMainlineMove` silently seeds instead of freezing.
  Field omitted.
- **Live branch equals the watermark's trusted branch** — this is the scenario `8418479f` describes: the
  watermark's *sha* will silently advance at the next landing's "explained" classification, but the
  per-branch *trust* record does not, so that landing's `advanceMainlineWatermark` sees
  `trustedBefore !== checkedTip` and freezes. Field set to `true`.
- **Live branch differs from the watermark's trusted branch** — a different, pre-existing hazard
  (`2a6a292a`'s branch-diverted case), out of this card's scope. Field omitted.

## Do not

- Do not make this route, or anything it calls, write a mainline trust or ledger row. `8418479f`'s
  "Decision: NO" and its "Do not" list still apply in full — this card changes NOTHING about what writes
  trust, only what the human is told and offered as a one-click follow-up action they must still click.
- Do not auto-call the reset route from the commit response, from a page-load effect, or from any other
  non-click trigger. The human clicks, every time.
- Do not re-derive "what counts as mainline" from a third source (a project config field, a fresh
  `origin/HEAD` probe, a different watermark key shape). Reuse `readMainlineHead` +
  `mainlineWatermarkKey`/`parseMainlineWatermark` exactly as read above — both are already the daemon's
  own answer to this question, in two different call sites that must not drift apart.
- Do not surface this field or prompt for a commit on a non-mainline-watermarked branch (the
  branch-diverted case above), and do not surface it on a failed (`ok:false`) commit.
