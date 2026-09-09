# b8de5876 — `start()` remembers `dbPath` for the instance's whole lifetime, not just the boot call

## Narrative

`dbPath` is the DB-persisted `integrations.codescape.path` override, when the caller has DB access (`index.ts` boot does; `CodescapeSupervisor` itself has none). Card `b8de5876`: `start()` remembers it on `codescapePath` for the REST of the instance's life — not just this call — so the enablement check inside `start()`, the actual `ingest`/`serve` spawn (this call AND every later restart-on-death spawn, which runs long after this call has returned), and the boot log line all resolve the SAME candidate.

Before this, `start()` only ever checked env/bare-PATH, so a host configured via the DB path alone (no global install) logged "codescape off" at boot while the per-spawn seam (`pty/host.ts`) — which DID thread the DB path — went on to conclude "enabled", disagreeing within the same boot and leaving the feature unactivatable.

`start()` itself is a no-op (a) when disabled (`isCodescapeSupervisorEnabled()` false), or (b) when already running/starting. It ingests each of `repoPaths` in order (v1 bootstrap — see `docs/decisions/194d343d-codescape-cwd-contract-pin-codescape-home-in-spawn-env.md`), reserves a loopback port, then spawns and supervises `serve`. Async, best-effort: an ingest failure is logged and does NOT abort the boot — serve still starts, since an empty or stale project index there is a Codescape-side concern, not a reason to leave serve down.

## Do not

- Do not re-derive the codescape binary candidate from env/bare-PATH alone on a restart-on-death spawn — always resolve through the `codescapePath` remembered from `start()`'s own `dbPath`, or a DB-only-configured host silently disagrees with itself about whether codescape is enabled.

## Source

JSDoc method comment in `packages/daemon/src/codescape/supervisor.ts`, above `start`: originally lines 932-947, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
