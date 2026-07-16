# Changelog

All notable changes to Loom (the umbrella `loom` package) are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Loom adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor = breaking/notable, patch = fixes — see [`docs/releasing.md`](docs/releasing.md)).

## [Unreleased]

## [0.21.1] — 2026-07-16

**Bind reference repos when creating a project from the setup wizard.** The "New project from Template" wizard's Project step now carries a reference-repos editor, so read-only sibling repos can be bound at creation time — previously `referenceRepos` (shipped in 0.21.0) could only be added afterwards from Project settings.

### Added
- **Reference repos in the setup wizard.** The wizard's Project step gains an optional reference-repos list editor — a field distinct from the primary repo path — wired through BOTH creation modes. `POST /api/setup/project-init` (the "Create new project" path) now accepts and `isGitRepo`-validates `referenceRepos` with the same validator as `POST /api/projects`, run before the directory bootstrap so a bad reference leaves no stray folder. A server validation error surfaces inline on the review screen. Additive and byte-identical when no reference repo is added.

### Fixed
- Setup-wizard e2e specs updated to real fixture git-repo paths — the `isGitRepo` validation added in 0.21.0 had left the old `/tmp`-path specs failing.

## [0.21.0] — 2026-07-16

**Reference repos, a per-project memory explorer, a navigation consolidation, and the credential/connections + inbound-webhook story — plus a WebSocket token-leak security fix.** A project can now bind read-only *reference repos* its manager and workers may read but never own; the new **Lore** page makes a project's shared agent memory legible; the top nav collapses into **Actors** / **Automation** / **Repository**; answered credentials auto-provision into project-scoped Connections with a review-and-grant binding UX; and an HMAC-verified inbound-webhook receiver can wake or spawn a session.

### Added
- **Reference repos (multi-repo, "Interpretation A").** A project can bind additional **`referenceRepos`** — absolute paths to sibling git repos its manager and workers may READ but never own (no worktree, branch, gate, or commit; the primary `repoPath` is unchanged). Human-only to set via `POST`/`PATCH /api/projects` with each entry `isGitRepo`-validated, and rejected on every agent config-write surface; injected read-only into manager and worker kickoffs; a Project-settings repo-list editor; and a read-only per-reference-repo git-log in the Repository page's Git tab (index-by-construction allowlist). Additive and byte-identical until a repo is bound.
- **Lore — the per-project memory explorer.** A read-only `/lore` page (a primary Project tab) that makes a project's shared agent memory (the `project_memory` store) legible: pinned "always in context" cards, an all-entries list sortable by recall / recent / title with a per-entry recall signal, a note-detail panel with markdown + `[[wikilink]]` rendering, and search — backed by a new human-only, project-scoped `GET /api/projects/:id/memory` read.
- **Navigation consolidation.** Profiles + Skills merge into **Actors**, Schedules + Event Triggers into **Automation**, and Vault + Git into **Repository** — each a single destination with a linkable segmented sub-tab (`?tab=`), with redirects from the old routes.
- **Credential auto-provisioning into Connections (v1).** An answered `type:"credential"` request provisions a Connection at the answer boundary (role-gated to managers/leads, create-only), with **project-scoped Connections** (`project_id` nullable = global) + a resolution scope-check + a Settings scope selector, and a **Pending-bindings queue** with a human "Review & grant" binding UX (Direction B).
- **Inbound webhook receiver (remote-access Tier-2 ingress).** An HMAC-verified inbound webhook endpoint (github / stripe / standard / generic schemes, per-scheme replay defense, DB-backed dedupe, per-endpoint spawn cap) that can wake or spawn a session — human-only endpoint management; ships inert (no endpoints by default).
- **Host-tool integrations, UI-configurable.** Optional host-tool paths (Open Design, Codescape, …) are DB-persisted and human-configurable in Settings instead of daemon launch-script env vars, with a live "resolved" badge; and Open Design's integration expresses its real desktop-app MCP invocation as a full stdio spec (command + args + env).
- **`/codescape` bundled skill.** Codescape orientation ships as a bundled Loom skill (mirroring `/graphify`), with a Codescape-first orientation + structural-fix audit lens in the shipped doctrine.

### Changed
- **"Workspace" → "Project"** in the new-project / setup wizard, aligning the user-facing terminology with the rest of the app.
- **codescape host-tool config is path-only.** `codescape.mcpConfig` is now REJECTED at validation (fail-closed) rather than silently accepted-and-ignored — codescape resolves via a bin path only; Open Design keeps the full stdio spec.
- **Remote-access hardening.** Token-rotation grace, an explicit `0.0.0.0` bind posture, and an Authorization / `Sec-WebSocket-Protocol` log-redaction seam.

### Fixed
- **WebSocket gateway-token leak (security).** The gateway token no longer echoes in the `101` `Sec-WebSocket-Protocol` response header — a double-subprotocol handshake keeps the token out of the reflected response. (Inert while remote access is off, but a must-fix before enabling it.)
- **`POST /api/projects` now `isGitRepo`-validates the primary `repoPath`** — closing a two-path asymmetry (the elevated MCP create and the PATCH rebind already validated it).
- **Zombie merge-op recovery.** A daemon restart — or a manager that dies / recycles — mid-merge no longer orphans the `pendingMerge` op forever; a fresh `worker_merge_confirm` no longer dedup-attaches to a dead op, with a settle-clobber identity guard.
- **Archive-page resume.** A failed resume from the Archive no longer drops the session out of the archive.
- **Untrusted-data envelope.** The poll-format and webhook untrusted-payload envelopes share one collision-proof helper hardened against code-fence breakout.

### Internal
- Test-fidelity: extracted `resolveScopedConnectionSecret` as the single tested owner of the P4 cross-project scope-guard.
- Doctrine: agents are taught to write durable learnings to project memory (`/worker`, `/orchestrate`).

## [0.20.0] — 2026-07-15

**Shared agent memory, an open-design capability, and a self-hosting host-load guard — plus manager board-column control, Platform/Lead idle coverage, and a broad orchestration/pty reliability pass.** Agents on the same project now accumulate and share durable notes across sessions via an FTS5-backed memory store injected into each kickoff; the removed Deja integration is replaced by an opt-in open-design MCP capability; and the daemon's merge/deploy gate path gains a concurrency guard so a heavy gate run can't starve a live sibling service on a self-hosting host.

### Added
- **Project-scoped shared agent memory.** A `project_memory` FTS5 store with `memory_write` (upsert) / `memory_forget` / `memory_list` / `memory_read` tools. Pinned-always plus top-K retrieval-relevant notes are injected into each session's kickoff under a token budget, with LRU-by-retrieval eviction — so agents working the same project build and share durable knowledge across sessions.
- **Open Design (`openDesign`) capability.** An opt-in, per-session stdio [open-design](https://github.com/nexu-io/open-design) MCP server for design/mockup rigs, gated on OD being installed on the host (`LOOM_OPEN_DESIGN_BIN`). Default-off, human-only grant, and public (not dev-gated) — the forward design capability that replaces the removed Deja integration.
- **Manager-driven board columns.** `board_column_create` / `board_column_rename` / `board_column_delete` let a manager restructure its own project board (an owner-gated capability-surface expansion), with a configurable **`mergeLanding`** column role so a merged card can land somewhere other than the terminal column (default terminal, byte-identical), and an **`excludeFromIdleWatchdog`** column flag so a parking lane needn't mark every card `deferred`.
- **Platform/Lead idle-watchdog coverage.** The idle watcher now covers `role=platform`, so a parked Platform/Lead session gets the same idle nudges and `idle_report('waiting'/'done')` affordance as a manager.
- **`skill_edit` (platform).** A patch/anchor skill edit, instead of requiring full-file reproduction for a one-line change.
- **Patch-style `tasks_update`.** A column/priority-only card move no longer requires re-sending the full card body.
- **Non-consuming `requests_list` for scheduled/autonomous agents** — list your own open requests without consuming them, so a scheduled agent doesn't re-file duplicates each cycle.
- **Un-pushed-commits signal (vault).** A visible "N commits un-pushed" indicator for a vault with a remote, plus a documented commit-only auto-commit contract.

### Changed
- **Host-load guard on the daemon gate path (self-hosting).** A new daemon-global `orchestration.maxConcurrentGates` (default 1) serializes daemon-executed merge-confirm and scoped-deploy gate runs so concurrent gates can't pile up unbounded host load; and the daemon test runner (`test-daemon.mjs`) now defaults to **2** parallel lanes when `LOOM_TEST_CONCURRENCY` is unset (dial-up still available via the env), so a bare gate run can't spike to full core count and starve a live sibling service.
- **`schedulerEnabled` is resolved daemon-global** — wired to the platform-global config so the owner's toggle actually enables scheduling (a stale per-project value is ignored).

### Fixed
- **Codescape MCP scope.** A per-session stdio `codescape mcp --graph <graph.json>` replaces the broken shared multiplexed serve, fixing a projectId scope mismatch (a 400/404 handshake failure that surfaced zero tools) so agents get the read tools.
- **Worker plan-mode trap (pty).** A Loom-driven worker put in plan mode could hang — it can't self-approve the permission prompt a `worker_report` triggers; plan mode is now rejected for Loom-driven roles and `worker_set_mode` lands reliably.
- **Auto-heal fresh/resume asymmetry (pty).** The permission-mode auto-heal drives a session to its own configured target instead of a hardcoded `auto`.
- **Spurious session auto-resume.** A cleanly-parked platform/manager session is no longer auto-resumed (holding its non-terminal cards) on every unrelated daemon restart; and a crash-recovered manager no longer gets an unconditional full re-orientation nudge (no-op wake classification added to the crash-boot / recovery paths).
- **Credential request provisioning.** A `type:"credential"` request's answer is now read by a consumer, so the promised env var is actually provisioned.
- **`worker_merge` pathGlob** no longer silently returns an empty diff when a bare `*` should cross a `/` boundary.
- **Idle/wake nudge accuracy.** `[loom:worker-idle]` no longer says a worker is "awaiting your reply" when it's parked on its own background gate; a finished taskless consultation worker no longer shows stale `busy:true`; and wake Paths B/C get Lead-appropriate nudge copy.

### Removed
- **Deja integration removed.** The opt-in Deja mockup-corpus capability (`dejaCorpus`) and the Deja capture PostToolUse hook (`dejaCapture`) are gone from Loom's built-in surface — dedicated modules, config/DB fields, MCP wiring, and web UI all removed. [open-design](https://github.com/nexu-io/open-design) is the forward design capability that replaces it (see `openDesign` in `CLAUDE.md`). The Deja product itself is unaffected; only Loom's built-in integration is removed.

### Internal
- `pnpm build` (sync-claude-skills) no longer mutates tracked skill files with pure LF→CRLF churn.
- Shipped-skill / doctrine refresh (orchestrate, ideate, the platform-lead idle affordance, companion session-lifecycle).

## [0.19.0] — 2026-07-12

**Security hardening and reliability.** The opt-in browserTesting browser surface is locked down so an untrusted-chat Companion can't reach host-code-execution or host-file-read tools; the Companion's in-app delivery path gets several route-fallback fixes; and managers gain peer discovery, a board-wide Requests view, and delivery-channel introspection — plus orchestration observability, config-write resilience under load, and a flaky-test hardening pass.

### Added
- **`peer_list` (manager orchestration).** A non-mutating tool to discover your owner-linked peer projects (`{projectId, name}`) before messaging them — the read-only complement to `peer_message`, scoped server-side to your own project.
- **Board-wide manager `requests_list`.** A non-consuming, own-project-scoped view of a manager's Requests inbox (`{state?, type?, includeConsumed?}`) — see decisions/credentials/permissions/input across all your cards without consuming them.
- **Companion delivery introspection.** The Companion can answer "what did you send / on which channel / was it spoken" from real state — `my_context` now surfaces its bound channel(s), effective voice-reply mode, and last delivery (with the clip transcript when spoken).
- **`LOOM_SCRATCH_DIR`** exposed to browser-testing agents for staged uploads/screenshots.
- **Orchestration transport observability.** The `loom-orchestration` MCP router logs a warning on a failed/aborted request (the abort path previously had no server-side signal).

### Changed
- A `[loom:from-manager]` **peer inbound is stamped with the sender's `projectId`**, so the recipient manager can reply via `peer_message` without a human relay.

### Fixed
- **browserTesting host-escape hardening (security).** The opt-in Playwright surface allowlists the whole MCP server, which includes host-reaching tools. **`browser_run_code_unsafe`** (RCE-equivalent — it runs arbitrary code in the Playwright server process) is now disallowed for **every** role whenever the browser mounts; and the host-file-reading **`browser_file_upload`/`browser_drop`** (they read absolute host paths into a page — a secret-exfil primitive) are disallowed for the **untrusted Companion (`assistant`) role only**, so worker rigs keep them for legitimate upload/drag-drop testing.
- **Companion in-app delivery.** A route-less **reminder** for an in-app-only Companion no longer no-ops (the in-app home fallback now covers the reminder fire path); a proactive **decision-relay** `chat_reply` no longer fails no-target for an in-app Companion with a null home route; and heartbeat dedup no longer collides two home-less in-app companions onto the same key (suppressing one's heartbeat).
- **`writeJsonAtomic` under load.** The transient-EPERM rename-retry budget is now env-configurable (`LOOM_TRANSIENT_FS_RETRY_LIMIT`, mirroring `LOOM_TRUST_LOCK_MS`) so it can't exhaust and crash a config writer under extreme concurrent Windows FS contention; the default is unchanged.
- **Gateway config save.** `PATCH /api/platform/config` shallow-merges only the keys in the body, so one Settings save can no longer clobber a sibling toggle it didn't touch.
- **Idle-watchdog accuracy.** The idle-watcher no longer counts review-lane cards or cards gated on a pending owner Request as "actionable," ending misleading idle nudges.
- **agent write-tool id-prefixes.** `agent_update` (and its sibling agent write tools) resolve an 8-char id-prefix like `agent_get` does — fixing a read/write asymmetry that yielded a silent "agent not found."
- **Resumed-session paste.** A pasted-text attachment that can't be re-rendered into a resumed session after a restart now surfaces an explicit placeholder/raw text instead of a dangling "[Pasted text #N]" the agent can't read.

### Internal
- Flaky-test hardening (user-audit-surface, worker-spawn-taskless, dev-server-teardown, trust-lock) against timing flakes under the concurrent gate pool. Shipped-skill doctrine refinements: a bundled-skill-currency release check + wrong-tool-name lens for platform-audit, a token-inefficiency audit category for workspace-audit, `ideate` folded into the doctrine batch, and the `@playwright/mcp` download-capture recipe taught in browser-testing guidance.

## [0.18.0] — 2026-07-12

**The Companion becomes a full remote operator — plus remote access, guided onboarding, and a broad reliability pass.** Behind owner-granted, default-off levers, the in-app Companion can now be elevated toward Platform-Lead reach — read any session's transcript, read/author/relocate cards across projects, list and spawn sessions — under a redesigned session-scoped **trust window** (a confirm "warms" a short window instead of confirming every action) with per-capability risk tiers and grant-time risk advisories. Loom gains a **remote-access story** (per-route trust tiers, gateway token auth, TLS/wss bind, rate-limiting), a **guided onboarding wizard** with team-preset workflow templates, **OAuth2** connections, **event triggers**, and a generalized **Requests inbox** (decisions · credentials · permissions · input). Plus a large orchestration/merge-gate/worktree hardening pass — including a data-loss fix where a worker-merge cleanup could destroy an unpushed nested clone.

### Added
- **Companion → Platform-Lead capability elevation (default-OFF, owner-granted per capability × project).** A session-scoped **trust window** replaces per-action confirms as the default friction: a step-up confirm warms a short window (Tier A) within which same-scope acts flow without re-confirming; the highest-risk levers (Tier X) always step up; reads (Tier R) never touch the window. New levers: **transcript read** (a session's transcript, DM-only, per-project), **board_get** (cross-project card-body read), **stopped-session listing** (session-status state filter), **authored cross-project card text** (create/update a card with composed — not verbatim — text, Tier A), **board_relocate** (re-home a misfiled card to another project + its connected decision-inbox requests, Tier X), and **session-spawn** (spawn a manager|plain session — never a platform/auditor/worker one — Tier X). A cross-project **grants-by-project overview** in the companion panel; session-spawn surfaced there with an honest "confirms each use" label; and a **grant-time risk advisory** when co-granting the transcript-read + session-steer injection-launder pair, or multiple shared-window Tier-A levers (a warning, never a block).
- **Remote access (access-story P5b).** A per-route **trust-tier enforcement** seam + `remoteAccess` config; gateway **token** mint/rotate/revoke with Bearer + WebSocket-subprotocol auth; **TLS (wss)** bind-host + a rate-limiter + CSRF-Host reconciliation; and a "Remote access" docs page (Tailscale-Serve/SSH primary + direct-bind how-to). Ships inert until configured.
- **Guided onboarding.** A workflow-template model with canonical **team presets**; `template_list`/`template_apply` (setup MCP + human REST); a guided-onboarding **wizard** whose "Create new" initializes a real project dir; operator doctrine to offer + apply a template.
- **Requests inbox — generalized.** The manager→human decision inbox becomes a durable **typed Requests** object — **decision · credential · permission · input** — with a unified inbox, per-type attention labeling, a connected-requests view on a card (`tasks_get` + a non-consuming task-scoped read pair), a Request-detail modal everywhere, and an audit requests-read tool.
- **Event triggers.** An `event_triggers` table + Db CRUD + shared type, an EventTriggerService dispatcher (boot-wired) + human-only REST, and an Event Triggers management UI (PollService honors the global-pause kill switch).
- **Connections & capabilities.** OAuth2 authorization-code + PKCE + token-refresh in the credential store (loopback redirect, no ingress) + a turnkey Google Analytics connector preset; an **image-generation** catalog capability for the Web-Designer rig (BYO-key); the GitHub capability migrated to a Loom-managed `github-mcp-server` binary.
- **Orchestration.** A sanctioned manager↔manager **peer channel** (`peer_message`) over an owner-gated project link; a **scoped per-project deploy** capability for managers; a Platform-Lead resume-doc **Read-cap warning** + freshest-sibling handoff pointer on boot; and a visible marker when a `worker_spawn` is rejected by the concurrency cap (the intent no longer drops silently). A scoped, opt-in **elevated operator** surface for end-user installs (Bucket 2b).
- **Web.** The companion chat rebuilt as a real chat (not an endless message wall); a proper schedule-builder UI (frequency/time/day → cron); transcript view surfaces tool-result images + call/result pairing; in-app proactive frames (heartbeat/reminder/alert) render as the amber event line; a redesigned task-details modal with connected requests; the companion capability-grant panel.

### Changed
- Board task-card detail opens as a **modal everywhere** (not a side drawer), wider/taller on large windows.
- `applyWorkflowTemplate` is **atomic** — all agents pre-validated before any insert.
- Broad shipped-skill doctrine refresh (Requests inbox, deploy path, decision routing, Windows worktree hygiene); the `blocked_human` "Needs Human" alert retired (the Requests inbox supersedes it).

### Fixed
- **Worker-merge data loss (P0).** `worker_merge_confirm`'s worktree force-remove — and the boot-reconcile / wedge-sweep GC paths that share the same removal chokepoint — no longer delete a **gitignored nested git clone** holding unpushed work; a nested repo (or an inconclusive scan) retains the worktree and warns instead of destroying it.
- **Board reconciliation.** A reconnect/boot reconcile no longer replays merge-move events over a **manual** column move (which reset merged cards to the terminal column and then blocked re-dispatch).
- **Companion.** A revoked/downgraded grant now takes effect on the live companion (its trust window closes on any grant write); a Tier-X fail-safe guard is backfilled on `decision_resolve`; grant mode is validated against the capability's supported modes; a proactive decision-relay `chat_reply` is pre-warmed; proactive-frame tagging fixed.
- **pty.** A dropped bracketed-paste END marker no longer strands a worker report mid-paste; the resume-summary gate no longer force-compacts a manager on restart; a submit verify-retry give-up no longer strands composer text into the next turn.
- **Orchestration.** Decisions are scoped to the project/agent so a fresh (non-recycle) successor manager sees the prior manager's decisions; the idle-watcher no longer false-positives on a worker parked on a pending `wake_me`; a `peer_message` to a linked-but-archived peer no longer dead-letters.
- **browserTesting.** The per-session Playwright MCP no longer writes ARIA snapshot `.yml` files into the user's Obsidian vault (defaults to the session scratch dir).
- **Web.** Numerous board/transcript/e2e fixes — narrow-lane card wrapping, transcript tool-results mislabeled as "User", modal sizing, typed-Request labeling, and several red-on-main e2e specs.

### Internal
- Release CI pins **npm 11.18.0** (npm 12's provenance path broke publish — sigstore `MODULE_NOT_FOUND`). The daemon test runner is parallelized + reuses builds to cut merge-gate wall-clock; stale companion-respawn comments corrected (buildServer is stateless per MCP request → a grant revoke is live, no respawn); Codescape pre-dogfood hardening; and a broad sweep of doctrine + shipped-skill refinements.

## [0.17.0] — 2026-07-10

**The Companion becomes an operator, plus a broad orchestration-reliability pass.** Behind owner-granted, default-off permission levers, the in-app Companion can now *read* your fleet (session status, decisions, board, vault) and *act* on your behalf from chat — resolve a decision, file or move a board card, message/steer/stop/resume a session, or send you a screenshot/file — each gated by owner-only grants and injection-guard primitives. Managers gain a batch of orchestration tooling (intra-turn worker liveness, transcript pagination, a merge-confirm completion signal, taskless spike workers, escalation status), and the merge gate, crash recovery, and worktree lifecycle get a large hardening pass.

### Added
- **Companion permission levers — an owner-granted capability framework.** A per-companion, per-project grant model (a grants table + a single `resolveCompanionGrant` chokepoint + a capability registry + a **HUMAN-only** grants REST surface, never an agent tool) lets the owner selectively enable what a Companion may do. **Read levers:** live session status, a decisions relay (`decisions_list`), cross-project board reach (`board_list`), scoped vault lookup (secret-excluded), and a proactive attention-push that relays fleet alerts to chat. **Act levers** (owner-confirmed, injection-guarded via new A/B/C primitives): resolve a decision-inbox question, scoped board writes (create/move/priority/held), session control (message/steer/stop/resume), and media-out (send a screenshot/mockup/file to chat, incl. in-app rendering). All **default-OFF and inert until granted**; a running Companion picks up a newly-granted lever via a conversation-preserving respawn.
- **Companion `/refresh`** — live, non-destructive persona/memory reinject for a running Companion, decoupled from `/new`'s history reset.
- **Decision inbox: free-text answers** — answer a manager's decision with a note, without picking one of the offered options.
- **Manager orchestration tooling** — intra-turn worker liveness on `worker_list` (a busy worker in one long turn no longer looks wedged); `worker_transcript` pagination (no more whole-transcript dumps); a `worker_merge_confirm` completion signal (no more spin-polling a pending merge); taskless spike / no-commit workers (a research worker no longer has to hijack a real card); `escalation_status` (a manager sees whether the Platform Lead picked up an escalation it filed); and a shipped-card lifecycle link so a squash-merged card is closed, not re-dispatched.
- **GitHub MCP capability** — the first credential-tied catalog capability, an end-to-end proof of the connection-bind path (profile-gated, host-allowlisted, token-injected).
- **Overview attention list** is capped + collapsible so it can't grow unbounded; the **Profiles role picker** reads as a legible capability-"class" selector.
- **Platform (dev) tooling** — the Platform Lead gains a session-transcript read tool and its own decision inbox; the workspace auditor gains confined, read-only own-project source-read tools.

### Changed
- **Deja mockup capture is now gated behind `LOOM_DEV`** — public `loomctl` users never see or hit it.
- **Shipped skills refreshed** — the `setup-assistant` and `workspace-audit` skills generalized with operator/Lead and code-gap-hunt doctrine; broad `orchestrate`/`worker`/`platform-audit` doctrine refinements (report discipline, capability-vs-role UI verification, decision routing, Windows worktree hygiene).

### Fixed
- **Merge gate** — a rejection now carries a diagnostic payload (failing phase/test/stderr) instead of an opaque "build gate failed"; a build OOM/kill under concurrent worker load is classified and retried once instead of masquerading as a genuine failure; merge lifecycle signals carry an opId/worker correlation stamp so a manager can match a `[loom:merge-*]` to the confirm it issued; a rejected async confirm no longer double-notifies.
- **Crash & restart recovery** — a planned/supervised restart no longer resumes sessions with a false "the daemon crashed" note; boot-reconcile surfaces an orphaned live fleet (a user-interrupt that archived a manager while its workers stayed live) instead of stranding it; stale/duplicated idle- and decision-nudges are silenced (a blocked-and-parked worker, an already-answered question, a multi-answer batch).
- **Companion** — a guardrail stops it silently misfiling an owner's "put this on project X" card onto its own board; `chat_reply` is pre-warmed on the silent startup turn so the first reply isn't gated on a tool round-trip; the injected-message submit-strand (paste-without-submit) is fixed.
- **Platform** — `list_all_agents` / `list_all_schedules` / `list_all_sessions` resolve an 8-char projectId prefix (or error) instead of silently returning `[]`.
- **Orchestration robustness** — a manager no longer gets locked out of its own live fleet; a Playwright eyeball no longer leaves worktree dev servers holding the worktree open (a Windows merge-cleanup failure); recycle/wake/serve-static param + script mismatches that cost failed round-trips are reconciled; a fresh (non-recycle) orchestrator boot gets an accurate absolute-paths "Where things live" block; the per-session Playwright MCP can write to a vault root.

### Internal
- LOOM_DEV-gated Codescape fleet-daemon integration (serve supervision + loopback control client + per-agent MCP injection + worktree/merge lifecycle hooks); de-flaked timing assertions (user-audit ReDoS wall-clock, merge-confirm-nudge, merge-gate completion); and the `build_gate_retry` events surfaced in the audit-replay stream.

## [0.16.0] — 2026-07-08

**Voice, integrations, and a decision inbox** — the Companion gains voice (talk to it, it talks back), grows to a multi-companion cross-channel agent, and Loom gains the plumbing to *act* on the outside world: an encrypted credential store, an authenticated-request tool, scheduled triggers, and a data-described capability registry. Managers get a first-class way to ask *you* a durable, answerable question. Plus session self-stop, Deja mockup capture, a redesigned marketing site, and a large reliability pass on crash-recovery, worktree isolation, and the merge gate.

### Added
- **Companion voice.** Inbound speech-to-text (local faster-whisper) transcribes Telegram voice notes;
  outbound text-to-speech (local Kokoro) synthesizes voice replies; the companion decides text-vs-voice per reply; a web-chat mic captures browser audio; per-route `/lang` + `/voice` preferences via a slash-command router. Voice provisioning (faster-whisper ~500MB + kokoro-onnx ~197MB) is an explicit, **off-by-default** daemon-global opt-in (`companionVoiceEnabled`) — off, voice degrades cleanly to text.
- **Multi-companion + unified cross-channel chat.** Run more than one companion (each a distinct cloned
  agent); Telegram and web-chat share one conversation (Telegram messages, incl. voice, live-push into the open web chat with no reload); conversation-grouped history with a browser + transcript view, where `/new` archives (never deletes) the thread; a full slash-command surface (`/status`, `/start`, `/help`, `/new`, `/export`, `/whoami`, `/voice`, `/lang`); companion lifecycle — create, clone, delete/retire, editable given-name.
- **Agent tooling & integrations (EPIC).** An owner-controlled **encrypted credential store** (human-only
  REST + Settings UI); an **authenticated-request MCP tool** (profile-gated, host-allowlisted, credential-injected); **poller triggers** (scheduled local poll jobs that wake/spawn a session with the event as kickoff); a **capability registry** — owner-curated, data-described per-profile capabilities generalizing the hard-coded per-session MCPs — plus an arbitrary-command capability kind and a Capabilities catalog panel.
- **Manager→human decision inbox.** A manager can file a durable, answerable decision (`question_ask`,
  non-blocking) with options + a recommendation; you answer it in the UI (a cyan "DECISION NEEDED" attention item → `/question/:id` page → a global "waiting on me" inbox with a per-project facet); the answer pushes back into the asking session, which pulls it (`question_pull`). Survives daemon restart and manager recycle; an answered-but-unpulled decision re-nudges the manager.
- **Session self-stop.** An `end_me` primitive (terminal exit, no successor, gated on an empty inbound
  queue); auditors self-stop after completing a scan; an "End Session" button on non-worker terminal cards runs `/session-end` then stops.
- **Deja capture.** An opt-in PostToolUse relay auto-ingests agent mockups with their originating prompt;
  a per-profile `dejaCorpus` capability and a `dejaCapture` project toggle (parity with browserTesting/documentConversion).
- **Per-schedule prompt**, **composer presets** (a Spark popover, insert-to-edit), **batch/templated agent
  creation** across sibling projects, resolved **capability flags surfaced** on `agent_get`/`agent_list`, a **queued-messages "Ledger Bar"** across terminal cards, and a bundled **noCommit "Docs & Vault / Analysis" rig**.
- **Redesigned GitHub Pages landing site** with richer, accurate demo screenshots and a synced feature story.

### Changed
- **Workspace, Projects, and Overview reworks** — a redesigned project/agent management page, "New project"
  hoisted with roomier agent fields, and the header project dropdown sorted by active session (active pinned on top).
- **Board management moved into Settings** (column add/rename/delete off the board itself) plus a kanban
  responsiveness + polish pass.

### Fixed
- **Crash recovery** — boot-reconcile now recovers crash-orphaned in-flight workers (re-parents resumable
  workers to their live manager) instead of stranding them; a second crash no longer marks one project's sessions "dead" while another's auto-resume; non-JS/native daemon-death now leaves a persisted diagnostic signature.
- **Worker isolation & provisioning** — worker worktrees no longer nest inside the live `LOOM_HOME` git tree
  (a stray relative git op could corrupt cross-agent state); worktree dep-provisioning is more complete (sibling-dist build, base `node_modules` refreshed after a dep-adding merge).
- **Orchestration robustness** — merge-gate hardening (validates the post-merge union in the worktree, fixes
  a false "build gate failed" on a re-poll, worktree-scoped pre-gate cleanup, client-timeout-resilient spawn/merge), rate-limited sessions resume at the real usage-window reset (not a flat backoff), manager redirects reach in-flight workers mid-turn, watchdog false alarms (queued-report "didn't report", parked-orchestrator "stuck-busy") silenced, and `my_context` no longer returns a misleading 200k default before the first measured turn.
- **Companion** — a TTS-synth `EPIPE` no longer crashes the daemon (P0); heartbeat/reminder watchers are
  scoped per-session/per-home (no multi-companion cross-delivery); a live home-change reconciles the cache; `/new` re-injects the persona after clearing.
- **pty** — `withTrustLock` no longer drops the lock on a transient `EPERM` (a `~/.claude.json` clobber risk);
  the Deja-capture relay no longer silently no-ops on Windows (`execFile` of a node CLI threw `EFTYPE`).
- **Cost reporting** — run-cost price data added for current Anthropic models (claude-sonnet-5 et al.) — no more $0 runs.

### Internal
- A broad end-to-end (Playwright) test harness, legacy/upgraded-DB boot regression tests (with a guard
  against SCHEMA indexes referencing migration-added columns), fault-injection coverage for the trust-lock retry path, and a sweep of orchestration/worker/web-design doctrine + shipped-skill refinements.

## [0.15.0] — 2026-07-04

**Orchestration control, message clarity, and worktree robustness** — managers gain direct control over a worker's permission mode and the full agent/profile delete lifecycle; queued agent and human messages are delivered one-per-turn instead of concatenated into a wall of text; a unified terminal chrome across the cockpit; faster startup; and a hardened, Windows-safe worktree/session cleanup path.

### Added
- **`worker_set_mode`** — a manager can drive one of its workers' permission mode
  (`acceptEdits`/`auto`/`plan`) from the daemon side, for recovery or a mid-run override (a worker can't change its own mode). Rejects `bypassPermissions`; scoped to the manager's own workers.
- **`agent_delete` + `profile_delete`** — agents and profiles can now be permanently deleted from the
  management surfaces, so workspace cleanups complete end-to-end: cross-project for the Platform operator, own-project for a project manager (with a guard that refuses to delete a rig another project still depends on). Mirrors the human REST delete exactly.
- **Manager-settable `deferred` task state** — mark a card as intentionally sequenced behind other work; it
  is excluded from the idle-nag count but never blocks dispatch, distinct from the owner's `held` brake.
- **`/graphify`** — an opt-in code-graph orientation skill (a local tree-sitter code graph) for getting your
  bearings in an unfamiliar codebase.
- **Message Delivery setting (`coalesceAgentMessages`)** — restores the legacy full-coalesce of queued agent
  messages; off by default (see the delivery change below).

### Changed
- **Agent & human messages are delivered one-per-turn.** When a session is busy, queued messages authored by
  an agent or human (manager→worker direction, worker→manager reports, companion messages, your composer turns) now each land as their own turn instead of being concatenated into one; only Loom's own operational nudges (idle/context watchdogs, restart notes) still coalesce. Reversible via the new Message Delivery setting.
- **Unified terminal chrome** — the session, shell, companion, and platform terminal tiles now share one
  terminal-card frame with maximize, quick-command presets, and inline task panels; card height follows its content, removing the dead space below the composer.
- **Overview page reworked** — Fleet moves below the Board, Attention is promoted into its place, and
  pending-merge cards render as the same rich review cards Mission Control uses.
- **Faster startup** — the daemon no longer blocks boot on worktree cleanup; it binds its port promptly and
  reconciles + cleans up in the background.
- Inactive projects are labeled "inactive" (not "archived") on Mission Control; reserved system homes are
  hidden from the picker.

### Fixed
- **Reliable worker permission mode under load** — a dropped mode keystroke during a busy spawn could strand
  a worker in plan mode (unrecoverable); the spawn and the auto-heal now feedback-verify the landed mode.
- **Robust, Windows-safe worktree cleanup** — escaped build/dev-server processes (an `esbuild` service, a
  `vite` dev server) that held a worktree open (the root cause of worktrees that could not be removed) are now reaped before removal, and the removal runs in a killable child process so a wedged directory handle can never stall the daemon. A dir that still can't be removed is retried slowly and surfaced, never silently accumulated.
- **Crash-recovery coordination** — a false "won't come back" nudge no longer collides with auto-resume, and
  the companion/assistant recovers correctly after a restart.
- **Leaked dev servers** (`pnpm dev`) are torn down on session end/recycle — they had been exhausting the
  local port range.
- The **companion's given name** is now an editable field in Manage.
- **Terminal-card sizing** — no more resize oscillation on the Platform page, and the gap between the
  terminal and the composer is closed.
- **Cross-session message routing** — a message to a recycled session reaches its live successor, and a
  recycled successor can read its predecessor's worker transcripts.

### Internal
- A broad end-to-end (Playwright) test harness with page-level specs across the app, glob-based daemon test
  discovery, and a sweep of orchestration/worker doctrine + skill refinements.

## [0.14.0] — 2026-07-03

**The Companion** — a chat-native personal agent on the same durable, real-`claude` PTY runtime as your project fleet. Talk to it in the cockpit (in-app, the default) or over Telegram; it holds the thread across restarts, remembers what matters to you, sets its own reminders, writes its own skills, and can proactively check in — behind a fail-closed security model. Plus a broad cockpit-UX pass and a platform-quality batch.

### Added
- **The Companion — a chat-native personal agent.** A long-lived assistant you converse with directly,
  reachable from an **in-app cockpit chat** (the default, loopback-authenticated) and optionally over **Telegram**. One **Companion** page hosts it all: chat, plus a **Manage** tab for configuration, channels, memory, reminders, its editable persona, and a live-terminal view of the companion's own PTY.
- **Companion durable memory.** The companion curates its own memory store — facts about you and your
  ongoing relationship — and silently recalls it at the start of each conversation. View/prune it in Manage.
- **Companion reminders.** One-shot ("remind me in 20 minutes") and recurring (cron) reminders that fire
  back to the chat you set them from. View/prune in Manage.
- **Companion self-authored skills** — the companion writes and refines its own private, on-demand skills.
- **Companion proactive heartbeat** — an optional periodic check-in that speaks only when there's something
  genuinely worth surfacing.
- **Fail-closed companion security** — bot token encrypted at rest (AES-256-GCM), sender allowlists, one-time
  DM pairing codes (single-use / TTL / rate-limited), a restricted-tools profile, and human-only configuration so the chat-reachable agent can never reconfigure itself.
- **The companion learns its own given name**, and its base brief was strengthened (identity, an
  anti-fabrication rule, a declarative-not-imperative memory rule, and a hardened untrusted-input posture).

### Changed
- **The companion is managed as a companion, not a profile row** — its config, channels, memory, reminders,
  and persona live on the single Companion page (decoupled from Profiles), shown only when a companion is active.
- **Cockpit UX pass** — the Orchestration page folds into an expandable fleet-card drill-down; archived
  sessions render inside fleet cards; Usage session cost reframed as consumption wording (the $ estimate kept); clearer Overview stats; a disambiguated "run" vocabulary.
- **`held` is now the single human brake** — the `blocked` column is retired; a held card is the owner's
  don't-work / don't-nag flag in any column.

### Fixed
- A **platform + quality batch**: task-tool id resolution accepts unambiguous 8-char id prefixes (projects
  and tasks, on both the worker and platform surfaces); Board search matches by card id; the Platform Lead resume doc is lineage-scoped so concurrent Leads can't clobber it; a loopback `serve-static` helper replaces hand-rolled servers for eyeballing static HTML; the companion no longer burns a "standing by" turn on a fresh boot; and `worker_redirect` no longer fires a spurious idle nudge.
- **Sonnet-5 context window** sized to its real 1M window (was mis-sized).
- Companion unbind fully tears down per-channel bindings, allowed senders, and unconsumed pairing codes.

## [0.13.0] — 2026-07-01

**Session usage telemetry** — your real billed spend, over time, collected token-free — plus a **Vault document reader** upgrade (collapsible sections + in-doc find) and usage-sampler correctness/performance hardening.

### Added
- **Session usage telemetry — your real billed usage, over time, collected token-free.** The Usage page gains
  an **Interactive sessions** plane: a daemon-sampled time-series of every session's cumulative billed tokens
  + cost, charted by day and broken down by project and by agent, with page-local **Project** and **Window**
  scope controls. It reads the transcripts the engine already writes — **no agent tokens are spent** measuring usage — and stays deliberately distinct from live context-occupancy and the Agent Runs plane (the page never sums across the three). A one-time boot backfill seeds history from transcripts still on disk, so the page isn't empty on day one. The By-agent breakdown disambiguates same-named agents across projects.
- **Vault document reader — collapsible header sections.** Every markdown header in the Vault doc viewer gets a
  chevron to collapse/expand its section (down to the next same-or-higher header), so a long design note folds to a scannable outline. Keyboard-accessible.
- **Vault document reader — in-document find (Ctrl+F).** With focus in the doc view, Ctrl+F opens a scoped find
  bar — match highlighting, next/prev, a match count, and Esc to close — that leaves the browser's native find untouched everywhere else. A match inside a collapsed section auto-expands it.

### Changed
- **Runs moved into the More menu.** The top-level Runs nav item now lives under **More › Operate**, tidying the
  primary header.
- **Cleaner end-user skills.** The shipped skill set drops Loom's own self-hosting / dev-only content (kept in
  the repo for Loom's own development) and omits the install-specific research skill from the npm package, so an installed Loom's skills describe only what a user's workspace does.
- **The usage sampler reads transcripts incrementally, off the event loop.** At fleet scale the sampler no longer
  re-reads every live session's full transcript synchronously each tick — it parses only newly-appended bytes asynchronously (serialized against session-exit sampling), keeping the daemon responsive as fleets and transcripts grow. Accounting is unchanged and exact.

### Fixed
- **Usage samples no longer double-count across a daemon restart.** A resumed session's already-recorded usage is
  no longer re-counted on the first sampler tick after a restart — the first-sight baseline is now DB-aware, so totals stay exact across restarts. A one-shot corrective reset scrubs any historical inflation from before the fix.
- **The unpriced-model cost warning no longer spams.** A model with no recorded price logs its warning once, not
  once per session per sampler tick.

## [0.12.0] — 2026-06-29

A **session & run audit log** with a replayable, diffable timeline; the **review/merge gate** becomes the diff-triage centerpiece; **sessions auto-archive** into a project-scoped Archive with Run Replay; a **roomier composer**; and a broad **security + reliability hardening** pass (a CSRF/DNS-rebind backstop, capability-leak closures, and orchestration race fixes).

### Added
- **Session & run audit log — replay and diff any run.** Loom now records a durable, replayable timeline of
  what each session/run did, and Mission Control gains a **fleet-observability + audit-replay** view: scrub a run's events and transcript, and compare one run against another (or its predecessor). **Run Replay** can now focus a single agent — the previously-inert wave/session toggle works — and lists past runs, not just the live one.
- **The review/merge gate is the diff-triage centerpiece.** Reviewing a worker's branch is now a fast,
  per-file collapsible diff (risk-sorted, high/medium files open by default) with one-step **Approve & merge** / **Request changes** wired to the existing fail-closed build gate.
- **Sessions auto-archive on exit (and clear on resume).** Exited sessions move to a **project-scoped Archive
  page** with a manager→worker fold-out tree, instead of a manual archive action; pre-existing exited sessions are backfilled so your past runs appear. The redundant Workspace "Sessions" card and manual-archive UI are removed.
- **A roomier composer.** The message box is now **fixed-height** (it can no longer be dragged to eat the
  terminal pane) with an **expand-to-large-editor** overlay that round-trips your draft losslessly — voice dictation available in both the inline box and the overlay.
- **A diagnosable crash log.** A top-level fatal-exit handler writes a crash log (rotated at boot), so a
  daemon that dies leaves a diagnosable record even when run without the supervisor.

### Changed
- **Repositioned around the real-terminal, subscription-not-API value.** The README, landing site, npm
  description, and in-app copy now lead with what Loom actually is: orchestrate a fleet of **real Claude Code terminals on your Claude subscription**, local-first — not per-token API bills.
- **Platform page history sections are collapsible** (collapsed by default) so the Lead/Auditor view stays
  scannable.

### Fixed
- **Run Replay and Mission Control reflect archived runs.** After auto-archive, Run Replay now includes
  archived managers (not only live ones), and the Mission Control counts are labeled **"active"** so the number reads as correct-scope rather than broken. (Owner-reported regressions from the archive change.)
- **Merge-gate diffs render correctly.** Fixed a parser collision where a content line beginning with
  `+++`/`---` was mistaken for a file header, and its **renderer twin** where a deleted `---`/`--`-prefixed line painted **gray (as unchanged) instead of red** — so a reviewer can no longer overlook a removed line. The headline diffstat is now single-sourced from the backend so the summary and the chip can't disagree.
- **The bound-task bar shows on Overview terminal tiles** — the tile now owns its task lookup, so no caller
  can drop it.
- **Broad reliability hardening** across sessions, orchestration, git, runs, and pty: forked sessions keep
  their baseline + profile permissions; a run inherits its profile's pinned model + skills; concurrent worker spawns can't overshoot the configured concurrency cap; `resume()` can't orphan a live terminal; boot reconcile is bounded; the document-converter status can't be flipped stale by an in-flight install; and several boot-migration / index-rebuild edge cases were corrected.

### Security
- **Closed an auditor transcript path-traversal.** The archived-transcript read now confines caller-supplied
  ids to the archive root (rejecting `../`, absolute paths, and symlink escapes), so a prompt-injected auditor/workspace-auditor session can't read files outside the archive store.
- **Added a CSRF / DNS-rebind backstop on the loopback API.** A single request hook rejects cross-origin
  requests and non-loopback `Host` headers (while still allowing the CLI, Run-API clients, and the local UI), so a web page you visit can't drive your local daemon.
- **Closed agent config-override capability leaks.** The agent-facing config validator no longer accepts raw
  session env (which could smuggle a host-executable interpreter or launch path), and a custom permission allowlist no longer drops the load-bearing baseline.
- **Tightened least-privilege & lifecycle guards.** The Platform operator's profile-assign can no longer bind
  an agent to an elevated rig, a reserved project refuses a repo-path rebind, autonomous `run` sessions can no longer wedge on an interactive-prompt tool, a task can't be stranded on a non-existent board column, and a worker-spawn race that could double-create on one task was closed.

## [0.11.0] — 2026-06-27

**Maximize any terminal to a full-screen overlay**, get **context-overflow warnings** for long-running agents, and have **un-customized skill updates apply automatically** — plus reliability fixes across sessions, the board, skills, git, and orchestration.

### Added
- **Maximize any live terminal to a full-viewport overlay.** Click ⤢ on a session terminal — on the
  Terminals page, the project Overview, or the Platform page — to expand it to a large, dimmed-backdrop overlay you can keep working in, then press Esc or click outside to restore. The same interaction now works consistently everywhere instead of each page doing its own thing.
- **Context-overflow warnings for long-running agents.** Loom now tracks when a manager session nears its
  context limit, re-reminds on a steady cadence, and raises a clear alert if the reminders go unanswered — so a session that should hand off doesn't silently run past its window.
- **Skill updates you haven't customized apply automatically.** When Loom ships an updated built-in skill,
  any skill you've left unedited now fast-forwards to the new version on restart. Skills you've customized are never touched — they still wait for you to adopt the update yourself.

### Fixed
- **Cards can't land on a non-existent board column.** Creating or moving a task to an unknown column key
  is now rejected, so a typo can't hide a card off-board.
- **Usage / rate-limit status refreshes after you log in.** The usage poller now (re)starts on a post-boot
  login instead of staying blank until the next restart.
- **Sessions survive restarts and rate-limit pauses more reliably.** Queued messages persist across a
  recycle, a rate-limit "parked" resume prompt is no longer clobbered by the reconcile pass, and binding a project verifies a usable git commit identity up front.
- **Reliability hardening across skills, git, the scheduler, and orchestration.** Skill injection retries
  and surfaces failures (with an atomic manifest write), branch-merge cleanup problems are surfaced, scheduler spawn failures emit a durable event, and orchestration workers are reliably pointed at their own worktree for edits.

## [0.10.0] — 2026-06-26

Onboard from an **empty install** — the Platform operator can now create a brand-new project from scratch, with no existing repo — plus **automatic git history for your vault**, a tidier Platform home, and reliability fixes across sessions, skills, and the board.

### Added
- **Start from nothing.** The Platform operator can now **create a brand-new project** for you — a fresh
  directory it `git init`s under a sanctioned workspace folder, or a **notes-only vault project** with no repo at all — so a brand-new user with no code gets onboarded end to end. It also seeds a **getting-started checklist** on your Platform home.
- **Automatic version history for your vault.** Loom now **auto-commits your project's vault** as notes
  change, so documentation edits accrue real git history instead of silently overwriting. It commits at the vault's repo root (covering a one-vault-many-projects layout), isolates each project so one bad path can't stop the others, and deliberately skips Loom's own operational state.

### Changed
- **The Platform home lives on its own page, not the project picker.** The reserved "Platform" home no
  longer appears as a selectable project in the header picker; its board is now on the dedicated **Platform page** alongside the operator and Workspace Auditor — keeping the picker a clean list of your real work projects.

### Fixed
- **Adopting a skill update no longer leaves the served copy stale.** A line-ending/whitespace difference
  could make "adopt" advance the baseline while keeping the older content — so a skill read "customized" you never touched, and agents could run slightly outdated doctrine. Adopt now fast-forwards cleanly to the shipped version, and a new **"your copy differs from shipped → Sync"** control surfaces and recovers any lingering divergence.
- **Resumed, forked, and recycled sessions keep their profile's settings.** Re-spawn paths could drop a
  profile's model, permission tweaks, and role skill; they're now re-applied on every spawn path.
- **Board column edits can't strand cards.** Several setup/board config writes now route through the safe
  column updater, so changing a board's columns can't orphan tasks in a removed lane.
- **Tighter trust boundaries (security).** A manager's self-service writes are now scoped to its own
  project, an auditor hand-off path was corrected, and three bypassable spawn/config guards were closed.

## [0.9.0] — 2026-06-26

Your **Platform home** is visible and properly named, the **Platform operator** can now act on your behalf, the **Workspace Auditor** can hand its findings to an actor, and agents reliably get their instructions. Prompted by a real walkthrough of the operator/auditor experience.

### Added
- **The Platform home is visible and named "Platform."** The reserved home where the Workspace Auditor
  and Platform operator file cards is renamed from "Getting Started" to **Platform** and now appears in the project picker (pinned at the top with a ⌂), so you can finally see and act on its board. Existing installs are migrated automatically.
- **The Platform operator can act on your behalf — not just hand you text to paste.** It can now **edit an
  existing agent** (its instructions, name, or rig), read records directly, and configure board columns correctly — so "action these suggestions for me" actually happens. (It still can't elevate an agent to a privileged rig — that stays human-only.)
- **The Workspace Auditor can hand off its findings.** When it files an improvement suggestion it now
  **nudges your Platform operator** so the suggestion reaches someone who can apply it (instead of dead-ending on a board you couldn't see). It also reads the actual agent prompts/skills it critiques (no more guessing) and now covers worker sessions in its review.

### Fixed
- **Workers now receive their agent's base instructions.** A spawned worker's opening now includes its
  agent's base prompt (its role doctrine) ahead of the task — previously a manager-spawned worker got only the task and silently skipped its standing instructions. Applies to both fresh spawns and recycles.
- **Background agents can no longer block waiting on you.** Worker, operator, and auditor sessions are
  Loom-driven, so they can no longer pop an interactive question to the human and wedge waiting on input that never comes — the interactive-prompt tools are disabled for those roles at spawn.
- **The Platform operator stops inventing things when it hits the edge of its tools.** Corrected its
  guidance so it no longer fabricates a non-existent config "gate" (e.g. for document conversion), no longer misdirects you on where a setting lives, and never improvises a raw-database workaround — it tells you plainly when something is outside its scope. The Workspace Auditor's suggestions are sharper too (it distinguishes a model slip from a genuinely unclear instruction instead of just piling on rules).

## [0.8.2] — 2026-06-25

A **rebuilt Vault page** — browse your project's notes as a real folder tree and view images, graphics, and PDFs inline.

### Added
- **Vault folder tree.** The Vault browser now shows a proper **collapsible folder tree** (folders first,
  file-type icons, indentation, active-file highlight) instead of a flat list of full paths, with a **filter box** that auto-expands matching folders and a clickable **breadcrumb** of the open file's path.
- **View images, graphics, and PDFs in the Vault.** Files now open in a **type-aware viewer**: Markdown
  (now with **inline images** rendering, including Obsidian `![[image.png]]` embeds), images (PNG/JPG/GIF/ WebP/SVG/…), **PDFs** embedded inline, editable text/code, and a clean **download card** for other binaries — instead of dumping non-text files as garbled text. Backed by a new read-only, binary-safe, content-typed vault file endpoint (streamed, size-capped, path-traversal-guarded).

## [0.8.1] — 2026-06-25

Document conversion no longer fails **silently**: when the converter can't install, Loom now shows you **why** and lets you fix it — instead of the agent quietly lacking the tool.

### Fixed
- **Document-conversion (`documentConversion`) provisioning is now diagnostic and self-healing.** When Loom
  builds its shared Python venv for markitdown, it now **captures and classifies the real failure** (no base Python ≥3.10 / venv-create / pip / **timeout**) with the captured pip output — instead of one opaque "no Python, or venv/pip failed." The heavy `markitdown[all]` install timeout is **raised to ~15 minutes** (the old 3-minute bound killed legitimate first installs on slower/corporate networks and mislabeled them a failure), and a failed attempt **no longer permanently dead-ends** — it retries on the next session, on a profile re-save, or via an explicit retry, with no daemon restart needed.

### Added
- **See document-conversion status in the UI, and point Loom at your Python.** A profile with document
  conversion enabled now shows the shared converter's live state — **installing… / ready / failed (with the reason and the captured install log)** — with a **Retry install** button when it fails. Settings gains a **Python interpreter** field so you can point Loom at a specific base Python (≥3.10) when it isn't on PATH, instead of the converter silently never appearing.

## [0.8.0] — 2026-06-25

**Customize the bundled skills & profiles** with precise, update-safe tracking, opt-in **document-to-Markdown conversion**, and a batch of **manager→worker message-delivery** hardening.

### Added
- **Customize bundled skills and profiles — and adopt Loom's updates without losing your edits.** Edit a
  bundled skill or profile and Loom now tracks precisely what you changed against the shipped version: clear badges show whether an item is untouched, customized, or has an update available; a **"what changed"** diff shows your edits; and when Loom later ships a new version of a bundled item, an **update banner** offers a two-step adopt with a **field-level conflict resolver** — take the upstream change while keeping your own edits, line by line. Backed by a base-snapshot store and a 3-way merge engine (with `adopt` / `reset` / update-diff REST). New customizations work entirely off the server's notion of which items are bundled.
- **Opt-in document conversion (`documentConversion`).** A profile can enable a per-session **markitdown**
  MCP that converts PDFs, Office files, images, and HTML to Markdown — so a research/document rig can read documents cheaply in tokens. Default off and fully additive; **human-set only** (Profiles UI/REST), never an agent tool. Loom owns a shared Python venv for it and **pre-warms** it on profile-save and at boot, so the first document-conversion session usually finds the converter already ready.
- **Cross-project task-boarding for the Platform Lead.** The Platform operator can file a task directly onto
  another project's board (and link an escalation to the task it relates to).

### Changed
- **`project_configure` does a patch/merge instead of a clobber.** Changing a single config key no longer
  wipes your other per-project overrides.
- **Manager steering of workers is more authoritative.** A burst of manager→worker messages is now delivered
  as **one coalesced batch** (a single authoritative turn, not one injection per message), and a new **`worker_redirect`** lets a manager interrupt a worker's current turn, flush any now-superseded queued direction, and deliver one "do this now" instruction immediately.

### Fixed
- **A worker can no longer finish on a stale plan.** The daemon refuses a worker's completion report while it
  still has unconsumed manager direction queued, so a just-superseded plan can't be reported done.
- **`/session-end` stages only the files your session touched** in the shared vault (never a blanket
  `git add -A`), and drops an invalid merge flag — so wrapping up a session can't sweep in unrelated changes.
- **Orchestration tools resolve correctly in `/orchestrate`.** The lead doctrine now namespaces the
  `mcp__loom-orchestration__*` tools and preloads the lifecycle set, so a manager's first calls don't miss.
- **The skill "what changed" diff is line-ending tolerant** — it strips `\r` before comparing, so a CRLF
  edit no longer shows a whole file as changed.

## [0.7.0] — 2026-06-24

Board lanes you can **color, limit, and edit in place**, opt-in **Obsidian auto-start**, and a large batch of **multi-agent orchestration reliability** hardening.

### Added
- **Board column customization.** Give each lane an **accent color** and a soft **WIP limit** (with an
  unobtrusive over-limit indicator), apply a **column preset** at project creation (Agent Dev / Research / Ops / Simple) with a reset-to-preset action, and edit the board **in place** — rename, add, or remove columns directly on the board header with a live preview and role-coupling warnings. New columns are inserted before the terminal lane.
- **Opt-in Obsidian auto-start.** A new per-project setting (`obsidian.autoStart`, default **off**) that
  self-heals the vault tooling: when a skill needs the `obsidian` CLI and Obsidian isn't running, Loom launches it and waits until it's ready, then proceeds — falling back to direct filesystem access when it's disabled, headless, or not installed (never a hard error). Cross-platform, with an optional human-only launch-path override.
- **Repository-path editing.** Change a project's bound git repository from Settings (validated as a real
  repo; refused while a worktree session is live so an in-flight worker can't be rebound out from under).
- **Spawn a worker by agent name.** `worker_spawn` now accepts an agent's **name or slug** (not only its
  id), and a mistyped value returns a "did you mean …?" suggestion instead of a bare failure.
- **Editable agent prompts on the Platform page** and a `agent_update` patch surface.

### Changed
- **Manager sessions know where things live.** An orchestrator session now starts with its project's
  absolute repo and vault paths, so it reads its notes by path instead of a slow filesystem search.
- **Upward reports carry a delivery status.** A worker's report (and a platform escalation) now reports
  whether it was delivered live, queued, durably boarded, or dropped — and a **report wakes a parked manager**, so completed work is never left sitting unnoticed.
- **Bounded cross-project listings.** The platform/audit agent and session listings are capped to fit the
  context budget, so a large workspace can't overflow an operator.

### Fixed
- **`worker_spawn` validates its inputs up front** — a malformed or stale task id is rejected before any
  worktree or session is created, instead of binding a worker to a bogus task.
- **`worker_merge` won't silently pass an empty merge.** When a worker reported changes but its branch has
  nothing to merge (work was committed to the wrong place), the gate now hard-flags it for recovery instead of quietly marking the task done. The worker doctrine also now says, explicitly, never commit to `main`.
- **Usage-limit handling on spawn is self-healing.** A `worker_spawn` blocked by a usage limit now returns
  a retry-after deadline and the manager is auto-woken when the limit clears — no manual "retry" pokes.
- **Cleaner restart resumes.** After a daemon restart a session resumes as one coherent turn (the bare
  "Continue" no-op the engine emits is absorbed) and is told its file-read tracking was reset, so it re-reads before editing.
- **Vault-tooling correctness across the board** — unified board column coloring with AA-contrast-safe
  labels, Settings now preserves per-column accent/WIP on save, rate-limit holds clear cleanly across parked sessions, and several boot-migration and merge-recovery edge cases were hardened.

## [0.6.0] — 2026-06-23

A real board **column manager**, and a more robust + tunable worker-lifecycle watchdog.

### Added
- **Board column manager.** Settings → Board Columns replaces the old one-line-per-column textbox with a
  real editor: drag to reorder, rename inline, assign each lane a lifecycle role, see a live per-column card count, and add or remove columns. Removing or renaming a column **that still has cards is now safe** — its cards are atomically re-homed in one transaction (a removed lane's cards move to your default-landing column), so a card can never be orphaned onto a column that no longer exists. Columns are now identified by a stable lifecycle *role* internally, so renaming a lane no longer breaks delegation; existing boards are migrated automatically with no change to where your cards sit.
- **Adjustable worker-stuck threshold.** A new **"Worker stuck (min)"** field (Settings → Orchestration
  Caps) sets how long a worker may sit busy in a single turn before its manager is alerted. Set it to `0` to disable the stuck-worker watchdog for a project.

### Changed
- **Default worker-stuck threshold raised 20 → 30 minutes** — fewer false "stuck" alerts on a
  legitimately long single turn (a big build/test run). Override it per project in Settings.

### Fixed
- **Workers no longer wedge after committing.** A worker's shell could hang on a pager — e.g. a
  post-commit `git diff`/`git log` paging into `less` and blocking forever — which froze its turn and tripped a false "stuck" alert while its completion report sat undelivered. The worker environment now disables the git/terminal pager (`GIT_PAGER`/`PAGER`/`GIT_TERMINAL_PROMPT`) so a command can't block the turn.
- **Reviewer/operator sessions resume cleanly after a daemon restart.** When the daemon restarts, the
  Workspace Auditor, the dev Auditor, and the Platform operator are now nudged to continue (the way worker sessions already are) instead of sitting idle after their resume.
- **Captured transcripts keep tool-result bodies.** Saved session transcripts retain the bodies of tool
  results, so a later review or audit sees the full record rather than truncated tool output.
- **The Workspace Auditor's tooling is bounded and forgiving.** Its session listing is capped so a large
  workspace can't flood the auditor's context, and its transcript reads accept a session-id *prefix*, not only the full id.
- **Confirming a worker merge is idempotent.** A repeated merge-confirm (e.g. after a reconnect) is now a
  safe no-op instead of double-applying or erroring.
- **Queued messages survive a restart or the sender ending.** A message queued to a busy session is
  persisted, so it still arrives after a daemon restart or after the session that queued it exits — instead of being silently dropped.
- **A fast-exiting worker always reports back.** A worker that finishes or dies very quickly now always
  emits its terminal report to its lead, so the lead is never left waiting on a report that never comes.
- **Corrected the shipped Platform & Workspace Auditor prompts.** The seed prompts that ship to new
  installs dropped stale, Loom-internal wording (a leftover "auditor stand-down" note and dev-only framing) in favor of clean, user-facing text.

## [0.5.0] — 2026-06-23

The onboarding assistant grows into a standing **Platform** operator, and a new suggest-only **Workspace Auditor** reviews your own workspace and proposes improvements.

### Added
- **Workspace Auditor — a suggest-only review of your own workspace.** A new read-only reviewer scans
  your recent sessions for vague or ambiguous instructions in *your* own agent prompts and skills, and for prompts you type repeatedly that are worth saving as one-click presets. It files improvement suggestions as cards on your home board and proposes presets — it never changes anything itself, and it does not touch Loom's own internals. Run it on demand with **"Review my workspace"** on the Platform page, or put it on a cron schedule.
- **Archive a project from the Platform operator.** The operator can now soft-archive a project you're
  done with (reversible; it refuses your reserved home).
- **Voice dictation on board cards.** The card description field in the board drawer gains the same
  speech-to-text mic as the composer — dictate a card's description instead of typing it (the mic appears only in browsers that support speech recognition).

### Changed
- **The Setup Assistant is now your "Platform" operator.** What greeted you as the "Setup Assistant" is
  rebranded **"Platform"** — a standing, user-facing operator you return to whenever you want to create, configure, or archive your projects, agents, and profiles, not just a one-time onboarding helper. Existing installs are migrated automatically, and the Platform surface is now a single consolidated page (one tab per edition).

## [0.4.2] — 2026-06-17

### Fixed
- **Pasting into a terminal duplicated the text.** Ctrl/Cmd+V directly in a session's terminal pane
  pasted the clipboard contents twice. The terminal both pasted manually *and* let the browser's native paste run; it now lets the native paste happen exactly once (still swallowing the raw control byte and still honoring bracketed-paste mode for the agent's TUI).

## [0.4.1] — 2026-06-17

### Fixed
- **`loom` did nothing under fnm / nvm / volta (any symlinked global install).** Every command
  (`loom`, `loom start`, `loom status`, …) exited silently with no output when Loom was installed under a Node version manager that symlinks the global package directory. The CLI's entry-point check compared the launcher's path against the module's own URL; those diverge when the global dir is a symlink (Node resolves the real path while the launcher passes the symlinked one — plus Windows path-casing differences), so the CLI body never ran. The check now realpath-normalizes both sides. Update with `npm i -g loomctl@latest`.

## [0.4.0] — 2026-06-17

Onboarding gains in-chat skill editing, the install instructions become accurate, and a round of input/terminal reliability fixes lands.

### Added
- **In-chat skill editing for the Setup Assistant.** The assistant can now read and edit your skills
  directly in the conversation — new `skill_list` / `skill_write` tools on the curated `loom-setup` surface — instead of sending you to the Skills UI. Writes are bounded strictly to *your* skill store (it can never modify Loom's bundled skills) and are **confirm-first**: it shows you the skill name and full content and gets your go-ahead before writing.
- **Hosted landing page.** A GitHub Pages workflow publishes the `site/` landing page.

### Fixed
- **Accurate one-line install.** The README and `install.sh` / `install.ps1` pointed at a placeholder
  `loom.example` domain that didn't resolve. They now use the real raw-GitHub script URLs, so
  `curl … | sh` and `irm … | iex` work exactly as written.
- **Composer draft survives maximize/minimize.** Typing a message into a session's composer and then
  maximizing or minimizing that terminal no longer discards your unsent draft — it's preserved per session across the layout change.
- **No garbled turns when typing in the raw terminal.** A message delivered to a session (e.g. an
  automated status report) is no longer appended onto text you've half-typed directly in the terminal pane. Delivery now waits until you submit or clear your line — including multi-line pastes — and never alters your text.

## [0.3.0] — 2026-06-16

End-user onboarding and the full Phase-2 distribution layer: a friendly Setup Assistant that gets a new user from an empty install to a working setup, and a real management CLI + cross-OS autostart + `loom update` + one-line installers + package-manager manifests.

### Added
- **Setup Assistant — guided onboarding.** A standing, user-facing assistant (auto-launched on a fresh
  install, always reachable from the new **Set up Loom** page) that creates and configures your first projects, agents and profiles and picks default skills — acting on your behalf, confirming big or irreversible actions first. It runs on a new `setup` session role over a curated, fail-closed `loom-setup` MCP surface (project/agent/profile create+configure, manager/plain session spawn only) — no elevated or outward capability (no git/vault writers, no `gateCommand`, no cross-project messaging). Ships ungated to every user as the lower-privilege cousin of the dev-only Platform Lead. Seeds a reserved "Getting Started" home; the daemon auto-launches the assistant once on a brand-new install.
- **Management CLI.** `loom` gains subcommands: `start` (with `--detach`), `stop`, `status`, `restart`,
  `open`, alongside the bare `loom` (start + open browser). `stop`/`restart` use a graceful loopback shutdown hook so a backgrounded daemon snapshots live transcripts before exiting (cross-platform — Windows has no SIGTERM). State (PID file) lives under `LOOM_HOME`.
- **Cross-OS autostart.** `loom service install | uninstall | status` registers Loom to start on
  login/boot — a systemd `--user` unit (Linux), a launchd LaunchAgent (macOS), or a Task Scheduler logon task (Windows).
- **`loom update` + release channels.** `loom update [--channel stable|beta]` upgrades in place
  (`npm i -g loomctl@<dist-tag>`) and restarts; the channel is persisted under `LOOM_HOME`. Plus an unobtrusive in-app **"update available"** banner with an "Update & restart" button (a human-only, loopback, packaged-install-only control — never an agent surface).
- **One-line install scripts.** `install.sh` (`curl … | sh`, macOS/Linux/WSL) and `install.ps1`
  (`irm … | iex`, Windows): detect Node 22+, install `loomctl`, optionally register autostart, and launch. Plus Homebrew / Scoop / winget manifests + a submission runbook (`docs/packaging-submission.md`).
- **Prominent global-install docs.** The README now leads with `npm i -g loomctl` → `loom`.

### Fixed
- **Reserved-project home resolution.** Introducing the second reserved home (the Setup "Getting
  Started" project) is now name-scoped everywhere, so `/api/platform/home`, manager escalations, and auditor findings always resolve the correct home instead of "whichever reserved project sorts first."

### Security
- **Least-privilege profiles.** The setup surface can no longer mint `platform`/`auditor` profiles, and
  a default session spawn no longer lets a profile silently confer an elevated role — those roles come only from their explicit human spawn paths.

## [0.2.0] — 2026-06-16

The first publicly published Loom: the installable npm package goes live, joined by voice input, preset prompts, composer queue management, per-profile model selection, board search, and a round of reliability + stability hardening since `0.1.0`.

### Added
- **`loomctl` npm package + `loom` CLI.** `bin/loom.mjs` boots the single-process daemon, waits for the
  gateway, prints the local URL, and opens the browser — so `npx loomctl` / `npm i -g loomctl` runs the whole app (the installed command stays `loom`). Flags: `--port`, `--no-open`, `--version`, `--help`. Built by `pnpm pack:npm` (`scripts/build-npm-package.mjs`) into a self-contained tarball: the daemon dist (copied, not bundled), the prebuilt web at `dist/web`, the daemon `assets/`, and the private `@loom/shared` bundled via `bundledDependencies`; native deps stay real `dependencies` so a plain install fetches their prebuilt binaries. Build + local-install + publish runbook in [`docs/releasing.md`](docs/releasing.md).
- **Voice input in the cockpit.** A mic button in the composer — under every terminal (Overview grid,
  Terminals, Workspace) — uses the browser Web Speech API to dictate into the prompt box; the transcript is appended for review, never auto-sent. Includes a speech-recognition **language selector**. The mic appears only in browsers that support speech recognition.
- **Preset Prompts.** A global, editable store of reusable prompts, surfaced as a popover under each
  terminal's action buttons — one click sends a saved prompt to the session.
- **Board search + filter bar** on the task board.
- **Composer queued-message management.** Messages you queue while a session is busy are shown under
  every terminal and are now editable, reorderable, and deletable; messages queued programmatically (e.g. an agent's report to its manager) appear read-only so they can't be altered out from under it.
- **Per-profile model.** A Profile can pin a model that is applied at spawn (`--model`); leaving it
  blank uses the engine default, unchanged.

### Changed
- **Worker merges are now a single squashed commit** per task (one clean commit per branch).
- **Worktree dep-provisioning** covers npm and yarn projects, not just pnpm (picks the package manager
  by the worktree's lockfile marker).
- The optional dev-only **Platform layer is gated behind `LOOM_DEV`** and excluded from the published
  package — core orchestration (lead + workers) always ships.
- **Live-terminal grids order managers first** (the orchestrator sits leftmost, its workers to the
  right), then newest-first within each group.

### Fixed
- **Reliability:** a crash-recovery watchdog bounded-auto-resumes a session whose process died while
  the daemon stays healthy; workers no longer intermittently hang at startup on the plugin-MCP enable prompt; boot reconciliation no longer leaks orphaned worktree directories; `worker_report(done)` now refuses on uncommitted changes so completed work can't be silently dropped.
- **UI:** terminal scroll behavior; unreadable preset/button text on the default light background; a
  composer/terminal layout regression when toggling Voice; the task board now auto-refreshes on changes made by another process (no manual reload).
- **Stability:** a transient `~/.claude/projects` file-watcher error (e.g. a short-lived temp run
  directory vanishing mid-stat on Windows) no longer crashes the daemon.

## [0.1.0] — 2026-06-09

The first versioned Loom — sets the version backbone the install/update story builds on.

### Added
- **Versioning backbone.** The root `loom` package is the single source of truth for the
  user-facing version (now `0.1.0`); internal `@loom/*` packages stay private `0.0.0`.
- **`GET /api/version`** — a read-only daemon endpoint returning `{ version }`, read from the
  package version at runtime (never a hardcoded copy). The version also appears in the daemon's boot log line.
- **Version in the web UI** — a quiet `vX.Y.Z` chip in the header, fetched from `/api/version`.
- **Release process** — this `CHANGELOG.md` and [`docs/releasing.md`](docs/releasing.md) (version
  scheme, `npm version` → git tag → GitHub Release → `npm publish` + stable/beta channels).
- **Single-process viewport** — the daemon serves the prebuilt web UI from its own loopback origin,
  the prerequisite for an `npx loomctl` package.
