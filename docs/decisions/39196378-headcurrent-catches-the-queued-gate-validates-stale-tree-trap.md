# 39196378 — `headCurrent`/`headWarning` catch the queued-gate-validates-a-stale-tree trap

## Narrative

`headCurrent`/`headWarning` (card 39196378 — the queued-gate-validates-a-stale-tree trap, a confirmed live incident on a peer daemon) make a SETTLED result state plainly whether `validatedHead` is STILL the branch HEAD, computed once at settle time via `SessionService.describeGateHeadCurrency` — see its doc for the benign-vs-concerning wording split. `headCurrent:true` means nothing moved; `false` always comes with a `headWarning` explaining which of the two shapes it is. Set on every `ran:true` outcome, same as `validatedHead` — EXCEPT the circuit-breaker short-circuit path (no gate actually ran, no stamp taken, so neither field is set, same as `validatedHead`/`durationMs` there).

## Do not

- Do not skip stating `headCurrent`/`headWarning` on a settled result — this closes a confirmed live incident (a queued gate validating an already-stale tree) on a peer daemon; a `false` value must always come with a `headWarning` explaining which of the two shapes it is.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.headCurrent`/`headWarning`): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
