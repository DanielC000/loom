# d63585ca — project-local skills do NOT shadow same-named personal skills

## Narrative

`injectSkills` (`skills/inject.ts`) delivers Loom's managed skills by mirroring `~/.loom/skills/<name>`
into `<cwd>/.claude/skills/<name>`. Claude discovers these as PROJECT-LOCAL skills (bare names) —
without touching the user's personal set or `CLAUDE_CONFIG_DIR`.

CORRECTION (2026-07-20, card d63585ca): project-local does NOT shadow same-named personal skills —
Claude Code's documented precedence is the OPPOSITE (enterprise overrides personal, personal overrides
project; see https://code.claude.com/docs/en/skills.md). A bundled Loom skill whose name collides with
one the user already has under `~/.claude/skills` loses the collision and never fires. There is no
config lever to reverse this, so Loom's own skill names must simply not collide.

This was not hypothetical: a Loom manager invoked `/pickup` and loaded the WRONG (personal Obsidian
vault) skill instead of the Loom board/git one, then did none of it and oriented the Loom way anyway
(Selbstläufer Orchestrator `5abf781a`, ~turns 5-17) — a Platform audit finding (origin `e87342fc`,
severity low), ~2KB wasted plus a real risk a less-careful successor follows the irrelevant vault
workflow. Fix: `pickup` was renamed to `loom-pickup` to remove the collision (commit `95bed8ca`).

## Do not

- Do not give a new bundled Loom skill a name that collides with a common personal skill name — the
  collision is lost (personal wins) and the Loom skill never fires, and there is no config lever to
  reverse Claude Code's precedence order.

## Source

JSDoc comment in `packages/daemon/src/skills/inject.ts`, above `injectSkills`: lines 110-119, as of
this tranche's starting HEAD (main `6129350a`). The `/pickup` incident detail (Selbstläufer
Orchestrator `5abf781a`, ~turns 5-17; Platform audit finding origin `e87342fc`; "~2KB wasted") is from
card `d63585ca`'s own body (`tasks_get d63585ca`), not from the JSDoc, which only names the renamed
skill and not the incident.
