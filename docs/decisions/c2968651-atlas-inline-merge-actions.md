# c2968651 — Atlas inline merge actions, and the two parity rows that are NOT built

Card `c2968651` closed the three parity gaps card `fd99b2d7` (Atlas P2-1) disclosed but could not carry. Two of the three were built; one was dropped on evidence. This record is what each anchor in the code points at.

## Do not

- **Do not give the compact band merge action its own `api.mergeWorker` call, its own outcome branches, or its own button title.** `useWorkerMerge` / `MergeOutcome` / `MERGE_TITLE` in `packages/web/src/components/reviewQueue.tsx` are declared once and consumed by both renderings. A second copy drifts from the fail-closed gate's real semantics — in particular from the `pending` (`merged:null`) vs `merged:false` distinction, which a fresh `!merged` check reports as a rejection with nothing to flag that it guessed.
- **Do not add a diff read to `CompactMergeAction`.** It renders no diff summary, so a fetch would buy nothing and would put an N-wide fan-out (one per pending review) on a home node whose whole composition rule is that it reads only what another page already reads.
- **Do not make `AttentionRow`'s `footer` unconditional or item-derived.** It is opt-in so a classic attention row keeps the exact single-`div` shape it renders today, with no wrapper element inserted around its children — the text's ellipsis and the `flex: 1` spacer both measure against that element.
- **Do not put a recycle button in the `worst context` pop-over.** There is no human recycle write path, and a stop+resume pair wearing that label would misname what the click does.
- **Do not re-card the project card's `main <sha>` line without first adding a data source for it.** See §(b): it is not a layout problem, it is a missing read.

## (a) Inline "Approve & merge" — BUILT

P2-1 rendered a pending review in the Needs-you band as a compact `AttentionRow` whose only affordance was `Open` → `/review/:id`, because `ReviewQueue`'s card grid is `minmax(340px, 1fr)` and a band column measures ~300px at 1600px wide. The action was therefore a navigation where the classic surfaces have it as one click.

What landed is the card's own "(or equivalent)" option rather than a literal shrunken `ReviewCard`: the row gains a **second line** carrying `Review →` and `Approve & merge`, through the shared write path above. Three things about the shape are deliberate:

- **Two lines, not one.** At ~300px the kind label, the text, a `Review →`, an `Approve & merge` and the dismiss `×` cannot share a line without ellipsising the row text, which is the part the reader is scanning. The band's own operator and agent rows already use a two-line head/foot grammar, so this is that grammar, not a new one.
- **`Review →` keeps `variant="primary"`; the merge is `variant="default"`.** Verification is the bottleneck the full Review queue exists to serve, so the diff stays where the eye lands and the one-click merge is the deliberate shortcut beside it. The merge is not a gate bypass either — it runs the same fail-closed daemon gate — and the button's hover text says so in the same words the full card uses, because both read one constant.
- **`onOpen` is dropped for a footer row.** The footer's `Review →` IS that affordance; a row carrying both would offer the same navigation twice.

Wiring it in `AttentionList` (`pages/WorkspaceHome.tsx`) reaches **four mounts** — the Needs-you band panel and the `needs you` KPI pop-over, at the Workspace root and at the project node. No classic surface reaches that component at all: Mission Control and the project Overview each filter `MERGE REQUEST` out of their own attention list and render the rich card instead, which is why the switch-OFF polarity is structural rather than a flag check.

## (b) The project card's `main <sha>` line — DROPPED, and why

The card allowed either a no-fan-out implementation or a recorded drop. It is dropped, because no data source for it exists on the client under this card's constraints (no new `api.ts` members).

Measured against the real code, not inferred:

| Candidate source | Why it cannot serve the Workspace grid |
| --- | --- |
| `api.gitLog(projectId)` | The only `api.ts` member that returns a commit hash at all, and it is **per project** — exactly the N-request fan-out the row has to avoid. The Workspace grid already makes one `api.board(p.id)` call per project; this would double that fan-out, against an endpoint whose own `WORKER_DIFF_STALE_MS` note records that a burst of git calls over live worktrees is its expensive shape. |
| `GateHistoryRow` (already fetched, daemon-wide) | Carries `branch`, `taskId`, `opId`, `durationMs`, `endedAt` — and **no sha field**. This is where `lastMergeByProject` already gets each card's "merged 2h ago" line for free, so it was the obvious candidate; it simply has no commit id in it. |
| `Project` (already fetched) | `repoPath`, `vaultPath`, `repos`, `config`, … — **no sha field**. |

So the line cannot be rendered from anything the page holds, and the cheapest honest version of it would be a new aggregate daemon read — out of scope for a web card, and a design decision in its own right.

Two near-misses worth naming so the next reader does not re-walk them:

- **The last *landed* sha is not `main`'s sha.** Even if `GateHistoryRow` carried one, it would be the sha of the last commit Loom itself landed, which equals `main`'s HEAD only when nothing else moved `main` — a direct owner commit or an external push breaks it silently. Labelling that `main <sha>` would be a readout that is wrong exactly when a reader most needs it.
- **A single-request version on the project node is a different row.** `/project` has one active project, so one `api.gitLog` there is not a fan-out — but the parity row is about the project CARD in the Workspace grid, and relocating the information is not parity for that row. Not done here; a legitimate separate card.

Recorded on the P3 parity checklist card `f3cabed2`.

## (c) Pop-over action buttons — DECIDED PER ACTION

The round-4 mockup drew three. One was already wired, one arrives from (a), and two had no write path to wire:

| Mockup action | Verdict |
| --- | --- |
| **"Answer"** | **Already present** — no work. `AttentionList`'s rows already render `Answer →` for an answerable Request (`isAnswerableRequest`), opening the shared modal rather than navigating away, and the `needs you` pop-over renders that same list. Verified in the e2e rather than rebuilt. |
| **"Approve & merge"** | **New, and free.** Not in the mockup's pop-over list, but (a) wires it into `AttentionList`, which the pop-over renders — so the `needs you` breakdown became genuinely actionable as a side effect of the band fix. |
| **"Recycle Dev after card"** | **Rejected as a write; resolved as an exit.** There is no human recycle path: `lib/api.ts` has `resumeSession` and `stopSession` and no recycle at all, and "after card" is a manager's `worker_recycle` — an MCP tool with no human REST equivalent. Composing stop+resume under that label would be a button whose name lies about what the next click does, which is the same rule `useLiveWorkerCount` already states for the `Kill all` confirm. Instead each `worst context` row's agent name is now a link to the session that owns the real controls — the same "the exits carry the reader to the real control" rule `OperatorList` and `FleetList` already state for the band panels. |
| **"Adjust threshold"** | **Rejected as a write; resolved as an exit.** It edits `orchestration.recycleAtContextRatio`, a numeric config field — a form, not a button, and it already has a home in Settings. The pop-over footer now names the resolved ratio these meters are actually read against (through `resolveConfig`, the same way the classic Overview resolves `gateCommand`) and links to where it is changed. That answers the question the mockup's button was reaching for — "80% of what, and says who?" — without a second, thinner copy of a form. |

Nothing was added to the `plan 5h` pop-over. `ClearUsageHoldButton` is the one genuine one-click write among those figures, but `FleetControlsBar` already renders it directly under the KPI deck on that same page, so a pop-over copy would be redundancy ~100px from the original rather than a parity gain.

## What did NOT change, deliberately

`MergeOutcome` renders exactly what the classic `ReviewCard` rendered before the extraction — the `pending` and `rejected` lines, and **nothing on success**. A success confirmation would be a real improvement (the button currently returns from "Merging…" to its resting label with no acknowledgement; the row retires only once the merged worker leaves the live session feed), but it is a change to what the classic Review queue renders, and this card's own rule is that switch-OFF stays untouched. It belongs in a card of its own.
