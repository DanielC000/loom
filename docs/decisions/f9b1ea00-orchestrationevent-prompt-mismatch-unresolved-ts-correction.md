# f9b1ea00 — `prompt_mismatch_unresolved`'s fields, and the `ts`-is-give-up-not-write correction

⚠️ Spans two decisions, both about this same event kind: this record (§1, the event shape + `ts`
correction, `shared/src/types.ts`) and the resolve-window's own sizing/bounding (§2, `pty/host.ts`).
`resolveRecord` serves one file per id; folded here rather than left as a second unreachable
`f9b1ea00-*.md` file (card `6de8956e`).

## §1 — Narrative

`PtyHostEvents.onPromptMismatchUnresolved` fired — a "recognized replay" `[loom:prompt-mismatch]` detection (the `UserPromptSubmit` mismatch detector's `replayedEntry !== undefined` branch) never resolved within `PROMPT_MISMATCH_RESOLVE_WINDOW_MS` — no later generation's own submission fused that gen's content back in whole. Distinct from `paste_length_loss`: that fires when Loom never wrote the lost text at all; this fires when Loom DID write it, the engine's echo mismatched it, and the follow-up window to prove recovery has elapsed. An independent worker, on a different specimen, later converged on this same sibling-asymmetry diagnosis on its own.

`detail` carries `{ gen, writtenHash, reportedHash, intendedLen, recognizedGen, matchedLen, leadingRemainderLen, trailingRemainderLen }`, plus an OPTIONAL `messageExcerpt` (card `a419a7e6`) — present only when `LOOM_LOG_MESSAGE_CONTENT=1` (default OFF), OMITTED otherwise, never an empty placeholder. This is the durable audit trail for a mismatch whose own notice promised a follow-up either way but, until this card, only ever delivered on the SUCCESS half.

Card `280309d9` (the `ts` correction): this row's own `ts` IS THE GIVE-UP INSTANT, NOT THE WRITE INSTANT — `handlePromptMismatchUnresolved` stamps `ts` at fire time, `PROMPT_MISMATCH_RESOLVE_WINDOW_MS` (600s) AFTER the mismatch was detected/written. Two independent parties both read `ts` as write time and got every time-correlation wrong by exactly ten minutes, before this was documented. `detail` now ALSO carries `writtenAt: string | null` — the real Enter-write instant (ISO, or `null` if unrecorded) — so a reader recovers true write time BY CONSTRUCTION instead of a manual hash-keyed join against `[prompt-echo]`. `ts` stays give-up time; `writtenAt` is ADDED, never a re-meaning.

### Do not

- Do not read this row's `ts` as the write instant — stamped 600s after the mismatch was detected/written. Use `writtenAt`.
- Do not re-derive write time via a manual hash-keyed join against `[prompt-echo]` — `writtenAt` recovers it by construction.

### Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `prompt_mismatch_unresolved` case doc). Relocated by card `35d90c4e` (tranche 1).

## §2 — the prompt-mismatch resolve window is sized past the measured p95 engine-confirmation lag

### Narrative

The bounded window a `[loom:prompt-mismatch]` "recognized replay" notice's own "wait one generation and re-check before treating this as a confirmed loss" promise gets to actually resolve (a LATER generation's submission fusing this one's content back in whole — see `Live.mismatchResolvedGens`) before Loom stops waiting and fails loud instead of staying silent forever.

SIZING (DoD-4: "pick the window deliberately and say why"): no direct measured distribution exists for "how long until a composer-accumulation fusion resolves a pending replay" specifically — the closest real data is `confirmationLatencyProportionalityClause`'s own n=177 give-up-driven engine-confirmation-latency pool (card `518d0305`): p50=8.5s, p90=45.9s, p95=342s (~5.7min), p99=675s (~11.25min), max=970s (~16min) — see pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`. A different signal (a single turn's own hook confirmation, not "does a LATER turn ever arrive"), but the best available order-of-magnitude evidence, and a resolving fusion needs a full extra turn on top. 10 minutes sits between the measured p95 and p99 — closer to the tail on purpose, because a false "confirmed loss" alarm sends its reader chasing a loss that never happened (the false-alarm regression DoD-3 guards against), worse than landing a few minutes late. Env-overridable so a hermetic test can shrink it.

Code Review MINOR (confirmed), later found INCOMPLETE and completed: unlike sibling `Number(env) || default` constants — where a bad override degrades benignly — a bad value here is not benign in EITHER direction. `Number(x) || default` only falls back on `0`/`NaN`/unset, so a negative override (e.g. `-1`, truthy) passes through, and `setTimeout` treats a negative delay as `0` — firing on the very next tick. The FIRST fix rejected that via `Number.isFinite(...) && > 0`, but left the opposite hole open: Node clamps any `setTimeout` delay ABOVE `2_147_483_647` (2^31-1 ms) to fire almost immediately instead — MEASURED (a delay of `3_000_000_000` fires in ~3ms with a `TimeoutOverflowWarning`) — so `LOOM_PROMPT_MISMATCH_RESOLVE_WINDOW_MS=3000000000` reproduces the EXACT same instant-false-alarm failure from the other side of the valid range. Bounding on BOTH sides (`0 < x <= 2_147_483_647`) closes both ends rather than reintroducing the failure at the other one.

### Do not

- Do not bound this constant's env override on only one side — a value above `setTimeout`'s signed-32-bit ceiling (`2_147_483_647`) fires almost immediately, reproducing the same instant-false-alarm failure as an unbounded negative value.
- Do not shorten this window below the measured p95 (342s) on intuition alone — a false "confirmed loss" alarm is worse than this notice landing a few minutes later.

### Source

Inline comment in `packages/daemon/src/pty/host.ts` (`PROMPT_MISMATCH_RESOLVE_WINDOW_MS`'s top-of-const doc). Relocated by card `a4818d7a` (tranche 1). Folded into this pre-existing record by card `6de8956e`.
