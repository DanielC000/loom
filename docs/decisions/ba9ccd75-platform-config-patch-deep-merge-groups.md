# ba9ccd75 — `PATCH /api/platform/config` deep-merges a fixed set of nested groups

## Narrative

`PATCH /api/platform/config` shallow-merges the submitted top-level keys onto the PERSISTED config rather than replacing the whole blob — a PATCH carrying only one field (e.g. a single Settings toggle) must leave every sibling field the caller didn't touch byte-identical. An OMITTED key is left alone; an explicit `null` (card `fd55ac8a` — the clear sentinel a blanked Settings toggle sends) DELETES the key instead, reverting it to inherit the resolved default.

Card `ba9ccd75` (`backup` added sweep G4, `gateRetry` added sweep G3): the deep-partial groups — `rateLimit`, `watchers`, `timeouts`, `backup`, `gateRetry` — get a DEEP merge instead of the shallow whole-key replace every other key uses. A submitted `rateLimit`/`watchers`/`timeouts`/`backup`/`gateRetry` object merges FIELD BY FIELD onto the persisted group rather than replacing it wholesale, so "omitted = leave alone" holds uniformly at both levels (top-level key AND a field nested inside a submitted group). Before this, `{"rateLimit":{"exhaustedThresholdPct":90}}` silently wiped every other persisted rateLimit field, since the shallow path (`merged[key] = val`) replaces the entire group with just what was sent. A per-field `null` inside the group (accepted by `platformConfigPatchSchema`'s nullable field variants) deletes just that field; whole-group `null` still deletes the whole group unchanged.

## Web client NaN/Infinity collision (part of the same decision)

Widening the per-field schema (`rateLimitPatchOverride`/`watchersPatchOverride`/`timeoutsPatchOverride`/`backupPatchOverride`/`gateRetryPatchOverride`) to accept `null` removed a guard the Settings global-config form (`packages/web/src/pages/Settings.tsx`) was leaning on without its own backstop: a garbage numeric entry (`Number("abc")` → `NaN`, `Number("1e999")` → `Infinity`) JSON-serializes to `null` — the SAME wire shape as the legitimate per-field clear sentinel — so it would silently "succeed" as a clear instead of 400ing. Caught in code review. Fix (`buildGlobalOverride`): route a non-finite parse result through as the ORIGINAL STRING rather than the NaN/Infinity number (`Number.isFinite(n) ? n : s`), so it fails the `number|null` shape check server-side and still 400s readably. Same hazard, same fix, at the separate `maxConcurrentGates` control further down the same file.

## Do not

- Do not add a new nested config group (like `rateLimit`/`watchers`/`timeouts`/`backup`/`gateRetry`) without adding it to `DEEP_MERGE_GROUPS` — otherwise a partial PATCH to that group silently wipes every sibling field the caller didn't send.
- Do not let a numeric form field in the Settings global-config grid send a raw NaN/Infinity parse result through this schema — route it through as the original string instead, or it collapses onto the same wire shape as the clear sentinel and silently succeeds instead of 400ing.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`PATCH /api/platform/config`, lines 4529-4544 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.

Also cited in `packages/web/src/pages/Settings.tsx` (`buildGlobalOverride`, the NaN/Infinity clear-sentinel collision above) — relocated from that file's own inline comment by card `2d9db616`; no wording changed beyond compressing the introductory clause into this record's own framing.
