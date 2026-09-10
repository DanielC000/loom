# sha:5cb98ca4 — repair engine-mangled comment markers in transcript tool-result bodies

Source: commit `5cb98ca4`, no board card.

## Narrative

Repairs a CONFIRMED engine-side transcript-capture quirk (Claude Code CLI on Windows, v2.1.202): the last line of a Grep/Read `-C` context hunk occasionally has its leading comment token collapsed to a bare backslash where the ENGINE WRITES ITS OWN on-disk JSONL — `// Guard the X` -> `\ Guard the X`, `/** Every Y` -> `\** Every Y` (verified against a real transcript; the source file itself is untouched — `git show`/`Read` on the same line reads back clean `//`/`/**`). Loom's daemon never touches this text before this point (it's a straight `fs.readFileSync` + `JSON.parse` of the engine's file), so this can't be fixed at the source — but the loom-audit surface must still hand an auditor VERBATIM code, so the corruption is repaired at read time instead of being passed through.

Per LINE (Grep/Read output is always line-oriented — `NNNN-`/`NNNN:`/`NNNN\t` decoration then the source indentation): strip that leading decoration, and if what remains starts with a bare `\` followed by a space or `*`, restore the dropped slash(es). A source/comment line never legitimately starts (after its own indentation) with `\ ` or `\*` — that exact pair only arises from this engine collapse — so the repair can't false-positive on real content; a mid-line backslash (e.g. a quoted Windows path) is untouched since it never sits at this leading position.

Original motivation: `fix(loom-audit): transcript_read mangles leading //` and `/**` comment prefixes to `\` / `\**` in embedded grep/read results — the auditor's own surface can fabricate a comment defect.

## Do not

- Do not weaken the leading-position check (`\ ` / `\*` immediately after line decoration + indentation) — it is what makes the repair unable to false-positive on real content, including a mid-line backslash such as a quoted Windows path.

## Source

Originally landed in `packages/daemon/src/sessions/transcript.ts` by commit `5cb98ca4` (verified: `git cat-file -t 5cb98ca4` -> commit; content diffed byte-identical against `git show 5cb98ca4c1a3f5f7d1c60d842f0a92129da3bf2e`). Relocated unchanged into `packages/daemon/src/pty/claude-transcript.ts` by the later HarnessAdapter-seam move (commit `f6e652be`, card `2b099e48`) — `git blame` on the current file location names that move commit, not the original fix; this record cites the true originating commit instead, found via `git log --all -S"CONFIRMED engine-side transcript-capture quirk"`. Function: `repairMangledCommentMarkers` (lines 228-244 pre-extraction).
