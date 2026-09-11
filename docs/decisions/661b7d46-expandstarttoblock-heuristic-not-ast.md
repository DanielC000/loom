# 661b7d46 — expandStartToBlock is a heuristic stand-in for "the enclosing symbol", not AST

`expandStartToBlock` (in `packages/daemon/assets/decision-records.mjs`) is a heuristic stand-in
for "the enclosing symbol" (card 661b7d46's own wording) — not a real AST symbol boundary —
chosen because it's cheap, dependency-free, and mirrors a heuristic already used elsewhere in
this repo (`docs/investigations/e3faa8ac-fixed-wait-polarity`) for the same "which block is this
line part of" question.

## Source

`packages/daemon/assets/decision-records.mjs`: `expandStartToBlock`'s own doc comment.
