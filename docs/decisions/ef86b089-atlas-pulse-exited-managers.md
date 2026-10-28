# Reaching an exited manager's orchestration events from the Atlas Pulse band

Card `ef86b089`. Closes the one gap card `5afd71bd` measured and deliberately left open when it retired Mission Control as an Atlas destination — see that card's record (`docs/decisions/5afd71bd-atlas-retire-mission-control-and-projects.md`), §"One measured gap, deliberately NOT closed here", for the measurement this card starts from.

## The gap

The Workspace node's Pulse band and Mission Control's Activity column shared their derivation byte-for-byte — same `["orchEvents", managerId]` query keys, same flatMap, same sort, same `GLOBAL_ACTIVITY_CAP`, same `EventRow` — except for the manager set they fanned out over. Mission Control read every **non-archived** manager (`/api/sessions` filtered by role, with no liveness predicate). The band read the **live, non-companion** ones (`pages/WorkspaceHome.tsx`'s `live`).

So the band's population was a strict subset, and the complement was unreachable: with Mission Control retired in Atlas, an exited-but-unarchived manager's orchestration events appeared **nowhere in the Atlas shell at all**. Classic mode was unaffected throughout — Mission Control is still a live destination there.

The companion half of that difference turns out to be vacuous, which simplifies the fix: a companion's role is `"assistant"` (`lib/sessions.ts`'s `COMPANION_ROLE`), so `role === "manager"` already excludes every companion. The *only* real difference was `isLiveSession`.

## The trade-off, and why it is a policy rather than a filter

Widening the band's set to `role === "manager"` and nothing else is a two-line change, and it is the wrong one. Each manager in the fan-out costs:

- **one `api.orchestrationEvents` request every 3000ms**, the live tier's interval, forever, on `/home` — the most-visited node in the app; and
- **a whole event stream in payload**. `db.listEvents(managerSessionId)` has no `LIMIT` of its own (`packages/daemon/src/db.ts`) — it returns a manager's entire audit trail.

Neither cost is bounded by anything except how many exited-but-unarchived managers a workspace has accumulated. Mission Control accepted that on a page people visited occasionally; the Workspace root is a different trade.

Four options were on the table. The chosen shape is **(a) a much slower interval + (c) a cap on the set**, both web-only:

| Option | Verdict |
|---|---|
| (a) poll exited managers far more slowly | **Taken.** An exited session's stream is near-immutable, so a 3s cadence buys nothing. |
| (b) fetch only when the band is expanded | **Rejected.** The band has no expand affordance — it is a fixed-height panel that owns its own scroll, always rendered on the Overview tab. Adding one is a visual change, and the band's visuals are under a pending owner mockup review. |
| (c) cap the set to the most recent N | **Taken.** This is the half that makes the cost flat in N rather than merely smaller. |
| (d) a new aggregated server endpoint | **Rejected as unnecessary**, not as wrong. (a)+(c) is provably bounded without widening scope into daemon code; if the cap later proves too tight to be useful, this is the option to revisit. |

### Why not a one-shot fetch instead of a slow poll

`refetchInterval: false` would be cheaper still, and was rejected. An exited manager's event stream emits *almost* nothing new, but "almost" is not "nothing": a worker can outlive its manager and still file against it, and boot-reconcile appends. A one-shot query would therefore go **permanently** stale for as long as the page stayed mounted, rather than lagging by at most one interval. Relying on react-query's `refetchOnWindowFocus` instead would make the refresh cadence a property of the user's window manager, which is not a cadence anyone can reason about.

### The numbers, and the arithmetic that justifies them

`PULSE_EXITED_MANAGER_CAP = 8`, `PULSE_EXITED_REFETCH_MS = 60_000` (`packages/web/src/lib/fleet.ts`).

The bound those two produce, stated as arithmetic rather than prose: the exited tier's worst case is `CAP × (60_000 / PULSE_EXITED_REFETCH_MS)` = **8 requests per minute**, *whatever N is*. One live manager, at 3000ms, costs 20 per minute. So the entire exited tier — at its cap, with an unbounded number of exited managers behind it — costs less than half of a single live manager, and does not grow.

`packages/web/test/mission-control-archived.mjs` asserts that inequality directly against both constants, so raising the cap or shortening the interval past the point where the tier outgrows one live manager fails a test rather than quietly shipping.

### Measured

`packages/web/e2e/atlas-pulse-exited-managers.spec.ts` seeds **12** exited-unarchived managers (N = 12, cap = 8) and counts `GET /api/orchestration/events?managerId=…` requests for exactly those twelve ids on `/home`: every poll from page load, and separately those falling inside a fixed 12-second steady-state window measured after the tier's first fetch has landed. The spec prints the three figures on every run rather than only asserting them.

Each row below was obtained by actually building and running that shape, not projected — the two middle rows are the negative controls for the two halves of the policy, each of which produced a clean split (leg 1 green, leg 2 red at that half's assertion alone):

| cap | interval | distinct polled | total polls | polls in the 12s window |
|---|---|---|---|---|
| *(before — `live` tier only)* | — | **0** | 0 | 0 |
| none | 3000ms *(the naive widening)* | 12 | 48 | 36 |
| none | 60s *(control: cap removed)* | 12 | 12 | 0 |
| 8 | 3000ms *(control: slow interval removed)* | 8 | 40 | 32 |
| **8** | **60s** *(as shipped)* | **8** | **8** | **0** |

Three things that table says, which the prose above only claims:

- **The "before" row is the gap**, not a baseline to be proud of: zero requests because zero of those managers' events were reachable anywhere in Atlas.
- **The two halves are independent, and both are needed.** Removing the cap alone costs 4 extra requests on mount and grows with N; removing the slow interval alone costs 32 requests per 12s at the cap and never stops. Only the shipped pair is both flat in N *and* quiet at rest.
- **The shipped row is one request per capped manager** — each is its initial mount fetch, with nothing inside the window, which is exactly what a 60s interval buys over a 3000ms one.

## Do not

- **Do not drop the cap, and do not fold the exited tier onto the live tier's 3000ms interval.** Either one restores the unbounded per-manager poll on the app's most-visited node. The two numbers are not independently tunable comfort knobs: together they are the only thing making this tier's cost flat in the number of exited managers.
- **Do not add a companion predicate to `pulseExitedManagers`.** `role === "manager"` already excludes every companion. A second, redundant guard reads as an independent safety property while being dead code.
- **Do not key the cap on anything but recency.** It is `lastActivity` DESC, so the rows it keeps are the ones a reader is plausibly looking for. A cap that kept an arbitrary 8 would bound the cost just as well and be useless.
- **Do not give the band an `action` or an expand control as part of widening it.** `5afd71bd`'s own prohibition still holds (this band is the deepest cross-project view of that stream), and the band's visuals are under a pending owner mockup review.
- **Do not change `pages/MissionControl.tsx`.** It is the CLASSIC shell's page, where this gap never existed, and its behaviour under the switch OFF is the condition the retirement's owner sign-off was given under.

---

## Extended to the PROJECT node by card `102bc915` (2026-10-28)

This card closed the gap on the WORKSPACE node and left it open one tier down. `pages/ProjectHome.tsx`'s Pulse band fed off `liveManagers` alone, so **an exited-but-unarchived manager's events were reachable nowhere on the project tier** — the same defect, the same shape, in the file next door. It survived because this card's own scope was the cross-project band: nothing here was wrong, it just was not applied twice.

It mattered more than it looks. Classic `/overview` reads every NON-archived manager, so it showed those rows all along — meaning the gap was invisible until `/overview` retires (card `3449fb54`), at which point the project tier would have lost a whole CLASS of manager silently. That is strictly worse than the older-events loss a cap causes, and it is why card `102bc915` built this half whether or not it raised the project Pulse's own cap.

The fix is this card's own mechanism, reused verbatim — `pulseExitedManagers` / `PULSE_EXITED_REFETCH_MS` / `PULSE_EXITED_MANAGER_CAP`, same two tiers, same `["orchEvents", id]` keys, so a manager crossing between tiers keeps its cache entry. The only difference is the INPUT: `ProjectHome` feeds the helper its already project-filtered session list, so the recency cap applies WITHIN one project rather than across the fleet. Nothing in the policy above was loosened, and the prohibitions in this record's own `Do not` list bind that mount exactly as they bind this one.

Witness: `packages/web/e2e/atlas-project-parity.spec.ts`'s Pulse legs — an exited-but-unarchived manager's event rendering in the project node's band, with classic `/overview` as the positive control, and both measured RED against the pre-card build. This record's own spec (`atlas-pulse-exited-managers.spec.ts`) is unchanged and still green: the two nodes are asserted separately, deliberately, because they feed the SAME helper from DIFFERENT session sets and a shared loop would stop checking either for what it actually is.

### Do not (in addition to this record's own list above)

- **Do not fold the two nodes' pulse derivations into one shared hook** to remove the duplication. They differ in the input set (cross-project versus project-filtered), which is the part that decides what the cap means on each; a shared wrapper would hide exactly that.
- **Do not re-scope `pulseExitedManagers` itself to a project.** It takes the session list it is handed. Filtering is the caller's job, and is what lets one helper serve both tiers.
