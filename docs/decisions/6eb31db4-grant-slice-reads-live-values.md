# 6eb31db4 — the editor's grant slice reads live values; never pin a key to a constant

## Narrative

Card `3c4e0df6` built the Profiles editor's pre-save grant confirm: before a save that ADDS a human-only
grant lands, name what is being granted and which bound agents it already reaches. It compares two
`ProfileGrantFields` slices — the stored row against what the save would land — using the same
`addedProfileGrants` helper the daemon uses to file its own audit event.

Seven keys sit on `AGENT_FORBIDDEN_PROFILE_KEYS`, and at that point the editor exposed a control for six
of them. `vaultWrite` (card `be8be211`'s confined vault-write grant) had no toggle at all — only raw REST
could set it — so the "after" adapter pinned it:

```ts
// Not an editor-exposed control today, so a save can never change it; …
vaultWrite: false,
```

The reasoning was locally sound and the comment stated it honestly. It was still the wrong shape, because
the premise it rests on ("no control exposes this") is a fact about the UI at one moment, while the pin is
permanent. Card `6eb31db4` then added the toggle one card later, and a pin left in place would have been a
**silent fail-open**: the human ticks vault write, `grantFieldsOfValues` reports `false` anyway,
`addedProfileGrants` sees no added grant, `planGrantSave` returns `kind: "save"`, and the grant lands with
no confirm and no blast-radius disclosure. Nothing fails; the save simply succeeds the way an ungranted
save does. That is indistinguishable from correct behaviour from the outside — which is precisely the
failure class `3c4e0df6` exists to eliminate, reintroduced through its own adapter.

The same card moved both adapters out of `pages/Profiles.tsx` into `lib/profileGrantReach.ts`. That is not
cosmetic: the page is JSX, so no unit test in this package (bare node scripts, type-stripping only, no
React renderer) could import it. With the adapters in the JSX-free lib, `test/profile-grant-reach.mjs`
asserts the live-value property directly, and a future pin fails a test rather than waiting to be noticed.

## Do not

- Do not pin any key in `grantFieldsOfValues` to a constant because the editor exposes no control for it
  yet. Read the live field. A pin outlives the condition that justified it, and the resulting
  no-added-grant verdict saves a trust-boundary widening with no confirm — a fail-open that looks exactly
  like a normal save.
- Do not add a member to `AGENT_FORBIDDEN_PROFILE_KEYS` and wire a Profiles control for it without also
  adding it to `ProfileGrantFormValues` + `grantFieldsOfValues` and to the live-value unit test. The
  `ProfileGrantFields` return type catches a MISSING key at compile time; it cannot catch a key present
  with a constant value.
- Do not move these adapters back into `pages/Profiles.tsx`. They are in `lib/` so a unit test can import
  them without JSX; the page's own `ProfileFields` satisfies `ProfileGrantFormValues` structurally, so
  nothing is gained by coupling them to the component again.
- Do not compare `allowText` raw in place of `parseAllowDelta(allowText)` — a whitespace-only edit would
  read as a newly granted permission glob.
