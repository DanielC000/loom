# 71de1f9c — a give-up whose final Enter provoked real engine output is SUPPRESSED, not recovered

## Narrative

When `sendEnterAndVerify` exhausts its attempts still unconfirmed, it does not unconditionally treat that as a lost Enter. If the engine produced any output after the final Enter write, that is strong evidence the Enter actually registered and a turn is genuinely running, just with a slow-to-confirm hook — GIVE-UP SUPPRESSED: do nothing, and let the real `Stop`/`UserPromptSubmit` (however late) finalize normally. Only when there is genuinely no output at all does the method fall through to GIVE-UP RECOVERY (recover `busy`, clear the stranded injection — see card `ee082fbb`'s own record for that half).

This "did output land" read can itself be fooled — by the method's own paste-reassert write provoking a deterministic engine response, or by a viewer's `repaint()` doing the same — either vector can leave a submit stranded exactly as if no output had landed at all. The final-attempt sequencing fix recorded under card `b64b3726` (Half 1) closes that specific window; earlier attempts don't need it because they don't consult this signal at all.

## Do not

- Do not treat "no output since the final Enter write" as a weak signal to combine with others — it is the sole discriminator between GIVE-UP SUPPRESSED and GIVE-UP RECOVERY; see card `ee082fbb`'s record for what recovery does once suppression doesn't apply.
- Do not assume this read is reliable on the final attempt without the sequencing fix — see card `b64b3726`'s record (Half 1) for why the re-assert's own response must be allowed to land before this read is taken.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`sendEnterAndVerify`'s own method doc). Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 35 (card `905cf0ce`).
