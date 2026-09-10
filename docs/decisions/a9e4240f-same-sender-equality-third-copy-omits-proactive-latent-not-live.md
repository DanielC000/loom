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
