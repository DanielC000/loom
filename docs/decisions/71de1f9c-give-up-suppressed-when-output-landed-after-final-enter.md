# 71de1f9c — a give-up whose final Enter provoked real engine output is SUPPRESSED, not recovered

## Narrative

When `sendEnterAndVerify` exhausts its attempts still unconfirmed, it does not unconditionally treat that as a lost Enter. If the engine produced any output after the final Enter write, that is strong evidence the Enter actually registered and a turn is genuinely running, just with a slow-to-confirm hook — GIVE-UP SUPPRESSED: do nothing, and let the real `Stop`/`UserPromptSubmit` (however late) finalize normally. Only when there is genuinely no output at all does the method fall through to GIVE-UP RECOVERY (recover `busy`, clear the stranded injection — see card `ee082fbb`'s own record for that half).

This "did output land" read can itself be fooled — by the method's own paste-reassert write provoking a deterministic engine response, or by a viewer's `repaint()` doing the same — either vector can leave a submit stranded exactly as if no output had landed at all. The final-attempt sequencing fix recorded under card `b64b3726` (Half 1) closes that specific window; earlier attempts don't need it because they don't consult this signal at all.

## Do not

- Do not treat "no output since the final Enter write" as a weak signal to combine with others — it is the sole discriminator between GIVE-UP SUPPRESSED and GIVE-UP RECOVERY; see card `ee082fbb`'s record for what recovery does once suppression doesn't apply.
- Do not assume this read is reliable on the final attempt without the sequencing fix — see card `b64b3726`'s record (Half 1) for why the re-assert's own response must be allowed to land before this read is taken.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`sendEnterAndVerify`'s own method doc). Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 35 (card `905cf0ce`).

## Why the FINAL Enter write is the anchor, and the measured accuracy behind it

Observed under fleet load: 79% of a measured sample of give-ups WERE followed by a `UserPromptSubmit` for the same session — i.e. most give-ups are FALSE NEGATIVES, not real drops. Treating every give-up as a real failure is actively harmful, not just imprecise: clearing `busy` unconditionally reopens `enqueueStdin`'s `!live.busy` immediate-submit path, so the NEXT message can land — and get interleaved with — a turn that is actually still generating (the owner-reported "text sitting in the input field, unsent" symptom).

The discriminator is `lastOutputAt` (bumped on every real `pty.onData` chunk, already used the same way by `healIfStuck`), read against THIS attempt's own final Enter write (`enterWrittenAt`), never against `submit()`'s own start. Anchoring any earlier makes the check vacuously true and useless: the pasted body's own render bumps `lastOutputAt` within the very first attempt, long before give-up. By `attempt > 1` (always true at give-up in production), the reassert above already guaranteed the paste bracket was closed going into this Enter, so a landed keystroke observed after THIS write can only be a real submit, not paste-content-swallowing.

Real-engine measurement, not a guess: a `claude` sitting genuinely idle at the composer emitted ZERO pty output over an 85+ second observation window on this project's own live fleet, while a concurrently-busy session's output stream grew continuously in the same window — confirming idle claude does not emit periodic output (no spinner/repaint chatter) that could make this discriminator misfire on a genuine drop. If this read is ever wrong regardless, `healIfStuck`'s existing stale backstop (`busySince` AND `lastOutputAt` both stale) still recovers a truly-wedged session — just not as fast as this branch would have.

## Do not (2)

- Do not anchor the output-landed check on `submit()`'s own start instead of THIS attempt's final Enter write — the pasted body's own render already bumped `lastOutputAt` by then, making the check vacuously true.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `else` branch of `fireEnterAndVerify`'s give-up handling, its opening paragraph), commit `71f20fa9` ("fix(pty): no give-up stays terminal unconfirmed; worker_flush reports recovery"). Condensed, not verbatim. Extracted by tranche 37 (card `b9951bbc`).
