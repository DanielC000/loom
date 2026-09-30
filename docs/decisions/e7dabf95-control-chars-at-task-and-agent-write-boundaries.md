# e7dabf95 — control-char defense at every remaining agent-writable text store, one posture per store

Follow-up to `ea5fb00a` (`docs/decisions/ea5fb00a-reject-control-chars-at-project-memory-store-boundary.md`),
which added write-time ESC/C0/C1 rejection to project memory. That card's own review found three more
agent-writable stores whose text reaches a session prompt and relies SOLELY on `49b382d9`'s submit()-time
strip (`docs/decisions/49b382d9-strip-esc-c0-c1-at-submit-chokepoint.md`) — plus a fourth surface, the
Platform Lead resume doc, that isn't a DB store at all. This card closes all four, each with its own
justified choice of reject vs. strip, per `CLAUDE.md`'s own "point at a source of truth" rule for briefs —
this file is that source; the code comments at each site only anchor here.

## 1. Companion MEMORY.md — REJECT (`skills/companion-memory-store.ts`, `authorCompanionMemory`)

Both real writers — the companion's own `memory_write` MCP tool (`mcp/orchestration.ts`) and the e2e-only
`/internal/test/seed` route (`gateway/server.ts`) — call this ONE function, and both are discrete,
retriable calls (an agent tool call, or a hermetic test seeding a fixture), exactly the shape `ea5fb00a`
argued REJECT fits: a clear, actionable, retriable error beats a silent mutation the caller can't see.
`content` is checked (it rides verbatim into `memory-recall.ts`'s `composeMemoryRecallDigest`, folded into
every future kickoff/resume turn). `name` is NOT checked — `PerCompanionStore.resolveDir`'s
`isValidSkillName` (`store.ts`, kebab slug `^[a-z0-9][a-z0-9-]{0,63}$`) already structurally excludes
every control byte before this function is ever reached, on BOTH callers — unlike project memory's `key`,
there is no unchecked bypass path here to close.

## 2. Task title/body — STRIP (`db.ts`, `insertTask` + `updateTask`)

Unlike project memory and companion memory, task title/body has MANY writers that are NOT a single
discrete agent-initiated call, and several of them are Loom-internal, non-retryable, and return `void`:
`appendEscalationDetail` (`sessions/service.ts`, a manager's re-escalation) calls `db.updateTask` directly,
bypassing the agent-facing `updateProjectTask` chokepoint entirely; companion `board_create`, `peer_message`
boarding, platform-escalation, and project-seeding paths reach `createProjectTask`/`db.insertTask` the same
way (`docs/decisions/5b221bf2-...md` documents this same bypass shape for the duplicate-detection guard,
and `docs/decisions/d6890435-...md` is the reason it stays that way: "a lost card is a worse failure mode
than an occasional [issue] slipping through"). A REJECT at `db.ts` would either throw uncaught into one of
these void-returning callers (crashing a boarding/escalation path outright) or force a signature change —
from `void` to a discriminated result — across every one of them, most of which never check a return value
today. A silent STRIP needs neither: it matches `pty/host.ts`'s own submit()-time posture for a
must-always-proceed write, and it is the one function EVERY writer — agent-facing and Loom-internal alike
— already funnels through, so nothing can bypass it. `insertTask` strips unconditionally (title/body are
always present on create); `updateTask` strips only when the patch actually supplies `title`/`body` (an
absent field is left alone, matching the function's existing PATCH semantics — see `Task.version`'s own
"content counter, not a row counter" doc, `docs/decisions/d0978321-...md`).

### 2a. Correction (Code Review `f19a98e5`): the title guards must see the STRIPPED title, not the raw one

The first pass of this card left `checkTitleHtmlEntities`/`checkTitleConventionalType` (`tasks/title-guard.ts`)
running on the RAW `title` in `createProjectTaskChecked`/`updateProjectTask` (`mcp/tasks.ts`), with `db.ts`'s
strip happening only later, at the actual write. That ordering is exploitable: a control byte hidden INSIDE
a token a guard would otherwise reject breaks that guard's own regex match (`TITLE_HTML_ENTITY_PATTERN`/
`TYPE_PREFIXED_TITLE_RE` both require a CONTIGUOUS match), so the guard sees no violation and passes — and
`db.ts`'s later strip then silently removes the hidden byte, reassembling exactly the rejected shape.
Reproduced: `"fea\x01ture(x): y"` (guard sees no type-shaped prefix, since `\x01` breaks the match) is
accepted and stored as `"feature(x): y"`; `"fix(web): a &\x01amp; b"` is stored as `"&amp;"` (a real HTML
entity, unrejected); a title of just `"\x1b"` is stored as `""` (an empty title, having bypassed every
guard because there was nothing for either pattern to match against).

Fix: `createProjectTaskChecked`/`updateProjectTask` now strip `title` FIRST — before either guard runs, and
before the duplicate detector (`findSuspectedDuplicate`) ever sees it — and REJECT outright if nothing
printable survives the strip (an all-control-byte title). `db.ts`'s own strip is left in place, now a
genuinely redundant backstop (the title reaching it is already clean) rather than the ONLY strip. `body` is
NOT pre-stripped at this layer — it has no guard of its own to protect (only `db.ts`'s unconditional strip
applies to it), so there is no analogous ordering bug for it.

Scope: this bug is TASK-TITLE-SPECIFIC. Companion memory (§1) REJECTS before any write happens at all (no
strip-then-reassemble window exists). Agent startupPrompt (§3) has no pre-storage guard of any kind — only
`db.ts`'s strip applies, so there is nothing for a hidden byte to hide FROM. Every other title-consuming
task entry point funnels through one of these two functions already (`tasks_create`/`tasks_update`,
`project_task_create`/`project_task_update`, and the companion's own board-update capability all call
`createProjectTaskChecked`/`updateProjectTask`) — companion `board_create` and every human-REST task route
call the RAW, UNGUARDED `createProjectTask`/`db.insertTask` directly and always have (see §2 above and
`docs/decisions/5b221bf2-...md`), so they were never exposed to this guard-ordering bug in the first place.

## 3. Agent startupPrompt — STRIP (`db.ts`, `insertAgent` + `updateAgent`)

Same reasoning as task title/body, for the same structural reason: `insertAgent`/`updateAgent` are reached
not only by the three `agent_update`/`agent_create` MCP surfaces (orchestration/platform/setup routers,
mirrored by the human REST routes) but also by Loom's OWN boot-time seeding (`setup/seed.ts`,
`platform/seed.ts`, `setup/templates.ts`) and agent cloning (`agents/clone-core.ts`) — every one of which
returns `void` and must never throw mid-boot. `resolveStartupPromptEdit` (`agents/validate.ts`) — the pure
resolver shared by all three `agent_update` MCP surfaces for the append/replace/full-replace modes — is
deliberately NOT where this check lives: it resolves the patch's target string, not the final write, and
`agent_create` doesn't call it at all (there's no "current" to edit for a brand-new agent), so a check
there would still miss the create path and the boot-seed path. `db.ts` is the one place both paths and
every future one converge.

### 3a. Correction (Code Review `f19a98e5`, found while reproducing the §2a task case): REST agent-create
echoed the wrong object

`POST /api/projects/:id/agents` (`gateway/server.ts`) used to `reply.send(agent)` — the in-memory object it
built BEFORE calling `insertAgent`, never re-read from the DB. Since `insertAgent` strips ESC/C0/C1 at
write time, a control byte in the request's `startupPrompt` meant the STORED row was clean but the HTTP
response echoed it back raw — a harmless self-disclosure (the caller already had the bytes it sent), but a
genuine data-consistency gap: the response no longer described what was actually persisted. Fixed by
re-reading via `db.getAgent(agent.id)` before responding, mirroring the sibling `POST /api/agents/:id`
(update) route and the task-create route (`POST /api/projects/:id/agents`'s own OWN task-store twin) —
both already did this. No equivalent gap exists for task create (`createProjectTaskChecked`'s callers
already read `db.getTask(created.id) ?? created` before returning) or companion memory (REJECT means
nothing is ever echoed back that wasn't already rejected).

## 4. Platform Lead resume doc — sanitize at the one place Loom's own code touches the file's bytes

`composePlatformLeadStartupPrompt` (`sessions/platform-lead-prompt.ts`) never embeds the resume doc's raw
file CONTENT into a prompt — only its resolved PATH (server-derived) and size/staleness NOTES (also
server-derived, from `fs.statSync`, never the file's text). The Lead reads and writes the file exclusively
through its own native harness `Read`/`Write` tools — a path entirely outside any Loom-composed prompt
string and outside `pty/host.ts`'s `submit()` chokepoint, so there is no DB-style "write boundary" for
Loom to intercept the way there is for the three stores above.

The one place Loom's OWN code does touch this file's bytes and propagate them across a session-trust
boundary is `resolvePlatformLeadResumeDocPath`'s SEED COPY: when a second (or later) recycle lineage's
resume doc doesn't exist yet, it seeds a fresh copy from the shared base doc's content, which a later
session then reads. That copy used to be a raw `fs.copyFileSync` (byte-for-byte, including any control
byte the base doc's own author — a prior Lead, self-authoring via its own Write tool — happened to write).
It is now a read + `stripEscapeAndControlChars` + write, so a poisoned base doc's control bytes are never
propagated into a freshly-seeded lineage file. Best-effort semantics are UNCHANGED (any failure — read or
write — is still swallowed; the successor just starts its doc fresh, same as before).

This does not, and cannot, sanitize a Lead's own resume doc in place (nothing here ever rewrites a doc a
Lead already owns and is actively both reading and writing) — it only stops the seed-copy from being a
second, silent channel for a poisoned base doc's bytes into a brand-new file.

## Do not

- Do not add a control-char check to `mcp/orchestration.ts`'s companion `memory_write` handler INSTEAD of
  `authorCompanionMemory` — the `/internal/test/seed` route (`gateway/server.ts`) calls
  `authorCompanionMemory` directly too; either caller alone can be bypassed by the other.
- Do not move the task/agent STRIP itself into `mcp/tasks.ts`'s `createProjectTaskChecked`/
  `updateProjectTask` or `agents/validate.ts`'s `resolveStartupPromptEdit`/`validateAgentPatch` INSTEAD OF
  `db.ts` — every one of those is an agent-facing-only chokepoint that the Loom-internal writers named
  above bypass entirely; the authoritative strip must live in the function ALL of them funnel through.
  §2a's title pre-strip in `mcp/tasks.ts` is a NARROWER, ADDITIONAL fix (so the title GUARDS see clean
  input before `db.ts` ever runs) — it does not replace `db.ts`'s own strip, which stays the backstop.
- Do not let a title-consuming guard run on `input.title`/`patch.title` before stripping it in
  `createProjectTaskChecked`/`updateProjectTask` — see §2a; this is the exact regression Code Review
  `f19a98e5` caught in this card's own first pass.
- Do not change `insertTask`/`updateTask`/`insertAgent`/`updateAgent`'s return type to surface a rejection
  — they are `void` by design, called by many non-error-checking sites; a REJECT posture was deliberately
  ruled out for exactly this reason (see §2/§3 above).
- Do not widen the checked/stripped byte range beyond ESC/C0(excl. `\t\n\r`)/C1, and do not echo the
  offending bytes in any rejection error — see `49b382d9`'s own "Do not" section; the same reasoning
  applies to every site here.
- Do not treat `resolvePlatformLeadResumeDocPath`'s seed-copy sanitization as covering a Lead's own
  in-place edits to its resume doc — it only covers the one-time copy into a NEW lineage's file.
