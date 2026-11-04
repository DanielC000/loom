# 7f2263fd — codex transcript/rollout-archive fixture writers get their own CODEX_HOME sandbox guard

## Narrative

Card 668bc52c's `transcript-realhome-sandbox-guard.mjs` is scoped to claude's `~/.claude/projects` and
deliberately excludes codex-bound calls — a codex fixture written without `CODEX_HOME` set lands in the
owner's REAL `~/.codex` (`realCodexHome()` resolves `process.env.CODEX_HOME || os.homedir()/.codex`).
This card closes that gap with a sibling guard, sharing AST machinery via a new
`_realhome-sandbox-ast.mjs` helper module rather than duplicating it.

**Conservative rule despite fresh-per-call reads.** `codexSessionsRoot()`/`codexRolloutArchiveRoot()`
read `CODEX_HOME`/`LOOM_HOME` fresh on every call, never cached at module load — the real contract is
"sandbox before the first CALL," not "before import." This guard enforces the stricter "before the first
dynamic dist import" rule anyway, same ground the claude guard uses for its own `claudeProjectsRoot()`.

**Two real bugs found only against the real corpus, not synthetic fixtures.** (1)
`resolveTranscriptFile`/`readTranscript`/`snapshotTranscript` collide between codex-transcript.ts's
direct export (no harness param) and `sessions/transcript.ts`'s dispatcher (same args + an optional
trailing `harness`). The harness param sits at a DIFFERENT index per function (3rd for resolve/read, 5th
for snapshot) — disambiguated by the LAST argument + a per-function min-argc map, never a fixed index.
(2) `transcriptExists` has no dispatcher entry but IS a `HarnessAdapter` interface method implemented
identically (2 args, no harness) by `claudeAdapter.transcriptExists` — arg-count can't disambiguate it,
only the resolved import SOURCE can. False-positived on `harness-adapter-conformance.mjs`/
`harness-adapter-delegates.mjs`.

**`_transcript-fixture.mjs` exclusion.** Claude's marker-A fixture helper statically imports
`dist/sessions/transcript.js` — irrelevant to CODEX_HOME, but it trips the "local helper that itself
imports dist is a transitive hazard" check. `findTransitiveStaticDistImport` gained an
`excludeSpecSuffixes` param so both guards can list their own known-safe helpers; without passing
`["_transcript-fixture.mjs"]` here, `transcript-harness-dispatch.mjs` (genuinely, correctly sandboxed)
was misclassified unsafe.

**A third real-spawn file found only by the guard.** `codex-doctrine-real-spawn.mjs` reaches codex's
path indirectly via `sessions/transcript.ts`'s dispatch (`readTranscript(cwd, id, "codex")`), never a
direct `codex-transcript.js` import — the card's initial manual grep for direct importers missed it.
Allowlisted alongside `codex-transcript-real-spawn.mjs`/`codex-rollout-archive-restore-real-spawn.mjs`:
all three genuinely need the real `~/.codex` for auth (a per-worker override is empirically broken).

**Why a sibling guard, not an extension.** Different env var, different hit set, opposite-polarity
name-collision exclusions, and no codex equivalent of marker-A exists — folding codex's rules into the
claude guard's `classify()`/allowlist would couple two independently-evolving fn-name sets behind one
function. Only the generic AST plumbing is shared.

**The disclosed `PtyHost.spawn` blind spot.** `codex-giveup-screen-tail.mjs` reached
`findConversationIdForSpawn` only via `host.spawn({harness:"codex"})`'s own internal call, invisible to
this guard's name-based detection. Card `7664f6b3` sandboxed the 16 files that needed it; card `21174cef`
(below) closes the detection gap itself.

## Card 21174cef — a SEPARATE hit set for `.spawn(`/`host.spawn(` call sites

`classifySpawnHits` (not `classify`) flags any such call carrying a literal `harness: "codex"` (fails
closed on a non-literal), excluding direct `createCodexPty`-only calls and the `*-real-spawn.mjs` family
(via `CODEX_REAL_SPAWN_SET`, the single source of truth — never a second hand-copied list). Ordering is
EXECUTION order, not line order: `effectiveSpawnLine` walks a call wrapped in a named helper out to that
helper's own call site(s) (recursively) — a function only runs when CALLED, never at its definition line
(`codex-engine-id-giveup-diagnostic.mjs`'s `giveUp` is the worked example). The real-corpus scan surfaced
3 files that looked unsandboxed by `CODEX_HOME` alone but sandbox `HOME`+`USERPROFILE` instead (a
pre-existing pattern for an unrelated reason) — equivalent, since `os.homedir()` reads a different one of
those two per platform; `findHomeAndUserprofileOverrideLine` now accepts that pair too.

## Do not

- Do not widen this guard to a text/regex scan — a regex can't distinguish a real
  `process.env.CODEX_HOME =` assignment from the same text in a comment/string/`==` comparison.
- Do not disambiguate `resolveTranscriptFile`/`readTranscript`/`snapshotTranscript` by a fixed argument
  index — `snapshotTranscript`'s harness param sits at index 4, not 2; check the LAST argument and a
  per-function min-argc instead.
- Do not treat `archiveOldCodexRollouts`/`restoreArchivedCodexRollout`'s injectable
  `deps.sessionsRoot`/`deps.archiveRoot` seam as an exemption from needing `CODEX_HOME` sandboxed — every
  real caller in this corpus sandboxes it regardless of whether a given call passes deps.
- Do not add a new real-codex-spawn test to `NON_SANDBOXED_ALLOWLIST` without checking whether it reaches
  codex via a direct import OR via `sessions/transcript.ts`'s dispatch — both shapes are real here.
- (Card `21174cef` closes this) Do not resolve a `.spawn(` call wrapped in a named helper by its own
  textual line — a function only runs when something CALLS it; walk out to the call site(s) instead
  (recursively), never the definition line. Do not treat `HOME`/`USERPROFILE` set ALONE as equivalent
  to a `CODEX_HOME` override — `os.homedir()` reads a DIFFERENT var per platform, so BOTH are required.
