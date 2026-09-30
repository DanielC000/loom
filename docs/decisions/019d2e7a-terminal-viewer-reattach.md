# 019d2e7a — a terminal viewer is attached to the SESSION, not to the pty process

A `/ws/term` pane used to be permanently bound to whatever was live the instant it attached, in two independent ways. Both produced the same symptom the owner hit daily in the Overview cockpit: a tile that still *looks* like a live terminal, drawing nothing, recoverable only by navigating away and back.

## The two failures

**A closed socket was terminal.** `Terminal.tsx`'s `onclose` wrote `[connection closed]` and stopped. There was no reconnect at all, so after any `daemon_restart` every open tile in the cockpit was dead for the rest of that page's life — while `FleetSocketProvider` and `CompanionChat`, on the same page, both reconnected and carried on.

**A respawn stranded the viewer.** `PtyHost.subscribe()` adds the viewer to whichever `Live` holds the sessionId *at attach time*, but every (re)spawn constructs a brand-new `Live` with `subscribers: new Set()` and overwrites the map entry. After a Stop→Resume the socket was still open and still subscribed — to the discarded, dead `Live`. Nothing the successor pty produced reached it. Keystrokes, meanwhile, *did* reach the new pty, because `writeStdin` resolves the session id fresh on every call. So the pane was frozen and writable at the same time: the worst of the two states to be in, because it gives no signal that anything is wrong.

## The decision

Fix both halves, because neither covers the other. Migration cannot help when the daemon process is gone; a client reconnect cannot help when the socket never closed.

**(a) The pane reconnects,** with the capped exponential backoff ladder `FleetSocketProvider` already uses (1s, doubling, capped at 10s). The xterm instance is built once per mount and outlives every attempt — only the socket is rebuilt.

**(b) The daemon migrates subscribers** at the spawn chokepoint (`adoptSubscribers`), rather than closing the old sockets and letting (a) re-attach.

### Why migrate rather than close

- **The client contract already existed.** `TerminalControl`'s `{type:"reset"}` is documented, verbatim, as *"pty respawned (resume) — clear xterm"*, and `Terminal.tsx` has always handled it. Nothing in the daemon ever emitted it. Closing the sockets instead would have left that frame permanently dead code and quietly retired a design someone had already reasoned through.
- **No gap.** Closing costs a full reconnect round-trip (≥1s of backoff, plus the handshake) on every Stop→Resume and every recycle. Migration is synchronous with the swap.
- **It matches the model already in force.** "Sessions outlive viewers" is an existing invariant of this transport (closing a ws never kills the pty). Its mirror — a viewer outlives the *process*, because it is watching the session — is the same idea, and this is what makes it true.

Migration re-runs `subscribe()`'s own "make this viewer coherent" sequence against the successor: `reset` first (whatever is on screen belongs to a dead process), then ring replay → `sessionId` → `geometry`, in `subscribe()`'s order, so a migrated viewer and a freshly-attached one converge on the same state.

## Do not

- **Do not leave an attached subscriber in a discarded `Live`.** It goes silent while stdin still reaches the successor — a pane that looks alive and is not.
- **Do not leave the outgoing `subscribers` set populated after a migration.** A hard kill's `onExit` is asynchronous and can land *after* the successor is up; `broadcastControl` would then push that dead process's `{type:"exit"}` at a viewer now watching a healthy one.
- **Do not let `subscribe()`'s returned unsub close over only the `Live` it was called against.** After a migration the subscriber lives in a different entry; a captured-only delete leaks it into the successor forever and keeps pushing at a closed socket. It must also delete from whichever entry currently holds the sessionId.
- **Do not buffer stdin typed while the pane is disconnected and replay it on reconnect.** The pty has a real input stream that a queued burst lands in at an unpredictable point — after a respawn, quite possibly into a different process's composer. Dropping the keystrokes and *saying so* is the correct behaviour; the reconnecting strip is that notice.
- **Do not retry the credential-failure closes.** A missing loopback secret or gateway token is not transient, and its recovery path is the existing unlock nonce (card 093981dd). Retrying spins a 401 loop behind a banner nobody is reading.

## Testing notes

- `packages/daemon/test/terminal-respawn-subscriber-migration.mjs` pins (b) hermetically, driving the real `PtyHost` through its `createPty` seam with a fake pty whose `onData`/`onExit` the test fires by hand. Proven RED against `HEAD` via `pnpm --filter @loom/daemon negative-control`.
- `packages/web/e2e/terminal-reattach.spec.ts` pins both halves in a browser against the isolated e2e daemon. The respawn leg drives the **production** `adoptSubscribers` chokepoint through a test-only `respawnPty` key on `POST /internal/test/seed`, which re-registers a canned pty under an existing session id — a genuine respawn would need a genuine spawn, which that fixture's no-spawn guard forbids by design.
- **`context.setOffline(true)` does not close an already-open WebSocket in Chromium** — measured, not assumed: the spec's first run failed on an absent reconnect strip because the pane never saw a close. Offline mode blocks *new* requests only. The spec therefore closes the recorded socket explicitly (raising the same `onclose` a TCP teardown raises) and uses offline mode only to hold the down-window open deterministically.
