# 08ac5925 — the node_modules reclaim Settings panel: verbatim paths, daemon-global scope, and why `null` bytes is not zero

## Narrative

Card `1008e305` built `node_modules` reclaim behind two human-only loopback REST routes — `GET /api/worktrees/node-modules-reclaimable` and `POST /api/worktrees/reclaim-node-modules` — deliberately human-invocable rather than an automatic background sweep, because deletion is irreversible and runs on the owner's own host. But the only way to invoke it was `curl` with a `loom open` bearer token, so in practice it did not get used. This card added the consuming Settings panel (`NodeModulesReclaimPanel`).

**Paths round-trip verbatim.** `reclaimNodeModules` matches its `worktreePaths` argument by exact string equality against a freshly recomputed candidate set. These are Windows paths, so a separator variant, a drive-letter case difference, or a `path.join`-style rebuild produces a string that is *obviously* the same worktree to a human and a non-match to the server — it lands silently in `noLongerEligible` and the owner sees a no-op with no error anywhere. The panel therefore keys its selection state on the GET response's own `worktreePath` string and rebuilds the POST body by *filtering the current listing* (`entries.filter(e => selected.includes(e.worktreePath))`), so every byte sent is a byte that came back. That filter also means a path that aged out or went live between the scan and the click can never reach the request at all.

The same reasoning binds `minAgeHours`: the POST re-derives eligibility at whatever threshold it is handed, so the panel sends the exact value the displayed listing was read at. Sending the route's default while displaying a listing read at some other threshold would make every requested path ineligible.

**The view is daemon-global, not project-scoped.** Unlike the neighbouring retained-worktrees GET, neither route carries a project filter, and each entry's `projectId`/`projectName` *would* let the panel narrow to the header's active project. It deliberately does not. The question this panel answers is "what is Loom costing me on this disk", which is a host-level question; scoping it to one project would hide reclaimable space under every other project and make the freed total a lie by omission. Rows carry a project badge instead, so attribution survives without narrowing the view. This is also why the panel sits among Settings' daemon-global sections rather than the project-scoped ones.

**A `null` `bytesReclaimed` is an UNKNOWN, never a measured zero.** The daemon sets `bytesReclaimed` non-null only for `outcome: "removed"`. The other four outcomes all carry `null`, and they do not mean the same thing. `"wedged"` is the dangerous one: the removal was force-killed part-way and is never retried (decision record `bd9fc808`), so a real fraction of that tree may already be gone. Rendering that as "0 bytes freed" would tell the owner nothing happened when something did. The panel therefore branches on `outcome`, never on `bytesReclaimed === null`, and renders "Freed: unknown" with an explicit note for `"wedged"` while `"missing"` / `"left-on-disk"` / `"no-longer-eligible"` each read as "Freed: nothing" with their own reason. The run headline is built the same way: when `removed === 0` it says "Nothing was cleared" rather than printing a bytes figure, and a non-zero `wedged` count always appends its own "amount freed unknown" clause.

`sizeTruncatedCount > 0` makes the run total a lower bound (the size scan hit its entry cap mid-measure), so the headline reads "freed at least N".

**Candidates carry no size.** The daemon measures a tree only as it removes it, so `NodeModulesReclaimCandidate` has no size field and the panel does not invent one. The card's DoD asks for "measured bytes" in the listing; that field does not exist on the route, and a fabricated pre-deletion estimate is what the same DoD forbids elsewhere. The panel says plainly that sizes are measured during the run. Adding one to the GET would mean walking every candidate tree on a route documented as safe to poll — a separate decision, not this card's.

## Do not

- Do not reconstruct, re-join, normalise, or re-case a `worktreePath` anywhere between the GET and the POST. Send the response's own string. A variant is matched as a different path, lands in `noLongerEligible`, and produces a silent no-op with no error surfaced to the owner.
- Do not send a `minAgeHours` to the POST that differs from the one the displayed listing was read at — the POST re-derives eligibility at the threshold it is given, so a mismatch makes every requested path ineligible.
- Do not render a `null` `bytesReclaimed` as `0`, or reuse one presentation for all four non-`"removed"` outcomes. Branch on `outcome`. A `"wedged"` entry must say its freed amount is **unknown**: that removal may have destroyed a real fraction of the tree.
- Do not print a bytes figure in the run headline when `removed === 0`, and do not drop the `wedged` clause when `wedged > 0`.
- Do not scope this view to the active project, and do not move it behind a new top-level nav entry — it is daemon-global disk housekeeping and belongs in Settings.
- Do not fire the POST from anything but the armed confirm step, and do not let a primed confirm survive a change to the list underneath it.
- Do not add an estimated size to a candidate row. Sizes are measured during removal; a pre-deletion number could only be an estimate.

## Source

Card `08ac5925`, filed from the Code Reviewer's follow-up on `1008e305`'s branch review. Routes: `packages/daemon/src/gateway/server.ts`; service contract: `SessionService.listNodeModulesReclaimCandidates` / `reclaimNodeModules` and `reclaimNodeModulesDir` in `packages/daemon/src/git/worktrees.ts`. Consumer: `NodeModulesReclaimPanel` in `packages/web/src/pages/Settings.tsx`; client types in `packages/web/src/lib/api.ts`.
