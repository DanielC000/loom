# d92ec82b — the comment-anchor-lint hook is gated on an explicit `docLint` signal, not `vaultPath`

## Narrative

The comment-anchor-lint PostToolUse (Write|Edit) hook (card `67621894`) runs `comment-anchor-lint.mjs`
in its per-file `--hook` mode, scoped to just the one file a Write/Edit just touched. This hook targets
SOURCE files, not vault notes, so it has no legitimate need for a vault at all.

Before card `d92ec82b`, it was gated on `vaultPath` truthiness — a proxy for "docLint is on" that could
not distinguish "docLint is on" from "a vault is configured". A project with `docLint` on but no vault
configured never got this hook wired, even though the hook has nothing to do with vault content. Card
`d92ec82b` reworks the gate to the EXPLICIT `docLint` param, threaded through `SpawnOpts.docLint`
(`pty/host.ts`) from `sessions/service.ts`'s own `config.docLint` — independent of `vaultPath`. It also
requires `repoPath`, since the lint needs the session's actual repo root; a caller that omits `repoPath`
entirely (the pre-`5244adc2` shape) never gets this hook wired — the same "stays byte-identical" posture
as the decision-records hook in the same function.

## Do not

- Do not re-couple this hook's gating to `vaultPath` — that reintroduces the exact defect this card
  fixed: a project with `docLint` on but no configured vault would silently stop getting source-file
  linting, even though the hook never touches vault content.
- Do not assume a caller that omits `repoPath` gets this hook wired — it requires `repoPath` in
  addition to `docLint` being true.

## Source

Inline comment in `packages/daemon/src/pty/claude-settings.ts` (`writeSessionSettings`'s own doc
comment, the comment-anchor-lint hook paragraph), commit `a07c5092c` (2026-09-09).
