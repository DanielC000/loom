# 498452c0 — count-drop sanity guard on the dead-worktree `.claude.json` prune

## Narrative (round 3 — shared write core reused by the temp-test-entries mode, card d4580e19)

Card d4580e19 added a second bulk-prune mode (`pruneDeadTempTestClaudeConfigEntries`, `pty/claude-config.ts`)
that targets a different leak — `.claude.json` entries LOOM TESTS wrote by reaching `ensureTrusted`
without redirecting `CLAUDE_CONFIG_DIR` (cards 849acf9b, 042a4312, c75006c2), keyed under `os.tmpdir()`
rather than under a worktrees root. Rather than fork a second read-lock-reread-write implementation, the
classify-and-write mechanics below (the lock, the re-verify-absent-before-write step, and this guard)
were factored out into a shared `pruneClaudeConfigEntriesCore`, parameterized only by WHICH stored keys
are candidates at all (`classifyWorktreeScopedKeys`'s `isStrictlyUnderRootForms` predicate for the
worktree mode; `isDirectLoomTempKey` — a direct child of `tmpdir` whose basename starts with `loom-` —
for the temp-test mode). Everything below this guard's own narrative (round 1/2) is unchanged in
substance for either mode; only the classification predicate differs.

## Narrative (round 2 — event-loop-stall fix on `removeClaudeConfigEntryForWorktree`)

Round 1 (below) wrongly believed `removeClaudeConfigEntryForWorktree`'s per-GC-removal cost was
negligible — its own doc comment called the per-key scan "an accepted background-GC cost, not a hot
path"; that claim is now corrected at the function itself. Code review (session d4a94e58) measured
~1.8s of frozen daemon PER worktree removal: a whole-file read+parse across a real ~9.6k-entry
`.claude.json`, plus `pathOverlapKind`'s two `realpathSync` calls PER STORED KEY (to find a case/
junction-variant match), plus a full rewrite — all inside `withTrustLock`, whose acquire wait is a
synchronous `sleepSync` of up to `trustLockMs()` (default 5s). This runs on `gcWorktreeDir`'s own call
stack, so it froze the WHOLE daemon (every spawn/resume, the web UI, all HTTP/MCP), not just this one
removal, for that long on every single worktree GC.

Three independent changes, all load-bearing on their own:
1. `setImmediate` defers the entire read+match+write off `gcWorktreeDir`'s synchronous `removed` branch.
   `removeClaudeConfigEntryForWorktree`'s own synchronous portion is now just the scheduling call.
2. The stored-key match became a plain string compare (`normForCompare(key) === target`), never
   `pathOverlapKind`/`realpathSync`: the worktree directory is already gone by the time this runs, so no
   realpath form of it can ever exist to compare against — the `realpathSync` calls were pure waste.
   `normForCompare` alone already folds win32 case the same way `pathOverlapKind` did, so a
   differently-cased stored key is still found; only the junction-alias resolution is dropped, and it
   was never reachable here (`ensureTrusted`'s own written key is always a plain `path.resolve`, never a
   realpath — see `claudeCliProjectKey`'s doc — so a stored key was never actually junction-aliased to
   begin with; that defense was dead weight borrowed from `worktreeRemovalRefusal`'s own, genuinely
   different, threat model).
3. The lock acquire became a single non-blocking attempt (`tryTrustLockOnce`), never `withTrustLock`'s
   retry+`sleepSync` loop. Busy ⇒ skip entirely, no write: recovery is the owner-run bulk prune
   (`pruneDeadWorktreeClaudeConfigEntries`) — a later GC removal only ever matches its own worktree's
   path, never a previously-skipped one (card f761fdf3 item 2: the skip used to be silent and the old
   comment's "caught by a later GC" framing was false; the skip is now logged via `console.warn`). This
   is a best-effort background cleanup, not a correctness-critical write.

Also fixed in round 2 (review item 2): `fs.existsSync` collapses every stat error — ENOENT, EACCES, a
non-existent drive root, a transient Windows glitch — to the same `false`, indistinguishable from a
genuine absence. A non-existent drive root repro'd this classifying EVERY key as dead. Replaced with a
tri-state `classifyPathLiveness` (`dead` only for ENOENT/ENOTDIR; everything else is `alive` or
`unknown`, and a caller must treat `unknown` exactly like `alive` — never delete on an unconfirmed
absence) everywhere a key's existence gates a deletion: the GC path's respawn re-check, the bulk prune's
classification, and the bulk prune's in-lock re-verify.

## Narrative (round 1 — count-drop guard, superseded in part by round 2)

`pruneDeadWorktreeClaudeConfigEntries` (`packages/daemon/src/pty/claude-config.ts`) classifies dead
worktree-scoped keys OUTSIDE the cross-process trust lock (`withTrustLock`), then re-reads the file fresh
INSIDE the lock before actually deleting anything — the same read-modify-write shape `ensureTrusted`
itself already uses for every other write to this file. Re-reading fresh inside a lock every Loom writer
honors already closes the ordinary read-then-write race more strongly than a separate mtime/size/content
snapshot compare would: there is no read-then-later-write gap to detect, because the mutation and the read
happen inside one held critical section.

That lock has two documented residuals this guard exists to catch, not to replace: (1) an external,
Loom-unaware `claude` CLI process writing `.claude.json` without ever taking Loom's lock at all (`ensureTrusted`'s
own doc already accepts this as unsolvable — "we can't lock an uncooperative external writer"), and (2)
`withTrustLock`'s own documented best-effort "proceed unlocked" degrade once its bounded acquire budget is
exhausted. In either case, a concurrent unlocked writer could shrink `projects` between the classification
read and the fresh in-lock read by more than this call itself intends to remove — e.g. a truncated or
otherwise clobbered file.

The guard (card f761fdf3 item 5: corrected to agree with the "Do not" bullet below): inside the lock, after
the fresh re-read, check each key the classification read saw. A key missing from the fresh read is
explained ONLY if THIS run itself classified it dead (it may have been pruned by a concurrent writer for
the same reason this call would have removed it); any OTHER missing key (alive, or never classified) aborts
the run with NO write, reporting `aborted:"count-drop"` — rather than writing back a file that may already
be missing content this call never touched. A concurrent ADD (a key present in the fresh read but not in
the classification read) is never examined by this check and always passes.

This was a manager-directed addition during 498452c0's design-checkpoint review, chosen specifically as a
cheap integrity check in place of a full mtime+size (or content-hash) snapshot-compare-and-abort, given that
the lock + fresh re-read already covers the ordinary race.

## Do not

- Do not replace this with a full mtime/size/content snapshot-compare — the lock + fresh re-read already
  covers the ordinary race more strongly; this guard is scoped to the narrower residual (an external,
  Loom-unaware writer, or the lock's own best-effort-unlocked degrade), not a general TOCTOU fix.
- ⛔ SUPERSEDED (review item 4, was wrong): a prior version of this bullet said to subtract this call's
  own planned removal count from the raw-count drop before comparing. That is backwards — both counts
  are taken BEFORE this call's own deletions ever happen, so the two are expected to be EQUAL on an
  ordinary run (zero expected drop), not to differ by `removed.length`. The old arithmetic tolerated up
  to `removed.length` unexplained missing entries, which on a large dead-count run (repro: ~4.6k) masked
  real external data loss entirely. The correct rule: a key missing from the fresh read is explained ONLY
  if it was itself classified dead by this run (it may have been pruned by a concurrent writer for the
  same reason this call would have removed it) — any OTHER key (alive, or never classified) missing from
  the fresh read aborts the run. A concurrent ADD (a key present in fresh but not in the classification
  read) is never examined by this check and always passes.
- Do not silently swallow a tripped guard — it must abort with no write and surface
  `aborted:"count-drop"` to the caller, the same way a `parseError` does.
- Do not acquire the real write's lock in `withTrustLock`'s ordinary best-effort mode — a bulk DELETE of
  many entries must never proceed unlocked (review item 3): the real write passes `requireLock:true` and
  aborts with `aborted:"lock-unavailable"`, no write, when the acquire loop gives up without ever holding
  the lock. Card f761fdf3 item 4 (wording only): this is most commonly a transient FS error
  (EPERM/EACCES/EBUSY) exhausting its own retry budget, or a non-EEXIST open error — NOT simply "another
  process is holding the lock". A lock that's merely held and looks STALE (older than `trustLockMs()`) is
  broken and retried instead of causing this abort (card 5b97da80 owns that stale-break/acquire-deadline
  behavior; nothing about it changes here).
- Do not classify a key as worktree-scoped using `pathOverlapKind`'s bidirectional "nested" (review item
  6): that also matches when `worktreesRoot` is strictly under `key` (the root is a DESCENDANT of the
  stored key — an ancestor-of-the-root key), which must never be treated as a worktree-scoped candidate.
  Classification is one-directional: `key` strictly under `worktreesRoot`, never the root itself, and
  never an ancestor of it. A non-absolute (or empty-string) key is skipped outright, never classified.
- Do not run the bulk prune's real write against a `worktreesRoot` that doesn't stat as an existing
  directory (review item 2) — the call refuses up front with `aborted:"worktrees-root-missing"`, since a
  wrong/typo'd root could otherwise silently classify nothing (or everything, via a stat-error
  misclassification) with no signal that the root itself was the problem.

## Source

Introduced in `packages/daemon/src/pty/claude-config.ts`'s `pruneDeadWorktreeClaudeConfigEntries`, card
`498452c0` ("chore(pty): prune ~/.claude.json project entries for deleted Loom worktrees"), design-checkpoint
review answer 2.
