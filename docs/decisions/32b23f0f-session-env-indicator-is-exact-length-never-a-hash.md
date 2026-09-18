# sessionEnv's write-only indicator is an EXACT length, never a hash prefix

Card `32b23f0f` — the project Settings panel's write-only `sessionEnv` editor.

## The decision

The editor shows each stored entry's **key name plus the exact character length of its value**, and nothing else. It never renders a stored value, and it never renders a hash of one.

Card `32b23f0f`'s own DoD-2 offered a choice — *"length and/or a short sha256 prefix, matching how the Platform Lead has been reporting them"*. The hash half of that offer was **deliberately rejected**, and the length was deliberately kept **exact** rather than bucketed or rounded.

## Why no hash prefix

A short hash prefix is a **verification oracle**, which a length is not.

Given a screenshot of the panel, anyone can test candidate secrets against a hash prefix offline: hash the candidate, compare the prefix, repeat. There is no rate limit, no audit trail, and no way for the owner to detect it happening. With a candidate list — a key leaked elsewhere, a password from a breach corpus, a low-entropy value like a PIN or a short database password — a 32-bit prefix is more than enough to **confirm** a guess.

It also enables **cross-context correlation**: the same prefix appearing in two places proves the two hold the same secret. That links a screenshot of this panel to a key exposed somewhere else entirely.

None of that capability exists today. `sessionEnv` values are already stored in plaintext and already readable by surfaces that can read a project's config, so the secret is not *more* confidential for lacking a hash — but a hash would hand out a **new, offline, undetectable confirmation primitive** that the plaintext status quo never provided. A length cannot do any of it: it can only narrow a candidate set, never confirm a member of one.

## Why the length is EXACT, not bucketed

Bucketing was considered and rejected on evidence. Credential request `1a559b0e` (recorded on card `af08f7e8`) stored a **121-character** blob where the working value was **2,377** characters — a truncated paste that nobody could see, because nothing surfaced the stored size at all.

An exact count is precisely the tell that catches that failure. A bucket (`"long"`, `">512"`) would have read as perfectly healthy for both the 121-char and the 2,377-char case, costing the one diagnostic this indicator exists to provide, in exchange for hiding a length that was never confirmatory to begin with.

## The prohibition

⛔ Do not add a hash, fingerprint, checksum, or any other digest of a stored value to this panel, and do not round or bucket the length. If a future change needs to answer *"is the stored value the one I think it is?"*, that question is the oracle — it does not have a safe indicator-shaped answer, and the honest route is to let the human overwrite the entry rather than to confirm its contents.

## Scope note

This decision governs the **indicator only**. The panel's separate write-only guarantees — never rendering a value, blank-means-keep, and removal via an explicit `unset` dot-path — are documented as guard comments at their own call sites in `packages/web/src/pages/Settings.tsx` (`SessionEnvRow`, `buildOverride`'s `sessionEnv` block, and `SessionEnvEditor`).

## Two mechanics the panel depends on, recorded because they are not obvious from the source

### `sessionEnv` already deep-merges key-by-key, so the panel sends only deltas

`mergeConfigOverride` → `deepMergeRecord` recurses into **any** plain object, and `sessionEnv` is a plain `Record<string, string>`. So the config PATCH merges the map **entry by entry**, not wholesale.

That is what makes the write-only design possible at all: the panel strips `sessionEnv` out of the cloned override and sends only the entries the human actually changed. An untouched entry is never in the payload, and the server preserves it byte-for-byte. Nothing in the client has to hold, echo, or round-trip a secret in order to keep it.

Side effect worth keeping: before this, `structuredClone(ov)` carried the stored secrets into **every** save, so an unrelated edit (a `gateCommand` tweak) re-POSTed the full service-account key over the wire on each Save. It no longer does.

### `dirty` is a JSON-diff of the built override, so it is blind to an `unset`-only control

`ConfigEditor`'s dirty check is `JSON.stringify(built) !== baseline.current`. Since card `546034fa` a deletion is expressed as a dot-path on the **separate `unset` array**, which `built` does not contain.

A staged `sessionEnv` removal therefore changes nothing the dirty check can see: Save stays **disabled**, and the removal — the panel's primary new action — cannot be committed at all. The fix is `sessionEnvDirty`, derived from the rows' own intents and OR'd into `dirty`, re-baselined in the mutation's `onSuccess`.

⛔ `unset.length` cannot substitute for that check: `buildOverride()` pushes `"orchestration.schedulerEnabled"` unconditionally on every build, so `unset` is never empty and any length-based guard reads dirty always.

The existing scalar fields do not hit this, which is why it was easy to miss — they push an `unset` path *and* `delete` the key from `built` in the same breath, so the JSON diff happens to see the deletion. The trap bites only a control with nothing to delete locally, because its value was never in `built` to begin with.

**This fails as a disabled button**, so a render-only check reads perfectly healthy and a unit test on the derived flag passes. It is guarded by an exercised-control assertion in `packages/web/e2e/settings-session-env.spec.ts`; reverting the `|| sessionEnvDirty` clause and rebuilding makes that test fail with `Received: disabled` while the file's other tests still pass.
