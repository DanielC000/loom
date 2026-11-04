# a483cbec — the board's done lane is fetched in windows while unfiltered

Anchored from `packages/daemon/src/gateway/server.ts` (the `GET /api/projects/:id/board` handler) and `packages/web/src/pages/Board.tsx` (`DONE_LANE_PAGE`).

Phase 2 of the done-column work. Phase 1 (`7da27eb5`, `docs/decisions/7da27eb5-done-lane-render-cap.md`) capped what the lane RENDERS; this caps what it FETCHES. Read 7da27eb5 first — every prohibition in it still stands, and this record only narrows one of them.

## What was left to win

7da27eb5 took first-live-card at 4,763 done from 1,596 ms to 1,024 ms by rendering 50 cards instead of 4,763. Its own record then attributed the remaining ~680 ms over the empty-done baseline (343 ms) to the payload layer: ~3.4 MB fetched and `JSON.parse`d every 4 s poll, plus `titleById` / `pickerCards` / `shownTasks` / `.sort(byRecentlyDone)` walking the full array.

**That attribution did not survive measurement here** — see "Measured" below, which finds no first-paint cost in the payload layer at all on loopback. What windowing does buy is the bytes themselves and the route's own response time. The change is worth having for those; it is not worth having for the first-paint number its predecessor predicted.

Card `1b4ad86e` measured the other candidate — a bodyless `SELECT` for done rows — and shipped nothing: done bodies are already stripped from the response by `toBoardTasks`, and SQLite decodes a TEXT column's full value for almost any expression on it (see project memory `sqlite-text-expressions-decode-full-value`), so there was no engine-level win to collect. Windowing was the remaining lever.

## The shape

`?doneLimit=N` is **opt-in**. Omitting it — or sending anything unparseable — returns today's response, byte-for-byte, with no extra keys at all. With it, the response carries the N most-recently-done terminal-lane cards plus two new keys: `doneTotal` (the lane's TRUE length) and `doneLimit` (the EFFECTIVE post-parse window, so a client can tell a honoured window from a coerced one rather than assuming the number it sent came back — the same reason `GET /api/archived-sessions` echoes its own post-clamp `limit`).

**The ordering comparator moved to `packages/shared`.** `byRecentlyDone` now lives in `shared/src/types.ts` and both readers import it: the web lane sorts by it, and the route picks *which* N cards a window contains by it. A second copy would be a window that disagrees with the lane it fills — the client would render the server's "newest N" in some other order, or page past cards the server never sent.

**Board.tsx's windowed fetch has its own query key**, `["board", projectId, doneLimit]`. The bare `["board", projectId]` entry is deliberately left holding the full, unwindowed set, because four other consumers read it and every one of them would be silently truncated by a window:

| Consumer | What it needs the full done set for |
|---|---|
| `ColumnManager` | per-column counts, terminal lane included |
| `RunHistory` / `PlatformFindings` | resolving an OLD done card by id |
| `ProjectUsage` | historical task ids |
| `ProjectHome` | rollup totals + `taskTitlesById` |

(`WorkspaceHome` sums only open lanes, so it is unaffected either way.) The key EXTENDS rather than replaces the shared one, so `invalidateQueries(["board", projectId])` still reaches every windowed entry too — react-query matches a key by prefix.

**`filterActive` drops the param entirely.** The moment a search / priority / column filter is on, the board fetches the whole board. This is 7da27eb5's load-bearing invariant pushed one layer down: the cap must never be applied before the filter, and a *server* window is the strongest possible form of "applied before the filter" — no amount of client-side filtering can reach a card that was never sent.

**"Show N more" is a refetch of the next page**, not a client-side unhide: it bumps the window by `DONE_LANE_PAGE`, which changes the query key. `placeholderData: keepPreviousData` covers both that bump and the windowed↔full switch, so neither flashes an empty lane; `isPlaceholderData` is the button's loading state (label, `disabled`, `aria-busy`).

## Which lane got windowed is resolved by the DAEMON's resolver, not the board's

`Board.tsx` has two different notions of "the done lane" and they are **not** interchangeable:

- `isDoneColumn(col)` — role `terminal`, else a key-substring guess. Drives the lane's tint and sort. **Unchanged.**
- `columnKeyForRole(cols, "terminal")` — role `terminal`, else the LAST column. The daemon's own resolver, and what the route windows by.

On a legacy role-less board these genuinely disagree: for columns `[inbox, done, archive]`, `columnKeyForRole` answers `archive` and `isDoneColumn` answers `done`. So the client identifies the windowed lane with `columnKeyForRole` — exact agreement with the server, by construction — and keeps `isDoneColumn` for tint and sort. Attributing one lane's window and total to a different lane is worse than not windowing at all.

## Do not

- **Do not make the window the default.** The four consumers above read `["board", projectId]` for the whole done set; a default window truncates every one of them, and three of them (resolve-by-id, historical ids, rollup totals) fail *silently* and wrongly rather than visibly.
- **Do not send `doneLimit` while a filter is active.** `board-done-window.spec.ts`'s filter test exists for exactly this, and it was proven by mutant: leaving the param on makes a search for an old done card return "no matches" for a card that exists. This is 7da27eb5's rule, not a new one.
- **Do not derive the lane header's count, or the soft-WIP readout, from the fetched rows.** Both read `laneTotal` (the server's `doneTotal`) when the lane came back windowed. `tasks.length` and `cardCount` only span what was FETCHED, so on a windowed lane both read the window and the lane looks like data loss. Proven by mutant: breaking `doneTotal` alone reads `(50)` instead of `(61)` and makes the reveal button vanish, because `hidden` computes to 0.
- **Do not identify the windowed lane with `isDoneColumn`.** See the section above — it disagrees with the server on a role-less board.
- **Do not feed `boardRollup` the windowed task list.** It treats its `tasks` argument as the UNIVERSE it counts children against, so a windowed list under-counts a live parent's `childCount` by however many of its children the window dropped. Roll up over the full list, then look up per returned row; `board-done-window.mjs` case F pins this.
- **Do not clamp `doneLimit` downward.** There is nothing for a ceiling to protect: the uncapped full set is already one request away (omit the param). A clamp would only make a large window silently lie about what it returned.
- **Do not make the windowed reveal load the whole lane in one click.** One click on a 4,763-card lane re-pays the entire payload this window exists to avoid. It loads one page (or just the remainder, when that is smaller).
- **Do not treat `doneTotal`/`doneLimit` as falsy-checkable.** They are ABSENT on an unwindowed response, and `doneTotal: 0` / `doneLimit: 0` are both legitimate windowed values. Read `doneTotal !== undefined` as "this response is windowed".
- **Do not pin a test's "before" snapshot with `git show HEAD:`.** `board-done-window.mjs` case A compares the default response against the pre-change handler expression transcribed from a FIXED sha (`2ff0e2eb`). A `HEAD:` snapshot pins to whatever HEAD is, so it can never fail once the change itself is HEAD.

## 7da27eb5's "do not move the reveal state up into Board" — narrowed, not broken

That prohibition said the reveal belongs in `Column` so it is genuinely per-lane. Both halves survive, split by which kind of paging is in play:

- The **client-side** reveal (`expanded`) stays in `Column`, exactly as before. It is still what applies when the whole set is in hand — i.e. while a filter is active, or when nothing asked for a window.
- The **server window** (`doneWindow`) necessarily lives in `Board`, because it is a query parameter and the query lives there. Nothing per-lane is lost by that: a board has exactly one terminal lane (`columnKeyForRole(cols, "terminal")` returns one key), so the window was never a per-lane quantity to begin with. It is reset on a project switch for the same reason `<Column>`'s key carries the project id.

## Measured — and the first-paint win did NOT materialize

Isolated daemon (own short `LOOM_HOME` under `os.tmpdir()`, port 4411, `LOOM_DEV=0`, first-run marker pre-stamped so no real claude could spawn), ONE project seeded to 4,763 done + 107 live, every card carrying a ~700-byte body. Real chromium at 1440×900. The real `~/.loom` DB was never opened. Fixture identity was asserted, not assumed: every live card is titled `LIVE-SENTINEL-<i>` and both legs wait on that exact string, so a silent fallback to a sibling worker's daemon would fail rather than produce a plausible wrong number.

"before" is the SAME tree with one line mutated — `const doneLimit = null` in `Board.tsx`, i.e. a client that never sends the param — rebuilt with `vite build`. So the two legs differ only in whether the client windows, against one identical server.

| | before (full fetch) | after (`?doneLimit=50`) | instrument |
|---|---|---|---|
| board payload | **3,091 KB** | **172 KB** | identical in all 6 runs |
| poll payload, every 4 s forever | **3,091 KB** | **172 KB** | — |
| route response time, loopback (incl. `JSON.stringify` + transfer) | **193 / 176 ms** | **138 / 116 ms** | paired INTERLEAVED, 11 trials each, 2 runs |
| poll transfer time, avg per poll | 118 ms | 86 / 89 ms | 3 trials, real churn |
| poll main-thread block (`longtask` total) | **0 ms** | **0 ms** | 3 trials × 2 runs, real churn |
| first LIVE-lane card visible | 310 / 362 ms | 276 / 306 / 336 / 355 ms | 3 trials per run; **the two legs overlap entirely** |
| DOM cards rendered | 157 | 157 | 7da27eb5's render cap, unchanged |

**The payload win is real and large; the first-paint win is not there at all.** Over loopback, a 3 MB response completes at `responseEnd` 277–317 ms and a 172 KB one at 251–305 ms — the request is not even issued until the bundle has mounted React, and after that the size barely registers. First-live-card is dominated by bundle parse + mount, not by the board payload. The same goes for the poll: its main-thread block was already **0 ms in both legs**, because 7da27eb5 removed the render work, and fetch + `JSON.parse` + the `O(n)` array walks never produce a single >50 ms long task even at 4,870 rows.

So what this card actually buys, on the evidence: **~94% fewer bytes** per board read (and per 4 s poll, forever) and **~30% off the route's own response time**, which is the fleet-wide half — that handler is synchronous `better-sqlite3` plus `JSON.stringify` on the daemon's single event loop, so every request it isn't blocking is a request some other project's session isn't waiting behind. It buys no measurable local first paint.

### Two cautions about these numbers

- **The route-time figure is only trustworthy because it is interleaved.** Timing one URL shape's whole block and then the other's made the first block pay cold-JIT costs and read 70–170 ms slower, which looks exactly like a real handler win for whichever shape ran second — one such run read 155 ms full vs 157 ms windowed, i.e. no difference at all. Between-run drift on this host is large on its own (full-set medians of 155 / 176 / 179 / 193 / 235 / 333 ms across six runs). Only the alternating, same-process comparison separates the two, and it replicated (193→138, then 176→116).
- **These first-paint numbers are NOT comparable with 7da27eb5's.** That record measured 1,596 ms before / 1,024 ms after at the same nominal fixture size, where this harness reads 276–362 ms for a board of the same shape. A 3× gap in the baseline means the two methods measure different things (most likely a warm browser context with the bundle already cached, and "first live card in the DOM" via `MutationObserver` rather than paint). Nothing here falsifies that record's numbers — but project memory `board-done-column-cost-is-client-render-not-server` attributes ~680 ms of remaining first-paint cost to the payload layer, and **this measurement does not reproduce any first-paint cost in that layer**. Treat the payload-layer-costs-first-paint claim as unconfirmed under this method, not as the established reason to want this change.

### Bound on all of it

Same bound as 7da27eb5's, and it still matters: an idle isolated daemon, ONE project, no live sessions or terminals, and a **loopback** client. The owner's Overview mounts live terminals above the board embed and their daemon serves the whole fleet, so these are FLOORS. Behaviour under fleet load is unmeasured — and so is the case where the byte saving should matter most: a client reached over the gateway tunnel rather than loopback, where 2.9 MB every 4 s is real bandwidth rather than a memcpy.

### One cost, stated

On the Atlas project node, `ProjectHome` holds `["board", projectId]` (full set, `staleTime: 30_000`, no poll) while the board body it mounts holds `["board", projectId, 50]` (windowed, 4 s poll). That is two entries where there was one, so the full set is fetched once on mount in addition to the window. The *polled* request — the one that repeats every 4 s forever — is the small one, which is the trade this card is making. Classic `/board` mounts no second consumer and pays nothing.
