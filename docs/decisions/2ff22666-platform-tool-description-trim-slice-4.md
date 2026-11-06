# Platform tool descriptions, slice 4: rule-preserving rewrite of eleven more tools

Card `2ff22666`. Follows slice 3 (`31d7f891-platform-tool-description-trim.md`), same method: rule-per-sentence rewrite, no guard text moved to a skill reference, no card or decision id in description text.

## What changed

- Rewrote the descriptions of `events_search`, `list_all_sessions`, `agent_update`, `question_pull`, `session_message`, `daemon_restart`, `project_memory_search`, `question_resolve`, `agent_clone`, `project_update` and `git_commit` in `mcp/platform.ts`.
- Reused the slice-3 `ID_PREFIX_DOC` constant in `events_search`, `list_all_sessions`, `agent_update` and `project_memory_search`, so the id-prefix rule reads the same on every platform tool.
- Shared text with the orchestration router: `events_search`, `agent_update`, `question_pull`, `question_resolve`, `project_update` and `daemon_restart` also exist in `mcp/orchestration.ts`, but each has its own hand-written description (only `EVENT_SEARCH_VALID_KINDS_LIST` is shared and was not touched). No orchestration text was edited, so nothing there can drift from this slice; the rules kept here are the same rules those tools state.
- `daemon_restart` carried two bare card ids in its text (dev-only tool, so the no-dogfood scan never reached it); both are removed.

## Measured result

Method as slice 3: build the real `PlatformMcpRouter` over an in-memory MCP client, read `tools/list`, sum `description` characters (throwaway script, not committed). The before baseline is current main (95,069), not slice 3's reported 95,020, because main moved after that measurement.

| surface | desc before | desc after |
|---|---|---|
| `LOOM_DEV=1` (60 tools) | 95,069 | 89,188 (-5,881, -6.2%) |
| `LOOM_DEV` unset (59 tools) | 92,856 | 87,507 (-5,349, -5.8%) |

Per tool (identical in both surfaces except `daemon_restart`, absent without `LOOM_DEV`): `events_search` 6,799 -> 6,141; `list_all_sessions` 3,325 -> 2,727; `agent_update` 2,798 -> 2,063; `question_pull` 2,492 -> 2,114; `session_message` 2,340 -> 1,735; `daemon_restart` 2,285 -> 1,753; `project_memory_search` 2,021 -> 1,720; `question_resolve` 2,023 -> 1,594; `agent_clone` 1,784 -> 990; `project_update` 1,748 -> 1,192; `git_commit` 1,578 -> 1,283. A before/after diff of every tool's description shows only these eleven changed.

## Phrase scan

Method as slice 3: rule tokens (backticked names, snake_case, camelCase, ALLCAPS, numbers, `{...}` shapes) taken from each BEFORE description and checked as substrings of the AFTER description. Scope: token presence only, not meaning. Tokens / missing: `events_search` 228/10, `list_all_sessions` 52/6, `agent_update` 47/8, `question_pull` 41/1, `session_message` 31/2, `daemon_restart` 27/4, `project_memory_search` 32/1, `question_resolve` 18/0, `agent_clone` 22/4, `project_update` 25/4, `git_commit` 23/3. Every missing token is listed below. "Carried by refusal text" says whether the daemon's own error text still tells the caller.

| tool | dropped text | kind | carried by refusal text |
|---|---|---|---|
| `events_search` | "mirrors project_get" (now the shared `ID_PREFIX_DOC` wording, which keeps the unknown/ambiguous `{error}` rule); "so a wrongly-empty result can't misread as 'this never occurred'"; "`loomSessionId` is the SAME Loom session id the `sessionId` filter matches on"; "same as tasks_list's `rowsFile` spill"; "an un-asked-for field is genuinely ABSENT"; "short-circuits before ... JOIN-enrichment"; "(UTF-8)"; "the Gates page's gate-only history read" | rationale / cross-reference / restatement | unrecognized kind is still stated as an explicit error naming the value; the field and spill shapes stay |
| `events_search` | KEPT: kind semantics, sessionId = manager OR worker, event field list, envelope + paging, effective-limit clamp warning, NDJSON spill shape and Read/grep paging, `fields` (unknown name ignored, `id` not auto-added), `countsOnly` shape, global-scoped kinds invisible to a `projectId` filter | rules no error announces | n/a |
| `list_all_sessions` | "mirrors list_sessions' contract"; "mirrors project_get"; "EXPLICIT error, never a silent []" (now `ID_PREFIX_DOC`); "NOT" emphasis | cross-reference / emphasis | yes: unknown/ambiguous id returns `{error}` |
| `list_all_sessions` | KEPT: scope/state semantics, the under-count warning for aliasing questions and the `worktreePathAliases` pointer, summary field list, `lastEngineOutputAt` claude-only/null rule, `turnSeq:0` is not a wedge verdict, never compare `turnSeq` to `ctxTurns`, bare-array vs envelope pagination | rules no error announces | n/a |
| `agent_update` | "REUSED from the human REST POST /api/agents/:id (agents/validate.ts)"; "exactly like the REST path"; 404 / ambiguous-prefix restatement; "NOTE"; "WITHOUT" emphasis; "(see agentAssignableProfileError in profiles/validate.ts)"; "EXCEPT" (the rebind refusal is kept as its own sentence) | implementation reference / restatement | yes: unknown agent, ambiguous prefix, profile-not-found, replace-not-exactly-once and multi-mode rejections all return `{error}` |
| `agent_update` | KEPT: PATCH semantics, `profileId:null` clears, three mutually exclusive startupPrompt modes and the exactly-once `old` rule, edits apply to the next session, endpoint/ioSchema not settable, elevated-role assignment rules, `rebindReach` relay-to-human, the rebind-with-grant refusal, spill shape | rules (several are not announced until the call fails) | n/a |
| `question_pull` | "YOU" emphasis only | emphasis | n/a (every shape, advisory-`lapsed`, fulfillment-state and `remaining` rule kept) |
| `session_message` | "HONEST" emphasis; "same resolution as session_transcript" | emphasis / cross-reference | yes: an unknown/ambiguous/too-short id returns `{error}` (still stated) |
| `session_message` | KEPT: deliveryStatus meanings, `delivered-live` is not a terminal guarantee, successor routing / boarding with `taskId`, `replacedBy` disclosure, tag applied for you, deliver-once `duplicate:true`, delivery only, id-prefix length | rules no error announces | n/a |
| `daemon_restart` | "83718377" and "2e84a250" card ids (also "Card" wording); "ONCE"; "DIFFERENT" emphasis; "SAME" emphasis; "(per /platform-lead's safety posture)"; "a cross-project, platform-level action that's naturally yours to own" | card ids (forbidden in description text) / rationale | n/a |
| `daemon_restart` | KEPT: confirm via `question_ask` first, blast radius, build-first fail-closed, fleet auto-resume, `{restarting:true\|false, error}`, live-process-table supervisor check and the retry-vs-ask-a-human split, `supervisorChanged` vs `supervisorCheckFailed` (unknown, never clean), resume nudge is the reliable read | rules | n/a |
| `project_memory_search` | "mirrors project_get" (now `ID_PREFIX_DOC`); "a HIGH-circulation note ... turns a wrong note into live doctrine"; "ordering is a convenience, not a substitute for reading the full returned set"; "a project's store is its own to curate" | rationale | yes: unknown/ambiguous project returns `{error}` |
| `project_memory_search` | KEPT: literal substring, read-only (no cross-project write), `retrievalCount` ordering + `truncated`/`totalMatches`, `asOf`, the `retrievalCountCaveat` blind spot (0 is not harmless), hit shape | rules | n/a |
| `question_resolve` | "This is what lets you resolve your OWN question without reopening the human-only answer boundary"; "nothing to attest"; "the owner's reply stands alone as the note either way"; "unlike the REST inbox answer path (which captures ... structurally)" | rationale | yes: no owner turn / raced reply / not yours / not pending / credential are refused with the reason |
| `question_resolve` | KEPT: note is server-captured owner text, `chosenOption` rules per type, prefer over ask-then-cancel, chat-resolved permission has null scope/expiry and the scope lives only in `note`, return shape | rules (the permission null-scope contract is not announced anywhere) | n/a |
| `agent_clone` | "createAgentCore" and "no forked create path"; "(clone stays stricter by design)"; "404 ('source agent not found')" and "'project not found'" restatement; "'profile not found' is impossible here"; "see agentAssignableProfileError"; the "SAME validated core" capitalisation | implementation names / restatement / rationale | yes: `source agent not found`, `project not found` and the field/role refusals are returned as `{error}` |
| `agent_clone` | KEPT: nameOverride / promptPatch REPLACES (not a diff) semantics, the three refusals (elevated source role, human-only profile field, locked role into a non-reserved project) and that clone is stricter than direct assign | rules | n/a |
| `project_update` | "DELIBERATELY, as a least-privilege trust-boundary choice ... even though every runtime lookup ... survives a rename via the stable id marker"; "rejected otherwise, exactly like project_create"; "same exfil-adjacent trust class as repoPath/gateCommand"; "404 if the project is unknown"; "Config changes go through project_configure" kept as a pointer | rationale / restatement | yes: unknown project, non-git repoPath and reserved-name refusals return `{error}`; the human-REST-only fact is kept |
| `project_update` | KEPT: reserved-project name refusal (and that vaultPath/repoPath/config stay allowed), repoPath rebind rules and the live-session refusal, repoPath only editable here, `referenceRepos`/`repos` not settable, `staleStartupPrompts` is WARN-only, sessionEnv masking and masked-value-rejected | rules | n/a |
| `git_commit` | "Explicit projectId" (schema-required); "`git add`" wording for an out-of-band stage; "(multi-repo epic)"; "404 if the project is unknown"; "an escaped descendant's residue from an earlier quarantine" example | schema restatement / example / restatement | yes: unknown project returns `{error}` |
| `git_commit` | KEPT: `paths` scoping, no -c / no Co-Authored-By, the pending-merge guard with its full refusal shape and `acknowledgePendingMerge`, `repoKey` ("primary", unknown key rejected, never falls back), clean tree is an expected failure, `residue` meaning | rules | n/a |

## Verification

All of these passed (exit 0, 0 FAIL lines): `agent-prompt-lint-surface-drift`, `agent-prompt-lint`, `surface-subset`, `audit-surface`, `mgmt-surface`, `operator-surface`, `setup-surface`, `user-audit-surface`, `platform-elevated-surface`, `platform-mgmt-surface`, `my-context-gate`, `platform-agent-update`, `role-surface-tools-named-in-doctrine`, `platform-end-user-no-dogfood`, `project-configure-description-drift`; extra description/tool-adjacent tests: `platform-agent-clone`, `platform-pending-merge-warning`, `mcp-list-budget`, `agent-id-prefix`, `platform-setup-unbounded-list-spill`, `requests-typed-object`, `session-list-summary`; the six source scanners from CLAUDE.md's ungated-landing list; `pnpm --filter @loom/daemon guards` (35 guards); `pnpm build`.

Not covered: no negative control was run for the token scan beyond slice 3's own proof that the method can fail; the scan proves token presence, not that the model behaves the same.

## Do not

- Do not cite a card or decision id in agent-facing description text; `daemon_restart` was the last known offender and it is dev-only, so the no-dogfood scan could not see it.
- Do not move guard text out of a description into a skill reference.
- Do not edit the orchestration router's twin descriptions to "match" a trimmed platform one without keeping every rule; they are hand-written separately and a rule dropped there is a rule the manager can no longer learn.
