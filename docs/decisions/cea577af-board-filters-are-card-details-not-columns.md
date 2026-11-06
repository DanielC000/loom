# cea577af — the board filters on card details, never on columns, and never persists a filter

Anchored from `packages/web/src/pages/Board.tsx` (the client-side view filter state). Predicates live in `packages/web/src/lib/boardFilters.ts`.

## What changed

The board's filter bar used to carry a "Column" group: one toggle per lane. The owner called it "completely unnecessary" — a lane already shows which column a card is in, so filtering by it only re-says what the layout says. It was replaced with filters on what a card row actually carries:

- **Priority** (unchanged).
- **Type** — the Conventional-Commits type parsed from the title (`fix(web): …` → `fix`); a non-conforming title buckets as `other`. Only types present on the board get a chip.
- **State** — held, deferred, policy unmet (`useCardPolicyStatus` blocking > 0), awaiting request (a PENDING Request on the card, from the app-wide `["openQuestions"]` query, matched like the card dialog's requests rail incl. legacy 8-char id prefixes), blocked by card (`blockedByOpen > 0`).
- **Epic** — a single-select over cards that have descendants. Matches the WHOLE subtree (parent OR grandparent; the hierarchy is at most two levels below a top card). The epic itself is not included.
- **Repo** — a single-select, rendered only on a project with a repo registry (the same gate as the card's repo badge).

OR within a group, AND across groups. Every filter counts toward `filterActive`, which is what drops the done-lane `?doneLimit=` window (decisions `a483cbec` / `7da27eb5`).

## Do not

- **Do not persist these filters per viewer** (localStorage or otherwise). This is the same `<Board>` as the Overview embed, the owner's primary board. A filter silently restored on a later visit hides cards, and the only sign is a count. Every mount starts unfiltered. (Manager decision on card `cea577af`.)
- **Do not re-add a column filter.** The lanes are the column view; collapse a lane (the ⋯ lane menu) if you want it out of the way.
- **Do not add a filter that does not count toward `filterActive`.** It would filter a windowed response and silently miss older done cards.
- **Do not add a filter that needs a new per-poll request.** Everything here reads the board row or an already app-wide cached query.

## Known limit

Chip counts and the Epic list are computed over the rows currently fetched. While NO filter is on, the done lane is windowed, so a count can exclude old done cards. The moment any filter turns on, the full board is fetched and the counts cover everything.
