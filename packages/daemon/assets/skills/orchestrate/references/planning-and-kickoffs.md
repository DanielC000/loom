# Planning, carding, and kickoffs — detail

Read this when you triage a backlog, create or retitle a card, route a card on a multi-repo project, or
write a `worker_spawn` kickoff. The core doctrine (loop, steps 1-4) carries the shape of each step; this
file carries the sub-rules.

## Step 1 — plan & triage

   - **Consult a card's connected Requests before you act on it.** `tasks_get` shows a summary; read
     detail and the answer with the non-consuming `task_requests_list` / `task_request_get` (distinct from
     `question_pull`), so you don't re-ask what the owner already settled. **An EMPTY per-card result is
     NOT proof the owner never answered** (the link can be absent or lag): before you label a card
     "owner-gated" and park actionable work, cross-check the board-wide inbox (non-consuming
     `requests_list`, or drain `question_pull`).
   - **Before filing a "remove/drop X as dead" card, prove X is dead and cite the proof.** "Nothing
     displays it" is a hypothesis: check `git log`/`git blame` on the symbol (was it added for a feature
     that still needs it?) AND grep repo-wide for live consumers, then put the blame/commit and grep
     result in the card.
   - **A short `@decision <id>` (or `@decision sha:<8hex>`) comment marks a load-bearing decision
     record.** A `Read` covering that line already surfaces its guard; if the project exposes
     `decisions_for`, use it only to resolve what the guard didn't answer.
   - **Reviewing a diff that grows or keeps a long WHY-heavy comment block? Ask whether it's decision
     narrative** (the WHY behind a choice, or an incident a future reader would want) rather than a short
     standing guard, contract docs, or restated code. If so, request extraction via `worker_message`
     instead of waving it through: a short `@decision <id> — <the prohibition or consequence, not a
     summary>` pointer in the code, the narrative in `docs/decisions/<id>-slug.md` (or, for a rare
     cross-cutting decision, `docs/adr/<id>-slug.md`, immutable: amend or supersede, never rewrite).
     `<id>` is a board task id, or `sha:<8hex>` (introducing commit, from `git blame`) when no task
     covers it, never invented. Check first whether that id already has a record; a second decision under
     one id is a new section there, never a second file. Same rule when you author a change or doc
     yourself. A note-only project uses the same grammar in an HTML comment: `<!-- @decision <id> — ...
     -->`.

## Step 2 — decompose into delegable tasks

   - **A card that changes a tool's contract or documented behavior carries "update the docs/doctrine
     that teach the OLD way" in its DoD**; check it at the merge gate.
   - **Title cards in Conventional Commits form**: `type(scope): summary` (lowercase type, imperative,
     no trailing period, ≤~72 chars; no `[Type, Priority]` bracket, priority is a card field). A SOLO
     squash merge uses the card title verbatim as the mainline commit subject (a slipped title is
     coerced by a safety-net; don't lean on it). Allowed types: `feat, fix, docs, style, refactor, perf,
     test, build, ci, chore, revert`. **A BATCHED landing (`merge_batch`) never rewrites or coerces a
     subject: every commit subject on the branch lands verbatim.** `worker_merge`'s review exposes
     `ownTipSubject`/`ownTipSubjectConventional` (tip commit only, enough for a single-commit branch)
     and `ownNonTipCommitSubjects`/`ownNonTipCommitSubjectsConventional`; check both before routing a
     multi-commit branch into a batch.
   - **The scope is REQUIRED** and comes from the project's own "**Commit scopes**" list in its
     `CLAUDE.md` (the subsystem the change lands in). If none exists, **derive one at intake** from the
     repo's real structure and add the section to `CLAUDE.md` in the same work. Scopeless is acceptable
     only for a project with no meaningful code subdivisions (e.g. a single-vault research project). The
     vocabulary is per-project data, never baked into this doctrine.
   - **On a MULTI-REPO project, route each card to its repo when you CREATE it.** If the project
     registers additional writable repos, your startup context lists them by key; each card targets
     exactly one via `repoKey` (`tasks_create` / `tasks_update`); none means the primary repo.
     - A worker's worktree is cut from the repo its card names, and retargeting is refused while that
       worktree exists: route before you spawn.
     - It is YOUR decision; a worker cannot set its card's repo, so don't ask one to pick.
     - **One task = one repo.** No cross-repo atomic merge: work spanning two repos is two sibling cards
       you sequence (land and verify the dependency first). A worker whose change needs a second repo
       gets a new card, not a scope expansion.
     - **Each repo carries its own gate.** A repo with no gate command does not inherit another's: its
       merges are reported **unverified**. Decide before dispatch whether that's acceptable, and say so
       in the kickoff if it isn't.

## Step 3 — write self-contained kickoff prompts

   - **Inline the full spec; cite a foreign card id as provenance only.** A worker's task tool is
     scoped to its OWN board, so telling it to look up a card from a different board dead-ends. Write
     "originally filed as X — for reference only" and inline the content it must act on.
   - **Never hand a worktree-bound worker a bare vault-relative path** (e.g. `Projects/…/Design/*.md`):
     it can live outside the worktree and be unreachable. Paste the excerpt or give an absolute,
     worktree-reachable path.
   - **Name the tests to run as a test-file FAMILY, not a keyword filter**, and for a changed lookup or
     identity key also name the fixtures that construct the entity directly: a keyword grep misses
     hand-built state, so the red surfaces a review round or a gate later.
   - **Sequence review before the full gate.** When a card needs Code Review, tell the worker to run
     targeted tests only until review approves, then fire ONE `run_gate` on the approved tip
     (`run_gate` is the worker's call only where the kickoff allows it; the merge gate stays
     authoritative either way). A blocking review voids any gate already holding a slot.
   - **A card's cited file location is a HYPOTHESIS, not a scope fence.** Don't turn a guessed location
     into "touch only this file": a wrong guess forces the worker to block instead of tracing the real
     site. To de-conflict parallel workers, scope by SUBSYSTEM/TASK, not by a guessed path.

## Dispatch sizing and board structure

- Size dispatch off `capacity:{cap,live,inFlight,free}` (the `worker_spawn` result and every `worker_list` row); `free` is a live read at that call, so re-read it rather than carrying it forward. Past the cap, `worker_spawn` throws "concurrency cap reached (N)" and records the intent as `capQueued`, which auto-fires FIFO when a slot frees — but ⚠️ that queue is in-memory-only and does **not** survive a daemon restart; re-`worker_spawn` by hand after one if the dispatch still matters. `taskId` is **optional**: omit it for a taskless spike, or for a read-only reviewer via `reviewOfWorkerSessionId`/`reviewOfTaskId` (mutually exclusive; cuts the reviewer's branch from the reviewed branch's current tip).
- **Record structure as board data, not title tags or prose.** Group an epic's children with `parentId` (a card with children *is* the epic). Record a real dependency with `blockedBy`/`blocks` (it stops blocking once the blocker is done or merged and never parks the card); use `deferredUntilTaskId` only to park a card and auto-release it when another merges. Link cards with `relatedTo`/`related` and a follow-up with `discoveredFrom`. Pick work with `tasks_list({ready:true})` (add `parentId` to scope to one epic). When you read relations and write them back, leave out `released:true` items: that is history, not a dependency. The tool descriptions own the mechanics.

## The intake lane

**The intake lane is the owner's intake.** If the board's FIRST column has the `intake` role, the owner drops **raw one-liner wishes** there — the counterpart to `held` (`held` is the owner's stop, intake is the owner's start). **Auto pick these up**; don't wait for a prompt and don't let them sit: convert each wish into scoped, actionable task(s) with a clear definition of done, move it into the normal flow, and drive it like any other card. **Retitle on intake — no raw owner placeholder survives into a working column.** When you refine a raw wish (from intake, or a raw placeholder in `backlog`), `tasks_update` its TITLE to a descriptive Conventional-Commits title, whether you (a) implement it in place (for a SOLO merge the title becomes the squash commit subject on the mainline, so it MUST be conventional; see the card-titling bullet below for the `merge_batch` exception) or (b) keep it as a decomposed umbrella (still descriptive; the children carry their own conventional titles). **Safety:** if an item is ambiguous, irreversible, or outward-facing beyond your autonomy bar, refine it into a task and **escalate** per the escalation bar below; never auto-run destructive or irreversible work off a one-liner.

## Where project-specifics live

**Project-specifics live in the project's agent prompts + `CLAUDE.md`, never in a shipped or shared skill.** Skills (this one, `/worker`, `/web-design`, …) ship to end-users' own projects, so they stay generic. A project's conventions, gate command, definition of done, repo paths and build commands go in the **agent's base prompt** or the project's own `CLAUDE.md`, which is where you inject them into a worker — not in a skill, and not in the globally-injected *personal* `CLAUDE.md` (it spans every project, so a project rule there leaks across all of them). Skill = generic HOW; prompt / project `CLAUDE.md` = the WHAT. Weigh before routing more content into `CLAUDE.md`: it is injected in full into every session on the project, manager and worker alike, so it spends every reader's attention every session.
