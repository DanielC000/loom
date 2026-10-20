# Parity checklist

Everything below is derived from the live code as of commit `436e55c6` — never from the mockups. Each
section states its own extraction method so the method can be re-run if the code moves before the build
starts. "Covered" / "Atlas home" columns record what round 2–4 actually mocked up; `NOT IN MOCKUPS` or
`⚠️` flags a genuine gap. Section J collects the gaps in one place.

## A. Routes & navigation

Source: `packages/web/src/nav.tsx` (`NAV_PAGES`) + `App.tsx`'s `<Routes>`. Read directly, not grepped —
the file is small enough and is itself the single source of truth the app, the Command Palette, and the
Sidebar all derive from.

**17 nav destinations** (`NAV_PAGES`, in `nav.tsx` order):

| # | Label | Route | Group | Scoped | Atlas home (round 2/4) | Covered |
|---|---|---|---|---|---|---|
| 1 | Mission Control | `/` | operate | no | Workspace › Deck | ✅ |
| 2 | Overview | `/overview` | project | yes | project › Deck (Mission Deck) | ✅ |
| 3 | Platform | `/platform` | system | no | **Platform** reserved node, pinned above the project list | ✅ |
| 4 | Terminals | `/terminals` | operate | no | project › **Sessions** node (Grid mode) + a `Terminals ⋯` pop-over on the Deck | ✅ |
| 5 | Board | `/board` | project | yes | project › Board (also a tree node) | ✅ |
| 6 | Memory | `/memory` | project | yes | project › Memory (tree node) | ✅ |
| 7 | Inbox (Requests) | `/inbox` | operate | no | Workspace › Inbox | ✅ |
| 8 | Gates | `/gates` | operate | no | Workspace › Gates | ✅ |
| 9 | Repository | `/repository` | project | yes | project › Repository (tree node) | ✅ |
| 10 | Runs | `/runs` | project | yes | project › Runs (tree node) | ✅ |
| 11 | Archive | `/archive` | project | yes | project › Archive (tree node) | ✅ |
| 12 | Projects | `/projects` | config | no | **Dissolved, not dropped** — list → the tree + Workspace Deck's project grid; create → `+ Project`; per-project agents/repo binding → that project's Settings; reference/registered repos → Workspace Settings | ✅ |
| 13 | Actors | `/actors` | config | no | Workspace › Actors (Profiles \| Skills switch) | ✅ |
| 14 | Companion | `/companion` | config | no | Workspace › Companion | ⚠️ see §J — only the destination, not its 3 modes or ~10 sections |
| 15 | Automation | `/automation` | config | no | Workspace › Automation (Time \| Events switch) | ✅ |
| 16 | Usage | `/usage` | system | no | Workspace › Usage + the `plan 5h` KPI pop-over | ✅ |
| 17 | Settings | `/settings` | system | yes | **Split by depth**: project keys → project › Settings; daemon-global keys → Workspace › Settings | ✅ (design decision, not yet pixel-verified — see §J) |

**3 parameterized routes** (declared directly in `App.tsx`, not in `NAV_PAGES`):

| Route | Today | Atlas home | Covered |
|---|---|---|---|
| `/review/:workerId` | `ReviewPanel` — branch diff + approve | worker node → **Diff** tab | ✅ |
| `/question/:id` | `QuestionAnswer` | Workspace › Inbox detail pane, and an `Answer` pop-over wherever the request surfaces | ✅ |
| `/session/:id` | `SessionView` — **today this is a thin page: just the live `TerminalTile` (terminal + Fork/Stop), or an archived-transcript fallback. It is NOT the rich tabbed "manager/worker cockpit."** | the session node itself | ⚠️ see §J — the richer tab set round 2 attributed to this route actually lives in Overview's fleet accordion, not here |

**8 redirects** (`App.tsx`, all legacy-URL compatibility): `/setup`→`/platform`, `/workspace`→`/projects`,
`/profiles`→`/actors`, `/skills`→`/actors?tab=skills`, `/schedules`→`/automation`,
`/event-triggers`→`/automation?tab=events`, `/vault`→`/repository`, `/git`→`/repository?tab=git`.
Atlas home: each becomes a node+tab deep link; the old flat path keeps redirecting — ✅ covered
(round 2's inventory names this explicitly, and the architecture doc below keeps the same promise for
the Atlas URL scheme).

## B. Sub-tab / segmented-switch sets

Source: grepped for `role="tab"`/segmented-switch patterns across `pages/*.tsx`, read in full where found.

| Page | Switch | Values | Atlas home | Covered |
|---|---|---|---|---|
| Actors | tab param (`?tab=`) | Profiles \| Skills | Workspace › Actors, same switch | ✅ |
| Automation | tab param (`?tab=`) | Time (cron) \| Events | Workspace › Automation, same switch | ✅ |
| Repository | tab param (`?tab=`) | Files \| Git | project › Repository, same switch | ✅ |
| Memory | sort selector | Recall \| Recent \| Title | project › Memory, unchanged | ✅ |
| Platform | edition + tabs | View-as: Developer \| End-user, then Home / Cadence / History / Board / Findings | **Platform** node, 5 tabs — ROUND 4 | ✅ |
| Companion | `ModeToggle` (`role="tablist"`) | **Chat \| Manage \| Terminal** — Manage alone holds ~10 sub-sections (Voice provisioning, Channels, Persona, Skills, Memory, Reminders, Restricted tools, Capability grants, Pairing, Delete) | Workspace › Companion (generic, undifferentiated) | ⚠️ **NOT IN MOCKUPS** — see §J |
| Session cockpit (Overview's `FleetCockpitRow` → `SessionCockpit`) | `TerminalCard`'s own tab prop | **Terminal \| Transcript**, plus **Timeline** (manager only) or **Diff** (worker only) — Queue / Wakes / bound-task-card are inline scrolling sub-panels **below** the tabs, not tabs themselves | round 2's IA diagram claims 5 flat tabs for a manager (Transcript/Workers/Orchestration/Queue/Wakes) and 4 for a worker (Transcript/Diff/Task/Gate) | ⚠️ **MISMATCHES THE CODE** — see §J |

That is the "7 sets of sub-tabs" round 2's inventory counted (Actors/Automation/Repository/Memory/
Platform/Companion/session-cockpit) — the count was right; two of the seven (Companion, session cockpit)
turn out to need more care than a flat tab list once you read the actual component, not just the route.

## C. Write actions — `packages/web/src/lib/api.ts`

Method (script-derived, not inline regex — see the project memory note on the `node -e` backspace-escape
trap this guards against): a real TypeScript-AST parse of `export const api = {...}` in `api.ts`
classified every member by which low-level helper its body calls (`post`/`put`/`patch`/`del`/their
`*Err` variants/`patchProject`/`updateTaskReq`/`provisionCompanionReq` ⇒ WRITE; `get`/`getOrNull`/`getErr`
⇒ READ), then a second script scanned every `.ts`/`.tsx` under `packages/web/src` for every `api.<name>`
occurrence — matching a call (`api.x(`), a bare function reference (`api.x,`/`api.x}`/`api.x;`), or
anything else — and joined the two.

- **Positive control**: the caller-scan was checked to find `api.updateTask`'s known callers (4 hits)
  before any zero elsewhere was trusted.
- **Negative control**: a fabricated member name returned exactly 0 occurrences.
- **Cross-check**: this independent, code-only extraction produced **115 write members**, and the round-4
  mockup's own independently-authored action table names the **same 115 names**, with zero missing in
  either direction (machine-diffed, not eyeballed). That is strong evidence round 4's table is accurate,
  so this checklist reuses its "Atlas home" column (credited inline as "round 4") rather than re-deciding
  115 placements from scratch — but the **"Today" column below is this task's own scan**, not round 4's
  shorthand, so it names every calling file, not just one.
- **3 unclassified reads** (`vaultRawUrl`/`vaultRawBlob`/`vaultRawHead`) build a URL/blob for a GET and
  are correctly READ, not WRITE — confirmed by reading their bodies directly.

#### Sessions & agents

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 1 | `startSession` | spawn a session from an agent (role override optional) | `pages/Overview.tsx`, `pages/platformEdition.ts`, `pages/PlatformView.tsx` | **Agents panel** on the project home · **Agents** node · tree `+` · node-head `Spawn +`; on the Platform node, its own two go-live cards — ROUND 4 | ✅ |
| 2 | `resumeSession` | resume an exited session | `components/RunHistory.tsx`, `pages/Overview.tsx` | session node header · Fleet row | ✅ |
| 3 | `forkSession` | fork a session into a new branch of work | `lib/useSessionActions.ts`, `pages/Overview.tsx` | session node header | ✅ |
| 4 | `sendInput` | send a turn into a session (composer) | `components/Composer.tsx`, `components/requests.tsx`, `pages/ReviewPanel.tsx` | session node composer · request answer modal | ✅ |
| 5 | `endSession` | end + archive a session | `lib/useSessionActions.ts` | session node header | ✅ |
| 6 | `stopSession` | stop a session (graceful or hard) | `lib/useSessionActions.ts`, `pages/Overview.tsx`, `pages/PlatformView.tsx` | Agents panel (manager + Lead-singleton guard) · Fleet row · session node · **Platform** node session tiles — ROUND 4 | ✅ |
| 7 | `clearSessionRateLimit` | clear a session's rate-limit hold | `components/fleet.tsx`, `pages/Overview.tsx` | Fleet row · session node · `pop-fleet` | ✅ |
| 8 | `restoreSession` | restore an archived session | `pages/Archive.tsx` | **Archive** node | ✅ |
| 9 | `deleteArchivedSession` | permanently delete an archived session | `pages/Archive.tsx` | **Archive** node | ✅ |
| 10 | `cancelWake` | cancel a scheduled wake | `components/SessionWakes.tsx` | session node → Wakes tab | ✅ |
| 11 | `deleteQueued` | drop a queued message | `components/SessionQueue.tsx` | session node → Queue tab | ✅ |
| 12 | `editQueued` | edit a queued message | `components/SessionQueue.tsx` | session node → Queue tab | ✅ |
| 13 | `reorderQueued` | reorder the queue | `components/SessionQueue.tsx` | session node → Queue tab | ✅ |
| 14 | `createTerminal` | open a plain shell terminal | `pages/Terminals.tsx` | **Sessions** node — `Open a shell` | ✅ |
| 15 | `killTerminal` | kill a shell terminal | `pages/Terminals.tsx` | **Sessions** node tile | ✅ |

#### Agent & rig definitions

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 16 | `deleteAgent` | delete an agent | `pages/Projects.tsx` | **Agents** node → agent editor — ROUND 4 | ✅ |
| 17 | `createAgent` | create an agent in a project | `pages/Projects.tsx` | **Agents** node `+ Agent` · band head `+ Agent` — ROUND 4 | ✅ |
| 18 | `updateAgent` | rename / re-profile / re-prompt an agent | `components/AgentPromptEditor.tsx`, `components/KeyAdmin.tsx`, `pages/Projects.tsx` | **Agents** node → agent editor; the reserved-home prompt editor on **Platform** → Home — ROUND 4 | ✅ |
| 19 | `saveSkill` | save a skill's text | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 20 | `createSkill` | create a skill | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 21 | `deleteSkill` | delete a skill | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 22 | `resetSkill` | reset a skill to shipped | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 23 | `publishSkill` | publish a skill to the repo (dev only) | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 24 | `resolveSkillFile` | resolve a skill-file merge conflict | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 25 | `adoptSkill` | adopt the shipped update of a skill | `pages/Skills.tsx` | Workspace → **Actors** → Skills | ✅ |
| 26 | `createProfile` | create a profile (rig) | `pages/Profiles.tsx` | Workspace → **Actors** → Profiles | ✅ |
| 27 | `updateProfile` | edit a profile | `pages/Profiles.tsx` | Workspace → **Actors** → Profiles | ✅ |
| 28 | `deleteProfile` | delete a profile | `pages/Profiles.tsx` | Workspace → **Actors** → Profiles | ✅ |
| 29 | `resetProfile` | reset a profile to shipped | `pages/Profiles.tsx` | Workspace → **Actors** → Profiles | ✅ |
| 30 | `adoptProfile` | adopt the shipped update of a profile | `pages/Profiles.tsx` | Workspace → **Actors** → Profiles | ✅ |
| 31 | `createPresetPrompt` | save a reusable prompt preset | `components/PresetPrompts.tsx` | composer preset pop-over | ✅ |
| 32 | `updatePresetPrompt` | edit a preset | `components/PresetPrompts.tsx` | composer preset pop-over | ✅ |
| 33 | `deletePresetPrompt` | delete a preset | `components/PresetPrompts.tsx` | composer preset pop-over | ✅ |
| 34 | `adoptPresetPromptSuggestion` | accept an auditor's preset suggestion | `components/PresetPrompts.tsx` | **Platform** node → Findings, inline `Adopt preset` — ROUND 4 | ✅ |
| 35 | `dismissPresetPromptSuggestion` | dismiss a preset suggestion | `components/PresetPrompts.tsx` | **Platform** node → Findings, inline `Dismiss` — ROUND 4 | ✅ |

#### Board

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 36 | `createTask` | create a card | `pages/Board.tsx` | board bar `+ Card` (`pop-newcard`) | ✅ |
| 37 | `updateProjectColumns` | rename / add / remove / reorder board lanes | `components/ColumnManager.tsx`, `pages/Projects.tsx` | board bar → `pop-columns` | ✅ |
| 38 | `updateTask` | move / edit / hold / defer / re-prioritise a card | `pages/Board.tsx` | board drag-drop + the **card DIALOG** (centred modal, the board never reflows) — ROUND 4 | ✅ |
| 39 | `deleteTask` | delete a card | `pages/Board.tsx` | card dialog footer, two-step inline confirm — ROUND 4 | ✅ |

#### Review & merge

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 40 | `updateProjectConfig` | set merge-gate cadence + project config | `components/mergeGate.tsx`, `pages/Settings.tsx` | **Settings** (project) · merge-gate strip | ✅ |
| 41 | `gateNextMerge` | force the gate on the next landing | `components/mergeGate.tsx` | merge-gate strip · **Gates** tab | ✅ |
| 42 | `mergeWorker` | review / approve / merge a worker branch | `components/reviewQueue.tsx`, `pages/ReviewPanel.tsx` | **Needs you** merge card · worker node → Diff tab | ✅ |

#### Requests inbox

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 43 | `answerQuestion` | answer a decision / input request | `components/requests.tsx` | **Needs you** → `Answer` · **Inbox** tab | ✅ |
| 44 | `answerPermissionQuestion` | grant or deny a permission request | `components/requests.tsx` | **Needs you** → `Answer` · **Inbox** tab | ✅ |
| 45 | `answerCredentialQuestion` | supply a requested credential | `components/requests.tsx` | **Inbox** tab (never a pop-over — secret entry) | ✅ |
| 46 | `dismissQuestion` | dismiss a request | `components/requests.tsx` | **Inbox** tab | ✅ |
| 47 | `acknowledgeQuestion` | acknowledge a notice | `components/fleet.tsx` | **Needs you** · Fleet row | ✅ |
| 48 | `markQuestionsRead` | mark the inbox read | `components/requests.tsx` | **Inbox** tab | ✅ |

#### Fleet control

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 49 | `cancelRun` | cancel an agent run | `pages/Runs.tsx` | **Runs** node | ✅ |
| 50 | `reclaimNodeModules` | reclaim worktree node_modules disk | `pages/Settings.tsx` | **Settings** (workspace) → Maintenance | ✅ |
| 51 | `triggerUpdate` | install the available loomctl update | `App.tsx` | update banner in the crumb bar (workspace-wide) | ✅ |
| 52 | `clearUsageHold` | clear the GLOBAL usage hold (the worker_spawn block) | `pages/MissionControl.tsx` | **Fleet controls** cluster — Workspace head + the shell-chrome chip's pop-over — ROUND 4 | ✅ |
| 53 | `pauseOrchestration` | pause orchestration daemon-wide | `pages/MissionControl.tsx` | **Fleet controls** cluster; the paused state shows on EVERY node via the chrome chip — ROUND 4 | ✅ |
| 54 | `resumeOrchestration` | resume orchestration | `pages/MissionControl.tsx` | **Fleet controls** cluster — ROUND 4 | ✅ |
| 55 | `killOrchestration` | hard-stop every orchestration session | `pages/MissionControl.tsx` | **Fleet controls** cluster, behind a two-step inline confirm naming the count — ROUND 4 | ✅ |
| 56 | `retryPythonProvisioning` | retry the shared Python venv install | `pages/Profiles.tsx` | **Settings** (workspace) → Capabilities | ✅ |

#### Automation

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 57 | `createSchedule` | create a cron schedule | `pages/PlatformView.tsx`, `pages/Schedules.tsx` | Workspace → **Automation** → Time; the auditor cadence on **Platform** → Cadence — ROUND 4 | ✅ |
| 58 | `updateSchedule` | edit / enable / disable a schedule | `pages/PlatformView.tsx`, `pages/Schedules.tsx` | Workspace → **Automation** → Time; **Platform** → Cadence (list + single-form variants) — ROUND 4 | ✅ |
| 59 | `deleteSchedule` | delete a schedule | `pages/PlatformView.tsx`, `pages/Schedules.tsx` | Workspace → **Automation** → Time; **Platform** → Cadence — ROUND 4 | ✅ |
| 60 | `previewSchedule` | preview a cron expression's next fires | `pages/Schedules.tsx` | Workspace → **Automation** → Time | ✅ |
| 61 | `createEventTrigger` | create an event trigger | `pages/EventTriggers.tsx` | Workspace → **Automation** → Events (`pop-newtrigger`) | ✅ |
| 62 | `updateEventTrigger` | edit / enable / disable an event trigger | `pages/EventTriggers.tsx` | Workspace → **Automation** → Events | ✅ |
| 63 | `deleteEventTrigger` | delete an event trigger | `pages/EventTriggers.tsx` | Workspace → **Automation** → Events | ✅ |
| 64 | `createPollJob` | create a polling job | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 65 | `updatePollJob` | edit a polling job | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 66 | `deletePollJob` | delete a polling job | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |

#### Repository & vault

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 67 | `saveVaultFile` | save a vault note | `pages/Vault.tsx` | **Repository** node → Vault | ✅ |
| 68 | `createVaultFile` | create a vault note | `pages/Vault.tsx` | **Repository** node → Vault | ✅ |
| 69 | `deleteVaultFile` | delete a vault note | `pages/Vault.tsx` | **Repository** node → Vault | ✅ |
| 70 | `gitCheckout` | checkout a branch | `pages/Git.tsx` | **Repository** node → Git | ✅ |
| 71 | `gitCreateBranch` | create a branch | `pages/Git.tsx` | **Repository** node → Git | ✅ |
| 72 | `gitCommit` | commit the working tree | `pages/Git.tsx` | **Repository** node → Git | ✅ |
| 73 | `gitPush` | push to the remote | `pages/Git.tsx` | **Repository** node → Git (confirm-first) | ✅ |

#### Projects

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 74 | `applyTemplate` | apply a workflow template to a project | `components/SetupWizard.tsx` | the guided-setup wizard, launched from **Platform** → Home; also **Agents** node `+ Agent` — ROUND 4 | ✅ |
| 75 | `createProject` | create a project | `components/SetupWizard.tsx`, `pages/Projects.tsx` | Workspace home → project grid `+ New project`; also the guided setup on **Platform** → Home | ✅ |
| 76 | `projectInit` | bind a repo / vault on first run | `components/SetupWizard.tsx` | the guided-setup wizard on **Platform** → Home (and first run) — ROUND 4 | ✅ |
| 77 | `updateProject` | rename / rebind repo, vault, reference repos | `pages/Projects.tsx`, `pages/Settings.tsx` | **Settings** (project) | ✅ |
| 78 | `archiveProject` | archive a project | `pages/Projects.tsx` | **Settings** (project) → Danger zone | ✅ |
| 79 | `restoreProject` | restore an archived project | `pages/Projects.tsx` | Workspace → **Settings** → Archived projects | ✅ |
| 80 | `deleteProjectPermanent` | permanently delete a project | `pages/Projects.tsx` | Workspace → **Settings** → Archived projects (confirm-first) | ✅ |
| 81 | `createProjectLink` | link two projects for peer messaging | `pages/Settings.tsx` | **Settings** (workspace) → Project links | ✅ |
| 82 | `deleteProjectLink` | remove a project link | `pages/Settings.tsx` | **Settings** (workspace) → Project links | ✅ |

#### Workspace settings

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 83 | `updatePlatformConfig` | set daemon-global config | `pages/Companion.tsx`, `pages/Settings.tsx` | Workspace → **Settings** | ✅ |
| 84 | `createKey` | mint a project API key | `components/KeyAdmin.tsx` | **Runs** node → Keys | ✅ |
| 85 | `updateKey` | edit a key's caps | `components/KeyAdmin.tsx` | **Runs** node → Keys | ✅ |
| 86 | `rotateKey` | rotate a key | `components/KeyAdmin.tsx` | **Runs** node → Keys | ✅ |
| 87 | `killKey` | revoke a key | `components/KeyAdmin.tsx` | **Runs** node → Keys | ✅ |
| 88 | `deleteKey` | delete a key | `components/KeyAdmin.tsx` | **Runs** node → Keys | ✅ |
| 89 | `createConnection` | add an outbound connection | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 90 | `deleteConnection` | remove a connection | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 91 | `validateSonarQubeConnection` | test a SonarQube connection | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 92 | `createOAuthConnection` | add an OAuth connection | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 93 | `initiateOAuthConsent` | start an OAuth consent flow | `pages/Settings.tsx` | **Settings** (workspace) → Connections | ✅ |
| 94 | `createCapability` | register a capability | `pages/Settings.tsx` | **Settings** (workspace) → Capabilities | ✅ |
| 95 | `deleteCapability` | remove a capability | `pages/Settings.tsx` | **Settings** (workspace) → Capabilities | ✅ |

#### Companion

| # | `api.*` | What it writes | Today (code-derived) | Atlas home (round 4) | Covered |
|---|---|---|---|---|---|
| 96 | `provisionCompanion` | provision the companion agent | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 97 | `createCompanionConfig` | create a companion config | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 98 | `updateCompanionConfig` | edit a companion config | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 99 | `deleteCompanionConfig` | delete a companion config | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 100 | `createCompanionBinding` | bind a chat channel | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 101 | `deleteCompanionBinding` | unbind a channel | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 102 | `addCompanionAllowedSender` | allow a sender | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 103 | `removeCompanionAllowedSender` | remove an allowed sender | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 104 | `mintCompanionPairing` | mint a one-time pairing code | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 105 | `setCompanionHome` | set the companion's home project | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 106 | `clearCompanionHome` | clear the home project | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 107 | `updateCompanionPrompt` | edit the companion's startup prompt | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 108 | `deleteCompanionSkill` | remove a self-authored skill | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 109 | `deleteCompanionMemory` | remove a companion memory | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 110 | `deleteCompanionReminder` | remove a self-set reminder | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 111 | `updateCompanionRestrictedTools` | flip the restricted-tools blast radius | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 112 | `upsertCompanionGrant` | grant a capability | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 113 | `deleteCompanionGrant` | revoke a capability grant | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 114 | `setCompanionLeadMode` | flip lead mode | `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |
| 115 | `upgradeCompanionSession` | upgrade a companion session | `lib/companionCapabilities.ts`, `pages/Companion.tsx` | Workspace → **Companion** tab | ✅ |

## D. Non-REST writes (not in `api.ts`)

Source: round 4's README names these 5; verified directly against the cited files.

| Write | Today | Atlas home | Covered |
|---|---|---|---|
| Terminal `stdin` over the session websocket | `components/Terminal.tsx` | the live terminal inside a session node | ✅ |
| Terminal `resize` / repaint frames | `components/Terminal.tsx` | same, implicit | ✅ |
| Companion chat send (text + audio) over the chat websocket | `components/CompanionChat.tsx` | Workspace › Companion › **Chat** mode | ⚠️ the Chat mode itself isn't shown — see §J |
| `dismissAttention` (per-viewer, `localStorage`) | `lib/attention.ts` | the `Dismiss` on a Needs-you item | ✅ |
| Board drag-and-drop | `pages/Board.tsx` | routes through `updateTask` (row 38 above) | ✅ |

## E. Cross-cutting chrome

Source: `App.tsx` read in full (it mounts every one of these at the shell level, outside `<Routes>`), plus
`components/Sidebar.tsx` and `components/CommandPalette.tsx`.

| Element | Today | Atlas home | Covered |
|---|---|---|---|
| Instrument rail nav (grouped, 4 sections) | `components/Sidebar.tsx` | the entity tree | ✅ (round 2: "replaced") |
| Active-project picker | rail chip | tree selection | ✅ (round 2: "removed — navigating the tree is scoping") |
| Alerts/attention badge | rail footer → Mission Control | Workspace node badge + `Needs you` KPI | ✅ |
| Command Palette (⌘K / Ctrl+K) | `components/CommandPalette.tsx`, global | kept, node-aware (jumps to nodes too) | ✅ |
| `UpdateBanner` | `App.tsx` — shown when a packaged install is behind its channel | "unchanged, above the breadcrumb bar" (round 2) | ⚠️ named generically; its own dismiss-per-version / restart-reconnect states aren't individually shown — minor, listed in §J for completeness |
| `CredentialBanner` (the loopback "writes are locked" + paste-token recovery flow) | `components/CredentialBanner.tsx` | bundled into "Update / credential / gateway-token banners: unchanged" | ⚠️ **NOT INDIVIDUALLY SHOWN** — see §J |
| `GatewayTokenBanner` | `components/GatewayTokenBanner.tsx` | same bundle | ⚠️ same as above |
| `ToastContainer` — operational-alert toasts (auto-dismiss ~6s) | `App.tsx` | "unchanged" (round 2) | ✅ |
| `RequestCountPill` — collapsed pending-request count, suppressed on `/`, `/overview`, `/inbox` | `App.tsx` | "unchanged, one collapsed pill" (round 2) | ✅ |
| Browser `Notification` permission request + per-category mute | `App.tsx` (request) + Settings → Browser notifications (mute) | bundled into "Toasts: unchanged" | ⚠️ the permission-request UX itself isn't shown — see §J |
| `FirstRunWelcome` modal (first-run only; "Start guided setup" / "Open Platform" / "Maybe later", localStorage-dismissed) | `App.tsx` | — | ⚠️ **NOT MENTIONED IN ANY ROUND** — see §J |
| Merge-gate strip | Overview section | the `gate run·queued` KPI + pop-over, and Workspace › Gates | ✅ (round 2: "demoted from a panel to a KPI") |
| Review-queue card | Overview / Mission Control | `Needs you` panel | ✅ |
| Plan-usage strip | Mission Control / Overview | `plan 5h` KPI + pop-over | ✅ |
| Setup wizard · fleet socket · request modal provider | invisible infrastructure | unchanged, no UI surface of its own | ✅ |

## F. Keyboard shortcuts

Source: grepped `packages/web/src` for `metaKey`/`ctrlKey`/`keydown`, read every hit. **None of these are
named as their own inventory item in any round** — the PAGE each shortcut lives on is accounted for
above, but the shortcut's own interactive behavior is not separately demonstrated anywhere.

| Shortcut | Where | What it does | Atlas home | Covered |
|---|---|---|---|---|
| `Cmd/Ctrl+K` | global (`CommandPalette.tsx`) | open/close the Command Palette | kept, node-aware (§E) | ✅ |
| `Escape` + click-outside | universal, via `lib/useDismissable.ts` | close any popover/dropdown/modal that uses the shared hook | implicit everywhere a popover exists | ✅ (structural, not a named feature) |
| `Cmd/Ctrl+Enter` | `components/Composer.tsx`, `components/AgentPromptEditor.tsx`, `components/PresetPrompts.tsx`, `components/SessionQueue.tsx` (edit mode) | submit/save without leaving the keyboard | session composer, agent editor, preset editor, queue editor | ⚠️ **NOT IN MOCKUPS** |
| `Cmd/Ctrl+F` (scoped) | `components/DocFind.tsx`, inside the Vault markdown viewer only | opens an in-document find bar; native find still works everywhere else | Repository › Vault pane | ⚠️ **NOT IN MOCKUPS** |
| `Cmd/Ctrl+V` (smart paste) | `components/Terminal.tsx` | swallows the raw control byte and lets xterm's native paste fire exactly once | live terminal, any session node | ⚠️ **NOT IN MOCKUPS** (implementation-level, low risk) |
| `Cmd/Ctrl+C` (smart copy/interrupt) | `components/Terminal.tsx` | copies a selection and clears it; with nothing selected, falls through as SIGINT | live terminal, any session node | ⚠️ **NOT IN MOCKUPS** (implementation-level, low risk) |

## G. URL params / deep links

Source: grepped for `useSearchParams`/`URLSearchParams`/`searchParams.get` across `packages/web/src`.

| Param | Where | What it does | Atlas home | Covered |
|---|---|---|---|---|
| `?tab=skills` | `/actors` | pre-select the Skills sub-tab | node+tab deep link (same mechanism, per the architecture doc) | ✅ |
| `?tab=events` | `/automation` | pre-select the Events sub-tab | node+tab deep link | ✅ |
| `?tab=git` | `/repository` | pre-select the Git sub-tab | node+tab deep link | ✅ |
| `?task=<id>` | `/board` | open a specific card's dialog on load | same — a board deep link should open the card dialog | ⚠️ **NOT VERIFIED AGAINST ATLAS'S OWN URL SCHEME** — see §J |
| `?profile=<id>&grant=<capability>` | `/actors` (Profiles) | pre-select a profile when arriving from a "Review & grant" link elsewhere | — | ⚠️ **NOT VERIFIED** — see §J |

(`?token=`/`?gwtoken=` on `loopbackCredential.ts`/`gatewayCredential.ts` are credential-capture params,
not navigation — out of scope here, and unaffected by the Atlas build either way.)

## H. Dev-only (LOOM_DEV) vs end-user surfaces

Source: `packages/web/src/pages/platformEdition.ts` + `Platform.tsx`, read in full.

Loom's web client has **exactly one** dev/end-user fork, and it is resolved **server-side**, not by a
client env flag: `Platform.tsx` asks `GET /api/platform/home`; a 200 (the reserved "Loom Platform" home
exists — i.e. the daemon booted with `LOOM_DEV=1` at some point) selects `developerEdition`, a 404
selects `endUserEdition`. A dev install additionally gets a client-only `ViewAsToggle` to preview the
end-user surface (`previewOnly`, never wired to any spawn/role/stop call — see `@decision 8adccd37`).

| Surface | Dev edition | End-user edition | Atlas home | Covered |
|---|---|---|---|---|
| Platform node | Lead + Auditor, multi-Lead, grid session layout, list auditor-schedule, findings `showFindings` | Platform + Workspace Auditor, singleton operator, split session layout, single-form auditor-schedule | **Platform** node, both editions built — ROUND 4 | ✅ |
| `ViewAsToggle` | shown | never shown | the dev-only preview switch on the Platform node | ✅ |
| `publishSkill` (write #23 above) | enabled | — (dev-only write; see `api.ts`'s own comment) | Workspace › Actors › Skills | ✅ (the write is in the table; its dev-only gating isn't separately called out as a visible UI difference, which is fine — the mockup doesn't need to show a feature flag it can't observe) |

## I. Row count

- Routes/navigation (A): 17 nav + 3 parameterized + 8 redirects = **28 rows**
- Sub-tab sets (B): **7 rows**
- Write actions (C): **115 rows**
- Non-REST writes (D): **5 rows**
- Cross-cutting chrome (E): **14 rows**
- Keyboard shortcuts (F): **6 rows**
- URL params (G): **5 rows**
- Dev-only vs end-user (H): **3 rows**

**Total parity rows: 183.** Flagged `⚠️` (gap, mismatch, or unverified) across all sections: **16 rows**,
machine-counted (`grep -E "^\|.*⚠️"` against this file) rather than hand-tallied: 1 route row (Companion
destination, §A), 1 parameterized-route row (`/session/:id`, §A), 2 sub-tab-set rows (Companion's mode
toggle + the session-cockpit tab-shape mismatch, §B), 1 non-REST write row (Companion chat, §D), 5
cross-cutting-chrome rows (UpdateBanner, CredentialBanner, GatewayTokenBanner, the browser-notification
permission flow, FirstRunWelcome, §E), 4 keyboard-shortcut rows (§F), 2 URL-param rows (§G). (The
Settings row, §A #17, is marked ✅ with a caveat — "design decision, not yet pixel-verified" — rather
than `⚠️`, since the placement itself is decided; only its pixel-level verification is open, which is
why P2-12 in the decomposition still exists for it.) None of the 183 rows is a silent drop — every one
has an explicit Atlas home or an explicit `NOT IN MOCKUPS`/`⚠️` flag, per the card's own requirement.

## J. The gaps, ranked

Ranked by how much real functionality is at risk of being lost if the build proceeds without closing
the gap, not by how many checklist rows cite it.

1. **Companion's Chat / Manage / Terminal mode toggle, and its read-only Terminal mode, are not shown
   anywhere.** All 20 Companion write actions (rows 96–115) and the one non-REST Companion write are
   homed to a single undifferentiated "Workspace › Companion tab" in every round. The real page
   (`pages/Companion.tsx`) is a 3-way `role="tablist"` switch: **Chat** (the default — the actual
   conversational UI, text + voice, over a websocket), **Manage** (10 sections: Voice provisioning,
   Channels, Persona, Skills, Memory, Reminders, Restricted tools, Capability grants, Pairing, Delete),
   and **Terminal** (a deliberately-carved-out read-only watch window onto the companion's own `claude`
   session — companions are otherwise hidden from the Terminals page and project grids by design, so this
   is the one sanctioned exception). None of the three modes, nor any of the 10 Manage sections
   individually, has ever been mocked up or placed on the Atlas tree.
2. **The session cockpit's real tab shape contradicts round 2's IA diagram.** Round 2 states a manager
   session has 5 tabs (Transcript/Workers/Orchestration/Queue/Wakes) and a worker has 4
   (Transcript/Diff/Task/Gate). The real code (`Overview.tsx`'s `SessionCockpit`, over the shared
   `TerminalCard`) has **2–3 actual tabs** — Terminal, Transcript, plus Timeline (manager) or Diff
   (worker) — with Queue, Wakes, and the bound-task-card rendered as inline scrolling sections *below*
   the tabs, not as tabs. Building Atlas's session node against round 2's diagram would either invent 2
   tabs that don't exist today or silently flatten sections that are deliberately inline. This needs a
   decision (promote them to real tabs, as a genuine UI change — or keep them inline) before the IA is
   final, not an assumption either way.
3. **Keyboard shortcuts are never inventoried or interactively demonstrated.** `Cmd/Ctrl+Enter` submits
   in four different editors, `Cmd/Ctrl+F` opens a scoped in-document finder inside the Vault viewer, and
   the terminal's `Cmd/Ctrl+V`/`Cmd/Ctrl+C` clipboard handling is intentionally non-default (smart
   copy-or-interrupt). The *pages* that host them are all accounted for, but nothing proves the Atlas
   rebuild will actually wire the same key handlers rather than silently dropping them — static HTML
   mockups don't exercise this by construction.
4. **Board's real filter bar is richer than what's been proven in the mockup.** Today's `Board.tsx` has
   a **multi-select** priority filter (`Set<TaskPriority>` — you can show P0 *and* P1 together) and a
   **separate multi-select column/lane filter**, plus a "N of M shown" affordance and one-click
   "clear filters." The round-4 mockup's own `atlas.js` (`wireBoardBar`) only wires free-text search and
   a **single-select** priority toggle (`state.pri`) — confirmed by reading the function directly. The
   lane filter doesn't exist in the mockup at all.
5. **`?task=<id>` and `?profile=<id>&grant=<capability>` deep links aren't verified against Atlas's own
   URL scheme.** The destinations they open (a board card, a pre-selected profile) are on the tree, but
   nothing in rounds 2–4 proves a shared link built today still opens the right dialog/panel once the
   route becomes `project/.../board?card=...` or similar — only the mockup's *own* internal `?view=`/
   `?variant=` params have been exercised.
6. **`FirstRunWelcome` — the first-run modal — isn't mentioned in any round.** It's the actual landing
   experience for a brand-new install (before any project exists): a centered dialog offering "Start
   guided setup," "Open Platform," or "Maybe later," dismissed once via `localStorage`. Low traffic
   (fires once per install) but a real state a new user hits before anything else.
7. **`CredentialBanner`'s "writes are locked" + paste-token recovery flow isn't individually shown.**
   It's bundled into a one-line "Update / credential / gateway-token banners: unchanged." The banner's
   actual job — recovering from a wrong/stale/missing loopback credential without ever printing the
   secret — is a real, occasionally-hit state (two daemons on one port, a rotated secret) that a generic
   "unchanged" label doesn't prove was preserved.
8. **The browser `Notification` permission-request flow is bundled into "Toasts: unchanged."** The actual
   one-time `Notification.requestPermission()` ask, and the Settings → Browser-notifications per-category
   mute it respects, have no mockup screen of their own.
9. **Settings' "split by depth" is a stated design decision, not yet a pixel-verified mockup.** Round 2
   proposed splitting the ~26–29 `SectionLabel` sections in `Settings.tsx` across project vs. workspace
   depth; no round has actually rendered the split section-by-section to prove every section landed on
   the side its own data scope implies (e.g. per-project `Permission Allowlist`/`Board Columns` vs.
   daemon-global `Rate Limits`/`Scheduler`/`Remote Access`).
10. **`DocFind` (the Vault's scoped in-document finder) is named once as a "building block that moves
    with its page" and never shown.** Minor on its own, but it's the same class of gap as #3 and #9 —
    "the page is accounted for" has quietly stood in for "the feature on that page is accounted for" in
    three separate places now, which is the pattern worth watching for in the build phase, not just this
    plan.

Everything else in sections A–H is a genuine ✅: independently re-derived from the code and matched
against an Atlas home that round 2–4 actually stated.
