# 02cc2fbb — transcript token-composition report

`packages/daemon/scripts/transcript-token-composition.mjs` is the before/after instrument for the token-reduction cards (research 65e1fc5d, section 2).

## Decisions

- **Read-only over transcripts, `--root` required.** It never opens the Loom DB and has no default root, so a bare invocation cannot touch anything.
- **Instrument, not a gate.** The numbers depend on which host's transcripts are read, so the script is not in `STATIC_GUARD_REPO_PATHS` or `CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS`. Its test imports the script and exercises behaviour; it does not scan script text.
- **Method printed in every report**: denominator (sum of input + cache read + cache write over de-duplicated calls), window, chars/4, residency weight (chars x later calls in the same session).

## Do not

- Do not add a default `--root` pointing at the real home.
- Do not treat the CLAUDE.md / memory-digest attribution as additive to the first-call baseline; it is a char-based split inside it.
