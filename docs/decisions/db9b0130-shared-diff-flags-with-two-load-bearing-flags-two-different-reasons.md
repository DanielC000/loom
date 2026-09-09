# db9b0130 — `changedPathsBetween`'s shared diff flags, and why `--no-renames` is load-bearing twice over

## Narrative

`changedPathsBetween` is the raw changed-path list between `base` and `ref` — the single git-diff invocation `changedPathSetDigest` and `isInertMergeDiff` BOTH build on (extracted after the two calls drifted into byte-identical copies of the same `git diff` args — two copies of a load-bearing flag is precisely the mechanism that makes losing one dangerous).

`--no-renames` (in `NAME_ONLY_DIFF_FLAGS`) is LOAD-BEARING for BOTH callers, for two DIFFERENT reasons: `changedPathSetDigest` counts a rename as its two raw (deleted, added) paths, independent of git's rename-detection heuristic ever changing; `isInertMergeDiff` — PROVEN on git 2.47.0 — with rename detection ON, `git diff --name-only` after `git mv src/x.ts docs/x.ts` prints ONLY `docs/x.ts`, so a branch RELOCATING a real source file into an allowlisted prefix would misclassify as inert and un-gate that source file (see `merge-gate-inert-diff.mjs` scenario (F), which pins this).

`-c core.quotePath=false` disables git's C-style octal-escaping of non-ASCII path bytes (PROVEN: `docs/café-findings.md` is otherwise emitted as `"docs/caf\303\251-findings.md"`). Without it, `isInertMergeDiff`'s `startsWith` allowlist check would silently miss a non-ASCII docs filename — FAILS CLOSED but with no visible signal why.

Each raw line has only its trailing `\r` stripped (never a generic `.trim()`, which could widen an allowlist match against a hypothetical whitespace-padded directory name) — git's `--name-only` output uses `\n` even on Windows, so this only strips a stray CR.

A THIRD caller depends on the same two flags without being built on this shared helper: `computeEmitCompareGate`'s own `git diff --name-status` invocation (needs per-path STATUS) sets both identically, inline-only — not duplicated here as a third copy of the flag list; see that call site's own comment for why it couldn't reuse this function directly.

## `INERT_MERGE_PATH_PREFIXES` — the measured-absence allowlist, and why it stays narrow

`INERT_MERGE_PATH_PREFIXES` is the list of path prefixes PROVEN to hold nothing compiled, tested, or read at runtime by the Loom daemon test suite SPECIFICALLY. Verified 2026-08-05: `grep -rnE "(readFileSync|existsSync|readdirSync|createReadStream)\([^)]*docs" packages/daemon/test/*.mjs` ⇒ zero hits (the identical pattern against `assets` ⇒ non-zero, so the zero is a real absence, not a broken pattern), and the one `docs/` path a test file's own comment cites (`test-daemon-gate-timing.mjs`) is a provenance citation, never a real read. Deliberately narrow and NOT extension-based: `assets/**` is markdown too, and IS heavily tested (10 test files reference it) — an extension check would wrongly classify a `SKILL.md` change as inert. Do not widen this list without re-running that same grep first.

WHY `assets/skills/**` IS DELIBERATELY EXCLUDED (card `9fcc29bb`): markdown under `assets/**` is product behaviour, not incidental content — `redirect-discoverability.mjs` and `skills-seed-asset-override-default.mjs` both read real checked-in `assets/skills/<name>/SKILL.md` files as their comparison oracle. `merge-gate-inert-diff.mjs` scenario (B) ENFORCES this exclusion — it commits a branch whose entire diff is one such `SKILL.md` and asserts the gate command still genuinely RAN (a call counter, not a trusted return value).

THIS MEASUREMENT IS LOOM-ONLY, BUT `isInertMergeDiff` RUNS FOR EVERY PROJECT THIS DAEMON SERVES — so it does not trust this list alone for another project: it re-verifies PER-REPO, at gate time, via `repoTreeReferencesInertPrefix` (this list stays a cheap first-pass allowlist). See [[1c0d4aa4-per-repo-inert-prefix-rescan-is-fail-closed-on-exit-code-not-pattern]] for that re-verification's own fail-closed contract and pattern-coverage gaps, and [[0910531e-js-ts-applicability-gate-and-git-grep-exit-code-mechanics]] for why the scan itself is gated on the repo being JS/TS first (a "no match" is otherwise a tautology, not evidence, for a non-JS/TS project).

## Do not

- Do not drop `--no-renames` — proven on git 2.47.0 that it makes `isInertMergeDiff` misclassify a renamed source file relocated into an allowlisted prefix as inert, un-gating real source changes; `merge-gate-inert-diff.mjs` scenario (F) pins this.
- Do not drop `-c core.quotePath=false` — a non-ASCII path would be emitted octal-escaped, silently missing the `startsWith` allowlist check.
- Do not widen the trailing-`\r` strip to a generic `.trim()`.
- Do not let `computeEmitCompareGate`'s separate `--name-status` invocation drift out of flag parity with this one.
- Do not widen `INERT_MERGE_PATH_PREFIXES` without re-running the read-call grep first — every entry is a MEASURED absence.
- Do not add `assets/skills/**` to `INERT_MERGE_PATH_PREFIXES` — real tests read it as a comparison oracle; `merge-gate-inert-diff.mjs` scenario (B) enforces the exclusion.
- Do not trust `isInertMergeDiff`'s allowlist-only result for a non-Loom project without the per-repo re-check (see the two linked records above).

## Consequences

Two (now three, counting the `--name-status` caller) diff invocations that must agree on flags now share one array (or are explicitly documented as a deliberate exception), closing the exact "two copies drift out of parity" mechanism that made losing a load-bearing flag possible in the first place. `INERT_MERGE_PATH_PREFIXES` stays a narrow, measured allowlist re-verified per-repo at gate time, rather than a trusted-everywhere shortcut.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `changedPathsBetween`'s own doc comment and `INERT_MERGE_PATH_PREFIXES`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
