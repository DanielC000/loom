# 691d02e1 — the pasted-content wrap recognizer accepts the CLI's own escaped nested `<pasted_content`/`</pasted_content` tag

**SUPERSEDED by card `aeb62a82`** (`docs/decisions/aeb62a82-*.md`): `unescapeNestedPastedContentTag` (the
reverse-direction reversal this whole record describes) is REMOVED, replaced by a forward-direction
`escapeNestedPastedContentTag` comparison. The "one accepted failure direction: false alarm, never a
missed loss" section below, and the "Do not" item about never widening the reversal, describe code that
no longer exists — kept here as history of why the old approach existed, not as a current constraint.

## Narrative

Card 691d02e1 reported `[loom:prompt-mismatch]` arming UNMATCHED ("possible LOSS") on 3 real turns that
all arrived intact: a Lead `worker_report` relay (gen=2, lenDelta +63 vs the clean +58 overhead), and two
gen=1 kickoffs (lenDelta +61 and +59). All three bodies discuss card 282107e8/7c1487c8 — the pasted-content
wrap mechanism itself — and so all three literally quote its own syntax, `<pasted_content id="...">` /
`</pasted_content id="...">`, as prose.

Root cause (verified byte-exact): the current CLI (2.1.299) escapes a literal `<pasted_content` or
`</pasted_content` occurrence found WITHIN the pasted body, by inserting a single `\` right after the `<`
(`<pasted_content` → `<\pasted_content`, `</pasted_content` → `<\/pasted_content`) — almost certainly to
stop a nested lookalike string from being mistaken for the real outer wrap boundary. `PASTED_CONTENT_WRAP_RE`
itself matches correctly in all 3 specimens (the outer framing is intact); only the inner equality check
(`m[2] === intended` / `intended.trimEnd()`) missed this one specific, narrow transform.

Method (reusable, same as `7c1487c8`'s own): map the loom session id to the engine session id via
`[hook] SessionStart` in `daemon-output.log`, read the engine's own `<engine-session>.jsonl`, and match the
user turn by `fnv1a32` against the logged `reportedHash`.

Specimen 1 (Lead session `c5be87b4`, gen=2, msgId `79613033`) — full byte-exact proof. Reconstructed
Loom's own composed text from source (`sessions/service.ts`'s `[loom:worker-report] worker <id> (task <id>)
— <status>: <summary> | needs: <needs> | ctx: unknown` template, filled with the real `status`/`summary`/
`needs` pulled from worker `3329415e`'s own transcript `worker_report` tool-call input). Reconstruction =
9211 chars = `writtenLen` exactly. Diffed against the real reported text (9274 chars, `reportedHash`
`16176973`, read from the Lead's own engine transcript): exactly 5 single-character insertions, each a `\`
right after a literal `<` immediately before `pasted_content` or `/pasted_content`, nothing else differs
anywhere. Removing those 5 backslashes reproduces `intended` byte-for-byte, 100%.

Specimen 2 (worker `3329415e`'s own gen=1 kickoff, written 75346 → reported 75407) — structural
confirmation: inner has 2 escaped-open + 1 escaped-close occurrences (3 insertions); stripping them brings
inner from 75349 → 75346 = `writtenLen` exactly. (The literal kickoff text itself isn't recoverable — Loom
doesn't log kickoff bodies — but the length match after reversing this one narrow transform is not a
coincidence.)

Specimen 3 (Code Reviewer `c88d5c42`'s own gen=1 kickoff, written 62072 → reported 62131) — same: 1
escaped-open occurrence; stripping it brings inner from 62073 → 62072 = `writtenLen` exactly.

## Why suppression, not a diagnostic-only near-miss

The sibling near-misses (`b1cc4f01` one-char deficit, `ff871b77`/`79999395` 1-2 char excess, `dccb6290`
zero-delta divergence) all stayed diagnostic-only, even with corroborating specimens, because their shape
is a generic length/position heuristic that COULD coincide with a genuine partial loss of the same size —
accepting them would risk masking a real drop that merely happens to look the same. This case is
different in kind: the exact mechanism is known (a specific, deterministic, CLI-side escape of two named
literal substrings), the reversal only ever REMOVES characters it recognizes by exact substring match, and
the caller still runs a full exact-equality check against `intended`/`intended.trimEnd()` afterward — so
any OTHER divergence anywhere in `inner`, including one coincidentally the same size as an escape, still
fails that check and still fires the notice. The precise claim (Code Reviewer `ee0ec098`, round 2): the
reversal only ever equates two strings that differ by a backslash inserted immediately after `<` and
immediately before `pasted_content`/`/pasted_content` — a position no genuine content loss can produce,
since a loss removes or substitutes characters, it does not insert a backslash at that exact tag position.
`packages/daemon/test/pty-prompt-mismatch.mjs` scenarios 6y/6z pin why this must be exact on BOTH axes (the
`<` anchor AND the literal `pasted_content` suffix), not either alone — each scenario's own comment names
which of two widened implementations (strip every backslash; drop the `<` anchor) it alone defeats, and
both were verified RED by actually patching compiled `dist/pty/host.js` each way and restoring it
byte-identical afterward (`cmp`-verified), not just reasoned about.

## The one accepted failure direction: false alarm, never a missed loss

If `intended` itself already contains the literal substring `<\pasted_content` or `<\/pasted_content` as
real content (not CLI-inserted), the global reversal strips that pre-existing backslash too when it's
reached (only when a direct match already failed for some other reason), which can turn an otherwise
complete, correct transmission into a reported mismatch. This is a false ALARM — the session-facing
notice over-fires — never a masked loss: the reversal is removal-only, so it cannot turn a genuine
divergence elsewhere into a match, and the degenerate "both sides already match" case is caught by the
direct-equality check before this reversal ever runs. Accepted and pinned by test (see below); not
treated as a defect to fix without a real specimen showing it matters in practice.

## Do not

- Do not widen the reversal beyond the exact two substrings `<\pasted_content` / `<\/pasted_content` →
  `<pasted_content` / `</pasted_content` without a new, verified specimen — this is not a general unescape.
- Do not apply this reversal to `reported` as a whole, or anywhere outside `isRecognizedPastedContentWrap`'s
  own acceptance check — in particular, `findRecognizedPastedContentWrapOfPriorWrite` (`dc92f4b6`) keeps its
  own `m[2] === intended`-only equality; extending the same reversal there is a plausible follow-up but is
  explicitly out of scope for this card (its own do-not-relax posture is unchanged). Code Reviewer `ee0ec098`
  noted the consequence directly: that function would MISS a late echo of an earlier generation's own write
  if that write happened to contain this same escaped shape — but a miss there fails toward a false alarm
  (the mismatch stays unrecognized and still notifies), never toward a mask, same failure direction as the
  one accepted above, and with no real specimen yet showing it matters. Left unchanged deliberately, not
  overlooked.
  **Sanctioned exception (card `fc82dd76`):** `purgeConfirmedGiveUpRequeueCore` (host.ts, decision
  `0658d6d8`) DOES apply this same reversal, as an additional candidate signature alongside that path's
  existing raw and unwrapped checks — a different consumer, with its own genuine specimen (a give-up body
  quoting the tag syntax, escaped by the CLI on echo, never purged). **The safety argument above does NOT
  carry over to that consumer unchanged:** there, a false match only produces a false ALARM; in the purge
  path, a false match PURGES a still-queued requeue, so the failure direction flips to a possible LOSS —
  see `0658d6d8`'s own addendum for that path's separately-reasoned, accepted residual. The underlying
  reversal's own narrowness (pinned here by scenarios 6y/6z) is unchanged and still governs both
  consumers; only the SET of call sites widens, by exactly this one named exception.
- Do not treat the `ff871b77` 1-2 char excess population as PROVEN to be this same mechanism — plausible
  (1-2 occurrences of the same literal substring would produce exactly 1-2 extra chars) but not provable
  retroactively; Loom does not log kickoff body text, so there is no way to re-check those 3 historical
  specimens' actual content.
- Do not read the false-alarm failure mode above as something to "fix" by narrowing further (e.g. by
  requiring the escaped form NOT appear verbatim in `intended`) without a real specimen motivating it — the
  current form is deliberately the simplest reversal that explains all 3 known specimens exactly.

## Source

Card `691d02e1`, worker investigation 2026-10-14; manager approved suppression (not diagnostic-only) given
the byte-exact reconstruction, same session, same day. Code Reviewer `ee0ec098` shipped it, with a
follow-up round the same day pinning the reversal's narrowness (6y/6z) and sharpening this record's own
wording.
