# 1039e892 — owner sign-off: board-write guardrails for the companion capability catalog

## Narrative

Owner sign-off `1039e892` fixed several companion capability-lever guardrails at once, across multiple levers in `packages/daemon/src/companion/capabilities.ts`:

**No cross-project delete tool.** `board-reach`'s ACT half (`board_create`/`board_update`, card `7975c034`) deliberately ships with NO delete tool at all — no cross-project delete from chat, ever.

**Primitive C is mandatory for every board write, not merely recommended.** The design note's own open fork initially left the propose/confirm round-trip as a recommended-but-optional hardening for `board_create`/`board_update`. Owner sign-off `1039e892` made it MANDATORY instead: both tools always propose-then-confirm (mirroring `decision_resolve`'s own CR-hardened Primitive-C shape), with no lighter-weight direct-commit path.

**Conservative default for `decisionClasses`.** `decision_resolve`'s `decisionClasses` allowlist (per-project grant config) defaults to admitting NOTHING when absent/empty — mirroring `attention-push`'s own "absent config ⇒ nothing subscribed" default — so deploy/irreversible (and even `general`) decisions all require the owner to explicitly opt in.

**Recommended default roots for `media-out`.** The sign-off also named the recommended defaults for `media-out`'s `config_json.roots` allowlist (vault `Assets/`, the session scratch dir) — but the lever's own code applies no implicit fallback: an empty configured allowlist still delivers nothing, exactly like an empty `decisionClasses`.

## Do not

- Do not add a delete tool to `board-reach` without a fresh owner sign-off — the no-delete posture was a deliberate choice, not an oversight.
- Do not make Primitive C optional/skippable for `board_create`/`board_update` — it was explicitly upgraded from recommended to mandatory.
- Do not give `decisionClasses` or `media-out`'s `roots` an implicit non-empty fallback — an absent/empty allowlist must continue to admit/deliver nothing.

## Source

Inline comments in `packages/daemon/src/companion/capabilities.ts`: the `board-reach` top-of-block doc (the "no delete tool" and "Primitive C MANDATORY" sentences) and the `media-out` top-of-block doc (the "recommended defaults" sentence), as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
