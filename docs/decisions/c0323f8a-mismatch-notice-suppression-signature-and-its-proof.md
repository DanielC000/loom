# c0323f8a — the mismatch-notice suppression signature, and the proof that gen can't repeat across distinct events

## Narrative

`Live.lastMismatchNoticeSignature` is the SIGNATURE of the last `[loom:prompt-mismatch]` session-facing notice actually enqueued. Unlike `lastMismatchReplay`/`lastMismatchFusion` (read-only PULL surfaces, overwritten unconditionally on every detection, never gating anything), this field's ONLY job is SUPPRESSING an exact repeat: if `UserPromptSubmit` fires more than once for the SAME logical turn, this detection block re-runs from scratch and, before this field existed, re-enqueued a BYTE-IDENTICAL notice as a genuinely fresh turn — never tagged, since the `[loom:possible-duplicate root:…]` machinery only ever tags a REDELIVERY of an already-queued/given-up message, and this notice is neither.

### This is a data-loss alarm — the proof that suppression is sound

Suppressing a genuinely NEW mismatch here would silently hide a real loss. Soundness of suppressing on an exact `(gen, writtenHash, reportedHash)` triple match rests entirely on `gen` (`Live.submitGeneration`) being unable to repeat across two DIFFERENT underlying events — stronger than merely "gen advances". PROOF, by READING THE CODE, not by observing a production incident:

1. `submitGeneration` is mutated ONLY by `++`, at exactly FOUR sites in `pty/host.ts`, all monotonic increments, none a reset/decrement: `submit()` (`const gen = ++live.submitGeneration;`), `healIfStuck`'s stale-busy bump, `stop()`'s graceful/hard-stop bump, `interruptForRedirect`'s Esc-cancel bump.
2. The ONLY value-other-than-increment set is `submitGeneration: 0` at `Live` construction — one construction site, `spawn()`, for every path (fresh spawn, resume, fork, `worker_recycle` successor, boot-reconcile resume) — so a resume does NOT reuse an existing `Live` and dodge the reset.
3. This field is initialized to `null` at that SAME construction site — resets in lockstep with `submitGeneration` across every boundary that resets gen. A stale signature can never survive into a fresh gen sequence.
4. The one real engine quirk on record — card `8a5bd0d0`, a second `SessionStart` under a rotated `session_id` for the SAME live pty — does NOT construct a new `Live` and does NOT touch `submitGeneration`; it mutates only `live.engineSessionId`. Checked specifically as the most plausible way this proof could be wrong; it isn't.

⇒ Within one `Live`'s lifetime, two reads of the identical `gen` can only happen if no `submit()` ran between them — meaning `live.lastPrompt` (Loom's own intended write for that generation) is STILL the same string both times. There is no way for a second, genuinely-distinct loss to exist "at gen=N" without a new `submit()` first, and a new `submit()` always bumps gen — so a full triple match cannot represent two different events.

**What this does NOT prove:** it does not establish HOW, in production, the detection block re-enters a second time with an unchanged `gen`. A literal synchronous double `deliverHook` (`UserPromptSubmit`) call for one turn is itself structurally blocked from reaching this a second time (`submitWasOutstanding = !live.enterConfirmed`, and this same case sets `enterConfirmed = true` before the detector runs, so a genuine back-to-back duplicate takes a different, harmless branch) — the real trigger for the specimens that motivated this field is UNCONFIRMED. This field guards against the symptom regardless of the trigger; it is not evidence the trigger is understood.

Never cleared, overwritten (not accumulated) by the next notice actually sent — mirrors the PULL-surface fields' own "last one wins" posture. See `lastMismatchNoticeSuppressed` below for the durable, manager-visible record of when this actually suppressed something — this field alone is not manager-visible.

### `lastMismatchNoticeSuppressed` — the durable, manager-visible counterpart (manager review)

The durable PULL-surface counterpart to a suppression decided by `lastMismatchNoticeSignature`. A suppressed alarm and no alarm are indistinguishable to any future reader unless something records that a suppression happened — a `console.log` line is fine for a human tailing the daemon's stdout, but invisible to a manager, who actually needs to know an alarm was swallowed. Mirrors `lastMismatchReplay`/`lastMismatchFusion`'s posture (read-only, never gates, overwritten — not accumulated as a struct — by the next SUPPRESSED occurrence) with one addition: `count` accumulates across repeated suppressions of the SAME signature, so "suppressed once" and "suppressed five times in a row" read differently. Reset to `count:1` the moment a DIFFERENT signature suppresses (cannot happen without an intervening real notice — see the proof above), so `count` is always "repeats of the CURRENT signature", never a lifetime total.

## Do not

- Do not suppress on anything looser than the exact `(gen, writtenHash, reportedHash)` triple — the proof above is what makes that specific match sound; a looser match could hide a genuinely new loss.
- Do not treat `lastMismatchNoticeSuppressed.count` as a lifetime total — it resets to 1 the moment a different signature suppresses.
- Do not treat the proof as evidence for WHY the detection block re-enters with an unchanged gen — that trigger is unconfirmed; the proof only shows suppression is safe regardless of the trigger.

## Source

Inline comments in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchNoticeSignature`/`lastMismatchNoticeSuppressed` field docs), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10); wording unchanged beyond joining wrapped lines and stripping `*`/`//` markers.
