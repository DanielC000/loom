# e3faa8ac — fixed-wait-negative-guard's polarity scope: findings

Worker investigation, 2026-08-06. **Measurement only, per the manager's explicit decision on the
checkpoint below — no production or test code was written.** `filesChanged` for this task is this
document plus the scanner (`scripts/scan-positive-polarity.mjs`), its captured output, and the recovered
specimen snapshot used for the positive control. `packages/daemon/test/fixed-wait-negative-guard.mjs` and
every other test file are untouched — `git status` on this branch shows only the new `docs/` directory.

## The question

`fixed-wait-negative-guard.mjs` scans `packages/daemon/test/*.mjs` for a fixed-duration wait
(`sleep(N)` / `new Promise(r => setTimeout(r, N))`) immediately followed by a check()/assert() whose
label reads as a NEGATIVE-polarity claim ("never", "not", "no", "zero", ...). It is deliberately scoped to
that polarity only. The wait that actually reddened a live merge gate (op `12040557`, card `81a6e4e1`,
fixed in commit `003a1080`) guarded a **POSITIVE** assertion instead — `surfacedCount === 2` — and was
structurally invisible to the guard, whether or not it was run.

Card `e3faa8ac` asked, before any code change: how many positive-polarity fixed-wait sites exist in the
real corpus, and — the harder question — how many of those are actually **load-bearing** (the wait's own
duration can flip the assertion's outcome) rather than a safe settle/cleanup wait before a stable check?

## Method

A standalone scanner (`scripts/scan-positive-polarity.mjs`, re-runnable, not wired into any gate) mirrors
the shipped guard's own methodology — same `IDIOM_A`/`IDIOM_B` wait-shape regexes, same 5-line
check()/assert() window — but inverted to flag **positive**-polarity labels instead of negative ones. It
adds a stricter second pass on top:

- **TIER 1 (broad):** every fixed-wait site immediately followed by a positive-polarity check(). This is
  the naive "widen the polarity scope" superset — literally the shipped guard's own regex, polarity
  flipped. DoD-3 on the card explicitly warned against shipping this as an enforced guard ("a guard that
  flags every `sleep()` in the suite trains people to baseline it, which is worse than the gap").
- **TIER 2 (load-bearing candidate):** the TIER 1 subset where the wait's enclosing block — bounded by the
  nearest blank line above/below, not a fixed line-radius (see "Method refinement" below) — also carries
  one of two signals that the wait is genuinely racing another timing quantity:
  - `second-clock`: a numerically **larger** duration inside another `sleep(...)`/`setTimeout(...)` call in
    the same block. Requires the primary wait's own duration be the smaller number — see "Direction, not
    polarity" below for why that direction matters.
  - `in-flight-promise`: a variable assigned from an unawaited call before the wait line, referenced again
    (in an `await`/`Promise.all` context) after the check — a promise deliberately left running across the
    wait.

Run from repo root: `node docs/investigations/e3faa8ac-fixed-wait-polarity/scripts/scan-positive-polarity.mjs`.
Both signals are heuristics with known false-positive modes (see below) — **TIER 2's number is "what this
heuristic flags", never "how many load-bearing waits exist."** Keep that distinction attached to the
number, not just to this document.

### Method refinement (why the block boundary isn't a fixed radius)

The first version of `second-clock` used a fixed ±25-line radius around the wait. Run against the
recovered specimen (below) alone, it flagged 23 of that one file's 26 TIER-1 sites (~88%) — the exact
"flags every `sleep()`" failure mode DoD-3 warned about, because a ±25-line window in a densely-packed
test file routinely bleeds into an adjacent, unrelated test case's own unrelated duration constant.
Scoping the radius to the blank-line-delimited block the wait actually sits in (this codebase's test
cases are consistently separated by a blank line, even where they aren't also wrapped in a bare `{ }`)
cut that same file's count to 15/26, and requiring the primary wait be the numerically *smaller* of the
two durations (see next section) cut it further to 10/26. This is still an approximation — a block can
still hold more than one unrelated wait — named as a limitation, not hidden.

## Direction, not polarity

The real specimen (recovered from git history — the parent of `003a1080`, commit `abc00f1d`,
`packages/daemon/test/pending-ops-registry.mjs:198-207` at that revision):

```js
const slow = async () => { await sleep(80); return { ok: true }; };
const p1 = reg.attach("surf2", "gate", "mgr1", 10, slow, undefined, { onSurfacedPending: () => surfacedCount++ });
await sleep(20);
const p2 = reg.attach("surf2", "gate", "mgr1", 10, slow, undefined, { onSurfacedPending: () => surfacedCount++ }); // re-attach, still running
await Promise.all([p1, p2]);
check("(onSurfacedPending repeat) fires once per call that observes 'still pending' — idempotent-upsert-friendly", surfacedCount === 2);
```

`sleep(20)` is a SHORT probe wait, used to assert "p1 is still pending" while `p1`'s own internal
`sleep(80)` is in flight. Under host load, `sleep(20)` can overrun past 80ms — by the time it resolves,
`p1` may have already settled, and `p2`'s `attach()` takes the fast path instead of surfacing pending,
leaving `surfacedCount` at 1. The assertion flips.

Contrast a structurally similar-looking but **safe** site in the same file
(`pending-ops-registry.mjs:301`, current tree):

```js
const r = await reg.attach("m1", "merge", "mgr1", 200, async () => ({ merged: true }), undefined, { retainMs: 50, classifyOutcome: classify });
...
await sleep(70); // past retainMs
check("(retain) the retained view expires after retainMs — peek() reverts to undefined", reg.peek("m1") === undefined);
```

`sleep(70)` is used to guarantee at least 70ms of real time has passed, past a 50ms `retainMs` expiry.
`setTimeout`/`sleep` is a **floor**, never a ceiling — additional host load can only push the actual
elapsed time further past 70ms, never closer to violating the 70 > 50 relationship. This wait cannot flip
its assertion under load; more delay only makes the assertion *more* true.

**The discriminator is not "positive vs. negative assertion" — it is DIRECTION: is the fixed wait the
SHORTER of two racing clocks (risky — overrun can invert the ordering), or is it proven to EXCEED a
threshold it must pass (safe — overrun only widens the margin)?** This is why TIER 2 requires the
primary wait's own numeric duration be strictly *smaller* than the other duration found nearby, not just
"a second duration exists nearby."

## A known, un-fixed false-positive mode

The `in-flight-promise` signal accounts for 71 of TIER 2's 90 sites (56 alone + 15 combined with
`second-clock`) — the majority signal. It has a demonstrated false-positive mode: the "referenced again
after the check" test is a bare regex word-boundary match against the **entire** text from the wait line
to the end of the block, which includes every subsequent check()'s **label string** — plain English
prose, not code. A variable named `retained` assigned before a wait, followed by a later check() whose
*label text* happens to contain the English word "retained" ("the retained view expires..."), matches the
same regex as a real code reference to that variable. This is the same family of failure as the shipped
guard's own `NEG_KEYWORDS` prose-match trap (card `1c5dda5d`) — a bare keyword/identifier match inside an
assertion's human-readable label, not its code. **This was not fixed here** — TIER 2's count should be
read with that caveat attached; a real audit of the 71 `in-flight-promise` sites would need to separate
genuine variable references from this prose-matching artifact by hand.

This false-positive mode is a specific instance of a class already tracked on card `743be0c9`
("fixed-wait-negative-guard scans comment text as if it were code") — a text-pattern scanner matching
assertion prose or comment content as if it were executable code. This scanner independently reproduced a
sibling instance of that same class while measuring a different card's question, which is itself part of
the finding — see "Outcome" below.

## Positive control (both directions)

- **Fires on the known-bad state:** scanning the recovered pre-fix specimen
  (`scripts/pending-ops-registry.pre-003a1080.mjs.specimen`, `git show 003a1080^:packages/daemon/test/pending-ops-registry.mjs`)
  flags line 203 (`(onSurfacedPending repeat) ...`) under **both** signals —
  `[second-clock,in-flight-promise]`. Raw output: `scripts/specimen-scan-output.txt`.
- **Silent on the fixed state:** the same site does not appear anywhere in the current corpus scan
  (`scripts/corpus-scan-output.txt`) — `003a1080` replaced the fixed `sleep(20)`/`sleep(80)` race with a
  manually-resolved deferred promise, removing the fixed wait entirely. Confirmed by grep: the string
  `"onSurfacedPending repeat"` does not appear in `corpus-scan-output.txt`.

Both directions checked, per this project's standing "prove your check can fail before you trust its
green" rule — the pass on the current tree is not just an absence of output, it's a confirmed absence of
a site known to have been removed.

## Raw results (packages/daemon/test, measured 2026-08-06)

**Instrument attached to every number below:** these come from `scripts/scan-positive-polarity.mjs`, a
scanner mirroring the shipped guard's own idiom/window methodology, inverted to positive polarity, run
against `packages/daemon/test`. Read "90" as "what this heuristic flags", not "how many load-bearing
fixed waits exist" — see the false-positive mode above.

- **TIER 1: 240 sites across 78 files.** Full per-file distribution and per-site detail in
  `scripts/corpus-scan-output.txt`.
- **TIER 2: 90 sites across 36 files.** Signal breakdown: 19 `second-clock`-only, 56
  `in-flight-promise`-only, 15 both.

Top TIER 2 concentrations:

| file | sites |
|---|---|
| pty-mode-convergence.mjs | 16 |
| pending-ops-registry.mjs | 9 |
| gate-semaphore-concurrency.mjs | 7 |
| pty-prompt-mismatch.mjs | 6 |
| companion-voice-enable-gate.mjs | 4 |
| worker-flush-composer.mjs | 4 |
| paste-placeholder-tripwire.mjs | 3 |
| worktree-process-reap.mjs | 3 |

Remaining 28 files carry 1-2 sites each — full list in `scripts/corpus-scan-output.txt`.

## Related prior work

`docs/investigations/bbada785-fixed-wait-enumeration/` independently enumerated positive-polarity
wait-then-check sites for a different card (merge-gate false-fail exposure) and reported **221** such
sites (of 413 total, both polarities) on its own branch/tree snapshot. That number and this
investigation's TIER 1 (240) are not the same measurement and should not be diffed against each other as
if they were: different git tree states (that investigation measured post-conversion of one specific
site, on a different day), and this scanner additionally skips `//`-comment lines before idiom-matching
(bbada785's did not) — a small methodological difference on top of the tree-state difference. Both are
"what a specific instrument counted at a specific commit", not a fixed population.

## Outcome

**Per the manager's decision: not widening the guard, and not scoping follow-up cards against 90 or
240.** This investigation's own result is the deliverable — it refutes the card's implicit premise that
polarity-widening plus a debt baseline was the right remedy, which is a stronger outcome than the fix the
card asked for. Chain: polarity is not the discriminator (direction is); the first, naive heuristic
reproduced the exact "flags every `sleep()`" failure DoD-3 warned about (23/26 in one file); and even the
tightened, direction-aware version still carries a 62%-of-TIER-2 prose-match false-positive mode — the
same failure class as the already-open card `743be0c9`, independently reproduced by this scanner while
measuring something else entirely.

That makes **five** independent scope/correctness defects now identified against
`fixed-wait-negative-guard.mjs` as a single static-scan instrument: `0f744aa4` (blind to
`observeOnce`/`windowMs` idioms), `743be0c9` (scans comment text as code), `4479e6f0` (stale baseline
metadata), this card (blind to a whole polarity class), and this investigation's own reproduction of
`743be0c9`'s failure class inside a from-scratch heuristic aimed at a different problem. A sixth regex
patch is not the recommended next move; the manager is filing a separate design card for a
condition-driven-wait requirement (building on the existing `_wait.mjs` `waitUntil` helper and card
`22796d42`'s already-stated migration direction) rather than a further scan-and-baseline iteration on this
file. This document exists so the measurement survives past this worktree — re-run
`scripts/scan-positive-polarity.mjs` if a future session needs to ask "is this still 240/90?"
