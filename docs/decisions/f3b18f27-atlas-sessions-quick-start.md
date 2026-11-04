# f3b18f27 — the Atlas Sessions tab's inline quick-start

Owner feedback (card `16106aaf`, verbatim), Projects › tab "Sessions": *"Add a quick agent session start UI element."*

Anchored at `packages/web/src/components/atlasAgents.tsx` (`AgentQuickStart`).

## Do not

- **Never give this surface a spawn call, a go-live guard, or a spawnable-list rule of its own.** The picker is the only thing this card added. Whichever agent it resolves to is handed to `AgentActions` **verbatim** — the same component the band row, the Agents node card and the quick-spawn dialog mount — so the held-control-plus-Stop guard, the `▾` role override, the `api.startSession` call and the inline refusal are inherited, not re-expressed. The spawnable-only list is `splitRoster`'s, read through the same `useAgentRoster` the dialog reads.
- **Never add a second `AgentsQuickSpawn` trigger to this tab.** The project node head already carries that dialog's `Spawn +` on *every* tab, ~60px above this row (`pages/ProjectHome.tsx`, `testId="atlas-nodehead-spawn"`). A second button opening the same modal is one affordance on screen twice.
- **Never key the picker's `<select>` on the requested id instead of the resolved one.** See *The fallback is the load-bearing half* below.
- **Never gate the control on anything but `projectId` being present.** A separate flag would be a second thing that can disagree with whether a single project is actually in scope.

## Why a picker, not a fourth dialog trigger

The card's first instruction was to reuse `AgentsQuickSpawn` rather than write a second spawn implementation, and everything inside that dialog *is* reused here — only its trigger is not. A modal is the right shape for the tree's `＋` (spawn from anywhere, having navigated nowhere) and for the node head's primary action. It is the wrong shape for this tab, for two reasons:

1. **The affordance would be duplicated.** The node head's `Spawn +` is portalled into the frame and is identical on every tab, including this one. Drawing a second control that opens the same dialog repeats it on one screen — the duplicate-affordance defect card `03d9db6e` caught only in a screenshot, after every one of its assertions had passed.
2. **The question here is narrower.** This tab is a list of what is already running; the question it raises is "start one more, here", beside that list. One line answers it. A modal interrupts the list to answer it, then has to be dismissed to see the result it produced.

So the trade this card makes: a picker is a *new* control shape (the dialog's roster is a list of rows, one spawn cluster each; this is one spawn cluster with a chooser in front of it), bought by reusing every piece of behaviour underneath it. Nothing about which agents may be started, or when, lives here.

## The fallback is the load-bearing half of `resolveSpawnPick`

`resolveSpawnPick(spawnable, wanted)` returns the requested entry while it is still spawnable, else the first in the project's own agent order, else `null`. The happy path is uninteresting; the fallback is why the function exists.

`roster.spawnable` is re-derived on every `["agents", projectId]` / `["profiles"]` / `["allSessions"]` settle, so the chosen agent can leave the list under a reader who is still looking at it — deleted from the Agents tab, or re-bound to a worker rig, which drops it from `spawnable` outright. Two things go wrong if the stale id is kept:

- A `<select>` whose `value` matches no `<option>` renders as its **first option**, so the control would show one agent's name while its buttons acted on another's id.
- That id is then posted to `POST /api/agents/<gone>/sessions`, which 404s — a refusal the reader cannot act on, blamed on the agent the picker was displaying.

Keying the `<select>`'s `value` on the *resolved* pick (never on `wanted`) is what closes both: the state holds a **request**, and the render only ever shows an answer that is really in the list.

## `AgentActions` is keyed on the pick

`<AgentActions key={pick.agent.id} …>` — a fresh instance per agent, so `useSpawnActions`' own mutation state cannot outlive the agent it belongs to. Without the key, a refusal raised while agent A was picked stays printed under agent B the moment the reader switches, attributing a failure to an agent that never asked for anything.

## `RosterEmpty` took a `testId`

The Atlas project node parks every **visited** tab body in the DOM with `hidden` rather than unmounting it (`pages/ProjectHome.tsx`). So the Agents tab's own `RosterEmpty` and this one can be in one document at once, and the previously-hardcoded `atlas-agents-empty` would resolve both — a strict-mode violation in any spec addressing either. The prop is defaulted, so every pre-existing mount keeps the id it had.

## The bar exists for the next card, not this one

The filter and the quick-start share one `.loom-sessionbar`, and its micro-label style is hoisted to a module constant used by both groups. Card `ac0cfe91` (terminal ordering and gridding on this same tab) is blocked behind this card and adds more controls to this surface; it should extend a declared bar rather than open a third row of its own.

The label is deliberately **not** the `SectionLabel` kit primitive, even though it restates four of its five properties: `SectionLabel` is a block heading at weight 700, a louder voice than a field label beside its own field, and adopting it would also silently re-weight the project filter's label that the classic `/terminals` page has always drawn.
