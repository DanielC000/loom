# Skill permission-widening is DISCLOSED, never stripped — and detected in exactly one place

Card `87a51903`, from investigate-first card `28b2ca6f`. Sibling: card `36101180`, the bundled-asset lint (`packages/daemon/test/skill-permission-widening-guard.mjs`).

## Do not

- **Do not make `skills/permissionWidening.ts` reject, strip, or rewrite anything.** It is a read-only detector. A human-written store skill may legitimately carry `allowed-tools`, `hooks:` or a body `!` command — that is the owner's call, the same trust tier as `allowDelta` (`@decision 8c27ae8e`). Refusing an **agent**-written skill is a different concern that belongs on the write path (`skillWriteData`/`skillEditData`), not here, and must not be bolted onto this module.
- **Do not copy these regexes into a second file.** `INLINE_SHELL_RE`'s `(?<!\`)` lookbehind and `topLevelFrontmatterKeys`'s column-0 bound are both load-bearing false-positive guards; a hand-copied set drifts and then silently disagrees about which skills are flagged. Import the module.
- **Do not widen `FRONTMATTER_RE` past the first `---` block.** It is deliberately the same bound `store.ts`'s `descriptionOf()` uses, so "frontmatter" means the same bytes to both. A whole-file key match would flag any skill whose body merely *discusses* these fields — including Loom's own doctrine skills and this repo's docs.
- **Do not change `permissionWidening` to be present-and-empty on a clean skill.** It is omitted, so a clean skill's `SkillSummary` (and the MCP `skill_list` row that spreads it) stays byte-identical to what it was before this field existed.

## Why disclosure, not enforcement

Card `28b2ca6f` measured three constructs Claude Code's skill loader honours with **no workspace-trust gate**:

| Construct | Scope of what it grants | Contained by `--disallowedTools`? |
|---|---|---|
| frontmatter `allowed-tools:` | the turn that loads the skill; in `auto` mode it also lets a body `!` run at render with no classifier pass (P3 vs P4) | yes (P5) |
| frontmatter `hooks:` | **the rest of the session**, on turns after the skill's own | **no** (P9) — hooks are not tools |
| body `` !`cmd` `` / ` ```! ` | render time, before any model turn | yes (P5) |

Measured exposure at the time of writing: 0 hits across 14 bundled skill dirs, 14 live `~/.loom/skills` dirs, and 7 personal `~/.claude/skills` dirs. The hazard is latent, not in use.

Three populations, three dispositions — and only one of them is this card's:

- **bundled assets** — a static lint, so a future addition is a deliberate merge-review point (card `36101180`).
- **agent-written store skills** — refuse at write. An agent path must not mint a grant that is human-only in every other form. Not this card.
- **human-written store skills** — **warn**. A human pasting an upstream skill is a deliberate, attributable choice. Stripping it would silently break a skill the owner chose to install, and would do so invisibly, which is strictly worse than the thing it prevents.

This card is the third row. That is why the module is a detector and the UI is a notice rather than a gate.

## Why one module

`listSkills()` (the Skills list / MCP `skill_list`), the gateway's single-skill read, and the sibling bundled-asset lint all need the same answer. The patterns are subtle enough that an independent re-derivation is a real risk: a naive whole-file `/allowed-tools:/` scan flags prose, and a naive `/!\`[^\`]+\`/` scan flags the perfectly ordinary markdown sentence "the `!` character, like `ls`" (the closing backtick of the first code span lands directly after the `!`). Both false positives are in this module's own test as negative controls.

The module takes text and returns ids — no `fs`, no `paths.ts`, no `LOOM_HOME` — specifically so the lint, which is a bare `node test/*.mjs` source-text scan, can import it without becoming a daemon test.

## The UI side

`packages/web/src/pages/Skills.tsx` renders it at three weights, which is the whole surface (one component serves both the classic shell and Atlas, via `pages/Actors.tsx` and `WORKSPACE_NODE_TABS`' `actors` entry):

1. a `red` sidebar dot — the glance signal, distinguishable at a glance from the two amber ones already there;
2. a `red` header badge naming the count;
3. a hairline banner, one line per detected vector, each naming the construct and in plain words what it does.

`red` rather than `amber` deliberately: amber already carries two unrelated states on this page ("update available", "not delivered to locked roles"), and this codebase's own precedent for a capability/trust disclosure is `red` (`pages/Companion.tsx`'s "Elevated grant", "owner only", "no guardrails"). The banner copy carries the "Loom does not remove these" sentence, so the colour signals *severity of what it does*, not *something is broken*.
