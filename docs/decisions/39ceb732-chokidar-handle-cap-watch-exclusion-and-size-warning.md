# 39ceb732 — chokidar's one-OS-handle-per-entry cap: watch exclusion + a size warning

## Narrative

Chokidar opens one OS file handle per watched entry, with no cap — a real, uncapped resource cost that scales with vault size on a local-first desktop product. This card is the origin of two mitigations in `vault/versioner.ts`:

1. **Watch exclusion for a repo's own gitignored top-level entries** (`gitignoredTopLevelNames`/`safeToExcludeNames`) — a bare, non-root-anchored top-level `.gitignore` name is a CANDIDATE to stop watching, but not automatically safe: `.gitignore` has no effect on an already-tracked path (confirmed live: committing a file, then adding its directory to `.gitignore`, then editing it — `git add .` still stages the edit, and `git check-ignore` reports the tracked file as NOT ignored), so a name straight out of the parser is not provably safe to exclude on its own. `safeToExcludeNames` only excludes a candidate git does NOT already track (see [[687d2a47-gitignore-parser-and-tracked-check-over-generation-fixes]] for the parser/tracked-check findings that followed from getting this right). Deliberately narrow, not full gitignore semantics: no negation (`!`), no glob syntax, no nested paths, no root-anchored entries, no leading/trailing whitespace handling beyond what git itself treats as significant, no backslash-escape interpretation. A pattern the parser doesn't understand is simply left alone (kept watched) — this can only under-generate (fewer handles reclaimed), never mis-translate into excluding something that would have been committed.

2. **Lever 4 — "do nothing to the mechanism; add a startup size warning"** (`VaultVersioner.warnIfLarge`): rather than changing what gets watched or committed, this logs ONCE when the initial scan completes if the watcher ended up tracking an unusually large number of entries (`LARGE_VAULT_WATCH_WARN_THRESHOLD`, 20,000), making the resource cost visible instead of silent until someone reads a crashlog.

   `warnIfLarge` also warns on the DISCRIMINATING form of a zero-entry watcher, not a naive one — a naive `count === 0 ⇒ warn` false-positives on a legitimately brand-new, empty vault (no notes yet). It only warns when the count is zero AND `commitPath` actually has top-level content the matcher does NOT exclude (i.e. content that should have produced at least one watched entry) — see `hasUnexcludedTopLevelEntry`. This zero-entry case is the signature of the dead-watcher failure class (a chokidar `ignored` matcher accidentally matching the watch root itself, structurally prevented by `buildIgnoredMatcher` testing paths relative to `commitPath`) — but this tripwire has its own blind spot, see [[687d2a47-gitignore-parser-and-tracked-check-over-generation-fixes]] finding 4.

## Do not

- Do not widen `gitignoredTopLevelNames` to full gitignore semantics (negation, globs, nested paths) — the "unknown → leave watched" fail-safe depends on staying deliberately narrow; a pattern the parser can't confidently interpret must be left alone, not guessed at.
- Do not read `warnIfLarge`'s silence on a zero-entry watcher as proof of health — see the 687d2a47 finding-4 blind spot.
