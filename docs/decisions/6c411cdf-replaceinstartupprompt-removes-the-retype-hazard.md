# 6c411cdf — `replaceInStartupPrompt` REMOVES the 40 KB retype hazard; it does not merely make a retype verifiable

## Narrative

`agent_update`'s `startupPrompt` argument REPLACES an agent's whole prompt as a tool argument. Editing one clause of a 40 KB brief through that path meant retyping the entire body, with no diff instrument at the call site to catch a dropped correction or a mangled line — and Loom's own `CLAUDE.md` records the aggravating half: agent briefs live in the DB, invisible to `git grep`, so a silent transcription loss here would surface (if ever) only as an agent behaving oddly weeks later. A 2026-08-23 audit of 9 briefs had already found 3 carrying stale copied content — a different failure class (drift, not transcription loss), but invisible for the identical reason.

**Provenance, explicit on the card and carried here verbatim:** the underlying method (extract the before-value from the session's own engine transcript byte-exact, apply the edit programmatically, re-extract and diff) was the Codescape peer's, sent unprompted 2026-09-02 and consumed as `n=1` — not Loom's own finding, and not a validated rate.

**The decision this card actually made** was choosing among three candidate fixes rather than defaulting to the cheapest: (a) a documented manual procedure, (b) a helper script doing extract → assert-once → write → re-extract → diff, (c) a real tool affordance — a single-substring replace with an occurs-exactly-once assertion, so the retype never happens at all. (c) is what shipped: `replaceInStartupPrompt`'s `{ old, new }` is applied against the agent's CURRENT server-side prompt — never a value the caller had to hold or paste — and `old` must occur EXACTLY ONCE; zero occurrences or more than one is REJECTED with no write.

⇒ **This is the load-bearing distinction for the anchor:** (b) would have made a retype's fidelity checkable after the fact (byte-diff the re-extracted value against what was intended). (c) removes the retype itself — there is nothing to diff-verify because the server never receives a full-body argument to transcribe in the first place. A card retitle at merge (see below) exists specifically because the original title claimed the weaker, rejected (b)-shaped outcome.

**Mutual exclusion:** `agent_update` counts all three flags (`startupPrompt` / `appendToStartupPrompt` / `replaceInStartupPrompt`) and throws before any write if more than one is given.

**One noted, deliberately-not-fixed nuance:** the occurs-exactly-once check counts NON-OVERLAPPING occurrences (the second search for `old` starts at `firstIdx + old.length`), so a self-overlapping `old` (e.g. `"abab"` inside `"ababab"`) reads as unique where a strict overlapping count would say 2. Judged immaterial at review: self-overlapping matches are essentially unreachable for the real payload (a prose clause in a brief), the resulting edit is still a correct single replacement, and the safety property that matters — "the write cannot silently touch a clause you did not mean" — holds regardless. Not a defect; do not "fix" it without a concrete case where it bites.

**Retitle correction, recorded so the failure mode doesn't recur:** the card's own working title was `feat(agents): make a large startupPrompt rewrite byte-verifiable instead of eyeballed`, and was corrected at the merge gate — TYPE/scope/tense/retraction all passed, but the subject-breadth axis failed on two counts: (1) "make a rewrite byte-verifiable" claims coverage the diff doesn't provide — a full-body rewrite still goes through plain `startupPrompt` and carries the original hazard entirely unmitigated; what shipped covers a targeted single-clause edit only. (2) "byte-verifiable" names the REJECTED option (b) — what shipped is correct by construction (retype never happens), not verified after the fact. The framing came from the card as originally written, not from the implementing worker, who had no cause to challenge a title they were handed.

## Do not

- Do not describe this feature as making a prompt rewrite "byte-verifiable" or "diff-checked" — that names option (b), which was considered and rejected. It is correct BY CONSTRUCTION: the full-text retype this hazard depends on never happens.
- Do not "fix" the non-overlapping occurrence-counting nuance without a concrete, reachable case — it was reviewed and judged immaterial for real prompt-editing payloads.
- Do not generalize the extract-from-engine-transcript method beyond its scope: it works only because the before-value was returned as a tool RESULT, `n=1`, and untested against any other tool's payloads.

## Source

JSDoc comment above `updateAgentPreset` in `packages/daemon/src/sessions/service.ts`: originally lines 10777-10786, as of this tranche's HEAD. Card `6c411cdf` was already cited by name in the source comment; commit `f928173bd9` ("feat(agents): give agent_update an occurs-once in-place prompt edit mode") is the implementing commit (`merged.sha: f928173`).
