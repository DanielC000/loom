# 4b559feb — end option parsing before `rev-list`/`diff` ref positionals

## Narrative

Phase 5 of the option-shaped-ref hardening, after `65b2b002`/`7eac6366`/`abbda4f5`/`868e0135`/`a4145c7a`.
Those cards closed `merge-base`, `ls-tree`, `log`, and `rev-parse`; this card closes the same bug CLASS for
`rev-list` and `diff` in `packages/daemon/src/git/**`. Re-enumerated on main by temporarily widening
`bare-ref-positional-argv-guard.mjs`'s own `MONITORED_SUBCOMMANDS` to include `rev-list`/`diff` and reading
its corpus-scan offender list (the guard's own classifier, not a hand grep) — **35 real hits**, across
`batch-merge.ts`, `mainline-watch.ts`, `merge-linearization.ts`, `unanchored-comment-blocks.ts`,
`worktrees.ts`, and `writer.ts`. All 35 fixed in this pass, mirroring `868e0135`'s own precedent of closing
the whole real set rather than leaving some for later.

## MEASURED finding that corrects an implicit assumption carried from `868e0135`/`abbda4f5`

**REVISED (Code Review, session `858caa53`) — see "Correction" below for what changed and why.**

**For `rev-list`, a COMBINED two/three-dot range string (`` `${a}..${b}` ``/`` `${a}...${b}` ``) can never
literally equal a flag spelling** (it only starts with `-` if its own HEAD does, and `rev-list` has no
value-taking option whose prefix a crafted left side could match), so `--end-of-options` is MEASURED to
change **nothing** about that shape's real safety there: on a clean repo, a malicious embedded `--all` on
either side of the range **already** fails loud (`fatal: ambiguous argument`/`usage: git rev-list…`/
`fatal: option '--all' must come before non-option arguments`) with **no marker at all**, and continues to
fail loud the same way **with** the marker. (An earlier, throwaway repro repo that happened to carry a
decoy ref literally named `--all`/`--count`/`--not` produced a misleading "silent success" in both cases —
an artifact of that decoy, not of the marker's absence.)

**For `diff`, this does NOT hold — the marker IS load-bearing at every range site, left side included.**
`git diff` has several VALUE-TAKING options matched by PREFIX before the `=` (`--output=<file>`,
`--src-prefix=<p>`, `--dst-prefix=<p>`, and the short `-O<file>`) — unlike `rev-list`'s `--all` (an exact,
no-value flag), these never need the WHOLE positional to equal a known flag spelling; they only need it to
START with `--output=`/`--src-prefix=`/etc., with EVERYTHING after `=` (including the literal `..` and the
right-hand ref text) consumed as the option's own value. MEASURED, no marker: `diff --name-only
"--output=victim.txt..master"` exits **0**, prints nothing, and **creates/overwrites a file literally named
`victim.txt..master`** on disk — a real, unprompted file write from a caller-influenced range value never
intended as a filesystem path. `--src-prefix=x..master` is accepted the same way (silently, no file side
effect, but silently discarding the whole revision argument). WITH the marker, both fail loud instead
(`fatal: option '--output=victim.txt..master' must come before non-option arguments`), no file written.
**So the marker is genuinely load-bearing at every `diff` range call site this card touches** — the
`diffBranch` name-status/numstat/patch calls, `unanchored-comment-blocks.ts`'s scoped diff, the two
`` `${mergeBase}..${branchRef}` `` content-check calls, and `diffOwedLanding`'s `--numstat` call — not
merely defense-in-depth/guard-consistency. See `bare-ref-positional-argv-fixes.mjs`'s (0k2) for the
reproduction (writes under a `mkdtemp`'d scratch dir, cleans up after).

**The marker DOES close a real gap** for three shapes now, all MEASURED:
- For `rev-list`, a true **SEPARATE bare positional** (not a combined range) — e.g. `rev-list --parents
  -n1 --all` — silently SUCCEEDS pre-fix, treating `--all` as the real flag instead of an invalid literal
  ref name, and fails loud post-fix. Same class `868e0135` already closed for
  `log`/`merge-base`/`ls-tree`/`rev-parse`.
- For `diff`, EVERY range site, including a combined-range left side — see above.
- `rev-list ... <range> --not <ref>` — see below.

### Correction (Code Review, session `858caa53`)

The original version of this record claimed the combined-range finding above held for BOTH `rev-list`
AND `diff`, generalizing from `rev-list`'s own (correct) immunity without separately re-measuring `diff`'s
own option surface. `diff`'s value-taking, prefix-matched options are a property `rev-list` does not
share (`rev-list` has no equivalent of `--output=`/`-O`), so the two subcommands needed to be measured
independently — this is exactly the "narrowing a finding to a DIFFERENT, untested case" trap: the two
subcommands look alike (same guard, same call shape) but are NOT alike in their own option grammars. The
shipped SOURCE FIX was never wrong (every `diff` range site already carries the marker, same as every
`rev-list` site) — only this record's EXPLANATION of why was wrong for half of it. Project memory key
`revlist-diff-end-of-options-range-immune-not-placement` corrected the same way; see that note's own
history for the prior (superseded) wording.

## The `--not` placement rule (the card's own named hard case)

`--not` toggles sign for every subsequent revision argument until changed again — it is a REAL FLAG, not
a value, and it must stay recognized as one. `--end-of-options` ends ALL subsequent option/pseudo-opt
recognition from where it's placed, permanently, for the rest of argv. Consequence, MEASURED directly:

- Placing the marker **before `--not`** (e.g. right after the range) makes `--not` itself unreadable as a
  flag — it becomes a literal positional instead, and git either refuses the whole call outright
  (`fatal: option '--not' must come before non-option arguments`) or, worse, silently reorders sign
  application and changes which commits are excluded (MEASURED: `--not <ref> <range>` with `--not` first
  returns a DIFFERENT, non-empty-vs-empty result than `<range> --not <ref>` for the identical refs — the
  range's own sign gets flipped too).
- Placing the marker **right after `--not`, before the ref that follows it** is the correct shape:
  byte-identical to the unguarded call for a well-formed ref, and fails loud for an option-shaped one — see
  `bare-ref-positional-argv-fixes.mjs`'s (0m) and the real `computeOwedLanding` proof in its SECTION 7.
- The range **before** `--not` needs no marker at all (see the combined-range finding above) — attempting
  to protect it would have to sit the marker before `--not`, which breaks `--not` outright.

Fixed at both `computeOwedLanding` call sites (`git/worktrees.ts`, the `merges`/`owed` reads): the marker
sits between `"--not"` and `main`, never anywhere else in that argv.

## Call sites fixed

35 sites across `batch-merge.ts`, `mainline-watch.ts`, `merge-linearization.ts`,
`unanchored-comment-blocks.ts`, `worktrees.ts`, `writer.ts` — each anchored `@decision 4b559feb` at its own
call site; see those anchors (and `git log -p` for this card) for the exact file:line/argv/fix table rather
than restating it here, per this project's own "point at a source of truth" rule. Shapes covered: a bare
single positional (marker before it); two separate bare positionals (one marker before the first protects
both, verified with/without a trailing `-- <pathspec>`); a combined range (for `diff`, this closes a real
file-write/silent-discard gap — see above; for `rev-list`, the marker is added anyway for guard-consistency
even though it closes nothing there); `rev-list --not <ref>` (marker after `--not`); a compound-suffixed
positional (`` `${sha}^` ``, no safe literal prefix — same retracted-exemption class `868e0135` round 2
closed); and a conditional `...(paths ? ["--", ...paths] : [])` pathspec spread with no ref positional at
all (marker kept for guard-satisfaction; MEASURED harmless either way `paths` is present or empty).

## Guard extension (`bare-ref-positional-argv-guard.mjs`)

`MONITORED_SUBCOMMANDS` now also lists `rev-list`/`diff`. No other matcher logic changed — the existing
classification (literal/qualified-template/known-safe-spread exemptions, `--end-of-options` text-presence
check) already generalizes; `rev-list`/`diff` need no `--verify` companion the way `rev-parse` does. New
(C) controls added for both subcommands, including the `--not` placement shape (protected vs unprotected).
Real-corpus offender count: 35 → 0. ALLOWLIST unchanged (empty) — every real site took the generic fix.

## `trailer-derived-value-git-argv-guard.mjs`'s `STATIC_GUARD_REPO_PATHS` membership — reconciled, not removed

That guard's stated reason ("an explicit, self-contained comment-stripped whole-file scan, immune by
construction to a comment-only diff") argued the WRONG direction against the list's own MEMBERSHIP
CRITERION (card `a1734000`): being comment-stripped means only a genuine CODE change — itself a
behavioural `.ts` edit — can ever trip it, which is exactly the ground that EXCLUDES
`bare-ref-positional-argv-guard.mjs`/`canonical-git-helper-guard.mjs`/`emit-compare-soundness-guard.mjs`
from this same list.

**Corrected (Code Review, session `858caa53`): "owner-directed" does NOT apply here.** The first pass of
this record assumed the trailer guard shared its cited neighbours' (`remote-trust-single-predicate-
guard.mjs`, `harness-adapter-claude-literal-guard.mjs`) OWNER-DIRECTED ground, since all three police a
similar trust-boundary class. The Code Review checked and found **no actual owner request** behind that
claim for THIS guard — it was an inference, not a verified fact, and stating it as one would have invented
provenance the way the standing "never write an id you weren't handed" rule warns against for ids; the
same discipline applies to a decision's STATED AUTHORITY. The real, honest ground is narrower and does not
need an owner ruling to justify: keeping this guard on `STATIC_GUARD_REPO_PATHS` is a **reviewer-chosen
over-inclusion** on the trust-boundary ground (it polices a candidate/attacker-reachable value routing
through exactly one validated chokepoint — `resolveExactTrailerObjectId` — before it can reach git) —
an over-inclusion never WEAKENS the reduced gate (it only ever adds a check, never skips one), and this
guard's own corpus scan runs in ~1 second, so the cost of keeping it is negligible even though, strictly
by the `a1734000` criterion alone, it would not need a seat. The comment at its call site states this
plainly now, with no appeal to an owner directive this card never verified. Not removed either way; this
remains a judgment call made explicit, not a silent edit.

## Do not

- Do not read a combined `A..B`/`A...B` range's protection by `--end-of-options` as merely cosmetic for
  `diff` — MEASURED it IS load-bearing there (a left-side value-taking option like `--output=`/`-O`/
  `--src-prefix=` is matched by PREFIX, not by exact flag equality, so it never needs the whole positional
  to resolve as a revision first; unguarded, it silently writes/overwrites a file or silently discards the
  revision). This is TRUE ONLY for `diff`; for `rev-list` (no such value-taking option) the SAME shape is
  MEASURED to change nothing — do not generalize either subcommand's finding to the other without
  re-measuring; they were conflated once already (see "Correction" above) and that was the defect.
- Do not place `--end-of-options` before `--not` in a `rev-list ... --not <ref>` call, even to "protect"
  the range — it breaks `--not`'s own sign-flip semantics (MEASURED: a different, wrong result; sometimes
  an outright refusal) rather than merely failing to add security. The marker's one correct position is
  immediately after `--not`, before the ref it negates.
- Do not read "immune to a comment-only diff" as a reason a source-text guard belongs in
  `STATIC_GUARD_REPO_PATHS` — under that list's own `a1734000` criterion it is evidence FOR exclusion, not
  inclusion.
- Do not state a guard's membership is "owner-directed" without having actually verified an owner request
  behind it — the Code Review found none for `trailer-derived-value-git-argv-guard.mjs`; its real ground is
  a reviewer-chosen, cost-free over-inclusion on the trust-boundary class, not a ruling. Same discipline as
  never writing an id you weren't handed, applied to a decision's stated AUTHORITY instead of its identity.
- Do not widen this card's fix to `git grep`'s own `treeish` positional — unrelated subcommand, already
  excluded by `868e0135`'s own measured regression (see that record and the guard's own header).

## Source

Worker dispatch, card `4b559feb`. Test coverage: `bare-ref-positional-argv-guard.mjs` (extended
`MONITORED_SUBCOMMANDS` + new (C) controls), `bare-ref-positional-argv-fixes.mjs` (new 0k/0l/0m mechanism
sections + SECTION 7, a real `computeOwedLanding` RED/GREEN proof against real git). Every claim above was
measured on real git 2.47.0 in throwaway temp repos before any source edit.
