# 2fd9abf9 — project memory: zero metered tokens, two delivery points, and the known platform/auditor gap

## Narrative

Card 2fd9abf9 is the project-memory feature itself — project-scoped shared knowledge, the fleet-wide sibling of the companion's own per-session memory (`companion/memory-recall.ts`). Retrieval is a local SQLite FTS5 query (`db.ts`'s `searchProjectMemory`), never an embedding endpoint or API call — a zero-metered-tokens constraint that applies to budgeting too, not just retrieval: `estimateTokens` is a cheap bytes/4 heuristic (no tokenizer), good enough to bound the digest deterministically without spending a real API call just to count tokens.

Two delivery points, both role-agnostic (unlike the companion-only recall): a FRESH spawn appends the framed digest to the composed startup prompt (`appendMemoryRecallToStartupPrompt`, reusing the same generic append primitive `assistant-prompt.ts` already exports for the companion case); a RESUME has no startup prompt at all (the "resume injects nothing" invariant), so it is queued via the ordinary `enqueueStdin` turn-injection primitive instead — see `sessions/service.ts` call sites.

Coverage (`sessions/service.ts`): `startNew`, `startManager`, `spawnWorker`, `recycleWorker`, `recycleManager` (all fresh-spawn paths, appending to the composed startup prompt) + `resume()` and `forkSession` (both `--resume`/`--fork-session` paths, which carry no startup prompt of their own — injected via `enqueueStdin` instead, exactly like `resume()`'s own project-memory half).

Known remaining gap, accepted rather than deferred: the platform/auditor spawn paths do not inject project memory — they sit above/outside the per-project board this feature is scoped to, so there's no natural project to retrieve notes from. Not pursued further as part of this card.

## Do not

- Do not assume a platform/auditor session receives project memory — the gap is a known, accepted scope decision, not an oversight to silently "fix."
- Do not add a metered/API-based token count to `estimateTokens` — the zero-metered-token constraint applies to write-time budgeting too, not only to the FTS retrieval query.
- Do not build a new resume-shaped delivery path that assumes a startup prompt exists — resume carries none; route through `enqueueStdin` like the existing `resume()` path.

## Source

JSDoc file-header comment in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 6-42 as of tranche 1 on that file. No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping the `*` comment markers.
