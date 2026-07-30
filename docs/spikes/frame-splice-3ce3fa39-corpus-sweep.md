# Frame-splice corpus sweep (card `3ce3fa39`, next step 2)

Worker session, 2026-07-29. Scope: scan `~/.loom/logs/daemon-output.log` + rotated `.1/.2/.3` for Loom frame markers (`[loom:...]`) appearing mid-line rather than at frame start — the signature of a notification spliced into another message's frame. This is analysis only; no fix was attempted (out of scope for this session) and the card stays open.

## Corpus snapshot

Snapshotted before the sweep (the log rotates mid-investigation): `daemon-output.log` (2.4MB) + `.1` (10.5MB) + `.2` (5.3MB) + `.3` (5.2MB) = 64,710 lines total. `[submit-write]`/`[pty-write]`/`[stdin-write]` instrumentation (deploy `14c789b`) only exists in the two newer files — `corpus0` (328 submit-write lines) and `corpus1` (1,568 submit-write + 2 stdin-write lines). `corpus2`/`corpus3` (16,726 lines, the older rotations) predate that instrumentation and carry no `head=` content field at all, so the head-field check below has no signal to check there — noted as a coverage gap, not folded into "clean."

## Detector

Two independent, content-positional checks, deliberately not using `seq`/`gen`/hash matching (that's step 1's discriminator, already run and not re-run here):

- **Check A (head-field):** every `[submit-write]`/`[stdin-write]` line carries `head="<first ~60-70 chars of the composed content>"`. A legitimate single-frame write always starts that content with its own `[loom:...]` marker at offset 0. A second `[loom:` occurring at offset > 0 inside the head text means two frames were already concatenated before the write call (a composition-layer bug, distinct from a below-daemon replay).
- **Check B (raw-line):** a lower-level signature — the log *writer* itself interleaving two entries into one physical line with no intervening newline. Detected as a line containing more than one occurrence of a known daemon log tag (`[submit-write]`, `[hook]`, `[git]`, etc.), counted only *outside* `head="..."` content (masked out first) and with `[pty] spawn` lines excluded entirely (their argv echoes whole kickoff prompts, including literal `[loom:` text and the tag vocabulary itself as prose — anchoring everything to line-start avoids matching that noise, including this very investigation's own text).

## Controls (validated before trusting the sweep)

**Control 1 — locate specimen #2's two implicated frames by exact content + id + len match**, narrowing to the unique real pair rather than the many reuses of the same recurring headers:

```
payload-frame head snippet found: True -> [('corpus0.log', 4082, '[submit-write] 20e1b548-... len=824 head="[loom:worker-report] worker ecb896fe-1f3d-40cd-bd72-828890d2"')]
host-frame head snippet found:    True -> [('corpus0.log', 4166, '[submit-write] 20e1b548-... len=3245 head="[loom:from-manager · Codescape · projectId:046fda54-b722-4d7"')]
```

Both found, at the exact line numbers step 1's independent sweep already identified. **PASS.**

**Control 2 — synthetic specimen-#1-shape positive** (`merged.· projectId:` — marker injected mid-token, missing space) **+ a real clean line as negative**, run against check A:

```
synthetic positive: head="[loom:from-manager · Loom [loom:merge-done] worker 014509ae-… merged.· projectId:c36e8691-…"
  check_a offset: 26        (fires)
synthetic clean:    head="[loom:from-manager · Loom · projectId:c36e8691-44d8-44ae-91e"
  check_a offset: None      (does not fire)
```

**PASS.** (First draft of check A had an off-by-one: `head.find("[loom:")` always finds the frame's own leading marker at offset 0 first, so `idx > 0` could never fire — a detector that cannot fail. Caught by this exact control, fixed by searching from index 1.)

**Control 3 — synthetic two-lines-smashed-together positive + a real near-miss negative**, run against check B:

```
synthetic smashed: [submit-write] aaaa... head="[loom:x]"[submit-write] bbbb... head="[loom:y]"
  check_b spans: [0, 104]   (fires, 2 spans)
real negative:    head="What is going on with the non stop \"[git] findLandedSquashCo"
  check_b spans: None       (does not fire)
```

**PASS.** (First draft counted tag occurrences over the raw line unmasked, so a human message merely *quoting* a tag name as prose — someone asking about the `[git]` log tag — read as a second tag hit. Fixed by masking `head="..."` content before counting; this is the same "the observer/content can manufacture the signature" false-positive class the card already names, applied to log text instead of a witness's memory.)

All three controls exercised real failure modes on the first attempt and were fixed before the sweep ran — not designed to pass trivially.

## Sweep result

Full 64,710-line corpus, both checks: **0 hits.** Validated empty, not a broken-detector empty — both controls above prove the detector fires on true positives and abstains on documented near-miss negatives.

## Step 4 — does anything distinguish a below-daemon replay from a rendering-side artifact?

No new mechanism evidence. But the corpus does sharpen the *shape* of a below-daemon-replay hypothesis, from data already surfaced by step 1's sweep (re-read here for timing, not re-run):

Between the two frames implicated in specimen #2 — payload `gen=25` (len=824, the worker-report) and host `gen=27` (len=3245, the Codescape header) — the daemon wrote a *third*, intervening, fully independent message: `gen=26` (len=155, `[loom:merge-done]`). Each generation ran a complete, separately-confirmed turn before the next was written: `gen=25`'s turn ran ~170s (Stop `afterMs=170289`), `gen=26`'s ran ~85s (Stop `afterMs=84901`), and only then was `gen=27` written. `gen=26` is not implicated in the reported corruption at all.

That rules out the simplest version of "below-daemon replay" — a buffer holding the *most recently written* bytes and re-emitting them into the next write — because the most recent prior write before `gen=27` was `gen=26`, and it is `gen=25`'s older, already-fully-confirmed content that shows up spliced in instead, across two intervening complete turns and 250+ seconds. Whatever retains and replays the bytes (if that's the mechanism) is not simply "last thing in the pipe" — it would have to be tied to something specific about the `gen=25` write call itself (a stray callback, a duplicate listener, a retry path holding a stale reference), not to buffer recency.

This doesn't distinguish below-daemon replay from a rendering-side artifact outright — the corpus has no instrumentation below the write() call (no read-back of what ConPTY actually delivered, no confirmation of bytes-on-the-wire), so it cannot see either layer directly. That absence is itself the honest answer to the open question: nothing in `daemon-output.log`, at any content-positional layer, is capable of adjudicating "replay" vs. "render" — both would look identical from here (a clean, complete, sequential write log with no trace of what happened after). The corpus is exhausted for this question; distinguishing the two needs instrumentation at a layer this corpus doesn't reach, not a sharper sweep of the same layer.

## Detector script

Kept for reproducibility; not part of the shipped daemon (analysis tool only, reads `~/.loom/logs/...` directly).

```python
import re

SUBMIT_WRITE_RE = re.compile(
    r'^\[submit-write\] (\S+) reason=(\S+) busyBefore=(\S+) len=(\d+) head="(.*)"$'
)
STDIN_WRITE_RE = re.compile(
    r'^\[stdin-write\] (\S+) busy=(\S+) len=(\d+) head="(.*)"$'
)
HEAD_FIELD_RE = re.compile(r'head="((?:[^"\\]|\\.)*)"')
KNOWN_TAGS = [
    "boot", "busy-worker-watcher", "busy", "codescape", "companion",
    "context-watcher", "crash-recovery-watcher", "db-backup", "escalation",
    "finalizeMerge", "gateway", "git", "heal", "hook", "idle-watcher",
    "liveness", "orchestration", "paste-tripwire", "pty-write", "pty",
    "rate-limit-resume", "reap", "reconcile", "resume-mode", "run-cost",
    "scheduler", "skills", "stdin-write", "submit-write", "submit",
    "vault-push", "vault-versioner", "watch", "worktree",
]
TAG_ALT = "|".join(sorted((re.escape(t) for t in KNOWN_TAGS), key=len, reverse=True))
TAG_RE = re.compile(r"\[(?:" + TAG_ALT + r")\]")


def check_a_head_field(line):
    m = SUBMIT_WRITE_RE.match(line) or STDIN_WRITE_RE.match(line)
    if not m:
        return None
    head = m.group(m.lastindex)
    idx = head.find("[loom:", 1)  # start at 1: index 0 is the frame's own marker
    return idx if idx > 0 else None


def check_b_raw_line(line):
    if line.startswith("[pty] spawn"):
        return None
    masked = HEAD_FIELD_RE.sub(lambda m: "head=" + ("#" * (len(m.group(0)) - 5)), line)
    matches = list(TAG_RE.finditer(masked))
    return [m.start() for m in matches] if len(matches) > 1 else None
```
