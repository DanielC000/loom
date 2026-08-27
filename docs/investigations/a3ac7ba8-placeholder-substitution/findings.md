# Card a3ac7ba8 — placeholder-substitution ("outcome (c)") investigation

Scope per the card: DoD-1 (find a Loom-side specimen, or prove there is none) and DoD-2 (characterise the mechanism) only. No fix attempted — this is a report, per the card's explicit hard constraint.

## TL;DR

**DoD-1: we have Loom-side specimens — 14 of them, not 0.** The band-cross-validated query returns non-empty against our own retained `daemon-output.log` corpus, and two of the 14 are byte-identical (same `writtenHash`/`reportedHash`) to the peer's own cited specimens 5 and 6 — because this daemon self-hosts both the Loom and the Codescape projects, so "the peer's telemetry" and "our own telemetry" are literally the same log file for events on session `5570f79f-1f64-47e8-80c1-c47541669b34`.

**DoD-2: this is not a new, uncharacterised mechanism.** It is the exact class already named, instrumented, and auto-mitigated by cards `eef4883c` → `0f9268cc` (the `[paste-tripwire]` detector + one-shot recovery) and `b68d1f5b` (`detectPastePlaceholderLengthLoss`, a calibrated backstop for what the tripwire structurally can't see). Root cause was already traced, by that prior work, to an upstream `claude` CLI paste-collapse race — not a Loom write defect — and a targeted 24-attempt reproduction probe (cited in `host.ts`) came back 24/24 full, i.e. **not independently reproducible**, consistent with a genuine upstream race rather than a deterministic Loom bug. Any Loom-side work here is mitigation, not a fix, and the mitigation already exists and is already deployed.

## DoD-1 — Loom-side specimen search

### The query

Grepped `~/.loom/logs/daemon-output.log{,.1,.2}` (the retained rotation window; `.3`–`.5` predate `[prompt-mismatch]` logging and contain 0 matches) for `[prompt-mismatch]` lines, then filtered to lines whose `reportedAround` field is an **exact, whole-string match** for `^\[Pasted text #\d+ \+\d+ lines\]$` — i.e. the entire reported submission is nothing but the collapsed-paste placeholder, the precise shape the card describes as outcome (c) (as opposed to a placeholder merely prefixed onto other real content — see "Adjacent but distinct shape" below).

### Positive control (run first, per the card's own polarity warning)

`grep -c "[prompt-mismatch]"` across the three files returns **363** total lines before any filtering (149 + 148 + 66) — confirms the query surface is non-empty and the instrument works before trusting a narrower filter's result. Of those 363, 361 are the real divergence detector (`engine-reported submitted prompt DIVERGES…`) and 0 are the separate "hook carried no usable prompt field" diagnostic — i.e. the `hook.prompt` field is confirmed present and being compared on this corpus, so a silent/broken detector is ruled out as the explanation for an empty result, had one occurred.

### Result: 14 real specimens, not 0

Of the 361 divergence records, exactly **14** are whole-string placeholder substitutions:

| session | project | role | ts (UTC) | intendedLen | reportedLen | placeholder |
|---|---|---|---|---|---|---|
| `11010244…` | Loom | worker | 2026-08-02T05:41:31.619Z | 4493 | 27 | `[Pasted text #1 +327 lines]` |
| `19a92eb9…` | Loom | worker | 2026-08-03T23:28:23.065Z | 2562 | 27 | `[Pasted text #3 +314 lines]` |
| `f99aea6c…` | Loom | worker | 2026-08-04T04:03:50.180Z | 2838 | 27 | `[Pasted text #1 +312 lines]` |
| `1920c751…` | Loom | worker | 2026-08-04T20:09:18.855Z | 3586 | 27 | `[Pasted text #1 +321 lines]` |
| `3c7ac417…` | Loom | manager | 2026-07-31T21:35:10.679Z | 2923 | 27 | `[Pasted text #27 +18 lines]` (cross-project relay, frame tagged `· Codescape ·`) |
| `cb2a6c14…` | Codescape | manager | 2026-08-05T13:02:29.238Z | 4231 | 27 | `[Pasted text #1 +320 lines]` |
| `5570f79f…` | Codescape | manager | 2026-08-05T15:17:35.278Z | 3954 | 26 | `[Pasted text #6 +29 lines]` — **= peer specimen 5** (`writtenHash=65e8fc95 reportedHash=7cb2bd93`, exact match) |
| `5570f79f…` | Codescape | manager | 2026-08-05T15:33:30.109Z | 2752 | 27 | `[Pasted text #12 +14 lines]` — **= peer specimen 6** (`writtenHash=01d34c2d reportedHash=75b986ae`, exact match) |
| `8e8b753f…` | Codescape | manager | 2026-07-31T20:35:21.672Z | 5234 | 27 | `[Pasted text #11 +27 lines]` |
| `84241199…` | Codescape | worker | 2026-07-31T22:56:23.611Z | 3013 | 27 | `[Pasted text #2 +229 lines]` |
| `77246f82…` | Codescape | manager | 2026-07-31T22:46:07.121Z | 4436 | 26 | `[Pasted text #7 +34 lines]` |
| `a7f22ddb…` | Codescape | worker | 2026-08-01T00:50:06.148Z | 4287 | 27 | `[Pasted text #1 +272 lines]` |
| `3f629728…` | Codescape | manager | 2026-08-01T00:46:36.625Z | 2083 | 27 | `[Pasted text #11 +20 lines]` |
| `ae9d0bd7…` | Codescape | manager | 2026-08-02T04:37:52.707Z | 4358 | 27 | `[Pasted text #1 +323 lines]` |

13 unique sessions, 14 events, spanning 2026-07-31 through 2026-08-05 — well inside the retained window, not an edge artifact of the query boundary. `project`/`role` resolved by reading `~/.loom/loom.db` (`sessions`/`projects` tables, read-only) via a scratch script anchored with `createRequire` at `packages/daemon/package.json` (per this project's documented recipe for scripting against `better-sqlite3` outside the daemon process).

**5 of the 14 are genuinely Loom-project sessions**, independent of the Codescape-project ones — this alone answers DoD-1 in the positive; the Codescape/Loom overlap on `5570f79f` is a bonus cross-validation, not the whole of the evidence.

Every `intendedAround` for all 14 begins `[loom:from-manager]`, `[loom:from-manager · <Project> · projectId:…]`, or `[loom:worker-report]` — every one is a daemon-relayed, purely programmatic write (manager→worker direction, a cross-project `peer_message` relay, a worker report), never anything that could be a human composer draft. This matches the card's own framing exactly and rules the `2521bf51` human-Enter mechanism out structurally, the same way the card's own reasoning does.

### The band classifier, sharpened

The card offered "`reportedLen` in a ~24–30 char band" as an unverified hypothesis. All 14 real specimens satisfy the **exact closed form** `len("[Pasted text #N +M lines]") = 23 + digits(N) + digits(M)` — verified programmatically against all 14, 14/14 exact. In this corpus the naive band alone would have produced zero false positives (no `[prompt-mismatch]` record anywhere in the corpus has `reportedLen` in {24,25,28,29,30} at all), but I did not rely on the bare length band — the actual filter matched the placeholder **pattern**, not just a length, so it carries no band-collision risk regardless of what other lengths might exist in a different corpus.

### Adjacent but distinct shape found in the same sweep — not this card's target

87 `[prompt-mismatch]` lines have a `reportedAround` that *starts* with a placeholder token; only 14 of those are the whole submission. The other 73 have the placeholder immediately followed by more real reported text (e.g. `"[Pasted text #1 +331 lines][loom:from-man…"`, with `lenDelta` often exactly the placeholder's own length) — a **stale leftover placeholder prefixed onto the next real submission**, not a substitution. That shape is already `abeac33a`'s territory (cited directly in `host.ts`'s own `detectPastePlaceholderLengthLoss` comment as "a stale CLI-side re-render of an older, already-delivered gen still inside the window"). Naming it here only so the 14-count above isn't second-guessed as under-inclusive; it is not part of outcome (c) and I did not investigate it further.

## DoD-2 — mechanism characterisation

### The write path (Loom's side, confirmed by reading `pty/host.ts` directly)

`submit()` wraps the intended text in the terminal's bracketed-paste protocol: `ptyWrite(BRACKET_PASTE_START)` → `writeChunked(text)` (chunked because a single large `pty.write` truncates under Windows ConPTY) → `ptyWrite(BRACKET_PASTE_END)` → a settle delay → Enter. This wrap is deliberate and load-bearing — it's what stops the CLI's own readline from treating each embedded newline as a separate keystroke/Enter. Every one of the 14 specimens' underlying messages (2000–5700 chars, daemon-relayed frames) is exactly the kind of write this path exists for.

### The CLI's own collapse behaviour (already probed against the real engine)

A prior real-engine probe (cards `ee082fbb`/`0f9268cc`, cited in `host.ts`'s own doc comment on `sendEnterAndVerify`) established directly against `claude 2.1.207`: a bracketed paste that's multi-line/long gets **collapsed by the TUI into a single `[Pasted text #N +K lines]` placeholder token** in the visible composer — this is standard, intentional Claude Code composer behaviour, not something Loom's write path causes or can avoid (Loom does not own that presentation; confirmed by the same probe work backing card `76f7ac84`'s framing).

### The failure: at submit time, the placeholder's OWN display text is what gets reported/submitted, not the real buffered content

In the overwhelming majority of turns this resolves correctly — `[prompt-echo]` shows `byteIdentical=true` for the large majority of the 4216 records across this corpus's 3 log rotations, and even within the 5 affected Loom-project sessions the surrounding generations mostly confirm clean. In the 14-event failure mode, the CLI's `UserPromptSubmit` hook reports back the **literal placeholder string** as the submitted prompt — not the real underlying paste buffer it's meant to represent. This is a substitution, not a truncation: per the card's own observation (confirmed again here), the entire original payload is replaced by ~26–27 characters with no partial-content residue of any size in between.

**This is not new territory.** It is the exact class card `eef4883c`/`8a39f544` already investigated (2026-07-20, origin: a Companion owner-paste loss), already traced to a **transient upstream `claude` CLI race**, and already deliberately left unfixed at the write layer: a targeted reproduction probe (`test/_probe-paste-collapse-trigger.mjs`, `test/_probe-paste-collapse-production-repeat.mjs`, cited directly in `host.ts` at the `detectBarePastePlaceholderTripwire` call site) drove 24 real-CLI submissions varying bracket-paste presence, single/multi-line, and size (120–5000 chars) — including the exact production `submit()` path repeated 15×  — and came back **24/24 full, zero reproductions**. Prevention was explicitly considered and declined (owner decision, per the code comment) on the grounds that there is no reliable repro to validate a write-path change against, and the one plausible alternative (changing the bracket-paste/chunking transport) would trade an unreproducible rare loss for a reproducible Windows ConPTY truncation regression.

### The "fixed by 2.1.215" framing is stale — already known to be stale, not a new finding here

`8a39f544`'s original investigation pinned the race to CLI `2.1.212`, "fixed by 2.1.215." That claim did not survive even its own follow-up: `0f9268cc` (the recovery card) already recorded a recurrence at `2.1.217`, past the claimed fix, which is why `0f9268cc` shipped auto-recovery rather than treating detection alone as sufficient. My own sample only extends the same already-acknowledged pattern: the `claudeVersion` field on every `[paste-tripwire]` firing in the retained corpus (89 total firings, all three log files) reads `2.1.220` (62), `2.1.221` (9), or `2.1.222` (18) — i.e. the race is firing on the newest CLI versions this corpus has ever seen, with no version in the corpus where it's absent. I'm not asserting a cause for that (still upstream, still outside this repo) — only reporting that the "fixed" framing was already retired by prior work and nothing here revives it.

### Existing detection + mitigation infrastructure (already shipped, not proposed here)

Both detectors fire on every one of the 5 Loom-project specimens (and on the 2 shared Codescape ones) at the `Stop`/`StopFailure` hook, independent of the `UserPromptSubmit`-time `[prompt-mismatch]` line I queried for DoD-1:

- **`[paste-tripwire]`** (`detectBarePastePlaceholderTripwire`, cards `eef4883c`→`0f9268cc`): fires on the recorded transcript turn being *only* the placeholder. Confirmed firing for every one of the 13 sessions above (1–3 firings each). On first firing it auto-recovers by re-injecting the lost content as a `[loom:paste-recovery]` corrective turn — verified directly for `5570f79f`'s two events (`[submit-write] … head="[loom:paste-recovery] [this refers to an EARLIER message…"` immediately follows both tripwire lines). Corpus-wide: 89 tripwire-detected firings (NOT 89 collapses — see §NOT-ESTABLISHED), of which 4 had the recovery re-injection *also* collapse (falls back to asking a human to resend — the one class this mechanism cannot self-heal).
- **`detectPastePlaceholderLengthLoss`** (card `b68d1f5b`, an independent second instrument reading `ContextStats.lastUserText` — the CLI's own transcript JSONL, not the daemon's hook stream): 0 firings anywhere in the corpus. This is the expected, not a broken-instrument, result — I read its call site directly: it's deliberately silent when the placeholder is explained by "the current gen's own fresh collapse (already owned + recovered by the block above)," which is exactly what all 14 specimens are. It exists to catch what `[paste-tripwire]` structurally cannot (a raw human/terminal paste with no `submittedText` to compare) — a case this corpus's 14 specimens, being 100% programmatic writes, never hits. Zero firings here corroborates rather than contradicts DoD-1's finding.
  - ⚠️ **CORRECTED 2026-08-27 (card `183de1a4`):** the parenthetical above ("a raw human/terminal paste with no `submittedText` to compare") is false and was already stale when written — `Live.lastRawSubmit` has captured the raw path's full content since `0f9268cc` (2026-07-23), and `[paste-tripwire]` (`detectBarePastePlaceholderTripwire`) already receives it via `live.lastRawSubmit ?? live.lastPrompt`, so the human path already has detection AND one-shot recovery through that same mechanism. See `orchestration/paste-tripwire.ts`'s `detectPastePlaceholderLengthLoss` doc for the accurate, narrower statement of what this detector actually catches (a raw write's absence from `Live.recentWrittenLineCounts`, which only `submit()` populates). The corpus finding itself (0 firings, all-programmatic specimens) is unaffected by this correction.

### Card-routing check (per the card's DoD-4 instruction to check `76f7ac84` first and hand back rather than collide)

Read both named/adjacent cards in full rather than assuming fit:

- **`76f7ac84`** ("give a placeholder an identity") is explicitly a **different class**: its own text states "Not a claim that content is lost — n=3, turn 0 intact every time" and "`76f7ac84` is a DIFFERENT CLASS — there recipients HELD the content; here nobody held anything. Don't close one by fixing the other" (quoted from `4491bd3b`, which cites the same distinction). Outcome (c) is a genuine loss (recovery has to re-inject the content because the model never saw it) — it does not fit `76f7ac84`.
- **`4491bd3b`** ("surface a worker report its manager never resolved") is also a **different class**: its own DoD-2 finding is that the write produced **no turn at all** ("Written in full to the pty, two Enters, produced no turn"). Outcome (c) is the opposite shape — a turn *does* run, just on substituted content.
- **The actual, already-shipped home is `eef4883c`/`0f9268cc` (detection + recovery) and `b68d1f5b` (the independent backstop)** — both already merged and live in this corpus (confirmed above by real firings), not proposed or pending. Per the card's own instruction ("if it is upstream in the CLI, a Loom-side fix is a mitigation and must be labelled one"): the mitigation already exists, is already deployed, and is already working (85 of 89 corpus-wide recoveries self-healed; 4 fell back to a human resend).

## §NOT-ESTABLISHED — carried forward honestly

- Root cause is still **outside this repo**, in the CLI's own Ink composer/paste-buffer state management — not newly confirmed here, inherited from `eef4883c`/`8a39f544`'s own probe work. I did not attempt a fresh reproduction; the existing 24/24-full probe result is cited, not re-run.
- I did not determine *why* these 14 specific submissions triggered the race and the surrounding ones on the same sessions didn't (e.g. checked `5570f79f`'s gen 7→gen 8 timing gap — ~172s, not back-to-back — so a naive "rapid consecutive paste" trigger does not obviously fit; not investigated further, out of this card's scope).
- The 4-of-89 double-failure cases (recovery re-injection *also* collapsed) were not individually inspected — only counted from the `[paste-tripwire]` log line's own `RECOVERY re-injection ALSO collapsed` branch.
- **The 4-of-89 figure is not a defensible failure rate for the recovery mechanism itself.** 89 is the count of collapses the tripwire *detected* — its own denominator is selected by detectability, not by the true rate of collapses. An undetected collapse never reaches the recovery step at all and so cannot appear in either side of the 4/89 fraction. The true denominator (all collapses, detected or not) is unmeasured in this corpus; 4/89 bounds only the self-heal rate conditional on detection, not the class's overall success rate.
- `project`/`role` resolution used `~/.loom/loom.db` as it exists **now**; a session could in principle have moved project/role since these events (not checked, considered unlikely for closed historical sessions and not material to the count).
- Scope of the corpus: `daemon-output.log` + `.log.1` + `.log.2` only (`.3`–`.5` predate this logging and were confirmed empty, not just unchecked) — this machine's single self-hosting daemon, not a survey of any other Loom deployment.

## Recommendation

Per the card's hard constraint, no fix is proposed or attempted here. The characterisation above supports: outcome (c) is a real, recurring, upstream-sourced class with existing, deployed Loom-side mitigation (detection + auto-recovery) that self-healed the large majority of *detected* firings (85 of 89) — a conditional rate over what the tripwire could see, not a measured success rate over all collapses (see §NOT-ESTABLISHED); the two candidate "hand back" cards (`76f7ac84`, `4491bd3b`) do not fit and should not receive this work; and the one open thread worth a human decision is whether the 4-of-89 double-failure (recovery-also-collapsed) rate warrants anything beyond the existing "ask a human to resend" fallback — left to the manager, not decided here.
