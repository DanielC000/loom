# 7fbd1ba5 — codex never calls `injectSkills` — deliberate, not a gap

## Narrative

Neither `createCodexPty` nor `spawnCodexProcess` ever calls `injectSkills`. This is a ruling, not an oversight: `HarnessAdapter`'s `doctrineInjection` field (`adapter.ts`) declares exactly two shapes for how doctrine reaches a CLI — `"directory"` (claude's `.claude/skills` convention, delivered by `injectSkills`, `skills/inject.ts`) and `"file"` (codex's `AGENTS.md` convention). `claudeAdapter` declares `"directory"`; `codexAdapter` declares `"file"` (`codex-adapter.ts:32`) — this is a load-bearing architectural choice baked into the Phase-0 seam interface itself (card `2b099e48` — see that card's own record for the seam's own decision), not an incidental omission in this call site.

Codex is NOT skills-blind — it ships its own first-party skills tree (`~/.codex/skills/.system/`, including a `skill-installer`; see `docs/investigations/049e4a7b-codex-cli-capability-probe/findings.md:16`) — but mirroring `.claude/skills` into a codex worktree would deliver a claude-specific path/layout codex has no reason to read. A codex-side skills equivalent, if ever built, belongs on codex's OWN skills convention, not this one. `injectCodexDoctrine` (`codex-doctrine.ts`) is the `"file"` counterpart, called from `spawnCodexProcess`, mirroring `injectSkills`'s call site in `createPty`.

## What a codex worker does not get, relative to a claude worker

None of these are wired to any codex-side equivalent today:

- The project's whole skill set (every store skill, or the profile-pinned subset) — `AGENTS.md` carries no directory-of-skills equivalent by design.
- The role's full operating-doctrine skill (`ROLE_DOCTRINE_SKILL`, `skills/inject.ts`) — codex gets only a hand-condensed worker doctrine (`codexWorkerDoctrineBody`, `codex-doctrine.ts`: three load-bearing rules named by card `887e10b8`), and ONLY for `role === "worker"`; every other role (manager/platform/auditor/workspace-auditor/setup) gets NO doctrine injection at all on codex today — a named Phase-1 scope limit (`injectCodexDoctrine`'s own doc), not an oversight, but worth knowing before any non-worker codex role is ever dispatched.
- The conditional Obsidian-preflight skill FRAGMENT (`OBSIDIAN_FRAGMENT_SKILLS`, `skills/inject.ts`) — codex has no skill file to append it to. Card `9346ed5b` (see that card's own record) already threads the underlying `LOOM_OBSIDIAN_PREFLIGHT` env var into a codex spawn's env, so an `obsidian.autoStart` codex worker ends up with the script path SET but no instruction telling it to run it — a known, disclosed asymmetry, not new.

Whether any of these gaps needs a codex-side equivalent is a separate, undecided question this card does not settle.

## Do not

- Do not mirror `.claude/skills` into a codex worktree to "fix" this — codex has no reason to read a claude-specific path/layout; a codex-side equivalent belongs on codex's own skills convention.
- Do not treat the absence of `injectSkills` on the codex path as a bug to patch — it is `HarnessAdapter`'s declared `"file"`-shaped doctrine injection, implemented by `injectCodexDoctrine`.
- Do not assume any of the three enumerated gaps above (whole skill set, role doctrine skill, Obsidian fragment) is closed without checking `codex-doctrine.ts` first — none had a codex-side equivalent as of this card.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `createCodexPty`), as of this tranche's HEAD. Relocated by card `8dcf8521` (tranche 15 on `pty/host.ts`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
