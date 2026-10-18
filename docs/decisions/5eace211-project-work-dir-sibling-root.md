# 5eace211 — `PROJECTS_WORK_ROOT` is a sibling of `LOOM_HOME`, overridable only via an env var

## Context

Agents had been creating ~110 ad hoc test/build/cache folders at the drive root (`C:\cs<8hex>`,
`C:\klokk-m0-target`, `C:\tmp`, …), because the existing per-session scratch dir
(`SCRATCH_ROOT_DIR`/`sessionScratchDir`) is reaped and per-session, so nothing it offers can host a cache
or build target shared across sessions/gates of the same project. This card gives every project ONE
Loom-owned, persistent work dir instead.

## Decision 1 — sibling of `LOOM_HOME`, never nested inside it

`WORKTREES_DIR` already establishes this shape (`@decision sha:e1c6ef65`): `LOOM_HOME` can itself be a
live git repo in the self-hosting setup, and nesting a dir a session will `cd` deep into back inside
`LOOM_HOME` risks a stray relative `cd ..` landing back in `LOOM_HOME`'s own working tree and mutating it.
A project work dir isn't a git worktree, but doctrine explicitly allows a transient clone to live there
("delete clones … when the run is done"), so the same risk class applies, just needing a few more `cd ..`
hops. Keeping it a sibling (`PROJECTS_WORK_ROOT = path.join(path.dirname(LOOM_HOME),
`${basename(LOOM_HOME)}-projects`)`) closes this for free, at zero extra cost, and keeps the path shorter
than nesting under `LOOM_HOME` would (saves the `/projects` segment).

## Decision 2 — the override is a human-set env var, never a `PlatformConfig`/`resolveConfig` key

`LOOM_PROJECT_WORK_ROOT` is read the same way `LOOM_HOME` itself is — directly off `process.env`, not
through `resolveConfig`. This is a host filesystem root, the same trust class as `LOOM_HOME`/
`WORKTREES_DIR`/`gateCommand`/`obsidian.path`: human-only by construction (there is no env-var equivalent
of an agent-facing MCP write path), and routing it through `packages/shared/src/config.ts` would make an
ordinary filesystem-root change a full-gate-triggering edit (CLAUDE.md's own `PLATFORM_DEFAULTS`
bullet) for a value that has no per-project or per-agent meaning — every project on a host shares one
override, exactly like `LOOM_HOME` itself.

## Measured evidence (why a short-root override exists at all)

Measured directly against real, already-built corpora on the development host (no new builds triggered):

- The session scratchpad base that actually broke (`AppData\Local\Temp\claude\<encoded-worktree-path>\
  <sessionId>\scratchpad`): **169 chars**, before any monorepo structure.
- The default `PROJECTS_WORK_ROOT`-keyed base (`~/.loom-projects/<uuid>`): **66 chars**.
- A real cargo target dir (`C:\klokk-m0-target`, 32,300 files): deepest file **162 chars total** — a
  **143-char suffix** beyond its 19-char root. At the 66-char default base: 66+143=**209**, safe.
- A real pnpm store with a Sentry-doppelganger peer-dep tree (`C:\cs<8hex>`, 33,439 files): deepest file
  **262 chars total** — a **250-char suffix**. At the 66-char default base: 66+250=**316 — unsafe.**

The default base safely covers an ordinary pnpm/turbo monorepo build and a cargo build (both measured from
real on-disk corpora). It does not cover the pathological pnpm-doppelganger case that drove Codescape to
`C:\cs<8hex>` in the first place — migrating Codescape onto this mechanism is an explicit follow-up, not
part of this card. `LOOM_PROJECT_WORK_ROOT` exists so a host that genuinely needs that headroom can set
ONE short root once, instead of every agent inventing its own.

## Decision 3 — `gateOpIdEnvOverride`'s `projectId` parameter is required, not threaded per call site

`LOOM_PROJECT_WORK_DIR` must reach every gate type (worker self-check, solo merge confirm, `merge_batch`,
the deploy gate, the ungated-landing check) without relying on 11 separate call sites each remembering to
add it — the exact "shared-unit divergence" failure mode CLAUDE.md's merge-gate section warns about.
`gateOpIdEnvOverride(opId, batchSize, cap, base?)` is already the one chokepoint every one of those 11
call sites routes through (it stamps `LOOM_GATE_OP_ID`/`LOOM_GATE_BATCH_SIZE`/`LOOM_GATE_CONCURRENT_CAP`
onto every gate child, `@decision 720bb7ad`/`@decision fc53ea74`), so the fix adds a REQUIRED `projectId`
parameter there instead of hand-editing each call site's own `runGateSeq(...)` call individually. Every
call site already has a `project`/`projectId`/`finalProjectId`/`args.projectId` binding in scope.

## Decision 4 — build OUTPUT is per-branch/per-worktree under the project work dir; only content-addressed
## caches may be shared bare

Code Review (Klokk escalation `76fe4164`, triage addendum): a cargo `target/` dir shared BARE across
concurrent branches made a gate run a DIFFERENT branch's compiled test binaries — a false green for a
genuinely broken branch, and a false red for a genuinely passing one, both attributed to the wrong
branch. A project work dir that's merely "shared, not per-session" is not automatically safe to point two
branches' build tooling at the same literal output directory.

The discriminator is CONTENT-ADDRESSING, not "is it a cache." A package-download cache or an
`sccache`-style compiler-object cache is safe to share bare across branches because every entry's identity
IS its content hash — two branches writing the "same" entry are, by construction, writing the identical
bytes, so there is nothing to collide on. A compiler's OWN build-output dir (`target/`, `build/`, `dist/`
as a build artifact rather than a published package, …) is keyed by SOURCE STATE, not content hash — two
branches' source states differ, so the SAME output path can legitimately hold two different, mutually
incompatible binaries at once, and whichever branch's gate reads it second wins, silently.

The doctrine fix (`/worker`, `/orchestrate`) is to put build OUTPUT in a dir keyed to the worker's own
branch or worktree id, nested under the project work dir — `$LOOM_PROJECT_WORK_DIR/<branch-or-worktree-
id>/target`, never `$LOOM_PROJECT_WORK_DIR/target` bare. This is doctrine text only (no code mechanism
enforces the sub-path) — a worker that ignores it can still recreate the incident; the fix is instructional
until something stronger is justified.

## Decision 5 — the usage figure is async, bounded, cached, and scoped to known project ids

Code Review: the original sync `measureProjectsWorkRootBytes` walk (`fs.readdirSync`/`fs.statSync`, no
bound) runs on the `served_status` hot path (polled) and inline in three `project_archive` handlers — at
the review's own estimated ~150µs/file, a modest real cache population (tens of thousands of files, as
this card's own real pnpm-build measurement produced) costs single-digit seconds of BLOCKED EVENT LOOP per
call once caches actually land, defeating the entire point of an async daemon.

The fix: `measureDirBytesBoundedAsync` (paths.ts) walks via `fs.promises`, bounded by BOTH an entry-count
cap and a wall-clock cap, and returns `{bytes, truncated}` — a value that hit either cap is reported
HONESTLY as partial (`truncated:true`), never silently rounded down and presented as complete. The
fleet-wide `served_status` figure never walks on the read path at all: a background refresh
(`sessions/project-work-dir-usage.ts`) computes it off to the side, kicked at boot and opportunistically on
each `served_status` read (deduped — never two refreshes in flight at once), and `served_status` always
returns the last-cached snapshot, synchronously, however stale. A single project's own archive-time figure
(soft archive, all three surfaces) is the one place that DOES await the bounded async measurement inline —
a human-triggered, one-off action, not a hot path, so the small latency is the honest cost of an honest
number rather than a cached stale one for an action the human is watching.

The fleet-wide refresh walks ONLY the immediate children of `PROJECTS_WORK_ROOT` whose name matches a
REAL, currently-known project id (from `db.listAllProjects()`/`db.listArchivedProjects()`) — never every
directory entry under the root. `LOOM_PROJECT_WORK_ROOT` is a human-set override (Decision 2) that could
point at an existing, populated directory for reasons that have nothing to do with Loom; walking its
entire contents regardless of what's actually a Loom-owned project dir would make an unrelated bystander
directory's size (or a slow network mount, or a directory the human never meant scanned at all) silently
become Loom's own reported number.

## Decision 6 — the ceiling is per-project, not root-wide, and raised to a value that isn't permanently tripped

The original `PROJECTS_WORK_ROOT_WARN_BYTES` (2 GiB) summed ALL projects' work dirs against one shared
ceiling — a host with a handful of ordinary projects crosses 2 GiB in normal use, making the WARN a
permanent, uninformative fixture rather than a signal. `PROJECT_WORK_DIR_WARN_BYTES` (50 GiB — **a tunable,
not a derived constant**; raise or lower it directly if 50 GiB stops being the right line) is now checked
PER PROJECT: `served_status`'s `projectsWorkRootOverCeiling` is true when ANY single project's own
measured bytes exceeds it, not when the fleet-wide sum does. `projectsWorkRootBytes` itself stays a
fleet-wide sum (useful on its own merits — a capacity-planning number), it just no longer drives the
ceiling check.

## `hasLiveGateForProject` — known blind spots (left open, not closed)

`SessionService.hasLiveGateForProject` (the permanent-delete safety check) reads `GateSemaphore.snapshot()
.entries` — the ADMITTED-or-queued-in-the-semaphore view. Three real gaps, left open deliberately (closing
them is a separate, larger change, and this check is a best-effort safety net, not a correctness
guarantee the way the existing "no live session" guard is):

- **The squash window.** A gate that PASSED releases its semaphore slot (`holdRepoGuardOnExit`) before the
  squash-merge itself finishes — `gate-semaphore.ts`'s own per-repo `squashHolders` tracks that narrower,
  LATER window separately, and `hasLiveGateForProject` does not consult it. A delete racing exactly this
  window could remove a project's work dir while a squash is still writing to it.
- **The dist-importer-check's own pre-admission queue.** `cee17efe`'s coalescing queue (service.ts) can
  hold a landing's follow-up check queued for a moment BEFORE it ever reaches `GateSemaphore.runExclusive`
  — invisible to the snapshot during that narrow window.
- **A stray child process.** If a gate's own child process somehow outlives its semaphore entry (a kill
  that didn't fully reap), `hasLiveGateForProject` has no visibility into it at all — it reads the
  semaphore's bookkeeping, not the OS process table.

None of these is closed by this card. `hasLiveGateForProject` additionally now ALSO checks
`squashHolders` directly (cheap: the same per-repo map `gate-semaphore.ts` already keeps, lookup, not a
new subsystem) — narrowing the FIRST gap without claiming to close it (a squash can still begin writing in
the instant after the check reads clean); the other two remain open. `hasLiveGateForProject`'s own JSDoc
(`sessions/service.ts`) points back at THIS section rather than restating the list, so the two stay in
sync by construction — if this section moves or is renamed, update that pointer in the same change.

## Do not

- Do not nest `PROJECTS_WORK_ROOT` inside `LOOM_HOME` — see Decision 1.
- Do not move `LOOM_PROJECT_WORK_ROOT` (or any future override of this root) into
  `PlatformConfig`/`ProjectConfigOverride`/`resolveConfig` — see Decision 2.
- Do not derive `PROJECTS_WORK_ROOT` via string concatenation — use `path.dirname`/`path.basename`
  (mirroring `WORKTREES_DIR`) so a trailing separator on `LOOM_HOME` can't produce a malformed path.
- Do not make `gateOpIdEnvOverride`'s `projectId` parameter optional/defaulted — see Decision 3; a missing
  id must fail to compile at the call site, never silently reach a gate child with the var absent.
- Do not re-derive `LOOM_PROJECT_WORK_DIR` a second way inside `runGateStep`/`runGateSequential` — the one
  `gateOpIdEnvOverride` chokepoint is the only place that computes it for a gate child.
- Do not point a build tool's own OUTPUT/target dir bare at `$LOOM_PROJECT_WORK_DIR` (or any shared,
  non-branch-keyed subdir of it) — see Decision 4; only a genuinely content-addressed cache may be shared
  bare across branches.
- Do not reintroduce a synchronous, unbounded directory walk on the `served_status` read path or inside a
  `project_archive` handler — see Decision 5; use `measureDirBytesBoundedAsync`, and for the fleet-wide
  figure, the cached background refresh.
- Do not walk arbitrary contents of `PROJECTS_WORK_ROOT` for the fleet-wide figure — see Decision 5; scope
  to child dirs whose name matches a real, currently-known project id.
- Do not revert the ceiling check to a root-wide sum against one shared threshold — see Decision 6; it is
  per-project, and the 50 GiB figure is a tunable to adjust directly, not re-derive.
