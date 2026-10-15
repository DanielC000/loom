# 81331b0e — gate the manager's `daemon_restart` registration on `isSupervised()`, not `isLoomDev()`

Card 81331b0e, from C3's Code Review (card 2179a923, gen 417): C3 made the PLATFORM router's
`daemon_restart` absent on non-dev installs (registered only when `isLoomDev()`). The MANAGER surface's
`daemon_restart` (`mcp/orchestration.ts`) was still registered on every install — there, only
`requestDaemonRestart`'s `!isSupervised()` refusal (`sessions/service.ts`) stopped it, so every npm-install
manager was shown a tool that always refuses. Same present-but-refusing asymmetry C3 removed, on the
manager surface instead of the platform one.

## Investigation findings

- `LOOM_SUPERVISED` is unreachable on a packaged npm install: it is set in exactly one place,
  `scripts/daemon-supervisor.mjs`, which is excluded from the published npm tarball
  (`scripts/build-npm-package.mjs`'s `files` list is `["bin","dist","assets","README.md","LICENSE"]`).
  `bin/loom.mjs` never sets it on any launch path (`loom start`, `--detach`, or an OS-service-registered
  `loom start --no-open`).
- `isLoomDev()` and `isSupervised()` are independent axes that can diverge either way:
  - `LOOM_DEV=1 pnpm daemon` (tsx watch, no supervisor) — dev **and unsupervised**. Gating registration on
    `isLoomDev()` alone would reproduce the exact present-but-always-refusing bug this card fixes, just in
    a dev-unsupervised shape instead of an npm-install shape.
  - `LOOM_DEV=0 pnpm daemon:stable` (CLAUDE.md's own documented way to test the non-dev surface) —
    **non-dev and supervised**. A real supervisor is present and the tool would actually work there, so
    gating on `isLoomDev() && isSupervised()` would wrongly hide a working capability in that explicitly
    sanctioned test configuration.
- `isSupervised()` is the exact precondition `requestDaemonRestart` itself checks first — gating
  registration on it means "present iff it could ever not-refuse for this specific reason."

## Decision

Gate the manager's `daemon_restart` registration (`mcp/orchestration.ts`) on `isSupervised()` alone,
evaluated fresh per `buildServer()` call (never cached) — mirroring this same manager branch's existing
`deployCommandConfigured`/`hasPeerLinks` conditional-registration pattern. `requestDaemonRestart`'s runtime
refusals (including the supervisor-liveness re-check, card 83718377, for when `LOOM_SUPERVISED=1` but the
supervisor process has since died) are unchanged — this only governs whether the tool is **visible** at
all, not its runtime behavior once called.

## Do not

- Do not gate this on `isLoomDev()` (alone or in addition to `isSupervised()`) — see the two divergent
  cases above; either produces a wrong result in a real, reachable configuration.
- Do not cache the `isSupervised()` read at router-construction time or anywhere outside the per-call
  `buildServer()` evaluation — a hermetic test that toggles `LOOM_SUPERVISED` across calls on the same
  router instance (and, in principle, a live daemon whose supervisor status could only ever be fixed at
  process start anyway) must see the gate re-evaluated every time, matching every other conditional
  registration in this branch.
- Do not alter `requestDaemonRestart`'s own refusal logic or the card-83718377 supervisor-liveness
  re-check — those stay exactly as they are; this card only changes whether the tool is registered at all.
