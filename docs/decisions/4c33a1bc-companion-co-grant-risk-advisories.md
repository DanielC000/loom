# 4c33a1bc — companion grant-time co-grant risk advisories

## Narrative

Owner decision `4c33a1bc`, 2026-07-12: the grant-time co-grant RISK ADVISORIES in `packages/daemon/src/companion/capabilities.ts` are the SINGLE server-side source of truth for "this combination of grants is riskier together than apart." These are WARNINGS, never blocks — the grant always succeeds; the owner opted into the risk knowingly (option B — keep the friction-free model, but be told at grant time). Computed over a session's WHOLE resolved grant set (`computeCoGrantWarnings`), returned on the grants GET/POST/PUT responses, and rendered by the human grant UI. Deliberately kept as a small explicit slug list, not derived from per-act FrictionTier logic (which is decided per-CALL, e.g. a decisions-relay act is Tier A for a "general" decision but Tier X for a deploy/irreversible one) — the ADVISORY is about which levers were CO-GRANTED, a static grant-set fact.

`computeCoGrantWarnings` is pure + side-effect-free; returns `[]` for a benign grant set (the common case), so a single-lever grant surfaces nothing. Order is stable (primary launder risk first, then the shared-window ceiling). It computes exactly two advisories:

1. **transcript-read + session-steer LAUNDER**: `transcript_read` pulls UNTRUSTED transcript text into the owner's turn context, and a friction-free session-steer act can then commit an attacker-composed steer on that SAME owner-authored turn with no confirm — so injected instructions can be laundered from a transcript into a real cross-session action inside one benign turn. Fires when BOTH are in the grant set (transcript-read is read-only, so any grant of it counts; session-steer must be act).
2. **MULTI-Tier-A shared-window ceiling (CR LOW #4)**: 2+ DISTINCT Tier-A act capabilities share one trust window, so a confirm on the lowest-stakes one warms it for ALL of them — the effective confirmation ceiling becomes the highest-consequence Tier-A act granted, not each on its own.

Cross-project by design: `transcript-read` on project X + `session-steer` on project Y is exactly the risk, so project is deliberately ignored when computing these warnings.

## Do not

- Do not derive these advisories from per-act FrictionTier logic — that's decided per-call, while the advisory is about which levers were CO-GRANTED (a static grant-set fact).
- Do not turn these into blocks — the owner explicitly chose "warn, don't block" (option B).

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`computeCoGrantWarnings`'s top-of-function doc): lines 66-81, as of this tranche's HEAD. Relocated by card `2e703a3d` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
