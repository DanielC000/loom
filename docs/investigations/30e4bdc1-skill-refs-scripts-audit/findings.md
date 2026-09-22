# 30e4bdc1 — audit of the shipped skills' `references/**` and `scripts/**` payloads against live source

Card `30e4bdc1`, child of `a6d885e6` (merged `7583a37f`). The parent audit checked every `SKILL.md`
across the four axes (staleness / overlap / bloat / leakage) and explicitly named its own gap: it never
verified the `references/**`/`scripts/**` payloads against live source. This card closes that gap. **This
is an audit; no skill, reference, or script file was changed.** The only file this card commits is this
record. Every finding is cited at `file:line` and was verified against live source at audit time
(2026-09-22).

## Scope re-derived at source (do not inherit the parent's figures — DoD-6)

`DEV_ONLY_SKILLS` re-read live at `scripts/curate-release-skills.mjs:22` — still exactly four
(`platform-lead`, `platform-audit`, `codescape`, `research`). Of the 14 bundled skill dirs, **10 ship**:
`ideate`, `loom-doc-hygiene`, `loom-pickup`, `loom-session-end`, `loom-task-start`, `orchestrate`,
`setup-assistant`, `web-design`, `worker`, `workspace-audit`.

**Which of the 10 shipped skills actually carry a `references/**` or `scripts/**` payload** (the other
six have `SKILL.md` only, confirmed by directory listing):

| skill | references/ | scripts/ |
|---|---:|---:|
| `orchestrate` | 4 files, 20,640 B | 2 files, 43,414 B |
| `web-design` | 7 files, 28,723 B | 1 file, 12,392 B |
| `worker` | 3 files, 16,470 B | — |

None of the four `DEV_ONLY_SKILLS` carry a `references/` or `scripts/` dir (`codescape` has a top-level
`prompt-block.md`, not under either prefix, and is out of scope both by directory and by the
private-product exclusion). So the full audited surface is exactly these three skills' 14 files — nothing
was sampled or skipped within that set.

**Note on the parent's cited byte figures**: the parent recorded `orchestrate` references at 19,597 B.
Live measurement today is 20,640 B — not stale doc, but real content growth: `orchestrate/references/
resume-doc-rotation.md` was extended by 12 lines in commit `cc370967` (2026-09-22, teaching the new
live-commitments marker), landing on `main` after the parent's snapshot. Re-derived, not inherited, per
the card's own instruction.

---

# Findings

## MAJOR

### M1 — `issue` (blocking, visible hang) — `web-design/SKILL.md` documents the shared `serve-static.mjs` helper with the wrong subcommand, causing it to run in **blocking foreground mode** instead of the tracked-pid detached mode

`web-design/SKILL.md:169` (inside "Iterate by eye", step 1):

> Serve its directory over loopback with the bundled helper and open the printed URL instead: `node
> .claude/skills/web-design/scripts/serve-static.mjs <dir>`.

This omits the `start` subcommand. The script's own header (`web-design/scripts/serve-static.mjs:8-14`,
byte-identical to `orchestrate/scripts/serve-static.mjs`) states the three call shapes explicitly:

```
node serve-static.mjs [dir] [port]
  Foreground mode (unchanged): serves <dir> ... and blocks in this process until Ctrl-C / SIGTERM
  or LOOM_SERVE_STATIC_TIMEOUT_MS elapses (default 30 minutes).
node serve-static.mjs start <dir> [port]
  Spawns the server for <dir>, DETACHED so it outlives this launcher process, and prints: ...
node serve-static.mjs stop <dir>
```

The dispatch at the bottom of the file confirms it mechanically (`serve-static.mjs:256-263`): only
`a2 === "start"` and `a2 === "stop"` take the tracked-pid branches; anything else — including a bare
`<dir>` with no subcommand — falls through to `serve(a2, a3, ...)`, the **foreground, blocking** server.

**Concrete failure.** A worker following `web-design/SKILL.md:169` literally runs the foreground form. If
invoked as a normal (non-backgrounded) shell call, the command does not return until Ctrl-C/SIGTERM or the
30-minute timeout — this is exactly the "Never let a shell command hang your turn" failure class the
worker doctrine names as catastrophic (a blocked turn never ends, the session wedges at `busy`, and the
report sits undelivered). Even if a worker instead reaches for its harness's own background-shell
mechanism (not what the skill says to do), there is still no `start`/`stop` pairing documented anywhere in
`web-design/SKILL.md` — no printed tracked pid, no stop instruction — so the cleanup discipline this
project's doctrine treats as non-negotiable (`worker_merge_confirm`'s `git worktree remove` fails on
Windows if a dev/static server still holds the worktree open) has nothing to hook onto for this specific
artifact.

By contrast, `orchestrate/references/serving-and-capture.md:14-21` documents the same shared script
correctly: `start <dir>` (returns immediately, prints the tracked pid) then `stop <dir>` before requesting
a merge.

**Positive control.** The `start`-form invocation is real and reachable: `orchestrate/SKILL.md` does not
itself embed the invocation (it defers to the reference, which is correct), and `worker/references/
dev-server-verification.md:89` uses the equivalent `start ... -- <command>`/`stop` pair for the sibling
`dev-server.mjs` helper correctly. So the `start`/`stop` contract is the one genuinely taught elsewhere in
the shipped corpus — `web-design/SKILL.md:169` is the one site that dropped it.

**Direction (for the child card, not landed here).** Change `web-design/SKILL.md:169` to `node
.claude/skills/web-design/scripts/serve-static.mjs start <dir>`, and add the matching `stop <dir>` step
(mirroring `orchestrate/references/serving-and-capture.md`'s wording) so the artifact server is torn down
before a merge is requested, same as the dev-server helper already requires elsewhere in this skill's own
pre-ship checklist. Scoped strictly to `web-design/SKILL.md`, not the shared script (which is correct and
shared verbatim with `orchestrate`).

### M2 — `issue` (non-blocking but load-bearing) — `orchestrate/references/project-memory.md` teaches the `memory_write` tool's ORIGINAL 2026-07-15 param shape; three params added since are absent, while its sibling copy in `worker/` was updated for two of them

`orchestrate/references/project-memory.md:8-9` states, as an exhaustive claim:

> Its exact params are **`key`**, **`text`**, and optional **`title`** — these `memory_*` tools are
> DEFERRED...

The live tool's actual schema (confirmed against the loaded `mcp__loom-tasks__memory_write` definition,
and against `packages/daemon/src/mcp/memory.ts:56-83`) is: `key` (required), `text`, `title`, `pinned`,
`tags`, `requestIds`, `triggerGlob`, `baseVersion`. Three of those — `tags`, `requestIds`,
`triggerGlob` — are entirely absent from this file's "exact params" sentence and from the rest of its
prose; `pinned` and `baseVersion` are each covered later, but only in prose, never restated as part of the
"exact params" claim.

**This is not merely undercounted — it is stale relative to a SIBLING copy of the same reference that was
correctly updated and this one was not.** `worker/references/project-memory.md` documents the identical
topic ("project memory — mechanics & discipline") and was revised in commit `4148dfce` (2026-07-24, "annotate
a note's linked-request live state at recall") to add `tags` and `requestIds` to its own "exact params"
list, plus a dedicated "Linking a note to a Request (`requestIds`)" section. `orchestrate/references/
project-memory.md` has had exactly one commit ever (`f1b11cd3`, 2026-07-22, the original split) and was
never touched again — confirmed via `git log --follow` on the file. `requestIds` landed in the tool
itself at `e9cc9c2d`/`4148dfce` (2026-08-05/2026-07-24) — after the orchestrate copy was written, and the
SAME commit updated the worker copy but not this one.

**Why this matters beyond a param-list nit.** `requestIds` is the mechanism `CLAUDE.md`'s own worker brief
calls load-bearing: "A note that touches an owner gate ... must record the REQUEST ID + its STATE ... Also
pass that same id via `memory_write`'s `requestIds` param" — a manager reading only `orchestrate/
references/project-memory.md` (its own reference, injected specifically for this mechanics topic) would
never learn this param exists at all.

**Positive control.** `requestIds`, `tags`, `pinned`, `triggerGlob`, `baseVersion` are all present as real
top-level properties on the tool schema this session loaded for `mcp__loom-tasks__memory_write`, and
`tags`/`requestIds` are demonstrably taught correctly in the sibling `worker/references/project-memory.md`
— so the omission in the orchestrate copy is a genuine drift, not an artifact of a broken read.

### M3 — `issue` (non-blocking) — BOTH `project-memory.md` copies (orchestrate and worker) omit `triggerGlob`, the newest `memory_write` param (card `aeec1880`, landed 2026-09-09)

`triggerGlob` — an optional path-glob predicate gating a `pinned:true` note's delivery to a kickoff whose
text names a matching path (`packages/daemon/src/mcp/memory.ts:73-82`) — landed after BOTH reference
copies were last edited (worker's most recent touch was `4148dfce`, 2026-07-24; orchestrate's only touch
was `f1b11cd3`, 2026-07-22; `triggerGlob` landed `fb512c40`, 2026-09-09). Neither copy mentions it. Lower
severity than M2 because `triggerGlob` is optional and additive (omitting it from a note write is always
valid), but it means neither reference is a complete account of "exact params" as both claim to be.

## MINOR

### m1 — `orchestrate/references/project-memory.md` never mentions the `pinned && "never-drop"` sub-tier or its lower byte cap

`packages/daemon/src/mcp/memory.ts:34` (`MAX_NEVER_DROP_TEXT_BYTES`, a stricter cap than the general
`MAX_TEXT_BYTES = 4000` the reference correctly cites) and the `"never-drop"` tag mechanism are undocumented
in either `project-memory.md` copy. Minor because it's an advanced/rare case (the mechanism exists
specifically for the small number of always-critical pinned notes a project accrues), not a param a normal
write needs — but it's the same root cause as M2/M3: neither reference has been revisited since the tool
grew capability past its original 2026-07 shape.

---

# Verified clean — checked and came back accurate (recorded so nobody re-derives these)

- **`orchestrate/references/resume-doc-rotation.md`** — every claim about the `resume_doc_check` tool
  (`rotationMarkers`, `rotationLiveCommitmentsHeading`/`Floor`/`Marker`, `rulesPath`/`rulesPaths`,
  `archiveCheck`/`byteCheck`/`rulesCheck`, `markerSources`, `markerAmbiguous`/`markerOccurrences`/
  `markerAmbiguityWarning`, `rulesUnreadableWarning`) verified against `packages/daemon/src/mcp/
  orchestration.ts:4631-4767` — all present, all match. Freshly updated in `cc370967` (2026-09-22),
  consistent with source as of that commit.
- **`orchestrate/references/live-verification.md`** — generic doctrine (run/tool-IO, subprocess/spawn
  failure shapes), no claims tied to a specific tool/field/path — nothing to verify against source, and
  nothing stale by construction.
- **`orchestrate/scripts/dev-server.mjs`** and **`orchestrate/references/serving-and-capture.md`** — the
  reference's description of `start <dir> -- <command>`/`stop <dir>`, the recorded `{pid, command, dir,
  logFile, port, host, url}` tracking fields, `portDetectionFailed`/`detectionEndedAt` semantics, and the
  "never rebuild the URL from a bare port" warning all match the script's own implementation
  (`dev-server.mjs:20-49, 396-422`) line for line.
- **`orchestrate/scripts/serve-static.mjs`** — verified byte-identical to `web-design/scripts/
  serve-static.mjs` (`diff`, zero output), so both copies were checked once. Its `start`/`stop` contract
  and printed output match `orchestrate/references/serving-and-capture.md`'s description exactly (see M1
  above for where a CALLER of this same, correct script gets the invocation wrong).
- **`worker/references/dev-server-verification.md`** — every claim about the `dev-server.mjs` tracked-pid
  helper, the process-identity-by-worktree-path discipline, and the Windows cwd-unreadability caveat
  matches the script and is internally consistent with `orchestrate/references/serving-and-capture.md`
  (same underlying mechanism, independently phrased, no contradiction).
- **`worker/references/browser-verification.md`** — `browser_click`'s param shape (`element` optional,
  `target` required — NOT `ref`) verified directly against the installed `@playwright/mcp@0.0.75` package
  (`node_modules/.pnpm/@playwright+mcp@0.0.75/.../README.md:825-834`, generated from the package's own tool
  schema) — matches exactly.
- **`worker/references/project-memory.md`** — largely accurate (see M2/M3 for the two specific gaps); the
  `≤4000 bytes` cap, the read-first/`baseVersion` update-gate mechanics, and the `requestIds` live-annotation
  description are all correct against `packages/daemon/src/mcp/memory.ts`.
- **`web-design/references/*.md`** (`anti-patterns.md`, `color.md`, `interaction.md`, `layout-spacing.md`,
  `motion.md`, `typography.md`, `ux-writing.md`) — 6 of these 7 files carry **zero** references to any
  Loom tool name, MCP surface, env var, or script (`grep -ln "mcp__\|LOOM_\|\.mjs\|worker_\|tasks_\|
  memory_\|browser_\|page\.\|@playwright" *.md` → no matches). **Positive-controlled**: the identical
  pattern against `worker/references/dev-server-verification.md` returns 3 hits, confirming the pattern
  itself discriminates and the zero above is a real absence, not a broken grep. These 7 files are generic
  visual-design doctrine (typography scales, color theory, motion timing, copy rules) with no claim tied to
  this project's own source — there is nothing in them that live source could make stale. `anti-patterns.md`
  is the one exception with tool-adjacent content but even it names no tool/param, only design heuristics.

---

# Proposed child cards

Two, ordered by severity. **I filed neither — the lead boards them.**

**Constraint binding both.** `packages/daemon/assets/skills/**` is pinned `text eol=lf`
(`.gitattributes:12`) — pass condition `CR == 0`, not tree-default `CR == LF`. Verify with `git
check-attr text eol -- <path>` before comparing byte counts, same as the parent card's own six proposals.

**Second constraint binding both.** A merged `assets/skills/**` change is not live until a daemon restart
re-seeds the store, and then only for a `customized:false` (pristine) skill copy.

### Child card A — `fix(assets): correct web-design's serve-static invocation to the tracked start/stop form`

Closes **M1**.

**Changes.** `web-design/SKILL.md:169` only. Replace the bare `node .../serve-static.mjs <dir>` call with
`start <dir>`, and add the matching `stop <dir>` step before/alongside the existing pre-ship checklist
(mirror `orchestrate/references/serving-and-capture.md`'s wording, which already gets this right for the
same script).

**DoD.** `web-design/SKILL.md` no longer contains a bare (non-`start`/`stop`) invocation of
`serve-static.mjs`. A worker following the step literally never blocks its own turn. `CR == 0`.

### Child card B — `docs(assets): bring orchestrate's project-memory reference up to the live memory_write contract, and add triggerGlob to both copies`

Closes **M2** and **M3** (folds in **m1** if the manager wants one pass rather than two).

**Changes.** `orchestrate/references/project-memory.md` — add `tags`, `requestIds`, and (in both this file
and `worker/references/project-memory.md`) `triggerGlob` to the documented param set; port the "Linking a
note to a Request" section (or an equivalent pointer) so the orchestrate copy isn't a strictly worse
version of its own sibling. Optionally note the `pinned && "never-drop"` lower byte cap in both (m1).

**DoD.** Both `project-memory.md` copies list every current `memory_write` param (`key`, `text`, `title`,
`pinned`, `tags`, `requestIds`, `triggerGlob`, `baseVersion`) either in the "exact params" enumeration or
in an immediately-adjacent explanatory clause. Verified against the live tool schema, not against this
record. `CR == 0` on both files.

---

# What this audit did not do

- **Did not verify claims in the 6 purely-generic `web-design/references/*.md` files beyond confirming
  (via a positive-controlled grep) that they contain no Loom-tool-specific claim to verify** — see
  "Verified clean" above. Their content is external design doctrine, not sourced from this repo's code.
- **Did not re-check the four `DEV_ONLY_SKILLS`** (`platform-lead`, `platform-audit`, `codescape`,
  `research`) — confirmed by directory listing that none carries a `references/**` or `scripts/**` payload
  (only `codescape` has a non-references/scripts top-level file, `prompt-block.md`, which is both out of
  this card's declared scope and a private-product surface per project memory). Nothing was skipped within
  scope; this is a scope boundary, not a gap.
- **Did not land any fix.** Per the card's own DoD point 5, this record proposes two child cards; neither
  was filed or edited under this card.
- **Did not re-verify the parent audit's own six CRITICAL/MAJOR findings** (resume-doc path
  reconstruction, `merge_batch` nudge vocabulary, the leaked web routes, the unconditional push step, the
  stale `worker_spawn` model, the two-lane concurrency figure) — those are `SKILL.md` content, the parent
  card's own domain, not `references/**`/`scripts/**`. One of them (`worker_spawn`'s cap-rejection
  behavior) is orthogonal to anything reviewed here.
- **Did not measure whether any of this audit's findings affect token/context cost** — same caveat the
  parent audit recorded for its own axis-3 work; not this card's question.
