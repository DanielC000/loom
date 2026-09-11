# a9e4240f — the reorder scan's same-sender equality check is a third copy missing `proactive`, latent not live

## Narrative

Card a9e4240f (code review finding): `enqueueStdin`'s reorder-on-enqueue scan (the same-sender lookback that decides where to splice a new agent-kind arrival — see cards eac3464d/e01687ea) matches a candidate on `kind === "agent"`, `senderId`, and `route` alone — a THIRD copy of the same-sender equality set (route/senderId/proactive) that `drainPending`'s own coalescing condition already checks in two other places. This copy omits `proactive`.

Without `proactive` in the comparison, this scan could place a new entry adjacent to a `candidate` whose `proactive` differs, manufacturing an adjacency that `drainPending`'s own equalized-run condition (which DOES check `proactive`) would then correctly refuse to coalesce — a splice that sets up a pairing the drain side immediately rejects.

**HARMLESS TODAY, not by construction:** this is the SAME unreachability as `drainPending`'s own two sites — every real `proactive` producer omits `senderId` entirely, so `senderKey` is `null` and the outer `senderKey !== null` gate skips this whole scan before the omission can matter. The gap is latent, not live.

Left uncorrected, this is a THIRD site that would need re-deriving the identical fix if that unreachability is ever lifted (e.g. a future producer starts passing both `proactive` and a real `senderId` together) — the same risk class as any duplicated equality check: fixing two of three copies and missing the third.

## Do not

- Do not treat this comparison's omission of `proactive` as already fixed by `drainPending`'s own two (correct) copies — this is a separate, third site that silently diverges from them.
- Do not assume harmlessness here is permanent — it depends entirely on real `proactive` producers continuing to omit `senderId`; re-check this site if that ever changes.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`enqueueStdin`'s same-sender reorder scan, the same-sender equality check just before the `insertAt = i + 1` splice), as of commit `5cb06da7d` (`fix(pty): archive at BOTH points a give-up signature can be superseded`). Relocated by card `9145a86f` (tranche 26 on `pty/host.ts`); wording condensed, no clause dropped.

## MAJOR-2 — the route-keyed branch's own proactive equalization (the second of the "two other places")

Card a9e4240f (MAJOR-2, sibling finding to card `66b78175`'s same-sender-branch fix — see
`docs/decisions/66b78175-…md`): `drainPending`'s ROUTE-KEYED branch (`else`, the branch a
`coalesceAgentMessages:true` agent-kind run actually takes) ALSO read `drained[0]!.proactive` HEAD-ONLY,
the same hazard `66b78175` fixed in the same-sender branch above it. Equalized unconditionally (not gated
on the `coalesceAgentMessages` toggle) — cheapest, safe-by-construction, and harmless on the untoggled
default path, where no `"warning"`-kind producer sets `proactive` today.

This IS the second of the "two other places" `drainPending`'s own coalescing condition already checks
`proactive` correctly, referenced by this record's main Narrative above when describing `enqueueStdin`'s
reorder scan as a "third copy" — `66b78175`'s same-sender-branch fix is the first.

Regression-guarded by the SAME suite as `66b78175`
(`packages/daemon/test/pty-agent-sender-coalesce-proactive.mjs`, cases D/E/F, run against a separate host
instance constructed with `{ coalesceAgentMessages: true }`): differing `proactive` (both directions) must
NOT coalesce on this branch either; matching `proactive` still does (positive control).

## Do not (2)

- Do not gate the route-keyed branch's own `proactive` equalization on the `coalesceAgentMessages` toggle —
  apply it unconditionally, the same as the same-sender branch's fix.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`drainPending`'s route-keyed branch, the
`proactiveKey` doc), commit `5cb06da7d` (2026-09-02). Relocated by card `0d9bbbf4` (tranche 31 on
`pty/host.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and
stripping `//` comment markers.

## MINOR-1 — (unrelated decision, same card id, `pty/host.ts`)

Card a9e4240f (MINOR-1, a distinct finding sharing this card id — not the same-sender-equality family
above): the `onDeliver` call at the content-match purge site in `purgeConfirmedGiveUpRequeueCore`
wasn't guarded, unlike this file's other two `onDeliver` call sites (`consumePending`, `drainPending`),
both of which wrap the call in try/catch with an explicit "never break the pull/drain" comment; this
one didn't, with no stated reason.

LATENT, not a live defect: an unguarded throw here would abort the splice loop mid-way (after the map
entries above it are already deleted), leaving some duplicates purged and some not, and skipping the
rest of the UserPromptSubmit handler — but the only production supplier (`sessions/service.ts`'s
`resolveQueuedMessage`) is already wrapped in its own try/catch, so nothing reaches this path able to
throw today. Fixed as consistency, for the next supplier.

## Do not (3)

- Do not assume this guard is load-bearing today — it is a consistency fix for a currently-unreachable
  throw (the sole production caller already catches), not a fix for an observed failure.

## Source (this section only)

Inline comment in `packages/daemon/src/pty/host.ts` (`purgeConfirmedGiveUpRequeueCore`'s content-match
purge loop, the `Card a9e4240f (MINOR-1)` paragraph immediately above the guarded `onDeliver` call),
commit `5cb06da7d` (2026-09-02). Relocated by card `09a1354e` (tranche 46 on `pty/host.ts`); condensed
and reworded, not verbatim. Not the same decision as the sections above it — see the header.
