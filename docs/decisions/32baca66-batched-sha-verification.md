# 32baca66 — batch sha verification with `git cat-file --batch-check`, never one child per id

## Do not

- Do not revert to one `execFileSync`/`spawn` git child per sha id. The original `verifyCommitSha`
  spawned a fresh, blocking subprocess per unique sha-anchored id; on this repo (80 unique ids, ~48ms
  each) that alone cost ~3.8s of the 9.3–11.6s the no-query `decisions_for` scan froze the whole
  single-threaded daemon for (every project, every session, the web UI — see project memory
  `decisionsfor-no-query-blocks-event-loop-seconds`). One batched call replaces all of them.
- Do not key `git cat-file --batch-check` output off its first whitespace-separated field to recover the
  queried id. Verified empirically (a real repo, a real commit, a real blob, a nonexistent sha) against
  `--batch-check='%(objectname) %(objecttype)'`:
  - A **resolved** commit prints `<resolved-full-sha> commit` — the first field is the object git
    actually resolved to, which can differ from the queried short id entirely.
  - An **unresolvable** id (missing, or a non-commit object that fails the `^{commit}` peel) prints
    `<expr> missing` where `<expr>` is the literal input (`<id>^{commit}`) echoed back verbatim.
  So the two cases are NOT symmetric: matching the first field works for the failure case and silently
  breaks for the success case (every real id would misreport as unverified). The fix feeds `%(rest)`
  instead — each stdin line is written as `<id>^{commit} <id>`, so `%(rest)` (everything after the first
  whitespace on the INPUT line) echoes the literal queried id back on every success line too, giving one
  reliable correlation key for both outcomes.
- Do not treat only `missing` as a failure. `cat-file --batch-check` also prints `<expr> ambiguous` for
  an 8-hex prefix that resolves to more than one object — this must read as unverified exactly like
  `missing` does, mirroring `rev-parse --verify --quiet <sha>^{commit}` (which fails on both an
  unresolvable AND an ambiguous rev).
- Do not let a spawn failure, a non-zero/early exit, or the overall timeout firing resolve to "verified."
  The result `Map` is pre-seeded `false` for every requested id and is only ever flipped to `true` by a
  genuinely parsed `commit`-typed success line — refuse-rather-than-fall-through, matching every other
  resolution path in this file (`resolveRecordMeta`'s own catch-as-unverified posture).
- Do not leave the batch subprocess unbounded. The timeout handler calls `child.kill()` before settling,
  so a hung `git cat-file` can't wedge the caller or linger as an orphan.

## Why this shape

`verifyCommitShas(repoRoot, ids)` spawns exactly ONE `git cat-file --batch-check` child regardless of how
many ids are requested, writes every id as a `<id>^{commit} <id>\n` stdin line, and parses each output
line by whether it ends in ` missing`/` ambiguous` (failure — recover the id from the echoed `<id>^{commit}`
expression) or not (success — the id is the last whitespace-separated field, via `%(rest)`; verified
`commit` iff the object type field says so).

`decisionsForAll`'s no-query path collects every sha-namespaced anchor id whose bare id already has a
matching record, then calls this ONCE for the whole batch — replacing the old per-id loop through a
`shaVerifyCache` Map that still spawned one subprocess per unique miss. `resolveRecordMeta` (the
path/id/symbol-mode caller) calls the same function with a single-element array; the batching machinery
is unconditional, not a separate code path for N=1.

## Source

`packages/daemon/src/mcp/decisions.ts` — `verifyCommitShas` (replaces the old `verifyCommitSha`), card
`32baca66` ("perf(mcp): stop decisions_for's no-query scan from blocking the daemon event loop").
