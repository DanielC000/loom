# 86b41129 — `VaultVersioner.whenReady()` owns its own bounded timeout and names a pre-ready failure

## Narrative

`VaultVersioner.start()`'s watcher lifecycle stays swallow-and-log on error: the "error" listener never rethrows, matching `sessions/liveness.ts`'s established doctrine that a transient, often-recoverable chokidar error must not poison state nothing may ever observe. Because of that, the shared `readyPromise` field itself still never rejects — it only ever resolves, on `"ready"`.

Production is unaffected by `whenReady()`'s own rejecting behavior: nothing outside this method calls `whenReady()` today. But a caller that DOES call it is, by definition, asking to be told — so `whenReady()` cannot simply inherit `readyPromise`'s never-rejects behavior. It owns its own bounded timeout (`whenReadyTimeoutMs`) rather than requiring every caller to bring one, and rejects as soon as it can name why, rather than making a real defect indistinguishable from "still scanning". The method's own JSDoc (still inline, immediately below this anchor) enumerates the three ways a rejection is produced, so a caller's `Error` is never anonymous.

## Do not

- Do not let `whenReady()`'s rejection depend on the shared `readyPromise` ever rejecting — that field is deliberately swallow-and-log by design (matching `sessions/liveness.ts`'s doctrine); `whenReady()` must own its own bounded timeout and named-failure logic independently of it.
- Do not let a pre-ready failure resolve/hang silently once a caller has opted into `whenReady()` — always reject with a real, inspectable `Error` naming why, never `undefined` or an anonymous test-harness-style timeout.

## Source

Inline JSDoc in `packages/daemon/src/vault/versioner.ts` (`whenReady()`'s doc comment, originally lines 676-682 as of commit `e17a8c2a`). Condensed and reworded, not verbatim; the method's own enumerated 1/2/3 rejection-path contract stays inline in the source (Class C — not moved here).
