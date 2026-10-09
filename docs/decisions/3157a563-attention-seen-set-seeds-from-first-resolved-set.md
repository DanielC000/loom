# 3157a563 — `useNewAttention` seeds its seen-set from the first RESOLVED attention set, not the first render

## Do not

- Do not seed the seen-set on the first effect pass. That is the defect this record exists for: on a cold load the first pass runs before `allSessions`/`openQuestions`/the kind-filtered event queries have resolved, so `items` is `[]`, the seen-set seeds EMPTY, and every already-pending item is announced as brand new the moment the data lands — a browser `Notification` and a toast for the whole backlog on every single page load, `page.reload()` included.
- Do not narrow `useAttention`'s `resolved` to a subset of its queries. Each attention kind has its own source and they resolve independently, so an item whose query is still pending is simply ABSENT from `items`; seeding against that absence is the same bug one kind at a time. This is the same rule the neighbouring `loaded` gate's own comment already states for the dismiss-prune ("THE GATE MUST NAME EVERY QUERY A DISMISSABLE KIND IS DERIVED FROM"), arrived at from a different incident.
- Do not fold `resolved` into that `loaded` gate, or vice versa. They are deliberately different populations: `loaded` names only the queries DISMISSABLE kinds are derived from, which is all its prune has to be correct about, while `resolved` must name every query ANY kind comes from. Collapsing them would either over-gate the prune or under-gate the seed.
- Do not gate `resolved` on `data !== undefined` instead of `!isPending`. react-query leaves `data` undefined forever after a failed fetch, so a data-only gate turns one broken poll into permanently suppressed notifications. `isPending` treats an errored query as settled, which is what makes the fix fail-open.
- Do not assert "no notification fired" from a bare wait. The toast surface's request count pill is level-triggered off the same `items` array, in the same component (`ToastContainer`), as the edge-triggered `useNewAttention` call — so the pill reaching the expected count is the witness that the items really arrived and that render's effects really ran. Order a post-load item's own notification BEFORE the zero-assertion too: once a later notification has been recorded, every earlier passive effect has definitely flushed, so the zero cannot be a race.

## What changed

`useAttention` now also returns `resolved: boolean` — true once `sessions`, `questions`, `bootStuckEventsQuery`, `vaultLockEventsQuery`, `codexGapEventsQuery`, `crashLoopAbandonedEventsQuery`, `crashLoopRecoveredEventsQuery` and every per-manager entry of the `eventQueries` fan-out has settled. `useNewAttention` returns early while that is false, so its first seeding pass is the first pass carrying the real set. Genuinely new items — anything appearing after that seed — still fire exactly as before.

There is no false-true window on the fan-out: the per-manager queries are derived from `managers`, itself derived from `sessions`, so the render in which `sessions` first resolves is also the render in which those queries first exist as pending.

## Residual, accepted

A genuinely hung (never-settling, never-erroring) query holds `resolved` false and so suppresses the new-item signal for as long as that lasts. That is correct rather than a regression: the attention set being announced is unknown while any of its sources is unknown, and the same hang already leaves the attention queue itself incomplete on screen.

## Coverage

- `packages/web/e2e/attention-no-replay-on-load.spec.ts` — 3 pending requests seeded BEFORE the load fire zero notifications while the pill witnesses all three arrived; a 4th seeded AFTER the load fires exactly one. Proven RED against the pre-fix bundle (3 replayed notifications instead of 0).
- `packages/web/e2e/notification-mutes.spec.ts` — phase B was re-derived off this change: it used to lean on the replay (unmute, reload, the already-pending request re-fires). It now asserts the no-replay property as its own witness and seeds a second request after the load as the positive control.
