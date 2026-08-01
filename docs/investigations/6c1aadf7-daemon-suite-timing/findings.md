# 6c1aadf7 — daemon suite wall-time: per-file timing pass, halted

Read-only measurement pass against card `6c1aadf7` ("reduce daemon suite wall time — the real fix
behind the raised gate timeout"). **Halted mid-pass by the manager at 2026-08-01T05:23Z, before a
dominant-file ranking could be produced, once a self-poisoning bug in the suite itself
(`7d70b27b`) was traced to be the proximate cause of a real merge-gate rejection (`78e4b3f2`,
`FAIL 8a: file-not-found is named distinctly` in `engine-session-rotation`).** No production code was
changed by this pass. No fix was attempted.

**Bottom line, stated plainly per the card's own standard ("a stated gap beats a confident number"):
this window was too dirty, for a reason nobody anticipated at the outset, to answer the dominant-file
question at the precision the card needs.** The clean-triplet plan documented below in the session
transcript was superseded by discovering that repeated full-suite runs — the very thing this
measurement needed — poison each other through shared global filesystem state. A clean measurement
becomes possible once `7d70b27b` lands; this card is re-sequenced behind it, not cancelled.

## Fresh `--count`, superseding every stale number in the card

```
node packages/daemon/scripts/test-daemon.mjs --count
```
→ **617 hermetic tests** (the card's own "616" was already 5 commits stale at kickoff; re-verify again
before trusting this number too).

## What was measured

`docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs` reuses
`packages/daemon/test/census/lib.mjs`'s `runCensusBatch` (the same spawn/port/lane logic the suite-flake
census harness already uses, itself derived from `discoverHermeticTests`) instead of duplicating it —
every hermetic test file, run at `poolSize:2` (the gate's own `DEFAULT_CONCURRENCY`), with per-file
`startTs`/`endTs` (epoch + ISO UTC) and a per-run `run-summary` row (window + host snapshot). It was run
directly, never through `run_gate` (the card forbids measuring via the daemon-mediated gate — it shares
the resource under study), so it is **not gate-admitted and invisible to `gate_queue`** — every stamp
below exists only because it was captured explicitly, by this harness or by the manager reading
`gate_queue` by hand.

Two complete runs landed before the halt; a third was aborted mid-run with zero rows persisted (the
harness only appends a run's rows after the whole batch resolves, so the abort left no partial/unreliable
data in the structured output — see "What did NOT make it into the data" below).

| run | start (UTC) | end (UTC) | duration | executed | failed |
|---|---|---|---|---|---|
| 1 | 2026-08-01T04:38:30.842Z | 2026-08-01T05:02:15.821Z | 1424.75s | 617/617 | 2 |
| 2 | 2026-08-01T05:02:16.885Z | 2026-08-01T05:20:23.768Z | 1086.57s | 617/617 | 2 |
| 3 | 2026-08-01T05:20:25.325Z | *(aborted — no run-summary row; halted per manager redirect)* | — | — | — |

**Both complete runs measured UNDER the original 1500s budget** (1424.75s, 1086.57s) despite carrying
real, stamped contention — see the next section. This is the only DoD-4-shaped number this pass can
honestly offer: **it is not a clean/uncontended reading**, so treat "cleared 1500s under load" as
informative, not as evidence the card's job is done.

## The contamination this window carried — TWO independent mechanisms, both real

**Mechanism 1 — foreign gate-semaphore load (gate-attributable, not uncontended).** Both complete runs
overlapped foreign gate activity, sampled by the manager reading `gate_queue` directly (a manager-only
read this session had no access to) and reported live during the pass:
- Run 1 overlapped a Codescape worker self-check (`df6e59f7`, admitted 04:40:17Z) and, from ~04:46Z
  onward, **two concurrent** Codescape self-checks (`3b847f9d` admitted 04:46:42Z, `74c62ea6` admitted
  04:51:47Z) plus a sibling Loom worker's own full-suite run (`7f2c7142`, started ~04:36:10Z) — run 1 is
  the most heavily dosed of the two, at `activeCount:2` (both semaphore lanes foreign-occupied) for most
  of its duration.
- Run 2 overlapped the manager's own merge gate (`c3233e27`, admitted 04:58:47.457Z, ~20+ min) and a
  Codescape merge gate (`5409d16b`, admitted 05:02:17.068Z) — both running for effectively all of run 2's
  window.

**Every foreign-gate stamp above is a FLOOR, not a census** — each was a single manual `gate_queue` read;
a gate that admitted and settled entirely between two reads is invisible to both the manager and this
report. **Non-gate foreign load (dev servers, browsers, ingest subprocesses on the same box) never
touches the semaphore and is entirely unmeasured** — every number in this document is "gate-attributable
contention", never "uncontended", and that ceiling survived every correction made during this pass.

One live corroborating reading, worth recording for `e6e55f7a` (which exists to start capturing exactly
this): the manager's own merge gate showed `idleMs: 44.4s` against the `GATE_EXTEND_IDLE_MS` 60s
extension-refusal threshold — a real max-inter-event-gap reading on a healthy, passing-shaped run, not a
rounding error.

**Mechanism 2 — the suite poisons its own later runs (`7d70b27b`, discovered mid-pass).**
`engine-session-rotation.mjs` uses fixed literal engine ids (`engine-session-alpha/beta/gamma/delta`) on
every invocation and never cleans up the artifact directory it creates under the REAL `os.homedir()/
.claude/projects/`; `resolveTranscriptFile` (`transcript.ts:35-46`) scans that real homedir globally, not
scoped to any test's own `tmpHome`. **Once one full suite has completed, every subsequent one — this
pass's own runs 2 and 3, and eventually the manager's merge gate for an unrelated card, `78e4b3f2` —
fails the same check (`FAIL 8a: file-not-found is named distinctly`).** This is a **second, independent**
contamination mechanism from Mechanism 1: it is shared global filesystem state, not gate contention, and
no amount of gate-stamping detects it. **This pass did not fix it, did not clean the artifact directory,
and did not take card `7d70b27b`** — out of scope, assigned to a sibling worker.

⇒ **Consequence for THIS card's method:** repeating the full suite N times — the exact measurement this
card needs — is not a set of independent samples for at least one file, because run N's outcome for
`engine-session-rotation` depends on run N-1's leftover state. A clean measurement is only possible once
`7d70b27b` lands.

## The PASS/FAIL flip scan (the most valuable single result of this pass)

The manager asked, since this pass ran the suite more times than anyone else on the box: does any file
show a bimodal pass/fail outcome across otherwise-identical runs (the signature of exactly this class of
bug)? Scanned both complete runs, all 617 files each:

```
Total distinct files: 617
Files with a PASS/FAIL flip across runs 1↔2: 0
```

**Two files failed, consistently, in BOTH complete runs — not a flip, a steady failure:**
- **`engine-session-rotation`** — `7d70b27b`, exit 1 (`FAIL 8a: file-not-found is named distinctly`) in
  both runs (run 1: 1410ms; run 2: 1576ms). Reproduced standalone, own temp `LOOM_HOME`/port, outside any
  batch — same failure, same check. This is a real, load-independent defect, not a contention artifact.
- **`kickoff-real-spawn`** — failed in both runs, but via **two different mechanisms**: run 1 hit the
  blanket 120s `TEST_TIMEOUT_MS` (120061ms, consistent with the heavy run-1 contention above); run 2
  failed via a real exit 1 at 24938ms (well under the timeout). Same file, same "failed" outcome, but the
  *shape* of the failure differs between runs — worth flagging as evidence for `e4a2e789` (in-suite
  failures) rather than something this pass investigated further; not touched or root-caused here.

No other file failed in either complete run, so **no other bimodal candidate exists in this dataset.**
This is a 2-run scan, not exhaustive — a rarer flip could exist beyond what two runs can surface.

## What did NOT make it into the data (and one console-only line to explicitly discount)

Run 3 was aborted before its batch resolved; the harness's `run-summary` and per-file rows are only
appended after `runCensusBatch` returns for the whole run, so **zero run-3 rows exist in the persisted
NDJSON** — nothing to misattribute. The raw console log (`data/run.log`) does show individual per-file
`PASS`/`FAIL` lines for the files run-3 managed to start before the kill, including one
`FAIL merge-confirm-completion-nudge (exit 1)` as the very last line before the process stopped.
**This is explicitly NOT reported as a finding** — a process killed mid-test can produce a spurious
non-zero exit that looks identical to a real failure, and without the structured `startTs`/`endTs`/`ok`
row this pass cannot tell the two apart. Treat it as unverified, not as a third failing file.

## What this pass explicitly does not answer

- **No dominant-file ranking.** Per the manager's explicit instruction once the self-poisoning mechanism
  was found: do not attempt it from this data. Even setting aside `7d70b27b`, both complete runs carry
  unresolved gate-load contention (Mechanism 1) thick enough that a per-file "top N by duration" list
  would mostly be reporting which file happened to run during a foreign gate's peak, not the file's own
  cost.
- **No intrinsic-variance-vs-contention split** (the card's own DoD-3-shaped question) — two runs, both
  dosed by a different contamination source each, isn't a basis for that split.
- **No safe reductions landed.** The card's own constraint is to land only measured, evidence-backed
  reductions — this pass produced no trustworthy per-file evidence to land anything against.

## Reproduce this

```sh
cd packages/daemon
node ../../docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs --runs 3
# add --start-index N to continue labelling runs from a prior invocation without colliding in the
# shared NDJSON (e.g. --start-index 4 --runs 2 to append runs 4-5 after an earlier --runs 3 call)
# --limit N restricts to the first N discovered names, for a fast pilot/sanity check
```

Data lands in `data/per-file-timing.ndjson` (two row `kind`s: `run-summary` and `file`, each carrying
explicit UTC start/end) — this is the sole durable, committed artifact. The harness also writes
`data/run.log` (raw console output) but that path is repo-gitignored (`*.log`) and stays local-only; every
claim in this document is drawn from the NDJSON, except the one explicitly-discounted console-only line
called out above.

**Once `7d70b27b` lands**, re-run this harness for a genuinely clean triplet (or more — extra runs are
cheap relative to trusting a distribution with an unresolved confound). The harness, the stamping
convention, and the flip-scan method here are all designed to be reused as-is; no changes to the harness
are known to be needed for that follow-up.
