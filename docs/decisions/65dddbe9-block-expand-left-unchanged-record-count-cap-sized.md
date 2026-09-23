# 65dddbe9 — BLOCK_EXPAND_MAX left unchanged; MAX_RECORDS_PER_CALL sized at 10

## Narrative

Card `a475f698` (the 09-12 research note) proposed three cost-reduction levers for
`packages/daemon/assets/decision-records.mjs`'s injection hook. Lever #1 (guard-only injection, `27ee9f43`)
already shipped. This card (`65dddbe9`) was dispatched to implement levers #2 (narrow `BLOCK_EXPAND_MAX`)
and #3 (a per-call record COUNT cap, orthogonal to the existing `TOTAL_MAX_BYTES` byte cap) — but only
after a fresh measurement, since `docs/investigations/6d16606e-decision-record-injection-cost-post-guard/
findings.md` had already flagged both as unproven and card `a475f698`'s own body never gave target values.

**Lever #2 measured and SKIPPED.** A corpus-wide scan mirroring `expandStartToBlock`'s own upward-walk
logic (1,873 anchor sites, same source roots as `6d16606e`'s own harness) found: block-span-to-blank-line
p50=13, p90=195, p95=397, max=1,134; 551/1,873 (29%) already exceed today's 40-line cap unbounded.
Cross-referenced against `6d16606e`'s own findings: for the dominant targeted-50-line-read population the
byte cap is already UNREACHABLE (0/150 samples hit it, and even the single densest 50-line window in the
whole corpus — `packages/daemon/src/deploy-staleness.ts:41-90`, 13 candidate ids — came in at 9,341 B,
under the 12,000 B cap) — block expansion isn't the bottleneck there at all. For the whole-file-read-into-
a-hot-file tail case (`sessions/service.ts` 544 anchor sites, `pty/host.ts` 351), the literal in-window
anchor count alone already saturates `TOTAL_MAX_BYTES` regardless of block expansion. No scenario in the
current corpus shows narrowing `BLOCK_EXPAND_MAX` produces a measurable cost win, while narrowing it risks
silently missing a legitimate anchor-to-code catch (this file's own `PER_RECORD_MAX_BYTES` comment block
needs ~24 lines of upward reach from its declaration line). Owner ruling (relayed by the manager on this
card): leave it at 40.

**Lever #3 implemented, sized at 10.** `MAX_RECORDS_PER_CALL` bounds the NUMBER of records a single call
injects, applied as an earlier trim on the candidates list (same scan order the existing byte-budget drop
already used) BEFORE the budget loop — candidates beyond position 10 are omitted for record count, never
entering the budget competition at all. Sizing source: `6d16606e`'s 150-sample records-per-call
distribution — `{1:32,2:32,3:28,4:18,5:9,6:14,7:4,8:5,9:5,10:2,12:1}` — 60% of calls inject <=3 records;
10 only bites the >90th-percentile tail (the samples at 10 and 12).

**Effect on the tail case, measured before/after** (default whole-file `Read`, no offset/limit, invoked
directly against this branch's tree; "before" is the asset temporarily reverted to `HEAD` and re-run, then
restored byte-for-byte — same method as the negative-control proof below):

| file | records injected (before → after) | records omitted (before → after) | injected bytes (before → after) |
|---|---|---|---|
| `packages/daemon/src/sessions/service.ts` | 12 → 10 | 31 → 33 | 14,780 B → 10,185 B |
| `packages/daemon/src/pty/host.ts` | 11 → 10 | 26 → 27 | 14,341 B → 12,385 B |

Byte-budget omission (`TOTAL_MAX_BYTES`) is no longer the reason anything is omitted for either file after
this change — both drop to `omittedForBudget: 0`; every omission is now `omittedForCount` (the new cap).
Slightly different injected/omitted counts than `6d16606e`'s own same-file measurement (12/14,863 B and
14/14,079 B) reflect ordinary corpus drift since that measurement, not a methodology difference.

**Bounded the omission note itself.** Before this card, BOTH existing omission notes (the shared-budget
"further record(s) omitted" note in the normal path, and the "too large to inject" note in the
all-candidates-failed defensive branch) named every omitted record's path via an unbounded
`.map(...).join(", ")` — pre-existing, unrelated to lever #3's own correctness, but the exact same failure
shape lever #3's own omission note would have had if built independently (a whole-file read of
`sessions/service.ts` can omit 30+ records; naming every path is itself kilobytes). Fixed once, in a single
shared `buildOmissionNote` helper (bounded by `OMISSION_NOTE_MAX_LISTED`, lists the first N ids/paths then
`+K more`, always states the total omitted count), used by both the pre-existing byte-budget note and the
new record-count note — not forked.

## Do not

- Do not narrow `BLOCK_EXPAND_MAX` below 40 without a fresh measurement showing a real scenario it would
  help — see the corpus-wide numbers above; none exists in today's corpus.
- Do not raise `PER_RECORD_MAX_BYTES` or `TOTAL_MAX_BYTES` — unrelated to this card and separately
  forbidden by the owner's answer to request `a0155873` (card `8449a258`).
- Do not fork `buildOmissionNote` into a count-specific and a budget-specific copy — both omission reasons
  route through the SAME helper so a future bound change (or bug fix) can't quietly diverge between them.
- Do not assume `MAX_RECORDS_PER_CALL` and `OMISSION_NOTE_MAX_LISTED` must stay equal — they answer
  different questions (how many records to inject vs. how many omitted ids to name in one note) and were
  only set to the same value (10) because that was a reasonable first pick for both, not because they're
  coupled.

## Source

`packages/daemon/assets/decision-records.mjs`: `MAX_RECORDS_PER_CALL`, `OMISSION_NOTE_MAX_LISTED`,
`buildOmissionNote`. Card `65dddbe9` (child of epic `f69cabc7`, sibling of `a475f698`/`6d16606e`). Measured
against this branch's tree; re-derive before trusting the specific byte/count figures above if the corpus
has since changed materially.
