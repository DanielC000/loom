# 122eb237 — `withTimeout` throws a typed `WithTimeoutExpiry`; `isWithTimeoutExpiry` classifies by `instanceof`

Found by `1e7d6956`'s Code Review (reviewer `807c526a`). `isWithTimeoutExpiry`/`isSpawnLevelFailure`
(the `05915fc7` family, `git/worktrees.ts`) classified a git failure as TRANSIENT by matching `.message`
text — the lesson-271 shape: a hook's stderr, or any message carrying the phrase, can forge it.

## What changed

`withTimeout` (`git/bounded.ts`) now rejects its expiry with `new WithTimeoutExpiry(message)` — a typed
subclass of `Error`, same message text as before — instead of a bare `new Error(message)`.
`isWithTimeoutExpiry` (`git/worktrees.ts`, local to the 3 call sites below) now checks
`e instanceof WithTimeoutExpiry` instead of matching `/exceeded \d+ms \(hung git child\?\)/` against
`.message`.

## Scope: the TIMEOUT half only — `isSpawnLevelFailure` is a separate, follow-up card

The card as filed asked for BOTH predicates to move off message text, with the spawn half using
Node's structural `code`/`syscall` fields. Investigated and found that premise false for
`isSpawnLevelFailure`'s actual callers: verified directly (real `child_process.spawn` ENOENT vs. the
same failure run through `simpleGit({binary:'<bogus>'}).raw(...)`) that simple-git's own
`GitExecutorChain.onFatalException`/`onErrorReceived` constructs a BRAND-NEW `GitError` from
`String(err.stack)`, discarding the original Error object — the wrapped error's own keys are only
`['task']`; `.code` is `undefined`. All 3 of this card's call sites reach git exclusively through plain
`simpleGit(...).raw()` (`boundedGit`/`canonicalGit`), so there is no structural `code`/`syscall` left on
the object by the time any of them see it — only the text embedded in `.message`/`.stack` survives,
which is exactly what the regex already reads. Implementing the card's literal spawn-half prescription
would make `isSpawnLevelFailure` always return `false` for a real spawn failure at these 3 sites,
regressing the existing, deliberately-covered real-bogus-binary-spawn test in
`stale-generation-landedtip-content-check.mjs`.

Elsewhere in this same file, `isTransientSpawnErrorCode`/`TRANSIENT_SPAWN_ERROR_CODES`
(`worktrees.ts` ~9585-9592) DOES correctly check a structural `.code` — but its callers
(`mergeMainIntoWorktree`'s two mutating merge calls, via `killableCanonicalRaw`/`spawnCanonicalGitTree`,
`git/bounded.ts`) reach git through a RAW `child_process.spawn` (`rawViaDirectSpawn`/
`rawViaWinJobLauncher`), bypassing simple-git entirely — a structurally different path from this card's
3 sites, not a counter-example to the finding above.

`isSpawnLevelFailure` is left unchanged (still text-matching), with a doc-comment decision note at its
definition. The spawn half is carded separately (option A: generalize the `293beb47` guard-attached
marker mechanism beyond its current EMFILE/ENFILE-only scope, tapping the real spawn `'error'` event
before simple-git discards it — with its own forgery analysis, since `293beb47`'s marker rides in
`err.stack`, which can reach worker-readable logs).

## Blast radius of leaving `isSpawnLevelFailure` as-is

A forged spawn-shaped message can only shift RETRY/ESCALATION TIMING on the stale-generation
own-landing reconcile path (bounded: `staleGenerationTransientEscalateAttempts`/`_Ms`, 3 boots / ~1 day
— see `1e7d6956`'s own record) — never a merge decision or a deletion. 2 of `verifyReviewedTipChain`'s 3
callers (the merge-confirm paths, `sessions/service.ts` ~20352/~22106) deliberately IGNORE
`chain.transient` already (`@decision 1e7d6956`), so this predicate's classification has zero effect on
those two regardless of which predicate (timeout or spawn) fired it.

## Message-text compatibility — why nothing else breaks

`WithTimeoutExpiry extends Error` with the IDENTICAL message string `withTimeout` always produced.
Grepped every other consumer of this exact phrase (`/\(hung git child\?\)/`, 14 files) — all are either
(a) the DIFFERENT `withTimeoutKillingChild`/`killableCanonicalRaw` give-up/confirmed-kill message shapes
(`TIMEOUT_SHAPED_RE`, `isTransientSpawnErrorCode`, `isConfirmedKillTimeout` — a separate classifier
family entirely, untouched by this card), (b) prose/comments, or (c) a diagnostic-only output filter
(`dist-importer-check-glue.mjs`'s `BOUNDED_GIT_TIMEOUT_LOG_RE`) never asserted on. None of them
discriminate on `instanceof`/exact-class — `e instanceof Error` and `.message` both still hold for a
`WithTimeoutExpiry`, so every message-text-matching site (`verifyReviewedTipChain`'s own
`reason = message.split("\n")[0]`, shown to a human) is unaffected.

## Tests

`packages/daemon/test/with-timeout-expiry-typed-classification.mjs` — pure function-level unit tests (no
real repo/DB/daemon needed; every scenario supplies its own `deps.gitFactory`), covering all 3 call
sites (`findAllLandedTrailerCommits`, `resolveObjectKind` via `fullTreeEntries`, `verifyReviewedTipChain`):
a FORGED `Error` whose message carries the old phrase is NOT classified transient; a REAL `withTimeout`
expiry (a never-settling `git.raw()` under a short `deps.timeoutMs`) still IS. RED/GREEN proven via
`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts --file
packages/daemon/src/git/worktrees.ts --test packages/daemon/test/with-timeout-expiry-typed-classification.mjs`
— RED at the pre-fix `HEAD`, GREEN restored, tree confirmed byte-identical after.

## Do not

- Do not implement `isSpawnLevelFailure` by reading `e.code`/`e.syscall` directly off the error reaching
  its 3 call sites — those fields are already stripped by simple-git before any of them see it (verified
  above). A real fix needs to capture them at the source (the child's own `'error'` event), not at the
  catch block.
- Do not read a lack of `isTransientSpawnErrorCode` usage here as evidence structural spawn-code
  checking is broadly unavailable in this file — it works correctly for `mergeMainIntoWorktree`'s calls
  specifically because those bypass simple-git via `killableCanonicalRaw`/`spawnCanonicalGitTree`.
- Do not widen this card to also convert `withTimeoutKillingChild`'s own give-up/confirmed-kill message
  construction (`bounded.ts` ~386, ~397) — out of scope; a different function with its own typed-marker
  mechanism already (`UNCONFIRMED_KILL`/`CONFIRMED_KILL` symbols, card `24c0bdba`).
- Do not forget `WithTimeoutExpiry`'s message text must stay byte-identical to what `withTimeout`
  produced before — `verifyReviewedTipChain`'s own `reason` text (shown to a human) and every other
  message-text consumer depend on it being unchanged, only the classification moved off it.
