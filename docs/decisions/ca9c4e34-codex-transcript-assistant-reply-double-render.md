# ca9c4e34 — codex transcript's final assistant turn rendered twice: a reader defect, not a write-side one

## The observation

The Platform Lead's codex pilot (project `c348c3b5`, runs #2 and #3) found a 9-record transcript whose
last record was a byte-identical duplicate of the one before it — the final assistant turn rendered
twice. Reproduced independently in two separate pilot runs. Explicitly quarantined from the `turnSeq`
question settled by escalation `112b0310` (`turnSeq` read `1`, correctly — this is a rendering/capture
duplication, not a turn-counting fault).

## Mechanism (established from code, not from the unreachable pilot artifacts)

`packages/daemon/src/pty/codex-transcript.ts`'s `parseTranscriptFile` had two independent extraction
paths for an assistant reply within one turn:

1. A real `response_item` record with `payload.role === "assistant"` (handled by `classifyRole`).
2. `event_msg`/`task_complete`'s own `payload.last_agent_message` — a **defensive fallback**, per the
   file's own header, for when the reply "never appears as its own response_item."

Nothing scoped path 2 to fire only in path 1's absence. `task_complete.last_agent_message` is codex's own
echo of the turn's last assistant message, so when a turn's reply legitimately shows up as *both* a real
`response_item` and `task_complete`'s echo of it, the parser pushed it twice — two byte-identical
`TranscriptTurn` entries. Nothing in the persisted rollout JSONL itself is duplicated at the byte level;
this project's parser conflates two distinct, differently-shaped source records that happen to carry the
same final text. **Read-twice, not written-twice.**

Confirmed codex-specific by direct comparison: `pty/claude-transcript.ts`'s `parseTranscriptFile` has no
equivalent secondary/fallback extraction path — each JSONL line maps to at most one `TranscriptTurn`.

## Why this project could not reproduce it against a live codex process

No codex rig exists in this project (`harness` is human-REST/UI-only) and this project's own trivial
one-word pilot probe (`docs/investigations/049e4a7b`, `9a83ee8f`) never observed `role:"assistant"` on a
`response_item` at all — only the `task_complete` fallback ever fired in this project's own real-spawn
observations to date. The duplicate the Lead found in a *different* project's pilot, with more
substantive turns, is consistent with codex emitting a real `response_item` for the final reply once the
exchange is no longer a single trivial word — untested here, and not necessary to test here: the parser
bug is real and reproducible from the code's own two extraction paths regardless of which real codex
build/prompt shape actually triggers it.

## The fix

`parseTranscriptFile` now tracks `sawAssistantResponseThisTurn`, set when a `response_item` with
`role:"assistant"` is captured. The `task_complete.last_agent_message` fallback only pushes a turn when
that flag is false — restoring the fallback's own documented intent ("when it never appears as its own
response_item"). The flag resets both on `task_started` AND unconditionally after `task_complete` is
processed (whether or not it pushed) — see the next section for why both resets matter.

## Manager review: `task_started`-only reset can turn the duplicate into a LOSS

The first version of this fix reset the flag on `task_started` only. That makes correctness depend on
`task_started` being emitted before every turn. If it's ever absent, the flag stays `true` from an
earlier turn and a later turn's own fallback-only reply is **silently dropped** — the fix would convert a
duplicate into a loss, which this repo's `docs/decisions/88f11385` fail-toward-duplicate-never-a-loss
principle rules out (a duplicate on this p3, no-consumer defect costs almost nothing; a dropped reply
costs real transcript content). `turn_id` appears in the confirmed record shapes but is NOT read anywhere
in `codex-transcript.ts` — keying on it was considered and rejected in favor of the simpler fix below,
which needs no new field consumption.

Fix: reset `sawAssistantResponseThisTurn` after the `task_complete` branch too, unconditionally.
`task_complete` is itself every turn's real terminal, so closing the window there makes the guard
self-limiting and removes the dependency on `task_started` entirely. With `task_started` present,
behavior is unchanged (redundant reset, harmless). Without it: `response_item(assistant)` sets the flag,
`task_complete` correctly suppresses the fallback and then resets the flag, so a LATER fallback-only
`task_complete` (with no intervening `task_started`) still renders instead of being eaten. Reproduced (RED
before this second reset, GREEN after) in `packages/daemon/test/codex-transcript-parse.mjs`'s "no
task_started anywhere" case.

## Do not

- Do not remove or widen the `sawAssistantResponseThisTurn` guard in `parseTranscriptFile` — without it,
  a turn captured by both a response_item and `task_complete`'s echo renders twice again.
- Do not re-narrow the reset to `task_started` only — see the section above; that shape silently drops a
  later fallback-only reply whenever `task_started` is absent for a turn, trading the original (harmless,
  no-consumer) duplicate for a worse loss.
- Do not read this finding as evidence about `turnSeq` correctness in either direction — that question
  was already settled by escalation `112b0310`, on a different artifact.
- Do not treat the mechanism above as confirmed against a real codex build — it's established from this
  project's own code (two extraction paths, no live codex CLI available here), not from re-obtaining the
  original pilot's transcripts (unreachable — they live in project `c348c3b5`).

Reproduction: `packages/daemon/test/codex-transcript-parse.mjs`.
