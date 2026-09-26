# c06f876a — the solo merge verdict cache identity is (branch tip, main tip), so a rejection is re-gated once main has advanced

## Narrative

`worker_merge_confirm`'s until-superseded verdict cache (card `1555e361`) keyed on the branch tip only, so a cached REJECTION replayed after canonical main moved: "red because main was broken, main got fixed, re-call" returned the stale red unless the manager knew to pass `forceRemoveWorktree:true`. Card `8b1fb28f` pinned this as "PIN, not endorsement"; this card flips it.

The identity is now `<gatedTip>|main:<mainSha>|mergeGate:<on|off>`. Stored side: the mainline tip is captured in `captureGatedTip` at the SAME point as `gatedTip` (right before the FINAL gate spawn) — the main the gate actually ran against, not the main read at confirm start (they can differ across a forward/retry) — and surfaces as `ConfirmMergeResult.gatedMain`, stamped only alongside `gatedIdentity`. Re-call side: read fresh before the dedupe decision. Both sides use ONE resolver, `readMainlineHead` (`git/mainline-watch.ts`, `canonicalGit`). Any read failure is `undefined`: an unstamped verdict / an identity that never hits, i.e. a re-gate (the safe direction, same as the tip). An identity minted without a `|main:` segment (older format) never equals a new one, so it reads as a MISS. The cache is process-local, so nothing persisted needs migrating.

A same-commit re-call whose main segment differs is announced as `supersededBy:"main-advanced"` (with `cachedVerdictMainTip`/`currentMainTip`); a branch-tip change stays `identity-mismatch`. The registry only compares opaque strings, so the relabel is done in `confirmWorkerMergeTracked`. The batch path (`merge_batch`) keys on its own identity string and is unchanged.

**Why 1555e361 is not reopened:** its concern is a re-call with NOTHING new laundering a flaky red into green. A plain re-call with nothing moved is still a cache hit. Main advancing is a new input, like the worker pushing a commit: the tree the gate would test differs.

**Accepted cost:** on a busy main, ANY landing by any worker (docs-only included) re-gates a cached red on the next re-call — a real, multi-minute lane spend, bounded by the gate semaphore and announced via `main-advanced`. A red is replayed only while main is quiet.

99a1cf6f's never-cache-`stale-base` behaviour is untouched (that is main moving DURING the gate; this card is main moving AFTER a settled rejection). The mainline tripwire (card `4fa36502`) does not touch the identity.

## Do not

- Do not add a docs-only / relevance classifier to skip re-gating when main advanced. Whether a main change matters to the gate is exactly what the gate answers, and in this repo a docs-only commit can change the outcome (guards scan `docs/decisions`, text-scanning tests, the repo-wide EOL guard). A cheap classifier is unsound and adds a fail-open judgement surface.
- Do not read the main tip with a second resolver — store and compare through `readMainlineHead` only, or the two sides can disagree.
- Do not read the stored main at confirm start; it must be the main the FINAL gate ran against.
- Do not treat a failed main read as a match: `undefined` must re-gate.
