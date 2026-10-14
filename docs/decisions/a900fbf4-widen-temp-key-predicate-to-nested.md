# a900fbf4 — widen the temp-test-entries candidate predicate to nested `loom-*` keys

## Narrative

`pruneDeadTempTestClaudeConfigEntries` (card `d4580e19`) originally only treated a stored key as a
candidate when it was a DIRECT child of `os.tmpdir()` with a `loom-`-prefixed basename
(`isDirectLoomTempKey`). A read-only census (card `dc22f3d2`, run against the owner's real
`~/.claude.json`) found 44 real leaked keys nested one-or-more levels deeper under a `loom-*` fixture
root — e.g. `loom-ext-import-root-<rand>/<rand>`, `loom-rss-*-worktrees/<proj>/<sha>`,
`*/seed/repo-<hash>` — created when the leaking test fixture made a worktree, seeded a repo, or built a
run directory inside its own `loom-*` temp root before leaking. The direct-child-only predicate was blind
to all of them, since it rejected anything whose `path.dirname` wasn't exactly `tmpRoot`.

Card `a900fbf4` widened the predicate (renamed `isDirectLoomTempKey` → `isUnderLoomTempDir`,
`packages/daemon/src/pty/claude-config.ts`): a key now qualifies when it is strictly under (or equal to)
a direct child of `tmpRoot` whose basename starts with `loom-`, at any nesting depth — the `loom-` prefix
on the TOP segment immediately under `tmpRoot` is what safely attributes a key to one of Loom's own temp
fixtures; nesting depth under that segment adds no additional decoy risk the direct-child check didn't
already close out.

## Do not

- Do not restrict the candidate predicate back to direct children only — real leaked keys nest at least
  one level under a `loom-*` fixture root (see the census above), and a direct-child-only predicate is
  blind to all of them.
- Do not drop the `loom-` prefix check on the TOP segment when matching a nested key — a key nested under
  a NON-`loom-`-prefixed direct child of `tmpRoot` (e.g. `tmpdir/notloom-x/loom-y`) must stay rejected,
  however deep it goes; only the segment immediately under `tmpRoot` is tested for the prefix.
- Do not match `tmpRoot` itself — there is no top segment to test, and the direct-child case is already
  covered as a 0-deep instance of "strictly under a `loom-`-prefixed direct child."
- Everything `docs/decisions/498452c0-prune-count-drop-sanity-guard.md` documents about the shared lock /
  re-verify / count-drop core is unchanged by this widening — only the candidate predicate differs; see
  that record for the write path itself.

## Source

Introduced in `packages/daemon/src/pty/claude-config.ts`'s `isUnderLoomTempDir`, card `a900fbf4`.
