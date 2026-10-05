# c228b237 — `submit()`'s paste-bracket writer and `writeChunked` bind to `Live` by identity too

Same bug class as `17339316` (see `docs/decisions/17339316-enter-verify-timers-pinned-to-live-identity.md`),
found while fixing it: `submit()`'s `writeNewTurn` closure, and `writeChunked`'s own internal chunk-burst
`step()`, each used to re-derive `live` via `this.live.get(sessionId)` inside a deferred callback instead of
binding to the `Live` the write started on. A same-id respawn (`worker_recycle`/resume/fork) replaces
`this.live`'s map entry for `sessionId` with a brand-new `Live` object; an orphaned callback from the OLD
generation that re-fetches would find the NEW generation's `Live`, pass its `alive` check, and write into
the new generation's real pty on the stale turn's behalf.

The window is reachable: `writeChunked` paces writes at `PTY_WRITE_CHUNK_UNITS` (1024 bytes) per
`PTY_WRITE_CHUNK_DELAY_MS` (8ms) tick, so any submit over ~1KB already spans multiple ticks — a real
kickoff/report body (tens to low hundreds of KB) spans hundreds of ms to low seconds, long enough for a
respawn to land mid-burst.

## The fix — three sites, same pattern as `17339316` (numbered here, and in the hermetic test's own
## comments, as "site 1"/"site 2"/"site 3" — keep the two numberings aligned if either changes)

1. **(site 1) `writeChunked`'s `step()`** — captures `pinned = this.live.get(sessionId)` once at entry (was `live`);
   `step()` bails via `if (this.live.get(sessionId) !== pinned) return;` BEFORE its own alive/killed check,
   using `pinned` (never a re-fetch) for the alive/killed check and `ptyWrite`. On a respawn it returns
   WITHOUT calling `finish()`/`done` — unlike the not-alive/killed exit, which still does. `done` tells the
   burst's own caller (e.g. `writeNewTurn`) that ITS write landed; a respawn means a brand-new Live/pty now
   owns `sessionId` with its own independent lifecycle, so firing the old caller's `done` would resume its
   stale chain (e.g. sending Enter) against state no longer its to act on. The not-alive/killed path still
   fires `done` because that's the SAME Live dying in place, not being replaced — the caller's own
   `busy`/cleanup bookkeeping for its own generation is still correct to run.
2. **(site 2) `writeNewTurn`'s entry check** — bails via `if (this.live.get(sessionId) !== live) return;` using the
   `live` already closed over from `submit()`'s own scope (no new parameter needed — unlike the Enter-verify
   chain, this closure never crosses a method boundary). Once (1) is fixed, this check is UNREACHABLE
   defense-in-depth too: `writeNewTurn` only ever runs synchronously (submit()'s own direct call, still the
   same generation by construction) or as `writeChunked`'s `done` callback, which by (1) can only ever fire
   for the Live it was invoked on — so the mismatch branch here can never actually trigger. No scenario in
   `pty-submit-writenewturn-writechunked-respawn-identity.mjs` exercises it (confirmed by mutation testing:
   reverting both of writeNewTurn's checks together left that suite green); it is kept for the same reason
   (3)'s callback check is.
3. **(site 3) `writeNewTurn`'s deferred `writeChunked` `done` callback** — same identity check, same closed-over
   `live`, used for the alive/killed check and the `BRACKET_PASTE_END` `ptyWrite`. After fixing (1), this
   callback can only ever fire for the Live it was invoked on, but the check is kept anyway — the same
   defense-in-depth idiom `fireEnterAndVerify`'s own verify-timeout callback already uses ("state may have
   changed during the settle wait").

## Do not

- Do not re-fetch `live`/`pinned` via `this.live.get(sessionId)` inside `writeChunked`'s `step()` or
  `writeNewTurn`'s entry/callback bodies — bind to the identity captured at the top of each, mirroring
  `17339316`'s `boundLive` pattern.
- Do not call `finish()`/`done` from `writeChunked`'s `step()` on a respawn (identity mismatch) — only on
  the not-alive/killed path, where the SAME Live died in place. Firing `done` for an orphaned, respawned
  burst resumes its caller's stale chain against the new generation's state.
- Do not assume fixing only `writeNewTurn`'s two bracket sites is sufficient — `writeChunked`'s own `step()`
  has the identical re-fetch defect and is reachable mid-burst from `writeNewTurn`'s own `text` write (the
  long deferral this record measures), so both must be pinned together or the respawn window stays open at
  the chunk-burst layer even after the bracket sites are fixed.
