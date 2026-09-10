# sha:becc7581 — `cancelQuestion` is one write reached by two entry points; the throw names the row's real state

## Narrative

`cancelQuestion` is the terminal, retained-in-history counterpart to `answerQuestion`/`answerCredentialQuestion`, reached by TWO entry points that both funnel through this ONE write — never a forked state model: the human-only REST dismiss route (`POST /api/questions/:id/dismiss`) and the agent-lineage-scoped `question_cancel` MCP tool (both surfaces — see `mcp/questionTool.ts`'s `cancelQuestionForAgent`, which layers the ownership check in front of this).

It mirrors `dismissPresetPromptSuggestion`'s shape exactly: returns `undefined` when no question has this id (caller 404s); THROWS when it isn't currently `'pending'` (caller 409s) — the thrown message names the row's ACTUAL current state, so a race where the question was answered between the caller's read and this write surfaces as "question is already answered" rather than a generic rejection, telling the caller an answer is now available instead of silently discarding it.

Both branches read as this method either cancels the row or throws — never a truthy return for a row that's secretly something else. A cancelled row is retained exactly like an answered/consumed row (see `listOpenQuestions`' `includeConsumed` branch, which folds `'cancelled'` in alongside `'consumed'`).

The same commit also shaped two more surfaces on the `mcp/questionTool.ts` side of this feature, kept in this one record rather than a second file for the same commit:

**`cancelQuestionForAgent`** (`packages/daemon/src/mcp/questionTool.ts`) layers the agent-facing ownership check in front of `cancelQuestion` above, shared by both `question_cancel` MCP tool registrations (`mcp/orchestration.ts`'s manager surface, `mcp/platform.ts`'s Lead surface) so the two callers' ownership-check + error-shaping can never drift apart — mirroring how `buildQuestionAsk` is shared for the ask side. It is scoped the SAME way `question_pull`/`requests_list({mine:true})` are — by `sessions.agent_id`, not the exact asking session id — so a fresh (non-recycle) successor session on the same agent lineage may still cancel a still-pending ask a predecessor session filed. It rejects a question asked by a DIFFERENT agent lineage (an asker may only cancel its own asks — never another agent's, mirroring the `mine` ownership boundary) and a genuinely unknown id, then catches `cancelQuestion`'s throw for the "already answered" case and translates it into the caller-facing message described above.

**`questionAnswerByType`** (same file) extends the null-safe answer-shaping this feature needed: a row that was never actually answered — still `pending`, OR now terminally `cancelled` — has its answer fields all read `null` instead of a misleading false-ish derivation (e.g. an unanswered permission would otherwise wrongly read `approved:false`, indistinguishable from "denied"; an unanswered credential would otherwise call `credentialAck`, which assumes an answer boundary actually ran, and fabricate a "provided and stored securely" ack for a secret that was never given).

## Do not

- Do not fork the state model between the REST dismiss route and the `question_cancel` MCP tool — both must funnel through this one write.
- Do not throw a generic rejection when the row's state changed out from under the caller — name the row's ACTUAL current state in the error, so a race reads as "already answered" rather than an opaque failure.
- Do not hard-delete a cancelled row — retain it exactly like an answered/consumed row.
- Do not scope `cancelQuestionForAgent`'s ownership check to the exact asking session id — match `sessions.agent_id`, the same agent-lineage definition `question_pull`/`requests_list({mine:true})` use, so a recycle successor can still cancel a predecessor's still-pending ask.
- Do not derive `questionAnswerByType`'s answer fields for a `pending`/`cancelled` row as a false-ish value (`approved:false`, a fabricated credential ack) — surface `null` instead, so "never answered" is never misread as "denied" or "empty ack".

## Source

Inline comment in `packages/daemon/src/db.ts` (`cancelQuestion`'s doc comment), as of this tranche's HEAD. No board card cited anywhere in the block or the file; keyed to the introducing commit per the extraction program's sha-grammar carve-out. Sourced via `git blame`, then `git rev-parse --verify becc758139d4e95450f2917d1d7434865a555e40` (feat(orchestration): add question_cancel + a human dismiss route for pending Requests) — a genuine feature commit, not a bulk move. `cancelQuestionForAgent` and `questionAnswerByType` sections above relocated from `packages/daemon/src/mcp/questionTool.ts` (their own doc comments, pre-tranche-2 numbering) by this same tranche — same commit, different file, folded into this one record per the extraction program's "one commit can fix two files" rule rather than minting a second file.
