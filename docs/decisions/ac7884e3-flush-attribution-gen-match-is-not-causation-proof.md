# ac7884e3 — `worker_flush`'s gen-match verdict is the best available signal, never proof of causation

## Narrative

Card `ac7884e3`: `flushMarkerGen` records the generation `flushComposer` (`worker_flush`) most recently wrote a submit-only Enter attempt for, while that attempt's own resolution is still outstanding — consumed (cleared to null) by the same confirming-hook sites that resolve `enterConfirmed`, which is also where `lastFlushAttribution` gets its verdict.

THE UNATTRIBUTABILITY THIS CANNOT CLOSE (this card's own refusal-or-fix tradeoff, read before relying on a `true` verdict): `flushComposer` deliberately reuses the SAME `awaitReassertSettle`/`fireEnterAndVerify` ladder, under the SAME `submitGeneration`, that an ordinary in-flight give-up retry for that identical generation would also be running — see `flushComposer`'s own doc. Two Enter keystrokes for the same generation, one from each source, are indistinguishable to the engine and to this daemon: only ONE hook fires either way (validated against a real engine — see `sendEnterAndVerify`'s own doc, "a retry firing into a turn that actually already started is harmless"), so nothing here can tell "the flush's own keystroke is what broke through" from "a concurrent natural retry for the same generation broke through, and the flush's own keystroke landed as an inert no-op a moment later."

A gen-match verdict is therefore the best available signal, not proof of physical causation — it means "this generation's confirmation happened while a flush was the last action taken FOR it," which is what `lastFlushAttribution`'s own doc states plainly. Before this card existed, "did `worker_flush` work, and when?" had NO answer for the case that matters most — a confirmation landing well AFTER `flushComposer`'s own bounded wait (`awaitFlushConfirmSettle`) had already returned `confirmed:false` to its caller (the measured production case: `composerDirtyLen` cleared, confirmation ~60s later) — because that confirmation is invisible to the call that already returned. `lastFlushAttribution` is the sticky record of how the most recent `flushMarkerGen` actually resolved, read later by whoever needs to know.

## `lastFlushAttribution`'s own shape — the sticky record itself

`lastFlushAttribution` is STICKY (same convention as `lastMismatchReplay`/`lastMismatchFusion`/`lastPasteTripwireGiveUp` — never cleared, only overwritten by a later resolution). `null` means no flush attribution has EVER resolved on this session — either `worker_flush` was never called, or one was called and genuinely hasn't resolved yet (an honest "don't know yet," not conflated with either verdict below). `{attributable:true, reason:"confirmed-while-flush-marker-live", gen, resolvedAt}` is "worker_flush was the last thing done for this generation, and it went on to confirm" — a concurrent natural retry for the same generation still can't be excluded, but CAN be told apart from a flush issued when nothing else was racing, because in that case nothing else was outstanding to have caused it. Deliberately NEVER touched when `flushMarkerGen` is already null at a confirming hook (the overwhelming majority of ordinary turns have nothing to do with `worker_flush` at all) — only the two resolution branches ever write here, so a `null` reading is never manufactured by an unrelated turn quietly clobbering a real prior verdict.

## Do not

- Do not treat a `{attributable:true}` verdict from `lastFlushAttribution` as proof that `worker_flush`'s own keystroke is what broke a turn through — a concurrent natural retry for the same generation is indistinguishable to the engine and cannot be excluded.
- Do not read a gen-mismatch (`{attributable:false, reason:"marker-superseded-before-confirm"}`) as "we don't know" — it is a definitive "this specific attempt never got the chance to confirm," distinct in kind from the `null` (never resolved) case.
- Do not write to `lastFlushAttribution` from anywhere but the two resolution branches — a write from elsewhere (e.g. an unrelated turn's confirming hook when `flushMarkerGen` is already null) would clobber a real prior verdict with a manufactured `null`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.flushMarkerGen` field doc), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `//` comment markers.

The shape section above is a second site for the same card, extracted from the `lastFlushAttribution` field doc (`Live` interface, immediately below `flushMarkerGen`) as of commit `ca1117e261e56fcff271d6a0f2e5dce4579500b6` (tranche 7's HEAD). Extracted by card `0f3c76a4` (tranche 8 on `pty/host.ts`); no wording changed beyond joining wrapped lines and stripping `//` comment markers.
