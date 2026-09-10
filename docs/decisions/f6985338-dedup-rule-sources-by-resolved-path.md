# f6985338 — dedup the N-file rules union by `resolvedPath`, never by content

## Narrative

`buildRuleSources` builds the ordered, DEDUPED `RuleFileSource` list for the multi-file rules union (code review N3): `rules` first (if present, labeled "rules"), then every readable `rulesFiles` entry labeled by its own `resolvedPath` — but an entry whose `resolvedPath` was ALREADY SEEN (from `rules` itself, or an earlier `rulesFiles` entry) is SKIPPED, never pushed a second time.

Without this, the SAME on-disk file counted more than once — `rulesPath` equal to one of `rulesPaths`, a shape the `resume_doc_check` tool's own description explicitly invites ("pass `rulesPaths` instead of/alongside `rulesPath`"), or a duplicate entry within `rulesPaths` itself — reads as TWO DIFFERENT places the heading/marker was found, tripping `ambiguous`/`otherSources`/the top-level `ambiguityWarning` even though there is only ONE real file and nothing to migrate. That warning's own wording tells a reader this is doc-migration residue to resolve — sending them hunting a duplicate heading that does not exist is a false alarm on the module's loudest signal, worse than no signal at all.

Dedup by `resolvedPath` (not by content) is a strict subset of correct behavior: a caller who accidentally names the SAME file twice always meant one file; a caller who genuinely wants two DIFFERENT files with the SAME content is still free to do that (different `resolvedPath` ⇒ never merged) — so this never removes real ambiguity, it only removes duplicate reporting of what was never ambiguous to begin with.

## Do not

- Do not dedup the rules-source list by file CONTENT — that would incorrectly merge two genuinely different files that happen to hold identical text.
- Do not skip this dedup on the theory that a caller "shouldn't" pass the same file via both `rulesPath` and `rulesPaths` — the tool's own description invites exactly that shape.

## Source

Inline JSDoc in `packages/daemon/src/orchestration/rotation-check.ts` (`buildRuleSources`'s own doc), as of this tranche's HEAD, prior to compression. Extracted by card `1c247269` (tranche 1 on `orchestration/rotation-check.ts`).
