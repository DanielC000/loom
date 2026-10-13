# 59fa6403 — generalizing Requests into an Inbox (design + Phase 1 build)

Owner ask (verbatim framing): generalize "Requests" into an "Inbox" — agents should also use it to
message/inform the owner, not only to ask decisions. The design below was approved as written; Phase 1
(the `notice` kind, its rate limit, and the UI label rename) is BUILT — see "Implementation notes
(Phase 1)" at the end of this record for the manager's rulings on the two open questions and what changed
during implementation vs. what this design originally proposed.

## 0. What already exists today — read this before any of the sections below

The codebase is **already most of the way there**. Card `695ebab0` generalized the original
decision-only inbox (card `8701bdbb`) into a typed `Question`/`QuestionInboxItem` object with a `type`
discriminator: `decision | input | permission | credential` (`packages/shared/src/types.ts:3605`). The
web nav route is **already `/inbox`** (`packages/web/src/nav.tsx:89`) — only its sidebar *label* still
reads "Requests". So this design is narrower than "build an inbox from scratch": it's (1) add a true
no-answer-needed kind, (2) decide the write-surface shape for it, (3) add noise control a notice-class
kind actually needs, (4) finish the user-facing rename, (5) wire notifications/companion relay for the
new kind.

**Map of what exists (grep'd, not assumed):**

- **MCP tools** (`packages/daemon/src/mcp/questionTool.ts` holds the shared implementations; registered
  twice, verbatim, by `mcp/orchestration.ts` for the **manager** surface and `mcp/platform.ts` for the
  **Platform Lead** surface — never the worker surface):
  - `question_ask` — non-blocking ask; shape validated/built by `buildQuestionAsk`. Takes `type` (defaults
    `"decision"`), `title`, `body`/`detail`, plus per-type fields, `supersedes`, `provisionTo`,
    `fulfillmentTarget`.
  - `question_pull` — agent-lineage-scoped, bounded, pull-and-consume every `answered` row for the caller.
  - `question_cancel` — withdraw a still-`pending` ask (agent-lineage-scoped).
  - `question_amend` — edit a still-`pending` ask's title/body/options in place.
  - `question_resolve` — let the asker mark its own pending ask answered from a live owner **chat** reply
    (never agent-authored text — anti-fabrication invariant).
  - `requests_list` — non-consuming, paged, board-wide read of the caller's own project's Requests.
  - `task_requests_list` / `task_request_get` (`mcp/tasks.ts`) — read-only, card-scoped; **this is the one
    question-related surface a *worker* can reach** (read-only, to consult a decision its manager already
    fielded — see `packages/daemon/assets/skills/worker/SKILL.md`).
  - Platform Auditor (`mcp/audit.ts`) gets its own read-only, cross-project `requests_list` via
    `auditRequestItem`/`pageRequests` (shared pager, card `a193398f`/"requests-list-two-path-cap-asymmetry").
- **A worker's entire MCP surface is `worker_report` (+ `run_gate`/`my_context`/board reads)** —
  confirmed by reading the `role === "worker"` branch of `OrchestrationMcpRouter.buildServer`
  (`mcp/orchestration.ts:2179`): no `question_ask` registration at all. This is **already** the
  "workers relay through their manager" architecture the card asks me to recommend — it's existing,
  deliberate, load-bearing structure, not something to newly invent.
- **DB**: one table, `questions` (`packages/daemon/src/db.ts:1311`), `type TEXT NOT NULL DEFAULT
  'decision'` with **no CHECK constraint** — widening the enum needs no SQL migration, only
  `QUESTION_TYPES` (shared) + the zod shape (`questionTool.ts`) + the UI's type-tone maps. New *columns*
  go through the established `QUESTION_ADDED_COLUMNS` + `migrateQuestions()` ALTER-TABLE pattern
  (`db.ts:2206`) — every prior addition (`escalated_at`, `acknowledged_until`, `fulfillment_target`, …)
  used this, nullable, backfilled to `null`/a safe default, never a destructive migration.
- **REST**: `GET /api/questions` (global "waiting on me" — pending+answered, `?includeConsumed=true`
  folds in terminal history), `GET /api/questions/:id`, `POST /api/questions/:id/answer` (human-only
  write, branches by `type`), `POST /api/questions/:id/dismiss` (cancel), `POST
  /api/questions/:id/acknowledge` (snooze the STALE badge — see below), `GET /api/pending-bindings`
  (credential-provisioning side list). All loopback, human-only — same trust posture as the git/vault
  writers (`gateway/server.ts:6175` onward).
- **Web UI**: `pages/RequestsPage.tsx` (two tabs: "Waiting on me" / "History") renders
  `components/requests.tsx`'s `RequestsInbox`/`RequestHistory`. **Type and project filter chips already
  exist in both tabs** (`requests.tsx:264`, `:822`) — adding a new `QUESTION_TYPES` member gets a filter
  chip "for free" via `REQUEST_TYPE_ORDER`/`REQUEST_TYPE_TONE` (`lib/questions.ts`). The Sidebar's red
  badge on the `/inbox` nav item is `state === "pending"` count only (`Sidebar.tsx:152`). `Board.tsx`
  embeds a per-task "connected requests" rail that already uses the word **"Inbox"** in one place ("Add
  to Inbox", `Board.tsx:1551`) while labeling the section "Requests" elsewhere (`:1438`) — the naming is
  already visibly inconsistent in-tree, which is itself a small piece of evidence the rename is overdue.
- **Lifecycle / noise precedent already in the codebase** (for part (c) below): `platform_escalate`
  (manager→Platform Lead, a different and already-existing "inform, don't just ask" channel — see §(b))
  dedupes a repeat same-title escalation while the prior one is unresolved (`deduped:true`); the
  companion's `decisions-relay` lever dedupes via a stored per-row **signature**
  (`decisionSurfaceSignature`, folds in title/body/options so `question_amend` can't be masked as
  unchanged — `@decision 0c1365d0`); the companion's `attention-push` watcher has its own
  `IMMEDIATE_BURST_CAP` (coalesce >10 qualifying events/tick into one digest turn) and a
  `FLEET_OPS_ALERT_CLASSES` split (routine fleet-ops classes excluded from a companion's `"*"` lead-mode
  wildcard subscription by default). None of these three mechanisms is reusable as-is for a human-facing
  notice flood — they solve companion-chat noise, not inbox-row noise — but they're the right shape to
  mirror (see §(c)).
- **Snooze vs. read are already two different, non-overlapping concepts** — don't conflate them when
  designing "unread" below: `acknowledgedUntil` (card `889ae619`) is a durable, human-set snooze of the
  web attention queue's red "… STALE" treatment for a still-`pending` row; it never touches `state` and
  auto-re-reddens the instant it passes. There is **no existing "has a human looked at this row" field**
  at all — `consumedAt` means "the asking **agent** pulled the answer back," not "a **human** saw it."

## (a) Item kinds

**Keep the four existing kinds exactly as they are** — `decision`/`input`/`permission`/`credential`
already cover every ask/answer shape, and nothing here proposes touching their validation, state machine,
or answer UI.

**Add one new kind: `notice`.** An agent-to-owner FYI/status line that needs no answer — "worker X
finished the migration," "deploy succeeded," "heads up, I changed approach on Y." This is the one new
primitive the card actually asks for.

Naming: `notice` over `fyi`/`info`/`status`. `status` collides in spirit with `Task.status`/
`Session.*State` elsewhere in the schema and would read as if it were reporting *on* something with a
lifecycle; `info`/`fyi` read fine as UI copy but are weak as a **type discriminator identifier** sitting
in code next to `decision`/`permission`/`credential`. `notice` reads as a peer of those three and is
unambiguous in both places.

**Lifecycle — do NOT route a notice through the pending→answered→consumed answer machinery at all.**
A notice has nothing to answer, so forcing it through that FSM creates two real problems:
1. It would sit in `state:"pending"` looking exactly like a decision the owner is being asked to resolve
   — polluting the `pending` count that drives the Sidebar badge, the `decision-pending` attention-push
   alert class, and `db.listOpenQuestions()`'s "waiting on me" framing. A notice is explicitly *not*
   waiting on the owner for anything.
2. If it ever reaches `state:"answered"`, `question_pull` would hand it back to the **asking agent** on
   its next pull — a confusing echo of the agent's own FYI, since nothing about a notice is information
   the filer is waiting to receive back.

Recommendation (ORIGINALLY PROPOSED — SUPERSEDED by Code Review round 2, see the "Round 2" section near
the end of this record; kept here, struck through in spirit, so the history of the decision stays
legible): insert a `type:"notice"` row directly as a **self-terminal** state — ~~`state:"answered"`~~ —
`answeredAt = createdAt`, `chosenOption: null`, `note: null`, `options: null` — but ~~exclude `type =
'notice'` from `question_pull`'s underlying query~~. **This reused-`"answered"` approach shipped in Phase
1 and was found NOT SHIP by Code Review `b13df292`**: every existing `state === "answered"` reader treats
that state as "the owner answered, not yet pulled," which is false for a notice, and reusing it broke
three of them. The ACTUAL built state is `state:"notice"` — its own `QuestionState` member — which makes
the `question_pull` exclusion unconditional and automatic (no separate `type` filter needed at all). See
the Round 2 section for the full fix and reader audit.

**Does an "ack" state exist?** Not as a new `QuestionState` for the read/unread concern this question was
actually asking about — correct, and unchanged by round 2. **But round 2 DID add a new `QuestionState`
for a different reason** (self-terminal correctness, not read/unread) — don't conflate the two: `"notice"`
exists because reusing `"answered"` broke readers, not because an ack/read-tracking state was needed; the
read/unread mechanism below is still Phase 2, still unbuilt, still orthogonal to `state`. The thing the
owner actually needs — "mark that I've seen this" — is a **read/unread** concern, not a lifecycle
concern, and it's useful for every kind, not just notices (the card's own UI ask in (d) is "filters by
kind, project, **and unread**").
Recommend a new nullable `read_at TEXT` column on `questions` (via `QUESTION_ADDED_COLUMNS`, same pattern
as every prior addition — see §(f)), set by a lightweight human-only write (e.g. a batched `POST
/api/questions/mark-read` taking an id list, or set-on-open when the detail modal is opened for that row)
and read as `readAt: string | null` on `QuestionInboxItem`. This is **orthogonal to `state`**: a `pending`
decision can be read-but-unanswered, a `notice` can be answered-but-unread. Keep the two concepts visibly
separate in the UI and in any future code comment, the same way `acknowledgedUntil` (snooze) and `state`
are already kept separate today — conflating "read" with "answered"/"consumed" would be the same mistake
`cb7d6998` already named for `sessionId` vs. `filedBySessionId` (two different questions that happen to
sit on the same row).

## (b) The agent write surface

**One new `type:"notice"` value on `question_ask`'s existing `type` param — not a new MCP tool.**

`buildQuestionAsk`, `questionPullItem`, `taskRequestGetItem`, `auditRequestItem`, `cancelQuestionForAgent`,
`amendQuestionForAgent`, and `pageRequests` are all already generic over `QuestionType` and already branch
per-type. A new tool (e.g. `notice_post`) would have to reinvent agent-lineage ownership scoping, the
cancel/amend/supersede plumbing, the REST read/write surfaces, the three list-shaping functions, and the
Platform Lead's parallel registration — all to produce a row that is structurally identical to today's
`Question` object minus an answer. That is pure duplication with no offsetting benefit: there is no
trust-boundary reason to split it into a second tool, since the *role* gate (who may call it) is identical
to `question_ask`'s existing gate.

Shape: `type:"notice"` requires `title`+`body` (same as every other type via `buildQuestionAsk`'s existing
`resolveAlias(body, detail)` check) and silently drops `options`/`recommendation`/`action`/`scope`/
`expiresAt`/`envVar`/`provisionTo`/`fulfillmentTarget` — exactly like every other non-matching type does
today (e.g. `options` is already dropped for non-`"decision"` types). No new validation branch is needed
beyond the self-terminal insert described in (a).

**Roles: manager and Platform Lead only — identical to every existing `question_ask` type. Workers do
NOT get this tool, including for `notice`.** This is not a new restriction I'm inventing for this card; it
is the restriction that **already exists** for every other type, and the card's own text already asks me
to justify keeping it that way for the new kind too. Reasons, in order of weight:

1. **It's the existing architecture, not a new one.** A worker's entire MCP surface today is
   `worker_report` up to its manager — "depth-1," per the shipped `worker` doctrine skill. Adding
   `question_ask` (any type) to that surface would be a first-of-its-kind hole in a structural invariant
   (`CLAUDE.md`'s role-scoped `--disallowedTools` spawn recipe, the worker doctrine's "escalate up, never
   sideways" rule) that exists specifically so a worker's only channel is its manager. A `notice` ask is
   not somehow lower-stakes than a `decision` ask in this respect — both are "an agent writes directly
   into the owner's inbox," and the manager-mediation reasoning doesn't change based on whether an answer
   is expected back.
2. **The manager is the dedup/filtering/context boundary, not a formality.** A manager runs N workers at
   once; its job (already codified in `/orchestate`'s doctrine and in how `worker_report`'s
   `deliveryStatus` works) is to decide what's actually worth a human's attention versus routine progress
   it should absorb itself. A worker with its own direct notice channel reintroduces exactly the fleet-
   noise problem `CLAUDE.md`'s message-drain kind-classification section (`pty/host.ts`) and the
   companion's `FLEET_OPS_ALERT_CLASSES` split both exist to prevent elsewhere in this codebase — many
   workers, each free to FYI the owner directly, is a worse failure mode for "notice" than for "decision"
   precisely *because* nothing gates a notice on an answer; there's no natural backpressure.
3. **Precedent already in-tree for exactly this relay pattern.** `platform_escalate` is manager→Platform
   Lead's own "report a bug, OR notify of a status/completion it asked to hear about" channel — the
   doc comment explicitly includes the FYI case alongside the bug-report case, and it is manager-only, not
   worker-reachable, for the identical reason. The Inbox's new `notice` kind is the human-facing sibling of
   that pattern; it should inherit the same shape, not a looser one.

**Attribution when a manager relays on a worker's behalf:** there is no "on behalf of agent X" field on
`Question` today (nor on `platform_escalate`'s equivalent), and I'm not proposing one in this first slice —
it would need its own `filedBySessionId`-shaped provenance design (worker session ids are typically
short-lived/worktree-scoped, unlike a manager's own identity) and the card doesn't ask for it. The manager
composes the notice body itself (e.g. "Worker on card `<id>` reports: …"), the same way it already
composes a `platform_escalate` body today. Flag this as a candidate follow-up if the owner wants
structured per-worker attribution later — it's a real gap, just not one this slice needs to close.

## (c) Noise control

A `notice` has no natural backpressure (nothing is "owed" back, so nothing stops a chatty manager from
firing one per tick) — this needs an actual mechanism, not just doctrine telling managers to be polite.

1. **Server-side rate limit, enforced in `buildQuestionAsk` (or its caller), scoped per asking **agent
   lineage** (the same scope `question_pull`/`question_cancel`/`question_amend` already use via
   `sessions.agent_id` — a recycled successor shares the limit with its predecessor, which is correct:
   the limit is about load on the owner, not about one particular session row).** A sliding-window cap —
   e.g. a new project-level, human-tunable `orchestration.maxNoticesPerHour` config key (same shape as
   `orchestration.staleRequestMinutes`/`maxConcurrentGates` — `resolveConfig`-resolved, platform default →
   per-project override), defaulting to something generous enough not to bite a legitimate status-update
   cadence (a starting value like 10/hour per agent lineage is a reasonable opening guess; the owner
   should set the real number, see the open question below). **On exceeding it, refuse the call with an
   error naming the limit and suggesting the agent consolidate or use `supersedes`** — never silently drop
   the notice. Silent dropping would violate the same "never silently swallow a caller's intent" posture
   `applySupersede`'s own doc already states for a failed supersede ("reported back... never silently
   swallowed... never blocks or discards the caller's actual new ask"); a notice limit should refuse
   loudly, the same way, so the agent can see it hit a wall and change behavior instead of believing its
   FYI landed when it didn't.
2. **Dedupe via the existing `supersedes` param — document it as the idiomatic move for a repeat status
   update about the same ongoing thing, not a new mechanism.** `question_ask` already accepts
   `supersedes:<id>` for exactly "this new ask replaces that one" (card `fe2c1c6b` deliberately rejected
   an *auto*-detected heuristic in favor of an explicit, asker-stated supersede) — a manager posting "50%
   done" then later "100% done" on the same task should supersede the first with the second rather than
   leaving two live notice rows. This needs doctrine (a line in `/orchestrate`'s skill) more than code.
3. **A companion notification path, if the owner has `attention-push` granted, needs its own class** —
   see (e) below; the per-tick `IMMEDIATE_BURST_CAP` coalescing already in `attention-push.ts` applies to
   whatever class a notice maps to "for free," so this card doesn't need a second burst cap invented for
   notices specifically — it needs the new class *wired into* the existing one.
4. **Explicitly NOT in scope for this card:** the owner's **web** inbox bell/badge is append-only history
   by design (every other Request kind behaves this way too) — this card doesn't propose auto-expiring or
   auto-archiving old read notices; "unread" filtering (§(a)/(d)) is the mechanism for keeping the *active*
   view manageable, and History already exists for everything else.

## (d) UI

**Rename the user-facing label only — "Requests" → "Inbox" — leave file/component/route names as-is.**
The route is already `/inbox`; `RequestsPage.tsx`/`components/requests.tsx`/`lib/questions.ts`/
`lib/requestDrafts.ts` keep their current filenames and exports. Renaming source files buys nothing for
the owner (who only ever sees the rendered label) and costs real diff noise across every import site —
this is the "least churn" call from (f) applied to the UI specifically. Concretely:

- `nav.tsx:89`: `{ label: "Requests", to: "/inbox", ... }` → `{ label: "Inbox", to: "/inbox", ... }`.
- `RequestsPage.tsx:15`: the page header span text `"Requests"` → `"Inbox"`.
- `Board.tsx:1438`: the collapsed-rail strip label `"Requests"` → `"Inbox"` (making it consistent with the
  *already-present* "Add to Inbox" button text two call sites away — this fixes the in-tree inconsistency
  noted in §0, it doesn't introduce a new one).
- `App.tsx:180`: the title attribute `"open the Requests inbox"` is already inbox-flavored prose; leave it
  (or tidy to `"open the Inbox"` while touching the line — cosmetic either way).
- Code comments that say "Requests" when describing the *object/table* (e.g. `@decision 5b22b262`'s "the
  Requests inbox shows...") should stay as-is — they're naming the `Question`/`QuestionInboxItem` data
  model, which this design does **not** rename (see §(f)); only the **UI label the owner reads** changes.

**Filters by kind, project, and unread:**
- **Kind**: already exists (`REQUEST_TYPE_ORDER`/type filter chips in both the inbox and history tabs) —
  adding `notice` to `QUESTION_TYPES` + giving it a tone in `REQUEST_TYPE_TONE` (`lib/questions.ts`) is the
  only UI work needed for this filter to pick it up.
- **Project**: already exists in `RequestHistory` (`projF` select, `requests.tsx:826`); the live
  `RequestsInbox` tab currently shows every granted project unfiltered in one queue (cross-project by
  design, per its own doc comment) — recommend adding the same project `Select` there for symmetry with
  History, scoped by `useActiveProject()`'s known project list.
- **Unread**: new — a filter chip/toggle keyed on `readAt == null`, available in both tabs. Pairs with the
  `read_at` column from (a). The Sidebar's red pending-badge semantics (`state==='pending'`, "needs your
  decision") stay unchanged; add a second, visually distinct (less alarming — notices aren't urgent)
  indicator once notices exist, e.g. a muted dot for "N unread" alongside the existing red pending count,
  rather than conflating the two numbers into one badge.

**Deep links:** no routes change (`/inbox`, `/inbox/:id`-style question detail links if any exist today
via `QuestionAnswer.tsx` keep resolving exactly as before) — this is a pure label/filter addition, not a
route restructuring, so there is nothing to keep "working" that wasn't already going to keep working.

## (e) Notifications and companion relay

- **Web bell/toast/⌘K**: these already poll the shared `openQuestions` query (`attention.ts:244`,`:804`).
  A `notice` row reaching its own terminal state (`"notice"` as actually built by round 2 — this bullet
  originally said `"answered"`) immediately (per (a)) means it will **not** trigger the
  existing new-pending-item toast logic if that logic keys specifically on newly-`pending` rows — check
  this at build time and, if so, add a parallel "newly-created notice" signal (keyed on `createdAt`
  freshness + `type==='notice'`) so a notice still produces a toast/bell event despite skipping `pending`
  entirely. This is the one place where "notices never go through `pending`" (chosen deliberately in (a)
  to protect the pending-count semantics) has a cost that needs an explicit, separate wire-up rather than
  falling out of the existing pending-based plumbing for free.
- **`attention-push` (companion, owner-facing proactive alerts)**: add a new `AttentionAlertClass`, e.g.
  `"notice"`, classified from a new `question_asked`-shaped event carrying `type:"notice"` (today's
  `classify()` already special-cases `question_asked`/`request_escalated` by kind — this slots in as a
  sibling case, not a new mechanism). Per the owner-signal/fleet-ops split (`@decision b5c606aa`), a
  `notice` is explicitly an owner-signal class (it exists *to* inform the owner), so it should **not** be
  added to `FLEET_OPS_ALERT_CLASSES` — but per that same decision's "absent config ⇒ nothing subscribed"
  default, a companion only pushes it when the project's `attention-push` grant explicitly lists
  `"notice"` in `alertClasses`, or the companion is in lead mode (whose `"*"` wildcard already expands to
  every non-fleet-ops class, so `notice` is included there automatically with zero extra wiring once the
  class exists).
- **`decisions-relay` (companion read/act lever)**: `decisions_list`'s underlying read is
  `db.listOpenQuestions()` unfiltered by type — a `notice` row will already appear there once it exists,
  UNLESS it's filtered out deliberately. Recommend it **is** included (a companion asked "what's pending
  for the owner" should be able to mention a recent FYI) but `decision_resolve` (the ACT half) must
  continue to require `options` to be non-empty — which a `notice` never has — so `decision_resolve`
  already structurally refuses to try to "resolve" a notice; no new guard code is needed there, only
  confirming (at build time) that the existing options-required check isn't accidentally bypassable for
  the new type.
- **Platform Auditor's cross-project `requests_list`**: `auditRequestItem`/`listQuestionsForAudit` are
  already generic over every `Question` row — a `notice` shows up there automatically. Its `stale` flag
  (card `5ea0153c`, "routing session isn't live right now") is defined only in terms of a still-`pending`
  row (`state='pending'`); since a notice is never `pending`, it will correctly never read `stale:true` —
  confirm this at implementation time rather than assuming it, per the "verify before reporting" posture.

## (f) Migration of existing rows, and REST/DB naming

**UI-only rename, with one additive (nullable) schema change for `read_at` — not a data migration.**

- **Keep the DB table name `questions`, every existing column name, and the whole `/api/questions/*` REST
  surface exactly as-is.** Renaming any of these is pure internal-naming churn with real blast radius
  (every query in `db.ts`, every REST route, every MCP tool's internal plumbing, every test file) for zero
  owner-visible benefit — the owner never sees a table name or a REST path; they see the sidebar label and
  the page header, both covered by (d). This is the direct application of the card's own "prefer least
  churn" ask.
- **`QUESTION_TYPES` widens by one member (`"notice"`)** — no SQL migration (no CHECK constraint exists on
  the `type` column, confirmed by reading the `CREATE TABLE` statement), just a shared-types + zod-shape +
  UI-tone-map change.
- **One new nullable column, `read_at TEXT`**, added via the existing `QUESTION_ADDED_COLUMNS` +
  `migrateQuestions()` ALTER-TABLE-ADD-COLUMN pattern (`db.ts:2206` onward) — the same mechanism every
  prior Question column addition used (`escalated_at`, `acknowledged_until`, `fulfillment_target`, …).
  Every pre-existing row reads `read_at: null` ("never marked read") after the migration — a safe,
  non-destructive default; there is nothing to backfill, since "has a human looked at this specific row"
  genuinely has no recoverable history for anything created before this column existed (same "unrecoverable,
  not merely unmigrated" posture already documented for `filedBySessionId` on legacy rows, `cb7d6998`).
- **No existing row needs reclassifying.** Every row already created is `decision`/`input`/`permission`/
  `credential` and stays exactly that; `notice` is additive, used only by new asks going forward.

## (g) Test blast radius

Per `CLAUDE.md`'s "which check to run" guidance, these are the specific, named surfaces a `notice`-kind
change would trip — read at source before relying on a count, per that same file's own standing warning
about stale counts in this exact section of doctrine.

- **Surface-drift (new tool? No — but verify no tool table needs touching anyway):** since this design
  adds a `type` value to an *existing* tool rather than registering a new one, `agent-prompt-lint-surface-
  drift.mjs`/`agent-prompt-lint.mjs` and the per-surface `*-surface.mjs` tests
  (`mgmt-surface.mjs`/`operator-surface.mjs`/`setup-surface.mjs`/`user-audit-surface.mjs`/
  `platform-elevated-surface.mjs`/`platform-mgmt-surface.mjs`/`audit-surface.mjs`) should NOT need updates
  — `question_ask`/`question_pull`/etc. are already named in `promptLint.ts`'s tool tables
  (`packages/daemon/src/agents/promptLint.ts:38,53,74-75,96`) and that registration doesn't change. Run
  them anyway as a cheap confirming check, since "shouldn't need updates" is a claim to verify, not assume.
- **`role-surface-tools-named-in-doctrine.mjs`**: doesn't fire from a `type` value change (it checks tool
  *names* are named in doctrine, not their param enums) — but the **doctrine text itself** should still
  gain a line about the `notice` kind and the rate limit from (c), since a worker/manager reading
  `/orchestrate`'s skill should learn about the new kind and that `supersedes` does NOT help with a
  repeat notice (round 2 correction — see its own section). That's a doctrine-content update, tracked by
  the *next* bullet, not this test.
- **Response/entity key-set guards**: `QuestionInboxItem`'s shape doesn't gain a new *field* from the
  `notice` type itself, but it DOES gain one from `read_at`/`readAt` — check `entity-row-fields-guard.mjs`
  and `worker-status-projection-guard.mjs` (named in `CLAUDE.md`'s "added a FIELD to an existing tool's
  response" bullet) for whether either pins `QuestionInboxItem`'s/`Question`'s key set; if either does,
  it needs the new field added to its expected set in the SAME change that adds the column.
- **Functional tests already covering this object** (found via grep, read before trusting the list):
  `requests-typed-object.mjs`, `questions-inbox-read.mjs`, `question-orphan-no-successor.mjs`,
  `question-acknowledged-until-migration.mjs` (the migration-column precedent to follow for `read_at`'s
  own migration test), plus `test/decision-inbox*.mjs`/`test/companion-decisions-relay.mjs` for the
  companion relay surfaces touched in (e). A `notice` kind needs its own new test(s) covering: the
  self-terminal insert (state lands `answered` at creation), the `question_pull` exclusion, the rate limit
  refusal + its error message, and the `read_at` round-trip.
- **e2e (web)**: `packages/web/e2e/requests-inbox.spec.ts`, `requests-modal-everywhere.spec.ts`,
  `board-task-requests-rail.spec.ts`, `decision-inbox.spec.ts`, `board-inbox-create-failure.spec.ts`,
  `request-draft-guard.spec.ts` — the type/project/unread filter additions and the label rename both touch
  these; run the full set, not a guess at which ones the rename affects (a label-text assertion anywhere
  in them would break silently otherwise).
- **Guard list**: run `pnpm --filter @loom/daemon guards` regardless (per `CLAUDE.md`'s standing
  instruction to read `STATIC_GUARD_REPO_PATHS` fresh rather than trust a cached list) — nothing in this
  design obviously trips `working-tree-eol-guard`/`fixed-wait-witness-guard`/etc., but a build worker
  should still run the full guard command as part of its own DoD rather than skip it on my say-so.

## (h) Phased build plan

**Phase 1 — the smallest slice that delivers the owner's actual ask** (agents can inform, not just ask):
1. `QUESTION_TYPES` += `"notice"` (shared types + zod shape in `questionTool.ts`).
2. Self-terminal insert for `type:"notice"` in `buildQuestionAsk`; exclude it from
   `pullAnsweredQuestionsForAgentBounded`'s query.
3. Rate limit (per agent lineage, human-tunable project config key) in the `question_ask` handler path,
   refusing loudly over the limit.
4. UI: type-tone entry for `notice` (free filter chip), the label rename (`nav.tsx`/`RequestsPage.tsx`/
   `Board.tsx`), a minimal "no answer needed" row treatment in `RequestRow`/the detail modal (no
   `RequestControl` buttons — just title/body/provenance/timestamp, mirroring how a pure-blocker
   decision/input already renders with no options).
5. Doctrine: a few lines in `/orchestrate`'s skill — when to use `notice` vs. `platform_escalate` vs.
   `worker_report`, and the `supersedes`-for-repeats convention.
6. Tests named in (g)'s "needs its own new test(s)" bullet.

**Phase 2 — the read/unread layer** (needed for the UI ask's "filters by... unread," but separable since
Phase 1 is independently useful without it):
1. `read_at` column (+ migration, following `question-acknowledged-until-migration.mjs`'s precedent).
2. Mark-read write path (batched REST route or set-on-open).
3. Unread filter chip in both Inbox tabs; secondary muted "N unread" indicator in the Sidebar.

**Phase 3 — notifications/companion** (per (e), genuinely separable — Phase 1 is usable with zero
companion awareness, same as `input`/`permission` were usable before any companion lever existed for
them):
1. New `AttentionAlertClass: "notice"`, wired into `classify()`, excluded from `FLEET_OPS_ALERT_CLASSES`.
2. Web bell/toast "newly-created notice" signal (since it skips `pending`, per the (e) caveat).
3. Confirm (not assume) `decisions_list`/`decision_resolve` behave correctly for the new type with no code
   change, or make the small change if they don't.

**Phase 4 — attribution (explicitly deferred, not scheduled):** structured "on behalf of worker X"
provenance on a manager-relayed notice, if the owner wants it after using Phase 1-3 for a while. Not
carded yet; noted here so it isn't lost.

## Owner-only decisions

Two things in this design were genuinely the owner's call, not an engineering judgment call — the
manager routed both and ruled on them directly (not re-escalated to the owner, since both are safe,
human-tunable config, not a one-way door):

1. **The `maxNoticesPerHour` default value** (§(c)) — **RULED: 6/hour per agent lineage** (manager/Lead),
   not the 10/hour this design originally proposed as a no-data starting guess. Implemented as
   `OrchestrationConfig.maxNoticesPerHour`, default `6` (`packages/shared/src/config.ts`).
2. **Whether `notice` joins a companion's "lead mode" `"*"` wildcard by default** (§(e)) — **RULED:
   EXCLUDE by default** (the opposite of this design's original "yes, it's owner-signal" recommendation).
   A companion forwards a `notice` to chat only when a human explicitly opts that companion in (adds
   `"notice"` to its own `attention-push` grant's `alertClasses`) — it is NOT folded into
   `FLEET_OPS_ALERT_CLASSES` (so an explicit per-grant opt-in still works), but it IS excluded from the
   `"*"` lead-mode expansion itself. **Not yet implemented** — Phase 3 (notifications/companion, below)
   is still deferred; this ruling is recorded here so Phase 3 implements it correctly rather than
   defaulting to this design's original (now-overridden) recommendation.

## Implementation notes (Phase 1, built)

What actually landed, and what changed from this design during the build — read this before trusting a
claim above as still accurate; this section corrects it where it drifted.

- **A correction to §(c)'s `supersedes` guidance — superseded again by round 2.** This design originally
  suggested documenting `supersedes` as "the idiomatic move for a repeat status update," which Phase 1's
  implementation notes already corrected to "don't re-notice the same thing" once it became clear
  `supersedes` cancels a still-**`pending`** ask and a notice is never pending. That correction's reasoning
  stays valid after round 2 (a notice is now `state:"notice"`, still never `pending`) — the doctrine text
  and the mention-removal at `questionTool.ts`'s rate-limit comment (round 2, Code Review nitpick) both
  just drop the stale reference rather than re-explain it. The real (and only) noise-control mechanism for
  notices is the rate limit (§(c) point 1).
- **`maxNoticesPerHour` is HUMAN-only — and, since round 2's Code Review (b13df292), human-only even on
  the ELEVATED Platform Lead's `project_configure`.** This corrects Phase 1's own implementation note,
  which claimed the opposite (Lead-settable, "same trust tier as gateCommand/alertWebhook") — that framing
  was wrong on reflection: an agent that could raise its own rate limit would defeat the mechanism, and
  that reasoning applies just as much to the Lead raising its OWN fleet's limit as to an ordinary manager
  raising its own. It is omitted from the agent-facing config validator (`mcp/platform.ts`'s
  `agentOrchestrationOverride`) AND listed in `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` — the SAME trust
  tier `orchestration.mergeGate` sits in, not the Lead-settable `gateCommand`/`alertWebhook` tier. No
  dedicated Settings UI control was added in this slice; set it via `PATCH /api/projects/:id/config` with
  `{orchestration:{maxNoticesPerHour: N}}` until one exists.
- **The rate-limit refusal is per-agent-lineage, not per-project** — verified by a dedicated test case
  (`notice-request-kind.mjs` (D6)): a second manager/Lead lineage on the same project gets its own
  independent budget, matching `question_pull`'s existing agent-lineage scoping convention.
- **UI**: the nav label, the Inbox page header, and the per-task "connected requests" rail label (which
  this design's §0 flagged as already visibly inconsistent with the nearby "Add to Inbox" button text)
  all now read "Inbox." The route, file names, and component names are unchanged, per §(f). `notice` got
  a `muted` tone (deliberately not one of the four actionable tones), a `type`+`project`+existing filter
  chip for free (no new filter code needed — `REQUEST_TYPE_ORDER` already drives it), and a distinct
  "FYI · no answer needed" treatment in the detail modal, state chip ("FYI" instead of "ANSWERED"), and
  row outcome text — rather than falling through to the generic decision/input rendering, which would
  have shown a confusing "—" for every notice. The 30-minute "answered, not picked up" watchdog
  (`isDecisionWatchdog`) excludes a notice BY CONSTRUCTION since round 2 (it checks `state`, and a notice
  is never `state:"answered"` at all) — Phase 1's own version of this exclusion checked `type` instead,
  which worked but was redundant the moment `state` became authoritative; round 2 simplified it back to a
  plain `Pick<Question,"state"|"answeredAt">` check with no `type` plumbing needed. An **unread filter**
  was NOT built in this slice — it is Phase 2 (`read_at`), still deferred; see the phased build plan above.
- **Tests (Phase 1)**: `packages/daemon/test/notice-request-kind.mjs` (new) covers the self-terminal
  insert, the `question_pull` exclusion (both the bounded and unbounded backing queries), the generic
  answer-writer no-op, the rate-limit refusal (including the per-lineage scoping), and the worker-surface
  exclusion — proven RED (reverted to pre-Phase-1 `HEAD`) → GREEN (restored) via `pnpm --filter
  @loom/daemon negative-control`. The full named test battery the manager specified (CLAUDE.md's
  surface-drift list, the four response key-set guards, every daemon test matching
  `question`/`decision`/`request` in its filename, and `pnpm --filter @loom/daemon guards`) all passed
  clean against the built change.

## Round 2 (Code Review `b13df292`, NOT SHIP — fixed) — a notice gets its OWN `QuestionState`

Full record: `docs/decisions/b13df292-notice-never-reuses-answered.md` (the decision/incident narrative —
this section is the design-doc side of the same fix, not a duplicate of it).

**The defect:** Phase 1 inserted a `type:"notice"` row as `state:"answered"` (self-terminal). Every
existing `"answered"` reader in the codebase treats that state as a narrow, specific claim — "the owner
answered, and the asking agent hasn't pulled it yet" — which is not true of a notice. The Code Review
found three concrete breaks: `IdleWatcher.tickAnsweredStuckQuestions` fired a false
`[loom:answered-stuck] … call question_pull` nudge 15 minutes after any notice (re-firing on every
restart, since its dedupe lives only in memory); `wake-impact.ts`'s `hasUnconsumedAnswer` read `true` for
a manager holding only a notice, defeating `isNoOpManagerWake`; and `mcp/tasks.ts`'s
`summarizeTaskRequests` folded a notice into its `answered` bucket.

**The fix (manager's structural ruling):** give a notice its own terminal `QuestionState`, `"notice"`
(`packages/shared/src/types.ts`'s `QUESTION_STATES`) — never reuse `"answered"`. `buildQuestionAsk`
(`mcp/questionTool.ts`) now inserts it directly as `state:"notice"` (still `answeredAt = createdAt`, for
age display). Every `state === "answered"` / `state = 'answered'` reader now excludes a notice BY
CONSTRUCTION, with no per-reader special-casing needed — this is the "safe default" the ruling asked for.

**The full reader audit** (grepped for every `state === "answered"`, `state = 'answered'`,
`state IN (...)`/`'pending'`, `listOpenQuestions`, and the web watchdog/state-chip derivations — not
sampled):

| Reader | File | Needed a code change? |
|---|---|---|
| `Db.listAnsweredStuckQuestions` (answered-stuck watchdog) | `db.ts` | **No** — `state = 'answered'` excludes `'notice'` by construction. Verified with a new `answered-stuck-watcher.mjs` case (6b) — **CR2-corrected** (`844bd6b8`): seeds through real `buildQuestionAsk` now, not a hand-built row; see the "Tests" correction below. |
| `wake-impact.ts`'s `hasUnconsumedAnswer` | `orchestration/wake-impact.ts` | **No** — same reason. Verified with a new `wake-impact.mjs` case — **CR2-corrected**, same fix as above. |
| `restart.ts`'s `isNoOpManagerWake` | `orchestration/restart.ts` | **No** — consumes `hasUnconsumedAnswer`, inherits the fix transitively. Re-ran `restart-wake-classification.mjs` clean. |
| `mcp/questionTool.ts`'s `questionAnswerByType` (`hasAnswer`) | `mcp/questionTool.ts` | **No** — `state === "answered" \|\| state === "consumed"` already correctly excludes `"notice"`; it reads `hasAnswer:false`, which is accurate (nothing was answered). |
| `pullAnsweredQuestionsForAgent` / `…Bounded` (question_pull's own backing queries) | `db.ts` | **Yes, simplified** — the Phase 1 `AND q.type != 'notice'` clause is now dead code (state already excludes it) and was removed; keeping a redundant filter would have been misleading, not merely harmless. |
| `pullAnsweredQuestions` (the session-scoped, non-agent-lineage pull variant) | `db.ts` | **No** — same `state = 'answered'` filter, never touched by Phase 1 either; confirmed it was never broken. |
| `mcp/tasks.ts`'s `summarizeTaskRequests` / `TaskRequestsSummary` | `mcp/tasks.ts` | **Yes** — added a dedicated `notices` bucket (manager's ruling item 3); a notice is state-distinct from pending/answered/cancelled and needs its own count, not a fold-in. Verified with a new `task-requests-read.mjs` section (J), mirroring the file's own prior cancelled-bucket regression test (I). |
| `Db.listOpenQuestions` (the web "waiting on me" / History read) | `db.ts` | **Yes** — this is the one place that WANTS to show a notice (manager's ruling item 2): the default view now includes a notice created within `NOTICE_INBOX_WINDOW_MS` (7 days) and excludes an older one; `includeConsumed:true` (History) includes every notice regardless of age. Verified with new `notice-request-kind.mjs` cases (H1)-(H4). |
| `Db.listQuestionsForAudit` under its default `excludeConsumed:true` (the manager's own `requests_list`, `mcp/orchestration.ts`) | `db.ts` | **Yes (CR2 item 5)** — got the SAME `NOTICE_INBOX_WINDOW_MS` window as `listOpenQuestions`, for consistency: without it, this surface kept every notice forever. An explicit `state:"notice"` filter still bypasses the window (shows it regardless of age) — the SAME "an explicit filter always wins" rule `includeConsumed` already states for consumed/cancelled. The Auditor's OWN cross-project `requests_list` (`mcp/audit.ts`) does NOT get this window — it never defaults `excludeConsumed` in the first place (it already shows everything unfiltered by state, by design, since it's an audit surface). Verified with new `notice-request-kind.mjs` cases (I1)-(I4). |
| Both `requests_list` tool descriptions (`mcp/orchestration.ts`, `mcp/audit.ts`) | `mcp/orchestration.ts` / `mcp/audit.ts` | **Yes (CR2 item 5)** — neither named `notice` in its `state`/`type` enum prose; both now do, and the manager surface's description states the window behavior above plus corrects the `mine:true` text (a notice is never returned by `question_pull`, but `mine:true` still lists it here since this read is non-consuming). |
| Web `isDecisionWatchdog` / `questionStateChip` (`lib/questions.ts`) | `lib/questions.ts` | **Simplified, not newly fixed** — Phase 1 had already excluded a notice via an explicit `type` check (defensive, ahead of this round's fix); round 2 switched both to check `state === "notice"` directly (now authoritative) and dropped the now-unnecessary `type` parameter from both function signatures entirely. |
| Web `AnsweredReadout` / `RequestRow` / `RequestHistory` (`components/requests.tsx`) | `components/requests.tsx` | **Yes, cosmetic** — switched the notice-detection checks from `q.type === "notice"` to `q.state === "notice"` for consistency with the new authoritative FSM signal (not a behavior change, both were already correct); fixed one leftover `"answered"` label text (the row's age-line said "answered 3m ago" for a notice) to "posted"; `RequestHistory`'s terminal filter/outcome bucket/history count now include `notice` explicitly (it's genuinely resolved history, just not `consumed`/`cancelled`) with its own outcome-filter option and count. **CR2 item 2 (a real bug, not cosmetic): `RequestsInbox`'s default view folded a notice into the generic "answered" bucket** (shown under "Answered · waiting on manager pickup," a false claim — nobody is waiting on anything for a notice) **and counted it toward the "Waiting on me (N)" header.** Fixed: a notice is now its own `notices` bucket, rendered under its own "FYI · recent notices" group, and the header count is `pending.length + answered.length` only (notices excluded). |
| Web `ConnectedRequestsRail` / `ConnectedRequestAnswer` (`pages/Board.tsx`) — the web twin of `mcp/tasks.ts`'s `summarizeTaskRequests` | `pages/Board.tsx` | **Yes (CR2 item 3, a real bug, missed in the original round-2 pass — this file was absent from the audit table entirely until now).** `ConnectedRequestsRail`'s by-state summary line had no `notices` bucket, so its counts stopped summing to the header's `linked.length` the moment a connected notice existed. `ConnectedRequestAnswer` had no `state === "notice"` branch at all, so an expanded notice fell through to the generic decision/input rendering and showed a bare "—" instead of its body. Fixed: a `notices` count added to the summary line (mirroring `summarizeTaskRequests`'s bucket), and a notice branch added ahead of the type branches (mirroring `AnsweredReadout`'s own ordering) showing the body under an "FYI · no answer needed" label. |
| `mcp/tasks.ts`'s `resolveDeferredEventStuck` (a `deferredUntilEvent(kind:"request-answered")` pointing at a notice) | `mcp/tasks.ts` | **Yes (CR2 item 4, a real bug).** A notice is self-terminal and never transitions to `"answered"`, so a deferral naming one can never fire — but the function's `state === "cancelled"` check didn't know that, and silently read `stuck:false` forever (the SAME "can never fire" shape as a cancelled/superseded request, which the function already handles correctly). Fixed: `state === "notice"` is now treated as unfireable too, same as `"cancelled"`. Verified with a new `task-defer-stuck-event.mjs` case (I). |
| Platform Auditor's `auditRequestItem` / its `stale` flag | `mcp/questionTool.ts` | **No** — generic over every `Question` row already; `stale` is defined only for `state='pending'`, which a notice never is, so it correctly never reads `stale:true`. Not independently re-verified this round (Phase 1's own note already covered it; the state rename doesn't change the reasoning). |
| Companion `decisions_list` / `decision_resolve` (`companion/capabilities.ts`) | — | **No** — out of scope this round (Phase 3, card `68f27faf`); `decision_resolve` already structurally refuses anything with no `options`, which a notice never has, regardless of its state name. |

**A methodology note this round's own CR2 earned the hard way:** a reader-audit row marked "verified with a new test" is only as strong as whether that test actually exercises the PRODUCTION decision under audit. Two rows above (`listAnsweredStuckQuestions`, `hasUnconsumedAnswer`) were marked verified in this record while their tests silently hand-built the row under test — proving nothing about whether `buildQuestionAsk` itself was correct. Audit the TEST's own construction, not just its assertion, before marking a row verified.

**Config trust-tier fix (manager's ruling item 4):** `orchestration.maxNoticesPerHour` is now human-only
even on the elevated Platform Lead's `project_configure` — added to `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`
(`mcp/platform.ts`), the same tier `orchestration.mergeGate` sits in. The shared nested-human-only-key
rejection error message was genericized (it used to hardcode "it changes the merge gate," which would have
been actively wrong for this key) rather than special-cased per key.

**Nitpicks (manager's ruling item 5), all fixed:** the stale `supersedes` mentions at `config.ts`'s
`maxNoticesPerHour` doc and `questionTool.ts`'s rate-limit comment are removed (not merely corrected — see
the `supersedes` bullet above); `question_ask`'s tool description (both `orchestration.ts` and
`platform.ts`) now states the answer-push-nudge never fires for a notice; `App.tsx`'s pill tooltip reads
"open the Inbox" (was "open the Requests inbox").

**Tests (round 2)**: `notice-request-kind.mjs` extended with sections (F) agent-validator rejection, (G)
elevated-Lead rejection, (H) the inbox-visibility window, and (I) `requests_list`'s own backing query
getting the same window (added in the CR2 follow-up below); `answered-stuck-watcher.mjs` gained case
(6b); `wake-impact.mjs` gained a notice-only case; `task-requests-read.mjs` gained section (J).
**Correction (CR2 `844bd6b8`): this record originally claimed "all proven RED (reverted to end-of-Phase-1
`HEAD`)," which was true for (F)/(G)/(H)/(J) but FALSE for the (6b)/wake-impact cases** — both hand-built
a `{state:"notice"}` row directly via `db.insertQuestion`, bypassing `buildQuestionAsk` entirely, so they
passed identically whether or not the production state-assignment decision was correct (vacuous — they'd
have passed on the pre-round-2 bug too). Fixed in the CR2 follow-up: both now seed through the REAL
`buildQuestionAsk({type:"notice"})`, backdating only the resulting row's timestamps afterward (never
`state`), and are now ACTUALLY proven RED on `1eb8822f` (end of Phase 1) → GREEN restored, via
`pnpm --filter @loom/daemon negative-control`. See the lesson spelled out in the "Round 2" section's own
audit-methodology note, and in the b13df292 record's own file for why this distinction matters generally.
Full battery re-run clean after the CR2 fixes: the same 8 surface-drift/doctrine tests, the 4 response
key-set guards, every `question`/`decision`/`request`/`answered`-matching daemon test (exhaustively
grepped, not a fixed count — re-derive it from the filename pattern, not from a number quoted here),
`wake-impact.mjs`/`restart-wake-classification.mjs`, the 7 Inbox e2e specs, and `pnpm --filter
@loom/daemon guards`.
