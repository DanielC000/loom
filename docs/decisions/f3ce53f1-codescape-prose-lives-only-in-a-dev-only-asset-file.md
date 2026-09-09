# f3ce53f1 — the codescape discovery block's prose lives only in a dev-only asset file, never a string literal

## Narrative

Why `resolveCodescapeBlockText` reads a file instead of a string literal: the block's prose ("Codescape is available for this project…") is NOT a source string anywhere in this codebase — it lives ONLY at `CODESCAPE_PROMPT_BLOCK_ASSET`, a dev-only asset file inside the `codescape` skill dir, which is entirely omitted from a published `loomctl` release (one of `DEV_ONLY_SKILLS`, exactly like that dir's own `SKILL.md`).

A compiled `dist/` file CAN carry a `codescape`-named identifier (this method, its callers, `resolveCodescapeConfig`, …) — the owner ruled 2026-07-23 (Request `e685f273`) that compiled internals are not a user-visible leak — but it must never carry the PROSE ITSELF, which reads as a feature announcement an end user could find by grepping their install.

## Do not

- Do not inline the codescape discovery block's prose as a string literal anywhere in `packages/daemon/src` — it must only ever live in the dev-only asset file, which the npm build omits.
- Do not read this guard as covering compiled identifiers too — the owner's 2026-07-23 ruling (Request `e685f273`) already settled that a compiled `dist/` identifier is fine; only the prose text itself is the leak.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveCodescapeBlockText`'s doc, the "PRIVACY GUARD" paragraph): originally lines 2292-2315, as of this tranche's HEAD. The guard sentence itself stays inline at the source (class-A, compressed to <=3 lines) — this record exists so the fuller rationale (why a file, the owner ruling, DEV_ONLY_SKILLS mechanism) survives for a contributor who never opens `service.ts`. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
