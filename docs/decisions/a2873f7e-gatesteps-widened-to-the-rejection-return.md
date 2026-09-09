# a2873f7e — `ConfirmMergeResult.gateSteps` widened to the rejection return, not just the green path

## Narrative

`gateSteps` (card a2873f7e; widened to the REJECTION return by card 720bb7ad — before that card this was GREEN-path only, forwarded from `GateSequentialResult.steps` but silently dropped on the plain gate-fail rejection return even though `gateStepsResult` was already computed and in scope there, nested only inside that return's own `gateDetail.steps` instead): per-step `{step, durationMs, status}` from the gate that just ran, set on BOTH outcomes now — `undefined` when the gate was reused (never actually spawned, see the reuse-a-green-self-check path) or when there's no gate configured at all. PURELY DIAGNOSTIC — see `formatGateStepsDiagnostic`'s doc; never branch on it.

## Do not

- Do not read `gateSteps` as GREEN-path only — card 720bb7ad widened it to the rejection return too, since `gateStepsResult` was already computed and in scope there.
- Do not branch on `gateSteps` — it is purely diagnostic (see `formatGateStepsDiagnostic`'s doc).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.gateSteps`): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
