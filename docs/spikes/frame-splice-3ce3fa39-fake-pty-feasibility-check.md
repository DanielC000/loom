# Frame-splice re-assert-paste-drop candidate — fake-pty harness feasibility check (card `3ce3fa39`)

Worker session, 2026-07-29, step 3 of the card's NEXT STEPS ("cheapest first"). Read-only assessment. No fix attempted, no ConPTY harness built. Card stays open.

## The question

Card's surviving candidate: `host.ts:4631-4635`'s give-up clear-fill assumes the SAME attempt's own re-assert-paste write (`BRACKET_PASTE_START+END`, `host.ts:4495`) already closed any open paste bracket before the backspace burst is written. If that re-assert write itself silently drops (a second, independent ConPTY drop stacked on the original Enter drop), the trailing backspaces get folded into the still-open paste as literal CONTENT instead of acting as erasing keystrokes — which fits every observed property of specimen #3's splice. The question: **can this be exercised with the existing fake-pty harness, before considering a real-ConPTY repro?**

## 1. What does the existing fake-pty harness actually model?

Every `pty-*.mjs` hermetic test in `packages/daemon/test/` overrides `PtyHost.createPty()` with the same shape (e.g. `pty-giveup-clear.mjs:70-83`, `pty-reassert-settle.mjs:84-99`, `pty-submit-paste-end-retry.mjs`):

```js
function makeFakePty() {
  const writes = [];
  let onDataCb = null;
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: (cb) => { onDataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
    emitData: (d) => { if (onDataCb) onDataCb(d); },   // present in some, not all
  };
  ...
}
```

`write()` does exactly one thing: append the bytes to an array the test later inspects (`fake.writes.join("")`, `backspaceCount()`). It does not parse, interpret, or hold any state derived from what was written. There is no bracketed-paste tracking, no "is Ink mid-paste" flag, no model of the TUI composer's contents — nothing that would let a write of `BACKSPACE.repeat(N)` behave differently depending on whether a prior write is "believed" open or closed.

`onData`/`emitData` is the harness's only notion of engine *output*, and it is entirely test-driven and manual: a test calls `fake.emitData(someBytes)` at a moment of its own choosing (`pty-reassert-settle.mjs:149`, `pty-giveup-false-negative.mjs:144`, `pty-giveup-requeue.mjs:288`, `pty-healifstuck-clear.mjs:110`) to simulate "the engine produced this output now." Across every fake-pty test in the suite, `write()` and `emitData()` are fully decoupled — no fake's `write` implementation ever calls its own `onDataCb` in response to what was written. The harness has no feedback loop from writes to reads at all, real or simulated.

**Positive control that this isn't a missed grep:** `host.ts` itself does contain a real bracketed-paste state machine — `nextComposerLen` (`host.ts:260-295`) and `nextRawDraftState` (`host.ts:311-...`) both explicitly track an `inPaste` flag toggled by `BRACKET_PASTE_START`/`END` and treat backspace/Enter differently inside vs. outside a paste span, exactly the distinction this card's candidate turns on. So the grep methodology is sound — the daemon *has* this logic. But it applies to the opposite side of the pipe: it's driven by `writeStdin`'s `data` parameter, i.e. bytes arriving from a human's raw-terminal keystrokes being *forwarded into* the pty (`host.ts:5315-5354`), used only to gate `enqueueStdin`'s hold-for-human-draft logic. It is never invoked on the give-up clear's own backspace burst — that goes through `writeChunked`, not `writeStdin` (`host.ts:4647`) — and even where it is invoked, it is the daemon's own best-effort belief about what it *intended* by writing, not an observation of what the real Ink composer actually did with those bytes (see its own doc comment, `host.ts:257-258`: "it can't perfectly mirror Claude's Ink editor"). So the one paste-state-machine that exists in this codebase is structurally the wrong side of the pipe for this question, and isn't wired into the fake-pty harness regardless.

## 2. Can a dropped re-assert be injected?

Mechanically, trivially yes — the seam is `createPty()`/`fake.write`. A test could special-case the fake so the Nth write matching `BRACKET_PASTE_START + BRACKET_PASTE_END` ("reassert-paste", `host.ts:4495`) is swallowed (pushed to a side channel, or just not pushed at all) while every other write lands normally, exactly modeling "this one write vanished."

## 3. ⭐ The deciding question: could the harness observe the difference?

**No.** The failure this candidate describes is entirely in how the real Ink TUI's composer interprets the backspace bytes it receives — as erasing keystrokes (paste already closed) vs. as literal paste content (paste still open). That interpretation happens inside the real `claude` process, on the other end of a real ConPTY, and is not modeled anywhere in this harness. The fake pty's `write()` does not parse bytes, hold a paste-open flag, or produce any output in response to what it received — dropping the re-assert write and NOT dropping it produce byte-for-byte identical harness state afterward: the same `fake.writes` array entries for the backspace burst (`BACKSPACE.repeat(l2.lastPrompt.length)`, unconditional at `host.ts:4647`), the same `busy`/`composerLen`/`giveUpOrigin` daemon-internal state, because none of that daemon-internal state reads back what the "engine" did with the bytes either — it can't, since the daemon has no feedback channel for it in production, and the harness (correctly) doesn't fabricate one.

Put concretely: any test built this way could only assert things like "exactly `lastPrompt.length` backspaces were written" or "the reassert-paste write happened before the backspace burst" — assertions that are true regardless of whether the injected drop occurred, because the harness has nothing downstream of `write()` that a drop could change. It would pass identically whether the candidate mechanism is real or not. That is a tautology, not a discriminating test.

This is not a gap specific to this card — it is stated three separate times, independently, in the existing test suite and production code, all pointing at the identical limitation:
- `pty-giveup-clear.mjs:18-20`: *"This hermetic test can only assert the BYTES-WRITTEN half (a fake pty can't model Ink's paste/composer state machine) — it proves the daemon writes the RIGHT clear byte count IFF composerLen===0... The real-engine half is the probe above."* (referring to a manual, non-hermetic probe against a real logged-in `claude`)
- `pty-submit-paste-end-retry.mjs:14-18`: *"It CANNOT model Ink's own paste state machine (a real-TUI behavior, not hermetically verifiable) — that live confirmation is the Lead's, on the next daemon restart."*
- `host.ts:4477-4480` (the paste-reassert design doc, same subsystem this candidate lives in): *"Real-`claude` confirmation of both branches... is the Lead's live-verification pass — the fake pty this file's own test drives can't model Ink's paste state machine, only that the BYTES this host writes are exactly what's intended."*

## 4. Verdict

**Not feasible at this layer, structurally — not for lack of harness sophistication, but because the fake pty has no model of the thing that would need to differ.** A harness upgrade that added a paste-bracket flag to the fake and made it swallow drops would still only prove what the *test author* decided should happen to a synthetic flag — it would validate the test's own assumption about Ink's behavior, not Ink's actual behavior, which is exactly the trap this codebase's own prior probes (`test/_probe-composer-clear.mjs`, `test/_probe-empty-paste-provocation.mjs`, both real-`claude`, manual, explicitly out of the hermetic suite) exist to avoid.

This converts the open "maybe we can do this cheaply" into a clean either/or: either accept this residual risk as unverified-by-design (matching its own doc comment, which already says so), or verify it against a **real terminal** — a manual real-`claude` probe (this repo's established pattern for exactly this class of claim) or the owner-gated ConPTY repro harness named as the next, more expensive option in the card. There is no cheaper hermetic path between those two.
