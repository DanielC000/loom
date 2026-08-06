# Card 773b3914 — why did the paste-tripwire recovery itself collapse on 4 of 89 firings?

Scope per the card: characterisation only (DoD-1/2/3). No detector/recovery/escalation code changed —
if a fix is indicated it is reported here and stopped at, per the card's hard constraint (DoD-4).

## Verdict, up front

**DoD-1/DoD-2: the four "ALSO collapsed" escalations are not a distinct failure class with its own root
cause — they are (in the three I could directly verify against the engine's own transcript, and
structurally consistent in the fourth) FALSE-POSITIVE re-firings of the tripwire's own widened
detection condition, not a second genuine loss of the recovery payload.** In every one of the three I
traced into the real `claude` transcript JSONL, the content the "ALSO collapsed" warning claims was
re-lost had, in fact, already arrived — complete — by a different route (the recovery injection landing
with a cosmetic garbled prefix but an intact payload; a peer/manager message re-delivered through
Loom's durable inbox), and the recipient session's own turns show it reading and acting on that full
content. The discriminator that actually separates the 4 from the 85 is not payload size, role, or
project — it is whether the transcript's *recorded* turn text, at the moment the recovery's own Stop
hook fires, happens to contain a `[Pasted text #N...]`-shaped substring anywhere in it (stale or fresh),
because `detectBarePastePlaceholderTripwire` was deliberately widened (card `0f9268cc`) to match an
*embedded*, not just whole-string, placeholder — the exact widening that makes it vulnerable to the
same stale-render-ghost artifact that the sibling detector (`detectPastePlaceholderLengthLoss`, card
`b68d1f5b`/`abeac33a`) was specifically hardened against with a `gen`-based discriminator. This detector
has no such guard.

**DoD-3: the escalation does not fire into a channel nobody reads — it fires into no channel at all.**
`RECOVERY re-injection ALSO collapsed` is a bare `console.warn`, nothing else: no `db.appendEvent`, no
`enqueueSystemNudge` to sender or recipient, zero references anywhere in `packages/web` or
`packages/daemon/src/gateway`. The sibling `handlePasteLengthLoss` (b68d1f5b) *does* fail loud to both
recipient and sender via `enqueueSystemNudge` — this escalation was never given the equivalent. And
consistent with the DoD-1 finding: in the three cases I could verify, no human needed to manually resend
anything, because the content had already arrived through another Loom-internal delivery path before (or
around the same moment as) the "needs a human to resend" line was written to a log file nobody was
reading live.

**This mechanism was already established once, independently, on a single specimen.** Project memory
`gen4-paste-tripwire-was-stale-splice-not-independent-collapse` (2026-08-05, card `4ffb27b9`, session
`da934877`) found the identical shape by log+transcript reconstruction: a stale placeholder token from
one turn's genuine collapse splicing onto the FRONT of the *next* turn's fully-intact content, tripping
the tripwire a second time on content that was never actually lost — explicitly noted there as
"resemblance, not identity" with the `3ce3fa39` frame-splice family and left as a single, unweighted
specimen ("don't merge without more evidence"). This investigation is that additional evidence: the same
mechanism accounts for all four (not one) recovery-escalation failures in the full corpus, and — new here
— contrasted cleanly against the 85-firing population (4-of-4 vs 0-of-5, see DoD-2) rather than reported
as a single occurrence.

## Positive control — corpus still present, methodology reproduces the card's own count

Per the card's explicit instruction, confirmed the retained window survived the owner's 04:49Z restart
today *before* drawing any conclusion. `[paste-tripwire]` lines exist across all of
`daemon-output.log{,.1,.2,.3,.4,.5}` (non-empty at every rotation depth checked — see
`scripts/extract-tripwire.mjs`'s own run log). Log rotation is continuous, so "which physical file holds
which timestamp range" has shifted since `a3ac7ba8` ran (that investigation's own `.1`/`.2` are not the
same byte ranges as today's) — the script therefore parses every retained rotation and filters by
timestamp, not by file identity.

Filtering to `ts <= 2026-08-05T16:36:05.990Z` (card 773b3914's own `createdAt` — the exact moment
`a3ac7ba8`'s corpus was frozen) reproduces:

| | this investigation | `a3ac7ba8` / card 773b3914 |
|---|---|---|
| total tripwire firings in window | **88** | 89 |
| `ALSO collapsed` (the target) | **4** | 4 |
| `auto-recovering` (clean) | **84** | 85 |

The one-line gap (88 vs 89) is explained, not unexplained: one `[paste-tripwire]` line in the current
`daemon-output.log.3` predates the trailing-timestamp field this script keys on (a legacy pre-`0f9268cc`
log format), so it's excluded by construction — and it long predates the Jul 31–Aug 5 window regardless
(confirmed by its own session id not appearing in `a3ac7ba8`'s 14-specimen table). The **4-of-4 exact
match** on the actual target quantity is the load-bearing reproduction; see `scripts/extract-tripwire.mjs`.

Since `a3ac7ba8` ran, the daemon kept running and produced **6 more** `ALSO collapsed` firings
(2026-08-05T18:12Z through 2026-08-06T02:23Z, i.e. after the card's own cutoff and mostly after this
worker's kickoff) — correctly excluded from the corpus below, but noted because it confirms the class is
still live and this investigation's window boundary is a deliberate, principled cut, not an artifact of
what happened to still be on disk.

## DoD-1 — the four, individually

| session | project/role | original collapse (ts, intendedLen, token) | `ALSO collapsed` fired (ts) | gap |
|---|---|---|---|---|
| `a7f22ddb…` | Codescape / worker | 2026-08-01T01:01:40Z, 4287 chars, `[Pasted text #1 +272 lines]` | 01:06:52Z | 5m12s |
| `19a92eb9…` | Loom / worker | 2026-08-03T23:28:49Z, 2562 chars, `[Pasted text #3 +314 lines]` | 23:33:19Z | 4m30s |
| `f99aea6c…` | Loom / worker | 2026-08-04T04:04:55Z, 2838 chars, `[Pasted text #1 +312 lines]` | 04:06:35Z | 1m40s |
| `cb2a6c14…` | Codescape / manager | 2026-08-05T13:03:04Z, 4231 chars, `[Pasted text #1 +320 lines]` | 13:06:37Z | 3m33s |

(These are 4 of the same 14 specimens `a3ac7ba8`'s own findings table already catalogued — cross-checked
against that table by session id and timestamp, not re-derived independently.)

I read all four straight from the engine's own transcript JSONL (`~/.claude/projects/**/<engineSessionId>.jsonl`,
still on disk for all four) rather than relying on the daemon log's own necessarily-partial view. What
the recipient actually received and did, at the moment each "ALSO collapsed" fired:

- **`a7f22ddb` (Codescape worker).** The recovery re-injection landed as `"[loom:from-manager]\n**RUBR[Pasted
  text #4 +30 lines][loom:paste-recovery] Your previous message's pasted content was lost... resending the
  original content now:\n\n[loom:from-manager]\n**RUBRIC APPROVED — with one CORRECTION..."` — garbled at
  the seam (a stray placeholder token sitting between a fragment and the real preamble), but the full
  ~4.4KB rubric-approval message is present and complete. The assistant's own next turn, verbatim: *"This
  is the same message I already received and acted on — the paste-recovery resend of the content that
  reached me **(mangled but complete)** two turns ago... no new content, and critically no GO."* The agent
  itself directly confirms full, complete receipt at the moment the tripwire declared a second loss.
- **`cb2a6c14` (Codescape manager).** Two distinct events land in this window. First, the recovery
  re-injection itself arrives garbled-but-complete (`"[Pasted text #1 +320 lines][loom:from-manager ·
  Loom · projectId:..."`, full peer-letter content intact — the agent declines it as a duplicate of what
  it already has). Second, and coincident (within ~200ms) with the `ALSO collapsed` line itself, Loom's
  *own* `[loom:prompt-mismatch]` diagnostic notice (the b68d1f5b/`detectPastePlaceholderLengthLoss`
  sibling check, which *does* deliver via `enqueueSystemNudge`) fires on a **different, later** gen-3
  submission and is misread by the tripwire's own comparison as a fresh loss. The agent's own forensic
  read, verbatim: *"The 'lost' 4837 chars were **not lost** — they came through the durable inbox instead.
  And the arithmetic confirms the replay: 4258 = 4231 (the peer letter) + 27 (the placeholder) — exactly
  the immediately-preceding submission."* This is the clearest specimen in the corpus: the recipient
  session did its own forensic reconstruction and reached the identical conclusion this investigation
  reaches independently.
- **`f99aea6c` (Loom worker).** The manager's real correction message (*"🔴 CORRECTION FROM ME — a factual
  claim in your kickoff was WRONG..."*) lands prefixed with the same stale `[Pasted text #1 +312 lines]`
  token, full content otherwise intact. The agent reads it, correctly judges it *"a legitimate
  `[loom:from-manager]` delivery... not third-party injected content,"* acts on it, and reports `done` —
  all before the tripwire's own `ALSO collapsed` line for this session is even written. The Stop hook that
  produced the `ALSO collapsed` verdict corresponds to the *end* of that same already-completed,
  multi-tool-call turn (a `worker_report(done)` round-trip), not to any fresh content submission — no new
  user-authored text was written to the pty between the garbled-but-complete correction landing and this
  verdict.
- **`19a92eb9` (Loom worker).** Same structural shape as `f99aea6c`: the resent instruction (*"⚠️
  IMPORTANT ADDITION to `c1d48ea7`..."*) lands garbled-but-complete 28s after the original collapse, the
  agent reads and acts on the full content over the following ~4 minutes (visible in its own
  running commentary), and the `ALSO collapsed` verdict lands at the Stop hook ending that same
  `worker_report` round-trip, with no new content submitted in between. I did not individually re-derive
  `stats.lastUserText`'s exact value at that instant the way I could for the other three (the daemon log
  alone can't show it and I stopped short of a deeper transcript walk here) — flagged as the one specimen
  where "false positive" is inferred from a matching structural signature rather than directly read off
  the transcript, unlike the other three.

## DoD-2 — building the contrast, not just describing the four

Per the card's own warning, checked each candidate against a real comparison population before crediting
it, not just against the four.

- **Payload size (intendedLen of the original collapse): does not discriminate.** The 4 collapsed-recovery
  cases: 2562–4287 chars (mean 3480, median 4231). A same-methodology sample of 10 clean recoveries with
  comparable log coverage: 2083–5234 chars (mean 3683, median 3954). Fully overlapping ranges, no
  separation — ruled out. (See `scripts/payload-contrast.mjs`.)
- **claudeVersion: does not discriminate.** The 4 span 2.1.220–2.1.222, matching `a3ac7ba8`'s own finding
  that the *whole* 89-firing corpus (not just these four) spans exactly this range with no version in the
  corpus where the underlying race is absent. Not new territory, not a fresh finding, not a lead.
- **Session role: not a clean discriminator at this n.** 3 of 4 collapsed cases are workers, 1 manager. The
  broader `auto-recovering` (clean-recovery) population resolves to 37 workers / 32 managers / 2 unresolved
  across 71 unique sessions (~52%/45%) — so workers are already a slight majority of the population the
  tripwire fires on at all, and 3-of-4 is well within what that base rate alone would produce at this
  sample size. Reported, not weighted as a lead.
- **Project: not discriminating.** 2 Codescape, 2 Loom among the four; the broader population is 33
  Codescape / 36 Loom (near 50/50) — no skew.
- **Concurrent message traffic on the session — this is the one that separates the groups cleanly.**
  Cross-referencing `[prompt-mismatch]` lines (a *different*, UserPromptSubmit-time signal, logged
  independently of the Stop-hook tripwire) against every tripwire firing: sampled 79 clean-recovery
  sessions with prompt-mismatch coverage near their tripwire event, and **5 of 79 (~6%)** show a *second*
  mismatch record on/after the recovery submission — i.e. some concurrent-traffic noise is not unique to
  the four. But in every one of those 5, the interleaved content is an unrelated real message with **no
  placeholder-shaped token anywhere in it** (`reportedAround` values like `"[loom:worker-report] worker
  5e3eb1af..."`, `"[loom:resume-doc-size] Your resume doc..."` — plain text, no `[Pasted text #N...]`
  substring). **All 4 of the collapsed cases, by contrast, show a second mismatch record whose
  `reportedAround` DOES contain a `[Pasted text #N...]`-shaped token** — the exact substring
  `detectBarePastePlaceholderTripwire`'s widened embedded-match condition (card `0f9268cc`) looks for.
  4-of-4 vs 0-of-5 (and 0 of the ~74 with no second mismatch at all) is the sharp line: it isn't merely
  "traffic landed nearby" (that happens ~6% of the time regardless of outcome) — it's "traffic landed
  nearby *and* that traffic happened to leave a placeholder-shaped token in the transcript's recorded
  turn," which is a materially narrower, and apparently much more consequential, condition. Per the card's
  own warning against crediting a property shared by the four AND by most of the 85: this property is
  emphatically **not** shared by most of the 85 — it's the one candidate that actually separates the two
  groups. (See `scripts/second-write-contrast.mjs`.)
- **Elapsed time between original collapse and the `ALSO collapsed` verdict:** 1m40s–5m12s across the
  four. I could not build a matched contrast for this one — a clean recovery produces no second tripwire
  firing at all, so there is no symmetric "time to resolution" signal to compare against in the log. Not
  ruled in or out; flagged as genuinely unmeasured rather than guessed at.

## DoD-3 — did the escalation path behave as designed?

Read `host.ts`'s Stop-hook call site directly (`packages/daemon/src/pty/host.ts:5242-5247`). On
`isRecoveryAttempt === true`, the *entire* action taken is:

```
console.warn(`[paste-tripwire] ${sessionId} submitted turn resolved to a bare pasted-text placeholder
(...) RECOVERY re-injection ALSO collapsed — giving up automatic recovery after one attempt; this needs
a human to resend the content manually.`);
```

No `this.db.appendEvent(...)`, no `this.events.on*?.(...)` call of any kind — contrast directly against
the sibling `detectPastePlaceholderLengthLoss` path two dozen lines later in the same function
(`this.events.onPasteLengthLoss?.(sessionId, candidate)`), which `SessionService.handlePasteLengthLoss`
(`sessions/service.ts:7074`) turns into a durable `appendEvent` **plus** an `enqueueSystemNudge` to both
the recipient and (when it has one) its `parentSessionId` — exactly the "fail loud to recipient AND
sender" pattern this escalation's own log text promises but never implements. `grep -rln
"paste-tripwire|ALSO collapsed|RECOVERY re-injection" packages/web/src packages/daemon/src/gateway`
returns zero hits — there is no code path, anywhere in the web UI or gateway, that could ever surface this
specific line to a human. It is written to `daemon-output.log` and nothing else ever reads it.

So: not "fired into a channel nobody happened to be reading" — there is no channel. The design doc
(`paste-tripwire.ts`'s own comment on `PASTE_RECOVERY_TAG`) describes the intended behaviour as
"escalate instead of recovering again," but "escalate" here means "write one more log line," not any
action that reaches a person. And consistent with the DoD-1 finding: in the three cases directly traced,
no human *needed* to manually resend anything regardless — the content had already arrived by another
route before or around the same moment this line was written. Whether that would still hold on a
genuine, non-false-positive double-collapse is unmeasured (no such specimen exists in this corpus to
check against — see §NOT-ESTABLISHED).

## DoD-4 — no detector/recovery/escalation code changed

Confirmed by construction: every file touched by this investigation lives under
`docs/investigations/773b3914-recovery-collapse/`. `git status` at time of commit shows no changes under
`packages/daemon/src/**`. If DoD-1/DoD-3's findings above are to be acted on, they'd point at two
separable fixes — noted here, not attempted:
1. `detectBarePastePlaceholderTripwire`'s embedded-match widening (0f9268cc) has no `gen`-based
   discriminator against a stale re-render ghost, unlike its sibling `detectPastePlaceholderLengthLoss`
   (which gained exactly that guard via `abeac33a`, precisely because the same failure mode was already
   found and fixed once, on the other detector).
2. The `isRecoveryAttempt === true` branch's escalation has no `db.appendEvent`/`enqueueSystemNudge`
   equivalent to its own sibling's, despite its own log text promising one ("this needs a human to resend
   the content manually").

## §NOT-ESTABLISHED — carried forward honestly

- **Whether a *genuine* second collapse of the recovery payload (not a stale-ghost false positive) has
  ever occurred is not established either way** — this corpus's 4 specimens all show the false-positive
  signature to varying degrees of directness (3 confirmed by reading the actual transcript content; the
  4th inferred from a matching structural signature, not independently confirmed). A true double-loss
  remains possible and would look identical to these at the daemon-log level; distinguishing it needs the
  same transcript-reading step this investigation did, applied to a future specimen as it happens (the
  engine transcript JSONL for a session this old will not stay on disk indefinitely).
- **4-of-89 is still not a rate, and is not defended as one here** — same reasoning as `a3ac7ba8`'s own
  finding: the denominator selects for firings the tripwire *detected*, and a silent, undetected
  false-positive-flavoured double-collapse on content nobody happened to check would never enter this
  count either. This investigation narrowed *what the four have in common*; it did not re-open or narrow
  the denominator question.
- **The 19a92eb9 specimen's exact `stats.lastUserText` at the moment of its own `ALSO collapsed` verdict
  was not independently confirmed** — see its entry in DoD-1 above.
- **Whether a genuine double-collapse would actually reach a human faster or slower under the current
  (channel-less) escalation is unmeasured** — no such specimen exists in this corpus.
- Scope of the corpus: `daemon-output.log` + five rotations, this machine's single self-hosting daemon —
  not a survey of any other Loom deployment, same limitation `a3ac7ba8` already carried.

## Guard check (DoD-6)

No `.mjs` under `packages/daemon/test/` was added or modified by this investigation — its scripts live
under `docs/investigations/773b3914-recovery-collapse/scripts/` instead (log-forensics tooling, not test
suite content), so the directory-scanning guards (`grep -l readdirSync packages/daemon/test/*guard*.mjs`)
do not apply here. Stated explicitly per the card's own instruction not to silently skip this.

## Scripts

- `scripts/extract-tripwire.mjs` — parses every retained `daemon-output.log` rotation for
  `[paste-tripwire]` and `[prompt-mismatch]` lines, reproduces the positive control and the 88/4/84 split.
- `scripts/role-lookup.mjs` — resolves session role/project for a set of session ids via the read-only
  `loom.db` (anchored with `createRequire` at `packages/daemon/package.json` for `better-sqlite3`, per
  this project's documented recipe).
- `scripts/payload-contrast.mjs` — builds the payload-size contrast table (DoD-2).
- `scripts/second-write-contrast.mjs` — builds the concurrent-traffic / placeholder-token contrast table
  (DoD-2, the one discriminator that survived).
