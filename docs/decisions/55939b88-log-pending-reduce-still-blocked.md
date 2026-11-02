# 55939b88 — log when a by-token quarantine clear reduces but leaves an entry still blocked

`clearMergeQuarantineByToken` (`packages/daemon/src/git/merge-quarantine.ts`) is called by the in-process auto-clear closures in `git/worktrees.ts` and `git/batch-merge.ts`, and is itself `void`.

## Round 1 — the pending-entry site

Its pending-entry reduce branch (inside `clearTokenFromPendingIndices`) drops the cleared token from a pending quarantine entry that still holds other outstanding tokens — but, before this card, nothing logged that outcome.

Confirmed empirically: zero console output appeared between the arm and a later post-clear status assertion.

A human only discovered the still-outstanding strand later, by querying status, with nothing naming which token(s) remained or whose they were.

## Round 2 (Code Review of `d9438a31`) — the active-entry site, including its own dual-tracked pending twin

Code Review found the identical shape, reached from the same `void` route, in `clearActiveEntryTokenAtKey`'s own reduce branch — including this card's own title class: an `883e29bc` dual-tracked twin (`ta=enter(A); tb=enter(B); clearByToken(tb)`), one entry object armed both active and pending at once.

Fixed via one shared formatter, `logPartialClearStillBlocked(token, entry, writeFailed)`, so the two sites' own log text can never drift apart.

## Round 3 (Code Review of `dd318e2d`) — the active-entry site's own log input was NOT actually the final post-write state

Round 2 passed `updated` itself to the shared formatter at the active-entry site, and claimed this was "the entry's final post-write state" — the SAME claim that is genuinely true at the pending-entry site (where every write is sequential, each one's result feeding into the next). It was not true here: `clearActiveEntryTokenAtKey`'s own dual-tracked-twin loop stores each twin's own `written.entry` into `pendingUnresolvedQuarantines` directly, by design never folding it back into `updated` (`702b4241` round 3's own rule — a twin write must never mutate the object other twins/the active key already used). `writePendingDivertFile`'s marked-basename reread-and-union branch (gated on `keptUnreadableLatchFiles` alone, never on `rebaseOntoRealDiskRecord`) can pull a real on-disk token or contributor into a twin's own `written.entry` that `updated` — and so the log — never named, even though that record still blocks the repo.

Fixed with a LOG-ONLY union (`loggedTokens`/`loggedContributors`), built alongside the writes but never fed back into `updated` or into what is actually written/stored: seeded from `updated` once after the armed-key loop (which DOES feed its own result back into `updated`, so a union there was already covered), then folded with every twin's own successfully-written `written.entry` tokens/contributors as the twin loop runs.

Also reworded the write-failure qualifier from `" (in-memory; durable record still holds the cleared token)"` to `" (one or more durable records still hold the cleared token)"` — the active-entry site can attempt several writes per reduce (one per armed key, plus one per dual-tracked twin), so "the durable record" (singular) was never accurate there.

## Fix

A single log line fires once per reduce, at the end of the branch, after every write attempt that branch makes — never inside a write branch itself, and never once per write when a branch attempts more than one (the dual-tracked-twin case rewrites both the armed key's own final and the twin's own separate pending-divert file, but logs only once).

It names the entry's own `repoPath`/`branch` (the raiser still holding the record).

It names every outstanding token still on the entry's FINAL post-write state at BOTH sites — never a pre-write local. At the pending-entry site this is `live.entry` directly, since every write there is sequential (`writePendingDivertFile`'s own opt-in `rebaseOntoRealDiskRecord:true` can rebase onto a different real on-disk token set than a pre-write local would have named, and each write's result feeds the next). At the active-entry site this is the round-3 LOG-ONLY union described above, never `updated` directly — `updated` alone misses a dual-tracked twin's own on-disk union.

It names `contributorRepoPaths`, when present — every OTHER raiser whose own token was folded into this same entry's flat `tokens` set (`82032b5c`). This is the closest attribution available from data already in hand: `tokens` itself is a flat set with no per-token owner, so a remaining token cannot be attributed to one specific contributor by name — only the set of candidates. At the active-entry site this ALSO comes from the round-3 log-only union, for the same reason as the token list.

It qualifies itself with `" (one or more durable records still hold the cleared token)"` when one or more of the write(s) this reduce attempted did NOT actually land durably — the in-memory reduction still happened (the token is dropped and tombstoned regardless), but at least one durable copy on disk was not updated, so a restart before the write is retried can re-arm the just-cleared token there.

No behaviour change — this is a log line only, at both sites.

## Content-bearing-log classification

This line lives in `git/merge-quarantine.ts`, not `pty/host.ts` or `sessions/service.ts` — it does not route through the `redactedExcerpt` chokepoint `CLAUDE.md`'s log-message-content-gate bullet governs, and is not one of that census's enumerated sites.

What it logs — process-unique `randomUUID` tokens, filesystem repo paths, and git branch names — are identifiers, not session/user/agent text, so the content-redaction gate does not apply here.

## Do not

- Do not log this inside a write branch (any of: `clearTokenFromPendingIndices`' own `writePendingDivertFile` success/failure if/else; `clearActiveEntryTokenAtKey`'s own armed-key loop or dual-tracked-twin loop) — log once, after every write attempt in the branch, against the entry's final post-write state, or a rebase onto a different on-disk token set (or a later write in the same branch) will make the logged token list stale relative to what's actually durable.
- Do not add a per-token-to-contributor mapping to `logPartialClearStillBlocked` — `tokens` carries no per-token owner, so any such mapping would be fabricated; name the candidate set (`contributorRepoPaths`) only, never a specific pairing.
- Do not duplicate the log text at the two call sites — call the shared `logPartialClearStillBlocked` helper from both, or their wording will drift the next time either is edited.
- Do not pass `updated` directly to `logPartialClearStillBlocked` at the active-entry site — pass the round-3 log-only union (`loggedTokens`/`loggedContributors`) instead, or a dual-tracked twin's own on-disk union goes unlogged again (the round-2→round-3 regression this round fixes).
- Do not fold a twin's own `written.entry` into `updated` itself to fix the above — that would violate `702b4241` round 3's own rule that a twin write must never mutate the object other twins/the active key already used; the union belongs in the log-only locals alone.
