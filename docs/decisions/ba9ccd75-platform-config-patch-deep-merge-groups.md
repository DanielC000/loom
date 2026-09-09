# ba9ccd75 — `PATCH /api/platform/config` deep-merges a fixed set of nested groups

## Narrative

`PATCH /api/platform/config` shallow-merges the submitted top-level keys onto the PERSISTED config rather than replacing the whole blob — a PATCH carrying only one field (e.g. a single Settings toggle) must leave every sibling field the caller didn't touch byte-identical. An OMITTED key is left alone; an explicit `null` (card `fd55ac8a` — the clear sentinel a blanked Settings toggle sends) DELETES the key instead, reverting it to inherit the resolved default.

Card `ba9ccd75` (`backup` added sweep G4, `gateRetry` added sweep G3): the deep-partial groups — `rateLimit`, `watchers`, `timeouts`, `backup`, `gateRetry` — get a DEEP merge instead of the shallow whole-key replace every other key uses. A submitted `rateLimit`/`watchers`/`timeouts`/`backup`/`gateRetry` object merges FIELD BY FIELD onto the persisted group rather than replacing it wholesale, so "omitted = leave alone" holds uniformly at both levels (top-level key AND a field nested inside a submitted group). Before this, `{"rateLimit":{"exhaustedThresholdPct":90}}` silently wiped every other persisted rateLimit field, since the shallow path (`merged[key] = val`) replaces the entire group with just what was sent. A per-field `null` inside the group (accepted by `platformConfigPatchSchema`'s nullable field variants) deletes just that field; whole-group `null` still deletes the whole group unchanged.

## Do not

- Do not add a new nested config group (like `rateLimit`/`watchers`/`timeouts`/`backup`/`gateRetry`) without adding it to `DEEP_MERGE_GROUPS` — otherwise a partial PATCH to that group silently wipes every sibling field the caller didn't send.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`PATCH /api/platform/config`, lines 4529-4544 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
