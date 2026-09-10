# 7234688b — the in-flight spawn count feeding the concurrency cap must be scoped PER-MANAGER

## Narrative

Card 7234688b: the prior daemon-global sum here was a REAL BUG, not "conservative." `liveWorkers` (the
concurrency-cap check) is THIS manager's own live count, so the in-flight term summed against it must
share that SAME scope, or the comparison is meaningless. This used to sum the daemon-global
`inFlightSpawnTaskIds.size` instead — a sibling manager B's own in-flight spawn (which can legitimately
run for B's ENTIRE worktree-provisioning window: a bounded install up to `PROVISION_TIMEOUT_MS` plus a
bounded build up to `PROVISION_BUILD_TIMEOUT_MS`, `git/worktrees.ts` — seconds to minutes, not a
microsecond TOCTOU) inflated THIS manager's own admission check, wrongly cap-rejecting a spawn even while
THIS manager was genuinely below its OWN cap.

Worse, that daemon-global claim releases in a bare `finally` with no drain call — only a RETIREMENT of
one of THIS manager's own workers ever drains its queue — so a wrongly-rejected entry had no trigger to
re-admit until an unrelated retirement or the cap-queue's 30-minute TTL.

`inFlightSpawnCountByManager` fixes the scope mismatch directly: it counts only in-flight claims THIS
manager itself currently holds, so a sibling manager's spawn can never affect this check again.
`maxConcurrentWorkers` is documented (Settings UI: "Max workers / manager") as a PER-MANAGER limit — this
restores that stated semantics; the daemon-global term was never enforcing a real daemon-global limit to
begin with, so nothing is being removed here that was actually protecting anything at the daemon scope.

## Do not

- Do not sum a daemon-global in-flight count against a per-manager `liveWorkers` count — the scopes must
  match, or a sibling manager's own (potentially minutes-long) in-flight spawn wrongly cap-rejects this
  manager even while it's genuinely below its own cap.
- Do not assume a wrongly-rejected spawn will self-correct quickly — the daemon-global claim released in
  a bare `finally` with no drain call, so it could sit wrongly-blocked until an unrelated retirement or
  the cap-queue's 30-minute TTL.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s concurrency-cap admit, the
per-manager scoping paragraph): lines 6045-6060, as of commit `6916c813858798391bb28ea1b16d0f524da5cbd9`
(`fix(orchestration): scope the in-flight spawn count per-manager to match the cap check`). Relocated by
card `61632c05` (tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph
and the `//` comment markers stripped.
