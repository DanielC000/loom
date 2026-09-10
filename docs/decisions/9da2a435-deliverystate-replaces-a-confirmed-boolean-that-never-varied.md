# 9da2a435 — `deliveryState` replaces an earlier `confirmed:boolean` that discriminated nothing

## Narrative

Card `9da2a435` (additive; CR follow-up [3]) added `deliveryState: "handed-off" | "queued" | "dropped"` to `EnqueueResult`, ALWAYS present, one-to-one with which branch of `enqueueStdin` actually ran — the honest per-call outcome, spelled out instead of left to be inferred by cross-referencing `delivered`/`reason`/`queued`. It replaces an EARLIER `confirmed: boolean` field that was rejected for carrying zero bits: it was present only alongside `delivered:true` and never varied, so it discriminated nothing a caller could act on.

`"handed-off"` (the immediate-submit branch) makes explicit what `delivered:true` has always actually meant and never stopped meaning: the text was HANDED to `submit()` as a turn attempt — NOT that the engine confirmed receiving it. That confirmation (`fireEnterAndVerify`'s hook round-trip) is asynchronous and can still give up after this call already returned. The live specimen behind this card was exactly that: `worker_message` returned `{delivered:true}` for a message that never reached the worker's transcript. A caller that needs to know the real outcome must correlate `msgId` against a later `worker_list`/`worker_status` read (`staleDirective`/`parkedDirective` — see `staleDirectiveProjection` in `mcp/orchestration.ts`), which DOES read the durable `session_message_gave_up` trail this synchronous return value cannot see yet. `"queued"` (the held branch) and `"dropped"` (the `session-dead` branch) are the same per-branch identity `delivered`/`reason`/`queued` already convey — `deliveryState` doesn't add new information there, it just gives a caller one field to read instead of three.

## Do not

- Do not reintroduce a `confirmed`-style boolean that only ever co-occurs with one other field's value — if it never varies independently, it discriminates nothing; a caller needs the per-branch identity (`deliveryState`) instead.
- Do not treat `delivered:true` (the `"handed-off"` branch) as proof the engine received the text — it only means the text was handed to `submit()`. Confirm via `staleDirective`/`parkedDirective` on a later `worker_list`/`worker_status` read.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `EnqueueResult.deliveryState` field doc), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
