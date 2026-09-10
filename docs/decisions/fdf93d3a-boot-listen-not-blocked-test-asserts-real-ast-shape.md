# fdf93d3a — `boot-listen-not-blocked.mjs` asserts the boot-order chain via real AST shape, not a fixed character-offset slice

## Narrative

`boot-listen-not-blocked.mjs` (see [[460d3178-boot-orchestration-reconcile-kicked-after-listen-not-awaited]]
for the perf fix it guards) proves the boot-order invariant — `app.listen()` called, then
`sessions.reconcileOrchestrationOnBoot(...)` called strictly AFTER it, chained
`void <call>.then(...).catch(...)`, never `await`ed — by parsing `src/index.ts`'s real AST and asserting
on actual syntax-tree node shape and ordering, not text position or distance. An earlier version instead
read compiled `dist/index.js` and sliced a fixed ~1500-character window from the call site to find the
sibling `.catch()` text; that slice-length was sensitive to unrelated nearby text growth and broke twice
in one unrelated fix-pass — a longer log line or an added comment shifted the window enough to lose the
text it was looking for, with no change to the actual boot-order invariant it meant to guard. Reading
real syntax-tree node boundaries makes the test immune to that class of break: unrelated growth near the
call site changes node TEXT length, not tree SHAPE, so only an actual `.catch()` removal or reordering can
fail it.

## Do not

- Do not replace the AST-shape assertion with a fixed character-offset/window slice over source or
  compiled text — that shape has already broken twice on ordinary unrelated text growth near the call
  site, independent of whether the boot-order invariant itself still holds.
- Do not let this test's existence be read as licence to hand-verify boot order by eyeballing the diff
  instead of running it — the whole point is that a structural assertion catches what a by-eye review of
  a comment-only change would miss.

## Consequences

Growing the boot-time reconcile summary line, or adding/editing nearby comments, is safe and does not
risk spuriously failing this test — only an actual change to the call ordering or the `.then()`/`.catch()`
chaining shape can.

## Source

Test file header comment in `packages/daemon/test/boot-listen-not-blocked.mjs` (not itself under this
extraction's file fence — read as source material, not edited), as of this worktree's HEAD. The
corresponding inline citation this record resolves is in `packages/daemon/src/index.ts`, immediately
after the `reconcileOrchestrationOnBoot` summary construction (card `fdf93d3a`), as of this worktree's
HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers
stripped, no wording changed.
