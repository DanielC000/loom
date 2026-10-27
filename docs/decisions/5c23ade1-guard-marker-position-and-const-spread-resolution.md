
# 5c23ade1 — the bare-ref guard checks marker POSITION, resolves a module-level const-array spread, and deploy-staleness.ts is cleared


## Narrative


Follow-on from `4b559feb`'s own Code Review (session `858caa53`), which found two structural blind spots in
`bare-ref-positional-argv-guard.mjs`'s `classifyCall` — both about what the guard measures, not about any
live offender (none existed at the time this card was filed):


1. `protectedCall` was computed from `literalNames.has("--end-of-options")` — PRESENCE anywhere in the
   array — never the marker's actual POSITION. This passed a marker placed AFTER the risky positional it
   was meant to protect, and passed the semantics-breaking shape where the marker sits BEFORE `rev-list`'s
   own `--not`, swallowing it (card `4b559feb` measured this corrupts results, not merely misses protection).
2. A monitored subcommand named only inside a module-level `const NAME = [...]` array, referenced via
   `[...NAME, x]`, was invisible to the scanner — the subcommand-skip never finds a literal to classify
   against, since the literal lives inside the spread, not as a direct array element. Real corpus instances:
   `NAME_ONLY_DIFF_FLAGS`/`NAME_STATUS_DIFF_FLAGS` in `worktrees.ts`, spread into `changedPathsBetween`,
   `stagedPathsAgainstHead`, and `changedPathStatusesBetween`.


## The position rule


`isProtectedPosition` (see the guard's own doc comments — not restated here) requires `--end-of-options` to
sit at a real array index STRICTLY BEFORE the risky item it protects, since the marker ends ALL subsequent
option/pseudo-opt parsing from where it's placed, permanently, for the rest of argv. The one exception:
`rev-list`'s own `--not <ref>` — a risky item BEFORE `--not` needs no marker at all (the range/base argument
region there is immune regardless of placement, per `4b559feb`'s own measurement), while a risky item AFTER
`--not` is protected only when the marker sits in the ONE exact slot right after it
(`markerIdx === notIdx + 1`). A marker found BEFORE `--not` fails the WHOLE call outright, regardless of
what it would otherwise protect — `classifyCall` checks this before ever consulting the per-item rule.


## Two shape exemptions the position rule needed, found by running it against the real corpus


Making the position rule exact (not merely "present somewhere") surfaced NINE real-corpus false positives —
every one a LEGITIMATE, already-safe flag (or a flag's own consumed value) sitting, correctly, BEFORE the
marker, which the guard's existing conservative "risky" classification had always counted as risky but which
the OLD presence-anywhere check never needed to position-check:


- `isSelfEvidentFlagTemplate`: a `TemplateExpression` whose raw literal HEAD starts with `-` (e.g.
  `` `--max-count=${n}` ``, `` `--grep=Loom-Worker-Branch: ${branch}` ``) is UNCONDITIONALLY read by git as
  the option it's written to look like — there is no "re-interpretation" risk for an element that was
  always, by its own hardcoded spelling, meant and read as a flag, regardless of where the marker sits.
  Six of the nine corpus hits were this shape (`mainline-watch.ts`/`worktrees.ts`'s own `--max-count=`/
  `--grep=` construction ahead of a correctly-placed marker protecting the real trailing range/sha).
- `isKnownFlagValue`: a risky item immediately preceded by a KNOWN value-consuming flag — either a leading
  `GLOBAL_OPTS_WITH_VALUE` member (e.g. `--git-dir <path>`) or a judgment-curated, per-subcommand set
  (`KNOWN_VALUE_FLAGS_BY_SUBCOMMAND`, today just `log`'s own `-n <count>`) — needs no position protection
  either: git's CLI parser binds that next token to the flag directly and never independently re-examines
  it. One real corpus hit (`worktrees.ts`'s `listMergedCommitsLookup`-family `["log", ..., "-n",
  String(MERGED_LOOKUP_SCAN_LIMIT), "--end-of-options", base]`) needed this.


Both exemptions are gated on `markerIdx !== -1` (SOME marker must exist somewhere in the call) — a call with
ZERO `--end-of-options` anywhere stays conservatively flagged regardless of shape, matching this guard's own
pre-existing tests (e.g. `` `--output=${x}` `` with no marker at all stays flagged). Neither exemption
depends on the marker's POSITION, because neither element's own safety ever did — both describe an element
that was always going to be read as a flag (or a flag's own value), never re-examined as an independent ref,
however far the marker sits from it.


**Real-corpus parity, post-fix: 0 hits (unchanged from pre-fix — no live offender, as the card itself
expected).** Verified directly: running this card's own position-rule assertions against the PRE-card guard
logic (extracted from `HEAD`'s committed file into a scratch module, never committed) confirms all five RED
controls below were genuine, undetected blind spots under the old presence-anywhere check — the old code
reported every one of them "protected" (0 hits); the new code correctly flags all five.


## Module-level const-array spread resolution


`resolveModuleConstStringArrays` resolves a TOP-LEVEL `const NAME = [<string literals>] (as const)?;`
declared directly in the scanned file's own `sourceFile.statements` into a `Map<name, string[]>` —
deliberately conservative: a declaration whose array contains ANY non-string-literal element is not added at
all. `toItems` then expands a `[...NAME, x]` spread referencing a resolved name into its own literal
elements, in place, for every purpose (subcommand location, `literalNames`, position indices) — exactly as
if they'd appeared directly in the array. A spread of an UNRESOLVABLE identifier (cross-file, computed, or
mixed-literal) is left exactly as before: unclassified, invisible to the scanner, same as pre-card. The
dedicated `CANONICAL_GIT_CONFIG_ARGS` known-safe spread is checked FIRST and never expanded, even if it were
hypothetically also resolvable.


## Parity: real corpus, post-fix


`NAME_ONLY_DIFF_FLAGS`/`NAME_STATUS_DIFF_FLAGS` spreads (lines ~4876/4896/5201 of `worktrees.ts`) are now
VISIBLE to the guard (subcommand `diff`) for the first time. All three resolve to PROTECTED: the two with a
risky range template already carry `--end-of-options` correctly placed before it;
`stagedPathsAgainstHead`'s own spread (`[...NAME_ONLY_DIFF_FLAGS, "--cached", "HEAD"]`) has no risky element
at all (both trailing values are plain string literals). Total real-corpus hits: 0, both before and after
this card (no live offender, as the card itself expected).


## `deploy-staleness.ts` — traced, not fixed, not widened into


Card `5c23ade1`'s own kickoff named two bare-positional `diff` calls outside `git/**`
(`computeAncestorBehaviouralMatch`'s `diff --name-status --no-renames fromSha toSha -- …` and
`computeDeployStaleness`'s own `diff --name-only processBuiltSha mainlineHeadSha -- …`), asking whether
`fromSha`/`toSha`/`processBuiltSha`/`mainlineHeadSha` are agent-influenceable, and if so, to add the marker
and widen the guard's scan scope; either way, to decide and justify.


**Traced all FOUR risky-positional call sites in that file** (the two `diff`s above, plus
`commitDateMs`'s `log -1 --pretty=%cI <sha>` and `isAncestor`'s `merge-base --is-ancestor <sha> <of>`) to
their value provenance:


- `processBuiltSha` ← `readBuildInfo(__dirname)` (`served-status.ts`) ← `<dist-dir>/build-info.json`'s own
  `sha` field ← written ONLY by `scripts/write-build-info.mjs`'s `resolveSha()`, which is the trimmed stdout
  of `git rev-parse HEAD` on the real checkout, or `null` on any failure. Never a free-form string.
- `mainlineHeadSha` ← `runGit(repoRoot, ["log", "-1", \`--pretty=%H${UNIT_SEP}%cI\`])`'s own `%H` field —
  git's own full hex object id for the real current `HEAD`, split out of that one line.


**Conclusion: NOT agent-influenceable to be option-shaped, by construction — stronger than the `rev-list`
combined-range immunity `4b559feb` measured.** A `rev-parse HEAD`/`log --pretty=%H` result is always a
lowercase-hex commit id (today 40 chars, sha256 repos use 64) — hex digits are `0-9a-f`, so such a value can
NEVER begin with `-`. There is no committer-controlled free text anywhere in this chain (unlike
`trailers.base`/`baseSha`, which originates in an attacker-writable commit MESSAGE trailer, exactly the
class `65b2b002`/`b8122303` exist to validate) — `write-build-info.mjs` reads git's own resolved object id
directly, never a string a worker authored. The `diff`/`log`/`merge-base` calls at `show(...)`'s two sibling
sites (`fromSha:${p}`/`toSha:${p}`, lines ~486/491) carry the SAME provenance; `show` isn't a monitored
subcommand anyway. **No marker added — there is nothing here for it to protect.**


**Guard scope NOT widened beyond `git/**`.** The two things that would have justified widening — an
influenceable value, or a NEW call site this guard's own stated rationale ("these subcommands' bare-ref-
positional hazard is a `git/**` concern") didn't anticipate — are both absent here: every risky positional
in this file is provably hex-only, and widening to catch ONE already-safe file would mean pulling in
`packages/daemon/src/**` for zero closed gap, against the guard's own documented, deliberate `git/**` scope
(see its own header). If a FUTURE non-`git/**` file passes a genuinely attacker-influenceable value to one
of these subcommands, that's the trigger to widen — not this file.


## Do not


- Do not read `--end-of-options` as protecting a call merely because it is PRESENT somewhere in the array —
  it must sit BEFORE the risky positional it covers (the `rev-list`/`--not` exception aside). Never
  reinstate the presence-only check this card replaced.
- Do not place `--end-of-options` before `--not` in a `rev-list ... --not <ref>` call — it fails the WHOLE
  call outright in this guard (by design), and corrupts the real result in production (per `4b559feb`).
- Do not treat `isSelfEvidentFlagTemplate`/`isKnownFlagValue` as "this element is always safe" — both are
  gated on `markerIdx !== -1`; a call with NO `--end-of-options` anywhere stays flagged regardless of shape.
- Do not widen `KNOWN_VALUE_FLAGS_BY_SUBCOMMAND` with a flag that ISN'T genuinely unconditional-value-taking
  for that exact subcommand — the exemption is sound only because git's own parser binds the next token to
  the flag unconditionally; a wrong entry would silently exempt a genuinely risky positional.
- Do not resolve a module-level const array that contains ANY non-string-literal element — `toItems` must
  never guess at a value it can't see in the text; leave such a spread exactly as unclassified as an
  unresolvable one.
- Do not widen `bare-ref-positional-argv-guard.mjs`'s scan scope to `deploy-staleness.ts` (or `src/**`
  generally) on the strength of this card's investigation — every risky positional there is provably
  hex-only (git-resolved commit ids), never attacker-authored text; there is no gap here to close.


## Source


Worker dispatch, card `5c23ade1` (discovered from `4b559feb`). Test coverage:
`bare-ref-positional-argv-guard.mjs` (position rule + const-spread resolution + the two shape exemptions,
new `(C) 5c23ade1 …` controls, real-corpus parity unchanged at 0 hits). No `packages/daemon/src/**` change —
every real site was already correctly shaped; `deploy-staleness.ts` needed tracing, not a fix.
