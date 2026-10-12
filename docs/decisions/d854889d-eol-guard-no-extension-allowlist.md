# working-tree-eol-guard.mjs: no extension allowlist

Card `d854889d`, 2026-10-12. Follow-up to card `1718416d`, which first reported the guard missed a
bare-LF `native/win-job-launcher/launcher.cs` sitting alone inside a brand-new untracked directory.

## The hypothesis did not survive repro

The card's own hypothesis was that `listUntrackedFiles` collapses a new untracked directory to one
`?? dir/` entry, the way `git status --porcelain` does, unless run with `-uall`/`--untracked-files=all`.
That is false for this guard: `listUntrackedFiles` never calls `git status` — it calls `git ls-files
--others --exclude-standard`, which already recurses fully into a brand-new nested directory and lists
every file inside it individually. Verified directly, both in an isolated fixture repo and against this
repo's own real tree: a 2-level-deep brand-new untracked directory with a bare-LF `.ts` file alongside
the bare-LF `.cs` file was enumerated, evaluated, and correctly flagged as a violation in the SAME run
that missed the `.cs` file. Same directory, same recursion — only the extension differed.

## The first fix was too narrow

The first commit on this card added `.cs` to a hand-kept `TEXT_EXTENSIONS` allowlist. On manager review,
that was the same *shape* of fix that let `.cs` go missing in the first place — a new extension can
always slip through a hand-kept list again. The manager asked to close the whole class.

## The allowlist itself was the defect

A full-corpus scan of this repo's real tracked tree (3827 files, no extension filter — just the guard's
existing `textAttr === "unset"` + `containsNul` exclusions) found the hand-kept allowlist was ALSO
silently missing `.txt` (130 files), `.ndjson` (14), `.svg` (5), `.py` (2), `.log` (6), `.patch`, `.rb`,
`.specimen` — and, worse, three tracked files it could **never** have matched no matter how many
extensions were added to it: `.gitignore`, `.gitattributes`, `.npmrc`.

`path.extname(".gitignore")` returns `""` — Node's documented behaviour for a basename with no dot past
its own leading one. An extension-based allowlist is structurally incapable of including a dotfile. This
is a ceiling of the mechanism, not a missing entry, and no amount of widening the set would ever close it.

## The fix

`TEXT_EXTENSIONS` is removed entirely. `listTrackedFiles` (`git ls-files -z`) and `listUntrackedFiles`
(`git ls-files --others --exclude-standard`) now return every tracked / non-ignored-untracked path, full
stop — population selection no longer depends on a filename pattern at all.

The real exclusion git itself needs — skip a path that carries no LF/CRLF policy to check — was already
implemented for an unrelated reason: `containsNul` (card `4f2c493a`) replicates git's own `text=auto`
content-sniffing heuristic, and `expectedPolicy`'s `textAttr === "unset"` check already handles an
explicit `-text` pin. Dropping the allowlist needed no new exclusion logic, only removing the filter that
stood in front of the exclusion logic already there.

Verified sound by re-running the same full-corpus scan with the filter removed: 0 violations across all
3827 tracked files, with exactly 16 tracked files (all `.png`) correctly skipped as binary-by-content and
2 skipped as having no newlines to evaluate — matching the real population exactly, not a guess.

## Do not

- Do not reintroduce a hand-kept extension/filename allowlist to gate which files this guard scans. Any
  such list can always be missing an entry — including, structurally, every dotfile — and that is the
  exact defect this card removed.
- Do not treat `containsNul` as self-certifying. Section (B) of the guard cross-validates every
  binary-skip decision against `git ls-files --eol`'s own `-text` resolution
  (`resolveTrackedGitEolStates`) so a future divergence between this guard's content-sniff replica and
  git's real one is caught, not assumed.
