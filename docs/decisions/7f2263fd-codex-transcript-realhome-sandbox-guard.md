# 7f2263fd — codex transcript/rollout-archive fixture writers get their own CODEX_HOME sandbox guard

## Narrative

Card 668bc52c's `transcript-realhome-sandbox-guard.mjs` is scoped to claude's `~/.claude/projects` and
deliberately excludes codex-bound calls — a codex fixture written without `CODEX_HOME` set lands in the
owner's REAL `~/.codex` (`realCodexHome()` resolves `process.env.CODEX_HOME || os.homedir()/.codex`).
This card closes that gap with a sibling guard, sharing AST machinery via a new
`_realhome-sandbox-ast.mjs` helper module rather than duplicating it.

**Conservative rule despite fresh-per-call reads.** `codexSessionsRoot()`/`codexRolloutArchiveRoot()`
read `CODEX_HOME`/`LOOM_HOME` fresh on every call, never cached at module load — so the real contract is
"sandbox before the first CALL," not "before import." This guard enforces the stricter "before the
first dynamic dist import" rule anyway, same ground the claude guard already uses for its own
(also fresh-per-call) `claudeProjectsRoot()`: a simple line-order check that stays correct even if a
future change adds import-time side effects.

**Two real bugs found only against the real corpus, not synthetic fixtures.** (1)
`resolveTranscriptFile`/`readTranscript`/`snapshotTranscript` collide between codex-transcript.ts's
direct export (no harness param) and `sessions/transcript.ts`'s dispatcher (same args + an optional
trailing `harness`, routed through `transcriptOpsFor`). The harness param sits at a DIFFERENT index per
function (3rd for resolve/read, 5th for snapshot) — disambiguated by the LAST argument + a per-function
min-argc map, never a hardcoded index. (2) `transcriptExists` has no dispatcher entry (that name there is
`engineTranscriptExists`) but IS a `HarnessAdapter` interface method implemented identically (always 2
args, no harness to read) by `claudeAdapter.transcriptExists` — arg-count can't disambiguate it, only the
resolved import SOURCE can. This false-positived on `harness-adapter-conformance.mjs`/
`harness-adapter-delegates.mjs`, both calling `claudeAdapter.transcriptExists(cwd, id)`.

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

**The disclosed `PtyHost.spawn` blind spot, concretely.** `codex-giveup-screen-tail.mjs` reaches
`findConversationIdForSpawn`/`snapshotExistingConversationIdsForSpawn` only via
`host.spawn({harness:"codex"})`'s internal `captureCodexEngineSessionId` call, never importing
`codex-transcript.js` itself — invisible to this guard's name-based detection. It already sandboxes
`CODEX_HOME` correctly before that call (not currently exploitable), but this guard would not have
caught it otherwise. Card `7664f6b3` tracks auditing every such call site (85 files spawn with
`harness:"codex"` corpus-wide; only this one was spot-checked here) and extending detection if warranted.

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
- Do not read this guard as covering indirect reach via `PtyHost.spawn({harness:"codex"})`'s own
  `captureCodexEngineSessionId` call without a direct `codex-transcript.js` import — a disclosed,
  deliberate scope limitation (mirrors the claude guard's identical one for `harness:"claude"`), tracked
  by card `7664f6b3` rather than silently widened here.
