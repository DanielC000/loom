# a6d885e6 — audit of the bundled skills corpus (staleness · overlap · bloat · leaked project-specifics)

Card `a6d885e6` asked for a four-axis audit of the bundled skills under `packages/daemon/assets/skills/`. **This is an audit; no skill, no `CLAUDE.md`, and no source file was changed.** The only file this card commits is this record. Every finding below is cited at `file:line` and was verified against live source at audit time (2026-09-21), including the card's own dated readings.

## Scope correction that reframes the whole corpus: 10 skills ship, not 14

`DEV_ONLY_SKILLS` re-verified live at `scripts/curate-release-skills.mjs:24` — still exactly four (`platform-lead`, `platform-audit`, `codescape`, `research`), matching the card's dated claim. So of the 14 bundled skill dirs, **four are omitted from the published package and 10 actually reach end users.**

| | dirs | `SKILL.md` bytes |
|---|---:|---:|
| bundled in-repo | 14 | 305,882 |
| **shipped to end users** | **10** | **242,744** |
| dev-only (omitted at release) | 4 | 63,138 |

The card's byte table re-measured **exactly**, every row — it has not drifted. `CLAUDE.md` is 77,766 bytes, also unchanged.

This split matters for every finding below: a defect in `orchestrate`/`worker`/`loom-*`/`web-design`/`ideate`/`setup-assistant`/`workspace-audit` reaches end users; one in `platform-lead`/`platform-audit`/`codescape`/`research` does not.

## Verification posture — what I checked and what came back clean

Three of my own hypotheses died against the source. Recording them because a later reader should not re-derive them:

- **"`worker/references/browser-verification.md` is orphaned"** — FALSE. It is zero-referenced from `worker/SKILL.md`, but it is reached by a deliberate two-hop chain: `SKILL.md:276` → `references/dev-server-verification.md:10` → `browser-verification.md`. That chain is deliberate and test-pinned at `packages/daemon/test/worker-skill-dev-server-reference-split.mjs:51-57`. Reference structure is sound; do not "fix" it.
- **"`setup-assistant` under-covers its router"** — FALSE. The live `loom-setup` router (`packages/daemon/src/mcp/setup.ts:119`) registers 22 tools; the skill names **all 22**. My first grep used too narrow an alternation and produced a false gap.
- **"a skill teaches a `[loom:*]` tag that no longer exists"** — FALSE. Every one of the 19 distinct tags taught across `orchestrate` and `worker` is genuinely emitted from `packages/daemon/src/`. The defect is the reverse (Finding 2): a recommended path whose tags are *not* taught.

Also checked and clean, so nobody spends a second pass on them:

- **Every MCP tool named in `orchestrate`** (Transport list and body) is registered on the live orchestration router (`packages/daemon/src/mcp/orchestration.ts`). No skill names a removed tool.
- **Board column-role vocabulary** — `active` (`loom-task-start:3`), `review`/`terminal`/`parked` (`loom-session-end:1`), `intake` (`orchestrate:94`) are all real roles per `packages/daemon/src/tasks/columns.ts:22-30`.
- **`recycleAtContextRatio` default 0.8** (`orchestrate:144`) matches `packages/shared/src/config.ts:1185`.
- **`concurrency cap reached (N)`** (`orchestrate:116`) matches `packages/daemon/src/orchestration/cap-queue.ts:244`.
- **`$LOOM_SCRATCH_DIR`** (`worker:~400`) is genuinely exported to every session (`packages/daemon/src/pty/host.ts:3571`).
- **Axis 4 mechanical half** — not re-run, per the card. The concept-level read that *was* outstanding is Finding 3, and it is the **only** hit across all 10 shipped skills (sweep method in the Axis 4 section).

---

# Findings

## CRITICAL

### C1 — `issue` (blocking) — two skills teach a resume-doc path the resolver never produces, against an injected instruction not to construct one at all

`packages/daemon/assets/skills/orchestrate/SKILL.md:838` and `packages/daemon/assets/skills/loom-pickup/SKILL.md:23` both say, near-verbatim:

> your session's **"Where things live"** context block gives your project's absolute **vault root**; your resume doc is `<vaultRoot>/Projects/<Project>/Orchestrator Log.md` (substitute your project's name). **Read and write it by that ABSOLUTE path**

Three things are wrong with that, each independently verified:

1. **The resolver inserts no such segment.** `resolveResumeDocPath` is `path.join(vaultPath, filename)` — `packages/daemon/src/sessions/resume-doc-notes.ts:39-51`. There is no `Projects/` and no `<Project>` component anywhere in it.
2. **The filename is a per-project config override, not a constant.** `orchestration.resumeDocFilename` defaults to `"Orchestrator Log.md"` (`packages/shared/src/config.ts:1185`, `resume-doc-notes.ts:25`) but is a first-class settable key with its own validation schema (`packages/daemon/src/mcp/platform.ts:243`, `resumeDocFilenameSchema` at `:125`). A project that sets it gets a skill telling its manager to write somewhere else.
3. **The injected block already supplies the resolved path and explicitly forbids reconstructing it.** `packages/daemon/src/sessions/manager-prompt.ts:109-119` emits `- **Project vault dir:** …` and `- **Resume doc:** <resolved absolute path>`, followed by: *"Read your resume doc from the exact absolute path above, verbatim — do not reconstruct it."* The skills instruct the exact behaviour the daemon's own prompt prohibits, and additionally mis-name the field (`Project vault dir`, not "vault root").

**Concrete failure.** For Loom's own project, `vaultPath` resolves to the directory that already contains `Orchestrator Log.md`, so following the skill yields a doubled `…/Projects/Loom/Projects/Loom/Orchestrator Log.md`. For an end-user project whose vault has no `Projects/` folder, it yields a path that does not exist. Either way the manager's handoff lands somewhere the daemon's own machinery never looks: `ResumeDocWatcher` (`packages/daemon/src/orchestration/resume-doc-watcher.ts:32,62`), the `[loom:resume-doc-size]` warning (`resume-doc-notes.ts:53-62`), and `resume-doc-snapshot.ts:153` all stat the *resolved* path. The rotation/size discipline `orchestrate:826-835` spends ~1.5 KB teaching is silently disarmed, and a successor reading the injected path finds a file its predecessor never wrote.

This is Critical rather than Major because the failure is **silent and cross-session**: nothing errors, and the loss only surfaces when a successor reads a stale or absent handoff.

**Direction.** Delete the reconstruction recipe from both skills. Replace with: read the `Resume doc` line from the "Where things live" block verbatim; never construct the path. That also removes the hardcoded filename and the `Projects/` taxonomy in one move, making the skills correct for any `resumeDocFilename` override and any vault layout.

## MAJOR

### M1 — `issue` (blocking) — `orchestrate` recommends `merge_batch`, then teaches a completion vocabulary that excludes it

`orchestrate/SKILL.md:609` makes batching the preferred path: *"2+ workers ready to merge on the SAME repo? Reach for `merge_batch` instead of sequential `worker_merge_confirm` calls."*

`orchestrate/SKILL.md:696-707` then tells the manager how to wait for a pending merge — *"wait for the async `[loom:merge-done]` / `[loom:merge-rejected]` / `[loom:merge-failed]` / `[loom:merge-unknown]` / `[loom:merge-cancelled]` / `[loom:merge-orphaned]` nudge"* — and the dedicated *"Know the `[loom:*]` nudge vocabulary"* block at `:766` repeats that same solo set.

A batch does not settle with any of them. It settles with `[loom:merge-batch-done]` / `[loom:merge-batch-failed]` / `[loom:merge-batch-unknown]` — `packages/daemon/src/sessions/service.ts:15470-15482`, confirmed also in the tool's own contract at `packages/daemon/src/mcp/orchestration.ts:4116`. **Zero of those three tags appear anywhere in `orchestrate`** (the five `merge_batch` mentions at `:103,539,609,657,856` are all about commit-subject handling, none about settlement).

**Concrete failure.** A manager follows `:609`, batches, hits the documented pending shape, and parks waiting for a `[loom:merge-done]` that will never arrive for that op — while holding a shared gate slot. The doctrine's own anti-spin-poll guidance (`:696`) then keeps it from checking `gate_status`.

Compounding it, the same tool contract records a second trap the skill never mentions (card `19256231`, `orchestration.ts:4116`): a batch op can report `settled` while the per-candidate fallback merges it spawned are **still running**, discoverable only via `gate_queue`'s `fallbackOfBatchOpId`. `orchestrate:612` tells the manager *"A red gate falls back to individual gating automatically … nothing to re-call"* — true, but it omits that the batch settling is not evidence those fallbacks finished.

**Direction.** Add the three batch tags to the nudge-vocabulary block and to the pending-merge bullet, and add one sentence to the `merge_batch` bullet that batch-settled ≠ fallback-finished, naming `fallbackOfBatchOpId`.

### M2 — `issue` (blocking) — `orchestrate` names Loom's own web-UI routes as verification targets for *any* project

`orchestrate/SKILL.md:898-901`:

> claude-in-chrome is Lead-only / special-case (the real authenticated browser) — heavy cockpit/Overview pages freeze its CDP renderer (mounting a live-session terminal is the trigger), so if you must use it, eyeball only LIGHT, non-terminal pages (`/settings`, `/skills`, `/platform`).

`/settings`, `/skills`, `/platform` and "Overview" are **Loom's own web UI** — `packages/web/src/App.tsx:298` (`/skills`), `:248,292` (`/platform`), `:99` (`/overview`), `packages/web/src/components/Sidebar.tsx:181,208-209` (`/settings`), `packages/web/src/components/navIcons.tsx:21,22,35`. "cockpit" and "live-session terminal" are likewise Loom product vocabulary.

`orchestrate` is a **shipped** skill. It is loaded by a manager orchestrating an end user's *own* project, where those routes do not exist. This is precisely the concept-level leak the card scoped as axis 4's remainder, and it is exactly the shape the intake grep structurally could not see: the pattern matched package paths, `@loom/*` names and vault paths, not bare route strings.

It is also **the only such leak in the shipped corpus** — see the Axis 4 section for the sweep and its bounds.

**Direction.** This is a genuine Loom-specific operational constraint, so per the card's own rule it is **extracted, never deleted**. The generic residue that belongs in the skill is: *"a real-browser tool's renderer can freeze on a heavy page that mounts a live terminal — prefer the headless browser, and if you must use the real one, pick a light page."* The named routes and the cockpit/Overview specifics move to `CLAUDE.md` (or the Lead's agent brief, since the sentence already scopes itself "Lead-only").

### M3 — `issue` (blocking) — `loom-session-end` teaches unconditional `git push`; three other skills carry defensive clauses against exactly that

`loom-session-end/SKILL.md:21-22`, inside step 2 (**before** the "By role" split at `:30`, so it reads as unconditional):

> Push with plain `git push` (it already refuses a non-fast-forward …); reach for `--force-with-lease` only as a deliberate guard when a force is genuinely intended.

Four supersession clauses exist across three other shipped skills, all aimed at this shape:

- `worker/SKILL.md:89` — *"Loom's outward-action gates supersede any step in a generic or user-level skill you've loaded"* (naming push, deploy, spend, delete, send)
- `worker/SKILL.md:110` — the **same clause a second time** in the same file
- `orchestrate/SKILL.md:247` — *"that gate supersedes any step in a generic or user-level skill you've loaded"*
- `ideate/SKILL.md:102` — *"This gate supersedes any step in a generic or user-level skill you've loaded (**e.g. a wrap-up skill mandating a push**)"*

`ideate:102` names the culprit by shape. Three skills have independently grown a patch around one unfixed source — the clearest "same rule taught in N places" instance in the corpus, and the strongest axis-2 hit.

**Concrete failure.** Git writes are a human-only REST trust boundary (`packages/daemon/src/git/writer.ts`; no core project-session MCP tool exposes them). A worker that loads `/loom-session-end` on a "wrapping up" trigger reads an instruction to push, which it cannot satisfy and must not attempt. Today it is caught only because `/worker` happens to be loaded and happens to carry the override twice. That is defence by redundancy, not by design, and it costs the four clauses plus the ambiguity.

**Direction.** Scope step 2 by role in `loom-session-end` itself — push belongs to a human-driven/lead session, never a worker — and point at `/worker` for the worker path (the skill already does this at `:32`, just too late in the document). Then collapse `worker`'s duplicate clause at `:110`.

### M4 — `issue` (blocking) — `orchestrate` teaches a superseded `worker_spawn` model and omits both of its current affordances

`orchestrate/SKILL.md:116-118` is the only place the skill describes `worker_spawn`'s capacity and shape:

> `maxConcurrentWorkers` caps live workers, so a `worker_spawn` past the cap throws "concurrency cap reached (N)" … `worker_spawn`'s `taskId` is **optional** — omit it for a taskless spike or **a read-only reviewer** without hijacking a board card.

`grep -c "reviewOf\|capacity\|capQueued"` over `orchestrate/SKILL.md` returns **0**. Three live behaviours are consequently untaught:

1. **`capacity:{cap,live,inFlight,free}`** now rides on every successful spawn — `packages/daemon/src/mcp/orchestration.ts:3035-3048` (card `548a0c7e`). The tool's own contract says outright: *"Previously the cap was observable ONLY by deliberately provoking a rejection to read its message — that workaround is no longer needed."* The skill still teaches only the provoke-a-rejection model.
2. **A cap rejection now queues and auto-fires.** `capQueued:{opId,taskId,queuedAt}` records the intent, it is visible in `worker_list`, and it **fires on its own FIFO** when a slot frees — but it does **not** survive any daemon restart. The skill teaches "past the cap throws" as the whole story, which loses both the free retry and the restart hazard.
3. **Review spawns are now first-class.** `reviewOfWorkerSessionId` / `reviewOfTaskId` (`orchestration.ts:3319-3320`, threaded at `:3340`, card `47bbdc3f`) cut the reviewer's worktree from the reviewed branch's current tip, so ordinary `Read`/`Grep` is correct by construction. The skill's one sentence about read-only reviewers (`:118`) is exactly where this belongs and it is absent.

**Concrete failure.** A manager following `:118` spawns a reviewer with a worktree cut from `HEAD`, not from the branch under review — so the reviewer reads the wrong bytes unless it hand-rolls `git show`, silently reviewing mainline instead of the change. (This audit's own session was dispatched that way.)

**Direction.** Rewrite the `:116-118` bullet against the live tool contract: read `capacity.free` rather than provoking a rejection; a cap rejection is queued-and-auto-firing but restart-fragile; and a review spawn passes `reviewOf*` with `taskId` omitted.

## MINOR

### m1 — `issue` (non-blocking) — `worker` says the gate pins "two-lane" concurrency; the live pin is three

`worker/SKILL.md:119-120`: *"It also pins **two-lane** test concurrency for you, so don't set a test-concurrency env var yourself."*

Live: `packages/daemon/src/sessions/service.ts:1056` — `const WORKER_GATE_ENV_OVERRIDE: NodeJS.ProcessEnv = { LOOM_GATE_TEST_CONCURRENCY: "3" }`. The raise is recorded in-source at `packages/daemon/src/orchestration/gate-runner.ts:571` (*"raised 2->3 by 2ff32b5c"*), and `orchestration.ts:2092` states the same 3. `CLAUDE.md` also documents 3, so the skill contradicts both the code and the project's standards file.

Minor, not Major: the operative instruction ("don't set it yourself") remains correct, so the only harm is a worker reasoning about host load from a figure 50% low.

### m2 — `issue` (non-blocking) — `orchestrate`'s Transport describes a drain rule that changed

`orchestrate/SKILL.md:37-38`: *"A report that arrives while you're mid-turn is held in your inbox and otherwise drains ONE-per-turn as a separate (often already-handled) turn."*

Agent-kind messages now coalesce per sender: a run of consecutive entries from the **same** sender drains as one turn; a different sender still breaks the run. Worker reports qualify — `packages/daemon/src/sessions/service.ts:9723` enqueues with `{ sender: workerSessionId, kind: "agent" }`. So two reports from the *same* worker arrive as one turn, not two.

Minor: the cross-worker case (the common one) still behaves as described, and `inbox_pull` — the bullet's actual recommendation — is unaffected.

### m3 — `issue` (non-blocking) — `CLAUDE.md:56` states the `loom-setup` router has 19 tools; it has 22

`CLAUDE.md:56` describes the Platform operator as served by *"a curated **fail-closed** `loom-setup` MCP router (`/mcp-setup/:sessionId`, role-gated, 19 tools …)"*.

The live router (`packages/daemon/src/mcp/setup.ts:119`) registers **22**, counted two independent ways: `project_create`, `project_init`, `project_configure`, `project_update`, `project_archive`, `agent_create`, `agent_update`, `agent_get`, `template_list`, `template_apply`, `profile_create`, `profile_update`, `profile_assign`, `profile_get`, `list_all_projects`, `list_all_agents`, `list_all_sessions`, `project_get`, `session_spawn`, `end_me`, `skill_list`, `skill_write`.

Not a skill defect — `setup-assistant/SKILL.md` covers all 22 correctly. Filed because `CLAUDE.md` is the standards file this audit judges against, and an enumerable count in it is exactly the drift its own "point at a source of truth, never restate its content" rule warns about.

## NITPICK

### n1 — `worker/SKILL.md:89` and `:110` state the outward-action supersession clause twice, ~20 lines apart. Folds into card 4 below; not worth its own change.

---

# Axis 3 — wordiness, measured

The card's instrument is right: `references/` + `scripts/`, not deletion. **No proposal below removes a prohibition.** Where a cluster contains a hard fence (e.g. `orchestrate:465` *"⛔ `worker_redirect` is NOT a rung on this ladder"`), the fence stays inline in compressed form and only the surrounding diagnostic narrative moves — so **realized savings are materially below the raw cluster sizes**. I give the raw sizes as a ceiling, not a promise.

## `orchestrate` — 109,518 bytes, six situational clusters totalling 24,587 B (22.5%)

| bytes | % | lines | cluster | why it is on-demand |
|---:|---:|---|---|---|
| 8,415 | 7.7% | L435-478 | worker-liveness diagnostics: `composerDirtyLen` / `lastEngineOutputAt` / codex-null / turnSeq discriminator / `worker_flush` / remedy ladder | only ever needed while diagnosing one apparently-stuck worker |
| 4,608 | 4.2% | L910-958 | dev-server port-ownership walk, Windows process-listing caveats, log identity, fixture identity | only when a browser-capable worker is being reviewed; a reference already exists (`serving-and-capture.md`) |
| 3,943 | 3.6% | L656-695 | retitle cluster + the four title-staleness axes | only at a merge where the card's premise or scope shifted |
| 3,171 | 2.9% | L959-992 | control-polarity, grep-count ratios, right-answer-instrument, cross-review agreement | general research epistemics, not orchestration mechanics; overlaps `/worker`'s absence-claim rule |
| 2,513 | 2.3% | L734-758 | `gate_queue` / orphaned-process / `recentTimeoutStreak` | only when contention looks abnormal |
| 1,937 | 1.8% | L1098-1124 | `## A restart/redeploy note other sessions will read` | only when writing such a note on a platform that has one |

Residual `SKILL.md` if all six extract: **84,931 B**. The L910-958 cluster is the clearest win — `orchestrate:993` already points at `references/serving-and-capture.md`, so a partial extraction happened and left the bulk behind.

## `worker` — 53,149 bytes; one cluster is a quarter of the file

| bytes | % | lines | cluster |
|---:|---:|---|---|
| 12,874 | **24.2%** | L123-251 | the `run_gate` park/stale-worktree/`gate_status`/`gate_cancel`/shared-resource bullet set |
| 4,577 | 8.6% | L365-418 | worktree isolation + stash prohibition + Windows junction hazard + never-hang rules |

`## How you work` alone is 36,337 B (68.4%). The `run_gate` cluster is a single situational topic — it matters once, when a worker decides how to verify — and `worker` already ships a `references/` dir with a working two-hop chain, so the mechanism is proven in-skill.

## Axis 3 caveat worth stating

`CLAUDE.md` (77,766 B) is injected in full into every session, so a manager boots carrying ~188 KB and a worker ~131 KB before brief and kickoff. **Extraction moves bytes from always-injected to on-demand; it does not reduce the corpus.** A child card should measure the `SKILL.md` delta, not the directory total, and should not claim a token saving it cannot demonstrate.

---

# Axis 2 — synergy / overlap

## The `loom-*` / personal twin family: the card's starting premise is stale, and the collision is already resolved

The card asks to *"confirm the prefixed bundled copy is actually the one reaching users"* given that personal overrides project. **Both sides have since been renamed, so no name collision exists anywhere.** Bundled: `loom-doc-hygiene`, `loom-pickup`, `loom-session-end`, `loom-task-start` (`packages/daemon/assets/skills/`). Personal, on the owner's host: `personal-doc-hygiene`, `personal-pickup`, `personal-session-end`, `personal-task-start` (`~/.claude/skills/`). All eight load side by side with distinct names; neither shadows the other. **No action needed on the shipped side.**

One real defect surfaced, but it is **owner-workspace scope, not shipped**, and is offered only as an optional follow-up:

`~/.claude/skills/personal-doc-hygiene/SKILL.md` is a **stale fork** of `loom-doc-hygiene`, not an independent skill — identical H1 and opening paragraph, and it still carries the bundled skill's own tagline *"Shipped and kept current by Loom"* while being neither. It is 2,317 B against the bundled 4,494 B, and is missing: rule 5 (shallow taxonomy + `_Index.md`), rule 6 (**no hard-wrapped prose** — a rule the owner holds explicitly), the `docs/adr/**` immutability exception in rule 2, and two "How to apply" bullets. Its description differs from the bundled one by exactly the dropped hard-wrap clause. Because the two descriptions are otherwise near-identical, both fire on the same trigger in every owner session, and whichever wins may be the copy missing the owner's own rule.

The other three pairs have genuinely **diverged by design** — the personal ones are Obsidian-vault-oriented, the bundled ones board-oriented. That is correct, not drift. Their trigger phrases do overlap heavily ("pickup", "continue", "what were we doing"), which is a legitimate ambiguity but not a defect to fix under this card.

## The strongest overlap finding is M3

Four clauses in three skills patching one unfixed instruction (`worker:89`, `worker:110`, `orchestrate:247`, `ideate:102` → `loom-session-end:21`). Fixing the source is what retires the patches.

---

# Axis 4 — concept-level leakage

Per the card, the mechanical grep was **not** re-run. The outstanding work was a read for Loom-specific concepts written in generic words.

**Method.** Two sweeps across the 10 **shipped** skills only: (a) bare web-route literals in backticks, which the intake pattern structurally could not match; (b) Loom product/UI nouns (`cockpit`, `Overview page`, `Skills UI`, `Settings UI`, `Mission Control`, `the Requests inbox`).

**Result — exactly one leak**, and it is M2 above: `orchestrate/SKILL.md:898-901` (`/settings`, `/skills`, `/platform`, plus `cockpit` at `:899`).

Two hits were inspected and dismissed:

- `setup-assistant/SKILL.md:89` says "Skills UI" — legitimate; that skill's entire job *is* operating Loom's own workspace for the user.
- `loom-task-start/SKILL.md:20` says "the Requests inbox" — legitimate; that is the correct product name for the `question_ask` surface the user actually has.

**Bound on this result.** These two sweeps catch route literals and a hand-listed noun vocabulary. They would not catch a Loom-specific *mechanism* described in fully generic prose with no distinctive noun — e.g. `orchestrate`'s two-step `worker_merge` → `worker_merge_confirm` framing, which is Loom's own semantics but is correct to state in a Loom-shipped skill. I read for that class and found nothing that warranted extraction; that is a judgement, not a measurement, and it is the weakest claim in this record.

---

# Proposed child cards

Six, ordered by severity, each independently mergeable with its own DoD. **I filed none of these — the manager boards them.**

**A constraint binding all six.** `packages/daemon/assets/skills/**` is pinned `text eol=lf` in `.gitattributes:12`. For files under that prefix the `working-tree-eol-guard` pass condition is **`CR == 0`**, *not* the tree-default `CR == LF`. Checking a skill edit against `CR == LF` is a false failure. Verify with `git check-attr text eol -- <path>` before comparing.

**A second constraint binding all six.** A merged `assets/skills/**` change is not live until a daemon restart re-seeds the store, and then only for a `customized:false` (pristine) skill. **Ordering trap: if the store carries a Skills-UI edit not yet folded into `assets/`, adopting first silently discards it** — land content in `assets/` first, then adopt.

### Card 1 — `fix(assets): read the resume-doc path from the injected block instead of reconstructing it`

Closes **C1**. Highest priority: silent, cross-session handoff loss.

**Changes.** `orchestrate/SKILL.md:838` and `loom-pickup/SKILL.md:23`. Remove the `<vaultRoot>/Projects/<Project>/Orchestrator Log.md` recipe and the hardcoded filename from both. Replace with an instruction to read the `Resume doc:` line from the "Where things live" block verbatim and never construct the path. Fix the field name to `Project vault dir`. Keep the existing "never Glob/`find`/`ls` for it" prohibition.

**DoD.** Neither file contains `Projects/<Project>` or a hardcoded `Orchestrator Log.md` as a path to construct. Both agree with `manager-prompt.ts:109-119`'s "do not reconstruct it". Guidance is correct for a project setting a `resumeDocFilename` override. `pnpm --filter @loom/daemon guards` green; `CR == 0` on both files.

### Card 2 — `fix(assets): teach the merge_batch settle nudges and the fallback-still-running trap`

Closes **M1**.

**Changes.** `orchestrate/SKILL.md`. Add `[loom:merge-batch-done]` / `[loom:merge-batch-failed]` / `[loom:merge-batch-unknown]` to the nudge-vocabulary block (`:766`) and to the pending-merge bullet (`:696`). Add one sentence to the `merge_batch` bullet (`:609`) that a batch reporting `settled` does not mean its fallback merges finished, naming `gate_queue`'s `fallbackOfBatchOpId`.

**DoD.** All three batch tags appear in `orchestrate/SKILL.md` and match `service.ts:15470-15482` verbatim. A manager reading only the pending-merge bullet can identify a batch's completion signal. No prohibition removed. `CR == 0`.

### Card 3 — `docs(assets): extract Loom's own UI routes out of the shipped orchestrate skill`

Closes **M2**. The one axis-4 leak.

**Changes.** `orchestrate/SKILL.md:898-901` — keep the generic constraint (a real-browser renderer can freeze on a heavy page mounting a live terminal; prefer headless; if you must use the real browser, pick a light page). Move `/settings`, `/skills`, `/platform`, "cockpit"/"Overview" to `CLAUDE.md` or the Platform Lead's agent brief — **extracted, never deleted**, per the owner's own instruction.

**DoD.** No bare Loom web route remains in any **shipped** skill (re-run sweep (a) from the Axis 4 section). The constraint survives in generic form. The specifics are findable in `CLAUDE.md` or the Lead brief. The intake's original mechanical grep still returns zero across the corpus. `CR == 0`.

### Card 4 — `fix(assets): scope loom-session-end's push step by role and drop the duplicate worker clause`

Closes **M3** and **n1**.

**Changes.** `loom-session-end/SKILL.md:17-22` — scope step 2 so committing/pushing is explicitly the human-driven/lead path and a worker is routed to `/worker` (`worker_report`, never push, never merge) *at that step*, not only in the "By role" block at `:30`. Then remove the duplicate supersession clause at `worker/SKILL.md:110`, keeping `:89`.

**DoD.** A worker reading `loom-session-end` top-to-bottom never encounters an unconditional push instruction. The `git add -A` prohibition and the `--force-with-lease` guard are **retained**, just role-scoped. `worker/SKILL.md` states the outward-gate clause once. The clauses at `orchestrate:247` and `ideate:102` are left in place (they guard other loaded skills too) — this card does not remove them. `CR == 0`.

### Card 5 — `fix(assets): update orchestrate's worker_spawn guidance to the live tool contract`

Closes **M4**.

**Changes.** `orchestrate/SKILL.md:116-118`. Replace the provoke-a-rejection cap model with `capacity.free` (`orchestration.ts:3035-3048`). State that a cap rejection is recorded as `capQueued`, auto-fires FIFO when a slot frees, and does **not** survive a daemon restart. Extend the read-only-reviewer sentence at `:118` to name `reviewOfWorkerSessionId` / `reviewOfTaskId` with `taskId` omitted (`orchestration.ts:3319-3320`).

**DoD.** Each claim cites the live contract; a manager can size a dispatch without provoking a rejection and can spawn a reviewer whose worktree matches the branch under review. Verified against `orchestration.ts`, not against this record. `CR == 0`.

### Card 6 — `docs(assets): correct the gate test-concurrency figure in the worker doctrine`

Closes **m1**. Smallest and safest; good first landing.

**Changes.** `worker/SKILL.md:119` — "two-lane" → three, matching `service.ts:1056`. Optionally fold in **m2** (`orchestrate:37-38`, same-sender coalescing) and **m3** (`CLAUDE.md:56`, 19 → 22 tools) if the manager wants one docs-accuracy card rather than three; m3 touches `CLAUDE.md`, not a skill, so it may belong on its own.

**DoD.** No skill states a test-concurrency figure contradicting `service.ts:1056`. If m3 is folded in, the `CLAUDE.md` count matches a fresh count of `setup.ts` registrations — **or**, better and per `CLAUDE.md`'s own "point at a source of truth" rule, the count is replaced with a pointer to `setup.ts` so it cannot drift again. `CR == 0` on skill files; **`CR == LF`** on `CLAUDE.md` (tree default — different condition, do not conflate).

## Sequencing note for the manager

Cards 1-6 touch disjoint line ranges except Cards 2, 3 and 5, which all edit `orchestrate/SKILL.md` in three separate regions (`:609`/`:696`/`:766`, `:898-901`, `:112-117`). They are independently mergeable but will contend at the merge gate if run fully parallel. Card 6 is the cheapest and is a good candidate to land first.

The axis-3 extraction work is **deliberately not carded here.** It is a larger, judgement-heavy change set that should be scoped after the correctness cards land, so the extractions are made against corrected text rather than being redone. The measured cluster table above is the input for that scoping.

---

# What this audit did not do

- **Did not re-run the axis-4 mechanical grep**, per the card's explicit instruction.
- **Did not audit the four dev-only skills** (`platform-lead`, `platform-audit`, `codescape`, `research`, 63,138 B) beyond confirming their omission from the release and sweeping them for the cross-skill contradictions in M3. They do not reach end users, so axis-4 leakage does not apply to them and axis-3 bytes do not bill an end user.
- **Did not verify the `references/` and `scripts/` payloads** (`orchestrate` 19,597 B of references + 43,414 B of scripts; `worker` and `web-design` references) against live source. The audit's four axes are scoped to `SKILL.md` content; a reference carrying its own stale claim would not have been caught. This is a named, accepted gap, and a reasonable follow-up card.
- **Did not measure** whether extraction actually reduces any session's token cost. See the Axis 3 caveat.
