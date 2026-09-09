# a3f1319f — legacy 8-char task_id prefixes need a LIKE fallback, not equality

## Narrative

Bug fixed post-card a3f1319f: a question created BEFORE that commit stored `task_id` as an 8-char id-PREFIX (a UUID's first block, e.g. `369dde3c`), not the full 36-char task UUID every caller resolves to before calling in. A plain `task_id = ?` equality never matches those legacy rows, so a manager reading a card's connected requests would see none even though the owner had already answered one — invisible decisions. `Board.tsx` already tolerated this client-side (`task.id.startsWith(q.taskId + "-")`); `listQuestionsForTask` mirrors that same prefix match server-side so the DB query behind `tasks_get`/`task_requests_list` stops being the one un-fixed path.

## Do not

- Do not replace the `length(task_id) = 8` + trailing-`-` LIKE fallback with a plain equality "for simplicity" — that silently makes every pre-a3f1319f question invisible to `tasks_get`/`task_requests_list` again.
- Do not "optimize" the prefix branch to be sargable by rewriting the WHERE clause — the questions table is small enough that correctness (matching both legacy and current rows) deliberately wins over the index here.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listQuestionsForTask`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
