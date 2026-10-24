# 260fb29a — a deep-link query survives a legacy redirect, and only a VISIBLE board consumes `?task=`

Card `260fb29a`. Both defects were found by Atlas P2-10 (card `3ed3dc31`) and pre-date Atlas: each is a way for a page-level deep-link query to be destroyed in transit while every surface involved reports success.

The app has two page-level deep links — `?task=<id>` (opens that card's dialog, `pages/Board.tsx`) and `?profile=<id>&grant=<connId>` (pre-selects that profile with the connection ticked but unsaved, `pages/Profiles.tsx`). Neither is read by a shell or a frame; both are read by the page component. That is exactly why both failures are silent: the consumer never runs, so nothing logs, nothing 404s, and the reader lands on a page that looks perfectly healthy and simply isn't the state they asked for.

## Defect 1 — `nav.tsx`'s `redirect()` dropped the query

`redirect(from, to)` built `<Navigate to={to} replace />` from a plain path string. React Router resolves that string as given, so the incoming search was discarded: `/profiles?profile=<id>&grant=<cap>` landed on a bare Actors page with nothing pre-selected, in **both** shells.

P2-10 recorded this as parity rather than a bug, on the reasoning that carrying a stale page's query onto a different page is not obviously right and nothing linked to those paths with a query. That reading does not survive what a legacy redirect actually is: it is a **rename**, not a hop to a different page. `/profiles` and `/actors` are the same surface at two addresses, so the params a user pasted at the old one were always meant for the page they land on. Dropping them makes every deep link ever issued at a renamed address quietly stop working, with no way for the reader to tell the link from a broken one.

`QueryPreservingRedirect` (`packages/web/src/nav.tsx`) replaces it: the incoming search is merged with the row's own `?tab=` and both shells mount the one element, so neither can drift from the other.

**The collision rule is that the ROW'S OWN target wins.** A row's `?tab=` is its whole meaning — `/skills` means "the Skills tab of `/actors`" — so `/skills?tab=profiles` must still land on Skills. Each colliding key is replaced *whole* (every incoming value for that key dropped, every target value kept), so a repeated key cannot smuggle a second value in beside the target's own.

### The retirement hop is part of this fix, not scope creep

One declared row chains through a second redirect under Atlas alone: `/workspace` → `/projects` (a `LEGACY_REDIRECTS` row) → `/home` (an `ATLAS_RETIREMENTS` row, card `5afd71bd`, mounted by `components/AtlasShell.tsx`). Fixing only the first hop would leave that row preserving its query under the classic shell and dropping it under Atlas — a per-shell divergence in the one place both shells are meant to agree, and a failure of the card's own "every row" requirement. So the retirement hop renders `QueryPreservingRedirect` too.

`RehomedToNodeTab` (the card `41eab0eb` hop, same file) already preserved and translated the incoming query, and is unchanged.

## Defect 2 — `/platform?task=<id>` with no `tab=board` was consumed invisibly

The Atlas Platform node keeps **all five panels mounted** and hides the inactive ones with `hidden` (card `c07ff42a`; the owner's standing rule that a tab click is not consent to discard unfinished input). So its `<Board>` is live on every tab. A `?task=` arriving without `tab=board` was therefore consumed by a board inside a hidden panel: the dialog opened where nobody could see it, and the param was cleared on the way out, so no visible board ever got a chance at it.

The project node does **not** have this defect, and the reason is worth recording so a future reader does not "fix" it there: every project-node address renders at least one *visible* `<Board>` (the Overview tab embeds the whole board, and the Deck tab does too), so even when the parked Board-tab body also consumes the param, a visible board consumes it as well and opens the dialog where it can be seen.

The fix is two halves:

1. **The address is rewritten, not the derived tab.** `AtlasPlatformLayout` renders a `<Navigate replace>` to `/platform?tab=board&…` when a `?task=` arrives on any other tab. Deriving `tab = "board"` from the param's presence *without* changing the URL would re-hide the dialog the moment Board clears the param it consumed, so the rewrite is what actually makes the link work.
2. **`Board` takes a `deepLinks` prop** (default `true`, so every existing mount is unchanged). The Platform node passes `tab === "board"`, so a hidden panel neither consumes nor clears the param.

The `<Navigate>` must render **beside** the panels, never instead of them: returning it alone unmounts all five and destroys whatever unfinished input they hold.

`?task=` wins over an explicit `tab=<other>`: a URL carrying both is self-contradictory, only one half of it can be served, and the Board tab is the only tab that can serve either.

### Why half 2 is load-bearing — and why no fresh page load can show it

This was **measured in both polarities**, on real builds, because reasoning alone got it wrong in both directions.

With half 2 removed and half 1 kept, **every e2e leg in `atlas-deep-links.spec.ts` still passes.** The reason is timing, not correctness: a fresh document load starts with a cold react-query board cache, so `board.data` is `undefined` on the first render and the hidden board's effect no-ops until after the `<Navigate>` has already landed.

Warm that cache and the race is real. Same build, same removal, a warm cache plus a **client-side** arrival at `/platform?task=<id>`:

| half 2 | URL after arrival | board panel | dialogs |
|---|---|---|---|
| present | `/platform?tab=board` | visible | 1, visible |
| removed | `/platform` (`tab=board` **wiped**) | hidden | **0** |

The mechanism: the hidden board's effect fires in the *same* flush as the `<Navigate>`, and `setSearchParams` computes its next query from the params of the render that produced the effect — which never had `tab=board` in it. Its "delete task" therefore writes back a query missing the tab the `<Navigate>` just added, and the reader lands on Home with nothing open.

That state is **not reachable from any in-app link today** — every route to `/platform?task=` is a full document load, which is cold. It is one small change from being reachable: `components/requests.tsx`'s linked-task chip already does exactly this shape (`navigate("/board?task=" + id)`) from inside the app. `atlas-deep-links.spec.ts`'s leg 4c is the only test that discriminates half 2, and it reaches that state with a `pushState` + `popstate`, labelled as synthetic at the call site.

## Do not

- **Do not go back to a plain `<Navigate to={to} replace />` for a legacy redirect or an Atlas retirement.** Both hops must preserve the incoming query, or the one row that chains through both diverges per shell.
- **Do not let an incoming query override the row's own `?tab=`.** The target's tab is the row's meaning; a stale query must never re-point a redirect at a sub-tab the old address never named.
- **Do not consume or clear `?task=` from a `Board` mount that cannot show the dialog.** Silently eating a deep link is worse than leaving the param in the URL. Any future node that parks a board body with `hidden` must pass `deepLinks={false}` while that panel is hidden.
- **Do not delete the `deepLinks` gate on the evidence that `atlas-deep-links.spec.ts` stays green without it.** It does stay green, for a timing reason stated above that has nothing to do with the gate being unnecessary. Leg 4c is the leg that fails; run that one before concluding anything about this gate.
- **Do not add `deepLinks` to the project node's board mounts.** Every project-node address renders at least one *visible* board, so the param always reaches a mount that can show it; a `false` there would break a deep link that works today.
- **Do not replace the Platform node's `<Navigate>` with a derived tab, and do not return it INSTEAD of the panels.** Deriving the tab re-hides the dialog once the param is cleared; returning it alone unmounts all five panels and destroys whatever unfinished input they hold, which is the one thing that node's panel rule exists to prevent.
- **Do not "simplify" `Board`'s `setSearchParams((p) => { p.delete("task"); return p; })` into a rebuilt query.** A rebuilt query takes the node's own `tab` with it (card `3ed3dc31` measured this), which now also means bouncing straight back through the normalization above.
