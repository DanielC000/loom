# 29b22e7e — resume-summary gate: confirm Down landed before risking Enter (closes a 2026-07-10 race)

## Narrative

`resolveResumeGate` needs to know which option the resume-summary gate's ❯ cursor currently sits on — "1" (still the default, "Resume from summary"), "2" (the target, "Resume full session as-is"), "3" ("Don't ask me again") — before it presses Enter.

This closes the 2026-07-10 incident: the old handler wrote a blind, unverified Down+Enter pair, and under restart load the Down was delayed/reordered past the Enter — which then confirmed the still-default option 1, silently compacting the manager's full context. This was a systematic race, not a random dropped keystroke: it hit 3-for-3 simultaneously under restart load.

The fix reads the cursor position back from `resumeGateScan` — a CUMULATIVE rolling buffer (each re-render is appended, not substituted, since the TUI repaints via cursor-repositioning escapes that `collapseBoot` strips, leaving every prior frame's text still concatenated in front of the current one) — and takes the LAST `❯N.` match, confirming the Down press actually landed before risking Enter. Same "last occurrence wins" reasoning as `detectPermissionMode`'s footer-mode `lastIndexOf` scan.

## Do not

- Do not fire Enter against the resume-summary gate without first confirming, via a fresh cursor-position read, that the preceding Down press actually landed — a blind Down+Enter pair can confirm the wrong (default) option under restart load.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the resume-gate cursor-detection function doc), as of this tranche's HEAD (commit `1d2e8e78`). No card id anywhere in the block, the file, or `git blame`'s introducing commit — sourced via the `sha:` grammar. Whole block introduced by commit `29b22e7e25de03c2c2dc51b4069160eb5453c112` (2026-07-10). Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
