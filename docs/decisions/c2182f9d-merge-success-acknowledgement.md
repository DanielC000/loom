# c2182f9d — acknowledging a successful one-click merge

Card `c2182f9d`, discovered from `c2968651`. `MergeOutcome` in `packages/web/src/components/reviewQueue.tsx` rendered two of the merge endpoint's three outcomes and nothing at all for the third. This record is what the `@decision c2182f9d` anchor beside it points at.

## Do not

- **Do not move the success line out of `MergeOutcome` into either rendering.** `useWorkerMerge` / `MergeOutcome` / `MERGE_TITLE` are declared once and consumed by both the full `ReviewCard` and the compact `CompactMergeAction` — that is `c2968651`'s own standing prohibition, and a success branch written per rendering is exactly the second copy it forbids. One branch here is what gave the classic card and the band row the same confirmation in one edit.
- **Do not enrich the line with a `reason` or an `opId`.** `reason` is set on the pending branch and on a rejection, never on a `merged:true` return (see below); an `opId` would fill the line without telling the reader anything about their merge. `commitSubject` is the one exception, and it is no longer undeclared: card `3059ce95` widened `api.mergeWorker`'s response type with `commitSubject?: string` on purpose, after confirming the REST route forwards it, so `MergeOutcome` names it when present — see "Why the line now names the subject" below.
- **Do not reach for `reason` here as a fallback.** It is set on the pending branch (by the REST route) and on a rejection (by `ConfirmMergeResult`), and is absent from both `merged:true` returns. A `{reason ? …}` tail on the success line would be permanently dead against the real daemon, and any test written to exercise it would be asserting a response shape nothing produces.
- **Do not add an `isError` branch to this component.** `packages/web/test/loopback-credential.mjs` runs on every `pnpm build` and fails a `useMutation` that renders its own `.isError`/`.error` without `meta: { inlineError: true }`. A 400 from the merge route is already surfaced by the app's shared mutation-error path.

## Why success used to render nothing, and why that stopped being right

The original reasoning is recorded in the comment this anchor replaced: the row or card retires on its own once the merged worker leaves the live session feed, and `useWorkerMerge`'s `onSuccess` invalidates `allSessions` precisely to bring that forward. Adding a confirmation would also have changed what the classic Review queue rendered, which `c2968651` was deliberately holding still while it added a second rendering.

Both halves have since expired:

- **Retirement is a round-trip away, not immediate.** The invalidation refetches the session feed; the row only disappears once the daemon has stopped reporting that worker as live. In the gap the button goes from `Merging…` back to `Approve & merge` — byte-identical to a click that never fired, and to a click whose request failed before the mutation had anything to read. The one outcome a reader most needs to trust was the one the component said nothing about.
- **Holding classic still was a scoping decision for a different card.** `c2968651` added the band rendering and was right not to also change the classic surface in the same change. This card's whole subject is that confirmation, so the two renderings changing together is the intent rather than a side effect.

## Why the line now names the subject

`merged`, in `color.phosphor`, in the same 11px mono as its two siblings — a third parallel statement, not a new grammar. Card `3059ce95` widened it to `merged — <subject>` whenever `commitSubject` is present, since that is genuinely the most useful thing the line can say about a landed merge.

`commitSubject` is not present on every `merged:true`, though — only the plain green `ConfirmMergeResult` path sets it unconditionally; the `ALREADY_MERGED` finish (`finishAlreadyMerged`) deliberately never does, since no new commit lands there. `MergeOutcome` falls back to the bare `merged` whenever it's absent, so the line is always honest about what actually happened rather than fabricating a subject.

## What the e2e actually measures

`packages/web/e2e/atlas-merge-success.spec.ts`, on the shared `loomDaemon` fixture, with `POST /api/sessions/:id/merge` intercepted — so no real merge runs and no real `claude` spawns, the same reason `atlas-inline-merge.spec.ts` and `worker-diff-staletime.spec.ts` intercept their own endpoints.

Three things make it more than a render check:

- **A before/after on one click.** The success line is asserted absent, the click is exercised, the line appears — and the intercepted request's own URL is read back and asserted to name this worker's session id, which is what proves the rendered line came from this row's mutation rather than from anything else on a shared daemon.
- **Both renderings, under both switch states.** Atlas ON asserts the compact band action's line; Atlas OFF asserts the classic `ReviewCard`'s line *and* re-asserts that the compact action is still structurally absent from classic, so the shared branch reaching both surfaces has not quietly given the band row to the classic page.
- **The two pre-existing branches, re-driven on the same mount.** `rejected` and `still running` are asserted after the success assertion, from the same component instance, because a success branch inserted in the wrong order is a change that only shows up as one of those two going missing.

Identity discipline is the same as its sibling spec's: the e2e daemon is shared across spec files, so every locator is scoped to this test's own seeded worker session id (`data-session-id`) or to a per-run sentinel, never to button text or outcome text alone. `merged` in particular carries no per-run token of its own — it cannot, since the response has no reason field to put one in — so the row scope is the whole of its identity, and that is why it is never asserted page-wide.
