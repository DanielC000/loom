# 66ff7321 — detect a context-exhausted session by TICK, never by hook

## Background

Worker 09e8c9f1 (and separately, gen 455's quarantine worker) hit the Claude Code CLI's own
"Prompt is too long" rejection mid-turn. The session's context was exhausted, but Loom kept showing
`busy:true` forever — no event, no notice, no recovery — until the owner caught it by hand.

## The real terminal record (verified against the actual specimen)

Resolved from worker 09e8c9f1's own engine transcript (session `09e8c9f1-32b1-4f61-ade3-bd3c05760a83`,
2026-11-02) without opening the real `~/.loom` DB: `git log --all --grep` matched the task's own commit
message to branch `loom/a7cdbbd22c95`, which gave the worktree path, which gave the real-homedir
transcript path via the documented encoding convention. The terminal line is a `type:"assistant"` JSONL
record:

```json
{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence",
"stop_sequence":"","usage":{...all zero...},"content":[{"type":"text","text":"Prompt is too long"}]},
"error":"invalid_request","isApiErrorMessage":true,"session_id":"...","cwd":"...","gitBranch":"loom/..."}
```

followed immediately (and finally) by a `turn_duration` system record, a `last-prompt` record, and a
`cost-state` record — then nothing. That is the terminal write.

## Why tick-detected, never hook-delivered

Empirically verified from `daemon-output.log`'s own `[busy]` transition log for session 09e8c9f1: the
turn's rising edge (`[busy] ... -> true (user-prompt-submit-hook)`) has **no matching falling edge** —
every prior turn in the same session got a `(stop-hook)` falling edge shortly after; this one never did.
`grep -c "StopFailure"` for the session returns 0. The session sat `busy` for ~46 minutes (two
`[busy-worker-watcher]` long-turn advisories fired, informational only, no ctx%) until a `pty-reap
trigger=hard-stop` (a manual/owner stop) ended it.

So `PtyHost.deliverHook` — the dispatcher that already houses `detectUsageLimit`/
`isWeeklyUsageLimitSentinel` for the analogous StopFailure/rate-limit case — is structurally unreachable
for this failure. Detection has to live in a TICKING watcher: `BusyWorkerWatcher.tick()` for workers,
`ContextWatcher.tick()` for managers/platform.

## Do not

- Do not widen the detection predicate to "any `isApiErrorMessage:true` record" — every OTHER api-error
  class (rate-limit, billing, overloaded, …) is a DIFFERENT condition, already has or may need its own
  handling, and must never be read as context exhaustion. Key on
  `CONTEXT_EXHAUSTION_TEXT_PATTERNS` (`pty/claude-transcript.ts`) — a small, named, growable allowlist —
  not the bare `isApiErrorMessage` flag.
- Do not treat a match as exhaustion unless it is also the LATEST `type:"assistant"` record in the
  scanned tail — a later real-model assistant record means the session recovered.
- Do not construct a `~/.claude/projects/...` literal path, or encode a Claude JSONL wire-format
  assumption, anywhere outside `pty/claude-transcript.ts` — see decision `2b099e48`. The bounded
  tail-reader (`orchestration/context-exhaustion.ts`) calls `detectContextExhaustionInTail` there; it
  never re-implements the shape itself.
- Do not let `drainPending`/`enqueueStdin`'s immediate-delivery path (`idleEligible`) ignore
  `live.contextExhausted` — `busy` reads `false` the instant exhaustion is marked (the same falling-edge
  call `markContextExhausted` uses), so without this gate a queued message (or the periodic
  `reconcile()` safety net) would drain straight into the dead turn.
- Do not gate `worker_context_exhausted`'s durable event/notice on anything looser than the owning
  manager being LIVE (mirrors `worker_stuck`'s own gate) — the DB stamp (`contextExhaustedAt`/
  `lastError`) still always happens regardless, since exhaustion is a fact about the worker, not about
  who's listening.
- Do not invent a new push channel for the manager/platform twin
  (`manager_context_exhausted`) — route it through the SAME `companion/attention-push.ts` `classify()`
  class (`"context-overflow"`) its `context_escalated`/`context_blind_turn` siblings already use, plus
  `lastError`.

Full design, tests, and the touch-points with sibling card c5b234aa (live mid-turn ctx measurement) and
its own follow-up 22072f12 (shared tail-reader plumbing) are in card `66ff7321`'s own body and the
`worker_report` history on it.

## Round 2 — the stale-marker false positive (CR finding, reviewer 6ba057e4)

`latest` used to be reset only by a LATER `type:"assistant"` record, so a marker followed by nothing-
but-a-new-user-prompt (no assistant yet), or by a real `/compact` landing (whose own records are never
`type:"assistant"`), left `latest` as the stale match forever — a session recovered in place (a human
`/compact` or rewind, then a new turn) got re-marked exhausted on the next tick.

Fixed: `detectContextExhaustionInTail` now also resets `latest` to `null` on a later **genuine user
turn** (`isGenuineUserTurn` — `type:"user"` whose content is not purely `tool_result` blocks; mirrors
`classifyRole`'s identical distinction), a **`type:"summary"`** record, or a **`type:"system",
subtype:"compact_boundary"`** record.

### The real wire shapes (read from the installed `claude.exe` binary's own embedded JS/zod schema —
strings like `type:T("system"),subtype:T("compact_boundary"),compact_metadata:u({trigger:U(["manual",
"auto"]),pre_tokens:...})` — never hand-typed, per lesson 288):

```json
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info",
 "compact_metadata":{"trigger":"manual"|"auto","pre_tokens":<int>,"post_tokens":<int?>,
 "cumulative_dropped_tokens":<int?>},"uuid":"...","timestamp":"..."}
```

`{"type":"summary", ...}` is a distinct, separate record (already used as a real-shaped fixture
elsewhere in this repo, `context-stats.mjs`) — a `/compact` landing emits a `compact_boundary` record
and (not necessarily immediately after) a `summary` record; both independently supersede a stale marker.
Confirmed from the SAME binary that the original specimen's own trailing records — `type:"system",
subtype:"turn_duration"`, `type:"last-prompt"` (top-level type, not a `system` subtype), and
`type:"cost-state"` (also top-level) — match NONE of the three reset conditions, so the original
specimen (marker, then only those three) is still detected exactly as before.

## Do not (round 2 addendum)

- Do not reset `latest` on a `tool_result`-only `type:"user"` record — that's bookkeeping for the SAME
  turn the marker ended, never a new one (`isGenuineUserTurn` exists specifically to exclude it).
- Do not treat `last-prompt`/`cost-state`/`turn_duration` as reset signals — they are real trailing
  records of the terminal exhaustion write itself (see the real specimen), not evidence of recovery.

## Round 3 — `isMeta:true` is a real `type:"user"` record that is never human-authored

Investigated (CR round 2 question): does a LOCAL slash command (e.g. `/context`, `/cost`) write
`type:"user"` transcript records that `isGenuineUserTurn` would wrongly treat as a real user turn,
resetting the exhaustion marker when nothing actually recovered?

Resolved by reading the installed `claude.exe`'s own embedded dispatcher source (the same forensic
method round 2 used — never a real session transcript, never a spawned claude) — specifically the
slash-command dispatch functions (`vGi`/`it`/`mo`/`uo` in the minified bundle) and the record
constructors they call:

- `<local-command-stdout>`/`<local-command-stderr>` (a local command's own OUTPUT) is wrapped via a
  constructor (`vb` in the minified bundle) whose return value is
  `{type:"system", subtype:"local_command", content:e, level:"info", isMeta:false, ...}` — confirmed
  verbatim from the binary. **Never `type:"user"` at all.** `isGenuineUserTurn`'s existing
  `rec.type !== "user"` check already excludes it; no change needed here.
- The typed-command ECHO (`<command-name>…</command-name><command-message>…</command-message>
  <command-args>…</command-args>`, the literal text of what the human typed) is built via the SAME
  `type:"user"` constructor (`Me` in the bundle) a genuine human prompt uses, with no `isMeta` field —
  this correctly still counts as a genuine turn; the human really did type it.
- BUT the dispatcher also builds real `{type:"user", isMeta:true, message:{content:"<string>"}}`
  records for its OWN synthesized content — e.g. a local/prompt command's `metaTexts`
  (`N.map((Z)=>Me({content:Z,isMeta:true}))` in `mo`), hook `additionalContexts`, and a
  coordinator-mode-disallow notice. The dispatcher's own dedup logic (`uo`) reads this same shape back
  (`h.type==="user"&&h.isMeta`), confirming `isMeta` sits top-level, a sibling of `type`, exactly where
  `isGenuineUserTurn` would need to check it. None of these is something a human typed.

`isGenuineUserTurn` did not check `isMeta` at all, so a `type:"user", isMeta:true` record (plain-string
content) passed every existing check and would have reset `latest`. Traced every producer of such a
record reachable from the slash-command dispatcher and found none positioned, in the transcript, after
an unresolved exhaustion marker with no accompanying genuine human/engine activity in between — but this
is a trace of the dispatcher's control flow, not an exhaustive audit of every caller, and was not (and
cannot be, per this card's own investigate-first constraint) confirmed against a real transcript or a
live spawn. Given the fix is strictly narrowing (it can only delay, never defeat, a later genuine reset
once real activity actually lands) and matches `isGenuineUserTurn`'s own "human-authored" contract,
`isMeta:true` is now excluded defensively regardless.

## Do not (round 3 addendum)

- Do not drop the `isMeta:true` exclusion in `isGenuineUserTurn` on the grounds that no concrete
  false-positive scenario was proven — it was added as a defensive, contract-matching fix per this
  investigation's own fallback instruction, not because a live incident was found.
- Do not read "no local-jsx/command OUTPUT reaches `isGenuineUserTurn`" as "no local command output can
  ever be `type:"user"`" — the claim is scoped to the `<local-command-stdout>`/`<local-command-stderr>`
  wrapper (`vb`) specifically; a different, not-yet-audited producer could still emit `type:"user"`
  output elsewhere in the CLI.

## 5f825506 — does a raw-terminal `/compact` fire `UserPromptSubmit`?

Investigated as item 4 of card `5f825506` (a follow-up to this card's own round 3). The worry: the DB
mark/hold only clears on a busy RISING edge (`PtyHost.setBusy`'s `if (busy) live.contextExhausted =
false`, mirrored by `SessionService.handleBusyEdge`'s `db.clearContextExhaustedOnResume`), and that
rising edge is driven by the `UserPromptSubmit` hook (`deliverHook`'s `case "UserPromptSubmit":`,
`setBusy(sessionId, true, "user-prompt-submit-hook")`, `pty/host.ts`). If a human typing `/compact`
directly into the raw terminal (`writeStdin`) never fired that hook, a successful manual compaction
would leave the hold and DB mark in place with no rising edge to ever clear them.

Resolved by the SAME forensic method rounds 2/3 above used: reading the installed `claude.exe`'s own
embedded minified bundle (PE VersionInfo `FileVersion: 2.1.317.0`, read via PowerShell
`(Get-Item claude.exe).VersionInfo` — never executed; string contents read via `grep -a`, also never
executing the binary; no real transcript, no spawn).

`/compact`'s own local-command registration:

```
var pCo={type:"local",name:"compact",description:"Free up context by summarizing the conversation so
far",isEnabled:()=>!Oe(process.env.DISABLE_COMPACT),supportsNonInteractive:!0,argumentHint:"<optional
custom summarization instructions>",thinClientDispatch:"post-text",load:()=>import("...")}
```

`thinClientDispatch:"post-text"` is the SAME dispatch value a bare, unrecognized prompt resolves to —
confirmed by the client's own dispatch-resolver function:

```
function VJs(e,n){if(e.type==="prompt")return"post-text";switch(e.thinClientDispatch){
  case"post-text":return"post-text";
  case"control-request":case"local-then-rpc":return e.type==="local"&&!n?"unavailable":"local";
  case"twin":return"post-text";...}}
```

So `/compact`'s raw text is submitted through the IDENTICAL "post-text" pipeline as an ordinary prompt
turn — unlike a `thinClientDispatch:"control-request"` command (e.g. `/cost`, `/model`), which resolves
to `"local"`/`"unavailable"` and is handled client-side without ever entering the prompt-submission
pipeline at all. "post-text" submission is what fires `UserPromptSubmit` (the hook-dispatch generator
functions keyed on `hook_event_name:"UserPromptSubmit"` fire unconditionally for a submitted `prompt`,
regardless of whether the client later recognizes that text as a local command). On the daemon side,
`deliverHook`'s `case "UserPromptSubmit":` handling is itself generic — it does not care whether the
submitted text was a "real" prompt or a recognized local command.

**Conclusion: YES, a raw-terminal `/compact` fires `UserPromptSubmit`**, so it already gets the
ordinary rising-edge clear — this path was never structurally blocked. It is, however, exposed to the
SAME stale-marker race Part 1 of card `5f825506` fixes (any busy rising edge races the CLI's own
superseding transcript write identically, regardless of what triggered the edge) — closed by that same
fix, since its cutoff (`Live.busySince`) is a property of ANY rising edge, not specific to the composer
bypass. No separate code change was needed for this path. Full fix:
`docs/decisions/5f825506-stale-exhaustion-marker-cutoff-and-composer-strand.md`.

## Do not (5f825506 addendum)

- Do not re-derive whether `/compact` fires `UserPromptSubmit` by spawning claude or reading a real
  transcript — read the installed binary's own `thinClientDispatch`/`VJs` dispatch-resolver shape
  instead, per this card's own investigate-first constraint (and 66ff7321's own established method).
- Do not conflate `thinClientDispatch:"post-text"` (submitted through the ordinary prompt pipeline) with
  `"control-request"`/`"local-then-rpc"` (client-side only, never enters that pipeline) — only the
  former fires `UserPromptSubmit`; this record did not verify the latter class separately.
