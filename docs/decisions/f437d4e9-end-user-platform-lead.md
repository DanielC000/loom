# f437d4e9 — making the end-user "Platform" agent a full Platform Lead

DECISION RECORD. Owner directive (2026-10-15, relayed by the Platform Lead, verbatim): "End User
platform lead is more of an Assistant and is not as powerful as I want him to be. Make the End User
Platform Agent a Full platform lead like you are. Keep in mind, end User Agent prompt should Not Container
Details about my loom dogfood development or other personal projects."

This reverses decision #2 of the vault design note `Projects/Loom/Design/End-User Platform Tier Design.md`
(2026-06-23): "the full `platform` role/router/`loom-platform` + Lead doctrine mount only under
`LOOM_DEV`". Decision #1 of that note (keep the `setup` role / `/mcp-setup` router / "Getting Started"
reserved-home anchor, displayed as "Platform") is **not** reversed — see §1 below.

## Decisions

Lead decision, 2026-10-15, on the design spike below:

1. **Mechanism:** (A) — ship the `platform` role/router to end users, re-homing the Lead into the existing
   end-user "Platform" (Getting Started) home, exactly as drafted in §1, including the `!isLoomDev()`
   mutual-exclusion guarantee that keeps a dev install from ever growing a second competing Lead.
2. **Per-tool:** as drafted in §2 — 57 of 60 tools ship as-is; `daemon_restart` is **excluded** by not
   registering it on a non-dev install (absent from `tools/list`, not present-but-refusing); `skill_write`/
   `skill_edit` get `allowBundledAsset: isLoomDev()` instead of a hardcoded `true`.
3. **Doctrine:** option (i) — one generic shipped `platform-lead` skill, with every dev-only passage moved
   into a dev-Lead prompt addendum (the `PLATFORM_LEAD_PROMPT_PHASE_NOTE` pattern, `platform/seed.ts:111`).
4. **A customized Getting-Started agent is NEVER auto-upgraded.** Changing role/privilege underneath a
   prompt the user wrote for a different role is exactly the clobber the card forbids. Instead: seed a
   ONE-TIME board card on that home explaining the Platform Lead upgrade is available and how to opt in.
   Idempotent — never re-seeded once filed, even if the user dismisses/closes it.
5. **Added safety requirement for C1:** dropping the `isLoomDev()` router gate means ANY `role:"platform"`
   session reaches `/mcp-platform` on npm. C1 must PROVE the only minting path for a platform-role session
   on a non-dev install is the seeded Lead's own start path — no user-created profile can confer it, no
   `session_spawn` from any surface can mint it, no recycle can originate it (only carry it forward), and
   no template/import path can produce it. See §5 C1 for the required enumeration and test.

This file is the committed decision record for card `f437d4e9`; the Lead creates child cards C1–C7 (§5)
from it next.

## §1 Mechanism

### 1a. Every `LOOM_DEV` gate relevant to this card, classified

| Site | What it gates | Classification |
|---|---|---|
| `paths.ts:328` `isLoomDev()` | the single env read (`LOOM_DEV==="1"`) | infrastructure — unchanged |
| `index.ts:262` `seedPlatformHome(db)` call | seeds the reserved **"Loom Platform"** home + its two agents | **stays dev-only** — this is the owner's OWN dev/self-host home; must keep existing unchanged (§1c) |
| `platform/seed.ts:215` `if (!isLoomDev()) return [];` inside `seedPlatformHome` | same as above | **stays dev-only** |
| `profiles/seed.ts:250/254` `isPlatformProfile` dev-gate in `seedDefaultProfiles` | `isPlatformProfile(p) = p.role === "platform" \|\| p.role === "auditor"` (`profiles/seed.ts:236-238`) — gates BOTH the `Platform-lead` (role `platform`) and `Platform-audit` (role `auditor`) bundled profiles | **narrow, don't remove**: `role==="auditor"` (the dev Platform Auditor) stays dev-only; `role==="platform"` (the Lead) must become **ungated** so a `Platform-lead` profile seeds for every `loomctl` install — this is the Lead-layer half of the card |
| `mcp/platform.ts:1275` `resolveRole`: `isLoomDev() && role==="platform"` | whether a `role:"platform"` session can reach `/mcp-platform` at all | **this is the one router-reachability gate** (confirmed: `/mcp-platform/:sessionId` is registered unconditionally at `gateway/server.ts:966`; the gateway's shared `onRequest` auth hook is identity+liveness only — `gateway/server.ts:823-833` — all role-gating lives in each router's own `resolveRole`). Must become **ungated** (`role==="platform"` alone, mirroring `SetupMcpRouter.resolveRole`, `mcp/setup.ts:187-189`, which is a bare role check with no `isLoomDev()`). The surrounding comment's own rationale ("a leftover `role:"platform"` row... must still 404") is about a row surviving a LOOM_DEV **on→off** flip — once `platform` ships to every install, that premise is gone and the extra check is dead weight, not defense-in-depth. |
| `gateway/server.ts:4224` `/api/skills/.../publish` REST route | human-only "publish to repo" button, writes into the Loom monorepo's own git checkout | **stays dev-only, out of scope** — this is a different feature (publishing a skill edit back to Loom's own source tree) than anything on the agent-facing `loom-platform` MCP surface; genuinely meaningless without a Loom source checkout |
| `DEV_ONLY_SKILLS` (`scripts/curate-release-skills.mjs:22`) = `["platform-lead", "platform-audit", "codescape", "research"]` | which bundled skill DIRECTORIES ship in the npm tarball | `platform-lead` moves OUT (ships to all); `platform-audit`, `codescape`, `research` stay — none of those three are in scope of this card (the dev Platform Auditor, Codescape, and the research doctrine are unrelated to the Lead) |
| `pty/host.ts:2179` `isLoomDev()` inside the Codescape MCP mount gate | mounts the per-session Codescape MCP | **unrelated** — Codescape-specific, not the platform router (card `3e429d83`/`088afc94`); do not touch |

So the actual code surface to lift is small: **one `resolveRole` line, one profile-seed gating line, one
`DEV_ONLY_SKILLS` entry.** Everything else in the "today" list (the reserved "Loom Platform" home, its
seeding, its two agents) stays exactly as it is — it's the owner's own dev home, untouched.

### 1b. (A) ship `platform`/`loom-platform` vs (B) widen `setup`/`loom-setup`

**(A) wins, confirmed, not just a leaning.** Evidence:

- **Tool-surface diff, measured by counting `registerTool` calls in both files:** `PlatformMcpRouter`
  (`mcp/platform.ts`) registers **60** tools; `SetupMcpRouter` (`mcp/setup.ts`) registers **22**
  (re-count both at `pnpm --filter @loom/daemon guards`-adjacent review time — these are live counts as of
  this spike, not a number to hardcode into doctrine). Setup's 22 are a strict subset by name of
  Platform's 60 except for identical-looking duplicates (`project_create`, `project_init`,
  `project_configure`, `project_update`, `project_archive`, `agent_create`, `agent_update`,
  `template_list`, `template_apply`, `profile_create`, `profile_update`, `profile_assign`,
  `list_all_projects`, `list_all_agents`, `list_all_sessions`, `agent_get`, `profile_get`, `project_get`,
  `session_spawn`, `end_me`, `skill_list`, `skill_write`). Widening (B) to parity means re-implementing
  **38 more tools** from scratch in `setup.ts` (`agent_clone`/`agent_clone_batch`/`agent_delete`,
  `list_all_profiles`/`list_all_schedules`/`platform_config_get`/`events_search`/
  `agent_prompt_search`/`project_memory_search`, `profile_delete`, `session_stop`/`session_reap`/
  `session_transcript`, `recycle_me`/`idle_report`/`resume_doc_check`, `project_task_create`/
  `project_task_get`/`project_task_update`/`list_all_tasks`, `schedule_create`/`update`/`get`/`delete`,
  `session_message`, `question_ask`/`pull`/`cancel`/`amend`/`resolve`, `git_checkout`/`create_branch`/
  `commit`/`push`, `gate_queue`, `vault_write`, `skill_edit`) — a second, parallel copy of everything
  `mcp/platform.ts` already does, which is exactly the "maintaining two parallel routers" cost this
  card's own goal names as the thing to avoid.
- **`project_configure`'s validator difference is BAKED IN as the setup surface's identity, not an
  accident to widen away.** `mcp/setup.ts:343-346`'s own comment: "FAIL-CLOSED: the AGENT validator...
  (unlike the Lead's `project_configure`, which uses the full human-equivalent validator). **This is the
  load-bearing posture difference of the setup surface.**" Widening `setup` to the full validator fights
  the router's own documented design intent; `platform.ts`'s `project_configure`
  (`mcp/platform.ts:1598-1736`) already has exactly what the card's Goal asks for (full validator incl.
  `gateCommand`).
- **The recycle/idle/crash-recovery/promptLint machinery that must keep working is keyed on the ROLE
  STRING, never the home NAME or `isLoomDev()`:** `sessions/service.ts` lines 3436, 3500, 4529, 6665,
  6681, 6689, 6790, 10623, 11479, 14125, 14175, 14300, 15227, 15272, 15343, 16018, 16075, 16154 all branch
  on `role === "platform"` (or compare against another `role==="platform"` session) with **no** name or
  `isLoomDev()` check; `orchestration/idle-watcher.ts:397` (`isPlatform = m.role === "platform"`) and
  `orchestration/crash-recovery-watcher.ts:566` are the same. `agents/promptLint.ts:158` keys
  `PLATFORM_TOOLS` off `role==="platform"` too. **This means (A) gets the whole watchdog/recycle/resume-doc
  stack for free the moment a session is seeded with `role:"platform"`, wherever its home lives** — no
  changes needed there. (B) would need to either duplicate all of that keyed on `role==="setup"` instead,
  or leave the end-user Lead without idle-watchdog/recycle parity, directly failing the card's Goal
  ("the idle watchdog, a living resume doc + `recycle_me`/`end_me`").

**Decision 1 (approved): ship (A).**

### 1c. The dev-install question, settled concretely

- **On a `LOOM_DEV=1` install, THE Lead stays exactly where it is today: the reserved "Loom Platform" home**
  (`platform/seed.ts`'s `seedPlatformHome`, unchanged, still gated on `isLoomDev()`). Its seeded "Platform
  Lead" agent is untouched.
- **The Getting-Started-anchored "Platform" agent (today's Setup Assistant) is NOT upgraded on a dev
  install.** The upgrade migration (§4) must be gated on `!isLoomDev()` — on a dev install the
  Getting-Started "Platform" agent stays `role:"setup"` running the existing Setup Assistant doctrine,
  exactly as today.
- **Guarantee against a second competing Lead:** the two upgrade paths are mutually exclusive by that same
  `isLoomDev()` gate. A dev install never upgrades the Getting-Started agent (so it never becomes a second
  `role:"platform"` agent); a non-dev install never seeds the "Loom Platform" home at all (`platform/
  seed.ts:215` already guarantees this, unchanged). So exactly one `platform`-role agent ever exists on any
  given install, and it's always clear which home it lives in. No new structural check is needed beyond
  keeping both existing `isLoomDev()` gates as they are and adding the upgrade migration behind the same
  flag, inverted.

### 1d. `platform_escalate` routing, each install type

**Finding (not hypothetical — read at source):** `platformEscalate` (`sessions/service.ts:11306-11322`)
hardcodes its destination via `resolveLivePlatformHome(this.db)` (`platform/seed.ts:154-157`), which in
turn calls `resolvePlatformHome` (`platform/seed.ts:136-144`) — a lookup scoped to the `PLATFORM_HOME_PROJECT_ID_KEY`
marker that `seedPlatformHome` stamps (`platform/seed.ts:240`). Because `seedPlatformHome` never runs
without `isLoomDev()`, **`resolveLivePlatformHome` returns `undefined` on every non-dev install today, and
`platformEscalate` throws `"no reserved Loom Platform project exists — cannot escalate"`
(`sessions/service.ts:11322`).** The same resolver is reused at `sessions/service.ts:10578` (a Lead-notify
helper, itself already gated `if (!isLoomDev()) return { leadNotified: false };` at line 10577) and at
`sessions/service.ts:12072` (escalation-status read-back). Three more literal-string leaks ride the same
hardcoded name: `mcp/platform.ts:2761` ("cannot rename a reserved/system project (the Loom Platform
home)"), `:2830` ("cannot archive a reserved/system project (the Loom Platform home)"), `:2918` ("no
reserved Loom Platform project exists — cannot resolve resolvesEscalation"), and the **tool description
text itself** at `:2956`/`:3193` — `"resolved on YOUR OWN \"" + PLATFORM_PROJECT_NAME + "\" board"` — which
bakes the literal string `"Loom Platform"` into what the MCP `tools/list` response sends to EVERY
`platform`-role session, dev or end-user alike.

**Required fix (child card, §5):** every one of these must resolve against whichever platform-tier home is
actually live for the calling install — the dev "Loom Platform" home on a dev install, the end-user
"Platform" home otherwise — never a hardcoded name. The cleanest shape: a single `resolveLiveLeadHome(db)`
that tries `resolveLivePlatformHome` first, falls back to the (today ungated) setup/Getting-Started home
resolver when the former is absent, and is the ONE place both `platformEscalate` and every
`PLATFORM_PROJECT_NAME`-literal string above gets rewritten to call. Tool-description/error text should
stop naming a specific title at all ("your own reserved platform home board") rather than interpolating
either constant, since the two install types use different real names.

**This is also the DoD's missing fourth surface.** The card's DoD lists three surfaces for the no-dogfood
grep (agent prompt, loaded skills, injected blocks) — but the `PlatformMcpRouter`'s own **tool
descriptions and runtime error strings** are a fourth surface reaching the end-user agent's context (via
`tools/list` and tool-call results) that is NOT a skill, prompt, or injected block, and it already leaks
`"Loom Platform"` as shown above. The denylist test (§3, DoD-2) needs to scan the registered tool
descriptions too, not just the three named surfaces.

## §2 Per-tool table

All 60 `PlatformMcpRouter` tools (file:line is each tool's `registerTool(` call in `packages/daemon/src/mcp/platform.ts`), classified for an npm install:

**Ships as-is (57 of 60, Decision 2) — pure DB/project/session/board/question-inbox/git/vault/skill-list
ops**, scoped by explicit `projectId`/`sessionId`/caller-session, with no dependency on the Loom source
repo or a dev checkout: `skill_list` (4042),
`project_create` (1288), `project_init` (1344), `agent_create` (1379), `agent_update` (1396), `agent_clone`
(1477), `agent_clone_batch` (1520), `agent_delete` (1576), `project_configure` (1599), `list_all_projects`
(1737), `list_all_agents` (1757), `list_all_sessions` (1800), `list_all_profiles` (1861),
`list_all_schedules` (1876), `platform_config_get` (1906), `events_search` (1923), `agent_prompt_search`
(1960), `project_memory_search` (1987), `agent_get` (2025), `profile_get` (2043), `project_get` (2056),
`profile_create` (2072), `profile_update` (2089), `profile_assign` (2147), `profile_delete` (2183),
`session_spawn` (2217), `session_stop` (2263), `session_reap` (2280), `session_transcript` (2319),
`recycle_me` (2428), `end_me` (2459), `idle_report` (2490), `resume_doc_check` (2588), `project_update`
(2744), `project_archive` (2821), `template_list` (2846), `template_apply` (2864), `project_task_create`
(2930), `project_task_get` (3008), `project_task_update` (3086), `list_all_tasks` (3300), `schedule_create`
(3453), `schedule_update` (3476), `schedule_get` (3508), `schedule_delete` (3520), `session_message`
(3538), `question_ask` (3596), `question_pull` (3680), `question_cancel` (3742), `question_amend` (3769),
`question_resolve` (3815), `git_checkout` (3914), `git_create_branch` (3929), `git_commit` (3944),
`git_push` (3969), `gate_queue` (3988), `vault_write` (4006). (`git_*`/`vault_write` confirmed by reading
their handlers at 3913-4017: every one takes an explicit `projectId`, resolves THAT project's own bound
repo/vault via `resolveGitWriter(p, repoKey)`/`writeVaultFile(p.vaultPath, ...)` — these operate on the
*user's own* projects, never the Loom source tree, so they are portable as-is.)

**Excluded (1 of 60, Decision 2): `daemon_restart` (2540).** Its own description says it plainly: "SELF-HOSTING ONLY
(orchestrating Loom with Loom)... rebuild + restart the Loom daemon so merged daemon-`src` code goes LIVE."
`requestDaemonRestart` rebuilds from a source checkout — meaningless on an npm install (there is no `src`
to rebuild). The packaged CLI **already has** a human-only equivalent: `bin/loom.mjs`'s `restart`
subcommand (`SUBCOMMANDS` set at `bin/loom.mjs:45`, case at `:858`), itself built on the same loopback
`POST /internal/shutdown` hook (`bin/loom.mjs:355-371`) the rest of the human-only control surface uses.
Per repo convention, `/internal/shutdown`/`/internal/update` are "loopback-only, human-only, NOT agent MCP
tools." Rather than adapt `daemon_restart` into a no-op-rebuild "just restart" tool, **exclude it outright**
for the end-user Lead — a plain process restart on npm is already a human (`loom restart`) action, and
giving the agent its own restart lever would be a NEW agent-facing capability this project doesn't grant
anywhere else (dev self-hosting is the one deliberate exception today). Mechanism: gate the
`server.registerTool("daemon_restart", ...)` call itself on `isLoomDev()` inside `buildServer` (same
per-call conditional-registration shape already used for the Codescape MCP mount at `pty/host.ts:2179`),
so the tool is **absent from `tools/list`** on a non-dev install rather than present-but-refusing.

**Adapted (2 of 60, Decision 2, same registration, narrowed behavior): `skill_write` (4052), `skill_edit` (4065).**
Both are called today with `{ allowBundledAsset: true }` (`:4061`, `:4075`), which routes a write for a
bundled skill NAME to `assets/skills/<name>/SKILL.md` **inside the live Loom source checkout**
(`bundledSkillAssetsDir()`, referenced at `:4036`) via the same store→asset publish path the human Skills
UI uses — and the surrounding code (`withAssetPendingMergeWarning`, `:4027-4039`) exists specifically to
warn that this write "dirtied its canonical checkout" and could forfeit a pending git merge. None of that
has meaning on an npm install: there is no canonical checkout, and `assets/skills/` inside an installed
package is overwritten wholesale on the next `loom update` — writing "the source of truth" there is not
just useless, it is actively misleading (the write looks durable and isn't). **Fix:** pass
`allowBundledAsset: isLoomDev()` instead of a hardcoded `true`. **Correction (card 2179a923, verified
against `skillWriteData`'s actual branch, `mcp/skillTools.ts:102-110`): `allowBundledAsset: false` does
NOT fall through to the user store — it REJECTS a bundled NAME outright** ("is a bundled Loom skill —
skill_write is bounded to USER skills and cannot modify the bundled/dev skill set"), and this is exactly
what the operator's own `skill_write` already does for a bundled name (confirmed by
`setup-surface.mjs`'s own (f) section, which asserts the rejection, not a store fallthrough). So on a
non-dev install, `skill_write`/`skill_edit` behave exactly like the operator's — a bundled-NAME call is
REJECTED with that same error, never reaching `bundledSkillAssetsDir()` — not a silent write-through to
the user store as this paragraph previously (incorrectly) claimed. The end-user Lead keeps full
`skill_list`/`skill_write`/`skill_edit` capability over their own (non-bundled) USER skills; it just never
claims to rewrite a package-internal "source of truth" that doesn't durably exist for them, and a bundled
NAME must be renamed to a user skill to be editable there, same as for the operator today.

**Needs the home-resolution fix from §1d, not a tool-shape change (5 call sites inside otherwise-shipping
tools):** `project_update`'s rename refusal (`:2761`), `project_archive`'s archive refusal (`:2830`),
`project_task_create`'s `resolvesEscalation` resolution (`:2918`, `:2956`) and `project_task_update`'s twin
(`:3193`) all reference the literal `"Loom Platform"` project name in text the end-user agent reads. These
ship as-is functionally but their STRINGS need to stop hardcoding a name that is wrong for a non-dev
install (see §1d for the fix).

## §3 Doctrine

### 3a. `packages/daemon/assets/skills/platform-lead/SKILL.md` — every dogfood/personal hit, with file:line

- `:343-346` — **the clearest hit.** "**Auto-drive Loom-product development — that is the OWNER'S own
  flow.** Loom's own roadmap, bugs and dev cards are the owner's to direct. Field and triage escalations
  about them onto the board, but don't dispatch workers against Loom's own development off your own
  initiative; act on it only on an explicit owner directive." This treats "Loom" as *the specific product
  this very doctrine's own development repo builds* — a frame that only makes sense for the owner's own
  dev Lead. An end-user's Lead has no such thing as "Loom's own development" to carve out; their fleet IS
  their own project(s).
- `:186-187` — `` `merge_batch` is the exception: it lands each worker's own commit subjects verbatim,
  never the card title (card `a32533a1`)``. A specific Loom-internal board card id cited as doctrine
  precedent.
- `:127-128` — ``The link isn't create-only (card de90f22a)``. Same pattern.
- `:133` — ``Write your triage verdict with `project_task_update`'s `appendBody` param, never `body` (card
  8636f761).`` Same pattern.
- `:201-202` — ``(The c7bf65aa → `01a9983` slip: a formally retracted "cron ratchet" fix merged under its
  `fix(orchestration): …` title to salvage the regression test).`` A full narrative of a specific incident
  in Loom's own git history, with real commit/card shas, used as a worked example.
- `:228` — ``Check first whether that id already has a record — extend it, never duplicate. This applies
  in every project you touch, **not just Loom**.`` The "not just Loom" phrasing only parses if Loom is
  understood as one of several projects this Lead happens to manage — true for the owner's dev Lead
  (who manages Loom's own dev project alongside others), structurally false for an end-user Lead (whose
  "platform" has no Loom-the-product project at all).
- Every `daemon_restart`-related passage assumes the tool exists and assumes "self-hosting" framing:
  `:96-98` (naming the tool in the surface-overview paragraph), `:103` (the "write-capable tools" list),
  `:138-144` ("Own cross-project concerns"... "a self-hosting deploy"... "You hold `daemon_restart`
  directly"), `:148-150`/`:155-157` (Safety posture's deploy-confirm bullet), `:300` ("including your own
  fleet-wide `daemon_restart`"). Per §2, this tool is excluded on a non-dev install — every one of these
  needs to either disappear from the generic text or be scoped explicitly to "if your tool surface
  includes `daemon_restart` (a self-hosting/dev install)."

**Everything else read in the file (identity, capability, home & board, the tool-surface overview minus
`daemon_restart`, safety posture minus the deploy bullet's `daemon_restart` example, the operating loop,
autonomy, idle reporting, resume-doc rotation, "what you do NOT do" minus the Loom-product-development
bullet) is already generic** — "the owner"/"the user" is used throughout as a stand-in for whoever is
running this Lead, never a specific person; "Mission Control"/"the Platform UI"/`/loom-pickup` are shipped
Loom PRODUCT terms (fine — every end user's own install uses that same UI), not dogfood.

### 3b. The dev Lead's seeded startup prompt (`platform/seed.ts:61-70`, `PLATFORM_LEAD_PROMPT`)

**Already clean.** Read in full: no card/decision ids, no owner name, no repo/vault paths, no
"Loom-product-development" framing. It's a good template for the generic end-user prompt (see §4).

### 3c. Decision 3 (approved): option (i)

**`platform-lead` itself becomes the one generic shipped skill** (drop it from `DEV_ONLY_SKILLS`,
`scripts/curate-release-skills.mjs:22`), rather than forking a second skill file. Strip every item in §3a
to either (a) delete outright (the `card <id>` precedent citations and the `c7bf65aa`/`01a9983` incident
narrative — these are illustrative, not load-bearing; the surrounding rule stands fine without the
specific example), or (b) move into a short **dev-only ADDENDUM appended to the dev Lead's own seeded
`startupPrompt`**, never a second skill file. This repo already has exactly this pattern in production:
`PLATFORM_LEAD_PROMPT_PHASE_NOTE` (`platform/seed.ts:111`) is a trailing addendum concatenated onto the
base prompt for a phase-gating purpose, with a boot migration (`migratePlatformPrompts`, `platform/
seed.ts:174-199`) that strips it byte-identity-guarded. The "Auto-drive Loom-product development" rule and
the `daemon_restart`/self-hosting-deploy framing both belong in exactly this kind of addendum, since they
are true ONLY for the dev Lead's own seeded prompt, not for the shared skill text every `platform`-role
session loads.

Why (i) over "ship a separate generic Lead skill" (option ii): a second skill file means the shared
doctrine (identity, safety posture, operating loop, autonomy, idle reporting, resume-doc rotation — the
~90% of the file that's already generic per §3a) now exists in two files that must be kept in sync by
hand, the exact drift risk this repo's CLAUDE.md warns against for parallel routers and for restated
enumerable facts. One generic skill + a small dev-only prompt addendum keeps one source of truth for the
doctrine and isolates the dev-only content to the one place (the dev Lead's own seeded prompt) that is
already dev-only by construction.

### 3d. Warm first-run onboarding survives on top of full capability

Don't adopt `PLATFORM_LEAD_PROMPT` verbatim as the end-user agent's prompt — it has no onboarding warmth at
all (written for an already-oriented owner). The existing `SETUP_ASSISTANT_PROMPT` (`setup/seed.ts:100-106`)
has exactly the tone the card wants kept: "Be warm, concrete, and brief — guide, don't lecture. Ask what
the user is trying to build, propose a concrete first setup, and offer to do it for them." Recommendation:
author a new prompt constant that opens with that same warm orientation paragraph, then states the Lead's
full capability (human-equivalent, cross-project, confirm-first on irreversible/outward actions) in place
of the Setup Assistant's narrower "curated tool surface" framing. The seeded `SETUP_CHECKLIST` board cards
(`setup/seed.ts:114+`) and the "point to the Workspace Auditor rather than audit yourself" guidance both
carry over unchanged — neither depends on the agent's role being `setup`.

### 3e. Denylist for the DoD's grep test

**Structural rule (rot-proof, no list to maintain):** the end-user-facing doctrine (agent prompt + loaded
skill(s) + injected blocks + — per §1d's finding — the `PlatformMcpRouter` tool descriptions/error
strings) must contain **zero** `@decision <id>` or `card <id>`/`` `<id>` `` citations of the
`[0-9a-f]{8}` shape, full stop. Every such citation necessarily points at a `docs/decisions/`/`docs/adr/`
record that lives in the Loom repo and never ships — a citation an end-user agent can never resolve is
itself the tell, regardless of which specific id it happens to be. This also means the test doesn't rot
the way a fixed-id list would (per this repo's own standing complaint about exactly that failure mode).

**Literal-token checks** (re-derive at test-authoring time by grepping the actual shipped content, same
discipline CLAUDE.md asks of its own "point at a source of truth" rule — don't copy this list into the
test as gospel): `packages/`, `@loom/`, `pnpm --filter`, `worktrees.ts`, `Loom's own`, `Loom-product
development`, `self-hosting Loom`, `orchestrating Loom with Loom`, `Projects/Loom` (the vault path), and
the owner's real name/email (never written into shipped content in the first place).

**Cross-check against the live tool surface:** any doctrine text naming a tool (`daemon_restart` being the
concrete case today) must be checked against whether that tool is actually registered for the caller's
role/install — a generic skill that still narrates an excluded tool is itself a defect the fixed-string
denylist alone won't catch.

**Surfaces to scan**, confirmed from source, not assumed: the seeded `startupPrompt` row
(`platform/seed.ts`/`setup/seed.ts`); every loaded `SKILL.md` + its `references/**`; the daemon-injected
"Where things live" pre-block and any resume-doc/continuation-note injection; the project-memory digest
injected at kickoff; **and** the `PlatformMcpRouter`'s own registered tool `description` strings and
runtime `error` strings (per §1d — not named in the card's own DoD, added here as a gap found in review).

## §4 Upgrade path

**Reuse the existing byte-identity-guarded refresh pattern**, already proven in this exact file for exactly
this purpose: `migratePlatformPrompts` (`platform/seed.ts:174-199`) walks every agent in the home, skips
any row whose `startupPrompt` isn't byte-identical to the PRIOR shipped text ("guard 3: edited or already
clean — never clobber", `:193`), and only then overwrites it — stamping a one-shot `app_meta` marker
(`PLATFORM_PROMPT_MIGRATION_KEY`) so it runs exactly once per `LOOM_HOME`.

The end-user upgrade needs the same shape, extended to flip **role + profile binding + startupPrompt**
together, not just the prompt text, and gated the opposite way on `isLoomDev()` (§1c):

1. **Gate:** runs only when `!isLoomDev()` (dev installs keep the Getting-Started agent as `role:"setup"`
   unchanged, per §1c).
2. **Match condition (never clobber a user edit):** the Getting-Started home's "Platform" agent is still
   exactly the pristine seeded row — `role === "setup"`, bound to the (by-name) "Setup Assistant" profile,
   and `startupPrompt` byte-identical to the currently-shipped `SETUP_ASSISTANT_PROMPT` (or a historical
   prior value, same `PLATFORM_PROMPT_REFRESH`-style `{prior, clean}` map if the prompt text itself has
   already been revised once before this migration ships).
3. **On match:** flip `role` to `"platform"`, rebind `profileId` to the (now-ungated, §1a) `Platform-lead`
   profile, and overwrite `startupPrompt` with the new merged prompt from §3d. Stamp a dedicated one-shot
   `app_meta` marker (distinct from `PLATFORM_PROMPT_MIGRATION_KEY` — this is a capability change, not a
   prompt refresh) so it runs exactly once.
4. **On non-match (user has customized the agent) — Decision 4 (approved): NEVER auto-apply.** Changing
   role/privilege underneath a prompt the user wrote for a different role is exactly the clobber the card
   forbids — not merely a design trade-off, a settled rule. Instead, seed a ONE-TIME board card on that
   home (mirrors how `SETUP_CHECKLIST` already seeds guidance cards) explaining that the Platform Lead
   upgrade is available and how to opt in manually (e.g. via `agent_update`/the UI). **Idempotent: this
   card is filed at most once, ever, per `LOOM_HOME` — never re-seeded even if the user dismisses/closes
   it.** Mechanism: a dedicated one-shot `app_meta` marker, stamped the first time the migration runs and
   finds a non-match, same "stamp once, check before acting" shape as `PLATFORM_PROMPT_MIGRATION_KEY`
   above — never re-derive "has this already been offered" from the board state itself (a user closing or
   deleting the card must not cause it to resurface).
5. **Profile seeding prerequisite:** `profiles/seed.ts`'s `isPlatformProfile` dev-gate (§1a) must already
   be narrowed to `role==="auditor"`-only before this migration can bind to an ungated `Platform-lead`
   profile row — sequencing dependency, see §5.

**Fresh (non-upgrade) installs** need no migration at all: `seedSetupHome` (or wherever the Getting-Started
agent is first seeded) simply seeds the new merged prompt + `role:"platform"` + `Platform-lead` profile
directly, with the migration above existing purely for installs that seeded the OLD Setup-Assistant-only
shape before this card shipped.

## §5 Decomposition

Seven child cards, dependency order. Every one touches a role/router/trust-boundary surface — **per this
project's own standing rule, every one gets a Code Reviewer pass before merge**, not just the ones flagged
below with extra emphasis.

1. **C1 — Lift the router-reachability + profile-seed gates.** `mcp/platform.ts:1275` (`resolveRole`: drop
   `isLoomDev() &&`); `profiles/seed.ts:236-238`/`:250-254` (narrow `isPlatformProfile`'s dev-gate to
   `role==="auditor"` only). DoD: a `role:"platform"` session reaches `/mcp-platform` regardless of
   `LOOM_DEV`; a `Platform-lead`-named profile seeds ungated; existing dev install (Lead + Auditor,
   both agents, both profiles) unaffected — regression test. **Trust boundary: role-gate change — Code
   Reviewer required.**

   **Decision 5 — added safety requirement, with the enumeration already done in this spike (verify, don't
   re-derive from scratch):** dropping the `isLoomDev()` check means ANY `role:"platform"` session reaches
   `/mcp-platform` on npm, so C1 must prove — and pin with a test — that the ONLY way a session row's
   `role` column can become `"platform"` on a non-dev install is the seeded Lead's own start path. Every
   candidate minting path, checked at source:
   - **Profile-conferred role is structurally excluded.** `PROFILE_SPAWNABLE_ROLES` (`sessions/
     service.ts:1946`) = `{manager, worker, assistant}` — `"platform"` is not a member. Every reader that
     derives a spawned session's role FROM a profile filters it through `profileSpawnRole`/this set
     (`sessions/service.ts:3187-3188`), so a human setting a profile's `role` field to `"platform"` (via
     `profile_create`/`profile_update` on ANY surface, the elevated Lead included) can never cause a
     *generic* agent-spawn to produce `role:"platform"`.
   - **Every agent-facing `session_spawn` funnels through ONE shared runtime check.**
     `setup.ts:1021-1046`, `platform.ts:2216-2235`, `orchestration.ts`'s manager surface (~`:2127`), and
     the companion `session-spawn` lever (`companion/capabilities.ts`) all call the single
     `spawnSessionAsPlatform(projectId, agentId, role: "manager" | "plain")`
     (`sessions/service.ts:15964` — the parameter TYPE itself excludes every other value) guarded by the
     shared `spawnableRoleError()` helper (`mcp/spawnable-role.ts:16-20`), which statically permits only
     `"manager"`/`"plain"` and names platform/auditor/setup/operator as human-REST-only in its own
     refusal text. One chokepoint, not four independently-maintained checks.
   - **`worker_spawn` hardcodes `role:"worker"`** (confirmed by `platform/seed.ts:32`'s own comment).
   - **`template_apply` is fail-closed against elevated roles** — its own description and
     `templateAssignableProfileError` (`mcp/platform.ts:2864-2886`, `@decision 3de74275`) reject any
     template whose agent would resolve to `platform`/`auditor`/`workspace-auditor`.
   - **Recycle only CARRIES a `role:"platform"` forward, never originates it.** `recyclePlatformLead`
     (`sessions/service.ts:3829`→`:15168-15227`) throws `"not a platform session"` (`:15170`) unless the
     OLD session passed in already has `role === "platform"`; its own doc comment (anchor
     `@decision sha:b346f2c8`) states this and `startPlatformLead` are "exactly two sanctioned paths that
     mint a platform session" and warns never to widen beyond them.
   - **`startPlatformLead` (`sessions/service.ts:3829-3840`) is the one true mint path**, and its own
     surrounding comment (`:3823-3828`, `@decision 26aa4322`) states platform-spawn is human-REST-only.
     Its only call site is `gateway/server.ts:5898`, behind `POST /api/agents/:id/sessions`, passing
     `spawnHumanAuthorized: true` — never reachable from any MCP tool or agent-facing surface.
   - **`forkSession` (`sessions/service.ts:7616`) also only CARRIES a `role:"platform"` forward, never
     derives it from a profile.** The fork row's `role` field (`:7677`, mirrored onto the pty spawn at
     `:7742`) is `src.role ?? undefined` — read straight off the SOURCE session row — so forking a
     non-platform session whose agent's profile has since been rebound to a role:"platform" rig still
     resolves to the source row's own role, never `"platform"`; `forkSession` never consults the agent's
     profile at all. Unlike its `role === "setup"` (`:7638`, singleton refusal) and `role === "manager"`
     (`:7644`, barred-project refusal) guards, it carries NO `role === "platform"` check — forking an
     EXISTING `role:"platform"` session is a deliberate, sanctioned carry-forward (decision `8ddcf787`:
     multiple concurrent Leads are allowed) and succeeds, producing another `role:"platform"` row.
   C1's test should assert this enumeration directly (e.g. attempt every agent-facing spawn/recycle/
   profile/template surface against a non-dev install and confirm none can produce `role:"platform"`
   except via the seeded Lead's own carried-forward recycle), not merely re-read this list.
2. **C2 — Fix every hardcoded `"Loom Platform"` reference.** `sessions/service.ts` (`platformEscalate`,
   the Lead-notify helper at `:10577-10578`, the escalation-status read at `:12069-12072`) +
   `mcp/platform.ts` (`:2761`, `:2830`, `:2918`, `:2956`, `:3193`) — resolve against whichever platform-tier
   home is live (§1d's `resolveLiveLeadHome`), never a hardcoded constant/string. Depends on C1 (needs a
   live non-dev `platform`-role home to test against). DoD: on a non-dev install, a manager's
   `platform_escalate` lands on the end-user Lead's own home board; on a dev install, unchanged (still
   "Loom Platform"); no tool description/error string hardcodes a name that's wrong for either install
   type. **Code Reviewer required** (escalation routing is load-bearing cross-project plumbing).
3. **C3 — Per-tool adaptation.** Gate `daemon_restart`'s `registerTool` call on `isLoomDev()` (exclude from
   non-dev `tools/list`); change `skill_write`/`skill_edit`'s `allowBundledAsset: true` to
   `allowBundledAsset: isLoomDev()`. Update `agents/promptLint.ts`'s `PLATFORM_TOOLS` table and the
   surface-pin tests this repo's CLAUDE.md names (`agent-prompt-lint-surface-drift.mjs` et al.) to match.
   Depends on C1 (same router, avoid merge conflicts). DoD: non-dev `tools/list` omits `daemon_restart`;
   non-dev `skill_write`/`skill_edit` never reach `bundledSkillAssetsDir()`; dev install unaffected —
   regression test. **Code Reviewer required** (tool-surface change on an elevated role).
4. **C4 — Make `platform-lead` generic.** Strip the §3a hits; move the dev-only content into a prompt
   addendum on the dev Lead's own seeded prompt (§3c); remove `platform-lead` from `DEV_ONLY_SKILLS`
   (`scripts/curate-release-skills.mjs:22`). DoD: `platform-dev-flag.mjs`-style assertion that
   `platform-lead` now ships; dev Lead's own effective doctrine (skill + addendum, concatenated) is
   unchanged in substance from today's single file — regression check. **Code Reviewer required**
   (shipped-skill genericity is itself a stated project rule, not just this card's ask).
5. **C5 — Author the merged end-user prompt + the upgrade migration.** Per §3d (prompt) and §4 (migration);
   depends on C1 (ungated `Platform-lead` profile to bind to) and C4 (the generic skill it points at).
   DoD: fresh non-dev install seeds the upgraded Lead directly; an existing pristine non-dev install
   migrates exactly once, idempotently; a customized install is never silently clobbered and instead gets
   the one-time board card per Decision 4 (§4 step 4), idempotently (never re-seeded); dev install
   unaffected. **Code Reviewer required** (a role/privilege-changing migration on an existing install).
6. **C6 — The denylist + surface-parity tests.** Per §3e (the no-dogfood grep, covering all four surfaces
   including tool descriptions/errors) and the DoD-1 tool-list-parity test (non-dev Lead's surface == dev
   Lead's surface minus the documented C3 exclusions). Depends on C1-C5 all landing — this is the
   verification card for the whole feature. **Code Reviewer required** (this is the actual proof artifact
   the card's safety claim rests on).
7. **C7 — Docs.** Update `Projects/Loom/Design/End-User Platform Tier Design.md`'s decision #2 (superseded
   by this card, pointer to this record) and the "Setup Assistant → 'Platform' operator" paragraph in this
   repo's `CLAUDE.md` (its current text, "the ungated, lower-priv cousin of the dev Platform layer," goes
   stale the moment this ships). No code; low risk, but recommend a review pass anyway since it's
   documenting a trust-boundary reversal, not routine prose.
