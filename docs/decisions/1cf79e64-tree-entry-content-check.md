# 1cf79e64 — compare stamped tree entries instead of a pathspec diff in attribution

## Narrative

Follow-up to `c7dc99bf` (its Finding 4/4b, measured by CR6 reviewer `3d645f0d`). `recordedTipContentLanded`'s
own-files check used to run `git diff --name-only candidateSha recordedTip -- ...files` — a pathspec-based
diff restricted to the review-time stamped `filesChangedPaths`. On Windows, git treats a literal backslash
in a pathspec argument as a path separator, and no flag/magic/env var avoids it (`--literal-pathspecs`,
`:(literal)`, and `MSYS_NO_PATHCONV` were all checked and found not to help). A backslash-named stamped
path therefore never matches itself in the pathspec, on either side of the diff — the diff reads vacuously
empty for that path regardless of what the candidate actually contains.

Two measured consequences:

- **F4**: a candidate that genuinely OMITS a real backslash-named file (stamped in `filesChangedPaths`,
  present in `reviewedTip`'s own tree, absent from the candidate) was wrongly read as `"attributed"`.
  `stampedPathsPlausible`'s own net cannot rescue this — a stamped path that is genuinely present in
  `reviewedTip`'s own tree can never fail that net's OR-check, by design (it only rejects a path that was
  NEVER real at either reference point, not one a candidate merely omits).
- **F4b** (wider): when EVERY stamped path is backslash-shaped, the diff is vacuously empty against ANY
  candidate, including one with no shared history or content at all — the first eligible candidate for the
  worker's branch name (possibly a prior generation's own, unrelated landing) would be wrongly attributed.

Both reproduced directly on this worktree's HEAD (`a8685a71`) via a real-git fixture built through git
plumbing (`hash-object`/`update-index`/`write-tree`/`commit-tree` — a literal backslash cannot be created
through the real filesystem on Windows), mirroring the existing "backslash net" test's own technique. A
positive control — the identical omission shape with a normal filename — correctly escalated, confirming
the failure is specific to the backslash pathspec defeat, not a broken test.

## The fix

`recordedTipContentLanded` no longer uses a pathspec-based `git diff` at all. It now compares the stamped
paths' own TREE ENTRIES (mode + object type + blob/commit sha) between `recordedTip` and the candidate,
read via a new shared helper, `fullTreeEntries` (`git/worktrees.ts`): ONE `git ls-tree -r -z <ref>` call
with NO path argument, parsed into `Map<path, "<mode> <type> <sha>">`. Comparison is `recordedMap.get(p)
!== candidateMap.get(p)` for every stamped path `p` — exact string equality, with no pathspec anywhere in
the call, so no hazardous name (backslash, bracket/brace glob-magic, non-ASCII, a leading `-`, a space) can
ever be reinterpreted as pathspec syntax.

This one comparison handles every shape the old design needed separate reasoning for, with no special
casing:
- **Deletions**: a path absent on both sides (`undefined === undefined`) is a match — a deletion that
  landed correctly. A path present on one side only is a mismatch.
- **Mode changes**: the mode token is part of the compared string, so a mode-only change (e.g. an
  executable-bit flip) is a mismatch — at least as strict as the old pathspec diff, which also flagged a
  mode-only change in `--name-only` output.
- **Submodule/gitlink entries**: `ls-tree` reports mode `160000` and the submodule's own commit sha for a
  gitlink entry, so a changed submodule pointer is compared exactly like any other content change, with no
  extra logic.
- **Renames**: `machineReadablePathSet`'s existing rename-awareness already stamps BOTH the old and new
  path as separate entries; each is checked independently by the same comparison (old path expected absent
  on both sides, new path expected present and identical).

`fullTreeEntries` fails closed to `null` on any read failure or a malformed record (no tab separator) —
the whole map is untrustworthy then, never a partial one that looks complete (same convention as
`parseNameStatusZ`). `recordedTipContentLanded` and `stampedPathsPlausible` both take an optional
`recordedTipEntries` param so a caller looping over several candidates for the SAME `recordedTip` reads
that tree ONCE and shares it, instead of each function re-reading it per candidate. `recordedTip`'s own
tree never changes across the candidate loop in `attributeStaleGenerationOwnLanding`
(`sessions/service.ts`), so that caller now hoists one `fullTreeEntries` call before the loop and threads
the result into every `recordedTipContentLanded`/`stampedPathsPlausible` call in both trailer arms. A
failed hoisted read short-circuits the whole attribution attempt to `{kind:"no-match"}` immediately,
using the existing error kind — no new kind was introduced (the transient-vs-definitive split for this
path is card `05915fc7`'s own scope, not this one's).

`stampedPathsPlausible` itself is otherwise unchanged in behavior — it still separately reads a
merge-base tree (candidate-dependent, so it cannot be hoisted), and it remains necessary: a stamped path
that was NEVER real at either `recordedTip` or the merge-base (a genuinely forged/bogus entry) still
vacuously "matches" under the new tree-comparison design for the identical structural reason the old
pathspec diff was vacuous for it — both sides' maps simply lack the key. This is a DIFFERENT exploit shape
from F4/F4b (which depended on git's pathspec backslash handling specifically) and is unrelated to this
card's fix; `stampedPathsPlausible` remains the dedicated net for it.

`--literal-pathspecs` is dropped entirely from `recordedTipContentLanded`'s own call — there is no
pathspec left for it to act on. `files.length === 0` now fails closed to `"no-match"`, never a vacuous
`"attributed"` — an empty stamp proves nothing about any candidate, and treating it as a match is the same
vacuous-match shape F4b exploited at the whole-stamp level. The sole production caller already returns
`"zero-delta"` before ever reaching this function on a genuinely empty stamp, so this is a structural
floor for any other caller, not a reachable production path today.

## Bracket-precision coverage, repurposed

`c7dc99bf`'s own "(bracket precision)" direct-unit test proved `--literal-pathspecs` measurably flips a
real bracket-named case through `recordedTipContentLanded`'s exact spawn path. That flag — and the
pathspec it guarded — no longer exist in this function, so the test is repurposed rather than deleted: it
now proves the new tree-entry comparison correctly attributes a genuine bracket-named landing sitting next
to an unrelated, independently-drifting coincidentally-matching file, via plain Map-key equality with no
flag needed at all (brackets are never interpreted as glob magic by `ls-tree` with no path argument).

## Path-key exactness

Every map key is the raw `-z`-delimited path string exactly as git emits it (UTF-8 bytes), with NO
normalization applied — no backslash↔slash conversion, no case folding, no Unicode NFC/NFD. A case-variant
pair (`A.txt` vs `a.txt`) is two distinct keys, matching git's own case-sensitive tree storage regardless
of the host filesystem's own case-folding behavior (relevant on Windows/macOS, where the working directory
itself is typically case-insensitive but the git object store is not).

## Tests

`stale-generation-landedtip-content-check.mjs`: new real-git, plumbing-built F4 (a genuine omission of a
real backslash-named file now escalates) and F4b (an all-backslash stamp against a wholly unrelated
candidate now escalates) scenarios; a non-ASCII filename tree-entry comparison; a case-variant pair
(`A.txt`/`a.txt`, built via plumbing so the host filesystem's own case-folding can't interfere) proving
both are compared as distinct keys; an explicit `files.length === 0` assertion (fails closed, never
vacuously attributed); the repurposed bracket-precision scenario; every pre-existing scenario in the file
(FORGED/GENUINE/OVERLAP/FB_LANDEDTIP/FB_NOLANDEDTIP/ZERODELTA/REFMOVE/SCOPED_REVIEW_GENUINE/RENAME_PARTIAL/
LEGACY/REVERT/LAG/SPECIAL_NAME_*/backslash-net) re-run green against the new implementation. Negative
control: the pre-fix implementation (pinned to `a8685a71`, this worktree's HEAD before this card) shows
F4/F4b RED; the post-fix implementation shows both GREEN.

## Do not

- Do not reintroduce a pathspec-based `git diff` into `recordedTipContentLanded`'s own content check — a
  literal backslash in a stamped path defeats ANY pathspec (no flag, magic, or env var avoids it) and
  silently reads as a vacuous content match for a candidate that genuinely omits that file, or even an
  unrelated candidate entirely when the whole stamp happens to be backslash-shaped.
- Do not apply any normalization (case folding, Unicode NFC/NFD, backslash↔slash) to a tree-entry map key
  — compare the raw `-z`-delimited path strings exactly as git emits them, or a case-variant or
  differently-normalized pair of real, distinct paths can be silently conflated.
- Do not let `recordedTipContentLanded` return `"attributed"` for an empty `files` list — fails closed to
  `"no-match"` instead; a vacuous match on zero paths proves nothing about any candidate.
- Do not read `stampedPathsPlausible`'s continued necessity as redundant with this fix — it closes a
  DIFFERENT exploit shape (a stamped path that was never real anywhere, not merely backslash-defeated) that
  this card's tree-entry redesign does not and cannot close on its own.
- Do not re-read `recordedTip`'s own tree once per candidate when looping over several candidates for the
  same attribution attempt — it is loop-invariant; read it once via `fullTreeEntries` and pass the result
  as the optional `recordedTipEntries` param to both `recordedTipContentLanded` and `stampedPathsPlausible`.
