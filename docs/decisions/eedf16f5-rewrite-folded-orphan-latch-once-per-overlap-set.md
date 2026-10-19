# eedf16f5 — rewrite a folded orphan latch once per overlap SET, never once per token

`clearMergeQuarantineByKey`'s pending-filter "reduce" branch (`merge-quarantine.ts`) ties a pending twin P
to the active entry W being cleared whenever P shares an armed key or orphan-file reference with W. When
P survives holding a private token, the overlap tokens (every token in BOTH P's and W's current `tokens`)
are dropped from P and durably rewritten everywhere P is physically backed — including any folded orphan
latch file(s) named in `P.orphanLatchFiles`.

That orphan-file rewrite went through `rewriteOrphanLatchFilesAfterPartialClear`, called **once per
overlap token** (card `64119847`'s own accepted design — see that record's superseded bullet below). Its
ownership-confirming chokepoint (`orphanRewriteOwnershipConfirmed` → `orphanFileTokensAccountedForByUpdate`)
built `accountedFor` from `updated.tokens` (the already-reduced set) plus the SINGLE `clearedToken` passed
that call — never the other tokens also being dropped in the SAME reduce. Global tombstoning
(`tombstoneIfNotSurviving`) is deliberately deferred to ONE call at the very end of
`clearMergeQuarantineByKey` (decision `8db913e2` round 4), so it hasn't run yet while this loop executes —
the global `clearedTokens` fallback can't help either.

Result: whenever the overlap is 2+ tokens (W holds 2+ tokens that are ALSO in P's own set), every call in
the loop sees at least one of the OTHER overlap tokens still present in the orphan file's on-disk content,
unaccounted for — the write is refused ("keeping ... UNTOUCHED") on every iteration, deterministically,
every time. The orphan file is left stale forever at its original (pre-clear) token set. On the next
reboot, PASS 1 re-reads that stale file and re-arms the tokens that were already correctly lifted from W
and P in memory — the repo stays blocked until a human runs the broad clear.

Reachable only via the by-key/human routes (`clearMergeQuarantine`, `clearMergeQuarantineByRecordedPath`,
`clearMergeQuarantineLatchFile`'s active-match branch) — all three delegate to the same
`clearMergeQuarantineByKey` core, which can hold 2+ tokens on the active entry being cleared. The by-token
route (`clearMergeQuarantineByToken` → `clearActiveEntryTokenAtKey` / `clearTokenFromPendingIndices`)
never produces a 2+ overlap at this call site — each always clears exactly one already-known token.

## Fix

Widen the chain's third parameter from a single `clearedToken: string` to the full set of tokens THIS
call is dropping (`droppedTokens: ReadonlySet<string>`) — mirroring the existing sibling precedent,
`markedFinalFullyCoveredByClear(final, candidateTokens: string[])`, which already takes the plural shape
for the "final" (non-orphan) case. Call the chain **once**, with the complete `overlapTokens` set, instead
of looping, and ONLY when `overlapTokens.length > 0`. The two single-token callers
(`clearTokenFromPendingIndices`, `clearActiveEntryTokenAtKey`) pass a singleton set — byte-identical
behavior, proven never to hit the 2+ case (see above).

**Round 2 correction (Code Review finding 3):** the first draft of this fix called the chain
unconditionally — `rewriteOrphanLatchFilesAfterPartialClear(updated, writtenBasenames, new
Set(overlapTokens))` with no guard. A tied pending twin reduced through the KEY/ORPHAN-REF branches alone
(no shared token at all — scenarios 1/2's own shape, reached whenever an earlier by-token pre-pass has
already stripped every token the twin once shared) reaches this same reduce branch with `overlapTokens =
[]`. Pre-fix, the per-token `for` loop made ZERO calls on an empty array; the unguarded single call made
ONE call with an empty `droppedTokens` set — a write attempt the old code never made, contradicting
"byte-identical" for that shape. Fixed by gating the call on `overlapTokens.length > 0`, restoring the old
call-count exactly. See scenario 10's own proof below (byte-identical file content AND zero ownership-check
log lines, not merely "no visible damage").

## Why widening is safe (round 2 correction — do NOT cite token uniqueness)

Round 1 of this record argued safety from token uniqueness ("tokens are fresh `randomUUID()`s per raise,
never reused across independent raises, so two independent records have disjoint token sets"). **That
argument is FALSE and must not be cited.** The module deliberately copies tokens between what were
genuinely separate records: `unionQuarantineEntries` (~L815, `tokens: [...new Set([...older.tokens,
...newer.tokens])]`, invoked by `armQuarantineKey` whenever two DIFFERENT identities collapse onto the
same key at boot), `reconcileMarkedBasenameBeforeWrite` (~L1205, folds a key's own on-disk tokens forward
into the in-memory entry about to overwrite it), the protect copy-aside in
`protectOccupantContentBeforeDelete` (~L2103, builds a brand-new pending record directly from a DIFFERENT
occupant's on-disk tokens), and boot re-reads generally (two separate files on disk can legitimately carry
the same token at once, e.g. a final and its own dual-tracked pending twin, before either side has been
rewritten). Token identity is not an argument this fix can lean on.

The real argument is narrower and does not need uniqueness at all. For any SINGLE overlap token `t`, the
PRE-FIX code (the per-token loop, with `overlap = {t}`) already accepted the identical drop of `t` from F
— that is exactly what the pre-existing single-token path has always done, unaudited by this card. Calling
the chain once with the WHOLE overlap set, instead of once per element, adds no new class of token drop at
all — it only stops 2+ overlapping tokens from refusing each other's own write (each call's own
`accountedFor` previously missed whichever OTHER overlap token hadn't been passed yet THAT call). The
widening changes how many tokens are accepted PER CALL, never which tokens were ever eligible to be
dropped from F in the first place.

And dropping `t` from F never removes `t` from another record's own backing, by construction of two
PRE-EXISTING, unchanged mechanisms: `tombstoneIfNotSurviving` (~L360) tombstones a token into the GLOBAL
`clearedTokens` set only when it rescans the CURRENT live state of `activeQuarantines` AND
`pendingUnresolvedQuarantines` and finds NO surviving record — active or pending — still holding it; a
token any OTHER live record still carries is never tombstoned, so that record's own existence is
untouched by F's rewrite regardless. And layer (2) of the ownership chokepoint, `anotherLiveEntryOwnsFile`,
still guards F unconditionally as someone's own PRIMARY backing (its deterministic key-hash final, or its
own pending `sourceFile`) — unaffected by this widening, since it runs before layer (4) is ever reached and
doesn't look at tokens at all.

The one residual this leaves — F being some THIRD record's ONLY durable carrier of `t` via a NON-primary
(secondary, non-self) `orphanLatchFiles` reference — is not new. It is the SAME pre-existing shape the
single-overlap path always had: nothing about calling the chain once instead of N times changes what F's
own ownership-confirming layers (1)-(3) accept as `updated`'s own file, or what a THIRD record's own
correctness depends on. Name it as such, not as something this card newly opens or newly closes.

**Investigated and NOT reachable via production code (round 2):** every real write path that places a
filename into an entry's own `orphanLatchFiles` does so as a SELF-SCOPED record of THAT SAME entry's own
prior constituents, never an arbitrary unrelated entity's file. `consumeMatchedPendingsIntoArmedEntry`
(~L1498) STRIPS each matched pending entry's own former `sourceFile` out of the resulting union's
`orphanLatchFiles` on the ordinary success path (~L1518, `strippedOrphanLatchFiles = ...filter(f =>
!sourceFiles.includes(f))`) — those filenames reappear in `orphanLatchFiles` only on the DEGRADED-write
fallback, and only for the entries THAT SAME absorb just consumed, i.e. entities already tied into the
resulting record, never an independent third one. A genuinely untied Q (own healthy sourceFile, holding an
overlap token, with F as its ONLY durable carrier) would require F to have been some OTHER entity's own
former `sourceFile`, independently reused by Q's own unrelated absorb history — filenames are either
content-hash-derived (`sha256(directPathIdentity(repoPath))`) or random-suffixed
(`-collision-${randomUUID()...}`), so two unrelated absorbs landing on the identical filename is not a
shape any current write path produces. If a future change ever makes this reachable, construct the
discriminating test then; this round's own investigation found no production path to it.

Scenario 9 (below) accordingly does NOT, and structurally cannot, discriminate "the widened check correctly
accepts F's rewrite" from "the check would wrongly accept it even with over-broad acceptance" — Q's own
token never appears in F's content either way, so the check passing is uninformative about over-acceptance
specifically. The shape that DOES catch real over-acceptance is already covered by
`merge-quarantine-raise-protect-failure.mjs`'s `29fe2372-isolate-b` and `f2cc5f18` scenarios (a DIFFERENT,
independent same-identity record's own file, silently destroyed by a partial clear of an unrelated record
sharing only its identity) — unaffected by, and unchanged by, this card. Scenario 9 is relabeled below as a
durability/non-interference check: it proves an untied entry's own on-disk state survives a clear that
touches a file it merely, harmlessly, references — not an empirical safety probe against over-acceptance.

## Do not

- Do not call `rewriteOrphanLatchFilesAfterPartialClear` (or its two helpers) more than once per logical
  clear operation when a reduce drops 2+ overlap tokens — pass the complete set in one call.
- Do not call the chain at all when `overlapTokens` is empty (a twin tied by key/orphan-ref alone, no
  shared token) — the pre-fix per-token loop made zero calls on an empty array; an unconditional single
  call regresses that to one call with an empty set. Gate on `overlapTokens.length > 0`.
- Do not name the new plural parameter `clearedTokens` in `orphanFileTokensAccountedForByUpdate` — that
  shadows the pre-existing module-level global tombstone `Set<string>` of the same name (`merge-quarantine.ts`
  ~L319), silently disabling its own fallback check (`clearedTokens.has(t)`) inside the function body. Use
  `droppedTokens` (or similarly non-colliding), as the landed fix does.
- Do not cite token uniqueness (fresh `randomUUID()` per raise) as the reason this widening is safe — see
  "Why widening is safe" above. The module copies tokens between records in several places
  (`unionQuarantineEntries`, `reconcileMarkedBasenameBeforeWrite`, the protect copy-aside, boot re-reads);
  the real argument is that the single-overlap case already accepted this exact drop, and
  `tombstoneIfNotSurviving`/`anotherLiveEntryOwnsFile` independently guard any record still genuinely
  holding the token, unaffected by this change.
- Do not assume `anotherLiveEntryOwnsFile` covers a non-self `orphanLatchFiles` cross-reference (an entry
  whose own primary backing is elsewhere but which also lists this same filename as a secondary,
  non-authoritative reference) — it does not, by design (it only checks an entry's own PRIMARY backing).
  This is not a gap this card closes, and it was investigated (round 2) and found NOT reachable via any
  current production write path (see "Why widening is safe" above) — it is a pre-existing, orthogonal,
  presently-unreachable shape, not reopened by this fix.
- Do not read scenario 9 as an empirical safety probe against over-acceptance — Q's own token never
  appears in F's content under that scenario's own construction, so the check stays green whether or not
  the ownership check over-accepts. It is a durability/non-interference check only. The real
  over-acceptance coverage is `merge-quarantine-raise-protect-failure.mjs`'s `29fe2372-isolate-b` and
  `f2cc5f18` scenarios, unaffected by this card.

## Verification

Reproduced live on pre-fix `HEAD` via a standalone repro script (scratch, not committed) reusing the
committed test's own `buildDualTrackedTwin` shape with a 2-token active entry: both "keeping ... UNTOUCHED"
lines fired, the orphan file's on-disk tokens stayed at the full pre-clear set, and a simulated reboot
resurrected the already-lifted tokens.

Committed regression scenarios in `merge-quarantine-64119847-tied-twin-private-tokens.mjs`: 7 and 9's own
F-rewrite checks RED on the reverted code (the by-key route reaches the bug directly); 8 is a by-token
non-regression check, GREEN pre-fix (the by-token route's own sequential single-token pre-pass never
produces a 2+ overlap at this call site, confirmed by `64119847`'s own reachability analysis, restated
above); 10 (round 2, the empty-overlap guard) is RED on the round-1 fix without the `length > 0` guard —
it fires exactly one unexpected ownership-check attempt on an orphan file carrying a token outside the
(empty) accounted-for set. Each shown RED on the applicable pre-guard code (tsbuildinfo cleared, rebuilt,
confirmed RED, restored byte-identical, rebuilt) and GREEN on the landed fix.
