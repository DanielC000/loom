# 634edd2b — `mergedVerificationAtMerge` replaces the ambiguous flat `mergedVerification` on task reads

## Narrative

A single `project_task_get` (and its in-project siblings `tasks_get`/`tasks_list`) used to return TWO fields naming a verification grade for the same sha: the raw `Task.mergedVerification` (a flat, top-level field, spread straight off the DB row) and the nested `merged.verification` (computed fresh on every read by `getTaskMergedInfo`). A real incident hit these disagreeing for the same sha — `mergedVerification:"content"` (the strongest tier) alongside `merged.verification:"pathset"` (weaker) — with no way for the reader to tell which was authoritative, because nothing distinguished them beyond an easy-to-miss `merged.` prefix.

The two are not a bug disagreeing with itself: they answer different questions at different times.

- `merged.verification` is recomputed from scratch on every read (`getTaskMergedInfo` → `resolveMergedCommitMapHit`) — it reflects what's knowable RIGHT NOW. While the worker branch is still alive it can byte-diff against the live tip (`"content"`); once the branch is deleted, live content-verification is structurally impossible (nothing left to diff against), so it degrades to `"pathset"` (verified from the landed commit's own ancestry against a persisted path-set trailer) or `"trailer-only"`.
- The raw `Task.mergedVerification` DB column is written ONCE and never re-derived. A fresh solo squash-confirm (`SessionService.finalizeMerge`, the Green path) always stamps `"content"` — unconditionally, because it just created that commit from the live branch in the same call, so content-verification is trivially true at that instant. A solo ALREADY_MERGED / boot-reconcile landing doesn't pass a verification mode at all, leaving the column `null` until a human opens the board drawer, which lazily backfills it via `GET /api/tasks/:id` from whatever `merged.verification` happens to read AT THAT MOMENT — which may itself already be a degraded tier if the branch is already gone by then.
- **Update (card d6d40edd):** a `merge_batch` landing now ALSO stamps this column eagerly, for the same reason the Green path can: `landBranchCommitsIndividually` already computed its own `Loom-Worker-PathSet` digest (or found the stamp failed) in the same landing call, so `mergeBatchTracked` derives `"pathset"` (stamp landed) or `"trailer-only"` (stamp failed) from that for free — no separate verification pass. The one remaining batch case that still leaves it `null` is a `noop` landing (this branch's content was already present elsewhere in the batch's own ancestry, so nothing was freshly stamped) — that still waits on the lazy backfill like any other pre-fix history.

Both are correct answers to different questions. The incident's disagreement is exactly the expected shape: `mergedVerification` was stamped `"content"` when the merge landed (branch alive), and by the time the card was read, the branch had since been deleted, so the live `merged.verification` had degraded to `"pathset"`. Verified directly (not merely reasoned about) against a real, unforced squash-merge: with the branch still alive, a freshly-simulated merge-confirm stamp and a live `getTaskMergedInfo` call agree (`"content"` both); only after the branch is deleted does the live read degrade while the frozen stamp does not move — see `test/merge-verification-at-merge-vs-live.mjs`.

## The fix

Renamed the flat field the MCP task-read responses (`getProjectTask`/`listProjectTasks`, and therefore `tasks_get`/`tasks_list`/`project_task_get`/`list_all_tasks`) expose from `mergedVerification` to `mergedVerificationAtMerge` — self-documenting that it's frozen at merge time, distinct from the live `merged.verification` sitting right next to it in the same response. This REPLACES the ambiguous name rather than adding a third field alongside it; the underlying DB column (`Task.mergedVerification`) and every internal/web-board consumer that reads the raw DB row directly (`GET /api/tasks/:id`, `GET /api/projects/:id/board`, `Board.tsx`) are unaffected — they never went through the MCP enrichment layer that renames it.

## Do not

- Do not read `mergedVerificationAtMerge` and `merged.verification` as interchangeable — one is frozen at merge time, the other is live; a disagreement between them is expected once the branch is gone, not a bug to chase.
- Do not "fix" the disagreement by making the persisted field re-derive on every read — that's exactly what `merged.verification` already is; the two exist to answer different questions (what was true at merge vs. what's knowable now).
- Do not assume `mergedVerificationAtMerge` is always populated — a solo ALREADY_MERGED/boot-reconcile landing, a batch `noop` landing, or pre-`d6d40edd` batch history all leave it `null` until the web board's lazy backfill runs (human-triggered, not agent-facing). A freshly-landed (non-`noop`) batch branch since card `d6d40edd` DOES populate it eagerly (`"pathset"`/`"trailer-only"`) — see this record's own "Update (card d6d40edd)" note above.
- Do not add this field back to `TaskSummary` — the summary shape (`tasks_list`'s default, no body) deliberately omits both verification fields; only a full task read (`includeBody:true`/`tasks_get`/`project_task_get`) carries this ship-state nuance.

## Consequences

An agent reading a full task no longer sees two ambiguously-named fields that can disagree with no explanation — the field name itself now states which one it is, and the type doc + tool descriptions explain why they can diverge.

## Source

Board card `634edd2b`, filed 2026-09-21 (folded into the combined card `975d3c37` — "fix(tasks): make three board-tool signals describe what actually happened").
