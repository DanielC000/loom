# 868e0135 — close every remaining bare-ref-positional site in `packages/daemon/src/git/**`

## Narrative

Phase 4 of the option-shaped-ref hardening, after `65b2b002`/`7eac6366`/`abbda4f5`. The card named 5 sites
from `abbda4f5`'s Code Review; re-enumeration confirmed all 5 plus a 6th of the identical class
(`repoTreeHasJsTsSourceFile`'s raw-spawn `ls-tree`, invisible to a `git.raw(` grep). Building the guard
then surfaced these 6 were not the whole population — every other merge-base/log call in `git/**` carried
the identical shape — so the WHOLE set in `packages/daemon/src/git/**` was closed in one pass (56c10535's
precedent), across two rounds (round 2, CR `fc0a4ea9`, found the round-1 guard gave a false green — see
"Guard"). PER-FILE COUNT (the guard's own classifier): **55 total**; re-derive, don't trust this number.
Every fix measured byte-identical/fail-loud (`bare-ref-positional-argv-fixes.mjs`).

**One genuine exploit, found and proven**: `mergeCommitBlocksLinearization` compares `merge-base`'s OUTPUT
against `p` while the option-shaped value sits in `mainRef` (a DIFFERENT variable) — MEASURED: `merge-base
<p> --independent`/`--octopus` silently returns `p`'s own sha, collapsing `=== p` to true though `mainRef`
was never consulted. Pre-fix `undefined` (wrongly not-blocking); post-fix the correct reason. Most other
sites are genuinely immune to this collapse trick (same-variable comparison target, or no flexible-arity
mode) but were fixed anyway.

**RETRACTED (round 2, CR `fc0a4ea9`)**: a round-1 exemption claimed a compound-suffixed/ranged value
(`${sha}^{tree}`, `${a}..${b}`) could never match a flag's spelling. FALSE — `` `--output=${x}` `` writes
a file, `` `--grep=zzz${x}` `` matches nothing silently. Narrowed to a LITERAL-PREFIX-ONLY exemption.

## Fix shape (measured on real git 2.47.0, throwaway repos — see `bare-ref-positional-argv-fixes.mjs`)

Reuses abbda4f5's shapes for `ls-tree`/`log`/`rev-parse` unchanged, extended to `merge-base`: the marker
right after `"merge-base"` protects both positionals at once — byte-identical for two well-formed shas,
fails loud instead of silently switching mode. A spread of positionals takes the marker right before it.

## Guard (`packages/daemon/test/bare-ref-positional-argv-guard.mjs`)

The live matching rule, scope, and "what it does not see" live in the guard file's own header — read it
there. Round 1 (`.raw([`/`spawn(...)` only) false-greened a bare wrapper call; round 2
widened to ANY array literal, whatever the callee, and narrowed the round-1 exemption to a literal-PREFIX-
only one (see "Narrative" for why). Real-corpus ALLOWLIST is EMPTY.

**Not added to `STATIC_GUARD_REPO_PATHS`**: its criterion ("something OTHER than a behavioural `.ts` edit
can invalidate what it asserts," in `worktrees.ts`) excludes it — every array it polices is a genuine
runtime expression, so any edit flipping its verdict is itself behavioural, already forcing the full gate
where it runs via the corpus walk. Same ground as `canonical-git-helper-guard.mjs`'s exclusion.

## Round 3 — guard-scanner hardening + EOF-canary backstop (CR2/CR3)

`scanText`'s outer `'`/`"` quote state spanned the WHOLE file, no per-line reset — a stray apostrophe in
an inline, same-line comment (`git/reader.ts` ~line 84's own `catch`: "doesn't") or a quote-only regex
(`` /['"]/ ``) left it stuck open, hiding every later array literal. Fixed: reset `'`/`"` at every newline
(backtick doesn't — a template may legitimately span lines).

`isArrayLiteralStart` misread a literal right after a keyword that can only be followed by an expression
(`return [...]`) as a subscript; fixed via whole-token backtrack against a fixed list — see the guard
header for the list and its own named residual.

`isQualifiedTemplate` trusted a template's RAW text, not its COOKED value: a backslash escape in the
prefix (`` `\-${v}` ``, cooks to `-`) slipped past `startsWith("-")`, and an element chained after its own
close (`` `x${v}`.slice(1) ``) was exempted by its prefix alone. Fixed: reject any `\` in the prefix;
require EXACTLY one closed template (`findTemplateClose`).

**CR3's structural backstop**: (S) now appends a risky canary to each file's own text (in memory) and
asserts detection — a smoke test for a desync from ANY cause. **Measured blind spot**: a regex with an
ODD backtick count (`` /`[^`]*`/g ``) opens a backtick-quote state that, unlike `'`/`"`, never resets at a
newline — stays open through EOF, swallowing the canary too. Fails LOUD (the canary goes missing), the
point of a backstop; the shape is an open gap pending a carded AST rewrite.

@decision 868e0135

## Do not

- Do not add `--end-of-options` to `git grep`'s `treeish` positional (`repoTreeReferencesInertPrefix`'s
  inner spawn) — measured regression: git tries to resolve the marker itself as the revision.
- Do not read the EMPTY allowlist as "nothing to document" — see its own doc comment in the guard file.
- Do not assume a test's `args[1] === <value>` matcher still matches after this card — several did not
  (the sha/tip shifted slots); fixed via `args[args.indexOf("--end-of-options")+1] === <value>`.
- Do not add the marker to a bare (no `--verify`) `rev-parse` call assuming it's sufficient alone —
  MEASURED: it corrupts a WELL-FORMED call's output (echoes itself as a spurious first line) for a PLAIN
  sha just as much as a COMPOUND-SUFFIXED one (`${sha}^{tree}`, `${sha}^`). `--verify` is required, no
  exceptions.
- Do not reintroduce a "compound suffix is safe" exemption — retracted for the reason above plus the
  `--output=`/`--grep=` unsoundness; only a literal, non-`-` PREFIX is stable enough.

## Source

Worker dispatch, card `868e0135`; widened scope approved mid-dispatch. Test coverage:
`bare-ref-positional-argv-fixes.mjs`/`-guard.mjs`. `abbda4f5`'s record holds the mechanism proofs reused.
