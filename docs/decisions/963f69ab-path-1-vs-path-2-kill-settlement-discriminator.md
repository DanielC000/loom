# 963f69ab — Discriminating a confirmed-dead PATH-1 kill from a PATH-2 give-up, and the leg-A regex-anchoring fix

## Narrative

Card `963f69ab`: `withTimeoutKillingChild`'s "confirmed dead" guarantee (see the `8e75ee20` record) holds only for its PATH-1 settlement — the `p.then(...)` rejection worded `"${label} exceeded ${ms}ms (git child killed)"`, which only fires once `p` itself has settled after the kill. Its `giveUpTimer` fallback (PATH 2, `"${label} exceeded ${ms}ms, killed, but did not die within ${killGraceMs}ms — giving up (hung git child?)"`) rejects on a bare timer with NO such confirmation — the child may still be alive when this fires. A caller that needs to know WHICH happened (e.g. whether it's safe to run destructive recovery against residue the add's child may still be writing to — see the `fdfe8a56` record) needs to tell the two rejection shapes apart.

**Leg A — the fix, and why the obvious regex was a real gap:** the unanchored `/\(git child killed\)/` regex a caller might reach for to detect PATH-1 was a genuine gap, not a hypothetical: `withTimeoutKillingChild` sets `timedOut=true` from its own `killTimer` (fired purely because `ms` elapsed — independent of what actually caused `p` to settle) and, when the wrapped promise `p` REJECTS while `timedOut` is true, appends `p`'s own rejection message verbatim after `"(git child killed): "`. That suffix is NOT necessarily produced by OUR kill: simple-git's OWN idle `block` timer independently kills the child too (routing through the same `gitResponse.kill(reason)` handler `abortPlugin` uses for `controller.abort()`), so a settlement caused by `block`'s idle timer produces a message like `"(git child killed): block timeout reached"` — a string the unanchored regex matched identically to our own confirmed kill's `"(git child killed): Abort signal received"`. The unanchored regex could not tell "our total-elapsed kill stopped this commit" from "a different mechanism (`block`, or anything else `p` might reject with) settled it".

The fix anchors the PATH-1 classification to the SPECIFIC suffix our own `controller.abort()` produces — `"Abort signal received"` — not the generic `"(git child killed)"` substring, so a block-timeout-caused settlement is correctly NOT classified as our confirmed-dead kill.

**Verification (`test/bounded-git-kill-on-timeout.mjs`, not touched by this card):** two negative controls confirm the classification discriminates correctly rather than passing vacuously — (1) an `AbortController` wired to nothing (mimicking a child that ignores the signal) correctly classifies as PATH 2, not PATH 1; (2) a manufactured rejection worded `"block timeout reached"` (mimicking `block`'s own idle-timer kill) correctly does NOT classify as the anchored PATH-1 regex, confirming leg A actually closes the gap rather than merely renaming it.

## Do not

- Do not classify a `withTimeoutKillingChild` rejection as a confirmed-dead PATH-1 kill by matching the generic `"(git child killed)"` substring — that also matches a settlement caused by simple-git's own idle `block` timer, which carries no such confirmation. Anchor to the specific `"Abort signal received"` suffix instead.

## Source

Inline comment in `packages/daemon/src/git/bounded.ts`, `withTimeoutKillingChild`'s doc comment (~lines 86-89), as of commit `754f0f70`. Relocated by card `8b19e004`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The leg-A mechanism and verification detail is corroborated by, but not extracted from, `packages/daemon/test/bounded-git-kill-on-timeout.mjs`'s own comments (out of this card's file fence; read for context only, not modified).
