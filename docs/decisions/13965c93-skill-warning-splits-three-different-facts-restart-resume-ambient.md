# 13965c93 — The skill-change merge-review warning splits three different facts, not one

## Narrative

`changedSkillNames` reports per-skill info for what a diff between `base` and `ref` touched under `packages/daemon/assets/skills/` (card `64a30c79`, reworded by card `13965c93` after a cross-project miscommunication showed the original single-fact detector collapsed three DIFFERENT facts into one warning line:

1. `skills/inject.ts` delivers a session's skills from the STORE (`<LOOM_HOME>/skills/<name>/**`), never from `assets/` directly — a merge landing an `assets/skills/<name>/**` change is not in the store at merge time; only a daemon restart re-seeds it (pristine skills only — a customized one needs an explicit adopt, which a restart never does for it).
2. Being in the store is not the same as a SESSION holding it: `injectSkills` runs on every resume/fork/recycle (not just first spawn), so a session already live across a restart only picks up the new content the NEXT time it resumes, not the instant the store updates.
3. `SKILL.md` is read ambiently; `references/**` is read on demand. A `references/**`-only change can be seeded, injected, byte-correct on disk in a session's own copy — and still behaviourally absent indefinitely, because nothing makes an agent open it. `referencesOnly` flags exactly this case so the caller's warning text can say so, instead of implying "restart/resume ⇒ live" the way the original one-line detector did.

This function only DETECTS what a diff touched; it asserts nothing about store/session state (the caller reads `customized` from the live skill store) and changes no skill-loading behavior itself.

Sorted by name; empty for a diff that never touches this prefix. Fails closed to `[]` on any git error/timeout, same posture as `isInertMergeDiff` — a missed detection costs one missing (never a wrong) warning line.

## Do not

- Do not collapse these three facts back into one warning line — that was the exact miscommunication (a merged skill change looking "live" when it wasn't yet, on multiple axes) card `13965c93` fixed.
- Do not treat a `references/**`-only change the same as a `SKILL.md` change in the warning text — `referencesOnly` exists specifically so the two are worded differently (ambient vs. only-if-an-agent-happens-to-open-it).
- Do not have this function assert anything about live store/session state — it only detects what the DIFF touched; the caller is responsible for reading the live skill store's `customized` flag.

## Consequences

A merge-review warning about a skill-asset change now correctly distinguishes "in the store" from "a live session actually reflects it" from "an agent has actually opened it," instead of implying a single restart/resume makes the change fully live.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `ChangedSkillInfo`/`changedSkillNames`'s own doc comment (~line 2464), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
