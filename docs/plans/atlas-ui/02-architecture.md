# Architecture

How the Atlas shell coexists with today's UI during the build, and what stays reused verbatim.

## The one hard rule: reuse the data layer, never fork it

Every Atlas screen reads and writes through the **existing** `packages/web/src/lib/api.ts` +
`@tanstack/react-query` hooks — the same `api.startSession`, the same `useQuery(["allSessions"], …)`
cache keys, the same mutation `onSuccess` invalidation. Atlas is a new **presentation layer** over the
existing data layer, not a parallel one. Concretely:

- No new `api2.ts`, no duplicate fetch wrappers, no second credential-guard chokepoint
  (`guardedFetch`/`authHeaders` in `api.ts` stay the only place a 401/429 is interpreted — see
  `@decision 093981dd`/`9ccedbee`).
- A new Atlas component that needs data imports the existing `api.*` call or the existing hook
  (`lib/useSessionActions.ts`, `lib/useAllAgents.ts`, etc.) directly. If a genuinely new shape of read is
  needed (e.g. a combined KPI readout the Deck wants that no existing call produces), it is composed
  **client-side** from existing calls first; only escalate to a new `api.ts` member if composing
  client-side is provably too many round-trips, and even then it's a new member of the *same* `api`
  object, reviewed the same way any other write/read addition is.
- React-query cache keys are shared across old pages and new Atlas screens by construction (same calls,
  same keys) — a mutation fired from an Atlas card dialog invalidates the exact same keys the old Board
  page's dialog invalidates, so the two can run side by side without double-fetching or going stale
  against each other.

This is the single biggest risk-reducer in this plan: because the data layer is untouched, nothing about
*correctness* can regress by building Atlas — only *placement* (does the write/read have a home) and
*presentation* (does the new chrome around it work) are actually new surface area, and that is exactly
what the parity checklist (`01-parity-checklist.md`) audits.

## Phase 1: the switch, the empty shell, then today's pages mounted unchanged

**Decided mechanism (owner answer, request `770bfd62`, 2026-10-20): build on `main`, behind a switch.**
Atlas lives beside today's UI from the very first card; today's UI stays the **default** for every user
until the owner explicitly signs off the parity checklist and flips the switch's default — see
`03-decomposition.md` P1-0. There is no second branch, no second checkout, no second daemon: one build,
one deploy, one `daemon_restart`, same as every other feature on this project.

The switch itself is the smallest thing that can carry an on/off decision cleanly through this codebase:
a persisted, human-only flag (Settings UI toggle, `localStorage`-backed to start — promotable to a real
per-user server-side preference later if the owner wants it to follow them across browsers) that gates
which top-level shell `App.tsx` renders. **Default off.** Comparison, per the owner's stated need, is a
live in-app toggle, not two tabs or two daemons.

Once the switch exists (P1-0) and is proven to be a true no-op when off, phase 1 adds the Atlas shell —
tree, breadcrumbs, node tabs — as a new layout **around** the existing page components, mounted
**verbatim**, zero behavior change to the pages themselves:

- A new top-level layout component (the tree + breadcrumb chrome) renders behind the switch described
  above, alongside — never in place of — today's `Sidebar` + `<Routes>`, so flipping the switch off at
  any point is a true no-op on the existing UI.
- Every one of the 17 `NAV_PAGES` entries (and the 3 parameterized routes) gets a **node + tab**
  address in the tree, but the tab's *content* is the existing `<Overview />`, `<Board />`, `<Settings />`
  etc. component, imported and rendered exactly as `nav.tsx` already does — no new props, no behavior
  fork. A node tab is, at this phase, a thin wrapper that renders `{element}` from `NAV_PAGES`.
- The `scoped` flag in `NAV_PAGES` already tells the shell which pages need the active-project context —
  phase 1 keeps `ActiveProjectProvider` exactly as is; the tree's own node selection becomes the thing
  that *sets* the active project (round 2's "tree selection is scoping" — real wiring, not a relabel),
  but the pages underneath don't know or care that their project got set by a tree click instead of a
  rail-chip click.
- Legacy routes become redirects into node+tab URLs (mirroring the existing 8 redirects' own pattern —
  nothing new to invent here, just more of the same mechanism), so a bookmark to `/board` or
  `/actors?tab=skills` keeps working.
- Cross-cutting chrome (§E of the parity checklist) — Command Palette, banners, toasts, First-run
  welcome — stays mounted exactly where `App.tsx` mounts it today: outside the node/tab tree, at the
  shell root. None of it needs to know Atlas exists.

**At the end of phase 1, Atlas is navigable and every single parity-checklist row with a stated Atlas
home is reachable, functionally identical to today, just reached through the tree instead of the rail.**
This is deliberately the lowest-risk phase: because nothing is rebuilt, nothing in the parity checklist
can regress here — the phase exists purely to stand up the tree/breadcrumb shell and prove the reuse
promise above actually holds before any pixel is rebuilt.

**Every phase-1/2 card merges to `main` through the ordinary worker gate, same day, same as any other
card on this project** — there is no second branch to rebase, no second checkout to keep alive, no
second daemon. That is the direct benefit of the owner's decision: drift between Atlas and `main` is
structurally impossible, because Atlas code *is* `main` code, just gated off by default.

## Phase 2: rebuild the owner-approved surfaces, behind the same switch

Phase 2 replaces the *placement*, not the data, for the specific surfaces the owner actually approved a
new design for (round-4 V2): the Overview/Deck split, the fleet controls cluster, the Agents panel +
node, the full Platform node (both editions), and the card dialog. Each of these is a genuinely new
component, but every one of them is built by composing the *same* `api.*` calls and hooks phase 1 already
proved work — e.g. the new Agents panel uses the exact `SpawnControls`/`AgentControl` components and
`api.startSession`/`stopSession` calls `Overview.tsx` uses today, just laid out per the round-4 mockup
instead of in the old 7-section stack. Every phase-2 card lands **behind the same switch** P1-0 added —
no card in this phase ever changes what a user who hasn't opted into Atlas sees.

This phase is also where the 10 gaps from `01-parity-checklist.md` §J get closed — see
`03-decomposition.md` for which card closes which gap.

## Phase 3: parity sign-off, then switch-over, then retirement

Phase 3 is a single gate, not a rebuild: every row in `01-parity-checklist.md` gets checked off against
the *built* Atlas (not the mockup), the owner compares old-vs-new live via the switch (the entire reason
it's a toggle and not a silent replacement), and **only once that sign-off lands** does a dedicated
switch-over card flip the switch's *default* to Atlas (and, in a later, separate step, delete the old
shell). Until sign-off, both UIs are live behind the one switch and the old one is never touched except
for a genuine regression fix shared by both (which, per the reuse rule above, should be rare — most bugs
are data-layer bugs that both UIs inherit identically).

## Code Reviewer routing

Per standing project guidance (critical/load-bearing changes get a Code Reviewer pass before merge), the
cards most worth a Reviewer pass are the ones that touch shared, trust-boundary, or hard-to-reverse
surface:

- The phase-1 shell/routing card (anything that touches `App.tsx`'s route table or
  `ActiveProjectProvider` is touching every existing page's behavior, even though the intent is zero
  change).
- Any card that adds a *new* `api.ts` member (a new write is a new trust-boundary surface by definition
  — see `CLAUDE.md`'s loopback-write-guard decision record).
- The phase-3 switch-over card (flipping the default for every user) and the separate old-UI-removal
  card (deleting the old shell is the one truly hard-to-reverse step in this whole plan).
- The Companion mode/section placement card (closing gap §J.1) — Companion write actions already carry
  real trust-boundary weight (capability grants, restricted-tools, lead mode), so placing them correctly
  matters more than most relocations.
