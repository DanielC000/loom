# 8feb55b8 — a chat-reachable Companion's blast radius must be a RECORDED choice, never a silent default

## Narrative

Blast-radius gate for card `8feb55b8`: `restrictedTools` must never resolve to `false` for an assistant-role profile by silent omission — a companion is driven by untrusted inbound chat, so whether its raw-shell/host-write blast radius is withdrawn has to be a RECORDED decision, not an accident of a field nobody set.

This deliberately does NOT enforce `true` either: the owner explicitly declined that for their own Companion (Request `34923f42` / card `ccd0d05f`, WON'T-DO). `assistantRestrictedToolsOmittedError` (`profiles/validate.ts`) only requires the caller state a value, either one, so the stored `false` this normalizes to is provably a choice rather than an oversight.

## Do not

- Do not let `restrictedTools` resolve to `false` for an assistant-role profile by silent omission — require the caller state it explicitly on CREATE or a role change into "assistant".
- Do not enforce `restrictedTools:true` unconditionally for assistant-role profiles — the owner explicitly declined that (Request `34923f42`, card `ccd0d05f`, WON'T-DO); only requiring a stated value is correct.

## Source

Inline comment in `packages/daemon/src/profiles/validate.ts` (the opening paragraph of the JSDoc above `assistantRestrictedToolsOmittedError`), as of commit 45acc7e9763ba9f3388379f145d9e9ecfa1f0235. Relocated by card e762eef0 (`profiles/validate.ts`, tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers. The function's own "fires when…" and `submittedPatch` mechanics paragraphs stay inline in source (Class C contract docs) and are not duplicated here.
