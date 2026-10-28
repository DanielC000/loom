# Atlas UI build plan

Card `e7717e43`. The owner approved the Atlas V2 design (an Overview tab + a Deck tab, round-4 mockup,
decision request `49e57872`) and asked for a plan that loses nothing from today's app: *"Build this in
its own branch I want to be able to compare before we switch over since I'm still missing some
functionality in the mockups that I would not want to lose. Plan carefully so nothing is lost."*

> ⚠ **One approved-design change has landed since this plan was written.** Card `44f725fe` (the owner's D1 pick on request `fb8de852`) unified the PROJECT node's `Overview` and `Deck` tabs into one home tab, with the dashboard band behind a disclosure — so every row below that maps a surface onto *project › Deck* now lands on that single Overview, and the project node declares nine tabs rather than ten. The Workspace node's own Overview/Deck pair is unchanged. Rationale and the measured geometry: `docs/decisions/44f725fe-atlas-unified-project-home.md`.

This folder is that plan, in four parts:

1. **[Parity checklist](01-parity-checklist.md)** — every route, sub-tab, write action, non-REST write,
   cross-cutting chrome element, keyboard shortcut, URL param, and dev-only surface in today's
   `packages/web/src`, derived from the live code (never from the mockups), mapped to its Atlas home or
   flagged `NOT IN MOCKUPS`. This is the core deliverable — finding the gaps is the job.
2. **[Architecture](02-architecture.md)** — how the Atlas shell coexists with today's UI during the
   build, phase by phase. The owner has decided the delivery mechanism (request `770bfd62`, answered
   2026-10-20): **build on `main`, behind a switch** — today's UI stays the default until an explicit
   owner sign-off.
3. **[Decomposition](03-decomposition.md)** — the ordered build cards, each independently mergeable with
   its own DoD and Playwright verification.
4. **[Risks](04-risks.md)** — what could be lost or regress, keyed to specific parity-checklist rows,
   and which card's DoD closes each one.

## Why `docs/plans/` and not the vault

Every other planning/decision register in this repo (`docs/decisions/`, `docs/adr/`,
`docs/investigations/`) lives in the repo, keyed by id, because it's read by whoever picks up the next
card on this exact codebase — not by a human browsing the vault for design context. This plan is the
same kind of artifact: it will be read by the Dev/Bugfix workers who pick up the decomposition cards
below, from inside their own worktree, which can read `docs/` but cannot reliably reach an
Obsidian-vault-relative path (see `/worker`'s own note on this). The vault is for durable
cross-session design *decisions and vision* (`Projects/Loom/Architecture.md` etc.); this is a build plan
for one epic, with an expected shelf life of "until phase 3 lands" — `docs/plans/` is the correct
register, following the same pattern the comment-taxonomy convention (`CLAUDE.md`) already established
for `docs/decisions/` vs the vault.

## Source material

- Round 4 mockup (approved direction, V2): `Mockups/2026-10-19 UI Overhaul Round 4/` — README (the
  115-write action inventory + the agents/fleet-controls/Platform/card-dialog corrections), `index.html`,
  `png/`.
- Round 3: `Mockups/2026-10-19 UI Overhaul Round 3/` — the Overview-vs-Deck variant split.
- Round 2: `Mockups/2026-10-19 UI Overhaul Round 2/` — the destination/route inventory + IA diagram
  (`ia-diagram.html`).
- Round 1: `Mockups/2026-10-13 UI Overhaul/` — the original three-direction research.
- Live code: `packages/web/src/{App.tsx,nav.tsx,components/Sidebar.tsx,lib/api.ts,pages/*.tsx,
  components/*.tsx}` as of commit `436e55c6` (HEAD at planning time).
