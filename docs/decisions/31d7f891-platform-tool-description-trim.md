# Platform tool descriptions, slice 3: shared constants + rule-preserving rewrite of nine tools

Card `31d7f891`. Follows slice 2, which trimmed four search/list tools and cut `mcp/platform.ts` by only 2.5%.

## What changed

- Three shared constants in `mcp/platform.ts`, interpolated verbatim: `ID_PREFIX_DOC` (full id or unambiguous 8-char prefix, `{error}` naming candidates), `TASK_BATCH_RESULTS_DOC` (per-id result contract + NDJSON spill pointer of the `taskIds` batch tools) and `TASK_MERGED_DOC` (what `merged`, `merged.verification` and `mergedVerificationAtMerge` mean). Used by `project_task_get`, `project_task_update`, `project_task_create`, `list_all_tasks` and `project_configure`.
- `tasks/relations.ts`: `TASK_STRUCTURE_DOC` (the UPDATE tools' text, shared with the in-project `tasks_update`) no longer appends the `released:true` note a second time. Its own "leave out any blockedBy/blocks item marked `released:true`" sentence already states the rule, so `tasks_update` and `project_task_update` still say it once.
- Rule-per-sentence rewrite of nine tools: `project_task_update`, `project_configure`, `resume_doc_check`, `session_transcript`, `question_ask`, `project_task_create`, `project_task_get`, `list_all_tasks`, `profile_update`. Only rationale and restatements of a refusal that announces itself were dropped. A rule no error announces (response shapes, the spill pointer, "`version` advances ONLY when title/body change", `released:true` is history, `sessionEnvKeys` is not settable, transcript untrusted-data and no-spill, `question_ask` type semantics) was kept.
- Not done: no skill reference (guard text stays in the descriptions where the model reads it) and no edit to the `Settable top-level keys:` clause that `project-configure-description-drift.mjs` parses.

## Measured result

Measured by building the real `PlatformMcpRouter` over an in-memory MCP client and reading `tools/list` (throwaway script, not committed). "desc" is the sum of `description` characters; "full" is `JSON.stringify` of every tool entry.

| surface | desc before | desc after | full before | full after |
|---|---|---|---|---|
| `LOOM_DEV=1` (60 tools) | 99,936 | 95,020 (-4,916, -4.9%) | 122,924 | 117,996 (-4,928) |
| `LOOM_DEV` unset (59 tools) | 97,723 | 92,807 (-4,916, -5.0%) | 120,452 | 115,524 (-4,928) |

Per tool (identical in both surfaces): `project_task_get` 3,239 -> 2,208; `project_configure` 5,021 -> 4,073; `session_transcript` 3,440 -> 2,716; `profile_update` 3,118 -> 2,449; `project_task_create` 4,199 -> 3,605; `project_task_update` 7,030 -> 6,479; `resume_doc_check` 4,370 -> 4,216; `question_ask` 3,591 -> 3,390; `list_all_tasks` 3,147 -> 3,103. **Measured result: -4.9% (`LOOM_DEV=1` description chars), against a projected 12-15%.** The real figure is about 5% because what remains is mostly rules and response shapes no refusal announces. The roughly 35% goal is not reachable in this slice.

## Phrase scan

Scan method: from each tool's BEFORE description (rendered, `LOOM_DEV=1`) extract rule tokens (backticked names, `key:value` shapes, ALLCAPS words, camelCase keys, numbers, `{...}` shapes, snake_case names) and check each is a substring of the AFTER description. Scope: token PRESENCE per tool, not meaning. The scan proved it can fail: it flagged a real unintended drop ("CLEARS" in `project_task_update`), which was then restored. The counts above were re-run against the committed text (the first run predated that restore and read 97/1 for `project_task_update`). Token counts / missing: `project_task_update` 97/0, `project_configure` 73/2, `resume_doc_check` 61/0, `session_transcript` 48/3, `question_ask` 57/3, `project_task_create` 54/3, `project_task_get` 45/16, `list_all_tasks` 57/4, `profile_update` 31/1.

The "carried by refusal text" column says whether the daemon's own error text still tells the caller the rule. `n/a` means the dropped words were rationale or cross-reference, not a rule.

| tool | dropped text | kind | carried by refusal text |
|---|---|---|---|
| `project_task_update` | "CLEARS" (rewording; restored: "held:false CLEARS it, but clearing an owner-set hold is REFUSED") | none dropped after fix | n/a |
| `project_task_update` | "It is a plain comparison against the task's `version`, and the error text says whether it was omitted or stale" | restates a refusal | yes: the omitted-baseVersion error names it (`mcp/tasks.ts`, "this write omitted baseVersion, which is REQUIRED on every title/body write") and the conflict error carries `conflict:true, current` |
| `project_task_update` | "Same backing path as the in-project tasks_update", "(naming the candidates)" wording, "the fix for an audit wave's...", repeated "nothing written" | rationale/duplication | n/a |
| `project_task_update` | second `released:true` sentence (relations.ts) | duplicate of the preceding sentence | n/a (rule still stated once) |
| `project_configure` | "project_get" cross-reference | cross-reference | n/a |
| `project_configure` | "UNLIKE gateCommand's non-clearable guard (which still lets you CHANGE it...)" reasoning, "the categorical permission.mode rejection above applies regardless of whether the value matches", "so there is no payload shape through which replace:true can succeed" | rationale | yes: the refusal names the stored mode |
| `project_configure` | "a deliberate decision, not an oversight to close — because this whole route is Lead-only and human-driven"; "host-exec/host-launch ... arbitrary interpreter/executable" | rationale | n/a |
| `project_configure` | "so you can confirm a length without ever seeing anything value-shaped"; "never a silent write" | rationale | yes: invalid-config error on feeding `sessionEnvKeys` back |
| `resume_doc_check` | "(mirrors rotation-gate.mjs --rules)"; "so it can't check the wrong file"; "so the section can move out of the rotating doc"; "the transient residue of a mid-migration doc"; "'inspect these'" | rationale/cross-reference | n/a |
| `session_transcript` | `browser_snapshot` example; "NOT"; "ALWAYS-ON" | example/emphasis | n/a |
| `session_transcript` | "that would reopen a cross-session read of content this tool's own gates exist to protect" | rationale (rule "NEVER spilled... trimmed, never redirected" kept) | n/a |
| `session_transcript` | A/B-trial-style example; "covers the whole transcript, no gaps/overlaps" detail; rotation caveat's "most likely an internal auto-compact restarting its own bookkeeping" mechanism | rationale | n/a (caveat itself kept) |
| `question_ask` | "repoPath"/"vaultPath", "ARE" (the "so you cannot attach secret.key/loom.db even where..." parenthetical); "kind/size/dimensions/availability are derived server-side"; "cancelled ... with a reason linking this ask" | rationale/derived-field detail | yes: attachments outside the allowed roots or under LOOM_HOME are refused, and the rule that refusal path is kept |
| `project_task_create` | "createProjectTaskChecked"; "(mirrors project_get)"; "relatedTo:\"<taskId>\" ... (no prose on either card)" lead-in | implementation name/cross-reference; `relatedTo` is still named by the shared structure doc | n/a |
| `project_task_create` | "a card claiming to resolve an escalation it isn't actually linked to would be worse than no link at all"; "Missed this at create time..." | rationale | yes: unknown/ambiguous/out-of-scope escalation id rejected, nothing written |
| `project_task_get` | `tasks_list`, `project_task_get`, `agent_clone_batch`, FRESH/ALSO/ONCE/DISAGREE/NEVER/DOES, EXACTLY/INDEPENDENTLY/BYTE-IDENTICAL/AGGREGATE, `{taskId,task\|error}`, UTF-8 | cross-references/emphasis/format detail; `{taskId, task}` / `{taskId, error}` and the spill pointer shape kept in the shared batch constant | n/a |
| `project_task_get` | "backfills lazily only via the web board drawer (human-triggered, not agent-facing)"; "freshly-landed batch branch DOES stamp pathset/trailer-only eagerly" | rationale | n/a |
| `project_task_get` | "never assume one is simply more current than the other without checking which you actually need" | advice | n/a (disagreement is still stated as legitimate, not a bug) |
| `list_all_tasks` | EXPLICIT, WHICH, NEVER (emphasis); `orchestration.commitTrailers:"off"` in the `ledger` example | emphasis/example (the `commitTrailers:"off"` rule survives in the `mergedVerificationAtMerge:null` sentence) | n/a |
| `profile_update` | "POST" (`/api/agents/:id` pointer) | cross-reference | n/a |
| `profile_update` | "an explicit subset bypasses the locked-role skill-trust filter"; the enumerated meaning of vaultWrite/harness/browserTesting/documentConversion/allowDelta; "carrying e.g. browserTesting onto a role nobody reviewed it for (a QA-Tester-shaped rig to assistant)"; "a profile is shared across projects, so this can strand an agent you never directly touched"; "the profile's own fields can be grant-free while a bound agent still carries one" | rationale | yes: each rejection's error names the offending keys / agents |

## Do not

- Do not cite a card or decision id in agent-facing description text; the no-dogfood test scans for it.
- Do not move guard text out of a description into a skill reference: `references/**` is read on demand, and nothing makes the agent open it before calling the tool.
- Do not shorten a shared constant for one tool's benefit; it is interpolated into several tools and must say the same rule everywhere.
- Do not read this scan as a behaviour check: it proves token presence only, not that the model acts the same.
