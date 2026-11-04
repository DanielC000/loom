# 1c9dcb24 — outbound `[[wikilink]]` resolution flags unresolved targets, never strips them

Project memory's `[[wikilink]]` syntax had an inbound resolver (`project-memory-backlinks.ts`'s
`findInboundBacklinks`) but nothing checked a note's own OUTBOUND targets — a link to a renamed,
forgotten, or never-existent key rendered verbatim with no signal it was dead. An audit (card `ee825497`)
found 80 distinct targets (124 citations) resolving to no note in this project's own store, three of them
cited by pinned+never-drop notes that defer content to the missing target.

`project-memory-outbound-links.ts` closes this: `findUnresolvedOutboundLinks`/`findUnresolvedOutboundLinksBulk`/
`buildOutboundLinksIndex` resolve a note's outbound targets against the live key set, fresh at every
read/write, never cached on the note. Wired into `memory_read`/`memory_list` (a new `unresolvedOutboundLinks`
field), the kickoff digest (a compact `[unresolved links: a, b]` line via `unresolvedOutboundLinksDigestLine`),
and `memory_write` (a new post-write advisory `UnresolvedLinkSignal`).

## Why flag unconditionally, with no allowlist

Roughly 14 of the 80 audited targets are legitimate CROSS-STORE references — slugs in the owner's own
personal `~/.claude` auto-memory index, a completely different store this daemon-side subsystem has no
filesystem visibility into. Both a genuine typo and a deliberate cross-store reference use the identical
`[[key]]` syntax, so there is no syntactic signal that tells them apart. A hardcoded allowlist of "these
14 slugs are fine" would drift the instant the owner's own auto-memory gains or renames a slug — the exact
failure class CLAUDE.md already warns about for every other enumerable value copied out of its source
(the `grep -l readdirSync` guard-list recipe is the canonical example). So every unresolved target is
reported the same way; `memory_read`/`memory_write`'s fuller wording acknowledges the possibility of a
cross-store reference so the flag doesn't read as a confirmed error, but no code path tries to
distinguish one from a real broken link.

## Do not

- Do not auto-strip, auto-delete, or auto-rewrite a `[[link]]` whose target doesn't resolve — this
  machinery only ever reports; curation stays a human/agent decision.
- Do not build an allowlist of known-legitimate cross-store slugs (e.g. the owner's personal auto-memory
  index) — that list has no mechanism keeping it in sync with the store it describes and will silently
  go stale.
- Do not filter the existing-keys check by expiry — an expired note still exists (card `57a91801`); a
  link to one is resolved, not broken, mirroring `project-memory-backlinks.ts`'s own expiry-agnostic
  stance (card `527ed4f0`).
- Do not render the fuller cross-store-aware wording into the kickoff digest — that rides every kickoff,
  so the digest marker stays the compact `[unresolved links: ...]` form; the explanatory sentence lives
  only in `memory_read`/`memory_write`.
- Do not have `memory_list`/the kickoff digest re-fetch the corpus just to build the existing-keys set —
  both already hold a fetched corpus in hand; build the set from that, mirroring how `annotateBacklinksBulk`
  avoids memory_list's own N+1 fetch (card `41c3f546`).
