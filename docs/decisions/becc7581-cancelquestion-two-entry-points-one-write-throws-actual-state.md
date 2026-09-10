# sha:becc7581 — `cancelQuestion` is one write reached by two entry points; the throw names the row's real state

## Narrative

`cancelQuestion` is the terminal, retained-in-history counterpart to `answerQuestion`/`answerCredentialQuestion`, reached by TWO entry points that both funnel through this ONE write — never a forked state model: the human-only REST dismiss route (`POST /api/questions/:id/dismiss`) and the agent-lineage-scoped `question_cancel` MCP tool (both surfaces — see `mcp/questionTool.ts`'s `cancelQuestionForAgent`, which layers the ownership check in front of this).

It mirrors `dismissPresetPromptSuggestion`'s shape exactly: returns `undefined` when no question has this id (caller 404s); THROWS when it isn't currently `'pending'` (caller 409s) — the thrown message names the row's ACTUAL current state, so a race where the question was answered between the caller's read and this write surfaces as "question is already answered" rather than a generic rejection, telling the caller an answer is now available instead of silently discarding it.

Both branches read as this method either cancels the row or throws — never a truthy return for a row that's secretly something else. A cancelled row is retained exactly like an answered/consumed row (see `listOpenQuestions`' `includeConsumed` branch, which folds `'cancelled'` in alongside `'consumed'`).

## Do not

- Do not fork the state model between the REST dismiss route and the `question_cancel` MCP tool — both must funnel through this one write.
- Do not throw a generic rejection when the row's state changed out from under the caller — name the row's ACTUAL current state in the error, so a race reads as "already answered" rather than an opaque failure.
- Do not hard-delete a cancelled row — retain it exactly like an answered/consumed row.

## Source

Inline comment in `packages/daemon/src/db.ts` (`cancelQuestion`'s doc comment), as of this tranche's HEAD. No board card cited anywhere in the block or the file; keyed to the introducing commit per the extraction program's sha-grammar carve-out. Sourced via `git blame`, then `git rev-parse --verify becc758139d4e95450f2917d1d7434865a555e40` (feat(orchestration): add question_cancel + a human dismiss route for pending Requests) — a genuine feature commit, not a bulk move.
