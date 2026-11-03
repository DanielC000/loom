# cd9a78bc — `KIND_FACTS` is a UI mirror of daemon behaviour, and its two flags are independent

Child of the shadcn/ui epic `375bbfab` (plan card 6, §4). Built on `e7d6e43b`, which shipped the generic `GET/POST /api/capabilities/:slug/provisioning[/retry]` pair this reads.

## What the record governs

`packages/web/src/lib/capabilityProvisioning.ts` › `KIND_FACTS` — one `Record<CapabilityProvisionKind, { provisioned, network }>` that answers two questions the REST summary cannot:

- **`provisioned`** — does the daemon's per-slug tracker actually populate a status for this kind?
- **`network`** — does provisioning fetch from a remote host?

Both drive the Profiles editor: `provisioned` decides whether a granted capability gets a provisioning row at all, `network` decides whether its picker entry carries a `network` badge.

## Why a web-side map rather than a REST field

A capability's provisioning RECIPE is deliberately daemon-internal and never reaches `CapabilitySummary` (that is `toSummary`'s whole point — package names and commands stay server-side). The summary carries `kind`, and nothing finer. So either the daemon grows a new summary field, or the web derives from `kind`.

This card derived from `kind`, because `kind` is already sufficient for every real catalog row and the plan's §4 badge intent (`github`, `image-gen` and `document-conversion` all badge correctly; `browser-testing` correctly does not). A future daemon-side `CapabilitySummary.network` would be a strict improvement and should replace `KIND_FACTS.network` outright — but it is a daemon change, and this card was scoped to `packages/web`.

The cost is the staleness risk every UI mirror carries, the same posture as `lib/harnessFields.ts`'s codex drop map: the map can go wrong in the quiet direction, where the daemon changes and the UI keeps rendering a stale answer that still looks plausible.

Two things bound that risk:

1. **Exhaustiveness is enforced by the compiler, not by vigilance.** `Record<CapabilityProvisionKind, …>` means the moment the daemon adds a seventh provision kind, `tsc -p packages/web` fails until someone classifies it. A `readonly Kind[]` membership list — the shape this started as — would have silently defaulted the new kind to "no status, no badge" with nothing failing.
2. **The `provisioned` half was verified at source**, 2026-11-03, against `resolveCapabilityServer` (`packages/daemon/src/capabilities/registry.ts`): exactly three of its six branches touch `provisionStatus` — `resolvePythonVenv`, `resolveGithubBinary`, `resolveNpmPinned`, each a per-slug cache / `fs.existsSync` fast path plus a `kickCapabilityProvision` background miss on a cold one. `node-package`, `bundled` and `command` resolve synchronously and never write a status.

## Why `network: false` on `bundled`/`command` is an absence of claim

A `bundled` row's recipe may be `npx -y <pkg>` (fetches) or an absolute path to a local binary (does not). From the web side those are the same row. So the badge is WITHHELD rather than inverted: a missing `network` badge means "not known to fetch", never "known not to fetch". `node-package` is the one kind that genuinely is offline-safe — it `require.resolve`s a dependency already shipped inside the daemon.

This is why the UI shows a badge for network and nothing at all for its absence. An explicit "local" badge would turn an unknown into an assertion.

## Why the provisioning row is gated at all

For an untracked kind the generic route answers a hardcoded `{ state: "idle" }` forever — `getCapabilityProvisionStatus(slug) ?? { state: "idle" }`. An ungated row would therefore sit at **"not provisioned yet"** beside a capability that is in fact mounted and working: a false negative dressed as live status, which is the exact failure class the row was added to kill (a session mounting without its MCP while the checkbox still reads ON).

`document-conversion` is the one legacy carve-out, and it is not cosmetic. That builtin is not a catalog row: `buildMcpServers` (`pty/host.ts`) special-cases both builtins ahead of the registry loop, so markitdown provisions through host.ts's own module-scope globals and reports at `/api/python/provisioning`. The per-slug tracker never sees that slug, so `/api/capabilities/document-conversion/provisioning` would answer `idle` forever too. `provisioningSourceOf` routes it to the global python route for that reason, and keys its react-query entry separately so a daemon-wide status never shares a cache entry with a per-slug one.

## Do not

- **Do not collapse `provisioned` and `network` into one boolean**, however identical today's two derived lists look. They answer different questions, and the identity is a fact about today's catalog — three kinds that happen to be both — not a definition. A kind that is one without the other is the first thing a collapse mis-badges.
- **Do not turn `KIND_FACTS` back into a membership array** (`readonly CapabilityProvisionKind[]`) to tidy it. The `Record` is load-bearing: it is the only thing that makes a new daemon provision kind a build failure instead of a silent default.
- **Do not render a provisioning row for a capability `provisioningSourceOf` returns `"none"` for**, and do not "fix" its permanent `idle` by hiding the `idle` state generally — `idle` is a real, correct state for a tracked-but-not-yet-attempted capability, and suppressing it would hide the pre-warm hint that tells the user nothing is wrong.
- **Do not read `/api/capabilities/document-conversion/provisioning`.** It is a live route that answers `idle` unconditionally; the builtin's real status is at `/api/python/provisioning`.
- **Do not add a "local" / "offline" badge as the negation of `network`.** The absent badge is an unknown for `bundled`/`command`, not a guarantee.
