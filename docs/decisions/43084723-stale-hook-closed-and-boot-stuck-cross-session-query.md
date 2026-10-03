# 43084723 — stale-prior-process hook is structurally closed; boot-stuck visibility now a single cross-session query

Two follow-ups from Code Review `6bddda13` of `b1da256d`, both investigated under this card.

## Item 1 (CLOSED, no code): a prior process's hook can never flip a NEW Live's `anyHookObserved`

Question: can a hook emitted by a PRIOR `claude` process of the same Loom session id arrive, after a
same-id respawn (resume/fork/recycle), and flip the NEW `Live`'s `anyHookObserved`?

No — closed structurally by the per-spawn `hookToken`, independent of relay timing or whether the old
process is confirmed dead first. The chain:

1. `PtyHost.spawn()` mints a fresh `hookToken = randomUUID()` on EVERY call (`pty/host.ts:4814`,
   "Fresh every spawn/resume/fork/recycle") and stores it on the new `Live` (`pty/host.ts:4823`).
2. The SAME call's `createPty` writes that exact token, literally, into the hook-relay command line
   persisted to `settings.json` (`pty/claude-settings.ts:233`:
   `` node "${RELAY_SCRIPT}" ${sessionId} ${PORT} ${hookToken} ``) — the OLD incarnation's hooks config
   was written with the OLD token at ITS OWN spawn time and is never rewritten in place.
3. `/internal/hook` (`gateway/server.ts:3080-3091`) calls `PtyHost.verifyHookToken` BEFORE
   `deliverHook` and returns 403 on any mismatch — fail-closed (`pty/host.ts:6835-6842`, a
   `timingSafeEqualToken` compare).
4. `deliverHook`'s `anyHookObserved` false→true flip (`pty/host.ts:6915-6916`) only ever runs for a
   call that already passed step 3.

So a late-arriving hook from a prior incarnation always carries the OLD token baked into its argv,
always mismatches the NEW `Live.hookToken`, and is rejected before `deliverHook` is ever reached —
regardless of relay delivery latency. `verifyHookToken`'s own doc comment already asserted this
invariant; verified here against the actual mint site + gateway call order, not the comment alone.

## Item 2 (BUILT): a stuck worker's alert survived its manager's recycle — see `b1da256d`'s own "Web
ordering" section for the mechanism and the fix. Membership/trust notes specific to this card:

- `GET /api/orchestration/events?kinds=` is a human-only loopback read (same posture as the existing
  `managerId` form) — reachable only from the web UI's own fetch, never an agent MCP tool. `kinds` is
  validated against `ALL_ORCHESTRATION_EVENT_KINDS` server-side and the DB query uses bound parameters
  (`?` placeholders, not string interpolation) for the `IN (...)` clause — unlike `listScheduleHistory`'s
  trusted-internal-value `kindList` interpolation, `kinds` here arrives from an HTTP query string, so it
  is treated as outside-the-process input even though the route itself is loopback-only.
- `Db.listRecentEventsByKinds`'s `limit` (default 500, newest-first) is a safety ceiling sized for a RARE,
  detector-fired kind pair (one row per genuine stuck/resolved boot-dialog episode, never a per-turn
  event) — not a value expected to bite on a real fleet. Ordering newest-first means a cap that does bite
  drops the OLDEST, least-actionable rows first.
- `activeBootStuckAlerts` (`lib/fleet.ts`) needed NO change — it already paired/keyed by `workerSessionId`
  and checked the worker's own liveness; only the INPUT feeding it changed.

## Do not

- Do not re-add a per-manager/per-session fan-out (`bootStuckCandidates` + one `managerId`-keyed query
  per candidate) to fetch `claude_boot_dialog_stuck`/`claude_boot_dialog_resolved` — it loses a worker's
  unresolved event the moment its filing manager stops being live (the exact bug this card closed).
- Do not interpolate a caller-supplied `kinds` value into SQL unchecked, and do not skip the
  `ALL_ORCHESTRATION_EVENT_KINDS` membership check even though this route is loopback/human-only — treat
  HTTP query input as outside-the-process regardless of the route's trust class.
- Do not lower `listRecentEventsByKinds`'s `limit` to an ordinary paging value (e.g. 50-100) — these kinds
  are rare by construction; a small cap risks dropping an old, still-unresolved, still-actionable episode
  under real fleet-wide event volume from OTHER kinds-agnostic callers that might reuse this method later.
- Do not treat a passing token-mismatch check (item 1) as proof the OLD process is dead — it proves only
  that its hook can't be MISTAKEN for the new incarnation's; process lifetime/kill-confirmation is an
  orthogonal, unaudited concern this card did not need to resolve to close item 1.
