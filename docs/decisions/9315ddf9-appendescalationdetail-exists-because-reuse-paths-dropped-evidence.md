# 9315ddf9 — `appendEscalationDetail` exists because `platformEscalate`'s reuse paths silently dropped new evidence

## Narrative

`platformEscalate` has two paths that reuse an existing task instead of minting a new one: the
same-title dedup match, and the severity-bump case. Both used to return "success" to the caller while
the new evidence in `input.detail` was silently discarded — a reader watching the reused card only ever
saw whatever was on it before. (Mode A.)

Separately, when no still-open escalation matched the title at all, `platformEscalate` minted a
brand-new card unconditionally — even when the new title was really a reasonable retitling of a
still-open finding under new evidence, the natural signature of "same investigation, retitled
follow-up." That silently forked one investigation into two disconnected threads. (Mode B.)

**Fix for Mode A:** `appendEscalationDetail` — appends a timestamped, attributed detail section to the
task's body, NEVER replacing existing content, called on every reuse path (same-title dedup, and the
severity-bump reuse). An append-only section means a Lead's own triage note (which REPLACES the body
when filed) and any prior report already on the card both survive.

**Fix for Mode B:** before minting a new card, scan for other still-open escalation(s) THIS SAME manager
session has filed in this project under a DIFFERENT title — the natural signature of "same
investigation, retitled follow-up." Auto-link ONLY when there is EXACTLY ONE candidate: two or more is
genuinely ambiguous, and a wrong guess (silently relating two distinct findings) is the fragmentation bug
running in reverse — worse than leaving it unlinked-but-reported. Mirrors the board's own
`project_task_create` dupe guard (cards `0bd5aff5`/`e13c6087`): never silently merge, never silently
drop — surface it and let the reporter/Lead decide.

DELIBERATELY session-scoped, not project-scoped: widening to "same origin project" would make nearly
every open escalation a candidate, so `candidates.length > 1` would be the common case and this would
auto-link almost nothing anyway, just noisily. The unstated cost of that choice: managers on this project
recycle constantly, and a recycled successor gets a NEW `managerSessionId` — so a retitled follow-up
filed by a SUCCESSOR manager (not the same session that filed the original) matches ZERO candidates and
mints an unlinked card, the exact fork this fix exists to prevent, just across a recycle boundary instead
of within one session. That case is left to the reporter (or the Lead, via `escalation_status`) rather
than covered automatically — a project-wide scan would be too broad to auto-link safely.

## Do not

- Do not let a reuse path (same-title dedup, or a severity-bump reuse) skip calling
  `appendEscalationDetail` — that is exactly the silent-evidence-loss bug (Mode A) this fixes.
- Do not widen the Mode B auto-link scan from session-scoped to project-scoped — that was deliberately
  rejected as too broad to auto-link safely, even knowing it leaves a recycle-boundary gap unresolved.
- Do not auto-link when more than one candidate matches — surface it as `possiblyRelatedTaskIds` instead
  of guessing.

## Source

Inline comments in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s same-title dedup
return branch [Mode A], its severity-bump reuse branch [Mode A], its no-match mint branch [Mode B], and
`appendEscalationDetail`'s own JSDoc, as of this tranche's HEAD).
