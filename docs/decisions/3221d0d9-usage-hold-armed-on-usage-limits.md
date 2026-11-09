# The usage-hold latch is exposed as one boolean on `GET /api/usage/limits`, and the Clear button hides only on a positive "none"

Card `3221d0d9`, discovered from `73b41b5d` (Atlas audit A-13). That card made the Atlas "Clear usage hold" button full-weight only while a session was parked or bailed and a quiet ghost otherwise, because the web could not see the GLOBAL awareness latch (`<LOOM_HOME>/tmp/claude-usage.json`, `usage-awareness.ts`) that blocks `worker_spawn`. No decision record for `73b41b5d` exists in the tree (only code comments cite it), so this one carries the whole reasoning.

## What was decided

- **The field is `usageHoldArmed: boolean` on `GET /api/usage/limits`** (shared type `UsageLimitsResponse`). Chosen over `GET /api/orchestration/status` because that payload is pushed over `/ws/fleet` as a full-snapshot `status` frame built from `pausedScopes` + `schedulerEnabled` only; the latch changes by arming or by wall-clock expiry, neither of which broadcasts, and the next `status` frame would overwrite the cache entry without the field. `/api/usage/limits` is already read with a 30 s refetch by the Workspace page and the classic strip, so the latch is as fresh as that poll.
- **Same predicate as `worker_spawn`**: `isLikelyNearClaudeUsageLimit(now, recencyWindowMs)` with the live `platform.rateLimit.recencyWindowMs`, resolved in the route exactly as `sessions/service.ts` does.
- **A latch file that exists but cannot be read or parsed reads ARMED** (`isUsageHoldArmed`). `worker_spawn` is not blocked by such a file, but clearing is what removes it, and the web hides the button on `false`.
- **The web shows the button full-weight when a session is parked/bailed OR the latch is armed, hides it when both are positively false, and keeps the quiet ghost while the latch read is unloaded or failed.** The button stays mounted through its 4 s "hold cleared" confirmation, since a successful clear is what flips the hold to none.

## Do not

- **Do not expose a timestamp, a path or any file content** on this response. `lastRateLimitAt`/`lastResetsAt` stay daemon-side; the field is a boolean only.
- **Do not re-derive "armed" from the file in the route.** It must stay the `worker_spawn` predicate plus the corrupt-file arm, or the button and the block can disagree.
- **Do not make the corrupt-file case read `false`**, and do not hide the button on an unloaded or errored read, or on a response that omits the field (`!== false` is deliberate). Hiding on "could not tell" strands a hold with no UI route to clear it.
- **Do not move the field onto the `["orchStatus"]` entry** without giving the `status` frame the same field.
