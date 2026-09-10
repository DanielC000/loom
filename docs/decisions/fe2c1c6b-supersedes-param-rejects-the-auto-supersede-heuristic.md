# sha:fe2c1c6b — `question_ask`'s `supersedes` param rejects an auto-detected heuristic

## Narrative

`question_ask`'s optional `supersedes:<questionId>` handling (`applySupersede`, `packages/daemon/src/mcp/questionTool.ts`) lets an asker explicitly name the exact prior pending ask a new ask replaces, auto-cancelling it. The originating commit floated an AUTO-supersede heuristic instead — "this new ask obviously replaces that old one," detected automatically — and deliberately REJECTED it: "obviously replaces" eventually guesses wrong and silently cancels a live owner ask, with no way for the owner to know their pending decision vanished.

The shipped design is the safe, non-heuristic version instead: the asker names the exact prior ask it's replacing, explicitly, at the moment it knows — never an inferred guess.

## Do not

- Do not build an auto-detected "this ask obviously replaces that one" heuristic for `question_ask` — it will eventually guess wrong and silently cancel a live owner ask. Require an explicit `supersedes:<id>` instead.

## Source

Inline comment in `packages/daemon/src/mcp/questionTool.ts`, above `applySupersede` (lines 570-602, pre-tranche-1 numbering), as of commit `beeeb7c2`. Introduced by commit `fe2c1c6b` ("feat(orchestration): add an explicit supersedes:&lt;id&gt; param to question_ask that auto-cancels the named prior pending ask"). Relocated by card `8691d4a0` (tranche 1).
