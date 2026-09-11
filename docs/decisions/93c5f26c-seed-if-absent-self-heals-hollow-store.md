# sha:93c5f26c — seed-if-absent, and self-heal a hollow store dir left by the junction bug

Source: commit `93c5f26c`, no board card.

## Narrative

`seedGlobalSkills` seeds each bundled skill ONLY IF its `SKILL.md` is absent, so a user's UI edits to a
skill survive reboots — the old behavior force-copied every boot, which would clobber edits. A future
"reset to bundled" can force-refresh a single skill on demand instead.

Self-heal: the gate is the skill's `SKILL.md`, not the dir. If a skill's dir exists but is EMPTY, this
(re)copies the bundled asset so the store repopulates on the next boot. This exists because of a real,
shipped incident: Loom's injected skills were silent no-ops for every spawned session — the store
(`~/.loom/skills/<name>`) ended up with dirs but ZERO `SKILL.md` files. Root cause: `injectSkills`
placed each session's `.claude/skills/<name>` as a Windows JUNCTION into the store; `removeWorktree`'s
recursive-rm backstop runs on ~every merge on Windows and FOLLOWS the junction, deleting the store's
`SKILL.md` contents and leaving a hollow dir. `seedGlobalSkills` was dir-keyed (skip if dir exists), so
an emptied dir was NEVER refilled — the store stayed dead after the first merge. Fix: `injectSkills`
switched to a plain recursive `fs.cpSync`, never a junction (each session gets an independent copy that
worktree removal deletes without ever reaching the store), and `seedGlobalSkills` gates on `SKILL.md`
presence, not the dir, so a missing/hollow dir (re)seeds while a present `SKILL.md` (incl. UI edits) is
left untouched.

## Do not

- Do not gate re-seeding on the store DIR existing — a dir can be hollow (emptied by the junction-follow
  bug, or any other partial-delete). Gate on `SKILL.md` presence instead.
- Do not deliver an injected skill via a filesystem junction/symlink into the store — worktree removal's
  recursive-rm backstop follows it and can delete the store's real content out from under every other
  session. Use an independent recursive copy.

## Source

JSDoc comment in `packages/daemon/src/skills/seed.ts`, above `seedGlobalSkills`: lines 23-30, as of this
tranche's starting HEAD (main `6129350a`). Introducing commit: `93c5f26cb58bf2bdf2eeb552916e5e871c41bf1b`
("fix(daemon): skills inject COPIES not junctions; seed self-heals hollow store").
