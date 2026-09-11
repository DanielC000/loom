# 97558183 — every Enter retry also re-asserts the paste-close, not just the Enter itself

## Narrative

`submit()`'s own `BRACKET_PASTE_END` write is JUST as fire-and-forget as the Enter it precedes, and the SAME ConPTY drop class can lose it. When it does, Ink stays mid-paste and swallows every retried `\r` as paste CONTENT (never a submit) — worse, each swallowed byte resets Ink's paste idle-timer, actively preventing self-heal, so the old code's bare-Enter retry could NEVER recover from this and would burn all attempts before giving up.

The fix: every retry (`attempt > 1`; the FIRST attempt follows immediately after `submit()`'s own END write, so re-asserting there would just be redundant) re-sends a zero-length `START+END` pair — not a bare END — as ONE write, before the `\r`.

### The two-branch safety argument

- **Already closed** (the common case — only the Enter dropped, not the END): Ink is idle, sees a fresh START immediately followed by END, and treats it as an empty paste — a true no-op. A bare END alone sent while idle is NOT verified safe (Ink may not recognize an out-of-context terminator the same way a fresh START+END pair is defined to behave, either idle or mid-paste — see this file's own `CONTROL_CHAR_RE` note for the sibling risk of a stripped-ESC CSI turning into literal text).
- **Still genuinely open** (the bug): the extra bytes fold in as a few stray literal paste-content characters, but END is found and the paste closes — recovering the turn (submitted with a small cosmetic tail) instead of losing it entirely after 4 failed attempts (`SUBMIT_MAX_ATTEMPTS`'s default).

Real-`claude` confirmation of both branches (does an idle START+END truly no-op; does a still-open paste truly close and submit with just a small stray tail) is the Lead's live-verification pass — the fake pty this file's own test drives can't model Ink's paste state machine, only that the BYTES this host writes are exactly what's intended.

`3ce3fa39`'s own record cites this same START+END re-assert bytes in passing (its deferred clear-prefix force-closes the paste bracket the same way, "the same bytes `sendEnterAndVerify`'s own retry-reassert uses") — this record is the primary narrative for why the re-assert exists and what it protects against; `3ce3fa39`'s record does not restate it.

## Do not

- Do not send a bare END alone while idle to try to close a possibly-open paste — it is not verified safe; always send a fresh START+END pair together.
- Do not skip the re-assert on any retry beyond the first — only the first attempt is exempt, because it immediately follows `submit()`'s own END write.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`sendEnterAndVerify`'s own method doc, the RETRY re-assert paragraph). Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 35 (card `905cf0ce`).
