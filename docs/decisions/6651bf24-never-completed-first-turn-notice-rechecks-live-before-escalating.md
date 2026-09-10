# 6651bf24 — the never-completed-first-turn idle notice rewords the false completion claim, doesn't silence the nudge

## Narrative

Card 6651bf24 SPECIMEN 2: a taskless worker whose first turn genuinely started (SessionStart fired, a real UserPromptSubmit hook confirmed it — `hasFirstTurnStarted:true`) but has not yet completed one (`turnSeq` — incremented only at the genuine Stop-hook chokepoint, `host.ts`'s `onTurnCompleted` — is still 0, the same `neverCompletedTurn` field `worker_status`/`mcp/orchestration.ts` already expose). `hasFirstTurnStarted` answers "did anything begin", never "did it finish" — for a claude session it flips true on the first `UserPromptSubmit` hook, i.e. turn start; for a codex session (card 361a5520 — codex has no start-confirming hook at all) it flips true on the first confirmed completion instead (`armCodexBusyStaleTimer`'s CASE 2, `host.ts`) — either way, a live, actively-producing, `busy:true` session mid its first turn is `turnSeq:0` by construction. The taskless branch used to fall through past this state straight into the plain "finished a turn and is idle" wording — false for this case (measured: Specimen 2, a healthy Code Reviewer ~90s into its first turn, got that exact false claim plus a `worker_stop` recommendation — see the card).

Reworded, not silenced (card 6651bf24 DoD-4: "fix the claim it makes", not "silence the nudge generally") — a genuinely wedged first turn is real signal worth surfacing; the fix is to stop asserting a completion that never happened, not to go quiet. The `busy:false` reading this fires on is a single point-in-time snapshot that can already be stale by the time it's read (delivery can lag behind classification — same class of staleness `parked-gate-stale`'s own wording hedges for the tasked path) — an actively-working first turn can dip `busy:false` and recover before the manager ever reads this, which is exactly why the message leads with a live re-check rather than an escalation.

## Do not

- Do not word the never-completed-first-turn notice as a completion claim — it isn't one, and doing so previously drove a false `worker_stop` recommendation against a healthy, actively-working session.
- Do not skip the live re-check step (`worker_status`) before escalating to `worker_transcript`/`worker_message`/`worker_stop` — the triggering `busy:false` reading can already be stale by the time it's read.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`buildNeverCompletedTurnMsg`'s top-of-function doc): lines 1255-1276, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## DISCRIMINATOR A — `hasFirstTurnStarted`, not `engineSessionId` presence, at the taskless path

`notifyManagerOfIdleWorker`'s taskless branch runs its OWN discriminator, mirroring `classifyIdleWorker`'s card-`2281009d` discriminator exactly (see `docs/decisions/2281009d-broken-spawn-needs-two-proofs-a-turn-actually-started.md`): `engineSessionId` being SET only proves the SessionStart hook fired, NOT that a turn ever ran (card `f91c8634`'s parked-Enter signature can leave a kickoff sitting unsent in the composer forever) — without this check that state used to fall straight through into "it DID start a turn" and assert a completion that never happened.

`hasFirstTurnStarted` is seeded `false` for EVERY real Claude live entry `spawn()` creates — fresh, resume, AND fork alike (`host.ts:4072`, unconditional, inside the one `spawn()` chokepoint every one of those paths shares) — verified NOT the `firstTurnStarted:true` seeds at `host.ts:4250`/`4331`, which belong to `spawnShell`/`seedCanned`, an unrelated non-Claude `kind:"shell"|"canned"` code path reachable only from the human-only `POST /api/terminals` REST route and a WS-replay test fixture, never a real worker's resume/fork — so a worker that crash-resumed with a genuinely never-started kickoff still reads `hasFirstTurnStarted:false` here, never a stale `true`.

### Do not (2)

- Do not trust `hasFirstTurnStarted:true` as proof a turn started without checking whether the session could be a `spawnShell`/`seedCanned` (`kind:"shell"|"canned"`) seed — those alone seed it `true` unconditionally; every real Claude `spawn()` path seeds it `false`.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`notifyManagerOfIdleWorker`'s taskless branch, "DISCRIMINATOR A"): lines 9756-9767, as of main `c51b7bc2` (introducing commit `0e97a2fdb054c6c953db865b790a25898a3ce877`, `fix(sessions): gate the taskless idle nudge on whether a turn finished`). Extraction tranche 35.

## Source (3)

A second citation site of this record's main SPECIMEN-2 narrative above ("DISCRIMINATOR B (card 6651bf24 SPECIMEN 2)"), same `notifyManagerOfIdleWorker` taskless branch: lines 9779-9783, same commit family (`0e97a2fdb054c6c953db865b790a25898a3ce877`). No new content — the Narrative section above already covers this site in full. Extraction tranche 35.
