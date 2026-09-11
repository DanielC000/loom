# c1d71ff2 — `nextComposerLen` tracks draft LENGTH (not a bool), and never whole-chunk-short-circuits on a freeing control

## Narrative

Two related design points in the raw-terminal composer-dirty tracker `nextComposerLen` (`pty/host.ts`), which computes the human's in-progress RAW-terminal draft length from each input chunk so a programmatic turn can be HELD while the box is dirty (see `deferForHumanDraft`) rather than delivered onto — and never clobbering — the human's half-typed text.

`composer-dirty` is deliberately `len > 0`, a LENGTH rather than a bare boolean, so that a human who BACKSPACES the whole line back to empty also releases the hold — a bare bool couldn't distinguish "backspaced to empty" from "still dirty."

A later fix (commit `7e623fbd`) corrected a mis-scan: the function previously could whole-chunk short-circuit on a BARE box-freeing control (Enter/Ctrl-C/kill-line) found anywhere in a chunk. A MULTI-LINE bracketed-paste body legitimately carries embedded `\r`/`\n` bytes as draft CONTENT, not a free — short-circuiting on those would wrongly zero a held paste and let a queued turn drain onto it. The fix scopes the box-freeing check to a control found OUTSIDE a `\x1b[200~ … \x1b[201~` bracketed-paste span; inside a span, `\r`/`\n` is counted as one draft char instead.

## Do not

- Do not collapse `composer-dirty` back to a bare boolean — it must be a length so a full backspace-to-empty is distinguishable from "still dirty."
- Do not short-circuit on a bare box-freeing control (Enter/Ctrl-C/kill-line) found anywhere in a chunk — only one found OUTSIDE a bracketed-paste span actually frees the box; inside a span it's draft content.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`nextComposerLen`'s function doc), as of this tranche's HEAD (commit `96872120`). No card id anywhere in the block, the file, or `git blame`'s introducing commits — sourced via the `sha:` grammar. The composer-dirty-is-a-length design and most of the doc introduced by commit `c1d71ff2fd8617302ea9139cf511375626785ba8` ("[Hardening, P2] pty: defer a queued report while the raw terminal has an uncommitted human draft (composer-dirty flag) — never clobber/concatenate the user's text"); the multi-line-paste-is-not-a-free fix by commit `7e623fbdb75faea4601cc8f5bb59360b46a199de` ("[Hardening, P3] composer-dirty: a multi-line raw-terminal PASTE is misread as box-freed (newline in the paste body zeroes composerLen)").
