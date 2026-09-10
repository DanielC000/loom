# 47532bd0 — session-steer reframed from verbatim relay into a full operator surface

## Narrative

`session-steer` (Framework §4, card `305a54fb`) is the companion's session-control ACT lever. It was originally conceived as a verbatim-relay "steer" tool. An owner redirect (decision `47532bd0`) reframed it into a full OPERATOR surface instead: on the owner's intent, the companion messages/steers/stops/resumes sessions in its granted scope, composing the action from owner intent rather than relaying a verbatim quote.

This is a deliberate departure from the rest of the catalog's content-authoring posture: Primitive B (verbatim owner quote required) does NOT apply here, unlike `board_create`'s title/body. The companion is trusted to compose the message/steer text itself, not merely echo the owner's exact words.

See `71509fd5` (docs/decisions/71509fd5-session-steer-friction-free.md) for the companion decision that made every action under this reframed surface fully friction-free (no Primitive C confirm round-trip).

## Do not

- Do not require Primitive B (verbatim owner quote) on `session_message`/`session_steer`'s composed text — that would revert the reframe this decision made deliberately.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`session-steer`'s top-of-block doc, opening paragraph): lines 1980-1987, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
