# One owner for the mutation-failure alert: the MutationCache

Card `ad42a127` (found by the lane-6 web review, `edc931d8`).

## Do not

- **Do not add an alerting `onError` to a mutation call site.** TanStack Query v5 runs the `MutationCache` `onError` AND the per-mutation `onError` for the same failure, so a second alerter means the user dismisses two identical modals for one error. `packages/web/src/main.tsx`'s cache handler is the single owner; a call site that wants different behaviour opts OUT, it does not add a second path.
- **Do not render a mutation error inline without `meta: { inlineError: true }`.** Without the opt-out the user gets the inline message *and* a blocking modal. The pairing is silent in both directions — nothing type-checks it — so it is enforced by the source scan in `packages/web/test/loopback-credential.mjs`.
- **Do not reintroduce `alertUnlessCredentialGuard`.** It was removed here; see below for why it could never be the distinct thing its own doc comment claimed.

## What was wrong

`main.tsx` installed a global `MutationCache.onError` that `window.alert`s every failed mutation unless the mutation sets `meta.inlineError`. Card `093981dd` then added `alertUnlessCredentialGuard` — a shared `onError` that alerts the raw message at the call site — and wired it into 27 mutations across 12 files. Its doc comment described it as "bypassing the global handler in main.tsx", but a per-mutation `onError` does not bypass the cache handler in v5: both run. So each of those 27 mutations produced **two** modals for one failure, differing only in the cache's `"Action failed: "` prefix. Answering an already-answered Request was the reproducible case.

A second, larger population had the other half of the defect: 53 mutations rendered their own inline error but never set `meta.inlineError`, so a failure drew an inline message *and* a modal over it.

## Why the cache won, and why the helper was removable

The two alerters were not complementary. `alertUnlessCredentialGuard` suppressed exactly one class — the credential-guard 401, keyed on `isCredentialGuardMessage` — and the cache handler suppresses that same class, through the same predicate, three lines above its own `window.alert`. Every one of the 27 uses was a mutation `onError`, where the cache handler always runs. So the helper added no suppression the cache did not already provide, and nothing was lost by deleting it rather than leaving it as an unused export whose doc comment actively instructed the next reader to re-create the bug.

The credential-guard behaviour that card `093981dd` was actually protecting survives in two places that remain load-bearing: `isCredentialGuardMessage` (the cache handler's own suppression) and `errorText` (the inline-render path). Only the redundant third copy went.

## What enforces it now

`packages/web/test/loopback-credential.mjs` scans `src/**/*.tsx` and fails on a `window.alert` outside `main.tsx` and on any `onError` that alerts. It runs as the first step of `@loom/web`'s own `build` script, so it is inside the project gate rather than an opt-in check. It is a source scan, not a render test: it catches the shape, and the `meta.inlineError` pairing is checked by the e2e spec `packages/web/e2e/mutation-error-alert.spec.ts`, which counts `page.on("dialog")` events for one failing mutation.
