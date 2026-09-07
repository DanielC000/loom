Card 9a83ee8f -- codex first-real-turn rollout-write findings

Method: scripts/probe.mjs. See that file's own header for the full mechanism (real
PtyHost.spawn({harness:"codex"}), no in-process MCP gateway stood up, a self-test of the on-disk scan
instrument against a synthetic fixture tree BEFORE it is ever pointed at the real ~/.codex/sessions tree,
then three on-disk snapshots around exactly one real, minimal turn). Run once, under the exclusive
real-codex-spawn window this card's manager granted, per the manager's own explicit budget ("SPEND EXACTLY
ONE codex model turn. One.").

Run (2026-09-07, UTC timestamps from the process's own Date.now(), host-local clock is UTC+2):

- spawnStartTime: 2026-09-07T22:24:17.588Z
- Real codex process reached full boot readiness + settled idle (isCodexBootReady && !isBusy).
- Snapshot after boot, before the turn (scoped to mtimeMs >= spawnStartTime): NONE. Consistent with
  c6ce2804's established, twice-reproduced finding that boot alone writes no rollout file -- now checked
  directly in this run too, not only assumed from that sibling probe.
- turnSubmittedAt: 2026-09-07T22:24:22.789Z. Prompt: "Reply with exactly the single word: pong. Do not run
  any commands." enqueueStdin delivered it immediately (session was idle post-boot). The real submit ladder
  reached "confirmed" (host.isBusy settled back to false; no onCodexSubmitUnconfirmed fired).
- Snapshot after the turn reached its terminal state (scoped to mtimeMs >= spawnStartTime):
  `C:\Users\danie\.codex\sessions\2026\09\08\rollout-2026-09-08T00-24-18-01a07df8-e60e-7e81-a3f0-fd064b8d5dd0.jsonl`,
  mtime 2026-09-07T22:24:23.120Z -- 331ms after the turn was submitted.
- Cross-check: this project's own `captureCodexEngineSessionId` (pty/host.ts) independently discovered
  engine-session id `01a07df8-e60e-7e81-a3f0-fd064b8d5dd0` via its own retry-scan mechanism during this same
  run, matching the new rollout filename exactly. Two independent read paths (this probe's own scan, and
  the project's own production capture code) agree.
- Real codex process exited cleanly afterward (code 0, graceful stop, 1372ms to onExit). config.toml
  unchanged (no manual cleanup needed).

Positive/negative control on the scan instrument itself, run BEFORE the real spawn: a synthetic
`sessions/YYYY/MM/DD/rollout-*.jsonl` tree with two files of deliberately different, explicit mtimes,
confirming (a) an unscoped scan finds a file at all, (b) it picks the newer of two known files, (c) an
mtime-filtered scan still finds a file that postdates the filter, and (d) the same filtered scan correctly
returns null once the filter excludes both known files, and (e) a genuinely empty tree returns null. All
five passed before the real measurement was trusted. This is the "confirming something ABSENT needs a
check shown capable of returning non-zero" discipline applied to the instrument itself -- the DoD-1
question turns on a null-vs-non-null read of the real tree, so the scanner's ability to distinguish those
two states had to be shown first, not assumed.

## DoD-1 answer

**Yes, in this one observation: a codex session's rollout file was written 331ms after its first real turn
was submitted (and confirmed idle shortly after), where the identical spawn-to-idle-boot window on its own
had written nothing.** This directly settles the half `captureCodexEngineSessionId`'s own doc comment
disclosed as a hedge ("the rollout file is created lazily, around first-turn time, not at boot") and
c6ce2804's probe left as inferred-not-observed.

Stated at its true strength, per this card's own instruction not to round up: **n=1, one host, one codex
build (codex-cli 0.153.4), one trivial one-word prompt, one turn.** This does not establish a rate or rule
out a different codex version, a longer/tool-using prompt, or a turn that itself errors out before
completing ever behaving differently. It is a single clean observation of the mechanism, which is what this
card's manager judged sufficient to spend the one authorized turn on ("a mechanism question... ONE clean
observation is enough" -- the same standard the sibling fedef6a0 probe was run under). The delay measured
(331ms) is this run's own number, not a claimed constant -- a slower host, a larger response, or a
different build could plausibly change it; what does not depend on that number is the qualitative finding
that the file appears at (not before) first-turn time.

## The filename's own timestamp is BOOT time, not turn time -- a mint/persist distinction the raw numbers already carried

Re-reading this run's own three timestamps together (all from the process's own Date.now()/fs.statSync,
host-local clock UTC+2):

- `spawnStartTime`: 2026-09-07T22:24:17.588Z
- The new file's own NAME encodes `2026-09-08T00-24-18` local, i.e. **2026-09-07T22:24:18Z** -- 0.412s
  after spawn start, and (critically) **4.789s BEFORE** `turnSubmittedAt`.
- `turnSubmittedAt`: 2026-09-07T22:24:22.789Z
- The file's own mtime (when this probe's scan first found it, and the only timestamp its "post-boot,
  pre-turn" snapshot ever tested): 2026-09-07T22:24:23.120Z -- 331ms after the turn was submitted.

So codex's own filename convention names a start-of-conversation instant close to BOOT (within half a
second of spawn), not first-turn time -- meaning the conversation id (and whatever internal clock stamped
it) was **minted** around boot, well before this probe's own "post-boot, pre-turn" scan ran (which found
nothing, scoped to `mtimeMs >= spawnStartTime`). The file's bytes only became visible on disk -- creatable,
statable, present in a directory listing -- at first-turn time, ~4.8s after that mint instant and 331ms
after the turn was submitted. **These are two different events: an early, in-memory mint of the id+label,
and a later, on-disk persist that is what this probe's scan (and `captureCodexEngineSessionId`'s own real
scan) can actually observe.** The DoD-1 answer above is unaffected by this -- the FILE, which is the only
thing either scanner can see, still appears at first-turn time -- but it narrows what DoD-3 is actually
asking.

**Stated at its true strength: this is a one-build (codex-cli 0.153.4) OBSERVATION of what one filename's
timestamp component happened to encode in one run, not a documented contract.** Codex could change this
naming scheme, its precision, or what instant it reflects at any time without notice; a future reader must
not treat "the filename encodes boot time" as a guarantee to build anything on, only as a data point this
one run produced. Separately: the co-occurrence of the timestamp and the uuid inside one filename token
makes it a reasonable inference (not an independent measurement) that the uuid was minted at the same
instant as the timestamp -- this run only directly timestamps the timestamp component's origin, not the
uuid's, and did not attempt to observe the uuid separately (e.g. by checking whether the same uuid appears
in any other host-side artifact before the rollout file lands).

**The narrowed DoD-3 question, for whoever picks it up:** the open question is no longer "does an id exist
before the first turn" -- this run's own data says one demonstrably does, minted close to boot -- but
"is that minted id OBSERVABLE anywhere (stdout, another file, an IPC surface, anything) before the rollout
file itself lands on disk." Nothing in this run looked for such a surface; this is a lead for a future
research pass, not a finding this run establishes either way.

## DoD-2 -- fix, or document?

**Recommendation: document, do not build a mitigation.** Reasoning:

1. **The window this asymmetry opens is now measured, not merely inferred, and it is narrow in the case
   that actually matters.** A codex worker's `engineSessionId` stays null only from spawn until its first
   turn is submitted and its rollout file lands -- order of a few hundred milliseconds once a turn is
   actually running, per this run. The load-bearing case c6ce2804 named (a worker dying before it completes
   even one turn) requires the death to land inside that pre-first-turn window specifically, not "any point
   before the worker finishes its task" -- once a first turn has run at all, the id exists and boot-reconcile
   recovery works exactly like claude's.
2. **It already fails safe, verified by reading (this card's own ESTABLISHED section, unchanged by this
   run): `resume()` checks `engineTranscriptExists`/a null `engineSessionId` BEFORE ever touching
   `pty.spawn()`, throws a named, caught error, and `db.setResumability(id, "dead")` -- `resumeFleetOnBoot`
   records it in `failed`/`failedDetail` with role/projectId/taskId. Never a crash, never a silent zombie,
   identical to how a claude session with a missing transcript is already handled.** A worker lost this way
   is a diagnosable, named failure a manager can see and re-dispatch from, not a wedge.
3. **A mitigation is a real research question, not a known lever -- but the question is narrower than "does
   an id exist yet".** This run's own data (see the mint/persist section above) shows codex demonstrably
   DOES mint a conversation id+timestamp close to boot, well before the rollout file itself becomes
   observable on disk -- so the open question is not existence, it is **observability**: is that
   already-minted id surfaced anywhere (stdout, another file, an IPC surface, anything) before the rollout
   file lands, the way claude's SessionStart hook surfaces its own id at boot. No equivalent surface was
   found or looked for in this pass; finding one, if it exists at all, would be new research, not implied by
   anything this probe or c6ce2804 established. Building a mitigation now would still mean guessing at a
   codex CLI internal this project has not verified is exposed anywhere, against a failure mode that already
   degrades gracefully.
4. **Cost asymmetry.** Documenting costs one doc update pointing at this finding; a real fix would mean
   either (a) finding and wiring a genuine pre-first-turn codex signal (unverified to exist), or (b) some
   form of speculative polling/heuristic that adds complexity and its own failure modes to close a gap that
   already fails safe and is now known to be narrow.

If the owner's real-world crash rate against codex workers ever shows this window actually being hit in
practice (visible via `resumeFleetOnBoot`'s own `failed`/`failedDetail` diagnostic surface, card 5a9a963b --
already built for exactly this), that would be the trigger to revisit DoD-3 with real incidence data instead
of a hypothetical. Nothing in this run's own scope indicates that has happened yet.

## Bound on this whole investigation

n=1 run, one host, one codex build, one trivial prompt, one real model turn (the manager's explicitly
authorized budget for this card). Confirms the qualitative claim (first-turn, not boot, is when the rollout
file is created) but does not establish a rate, a guaranteed delay, or behavior under a different prompt
shape, tool call, or codex version. See docs/investigations/c6ce2804-codex-resume-rollout-timing/findings.md
for the sibling zero-turn findings this probe extends -- that file is unchanged by this one; the two
together (zero-turn: no file: twice; one-turn: a file, once) are what jointly answer this card's DoD-1.
