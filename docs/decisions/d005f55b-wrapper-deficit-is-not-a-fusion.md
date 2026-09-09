# d005f55b — a possible-duplicate wrapper deficit is a stale-echo artifact, not lost content

## Narrative

Card d005f55b — manager-supplied LIVE evidence (sessions 494db005/f6eeeb52, 2026-08-06) CONFIRMS the card's own Candidate #3 ("a Loom redelivery wrapper", marked PLAUSIBLE/UNVERIFIED in the card body) as a real foreign-content source — but as a DEFICIT, not a fusion: both measured specimens had `reported` SHORTER than `intended` by EXACTLY 40 chars (`divergesAtChar=0`, `lenDelta=-40`), and 40 is the fixed length of `POSSIBLE_DUPLICATE_TAG_RE`'s own match regardless of which 8 hex chars fill the root id (`"[loom:possible-duplicate root:"` (30) + 8 hex + `"] "` (2) = 40 — verified). In both specimens, `intended` (what Loom wrote for that generation) STARTS WITH the tag, and `reported` equals `intended` with the tag stripped, byte-for-byte.

CORRECTED MECHANISM (manager measurement, 2026-08-06, card 854d1632 — supersedes an earlier, wrong "does not establish whether the tag reached the engine" framing this doc used to carry): the wrapper DOES reach the engine and IS echoed back byte-identically in the ordinary case — verified directly via `[submit-write]`/`[prompt-echo]` pairs showing a wrapped write (`len=written+40`) confirmed `byteIdentical=true` at its full wrapped length. The `-40` specimens are best explained as a STALE, OUT-OF-ORDER confirmation: the hook that fired belongs to an EARLIER, bare (pre-wrap) write, but by the time it arrives `live.lastPrompt` has already advanced to a LATER, wrapped re-mint of that same content. This is an ATTRIBUTION/ORDERING artifact, NOT corruption and NOT content loss — every byte of SOME intended content (the earlier bare write) did arrive; it's compared against the wrong (already-advanced) generation's `intended`, not evidence that anything failed to transmit.

This function only NAMES the byte-pattern precisely enough that it stops reading as "matched nothing" (card d005f55b DoD-3's own point, which this specimen strengthens) — it must NOT be worded as a loss/deficit in anything that consumes it (see the notice text at the mismatch-notice site). Precise and non-heuristic, mirroring `isStalePlaceholderPrefix`'s own exact-strip-and-compare discipline (this file) — reuses the EXISTING `stripPossibleDuplicateFrame` (no new matcher, no loosening of anything): fires ONLY when stripping the tag from `intended` produces `reported` EXACTLY.

## Do not

- Do not fold this into `detectComposerAccumulation`/`detectComposerAccumulationOverDivergedPrior` — deliberately its own, orthogonal check (those are always LONGER, never shorter; this is a deficit).
- Do not chase the wrapper's actual delivery path from here — that question is answered and tracked separately (card 854d1632).
- Do not word this function's output as a loss/deficit in anything that consumes it — the corrected mechanism shows it is an attribution/ordering artifact, not content loss.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`detectPossibleDuplicateWrapperDeficit`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`) — the two embedded guard clauses (⛔ do not fold; ⛔ do not chase the delivery path) stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
