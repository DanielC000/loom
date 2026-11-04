# 6a9cb96a — the Atlas project Overview's "Work in flight" card lists every running session, not only managers and workers

Card `6a9cb96a`, an OWNER bug report (2026-11-04), verbatim: *"'work in flight' card in the UI atlas ui overview page does not show the currently running 'Thought Partner' 'ba96294d' session. Investigate and fix."*

## Root cause

`packages/web/src/pages/ProjectHome.tsx` split this project's sessions into exactly two populations by exact role match — `all.filter((s) => s.role === "manager")` and `all.filter((s) => s.role === "worker")` — and those two were the whole input to `rosterRows(managers, workers)` (`packages/web/src/lib/atlasProjectOverview.ts`), which is the only thing that produces a row of the table. Every session whose role is neither fell through both filters and appeared in **no row at all**: an ideation/thought-partner rig and the Companion (both `role:"assistant"` — see `docs/decisions/2db23c4d-notify-lead-assistant-relay-is-a-non-authoritative-claim.md`), an elevated `operator`, an Agent `run`, a `setup`/`auditor`/`workspace-auditor`/`platform` session, and a plain terminal (no role at all).

The exclusion was **not deliberate**. It is inherited parity with the `FleetList` band panel this table replaced — `rosterRows`' own doc called the input set "deliberately identical to that panel's", but that sentence is about *live-vs-exited* rows, and neither this card's own record (`269f46ef`) nor `effd47d5`'s prohibits widening the population. What `269f46ef` pinned was the removals (no board embed, no `KpiDeck`, no `BandDisclosure`), and `effd47d5` pinned the scope filter's default and its one definition of "spawnable". Nothing anywhere states that a non-manager, non-worker session must not be listed.

## The disagreement that makes it a defect rather than a scope choice

The card's own head reads `${live.length} live · ${working} working`, and `live` is `all.filter(isLiveSession)` — **every** role. So a live Thought Partner was counted in the head and listed in none of the rows underneath it. That is precisely the shape card `9b6be377` was filed against: *"one card's HEAD disagreeing with that card's own LIST."* The head was already stating the right population; the list was the half that was wrong.

The session was not unreachable in the UI — the Atlas tree's project branch lists every live session with no role filter at all (`components/AtlasTree.tsx`'s `liveByProjectId`, card `ec1aa18e`), which is how the owner could see it on screen and still not find it on this card. It was also absent from the **Sessions** card directly below the roster, for a different reason: that card's population excludes companions via `isCompanionSession`, which is `role === "assistant"` and therefore cannot tell a chat-bound Companion from a thought-partner rig sharing that role.

## The fix

`rosterRows` takes a third, **required** population, appended last and never indented:

```ts
rosterRows(managers, workers, others)
```

and `ProjectHome` derives it as `all.filter((s) => isLiveSession(s) && s.role !== "manager" && s.role !== "worker").sort(byCreatedStable)`.

No label work was needed: the row already renders `<i>{session.role ?? "session"}</i>`, so an assistant row reads `assistant` and a plain terminal reads `session`. The scope toggle's two counts are both derived from `rows`, so they update themselves.

### Why `others` is LIVE-only while managers and workers are not

This asymmetry is the one genuinely debatable part of the fix, and it is deliberate.

The manager/worker rows keep **every non-archived** row because an exited-but-unarchived manager or worker is a real anomaly worth seeing: `archiveOnExit` (`packages/daemon/src/sessions/service.ts`) archives every role on exit *except* a manager/platform that still holds live workers (`@decision 6cd3ce9e`), so such a row means an orphaned fleet.

For the other roles there is no equivalent case to surface, and there *is* a cost. `role:"run"` is never archived on exit at all — `packages/daemon/src/index.ts` skips it (`if (exited && exited.role !== "run")`) and `onRunSessionExit` finalizes the run, GCs the disposable snapshot dir, and **leaves the session row** `exited` and unarchived forever. Listing exited rows in this population would therefore accumulate one dead Agent Run row per invocation, permanently, under a card called "Work in flight". Live-only is both the honest reading of the card's label and the only bound on that growth.

The card's footer states the asymmetry rather than leaving it implicit.

### Why companions are NOT excluded here

The **Sessions** card one level down excludes them, and that exclusion is correct there: it is the companion guard (card `5c87f4b6`) — a companion is driven only through its chat surface, never a raw pty + stdin Composer, and that card mounts a real terminal. The roster mounts no terminal at all; its only control is an `Open ↗` link to `/session/<id>`, whose destination resolves the companion guard itself from the session store (`lib/companionGuard.ts`).

And excluding them would re-open this exact bug. `isCompanionSession` is `role === "assistant"`, which is the same role an ideation/thought-partner rig runs under, so there is no filter that drops the Companion and keeps the session this card was filed about.

## Do not

- **Do not give `others` an `= []` default, or an internal `?? []`.** A defaulted third population is how this surface lost one in the first place: a caller that forgets it compiles clean and renders a short fleet, which reads exactly like a project with nothing else running. Required-and-explicit is the whole guarantee.
- **Do not narrow `others` by excluding companions**, however reasonable the Sessions card's own exclusion looks. An ideation/thought-partner rig shares the `assistant` role, so that filter drops the owner's own reported session.
- **Do not widen `others` to every non-archived session** for symmetry with the manager/worker rows. `role:"run"` is never archived, so that accumulates a dead row per Agent Run invocation, forever.
- **Do not indent an `others` row.** `RosterRow.child` means "a worker drawn under the manager that owns it"; nothing outside that relationship may claim it, and `filterRosterRows` demotes a kept child whose manager was filtered out for the same reason.
- **Do not re-order the tail ahead of the manager/worker hierarchy.** Keeping that hierarchy contiguous and first leaves the card's spine where every existing reader already finds it.
- **Do not sort `others` with `bySessionActivity`.** It keys on `lastActivity`, so rows would reshuffle on the page's 3s poll; `byCreatedStable` is the key the manager rows already use for precisely that reason.
- **Do not narrow the card's head count to match the list.** The head is the project's live fleet, which is what the `Sessions ↗` exit beside it opens (`@decision effd47d5`). The list was the half that was wrong.
