# 245a3708 — one command replaces the unmaintained `grep -l readdirSync` folk recipe

## Narrative

WHY THIS EXISTS: `CLAUDE.md` documents `grep -l readdirSync packages/daemon/test/*guard*.mjs` BY NAME as an unmaintained folk recipe that answers a DIFFERENT question than "which guards does the merge gate always run" — it found its way into six card bodies anyway, because a worker who needs to run "the static guards" had no single command to reach for and reinvented one from memory. This script is that command, so there is nothing left to reinvent.

## Source

Inline comment in `packages/daemon/scripts/run-static-guards.mjs` (header, "WHY THIS EXISTS" paragraph, verbatim). Relocated by card `7fb7a5ba`.
