# f761fdf3 — the --apply gate's real-config comparison must be win32-safe

## Narrative

Card f761fdf3 item 1 fixed `scripts/prune-claude-config-worktree-entries.mjs`'s `--apply` gate so it
compares the RESOLVED `claudeJsonPath()` against the real `~/.claude.json` (`os.homedir()`) instead of
checking whether `CLAUDE_CONFIG_DIR` was merely "set" (which `CLAUDE_CONFIG_DIR=""` passes, even though
`claudeJsonPath()` treats an empty string as unset — i.e. the real file).

Manager review on the follow-up merge caught a second defect in that same comparison: a plain `===` on
`path.resolve(...)` output is case- AND drive-letter-casing-sensitive on win32. A differently-cased
spelling of the real home — e.g. `CLAUDE_CONFIG_DIR=c:\users\<name>` when the real home is
`C:\Users\<name>` — resolves to the SAME real file on disk but compares unequal as a bare string, so the
gate would treat it as "not the real config" and wave `--apply` + an overridden `--worktrees-root` through
against the real file.

The fix normalizes both sides before comparing: resolve, strip trailing separators, and lower-case the
result on win32 only — the same shape `claude-config.ts`/`git/worktrees.ts`'s own `normForCompare` already
uses for every other stored-key comparison in this file's domain. The helper is duplicated narrowly inside
the script itself rather than importing `git/worktrees.js` (a large module with many unrelated
dependencies — git ops, vault, merge-quarantine, codescape privacy, …) into this small one-off CLI script
just to reuse one function.

## Do not

- Do not revert the apply-gate's real-config comparison to a bare `path.resolve(...) === path.resolve(...)`
  — it is case-sensitive on win32 and can be defeated by a differently-cased (but identical) real home.
- Do not import `git/worktrees.js` into this script merely to reuse `normForCompare` — duplicate the small
  normalize-and-lowercase-on-win32 shape instead; the real `normForCompare` also handles the win32
  extended-path (`\\?\`) prefix, which is irrelevant here since neither `claudeJsonPath()` nor
  `os.homedir()` ever produce such a path.

## Source

`packages/daemon/scripts/prune-claude-config-worktree-entries.mjs`, card `f761fdf3` (manager follow-up
after the item-1 merge review).
