# 595e2a47 — splitting Settings by the scope its sections actually write

Atlas P2-12 (epic `9fe8cd4e`), closing parity gap §J.9 of `docs/plans/atlas-ui/01-parity-checklist.md`. Round 2 proposed splitting `Settings.tsx` "by depth"; nothing had ever checked it section by section. This record is that check and the placement it produced.

## Do not

- **Do not place a section by what its title suggests.** Placement is the API call the section's own component MAKES. "Project Links" is daemon-global; "Connections" reads `api.projects()` and is still daemon-global; "Interface" writes no API at all.
- **Do not give a section its own read of `useAtlasUi()`.** The switch is read exactly once, at `Settings()`'s own entry, and the section list is filtered there. A section that re-reads it grows a second, per-shell idea of where it belongs, and the two can then disagree.
- **Do not add a second section list beside `SETTINGS_SECTIONS`.** Both shells and all three mounts render from that one array; a per-shell copy is the drift this whole card exists to remove.
- **Do not add tabs to either Settings node without re-reading the owner's draft rule.** Neither node has tabs today, so "keep panels mounted across a tab switch" is vacuous here. Introducing tabs re-opens it: `ConfigEditor` and `GlobalConfigForm` both hold large unsaved drafts, and unmounting one on a tab click destroys it.

## The table

Derived by reading each section's component and recording the `api.*` members it calls. 38 `SectionLabel` call sites exist in `Settings.tsx` (the plan's "~26–29" was an estimate, and low): 9 top-level sections, 23 sub-sections inside four of them, and 6 dynamic list headers (`Connections (3)`) inside panels already placed. Only the 9 top-level rows are a placement decision; the other 29 follow their parent by construction, each living inside that parent's component with no mount of its own.

| # | Section | Write call(s) | Read call(s) | Placement |
|---|---|---|---|---|
| 1 | Interface | *none* — `localStorage` via `lib/atlasUi.ts` | *none* | **workspace** (argued, below) |
| 2 | Project Settings | `updateProject(id,…)` · `updateProjectConfig(id,…)` · `updateProjectColumns(id,…)` | `getPlatformConfig()` · `board(id)` · `mergeGateStatus(id)` · `harnessDrain(id)` | **project** |
| 3 | Global / Daemon | `updatePlatformConfig(…)` | `getPlatformConfig()` · `harnessDrain()` | **workspace** |
| 4 | Connections | `createConnection` · `createOAuthConnection` · `deleteConnection` · `initiateOAuthConsent` | `connections()` · `projects()` · `profiles()` | **workspace** (argued) |
| 5 | Pending bindings | *none* — links to `/actors`, which commits the grant | `pendingBindings()` | **workspace** (argued) |
| 6 | Poll Jobs | `createPollJob` · `updatePollJob` · `deletePollJob` | `pollJobs()` · `connections()` · `allSessions()` | **workspace** |
| 7 | Capabilities | `createCapability` · `deleteCapability` | `capabilities()` | **workspace** |
| 8 | Project Links | `createProjectLink` · `deleteProjectLink` | `projectLinks()` · `projects()` | **workspace** |
| 9 | Disk Reclaim | `reclaimNodeModules(…)` | `nodeModulesReclaimable(…)` | **workspace** |

Added since, by the same rule (the call its component makes), and not part of this card's own audit:

| # | Section | Write call(s) | Read call(s) | Placement |
|---|---|---|---|---|
| 2a | Project Lifecycle (card `c9b78d80`, `atlasOnly`) | `updateProject(id,…)` · `archiveProject(id)` · `deleteProjectPermanent(id)` | `allSessions()` | **project** |

Sub-sections, following their parent: **project** — Repository Binding (in `RepoPathEditor`); Board Columns, Permission Allowlist, Orchestration Caps, Merge gate, Resume Doc Rotation, Default Harness, Doc Lint, Python, Session Environment, Memory (in `ConfigEditor`). **workspace** — Rate Limits, Watcher Cadences, Timeouts, Authenticated Request Guard, Message Delivery, Browser notifications, Scheduler, Default Harness, Gate Concurrency, Backups & Telemetry, Elevated Operator, Remote Access (in `GlobalConfigForm`); plus the 6 list headers inside the Connections / Pending bindings / Poll Jobs / Capabilities / Project Links / Disk Reclaim panels.

## The structural check that makes the table trustworthy

`useActiveProject()` is imported once in `Settings.tsx` and called at exactly one site — the page entry. Its value reaches exactly two components, `RepoPathEditor` and `ConfigEditor`, both inside row 2. Every other section is active-project-blind by construction, not by inspection. So "which sections are project-scoped" has a mechanical answer, and it is row 2 alone.

> **Amended by card `c9b78d80`.** A second project-scoped row now exists — **Project Lifecycle**, between rows 2 and 3 — and it calls `useActiveProject()` a second time, for `setProjectId` (a project it just archived or deleted cannot stay the active one). So the check above no longer holds as written: the project-scoped set is rows 2 and 2a, and the hook has two call sites. The check it was making still has a mechanical answer — grep `useActiveProject` in `Settings.tsx` and read which sections the call sites sit inside — it is just no longer a one-liner. That row is also the array's first `atlasOnly: true` entry; see `docs/decisions/c9b78d80-atlas-project-lifecycle-on-settings.md`.

## The three rows placed by argument, not by lookup

**Interface** makes no API call in either direction — it is a per-browser `localStorage` preference. Placed on workspace because what it changes is the whole app's chrome, which is no one project's business; the classic page's reason for putting it first (the owner flipping it to compare) is already served inside Atlas by the frame's own `atlas-leave` button on every node.

**Connections** reads `api.projects()` and a connection row can carry an optional `projectId`. That is a per-row *assignment*, not a per-page scope: the panel lists every connection regardless of the active project, and the read only resolves a name and populates the create form's scope selector. It never rescopes.

**Pending bindings** has no write call at all — a read of the daemon-global `/api/pending-bindings` queue plus a link to `/actors`, where the grant is actually committed. Placed by its read's scope and by its destination being daemon-global too.

## No section is genuinely ambiguous

"Default Harness" appears under both row 2 and row 3, but those are two distinct sections in two distinct components writing two distinct layers — the project override and the platform default — which is exactly the layering those panels describe to the reader. Nothing writes both scopes. Nothing reads one and writes the other except row 2's `getPlatformConfig()`, which exists only to render the inherited "effective: …" hint beside each project field and writes nothing.

## Where the two nodes live

`/settings` keeps its NAV_PAGES entry and stays `scoped: true`, so under Atlas it is the project tier's Settings node. The workspace rows needed an address on the workspace tier: `/workspace-settings`, a new `ATLAS_HOMES` row (Atlas-only — a NAV_PAGES entry would put a second Settings row in the classic rail for a user who never opted in). Both are labelled "Settings"; depth disambiguates them, as it already does for the two "Home" nodes. With the switch off, `Settings()` renders every row in declaration order and the classic page is unchanged.
