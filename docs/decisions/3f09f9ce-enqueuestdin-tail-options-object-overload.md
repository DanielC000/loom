# 3f09f9ce — `enqueueStdin`'s tail accepts a single options object, additive alongside the positional overload

## Narrative

Card `3f09f9ce`: `enqueueStdin`'s TAIL — `giveUpHeldUntil` onward (`onGiveUpExhausted`, `logicalId`,
`mintedAtGen`, `mintedAtWallClock`) — also accepts a single named options object ({@link EnqueueStdinTail})
in place of the five trailing positional params, via an additive overload alongside the original positional
signature. Every existing positional call site keeps working byte-identical, including every `.mjs` test
double standing in for this method — those are untyped, so nothing here typechecks them, which required a
separate test-double audit (named on the card) rather than relying on the compiler to catch a stale mock.

**Why the overload exists:** a miscount among 5 same-typed trailing positional params typechecks cleanly
and fails silently — TypeScript can't distinguish "5 numbers/functions in the right slots" from "5 in the
wrong slots" when the types line up. That is exactly how two call sites silently dropped
`logicalId`/`mintedAtGen`/`mintedAtWallClock` before this card (see card `02baa3a5`, the companion-upgrade
requeue paths that were missing them). New call sites should prefer the options form — a wrong or missing
key fails to compile, where a positional slip would not.

## Do not

- Do not add a new trailing positional param to `enqueueStdin`'s tail — extend {@link EnqueueStdinTail}
  instead; a same-typed positional slot is exactly the shape that let two real call sites silently drop
  fields (card `02baa3a5`) without a type error.
- Do not assume the positional overload is typechecked at every call site — the `.mjs` test doubles
  standing in for this method are untyped, so a positional-tail regression there needs its own audit, not
  a compiler catch.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`enqueueStdin`'s own JSDoc, the tail-options paragraph),
as of `main` `7c501c6d4fda5741aad8adf95198159aadd6a5b6`. Extracted by card `17eee9f0` (tranche 25 on
`pty/host.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and
stripping `*` comment markers. See also `docs/decisions/02baa3a5-carry-logicalid-mintedat-through-upgrade-requeue.md`
for the specific incident (a different site, `sessions/service.ts`'s `upgradeCompanionCapabilities`) this
card's own commit message cites as the motivating silent-drop.
