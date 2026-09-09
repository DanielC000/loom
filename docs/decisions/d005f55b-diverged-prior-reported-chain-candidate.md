# d005f55b — the diverged-prior candidate reuses the PRIOR generation's REPORTED signature

⚠️ Spans FOUR decisions, all in `pty/host.ts`'s composer-accumulation family: this (§1),
`findRecognizedSubstring` (§2), `fnv1a32Continue` math (§3), wrapper deficit (§4). Tightened to fit the
cap, every number/id preserved (card `6de8956e`).

## §1 — Narrative

The SEPARATE, ADDITIVE candidate the card's fix direction names. `detectComposerAccumulation` can never confirm a fusion whose PRIOR generation's reported echo had ALREADY diverged from what Loom wrote — it sums `recentWrittenTurns` (WRITTEN), but the real state is SUBMITTED (`reported(gen11) = written(gen11) + reported(gen10)`, not `+written(gen10)`, once gen10's report mismatched). Tries ONE narrower candidate: the preceding RECORDED generation's REPORTED signature (never written) plus the CURRENT write's WRITTEN text — still exact-sum/exact-hash, since `fnv1a32Continue` (§3) reconstructs the hash from the prior entry's hash alone; only widens WHICH prior signature may be reused.

Deliberately narrow — one two-entry candidate, not a multi-span search. Regression fixture (gen=10/gen=11: written 1893/1126, reported 2161/3287, n=1) names this shape; a real-corpus sweep found the SAME equation — `reportedLen(N) == writtenLen(N) + reportedLen(prior gen)` — satisfied by 80/362 mismatches (~22%), 6 rotations of `daemon-output.log`. A multi-generation chain (prior-of-prior) is unestablished by this one-hop sweep, left as follow-up.

### Do not

- Do not widen to a multi-generation REPORTED chain on this sweep alone — the ~22% figure only checked one hop back.

## §2 — `findRecognizedSubstring` names a recognized write, never confirms

### Narrative

The card's floor item — mergeable even if §1/§3 are deferred. Tried ONLY once every exact-match candidate above (`replayedEntry`, `detectComposerAccumulation`, §1) has refused. Tests whether `reported` CONTAINS a recorded write as a SUBSTRING ANYWHERE — no new mechanism: names what WAS recognized so a caller can scope the LEADING/TRAILING remainder, instead of "could not be matched at all" reading the same whether zero or nearly all bytes are explained.

NOT edge-anchored (an earlier draft tried only `startsWith`/`endsWith`, missing the motivating gen=4 specimen: `<26ch placeholder><gen3's full text><gen4's own text>` — gen3's write sits SANDWICHED mid-string). Uses `indexOf`, reports BOTH remainders.

`window` EXCLUDES the current generation's just-pushed entry (`recentWrittenTurns.slice(0, -1)`, mirroring `priorEntry`'s `length - 2` exclusion) — that text is almost always a trailing substring of `reported` in a fusion mismatch, so including it would trivially "recognize" the caller's own turn.

Checked most-recent-first (`findLast` precedent); only the FIRST hit returned — a diagnostic aid, not a census.

### Do not

- Do not pass the current generation's just-pushed entry inside `window` — trivially "recognizes" the caller's own current turn. Do not treat a "no hit" result, or this output, as a confirmation — it only NAMES what was recognized.

## §3 — `fnv1a32Continue` extends a hash without the prefix's bytes

### Narrative

Extends a fnv1a32 hash already computed over prefix A with trailing text B, producing exactly `fnv1a32(A + B)` — WITHOUT needing A's own bytes, only its already-computed hash (fold ops are ToInt32-evaluated regardless of signed vs. `>>> 0` unsigned form, so continuing on B from the parsed hex yields the identical bit pattern: verified `fnv1a32Continue(fnv1a32(A), B) === fnv1a32(A + B)` for every sampled pair, incl. §1's gen=10/gen=11 lengths).

Lets `Live.recentReportedTurns` retain only each generation's REPORTED length+hash, never full text (matches `Live.ambiguousDispatches`'s discipline), supporting §1's "reported(prior) + written(current)" candidate.

## §4 — a possible-duplicate wrapper deficit is a stale-echo artifact, not loss

### Narrative

Manager LIVE evidence (sessions `494db005`/`f6eeeb52`, 2026-08-06) CONFIRMS Candidate #3 ("a Loom redelivery wrapper", PLAUSIBLE/UNVERIFIED in the card body) as a real foreign-content source — but a DEFICIT, not a fusion: both specimens had `reported` SHORTER than `intended` by EXACTLY 40 chars (`divergesAtChar=0`, `lenDelta=-40`) — `POSSIBLE_DUPLICATE_TAG_RE`'s fixed match length regardless of root-id (`"[loom:possible-duplicate root:"` (30) + 8 hex + `"] "` (2) = 40, verified). `intended` STARTS WITH the tag; `reported` equals it stripped, byte-for-byte.

CORRECTED MECHANISM (2026-08-06, card `854d1632` — supersedes an earlier "does not establish whether the tag reached the engine" framing): the wrapper DOES reach the engine, echoed byte-identically ordinarily — verified via `[submit-write]`/`[prompt-echo]` pairs (`len=written+40`, `byteIdentical=true`). The `-40` specimens are a STALE, OUT-OF-ORDER confirmation: the hook belongs to an EARLIER bare write, but by arrival `live.lastPrompt` has advanced to a LATER wrapped re-mint — ATTRIBUTION/ORDERING, NOT loss.

Only NAMES the byte-pattern (strengthens §2) — must NOT be worded as a loss/deficit. Reuses `stripPossibleDuplicateFrame` (no new matcher): fires ONLY when stripping the tag from `intended` produces `reported` EXACTLY.

### Do not

- Do not fold this into §1/`detectComposerAccumulation` — orthogonal (those are always LONGER; this is a deficit). Do not chase the wrapper's delivery path from here (tracked separately, card `854d1632`), and do not word this function's output as a loss/deficit.

## Sources

All four docs live in `pty/host.ts`: §1 `detectComposerAccumulationOverDivergedPrior`, §2 `findRecognizedSubstring`, §3 `fnv1a32Continue`, §4 `detectPossibleDuplicateWrapperDeficit` (its two guard clauses stayed inline per CLAUDE.md's class-A rule). All relocated by card `a4818d7a`; folded into one record by card `6de8956e`.
