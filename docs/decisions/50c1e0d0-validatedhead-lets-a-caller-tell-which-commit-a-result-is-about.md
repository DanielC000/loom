# 50c1e0d0 — `validatedHead` lets a caller tell, after the fact, which commit a gate result is about

## Narrative

`validatedHead` (card 50c1e0d0 — the result-consumption fix) is the worktree `HEAD` this run actually gated against, stamped at the moment the run started (`null` only if the worktree was unreadable at that moment) — set on EVERY `ran:true` outcome (pass or fail) so a caller can tell, after the fact, exactly which commit a `[loom:gate-done]`/`[loom:gate-failed]` result is about.

## Do not

- Do not omit `validatedHead` on a failing `ran:true` outcome — it's set on BOTH pass and fail so a caller can always tell which commit the result is about, not just on a pass.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.validatedHead`): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
