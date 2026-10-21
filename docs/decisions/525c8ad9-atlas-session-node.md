# 525c8ad9 — the Atlas session node is a skin over TerminalCard, not a second session surface

Atlas P2-7 (epic `9fe8cd4e`). The owner picked **B · Inline** over A · tabs (request `36787441`, 2026-10-21), so Queue, Wakes and the bound-task bar stay inline under the terminal rather than becoming tabs. The mockup set and the four code-read facts that decided it are in the vault at `Mockups/2026-10-21 Atlas session node/`.

## Do not rebuild the session body beside TerminalCard

The node is an opt-in `atlasNode` prop on `components/TerminalCard.tsx`, not a new component that composes `TerminalPane` + `Composer` + `SessionQueue` + `SessionWakes` itself. That is deliberate, and it is the one thing to preserve if this is ever refactored.

`TerminalCard` is the single owner of three invariants that are invisible at a call site and fail silently when duplicated:

- the **companion watch-only guard** (`readOnly={watchOnly}` on the pane, and the composer withheld entirely) — `packages/web/test/companion-terminal-guard.mjs` asserts it by reading this file's source text, so a second body that forgot it would still pass that guard;
- the **Composer's `key={session.id}`** (card `14c68c62`) — without it, one session's unfinished draft renders under another on an in-app `/session/:id` hop;
- the **queue ledger's own measurement wrapper**, which is what lets the ledger grow the card instead of shrinking the terminal.

So the Atlas node shares `terminalPane()`, `composerNode` and `belowStrip` with the classic body; only the LAYOUT forks (`atlasBody()` vs `sessionBody()`). A reviewer should be able to delete `atlasNode` and get the pre-card tree back byte-for-byte.

## Every pane unmounts — so a draft is protected by a STORE, not by staying mounted

Elsewhere in Atlas, a node's panels stay mounted under the `hidden` attribute so a tab click cannot discard half-typed input (the Companion node, `@decision e2af6ad7`). The session node does not do that, for two separate reasons that are easy to collapse into one wrong one.

The first is real: the surfaces holding unfinished input — the composer and the queue editor — are **inline strips here, not tabs**, so a SAME-ROUTE switch (`?tab=`) never takes them down at all. The terminal unmounts on purpose (a live pty websocket, no draft); Transcript (5s poll) and Timeline (2s poll) hold no input, so mounting them hidden would buy nothing and cost two timers per open node.

**The second is where the first version of this card was wrong.** Being an inline strip does NOT make a draft safe, because the Diff tab is a ROUTE (below) — a Terminal→Diff hop unmounts the whole node, strips included. The composer survived that only because its draft was already store-backed (`lib/composerDrafts.ts`, card `14c68c62`); the **queue editor's was not** — plain `useState`, no store — so that hop destroyed a half-written queued message, and the code comment and this record both asserted it was fine. Review round 2 caught it. `lib/queueDrafts.ts` now backs it, and keeps the drawer-open and editing-row state beside the text, because a restored draft behind a collapsed drawer is one the user can never reach.

Two rules survive that, and they pull in opposite directions, so keep both:

- **Don't re-apply "keep panels mounted" here by analogy.** It is a remedy for a hazard this layout does not have — an earlier draft of this card did apply it, mounting the review surface hidden on the terminal tab, where it fetched a diff nobody was looking at.
- **Don't infer "always mounted" from "inline", either.** Ask what unmounts the whole NODE, not just the pane. Under a route-per-tab design, that is every tab hop to another route.

An unmount is not a decision to discard, so it clears nothing. **Cancel and a successful save are** — those clear the stored draft, which is what keeps the store from becoming a thing that can never be emptied.

## Do not give the Diff tab a second address

`nav.tsx`'s `PARAM_PAGES` already declares `/review/:workerId` to BE the worker node's Diff tab. `lib/sessionNodeTabs.ts` honours that: the Diff tab's href is `/review/:id`, not `?tab=diff`, and Terminal's is the node's bare path rather than `?tab=terminal`. A `?tab=diff` would leave one surface reachable two ways, with two crumb trails and nothing keeping them in step — which is also why `pages/ReviewPanel.tsx` under Atlas renders the whole session node rather than the review surface alone.

`components/ReviewSurface.tsx` is `ReviewPanel`'s former inner component, moved verbatim so both the page and the node can mount it without a page↔component import cycle. Its `embedded` flag drops only its own `← back` / `MERGE REQUEST` / `worker w:…` header row, which is the same identity the frame's crumb and `<h1>` already carry.

### …and never branch the review page on whether the worker row resolved

`pages/ReviewPanel.tsx` mounts the node **unconditionally**. It used to pick between the node and a bare `ReviewSurface` depending on whether `["allSessions"]` had a row for this worker — and **a successful merge is exactly what makes that row stop existing**: the merge hard-stops the worker, the exit archives it, `listAllSessions` drops archived rows, and the mutation's own `onSuccess` invalidates the feed. So the page flipped branches one refetch after the merge landed, remounting the review surface at a new position and discarding the result banner it had just produced along with any note still typed beside it. The same flip fired on a worker exiting for any other reason mid-review, and on every first load while the feed was pending.

Two separate levers fix it, and they have separate witnesses in `e2e/atlas-session-node.spec.ts` (each shown red on its own revert):

- **one mount position** — there is no branch, so nothing can remount. Before the feed has answered, the node is drawn from `{ id, role: "worker" }`: the route itself is the authority for both fields, nothing else is invented, and `SessionNodeState` renders blank rather than claiming `idle` for a state it does not know;
- **a latched row** (`lib/useLatchedSession.ts`) — the frame's heading derives from the same vanished row, so without it the node renames itself to a bare `Session a666fb31` mid-review.

**The two addresses deliberately use different rules for a non-live row, and that is the answer to "which gate applies":** `/review/:workerId` renders the node whatever the row's `processState`, because a review outcome has to stay readable after the merge that ended the session. `/session/:id` keeps SessionView's live-or-starting gate, because a node whose terminal cannot attach is an ended-session record, not a session node. They agree at the seam — the node's Terminal tab links to `/session/:id`, where that gate is what answers — and the frame follows the same rule: the tab crumb is appended only when a tab row will actually render under it.

## The identity is stated twice, on purpose, and the second statement does a job

Inside the Atlas frame `/session/:id` used to name the session four times: the crumb trail, the frame's `<h1>`, `SessionView`'s own `header()` row, and `TerminalCard`'s `TileTitle`. What survives:

1. **the crumb trail** — it is the address;
2. **the `<h1>`** — and it is given a job: `TerminalCard`'s header (busy pill, harness tag, context meter, Fork / Stop / maximize) is PORTALED into the frame's node head beside it, via the slot in `lib/atlasNodeHead.ts`.

`SessionView`'s `header()` row is suppressed under Atlas only; `TileTitle` is suppressed by the existing `title` prop override. **The classic shell keeps both** — `e2e/atlas-session-node.spec.ts` asserts that in the same breath as the Atlas absence, because "it is gone" and "it is gone everywhere" are different claims and only one of them is wanted.

The short id is NOT repeated in the state cluster, although the approved mockup shows it there: the `<h1>` already carries the full `agent · role · shortid` label, and `e2e/atlas-param-routes.spec.ts` derives the heading from the crumb trail, so splitting the id out would have made the heading and the deepest crumb disagree for no gain.

## Why the header is a portal and not a prop

The controls belong to two owners the shell cannot see: the fork/stop mutations are the page's, and `maximized` is `TerminalCard`'s own state. Lifting either into `AtlasShell` would mean duplicating mutations or exporting a state handle. The shell instead publishes one empty element and the node portals its existing header into it — so the shell stays generic, the node keeps its controls, and there is exactly one portal into the slot (ordering is therefore not a question).

A null slot renders nothing rather than falling back to an inline header. That matters for one paint: the slot element only exists after the shell's ref callback runs, and an inline fallback would flash a second identity onto the screen exactly once per load.

## The 420px review overflow

`ReviewPanel`'s decision row held a `width: 320` textarea inside a non-wrapping flex `<span>`, giving the cluster a ~456px min-content inside a ~370px Atlas column — measured 61px off the right of a 420px viewport. The fix is `flexWrap` on the row plus `flex: 1 1 200px` with a `maxWidth` on the textarea, and it is applied in **both** shells: the defect is the component's, not Atlas's, and the classic page had it too.

**Do not assert that overflow by walking for x-scrollable ancestors.** `overflow-y: auto` on `.loom-atlas-content` forces its computed `overflow-x` to `auto` as well, so such a walk matches every element in the column and greens unconditionally — it did, 4 GREEN / 0 RED against known-bad CSS, while the mockups were being built. The sound measure is `scrollWidth > clientWidth` over boxes whose computed `overflow-x` is `visible`, which excludes a diff hunk's legitimately scrolling `<pre>` by construction.
