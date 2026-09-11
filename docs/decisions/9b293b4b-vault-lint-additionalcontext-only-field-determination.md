# 9b293b4b — vault-lint's FIELD DETERMINATION: additionalContext only, no systemMessage copy

`packages/daemon/assets/vault-lint.mjs` used to emit its advisory warning via BOTH
`systemMessage` and `additionalContext`, "whichever the running Claude honors" — a hedge never
actually checked.

Card da723d41 checked it empirically for the sibling hook `decision-records.mjs` (three
controlled `claude -p` trials, incl. a swapped-values control) and found `additionalContext` is
the ONLY field the model ever sees; `systemMessage` is UI-only and never reaches it.

This hook's own warning is addressed to the AGENT ("surfaces an ADVISORY warning to the agent" —
the agent self-corrects), not to the human at the terminal, so the same determination applies
here: emitting `systemMessage` bought nothing but double the byte cost.

Dated 2026-09-09. See also project memory
`posttooluse-hook-honors-additionalcontext-not-systemmessage` and `decision-records.mjs`'s own
header for the full method.

## Do not

- Do not reintroduce a `systemMessage` copy of this hook's warning — `additionalContext` is the
  only field the model ever sees.

## Source

`packages/daemon/assets/vault-lint.mjs`: the `FIELD DETERMINATION` comment.
