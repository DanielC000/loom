# 774a9701 — the resume-doc size note's byte figure is a pre-filter only; the message points at the harness's own token count, and the rotation recipe conditions on content

## Narrative

The `[loom:resume-doc-size]` note's byte figure (`RESUME_DOC_WARN_BYTES`) decides only whether the note fires — it cannot predict where a doc actually sits against the harness's real (token) cap, because bytes-per-token density swings hard with markup: measured as low as ~2.0 bytes/token on an emoji/bold-heavy resume doc, vs. the ~4-5 bytes/token rule of thumb for plain prose — roughly double the token count for the same byte size. Rather than add a tokenizer to make the byte figure precise, the fix points the agent at a number it already has for free: `resumeDocSizeWarning`'s message tells the agent to check the token count its own last `Read` of the file already printed, instead of trusting the KB figure as the real test.

Two independent fixes landed in the same message text, from the same measured incident: (1) the byte figure is reframed as a pre-filter only, pointing the agent at their own last `Read`'s real token count instead of implying the KB number itself is the test; (2) the rotation recipe no longer tells the agent to unconditionally reduce the doc to "only current state" — a resume doc can be mostly standing rules/method rather than transient state (the exact failure mode card `1a1b0670` already identified: "the fix is homing discipline, not gate code"), and blindly archiving that unread would discard it. The recipe now conditions on the doc's actual content and gives a safe way to read the archived copy first when something needs to be carried forward.

**Verified live:** a `Write` immediately following a cap-truncated `Read` of the SAME path fails "File has not been read yet", even though a `Read` did occur — so the recipe never has the agent Read-then-Write the same resume-doc path. Reading the archived copy instead — a different, never-Written-to path — carries no such risk.

## Do not

- Do not let the byte figure stand in for the real test — point the agent at their own last `Read`'s printed token count instead of the KB number.
- Do not add a tokenizer to make the byte pre-filter precise — the harness already reports the real count for free on every `Read`.
- Do not have the rotation recipe unconditionally reduce a resume doc to "only current state" — a doc that's mostly standing rules must have that content carried forward or homed first, never silently discarded by an unread rewrite.
- Do not Read a resume doc and then Write directly back to that SAME path — a cap-truncated Read does not satisfy the Write tool's "read it first" guard for that path.

## Source

JSDoc comment above `RESUME_DOC_WARN_BYTES` in `packages/daemon/src/sessions/resume-doc-notes.ts`: originally lines 15-21, as of this tranche's HEAD. Introduced by commit `0bef38aa8494b0fe52a06a3b8049618a51e15d04` (`fix(sessions): point resume-doc sizing at tokens, condition its rotation advice`).

Also cited (same commit, same decision) in `resumeDocSizeWarning`'s own doc comment in the same file, originally lines 73-87, as of this tranche's HEAD — the "two independent fixes" narrative and the verified Write-after-truncated-Read specimen came from that site. Both sites relocated to this one record by card `36641df4` ("sessions prompt-composer files, tranche 1").
