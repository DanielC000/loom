# f9972a3d — SSH never-echo test markers must come from the key's own secret material, not its header

## Narrative

Round 2's `deriveKeyMarker` sliced the first 40 base64 chars of the stored key's openssh-key-v1
container. Those bytes decode entirely within the container's FIXED header (the `"openssh-key-v1\0"`
magic + the always-`"none"`/`"none"` cipher/kdf-name fields) — identical across every ed25519 key
regardless of its actual secret. A Code Review mutant (`debug: stripped.privateKeyPem.slice(80)`, which
carries the real seed past that header) passed the whole never-echo suite unchanged.

The fix (`deriveKeyMarkers` in `test/connections-ssh-store.mjs`) derives four markers from the actual
Ed25519 seed instead: `base64Seed`/`hexSeed` (the seed re-encoded — hex has no byte-alignment issue
across different containers, so it's what detects a cross-container leak like a PKCS8 `getPrivatePEM()`
dump), `bufferDecimals` (the seed's own `JSON.stringify(Buffer)` shape, for a leak that never stringifies
it), and `privateSectionBase64` (a literal substring of the container's own base64 TEXT, sliced at byte
offset 161 — self-verified against the independently-extracted seed, since that offset is past the
header and survives the reviewer's mutant).

A cross-key isolation control (an independently generated key) confirms the markers key off the real
secret, not the per-connection random checkint — two connections sharing the SAME source key legitimately
share the SAME markers; that is expected, not a leak.

RED/GREEN-proved against the reviewer's `.slice(80)` mutant and a second hex-seed-leak mutant, both
applied to `createSshConnection` in `connections/store.ts` and reverted.

## Do not

- Do not derive a never-echo test marker from a stored container's fixed HEADER bytes — verify it
  discriminates between several independently generated secrets of the same type first.
- Do not assume a base64-encoded marker is a substring of a DIFFERENT base64 container just because the
  underlying bytes overlap — 3-byte group alignment is offset-dependent; use a hex marker, or a
  same-container self-verified-offset slice, when the comparison crosses containers.

## Source

`packages/daemon/test/connections-ssh-store.mjs`'s `deriveKeyMarkers`.
