# cad5d5d6 — `assertionFailed` stays the primary `failureDetail` classification even when a file also throws

## Narrative

`classifyFailureDetail` (the classifier behind card `237aa3a9`'s `failureDetail` field, part of the SAME
commit `cad5d5d6` that shipped that feature) sorts one failing
run's captured stdout/stderr into four honest buckets — `timeout`, `assertionFailed`, `testThrew`,
`unclassified` — deliberately four rather than twelve: an explicit `unclassified` beats a wrong label, and
each bucket is pure + exported so a test can drive it directly against synthetic or real-captured output,
with no child spawn needed for the classification logic itself.

`assertionFailed` pulls every this project's own `check(label, cond)` helper's "FAIL  <label>" line from
stdout, independent of how many a single file makes — naming EVERY distinct failing assertion in one read
of the row (`237aa3a9`'s own DoD-5 requirement for a multi-failure run).

**The CR follow-up this record is about:** a file can ALSO throw uncaught *after* one or more `check()` calls
have already failed — a real, plausible shape (code that assumes a check passed and dereferences something
that isn't there once it didn't) — and precisely the kind of stray-stderr signal the peer's own
`testThrew` insight (see `237aa3a9`'s record) was originally about. The named assertions stay the PRIMARY
signal: `failureType` stays `"assertionFailed"` rather than switching to `"testThrew"` or a new bucket — a
concrete, already-known-false check is more actionable than an incidental downstream throw, and a fifth
bucket for this overlap is explicitly rejected. The stderr is no longer silently dropped, though: a small,
bounded `stderrExcerpt` attaches alongside `messages` whenever BOTH FAIL lines and stderr are present —
present only in that mixed case, absent (not an empty array) otherwise.

## Do not

- Do not reclassify a run as `testThrew` (or add a fifth bucket) just because stderr is also present
  alongside FAIL lines — `assertionFailed` stays primary.
- Do not drop the stderr in the mixed case — attach it as `stderrExcerpt`, present only when both FAIL
  lines and stderr exist (never an empty array as a stand-in for absence).

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, immediately preceding `classifyFailureDetail`
(originally lines 1106-1132), as of this tranche's HEAD. Source: commit `cad5d5d6`, no board card — the
commit's own message reads "record the failing file's own output in gate-timing NDJSON rows"; the file's
"manager review of cad5d5d6" phrasing (never "card cad5d5d6") is CR feedback folded into that same commit
before it landed, not a separate card. Verified: `git cat-file -t cad5d5d6` → `commit`. Parent decision:
card `237aa3a9` (the `failureDetail` field design this classifier feeds — separate record, same commit).
