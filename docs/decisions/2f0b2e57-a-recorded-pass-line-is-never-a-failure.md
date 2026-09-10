# 2f0b2e57 — a recorded PASS line is never a failure, whatever words its own label contains

## Narrative

Card 2f0b2e57 (two real merge-gate rejections, both from this daemon's OWN test suite): a line recording a PASSING assertion — this daemon's own `check()` convention, `PASS  <label>`, optionally indented — must never be mistaken for a failure, no matter what words the passing assertion's own LABEL happens to contain. `FAILING_TEST_PATTERNS`' `UNCAUGHT`/`AssertionError`/`error TS\d+` tiers are all UNANCHORED (they match the keyword ANYWHERE in a line, not just at its start) — a real specimen (op `5b2075db`) hit this exactly: `merge-gate-single-file-retry.mjs`'s own retry-decoupling assertion is LABELLED `"the retry call names flaky-j (from failTierTest), never anything derived from the UNCAUGHT diagnostic string"` — a line describing the UNCAUGHT idiom in prose, which PASSED, was reported as the failing test.

`PASS_LINE_RE` is checked BEFORE any `FAILING_TEST_PATTERNS` tier is tried, so no tier — anchored or not, tier 0 or tier 3 — can ever win against a line that is itself a recorded PASS. The `FAIL`/`not ok` tier already can't match a PASS line on its own (it's anchored to the start of the line), but this guard makes the invariant FLAT and tier-independent rather than an accident of which tiers happen to be anchored today. It is applied in `scanLine` before `HARNESS_FAIL_WRAPPER_RE` is tried too, for the same reason, even though a PASS line can never actually satisfy that pattern (it never starts with the literal word `FAIL`).

## Known limitation, specimen 2 (left unfixed here)

Card 2f0b2e57, specimen 2 — a WEAKER hypothesis than the PASS-line bug (specimen 1) fixed above; not reconstructed from a raw stream, only observed as plausible. This daemon's own `test-daemon.mjs` runs failing files through a concurrent multi-lane pool, and every lane's output lands in the SAME combined stream `createFailingTestTracker` scans. "The LAST line matching the winning tier" therefore means "whichever lane's matching line was written last to the shared stream", not "the line belonging to whichever file the run ultimately blames". When more than one file's own FAIL-tier line is genuinely present, `failTierMatchCount() !== 1` already refuses the single-file merge retry on that ambiguity (`identifyRetriableTestFile`/`identifyRetriableTestFiles`) — but `result()`/`failingTest` (the DIAGNOSTIC field surfaced in `gateDetail`) carries no equivalent gate: it always returns *a* real matching line, with no guarantee it's the one `test-daemon.mjs`'s own end-of-run `FAILURES:` echo ultimately blames. Fixing this for real needs the test HARNESS to tag each lane's own lines with an attributable marker (a lane or file id) before they ever reach this scanner — a change to the test harness, not this tracker, and out of scope for this card.

## Do not

- Do not let any `FAILING_TEST_PATTERNS` tier (anchored or not) match against a line that also matches `PASS_LINE_RE` — check `PASS_LINE_RE` first, unconditionally, before any tier is tried.
- Do not assume an unanchored tier (`UNCAUGHT`/`AssertionError`/`error TS\d+`) is safe because it "looks like" a failure marker — a passing assertion's own prose LABEL can contain that same keyword and must still lose to the PASS check.
- Do not treat `result()`/`failingTest` as attributing a specific FAILING FILE under multi-lane concurrency — it only names a matching LINE, and the specimen-2 limitation above means that line can belong to the wrong lane when more than one file's FAIL-tier line is present.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `PASS_LINE_RE`: originally lines 180-194, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The "Known limitation, specimen 2" section above was originally part of `createFailingTestTracker`'s own JSDoc (lines 165-177 as of tranche 1's HEAD, commit `18bb69e3`); extracted here (rather than into the sibling `55cba5c5` record) by tranche 2 because it names this same card id.
