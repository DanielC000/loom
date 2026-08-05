# 5469ec08 — never-drop floor vs digest budget: findings

Worker investigation, 2026-08-05. **Read-only investigation plus a written proposal — no production code changed, no memory note deleted/pruned/re-tagged, `memory.budgetTokens` untouched.** `filesChanged` for this task is this document plus one read-only analysis script (`scripts/analyze-memory-list.mjs`, run against a `memory_list` dump; no DB writes).

Every DoD item is answered below, in order, with the raw evidence it rests on.

## DoD-1 — reproduce §ARITHMETIC independently, from a REAL kickoff header

This session's own kickoff (a fresh worker spawn, same project) carried the pinned-memory digest, verbatim. Seven notes were delivered in full, followed by:

> `⚠️ 16 pinned note(s) dropped for budget: a-claim-crossing-a-project-boundary-loses-its-scope, dangling-worker-rows-do-not-consume-slots, engine-confirmation-can-lag-minutes-timeouts-assume-seconds, commit-before-run-gate-or-forfeit-reuse, a-resume-doc-is-a-rewrite-not-a-ledger, first-turn-pasted-text-placeholder-is-the-kickoff, a-censored-instrument-manufactures-agreement, rarity-is-not-low-priority-price-the-exposure, a-comment-is-a-claim-grep-them-when-you-fix, positive-control-your-searches-empty-is-not-evidence, a-baseline-with-no-recorded-condition-is-not-a-baseline, two-states-one-signature-add-a-discriminator, discriminating-control-and-proof-beats-measurement, codescape-is-private-no-user-visible-surface, exoneration-proves-the-card-innocent-not-the-failure-spurious, read-which-assertions-failed-not-how-many`

and, in the related section:

> `⚠️ 8 of 8 related note(s) dropped for budget: did-it-land-check-by-title-or-content, a-tight-subset-is-the-most-persuasive-way-to-be-wrong, tasks-list-summary-hides-held-flag, an-approximation-launders-into-a-settled-fact-by-citation, windows-execfilesync-posix-cwd-silent-fail, release-cut-checklist-and-linux-ci-verify, the-gate-reports-one-failure-sweep-the-cheap-guards-first, concurrent-gates-is-admission-instant-not-max-over-run`

Cross-checked against a fresh `memory_list` pull (229 notes, parsed with `scripts/analyze-memory-list.mjs`):

```
total notes: 229
pinned: 23
never-drop (pinned+tag): 7
rest-pinned (pinned, no never-drop): 16
unpinned: 206
```

23 pinned − 7 floor = 16 non-floor pinned, and this session's drop line named exactly those 16, by key, with none left over. The 7 notes actually delivered to me are exactly the 7 `pinned && never-drop` notes:

```
shipping-a-detector-is-not-someone-reading-it            estTok: 1030
corroborating-a-premise-is-not-corroborating-the-inference  estTok: 1047
a-rule-stored-next-to-an-artifact-does-not-check-it       estTok: 1051
read-the-artifact-before-you-send-not-after               estTok: 1056
the-qualifier-dies-in-the-summary-label                    estTok: 1048
a-control-inherits-the-equivalence-you-assumed-building-it estTok: 1025
gate-cap-is-2-by-owner-decision-never-change-silently      estTok: 1037
```

Sum of these seven blocks (body only, header text excluded) ≈ **7294 est-tok** by my independent re-implementation of `estimateTokens`/`noteBlock`, against the card's own `memory_write`-reported **7306**. The ~12-token gap is fully explained by my script omitting the `## Pinned project memory (always included)` section header and any `annotate()` request-link lines that `computeFloorTierStatus` includes and my approximation doesn't — not a discrepancy worth chasing further.

**§ARITHMETIC reproduces on a third, independent kickoff — 91% floor consumption, and this time ZERO of the 24 non-floor candidates (16 pinned-rest + 8 related) survived**, one worse than the card's own session (which had exactly one survivor of 24). Confirms the mechanism is not a one-off; it is the steady state at the current floor size.

## DoD-2 — can the daemon distinguish MATCHED-AND-EVICTED from NEVER-MATCHED at all? (the write side)

**No. Read the code, not the tool description: there is no place — no DB column, no counter, no log the daemon itself can query — that records "this note matched a kickoff and was dropped for budget," distinguishable from "this note has never matched anything."**

Traced every consumer of `droppedFloorKeys`/`droppedRestKeys`/`droppedRelatedKeys` (`project-memory-recall.ts`, the only file that computes them — confirmed by `grep -rn "droppedFloorKeys|droppedRestKeys|droppedRelatedKeys" packages/daemon/src`, 1 file, no other consumer):

1. **The in-digest overflow/alarm lines** (`composeProjectMemoryDigest`) — these ride inside the framed text delivered to the *one* session being spawned right now. They land in that session's prompt/transcript and nowhere else structured; nothing re-reads them.
2. **`console.error`/`console.warn`** (`retrieveProjectMemoryForKickoff`) — daemon stdout/stderr only. Not written to any table, not exposed by any REST endpoint or MCP tool. Ephemeral to whatever is capturing the daemon's process output (a dev terminal, or nothing, depending on how the daemon is run) — not queryable by an agent or by `memory_list`/`memory_read` under any circumstance.

That's the complete list — nothing else touches those three arrays.

Now the DB side. `project_memory`'s only mutation on the read path is `touchProjectMemoryRetrieved` (`db.ts:5785`), and it is called with **`includedIds` only** — the ids that actually made it into the digest (`retrieveProjectMemoryForKickoff`, `if (framed) db.touchProjectMemoryRetrieved(includedIds)`). A note that matched the FTS5 query and then got dropped for budget is, by construction, **excluded** from `includedIds` — its row's `last_retrieved_at`/`retrieval_count` are left completely untouched, identically to a note that never matched at all. There is no separate "matched" counter and no "dropped" counter on the row.

The one persisted, per-session artifact that touches this at all is `sessions.last_project_memory_digest` — but it stores a **sha256 hash** of the framed digest text (`stampProjectMemoryDigest`, `service.ts:1640`), purely to dedupe re-injecting an unchanged digest across a resume. The hash carries **zero recoverable information** about which keys were in it, let alone which were dropped — you cannot go from that column back to "was `X` matched-and-dropped for session `Y`."

**So the finding stands as the card predicted: the store cannot currently tell its two failure modes apart, anywhere, and no amount of analysis of `everDelivered`/`retrievalCount` will ever recover that distinction — it isn't a case of looking in the wrong field, the information is simply never captured on the write side.**

### A sharper, independently-discovered consequence of this gap

Cross-checking this session's own 16 dropped-pinned-rest keys and 8 dropped-related keys against `memory_list`'s `everDelivered`/`retrievalCount` turned up something the original card's 7-key sample didn't have the range to show:

```
--- dropped-PINNED keys from my own kickoff ---
a-claim-crossing-a-project-boundary-loses-its-scope           everDelivered:false retrievalCount:0
dangling-worker-rows-do-not-consume-slots                     everDelivered:false retrievalCount:0
engine-confirmation-can-lag-minutes-timeouts-assume-seconds    everDelivered:true  retrievalCount:146
commit-before-run-gate-or-forfeit-reuse                        everDelivered:true  retrievalCount:92
a-resume-doc-is-a-rewrite-not-a-ledger                         everDelivered:true  retrievalCount:67
first-turn-pasted-text-placeholder-is-the-kickoff              everDelivered:true  retrievalCount:59
a-censored-instrument-manufactures-agreement                   everDelivered:true  retrievalCount:8
rarity-is-not-low-priority-price-the-exposure                   everDelivered:true  retrievalCount:14
a-comment-is-a-claim-grep-them-when-you-fix                     everDelivered:true  retrievalCount:273
positive-control-your-searches-empty-is-not-evidence            everDelivered:true  retrievalCount:53
a-baseline-with-no-recorded-condition-is-not-a-baseline          everDelivered:true  retrievalCount:36
two-states-one-signature-add-a-discriminator                    everDelivered:true  retrievalCount:192
discriminating-control-and-proof-beats-measurement               everDelivered:true  retrievalCount:57
codescape-is-private-no-user-visible-surface                    everDelivered:true  retrievalCount:292
exoneration-proves-the-card-innocent-not-the-failure-spurious    everDelivered:true  retrievalCount:131
read-which-assertions-failed-not-how-many                        everDelivered:true  retrievalCount:16
```

**14 of these 16 pinned-rest notes have `retrievalCount` in the tens to hundreds** — one (`codescape-is-private-no-user-visible-surface`) has been delivered **292 times** historically, another (`a-comment-is-a-claim-grep-them-when-you-fix`) **273 times**. These are not obscure, low-value notes; they are among the most-delivered notes in the whole store, and every one of them was dropped from *this* kickoff. `retrievalCount` is a lifetime counter across every past kickoff, not a per-kickoff signal — so a note with a huge historical count tells you it used to reliably fit (when the floor was smaller / the budget went further), not that it fits now. **This is a live, ongoing regression, not a static snapshot**: as the floor tier has grown, formerly-reliable pinned notes have been pushed out one by one, and `retrievalCount` is actively misleading about "current" reach precisely because it never resets and never distinguishes "used to fit" from "fits now." (Related-tier cross-check: 3 of 8 dropped keys read `everDelivered:true`, consistent with the card's own peer-project finding and with related evictions being non-permanent by design.)

## DoD-3 / DoD-4 — is floor size the actionable lever, and what's the ONE proposal

**Yes, floor *size* (not floor *membership*) is the actionable lever, and the evidence points at per-note byte allowance more than note count.**

The 7 floor notes measured directly from `memory_list` (body-only, no header):

```
1030, 1047, 1051, 1056, 1048, 1025, 1037   (est-tok)
```

Every one sits in a **31-token band around ~1040**, i.e. essentially at the per-note write ceiling: `MAX_TEXT_BYTES = 4000` bytes ÷ 4 ≈ 1000 est-tok (`mcp/memory.ts`'s own doc comment states this arithmetic directly). Seven near-maxed notes × ~1040 tok ≈ 7280–7350 tok — which is exactly the ~7294–7306 tok this investigation and the card both independently measured. **The floor isn't big because there are many notes in it; it's big because the per-note cap lets — and in practice invites — every floor note to be written right up against it.** This matches the card's own DoD-6 evidence: the author who wrote `shipping-a-detector-is-not-someone-reading-it` only discovered the tier had grown by ~250 tokens *after* the write succeeded, because nothing gates the write itself.

**§STILL-NOT-ESTABLISHED is real and I am not overriding it here:** all 7 floor notes read as substantive method/invariant notes; I have no evidence any specific one is the "wrong" one to keep, and picking an evictee by content-value is a judgment call outside a read-only investigation with no deep history on these notes. So the proposal below is deliberately **mechanism-shaped, not content-shaped** — it doesn't name a note to remove.

**The ONE concrete proposal:** enforce a **separate, lower byte cap specifically for `never-drop`-tagged notes** — e.g. 2000 bytes (≈500 est-tok) instead of the general 4000-byte `MAX_TEXT_BYTES` — as a **blocking precondition at the moment a note is tagged `never-drop`** (either on `memory_write` when `pinned:true` + the tag are both present, or on whatever future "promote to floor" action exists). Not an advisory line in the response — a rejection, the same shape `baseVersion` already uses for a stale write, and the same shape this project's own memory already names as the *only* thing that's worked: `shipping-a-detector-is-not-someone-reading-it`'s v2 finding is exactly "a blocking precondition on the ACTION beats a notice in the ATTENTION path," 2-for-2 on this project against 0-for-many advisories — and the current `neverDropStatus` signal (DoD-6, below) is precisely one of those zero-for-many advisories.

At the current measured average (~1040 tok/note), a 500-tok cap roughly **halves per-note floor cost**: 7 notes × ~500 ≈ 3500 tok ≈ 44% of the 8000-tok budget, versus the current 91% — recovering on the order of ~3800 tokens, or roughly 4-5 average-sized (~824-tok) unpinned notes' worth of headroom for the pinned-rest + related tiers, without evicting anyone.

**Named caveat, so this isn't oversold:** a write-time precondition only binds *future* writes/re-tags. It does nothing to the 7 notes already sitting at ~1040 tok each unless someone edits them down — this proposal recovers headroom going forward, it does not shrink today's floor by itself. **DoD-4's discipline is adopted for the orthogonal, count-side failure mode**: if the floor tier's *count* is also raised in the future (an 8th `never-drop` note), that action should require the author to name which existing floor note is being un-tagged in the same change — a floor tier that can only grow, never trade, is not a floor, it's a queue. This is a policy recommendation for whoever owns the mechanism next; nothing here executes it.

## DoD-5 — report even if "working as designed"

Not applicable as stated — this is not a "working as designed" outcome. The independent third measurement in DoD-1 reproduces and slightly *worsens* the card's own finding (0 of 24 non-floor candidates survived here, vs. 1 of 24 in the card's session). The floor-vs-budget arithmetic is a real, load-bearing constraint on this project's memory digest right now, not a one-off artifact of one kickoff's competition.

## DoD-6 — the write-time advisory, confirmed in code

Confirmed directly in `mcp/memory.ts`: `writeProjectMemory` calls `db.upsertProjectMemoryChecked(...)` first, and only computes `neverDropStatus` (`computeNeverDropStatus`, line 161) **after** `result.ok` is already true — the doc comment states this explicitly ("computed AFTER the write above already succeeded, never blocks/rejects it"). There is no code path where a `neverDropStatus` response prevents or modifies the write. This corroborates the card's own DoD-6 anecdote and is the direct evidence behind the DoD-3/4 proposal above: the *existing* signal for floor growth is advisory, and this project's own memory store already has two independent, on-the-record data points (`shipping-a-detector-is-not-someone-reading-it`) that an advisory in this position gets read past.

## Mechanics note — `never-drop` predicate, verified in code (not trusted from the tool description)

`isNeverDrop` (`project-memory-recall.ts:96`) is `m.tags?.includes(NEVER_DROP_TAG) ?? false`, and every caller that builds the floor tier (`computeFloorTierStatus`, `composeProjectMemoryDigest`) filters it **only over rows already restricted to `pinned:true`** (`db.listPinnedProjectMemory` for the write-time status check; `pinned.filter(isNeverDrop)` over the `pinned` array passed into `composeProjectMemoryDigest`, itself sourced from `db.listPinnedProjectMemory` in `retrieveProjectMemoryForKickoff`). An unpinned note carrying the `never-drop` tag is structurally invisible to both code paths — confirmed, not assumed; `mcp/memory.ts`'s own `computeNeverDropStatus` makes the same point explicit in its `inert:true` branch for exactly this case.

## Scope discipline

Nothing was deleted, pruned, re-tagged, or reconfigured. `memory.budgetTokens` was not touched and no number is proposed for it (Loom's live value is already clamped at `MEMORY_CONFIG_MAX.budgetTokens = 8000`, the platform-wide ceiling — confirmed in `packages/shared/src/config.ts`; there is no larger value `resolveConfig` could even resolve to today). The `never-drop` tag was not mass-applied or mass-removed. The DoD-3/4 proposal is a written recommendation only.
