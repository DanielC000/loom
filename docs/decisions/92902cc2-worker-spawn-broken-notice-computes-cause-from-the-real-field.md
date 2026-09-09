# 92902cc2 — the periodic `[loom:worker-spawn-broken]` notice computes its cause from the real field, never asserts one

## Narrative

Card 92902cc2: `notifyManagerOfIdleWorker`'s `[loom:worker-spawn-broken]` notice — the second, independent sender of this tag (the idle watchdog; the first site is `handleKickoffGiveUpExhausted`). Unlike that first site, this one is periodic — it re-fires on every idle tick, not once — so unlike the first site it must stay close to the original's length, not grow to match it; only restate what the first site does NOT already cover.

`classifyIdleWorker`'s `broken-spawn` kind has two structurally distinct triggers that both used to reach one hardcoded string here: `!engineSessionId` (genuinely no session — "no engine session was ever established" is true) and `engineSessionId` set but no turn ever started (a stranded-composer candidate — that clause is false there). Computing the cause from the actual field, instead of asserting one unconditionally, is what makes the notice correct on both triggers instead of only one — and it means a caller can never reintroduce the false clause by drifting past whatever gate it gets to today (e.g. the taskless branch's own `!w.engineSessionId` check): the builder itself never asserts what it hasn't read off `w`.

`getComposerDirtyLen` is read via a `typeof` guard, not a plain call, for the same reason the rootMsgId join guard a few hundred lines below is: `this.pty` is a concrete `PtyHost` in production (the method always exists there), but this codebase's test suite is full of hermetic PtyStub fakes that duck-type only the subset of the contract their own scenario needs — an unguarded call throws "not a function" on every stub that hasn't opted into this method.

`composerDirtyLen` itself has a blind window even when read successfully: it is only set once Loom's own give-up/heal budget exhausts (tens of seconds) — the idle watchdog can fire inside that window, and `undefined`/`null` (not live in this process, or not yet set) is not proof the composer is clean. The notice states this explicitly rather than letting a `0`/`n/a` reading pass as a clean bill.

## Do not

- Do not hardcode a single cause string for `broken-spawn` — compute it from whether `engineSessionId` is set, since the two triggers (no session vs. no turn started) are structurally distinct and only one clause is true for each.
- Do not call `getComposerDirtyLen` unguarded — the test suite's hermetic `PtyStub` fakes don't all implement it; guard with `typeof`.
- Do not read an unset `composerDirtyLen` (`undefined`/`null`) as proof the composer is clean — it may simply not have been set yet inside the give-up/heal budget's blind window.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the second `[loom:worker-spawn-broken]` notice site's top-of-block doc): lines 1228-1253, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
