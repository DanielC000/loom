# ad66e57e — tombstone-filter an unarmable tmp's content tokens before boot attributes it

From `0f58a09a`'s delta Code Review (Q2). PASS 1b's field-shape throw (a record lacking `branch`/`reason`) ran
BEFORE `filterBootTombstonedTokens`, so an unarmable record naming a resolvable repo X whose tokens were ALL
already durably tombstoned for X still got a fresh-token X placeholder: fail-closed but spurious (one-time when
X resolves; stuck pending when it does not).

## Fix

In the shape-throw branch, once `contentIdentity` (absolute `repoPath`) is known, derive the content tokens
(non-empty all-string `tokens`, else a string legacy `token`). If at least one real token exists and
`filterBootTombstonedTokens(tokens, contentIdentity)` leaves none, unlink the tmp and `continue`. This mirrors
the armable branch's fully-tombstoned disposition; the durable tombstone is the supersession proof, so no
superseding write is needed first. Boot path only; the resolver is unchanged.

## Never discards an un-tombstoned token

Partially tombstoned, tokenless, non-string/empty tokens, a tombstone held only for a DIFFERENT identity, and a
relative `repoPath` all fall through to the `0f58a09a` path unchanged. Test:
`packages/daemon/test/merge-quarantine-ad66e57e-tombstoned-unarmable-content.mjs` (controls included).

## Do not

- Do not dispose of the file unless at least one real string token exists AND every one is tombstoned for
  `contentIdentity` itself.
- Do not consult a tombstone by token alone; it is identity-scoped.
