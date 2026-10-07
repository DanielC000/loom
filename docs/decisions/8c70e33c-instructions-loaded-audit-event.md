# 8c70e33c — the `InstructionsLoaded` hook is wired as an `instructions_loaded` audit event, for every role, with a minimal payload

The installed `claude` CLI fires an `InstructionsLoaded` hook once per instruction file
(CLAUDE.md/AGENTS.md/rule) it actually loads — observability-only, the CLI's own doc says it "does not
support blocking". This is wired in `writeSessionSettings` (`pty/claude-settings.ts`) the same way every
other hook there is wired (unconditional, no matcher), dispatched in `PtyHost.deliverHook` (`pty/host.ts`),
and surfaced to `sessions/service.ts` via a new optional `PtyHostEvents.onInstructionsLoaded` callback,
which files the durable `instructions_loaded` orchestration event.

## Why this exists

A structural detection complement to the LOOM_HOME write-deny registries (cards `37310431`/`d332c969`),
useful specifically for the two coverage gaps those deliberately left open: the ancestor-directory walk,
and `~/.claude/CLAUDE.md` / `~/.claude/rules/**`. Even where write-deny can't reach (or the owner decides
not to extend it there), an actual LOAD of one of those files is now visible here rather than silent.

## Scope: every role, not platform-only

The motivating gap above is sharpest for the Platform Lead, but the Platform Lead is gated behind
`LOOM_DEV=1` (default OFF) and does not ship to regular `loomctl` users. A platform-only record would make
this feature dead for every shipped install. A worker, manager, or operator session loading a planted or
unexpected instruction file is the same audit question, so the durable event is filed for every role.
Wiring the hook itself was already role-blind (the settings-file hooks object has no role gating for any
of its unconditional entries), so this costs nothing extra to wire broadly — only the "what do we do with
the data" half needed a scope decision, and this is it.

## Payload: minimal, not the hook's full field set

The real installed CLI merges a common base-field set onto every hook, including this one:
`session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `served_call`,
`caller_session_id`, `effort`, plus `agent_id`/`agent_type` (set only for a subagent's own file access).
The durable event stores only `{ filePath, memoryType, loadReason, globs?, triggerFilePath?,
parentFilePath?, agentId?, agentType? }` — the question this event exists to answer ("what instruction
content did this session load") doesn't need `transcript_path`/`scratchpad_dir`/`cwd`/`prompt_id`/
`effort`, and none of those are stored or logged anywhere for this event. No new raw-path console log line
was added either — the existing bare `[hook] <sessionId> <event>` line (already unconditional for every
hook) is the only console-visible trace; the full paths live only in the durable, project-scoped event.

## Dedupe

`PtyHost.deliverHook` dedupes on `(file_path, memory_type, load_reason)` per `Live` incarnation
(`Live.instructionsLoadedKeys`, a `Set<string>`) BEFORE ever invoking `onInstructionsLoaded` — so a
`load_reason:"compact"` re-load (or any other re-load) of the same file under the same reason never files
a second row. The set's lifetime is exactly the `Live` object's own: a fresh spawn/resume/fork/recycle
always constructs a brand-new `Live`, so the dedupe set is implicitly cleared every time, never explicitly
reset.

## Filing identity

Filed under `managerSessionId: s?.parentSessionId ?? sessionId, workerSessionId: sessionId, taskId:
s?.taskId ?? null` — the same single-session filing convention already used by
`codex_unsupported_capability` and `claude_boot_dialog_resolved` (`SessionService.handleCodexUnsupported
Capability`/`handleClaudeBootDialogResolved`), since this event fires for any live session, not only a
worker/manager pair.

## Kind-list membership — explicitly decided, not left implicit

`instructions_loaded` is deliberately excluded from all four:

- **`EVENT_TRIGGER_EVENT_KINDS`** — loading an instruction file is routine session-boot behavior, not
  something a user automation should fire on.
- **`GATE_HISTORY_KINDS`** — unrelated to any gate run.
- **`ORCH_ACTIVITY_KINDS`** — not a lifecycle/orchestration-decision signal; same reasoning as
  `codex_auto_commit`'s own exclusion.
- **`REPORT_RESOLVED_EVENT_KINDS`** — nothing here is ever "resolved"; it's a one-shot record, not a
  paired stuck/resolved signal like `claude_boot_dialog_stuck`/`claude_boot_dialog_resolved`.

## Do not

- Do not widen the stored payload back to the hook's full field set (`transcript_path`/`cwd`/
  `scratchpad_dir`/`prompt_id`/`effort`) without a fresh card — this was a deliberate minimization, not an
  oversight.
- Do not add a raw-path console log line for this event — the durable event is the record; a console line
  would land in the shared, cross-tenant `daemon-output.log`.
- Do not gate the durable event write to `role === "platform"` — see the Scope section above; that would
  make the feature dead for every shipped (non-`LOOM_DEV`) install.
- Do not remove or weaken the `(file_path, memory_type, load_reason)` dedupe, and do not key it on
  anything broader than one `Live` incarnation — a session that resumes/forks/recycles gets a fresh `Live`
  and should be able to re-report a load it already reported in a prior incarnation.
- Do not add `instructions_loaded` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` without a fresh card — checked against all four for
  this card; none apply, per the reasoning above.
