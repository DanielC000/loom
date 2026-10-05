# 37b1ed5f — a companion chat reconnect MERGES its history re-seed, never replaces it

Card `37b1ed5f`. Round 1 of this card fixed the companion chat panel's ordinary reconnect path (a drop +
backoff reopen, not a terminal 1008 close) to re-fetch `GET /api/companion/messages/:sessionId` on
`ws.onopen`, since the panel previously reopened the socket without re-seeding and a reply persisted while
the socket was down stayed invisible until a manual reload. That first pass REPLACED the in-memory
transcript with the fetched history outright (`setMessages(body.messages.map(historyMessage))`).

Code review (round 2) found the replace itself still loses data: between `onopen` firing and the history
fetch resolving, the now-reopened socket's own `onmessage` can already deliver a live frame (a companion
reply, or a cross-channel push), or the user can send a message — both append to `messages` via
`setMessages`. If the replace then lands, it wipes that live arrival from view until the next reload —
the exact failure mode the reconnect re-seed was built to close, just shifted into a narrower window.

## Do not

- **Do not replace the transcript on a reconnect re-seed.** Use `mergeReconnectHistory` (lib/
  companionChat.ts): the fetched history is always the BASE (it already supersedes the whole
  pre-reconnect transcript), and only whatever arrived strictly AFTER the fetch began survives as a merge
  candidate.
- **Do not dedupe a plain chat bubble (youMessage/companionMessage) by id.** It carries no server-assigned
  id on the wire — only a local, per-panel counter (`nextId()`). Matching it against the fetched history's
  real row ids would never find a hit, so an id-only merge would duplicate every ordinary turn that lands
  in both the live push and the fetch. Dedupe it by content (`author`, `channel`, `text`) against the
  TAIL of the fetched history instead, bounded to how many live candidates there are.
- **Do not skip the content dedupe as unnecessary.** The double-capture is real: a proactive
  (heartbeat/reminder/attention-push) reply records to the database BEFORE it is pushed live
  (`companion/in-app.ts`'s `send`/`sendVoice` — `recordSafely` runs, then `deliver`), so a reply firing
  right as the socket reopens can land in BOTH this fetch's response AND the live push, under two
  different ids (none, and the local counter one).
- **Do not merge against the WHOLE pre-reconnect transcript.** Only the slice added strictly after the
  fetch began is a candidate; the fetch's own `history` already covers everything before that instant, so
  merging the full prior array back in would resurrect stale local-id duplicates of turns the fresh fetch
  already carries correctly.
- **Do not expect a live-only media/audio bubble to survive a reconnect re-seed regardless.** It is never
  persisted (`media-out`'s own design, card 9ec79b52; `audio` is transport-only) — one received DURING the
  gap can still end up kept by this merge (its content never matches a history row), but one received
  BEFORE the reconnect began is gone the moment `history` replaces the pre-fetch base, same as a reload.
