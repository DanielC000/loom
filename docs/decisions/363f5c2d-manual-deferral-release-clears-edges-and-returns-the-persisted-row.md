# 363f5c2d — manual deferral release clears both deferral edges, and every release path returns the post-persist row

Found during a full review lane (card 486d4238): a manual `tasks_update({deferred:false})` left two bugs
on the release path.

- M6: the ack was built as `{...owned, ...dbPatch}` — `owned` is the PRE-write snapshot. When the release
  also folds an outgoing `deferredReason` into `body` (card 1d27c3cd), that body write bumps `version` in
  the DB, but the ack echoed `owned.version` (unchanged) — the caller's next title/body write then
  conflicts on a `baseVersion` that was never actually current. The same manual release also never cleared
  `deferredUntilTaskId` — so a card released from a route-(a) deferral kept a stale blocker reference, and
  a later `deferred:true` with no reason was silently ACCEPTED (misread as route-(a), since
  `deferredUntilTaskId` still looked set) instead of being refused by the `c90e9525` manual-reason guard —
  the mirror image of the footgun `cf62c1ef` fixed on the AUTO-release path.
- M7: `listProjectTasks`/`getProjectTask`'s auto-release path (`persistDeferredStateBestEffort`) persists
  the same reason-fold + version bump, but both read sites built their response from the PRE-persist task
  snapshot, overlaying only `deferred`/`deferredUntilTaskId`/`deferredStuck` by hand — so a read that
  itself triggered the auto-release still returned a stale `body`/`deferredReason`/`deferredAt`/`version`.

## Do not

- Do not build a response that just persisted something by overlaying the write's patch onto a pre-write
  snapshot (`{...owned, ...dbPatch}` or equivalent) — a server-computed side effect of the write (a body
  fold, the version bump it causes, an edge clear) can land in the DB without ever being reflected in that
  hand-built object. Re-read the row after the write (`rereadAfterPersist`) instead, at every site that
  persists one of these release side effects — not a second, independently-patched copy of the same fix.
- Do not clear `deferredUntilTaskId`/`deferredUntilEvent` on a manual `deferred:false` release when the
  SAME patch also sets either field explicitly — respect the caller's explicit value; the forced clear
  only fires when the caller left the field untouched (`undefined`).
- Do not forget that the `cf62c1ef` manual-reason guard (`isManualDeferral`) depends on
  `deferredUntilTaskId` actually being null after a release — leaving it set (this card's M6 bug) lets a
  later bare `deferred:true` silently skip the "needs a reason" refusal.

Full narrative: see commits landing this fix for the `mcp/tasks.ts` sites (`updateProjectTask`,
`listProjectTasks`, `getProjectTask`) and the regression tests under `packages/daemon/test/`.
