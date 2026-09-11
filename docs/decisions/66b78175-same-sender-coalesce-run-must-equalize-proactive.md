# 66b78175 — the same-sender coalesce run must equalize `proactive`, not just `route`/`senderId`

## Narrative

Card 66b78175: `drainPending`'s same-sender agent-kind coalesce run's own `submit()` call reads
`drained[0]!.proactive` HEAD-ONLY (like `route`/`senderId`, NOT per-member) — so unlike `route`/`senderId`,
the run's own while-loop equality set did NOT originally include `proactive`, and two same-sender/same-route
agent entries with DIFFERING `proactive` could coalesce into one turn with the tail's flag silently lost
the instant it coalesces behind a mismatched head — in EITHER direction: a `proactive:true` tail behind a
non-proactive head has its flag discarded (`getActiveTurnIsProactive()` would read `false` even though a
proactive-tagged message was in the turn), and — the reverse case — a non-proactive tail behind a
`proactive:true` head has the whole turn silently read as proactive (`getActiveTurnIsProactive()` would
read `true` even though the tail was never tagged that way).

Verified this executes against the mechanism directly — not reachable via any production call site AT THE
TIME this card was filed (every real `proactive` producer passes senderId-less args), but card `4458dd9e`
was actively considering threading `senderId` at those sites, which would make it live.

THE REMEDY (card 66b78175 DoD-1, option (a) — cheapest, makes it safe by construction exactly like
`route`/`senderId`): add `proactive` to the same-sender run's equality set, so a mismatch BREAKS the run
instead of silently coalescing. Rejected alternative (explicitly ruled out): OR-ing the flags together in
`submit()` — that would mis-tag a batch containing one proactive member as an entirely proactive
(system-initiated) turn, wrong in the user-visible direction. `proactive` is always a real boolean by the
time an entry reaches `pending` (`enqueueStdin` defaults the param to `false`, never leaves it undefined),
but the `?? false` here matches the defensive style already used for `senderId`.

Regression-guarded by `packages/daemon/test/pty-agent-sender-coalesce-proactive.mjs` (cases A/B/C):
differing `proactive` (both directions) must NOT coalesce; matching `proactive` still does (positive
control).

## Do not

- Do not let the same-sender run's equality set omit `proactive` — a proactive/non-proactive mismatch must
  break the run, not silently coalesce and discard the tail's flag.
- Do not remedy this by OR-ing `proactive` flags together in `submit()` — that mis-tags a mixed batch as
  entirely proactive, the wrong direction for a user-visible signal.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`drainPending`'s same-sender branch, the
`proactiveKey` doc), commit `c9d9e496d` (2026-09-01). Relocated by card `0d9bbbf4` (tranche 31 on
`pty/host.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and
stripping `//` comment markers.

## The route-keyed branch has the same gap — see card `a9e4240f`'s own record

Card a9e4240f (MAJOR-2) found the SIBLING gap in `drainPending`'s route-keyed branch (the one a
`coalesceAgentMessages:true` agent-kind run actually takes) — same hazard, same remedy, a separate site.
That fix is documented under its own id, not duplicated here: see
`docs/decisions/a9e4240f-same-sender-equality-third-copy-omits-proactive-latent-not-live.md`.
