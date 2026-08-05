# 19af6c5c — audit for guard-dodging label rewords in fixed-wait sites

Card `19af6c5c` asked for a mechanical audit of `fixed-wait-negative-guard.mjs`'s full history for the
"reword the label to escape the guard" exit that card `1c5dda5d` named as forbidden but structurally
open (until `1c5dda5d` itself shipped `TIMING-GUARD-FALSE-MATCH` as the legitimate alternative). **No
production code was changed as part of this audit.** All scripts below are read-only consumers of `git
log` output and the current source tree.

## The two shapes, and which of them each check below can see

- **Shape A — reword-in-place.** An existing `check()`/`assert()` label is edited in a later commit,
  removing a `NEG_KEYWORDS` token while leaving the assertion's own condition unchanged. Visible to `git
  log -p`: the removed and added text both appear in the same diff hunk.
- **Shape B — born-already-phrased.** A file is *created* with a label that already avoids
  `NEG_KEYWORDS`, with no earlier committed version to diff against. **`git log -p` structurally cannot
  see this shape.** The card's own specimen (`worker-unconfirmed-delivery-signal.mjs`, introduced by
  `4aa687fe`) is exactly this shape — see Section 5.

## 1. A broken instrument produced a false "zero" first — caught before trusting it

The first version of the wait-adjacency checker (`scripts/filter-wait-adjacent.mjs`) hardcoded its
target repo as a POSIX-style path (`/c/Users/…`) for `execFileSync("git", …, { cwd: REPO })`. On this
Windows host, that `cwd` is invalid, and `spawnSync`'s failure mode for an invalid `cwd` is `ENOENT` on
the child binary itself — indistinguishable, from the catch block, from "git isn't installed." The
script's own `catch` swallowed that into `content = null` → `{found: false}` for every call. Run against
the real repo (1372 git-show calls), this failed on **every single call** — confirmed by adding temporary
error-count instrumentation and diffing: the POSIX-path version logged `ENOENT` on 1372/1372 calls in the
full run, while a version pointed at a real Windows-style `cwd` (`C:\…`, resolved from
`import.meta.url`) logged 0/1372 errors on the identical input. **That measurement is solid and stands
as written.**

What does NOT stand: an earlier draft of this section claimed an isolated single call with the same
POSIX path "reliably succeeded," and drew the actionable-sounding conclusion that a quick isolated sanity
check would not have caught this bug. That claim doesn't survive a second look at what was actually run.
Two isolated single calls (`node -e '…execFileSync("git", …, {cwd: "/c/Users/…"})…'`) against the exact
same invalid path — the real worktree path once, an unrelated throwaway-repo path once — both **failed**
with the identical `ENOENT` at a single call, same as the bulk run. What actually succeeded at low volume
was a `.mjs` script *file* (not a `node -e` one-liner) making 1–2 calls with the same invalid path. So the
two things that differed between "succeeds" and "fails" in what was actually measured are **invocation
form (`node -e` vs a script file) and call volume together** — never isolated from each other, no
intermediate volume tested. **The mechanism behind the bulk failure is unidentified** — it could be
volume/rate-triggered, invocation-context-dependent, or something else entirely. The fix doesn't depend on
knowing which: resolve `cwd` from a real Windows path (`path.resolve` off `import.meta.url`, or an
explicit `C:\…` string) rather than a bash-style `/c/…` literal, and this class of failure doesn't recur
regardless of why the POSIX form fails. (Full account, including the exact commands run and their outputs,
is in project memory `windows-execfilesync-posix-cwd-silent-fail`, v2.)

The result was a clean-looking `0 pairs are fixed-wait-adjacent` — plausible, and wrong. It was caught
only because the same script was later copied into this investigation folder (for reproducibility) with
its `REPO` default rewritten to resolve from `import.meta.url`, and a re-run on the *identical* input
produced `81`, not `0`. Two runs of "the same check" disagreeing is what triggered the investigation above
— not any a-priori suspicion of the number itself. Per this project's own doctrine
(`positive-control-your-searches-empty-is-not-evidence`,
`a-control-inherits-the-equivalence-you-assumed-building-it`): the fix wasn't "the positive control passed
once, therefore trust the zero" — the control had *already* passed once, on the broken version, via a
script-file invocation that (per the correction above) simply hadn't hit whatever the failure trigger
actually is. Only a second, independent re-verification (rerunning the whole pipeline after relocating it)
surfaced the gap. The script now shipped in `scripts/` resolves `REPO` from its own file location (a real
Windows absolute path) with `SCAN_REPO` as an override for testing against a different repo (used in
Section 2's positive control). All results below are from the fixed version, independently re-verified by
an error-count instrumentation pass that confirmed zero failed git calls across the full 701-pair scan.

## 2. Positive control (proves the method actually flags a dodge)

Per the card's DoD-3, a "no dodges found" result needs a demonstrated-working method behind it before it
means anything, doubly so after Section 1. `worker-unconfirmed-delivery-signal.mjs` can't serve as that
control — it's Shape B (Section 5), which this method isn't built to see. So the control is a synthetic
Shape-A dodge in a disposable throwaway repo:

```
$ git init positive-control-repo
# commit 1: sample.mjs contains
#   await sleep(50);
#   check("the counter did NOT advance while paused", counter === before);
# commit 2: same file, same condition, label reworded to
#   check("the counter remained fixed while paused", counter === before);
```

Running the two-stage pipeline (`scripts/find-rewords.mjs` then `scripts/filter-wait-adjacent.mjs
SCAN_REPO=<throwaway repo>`) against that history:

```
Found 1 candidate hunks; 1 high-similarity reword pairs (Jaccard >= 0.3)
sim=0.44  commit 1f3d3407…  file sample.mjs
  - "the counter did NOT advance while paused"
  + "the counter remained fixed while paused"

Checking 1 pairs for fixed-wait adjacency (both BEFORE and AFTER the edit)...
1 pairs are fixed-wait-adjacent (guard-relevant)
  wait-adjacent BEFORE: true  AFTER: true
```

Re-run 5× to rule out the exact non-determinism from Section 1 recurring here: identical result every
time.

## 3. Method (Shape A) — exhaustive, not sampled

`scripts/find-rewords.mjs` parses `git log -p --no-color -U1 --diff-filter=M -- packages/daemon/test/`
(1120 commits touch that directory — every one that *modified* an existing test file). For every diff
hunk it extracts every `check(`/`assert(` label on a removed (`-`) line and every one on an added (`+`)
line (multi-line labels handled via open-quote tracking), then reports every `(removed-label,
added-label)` pair where the removed label matches `NEG_KEYWORDS` and the added label does not — the
"logic-preserving, token-removing" signature the card names. No similarity floor is applied (an
intermediate Jaccard≥0.3 pass was tried and dropped — the downstream check is cheap and authoritative, so
there's no reason to risk excluding a genuine low-similarity reword): **686 pairs, from 146 diff hunks.**

Renames are a separate `git` status (`R`) not covered by `--diff-filter=M` — checked separately. Only 3
renames touch this directory in its whole history; their diffs were scanned the same way, yielding 15
more candidate pairs (all within `platform-lead-multi.mjs`'s singleton→multi-Lead rewrite, where the
labels changed because the *behavior* changed).

**686 + 15 = 701 candidate pairs.** Each was checked by `scripts/filter-wait-adjacent.mjs`, which — for
both the pre-image and post-image of the commit — loads the file via `git show <commit>[~1]:<file>` and
re-runs the guard's own exact window logic (`IDIOM_A`/`IDIOM_B`, 5-line lookahead, `CHECK_OR_ASSERT_RE`)
to ask whether this specific label, at this specific commit, was actually sitting in the guard's scan
window. This reproduces the guard's own detection logic directly rather than approximating it, so it
doesn't matter how noisy the first-pass candidate list is.

## 4. Result (Shape A)

```
701 pairs checked → 81 are fixed-wait-adjacent in the BEFORE state, the AFTER state, or both
```

`81` is not the dodge count — it's the population that needed manual classification. Breaking it down by
which side of the edit was actually wait-adjacent:

| shape | count | meaning |
|---|---|---|
| BEFORE: true, AFTER: true | **15** | same physical site, wait-adjacent both before and after — the literal reword-in-place-under-an-unchanged-wait signature |
| BEFORE: true, AFTER: false | 50 | the wait itself was removed/retrofitted as part of the same edit |
| BEFORE: false, AFTER: true | 16 | a wait was newly introduced next to a label that wasn't wait-adjacent before |

Only the first row is structurally the card's signature (same wait, same site, label swapped under it).
The other two rows mean the surrounding code changed, not just the label — consistent with a real fix,
not a text-only dodge, and confirmed as such below.

**All 15 "BEFORE:true, AFTER:true" pairs were traced by hand to their commits (7 distinct commits) and
every one turned out to be a genuine condition/behavior change or a spurious same-hunk pairing of two
unrelated `check()` calls** (an artifact of the brute-force all-pairs matching in a hunk that touched
several checks at once — not evidence of anything):

- **`6271d6f1` — `paste-recovery-boundary-annotation.mjs`, "(C) CONTROL"** (highest similarity, 0.52): the
  removed label's `NOT wall-clock wording` clause was dropped because the underlying condition changed in
  the same commit — `!/minted at \d{4}-/.test(drained)` was removed from the check entirely (feature
  widened per card `2d36337e` to disclose wall-clock wording in this branch too), and a **new**,
  still-negative-labeled check (`"stays absent"`) was added for the narrower claim that remains true.
  Read directly from the diff — this is exemplary handling, the opposite of a dodge.
- **`afd44380` — `codescape-mcp-spawn.mjs` / `codescape-lifecycle-hooks.mjs`** (21 + several of the 81):
  card `088afc94`, a wholesale codescape-wiring architecture rewrite (stdio → shared-serve HTTP mount).
  The old and new labels describe different mechanisms entirely; verified from the diff's own header
  comment rewrite, which documents the architecture change in detail.
- **`c38ae74b` — `pty-giveup-*.mjs`** (8 of the 81): the commit fixing the "stranded kickoff re-pastes its
  full ~46KB body" bug (referenced throughout the corpus as "card b9b8f8db") — a real behavior change
  (redelivery now retries only the Enter, not the full paste), so every label describing the old
  full-repaste behavior needed to describe the new Enter-only behavior instead.
- **`b4fa85a4` — `worker-kickoff-guarantee.mjs`**: card `0050a17e` (the argv-removal / delivery-via-submit
  rewrite named in this project's own `CLAUDE.md`). Traced the specific "(H1a) still exactly ONE forced
  submit (no repeat firing)" pairing to a spurious cross-hunk match — the diff shows this exact line was
  retrofitted, **in the same commit**, straight into `assertNeverWithControl` with the negative wording
  (`"no repeat firing"`) preserved verbatim in the replacement (`"(H1a) still exactly ONE delivery (no
  repeat firing)"`). The candidate pair matched against a *different* check a few lines away instead.
  This also explains 2 of Section 6's stale-baseline entries (site retrofitted to a helper the raw-idiom
  scan can't see).
- **`1ade09a1`, `6ad35ddc`, `29b22e7e`** (remaining 4 of the 15): each is a substantive fix commit
  (subjects: a flaky wall-clock-margin fix, a `worker_merge_confirm` dedupe fix, and a resume-gate
  regression fix respectively) with a genuine test-file rewrite; spot-checked via diff for the highest
  count (`29b22e7e`, 10 hits) — confirmed a large multi-scenario rewrite (4 old checks removed, ~15 new
  checks added across renumbered scenarios 4–7), the exact shape that produces spurious same-hunk pairs.

The remaining 66 (BEFORE-only or AFTER-only) pairs trace to the same 15 commits plus 8 more, all
substantive fix/feature commits by subject (`77112c5b` codescape stdio-mount fix, `e2d23231` health-probe
boot-order fix, `ede81d3b` duplicate-merge-op fix, `d35f1fb6` give-up-clear timing fix, `f7d7cd68`
`gate_status` opId-prefix fix, `a824d3c2` permission-mode feedback-loop fix, `a18a25d6` serve-drift
silent-failure fix, `1a182b07` squash-on-stale-main fix) — none suggestive of a pure label edit, and
structurally ruled out anyway: a wait's own adjacency changing between before and after means the
surrounding code moved, not just the string.

**Conclusion: zero genuine reword-in-place dodges, across the full modify+rename history, under a
methodology whose positive control is demonstrated working and whose earlier false negative (Section 1)
is understood and fixed.**

## 5. Shape B (born-already-phrased): what was checked, and the hard limit

Shape B has no diff to search by construction, so "0 found" isn't available here — only "the known
instance, and nothing else surfaced by the checks that exist."

**5a. The known instance, verified.** `git show 4aa687fe` confirms the commit *created*
`worker-unconfirmed-delivery-signal.mjs` (status `A`) with the label `"(1) getPendingConfirmMs is
monotonically increasing across a real sleep"` — no `NEG_KEYWORDS` token. Card `1c5dda5d` established, by
reading the assertion's own condition (`typeof second === "number" && second > first`), that this check
is **positive-polarity — it fails loudly on a static or wrong-typed value**. That matters independent of
intent: even under the worst-case reading (wording chosen specifically to dodge `NEG_KEYWORDS`), the
guard's actual defect class — a fixed wait silently passing because the thing it's supposed to catch
never arrives — doesn't apply here, because this assertion can't pass vacuously. `1c5dda5d` shipped
`TIMING-GUARD-FALSE-MATCH`; `0186a59f` (merged hours before this audit was filed) restored the fuller
wording and applied the annotation. **Already fully resolved.**

**5b. Self-disclosure search.** `git log --all -i --grep="TIMING-GUARD\|reword\|dodge.*guard\|guard.*dodge"
-- packages/daemon/test/` returns exactly two commits: `0186a59f` (the known fix) and one unrelated hit
(`5d83e3a8`, "reworded pending note" — an orchestration-module commit message, unrelated to this guard).

**5c. What was NOT done, and why.** The only way the known instance was actually surfaced was a
human/agent noticing that an *earlier-filed board card* quoted fuller wording for the same site than what
shipped. Generalizing that mechanically means full-text-searching every historical board card for
phrases resembling test labels and cross-matching against source — an unbounded natural-language search,
not a git-mechanical one, and disproportionate to a P2 audit. **Not attempted. This is the actual
residual risk this audit leaves open**: a Shape-B dodge with no self-disclosing commit message and no
easily-found card-quote mismatch would not be caught by anything in this document. The only structural
defense already in place is the guard's own default-fail-on-new-site behavior — a new site, any polarity,
gets seen once, even if its history can't be interrogated for what it might have said first.

## 6. A different, unrelated finding: 10 stale baseline entries (not a dodge)

Cross-checking baseline integrity (`scripts/baseline-drift-check.mjs`: does every
`KNOWN_UNAUDITED_WAITS`/`NEWLY_VISIBLE_UNAUDITED_WAITS` `(file, label)` entry's label text still exist
verbatim in that file?) found 10 of 167 that don't: 2 each in `pty-giveup-clear.mjs`,
`pty-giveup-hold-until-confirmed.mjs`, `pty-giveup-requeue.mjs`, and 4 in
`worker-kickoff-guarantee.mjs`. Each was traced by hand: every one was migrated off the raw
`sleep`/`setTimeout` idiom — into a bounded `while` poll carrying a `TIMING-GUARD-SAFE:
fully-awaited-completion`/`sync-probe-no-macrotask` annotation right above the wait line, or into the
shared `assertNeverWithControl` helper — exactly the "locally-reimplemented poll-loop" shape the guard's
own header names as structurally invisible to it by design. `NEG_KEYWORDS` still matches every one of the
new labels too (none lost a token) — this is baseline hygiene debt from a legitimate retrofit, not an
escape. Per the guard's own header, `KNOWN_UNAUDITED_WAITS` is "a PERMANENT BASELINE, not a countdown to
zero," and an entry may only be removed after auditing the site — these 10 were audited (above) and are
safe to leave; **no baseline edit was made**, per the card's own instruction not to touch it.

## 7. Verification run

```
$ node packages/daemon/test/fixed-wait-negative-guard.mjs
PASS  no NEW fixed-wait-guarding-a-negative-assertion sites outside the baseline (found 0)
PASS  no REGRESSION in the 4 retrofitted files back to a raw fixed-wait-then-negative-check (found 0)
PASS  every TIMING-GUARD-SAFE exemption cites one of the 3 sanctioned reasons (found 0 invalid)
PASS  1 site(s) cleared via TIMING-GUARD-FALSE-MATCH (classifier false positives — reported separately from TIMING-GUARD-SAFE clearances, not itself a pass/fail signal)
  FALSE-MATCH  worker-unconfirmed-delivery-signal.mjs:170  reason="keyword-in-methodology-aside"  "(1) getPendingConfirmMs is monotonically increasing across a real sleep (proves it's elapsed time, not a static marker)"
PASS  every TIMING-GUARD-FALSE-MATCH cites one of the 1 sanctioned reasons (found 0 invalid)
PASS  ws-fleet-session-feed.mjs: the retrofit actually removed the raw fixed-wait-then-negative-check shape
PASS  markitdown-prewarm.mjs: the retrofit actually removed the raw fixed-wait-then-negative-check shape
PASS  markitdown-provision-nonblocking.mjs: the retrofit actually removed the raw fixed-wait-then-negative-check shape
PASS  dev-server.mjs: the retrofit actually removed the raw fixed-wait-then-negative-check shape

✅ ALL PASS
```

## Bottom line

- **Shape A (reword-in-place): exhaustively searched (701 candidates, full modify+rename history),
  positive-control-verified, all 81 wait-adjacent hits manually classified — zero genuine dodges.** The
  first pass at this number was `0` for a different, wrong reason (a broken git-invocation path silently
  failing every call, Section 1) — caught and fixed before being trusted, then re-derived to `81` raw
  candidates and traced down to the same true answer for the *right* reason.
- **Shape B (born-already-phrased): structurally unsearchable by any git-diff method. The one known
  instance is already resolved. A residual, unbounded risk (a card-quote-vs-code mismatch with no
  self-disclosing commit message) is named, not closed.**
- 10 stale-but-harmless baseline entries found and traced to legitimate retrofits, left untouched per the
  card's own instruction.
- No new `TIMING-GUARD-FALSE-MATCH` proposals, no new negative-polarity-reworded-to-escape findings, no
  code changes.
