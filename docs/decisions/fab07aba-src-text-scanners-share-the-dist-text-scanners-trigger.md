# fab07aba — real `src/**` text-scanning tests share the `dist/**` scanners' trigger; one widened list, not a third one

## Narrative

Card `abaaf16e` closed the hazard for runtime tests that raw-scan compiled `dist/**` TEXT: a comment-only
diff can flip one even though `computeEmitCompareGate`'s transpile-comparison correctly proves the diff
behaviorally inert. Code Review on that same card found the identical hazard one directory over: a runtime
test that raw-scans the real, PRE-compile `packages/daemon/src/**/*.ts` TEXT a changed file's diff can touch
directly has the exact same failure shape — no `removeComments` anywhere in this repo's own tsconfig chain
means neither the real `dist/**` emit nor the `src/**` file on disk ever has comments stripped, so a
comment-only diff can introduce or remove matching text in either place.

## The sweep, and why a single grep can't replace it (again)

The reviewer's own starting point — `readFileSync` + `".."`,`"src"` or `../src/` on a non-comment line —
found 18 files, 4 already `STATIC_GUARD_REPO_PATHS` members. Re-running it for this card (populations drift,
per the reviewer's own caveat) and widening the pattern to catch every path-construction shape actually in
use (a literal `"src"` argument anywhere, not just immediately after `".."`) surfaced **43** `readFileSync`
files referencing `src` at all. Hand-reading every one against the same "raw, unstripped, comment-flippable"
criterion `abaaf16e`'s own doc states landed on **16** genuine `src/**` members — none of them a `STATIC_GUARD_REPO_PATHS`
member (those already run unconditionally regardless of diff shape, so folding them in again here would be
redundant). A 17th candidate — `anchor-re-parity.mjs` — was caught at Code Review (reviewer `96bb7127`) and
removed: its `ANCHOR_RE_DECL_RE` is `/^const ANCHOR_RE = (.+);\s*$/m`, `^`/`m`-ANCHORED to a line starting
with the bare keyword `const` — no comment in this codebase's `//`/`/** ` convention ever begins a line that
way, so a comment can neither introduce a false match nor reposition which line resolves as the real one.
Immune for the same reason shape (1) is, just via a different mechanism (a line-anchor, not a bounded
template-literal body) — see the array's own doc comment for the corrected reasoning.

**What the sweep wrongly included on the first pass, confirmed false by reading each file's own fixture
setup (the same "synthetic fixture ≠ real content" trap `ASSET_READING_TEST_REPO_PATHS`'s own doc already
names for `assets/**`):** `crashlog.mjs` and `batch-merge-gate-history.mjs`/`codescape-health-probe.mjs`/
`codex-transcript-real-spawn.mjs` (a `src`-shaped path mentioned only inside a COMMENT, never actually
read), `negative-control-runner.mjs`/`comment-anchor-lint.mjs`/`comment-anchor-lint-hook.mjs`/
`emit-compare-gate-scope.mjs`/`merge-diff-filter-spill.mjs`/`merge-gate-inert-diff.mjs` (each builds its own
SYNTHETIC fixture directory merely named `src`, never reads this repo's own real source), `user-audit-surface.mjs`
(calls `repo_read_file`/`repo_glob`/`repo_grep` against a synthetic throwaway PROJECT repo it creates itself,
path `src/widget.ts` and friends), and `worker-prompt.mjs` (the string `"src/a.ts"` is fixture CONTENT for a
composed message, never a real file read).

**What it wrongly EXCLUDED on a narrower pass:** `skill-edit.mjs` (a real read of `mcp/skillTools.ts`, missed
on a first head-limited check of its own `readFileSync` call sites) and `gate-runner-harness-marker-coupling.mjs`
(a real read of `scripts/test-daemon.mjs` — see the deferred-gap section below).

## Membership criterion — unchanged, just widened in scope

The membership criterion `DIST_TEXT_SCANNER_REPO_PATHS`'s own doc states (a RAW, UNSTRIPPED whole-file-or-large-region
text scan where a comment anywhere in the scanned region can change what the scan matches) did not need to
change — only the POPULATION it's checked against widened from "compiled `dist/**` output" to "compiled
`dist/**` output and/or real `src/**` `.ts` source." The same four excluded shapes `abaaf16e` documented
(bounded DATA extraction, TS-compiler AST-narrowed extraction, explicit comment-stripped scan,
presence-only-of-a-real-token) apply unchanged to `src/**` readers too — confirmed against two NEW
specimens this sweep found: `boot-listen-not-blocked.mjs` and `gate-verdict-field-classification-exhaustive.mjs`
both call `ts.createSourceFile` and walk the real parsed AST (shape 2), so neither belongs on this list
despite reading real `src/**` text.

**Two genuinely NEW exclusion shapes, not present in the `dist/**`-only population `abaaf16e` swept:**

- **Byte-level, non-textual properties** (`no-nul-in-tracked-ts.mjs`): scans every tracked `.ts` file for
  embedded NUL bytes. An ordinary comment edit can never introduce or remove a NUL byte, so this is immune
  by the KIND of property it checks, not by where it looks or how it's bounded.
- **A precondition already re-verified LIVE by `computeEmitCompareGate` itself** (`emit-compare-soundness-guard.mjs`
  (A)): it walks `packages/daemon/src/**` for a `const enum` declaration, but `emitCompareSoundnessOk` — the
  SAME file, called fail-closed inside `computeEmitCompareGate` whenever a compiled `.ts` changed — already
  runs the identical walk+regex against the worktree's own current tree before ever returning
  `eligible:true`. A comment-only diff that would flip this test's own (A) check would already flip that
  LIVE precondition to `notReducible`, forcing the full gate — so this test's own correctness can only be
  broken by editing `worktrees.ts` itself, already excluded on the same "that's a behavioural `.ts` edit"
  ground `STATIC_GUARD_REPO_PATHS`'s own doc gives for this exact file, one list over. Its (B) section is
  separately immune under the existing presence-only shape.

## Code Review finding: `companion-lead-mode.mjs` wrote into an inherited `LOOM_HOME` (fixed)

Reviewer `96bb7127` (BLOCKING): `companion-lead-mode.mjs` set up its env via `useOwnLoomHome()`
(`_tmp-fixture.mjs`), which only mints a fresh temp dir when `LOOM_HOME` is UNSET — correct for every OTHER
consumer of that helper (all run THROUGH the `test:daemon` harness, which already sets a fresh per-file
`LOOM_HOME` before the child starts — see `dd4349ff`'s own doc), but WRONG for a `DIST_TEXT_SCANNER_REPO_PATHS`
member, which runs bare via `node <path>` and inherits the daemon's own ambient env unscrubbed
(`gate-runner.ts` spreads `process.env` into the reduced-gate child). MEASURED by the reviewer: with
`LOOM_HOME` set to a non-default inherited dir, the test wrote 7 `<uuid>.db` files + `home/` + `logs/` into
it and left them; with `LOOM_HOME` equal to the real default path, `requireHermeticEnv()` correctly refused
(exit 99) — `requireHermeticEnv` only rejects the REAL default `~/.loom`, it has no way to tell "inherited"
from "freshly minted by this process" for any OTHER value, so the non-default-inherited case slipped through
silently. It was the ONLY one of the (then-)17 `src/**` additions with this defect — every sibling
(`decisions-for-tool.mjs:37`, `operator-surface.mjs:49`, `skill-edit.mjs:42`, and the rest) constructs its
own `tmpHome` and assigns `process.env.LOOM_HOME` UNCONDITIONALLY, never gated on whether it was already set.

**Fix:** replaced the `useOwnLoomHome()` call with a direct, unconditional `mkdtempManaged()` call (same
`_tmp-fixture.mjs` module, the primitive `useOwnLoomHome` itself wraps) — atomic, kernel-unique, and
registered for guaranteed cleanup, matching the siblings' unconditional-override behavior without hand-
rolling a `Date.now()`/pid path the way most of them do. `useOwnLoomHome` itself was left UNCHANGED — it is
still the correct primitive for its other ~14 harness-run consumers; changing its shared conditional
semantics to fix one bare-node caller would have been the wrong fix at the wrong scope (and was explicitly
out of bounds per the review: "if the fix turns out to need more than that, say so and drop it from the
list instead — don't widen scope").

**RED→GREEN, reproducing the reviewer's own repro exactly:** reverted just this file's fix, rebuilt, ran
`LOOM_HOME=<scratch-non-default-dir> node companion-lead-mode.mjs` — 7 `.db` files + `home/` + `logs/`
appeared in the scratch dir (RED, byte-for-byte the reviewer's finding). Restored the fix from a captured
patch, rebuilt, re-ran the identical command against a fresh scratch dir — it stayed EMPTY after a full,
still-passing run (GREEN). Also re-ran with `LOOM_HOME` pointed at the real default path (`~/.loom`) post-
fix: no longer exits 99 (the unconditional override replaces it with a fresh temp dir before
`requireHermeticEnv()` ever inspects it), and the test still passes all its own assertions.

**Correction to this list's own doc comment:** the claim "every member below is independently verified to
set up its OWN hermetic `LOOM_HOME`/temp-dir env" was FALSE for `companion-lead-mode.mjs` between this
card's first commit and this fix — now true again for all 26 current members, re-verified by this specific
review finding plus a fresh read of every other member's own env setup (none else use the conditional
`useOwnLoomHome` helper; `orchestration-mcp-role-guard.mjs` needs no `LOOM_HOME` setup at all — it's pure
fs/regex against real source text, no daemon/DB — the same "or needs none" carve-out the array's own doc
comment already states for exactly this shape).

## DoD-2 decision: widen `DIST_TEXT_SCANNER_REPO_PATHS`, don't create a third list

Both populations — `dist/**` readers and `src/**` readers — are unrun-but-reachable on the IDENTICAL trigger
`computeEmitCompareGate` already computes: `changedTsPaths.length > 0` (a compiled `.ts` file changed).
`buildReducedGateCommand` already folds `DIST_TEXT_SCANNER_REPO_PATHS` in on exactly that condition. A third,
separately-triggered list would duplicate that same condition for no benefit — the two populations differ
only in WHERE they read from, not in WHEN they need to run. Widening the existing list's array and doc
comment, keeping its exported name unchanged, means:

- No change to `buildReducedGateCommand`'s signature, `EmitCompareGateResult`'s shape, or
  `formatReducedGateWarning`'s parameters — every existing call site (all three: the two direct
  `sessions/service.ts` sites and the batch site) picks up the widened list automatically, with zero
  threading changes needed anywhere.
- `packages/daemon/test/_emit-compare-fixtures.mjs`'s `DIST_SCANNER_BASENAMES` (derived from the real array
  at test-load time, never hand-copied) and every test that iterates it (`emit-compare-gate.mjs`,
  `emit-compare-gate-scope.mjs`, `batch-merge-reduced-gate.mjs`) already assert against the array's ACTUAL
  membership, not a hardcoded count — so widening the array needed no test edits to stay green.

**A rename was considered and rejected — at the time.** `DIST_TEXT_SCANNER_REPO_PATHS` no longer described
only `dist/**` readers, which was a real, if minor, accuracy cost this decision accepted deliberately. A
rename would have required editing every direct reference to the exported name — including its import and
two `.length` usages inside `sessions/service.ts` (`ASSET_READING_TEST_REPO_PATHS.length,
DIST_TEXT_SCANNER_REPO_PATHS.length` in both `formatReducedGateWarning` call sites). At the time this card
shipped, `sessions/service.ts` was a live fleet lane owned by a different, concurrently-dispatched card
(`8b194419`) and explicitly off-limits to this one. Widening the array's CONTENT and its doc comment's
WORDING — without touching its exported identifier — achieved the same functional fix with zero blast
radius into that file at the time.

**Superseded by card `7b0cf49b` (2026-09-11):** once `sessions/service.ts` was free to touch again, the
deferred rename was done — the array is now `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (named after its TRIGGER,
not its content), and every derived name (`DIST_SCANNER_BASENAMES` → `CHANGED_TS_SCANNER_BASENAMES`,
`distScannerTestCount`/`distScannerClause` → `changedTsScannerTestCount`/`changedTsScannerClause`) moved
with it. The narrative above (why the rename was deferred, not whether it was ever coming) stands as
history; do not read it as still-current guidance about the exported name.

## RED → GREEN proof

Reverted just this card's `packages/daemon/src/git/worktrees.ts` changes (`git checkout HEAD --`), rebuilt,
and ran an ad-hoc script calling the real (reverted) `buildReducedGateCommand({ changedTestFiles: [],
changedAssetPaths: [], changedTsPaths: ["packages/daemon/src/sessions/service.ts"] })`: the output did NOT
contain `node packages/daemon/test/log-message-content-gate.mjs` (RED — the card's own DoD-1 specimen,
confirmed unreachable pre-fix). Restored the change from a captured patch, rebuilt, re-ran the identical
call: the output DOES contain it (GREEN). The three existing tests that exercise all three real call sites
(`emit-compare-gate.mjs` — direct pre-wait classification; `emit-compare-gate-scope.mjs` — admission-time
reclassification; `batch-merge-reduced-gate.mjs` — the batch path) all pass green against the widened array,
each already iterating the array's real (not hardcoded) membership, proving every call site picks up all 17
new members with no code change at those sites.

## Code Review, cheap items

- **Member-existence check** (reviewer `96bb7127`): nothing previously asserted a list member's path
  actually exists on disk — a later rename/delete of any `STATIC_GUARD_REPO_PATHS`/
  `ASSET_READING_TEST_REPO_PATHS`/`DIST_TEXT_SCANNER_REPO_PATHS` member would pass its own full gate (the
  full suite never runs any of the three lists AS A GROUP), then fail every LATER reduced gate fleet-wide on
  `node <missing-path>`, misattributed to whoever's branch happened to trigger the reduced path next. Added
  scenario (U) to `emit-compare-gate.mjs`: `existsSync` over the union of all three real (re-exported from
  `_emit-compare-fixtures.mjs`, never hand-copied) arrays, with a negative control (a synthetic missing path
  correctly flagged as exactly the one missing entry) proving the check isn't vacuously green. **Declined**
  the optional "assert every member sets `LOOM_HOME` unconditionally" check — that would need its own
  per-file heuristic (grepping for a conditional-vs-unconditional assignment shape) which is exactly the
  "a recipe that looks reasonable and answers the wrong question" trap this card's own CLAUDE.md section is
  about; the `companion-lead-mode.mjs` fix above closes the ONE real instance found by hand-reading, and a
  mechanical proxy for "sets it unconditionally" risks the same false-positive/false-negative shape the
  `readdirSync`-glob traps throughout this file already demonstrate.
- **Warning label** (`gate-runner.ts`): `formatReducedGateWarning`'s clause said "dist-text-scanner test(s)"
  even though 16 of 26 members are now `src/**` readers. Changed to "compiled-source/dist text-scanner
  test(s)" (the count is unchanged, still `DIST_TEXT_SCANNER_REPO_PATHS.length`) and updated the three test
  literals that assert the exact substring (`emit-compare-gate.mjs`, `emit-compare-gate-scope.mjs`,
  `batch-merge-reduced-gate.mjs`). `gate-runner.ts` carries no fenced/off-limits marker (only `service.ts`
  does this seat), so this was in scope.
- **`anchor-re-parity.mjs`** — removed from the list; see the corrected membership section above.
- **Doc-sentence error**: the array's own doc comment called `test-daemon-codex-real-spawn-preset.mjs`'s
  `scripts/test-daemon.mjs` presence check "a raw `src/**` reader" — wrong, it reads `packages/daemon/scripts/**`,
  not `src/**`. Corrected in place.
- **CLAUDE.md**: widened the closing "…asset-reading/dist-text-scanning test…" sentence to
  "…asset-reading/src-or-dist-text-scanning test…".
- **`redirect-discoverability.mjs` double-listing** (in both `ASSET_READING_TEST_REPO_PATHS` and now
  `DIST_TEXT_SCANNER_REPO_PATHS`): left as-is per the review (negligible cost, and each list answers a
  genuinely different trigger question for this one file).

## Known, deliberately deferred gap: `packages/daemon/scripts/**` readers

DoD-1 also asked to check for runtime tests that raw-scan `packages/daemon/scripts/**/*.mjs` TEXT (card
`82662e98`'s `changedScriptFiles` population, a SEPARATE trigger from `changedTsPaths`). One genuine
specimen was found: `gate-runner-harness-marker-coupling.mjs` locates real call sites in
`scripts/test-daemon.mjs` via a needle-based line search (not AST, not stripped) and asserts the located
template-literal text still satisfies `gate-runner.ts`'s own regex — genuinely comment-flippable the same
way every `src/**`/`dist/**` member above is.

**Not fixed by this card.** Its correct trigger is `changedScriptFiles.length > 0`, not `changedTsPaths.length
> 0` — folding it into the existing `.ts`-file trigger would be wrong in both directions (it would run on
any unrelated `.ts` change, and would still miss the one case — a `scripts/**`-only diff — it actually needs
covering for). Wiring the correct trigger needs `EmitCompareGateResult` to expose `changedScriptFiles` as its
own field (it is currently a local variable inside `computeEmitCompareGate`, never returned) and
`buildReducedGateCommand` to read it — which means editing `sessions/service.ts`'s two non-batch call sites
to thread a fourth field through, exactly the edit the previous section explains was off-limits this seat.
(The BATCH call site would need no edit — it already passes the whole `EmitCompareGateResult` object through
unchanged.) Left as a named follow-up rather than worked around with a same-trigger fold-in that would ship
incorrect behavior.

## Do not

- Do not re-derive this card's 16-member `src/**` addition from a single grep for `"..", "src"` or
  `../src/` — it both misses real readers built through an intermediate path variable (three-argument
  `path.join(dir, "..", "src")` style still needs the full sweep to confirm) and wrongly includes files
  that merely construct a synthetic fixture directory named `src`. Re-derive the population; it drifts.
- Do not add `boot-listen-not-blocked.mjs`, `gate-verdict-field-classification-exhaustive.mjs`,
  `no-nul-in-tracked-ts.mjs`, `emit-compare-soundness-guard.mjs`, or `loopback-write-guard.mjs` to this list
  "to be thorough" — each is immune by construction for the specific, documented reason in
  `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`'s own doc comment (shapes 2, 5, 6, and the pre-existing shape-2 citation
  respectively; `loopback-write-guard.mjs` reads `dist/**`, not `src/**`, and was already re-anchored on a
  real code token after a real incident).
- Do not fold `gate-runner-harness-marker-coupling.mjs` into this list under the `changedTsPaths` trigger —
  its correct trigger is `changedScriptFiles`, a different, currently-unexposed population. See the deferred
  section above before "fixing" this by attaching it to the wrong condition.
- This list's exported name is now `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` (card `7b0cf49b` — see the
  "Superseded" note in the DoD-2 section above). Do not cite `DIST_TEXT_SCANNER_REPO_PATHS` as the current
  name outside a historical quote of what this decision was named at the time; read the array's own doc
  comment, not either name, for current scope.
- Do not re-add `anchor-re-parity.mjs` to this list "to be thorough" — its `ANCHOR_RE_DECL_RE` is
  `^`/`m`-line-anchored to the bare keyword `const`, which no comment in this codebase's convention can ever
  start a line with. Immune for the same reason shape (1) is, via a different mechanism (a line anchor, not
  a bounded template-literal body).
- Do not "fix" `companion-lead-mode.mjs`'s hermeticity by editing the shared `useOwnLoomHome()` helper in
  `_tmp-fixture.mjs` — that helper's conditional behavior is CORRECT for its ~14 other, harness-run
  consumers. Fix a bare-node member locally (unconditional `mkdtempManaged()`, as this card did), never the
  shared conditional primitive.

## Source

`packages/daemon/src/git/worktrees.ts`, `DIST_TEXT_SCANNER_REPO_PATHS`'s own doc comment, as of the commit
that widened it (card `fab07aba`).
