# 29b22e7e — resume-summary gate: confirm Down landed before risking Enter (closes a 2026-07-10 race)

## Narrative

`resolveResumeGate` needs to know which option the resume-summary gate's ❯ cursor currently sits on — "1" (still the default, "Resume from summary"), "2" (the target, "Resume full session as-is"), "3" ("Don't ask me again") — before it presses Enter.

This closes the 2026-07-10 incident: the old handler wrote a blind, unverified Down+Enter pair, and under restart load the Down was delayed/reordered past the Enter — which then confirmed the still-default option 1, silently compacting the manager's full context. This was a systematic race, not a random dropped keystroke: it hit 3-for-3 simultaneously under restart load. That old pair was fire-and-forget: Enter fired unconditionally ~150ms after Down, never checking whether Down had actually landed.

The fix reads the cursor position back from `resumeGateScan` — a CUMULATIVE rolling buffer (each re-render is appended, not substituted, since the TUI repaints via cursor-repositioning escapes that `collapseBoot` strips, leaving every prior frame's text still concatenated in front of the current one) — and takes the LAST `❯N.` match, confirming the Down press actually landed before risking Enter. Same "last occurrence wins" reasoning as `detectPermissionMode`'s footer-mode `lastIndexOf` scan.

**Same commit's second half — `pty/claude-settings.ts`'s `RESUME_GATE_ENV_OVERRIDE`:** the SAME commit
(`29b22e7e25de03c2c2dc51b4069160eb5453c112`) that lands the keystroke-confirmation fix above also adds a
belt-and-suspenders fix at a different layer: it overrides both `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`
(to ~100 years) and `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (to 999999999) via `settings.json`'s documented
`env` key, so the resume-summary gate (`isResumeSummaryGate` in `host.ts`) never renders at all for any
real session — closing the race entirely rather than just handling it correctly when it occurs. The gate
(`Ifa`/`U1p` in the shipped CLI, confirmed against 2.1.206 by inspecting the bundled binary) only renders
when BOTH the session's age exceeds the minutes threshold (default 70) AND its estimated tokens exceed
the token threshold (default 100_000) — both read via `process.env` at the moment the gate would show;
overriding either alone would suppress it, both are overridden for defense-in-depth. This rides the SAME
per-session `--settings` file `writeSessionSettings` already writes (confirmed in the same CLI binary:
`env: v.record(v.string())`, merged into `process.env` at CLI startup) — no new spawn plumbing needed.

**Defensive option-3 correction (should be unreachable with a single Down ever written):** if the cursor is ever read on option 3 ("Don't ask me again") anyway, `resolveResumeGate`'s poll loop corrects with exactly ONE Up press — never a second Down — and keeps polling. No path may confirm with Enter while the cursor still reads "3": that would durably persist "don't ask me again" (an ONGOING config change) on top of still compacting this one time, a strictly worse outcome than the belt-and-suspenders give-up, which still sends Enter once the poll budget is exhausted (the pre-fix behavior) but only when the cursor is NOT known to be sitting on 3. This whole poll loop is itself the belt-and-suspenders fallback, not the primary defense — `RESUME_GATE_ENV_OVERRIDE` above is meant to keep the gate from ever rendering at all for a Loom-spawned session, so this loop should rarely if ever actually run in production.

## Do not

- Do not fire Enter against the resume-summary gate without first confirming, via a fresh cursor-position read, that the preceding Down press actually landed — a blind Down+Enter pair can confirm the wrong (default) option under restart load.
- Do not confirm/send Enter while the cursor reads option 3 ("Don't ask me again"), for any reason including give-up — that durably persists the "don't ask me again" setting on top of still compacting the current turn, worse than leaving the gate unconfirmed on screen.
- Do not remove the `RESUME_GATE_ENV_OVERRIDE` env thresholds (`pty/claude-settings.ts`) on the strength
  of the keystroke-confirmation fix above alone, or vice versa — they are two independent layers closing
  the same incident: one prevents the gate from ever rendering, the other handles it correctly if it
  somehow still does. Removing either narrows the defense, it doesn't make the other redundant.
- Do not lower either overridden threshold back toward a value a real long-running session could reach —
  that reopens the race the override exists to close entirely, not just narrow it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the resume-gate cursor-detection function doc), as of this tranche's HEAD (commit `1d2e8e78`). No card id anywhere in the block, the file, or `git blame`'s introducing commit — sourced via the `sha:` grammar. Whole block introduced by commit `29b22e7e25de03c2c2dc51b4069160eb5453c112` (2026-07-10). Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Extended by the `pty/claude-settings.ts` tranche-1 extraction (card `34ab92af`) with `RESUME_GATE_ENV_OVERRIDE`'s own doc comment, same introducing commit `29b22e7e25de03c2c2dc51b4069160eb5453c112` — a `find` before writing missed this file on the first pass; the near-duplicate `docs/decisions/29b22e7e-resume-gate-suppressed-via-settings-env-override.md` this produced was deleted and folded in here instead. Extended again by `pty/host.ts` tranche 48 (card `b09cbcd0`) with the defensive option-3 correction and belt-and-suspenders paragraph above and its two `Do not` bullets, sourced from `resolveResumeGate`'s own method doc (same introducing commit), which anchored to this record but wasn't yet folded into it.
