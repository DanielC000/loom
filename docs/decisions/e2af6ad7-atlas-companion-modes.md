# Where the Companion's Chat / Manage / Terminal modes live in Atlas

Card `e2af6ad7` (Atlas build plan P2-6, epic `9fe8cd4e`). Closes gap §J.1 of `docs/plans/atlas-ui/01-parity-checklist.md`.

## The gap this answers

Every mockup round homed all twenty Companion write actions, plus the companion-chat websocket write, to one undifferentiated "Workspace › Companion tab". The real page is a three-way `role="tablist"` switch — **Chat** (the conversational UI, text + voice, over a websocket), **Manage** (twelve sections), **Terminal** (a read-only watch window onto the companion's own `claude` session, the one sanctioned exception to companions being hidden from every other terminal surface). None of the three modes, and none of the twelve sections, was ever drawn.

The round-4 mockup was read before deciding (`Mockups/2026-10-19 UI Overhaul Round 4/index.html` §17, `atlas.js`'s `"companion"` view). It shows a left companion-picker rail plus a two-column grid of read-only summary panels, and **no modes, no chat, no terminal** — so it does not contradict any placement; it is simply silent on the one thing this card exists to decide. That made this a decision to take and record, not an ambiguity to escalate.

## The decision

**The modes are the Companion node's own tabs, on `?tab=chat|manage|terminal` at the existing `/companion` path. Manage's twelve sections become four sub-sections on a nested `?sec=run|channels|persona|trust`.**

- `/companion` is already a tree node (a `NAV_PAGES` destination). It stays one — no new `ATLAS_HOMES` entry, so the tree's node-set parity check in `e2e/atlas-tree.spec.ts` sees no new `extra`. What changed is the node's *content*, which is why `/companion` joins that spec's `REBUILT_IN_PHASE_2` map (and **only** that one — no legacy redirect targets `/companion`, so adding it to `e2e/atlas-legacy-redirects.spec.ts`'s map would fail that spec's own positive control).
- A mode is a **tab**, not a node. The three modes are three faces of one entity; promoting them to sibling tree nodes would put the companion picker — which is shared by all three — above or beside the tree, and a reader navigating from Chat to Terminal would be changing *address* rather than *view*. `?tab=` on the node's own path is also exactly what P2-1's home nodes and P2-4's Platform node already do, so this adds no new mechanism.
- The primary mode row uses `NodeTabs` (`components/atlasHome.tsx`) — the Atlas node-tab language, real `<Link>`s, so a mode is copyable and middle-clickable. Manage's sub-row uses the shared `Segmented`, which reads as the lesser, nested control. The hierarchy is carried by the two components' existing visual weight; no new chrome was invented for it.
- `?sec=` is preserved across mode links, so Chat → Manage returns to the section you left. It is inert outside Manage; `/companion?tab=chat&sec=trust` is a legal, harmless URL and there is no hidden "last section" state anywhere.

### The four Manage groups

Twelve sections, grouped by what they govern: **Run** (run configuration, proactive home, voice provisioning) · **Channels** (channels, incl. allowed senders and Telegram connect; DM pairing) · **Persona** (prompt, skills, memory, reminders) · **Trust** (restricted tools, capabilities incl. lead mode, delete companion).

`Trust` carries the destructive control as well as the permission ones. Those three are the controls whose consequences reach outside this page, and the owner meets them in one deliberate pass instead of finding "Delete companion" at the foot of an unrelated column.

## Do not

- **Do not re-order `COMPANION_MANAGE_SECTIONS` (`lib/companionManage.ts`) to match the Atlas grouping.** That array's order *is* the classic page's column order, and the classic page must stay untouched until phase 3. The Atlas groups are a `filter` over the array, never a re-sort of it. `test/companion-manage-sections.mjs` pins the flat order against an independently written copy of today's column, so a re-order fails the build rather than silently moving a control on a UI nobody opted into.
- **Do not make the mode state React state in the Atlas layout.** It is URL state on purpose: a mode has to survive a reload and be linkable, which is the whole reason the classic page's `useState` mode was not simply reused here.
- **Do not test the draft rule with "the panel is still in the DOM".** `toHaveCount(1)` + `toBeHidden()` is a structural check, and a panel React tore down and rebuilt satisfies it exactly as well as one it left alone — so it cannot see the only regression that matters. Test the rule by the thing it protects: type into the Chat composer *and* an open Manage editor, round-trip through another mode, and read both back (`e2e/atlas-companion.spec.ts`, "unfinished input survives a mode switch"). Shown RED by keying both panels on `location.search` to force a remount, which fails at "the persona editor must still be open" — the `editing` flag is local state, so a remount resets it before any typed text is even reachable.
- **Do not unmount the Chat or Manage panels on a mode switch.** Both hold unsaved user input — a composer draft, and form state in nine of the twelve sections. The owner's standing rule is that unfinished input is never destroyed, and a tab click is not consent to discard it. They are `hidden`, which (unlike a `display:none` style) also keeps them out of the accessibility tree and the tab order, so a keyboard user can never reach a capability-grant control on a panel they are not looking at. ⛔ Never give those wrappers an inline `display` — an author `display` out-specifies the UA's `[hidden]` rule and would silently un-hide them.
- **Do not keep the Terminal panel mounted when it is not the active mode** — this is the one deliberate exception to the rule above, and the reason is that the rule's premise does not hold for it. The Terminal is read-only: stdin is disabled, no composer is rendered, and there is no user input anywhere in it to lose. Mounting it costs a live xterm plus a pty websocket attach for every visit to the node, including visits that only ever use Chat. The classic page already unmounts it on a mode switch, so re-mounting on return is parity, not a regression.
- **Do not re-implement the Terminal's read-only guarantee here.** `CompanionTerminal` is reused verbatim, and underneath it `TerminalPane` resolves watch-only-ness from the session *store* (`lib/companionGuard.ts`'s `useIsCompanionSession`), ORed with the caller's `readOnly` prop — so a companion is watch-only whether or not a caller remembers to pass the prop. Both layers (xterm's `disableStdin` and the `ws.send({type:"stdin"})` gate) are pinned by `test/companion-terminal-guard.mjs`. Adding an Atlas-local read-only check would be a fourth copy of a guarantee that already fails closed.

## Why the companion picker is a strip, not the mockup's left rail

The mockup puts the companion list in a left rail beside the content. In the Atlas frame the entity tree already takes 244px of the viewport, and the two modes that need width most — Chat (message column plus, once there is history, its own conversation rail) and Terminal (a fixed-geometry pty) — are exactly the two a second rail would squeeze. So the picker stays a horizontal strip above the tab row, which is also where it sits today. It is shared by all three modes, so it belongs above the mode row rather than inside any one panel.

## The write inventory, derived from the code

Derived by reading today's call sites in `pages/Companion.tsx` and `components/CompanionChat.tsx`, not from the mockup's table — an action inventory, not a destination inventory. Every one of them routes to a real mode:

| Mode | Writes |
|---|---|
| **Chat** | the chat websocket `ws.send` — text frames, audio frames, and the `/new`/`/reset` command that archives a conversation (the only non-REST write on this page) |
| **Manage › Run** | `createCompanionConfig`, `updateCompanionConfig`, `setCompanionHome`, `clearCompanionHome`, `updatePlatformConfig` (voice) |
| **Manage › Channels** | `createCompanionBinding`, `deleteCompanionBinding`, `addCompanionAllowedSender`, `removeCompanionAllowedSender`, `mintCompanionPairing`, and the Telegram connect flow's `createCompanionConfig`/`updateCompanionConfig` + `createCompanionBinding` pair |
| **Manage › Persona** | `updateCompanionPrompt`, `deleteCompanionSkill`, `deleteCompanionMemory`, `deleteCompanionReminder` |
| **Manage › Trust** | `updateCompanionRestrictedTools`, `restartCompanionSession`, `setCompanionLeadMode`, `upsertCompanionGrant`, `deleteCompanionGrant`, `upgradeCompanionSession`, `deleteCompanionConfig` |
| **Terminal** | none, by construction |
| the node itself | `provisionCompanion` — the `+ New companion` affordance, above the modes because it creates the entity the modes are faces of |

Two of these are **not** rows 96–115 of the parity checklist and would have been missed by taking that table as the inventory: `updatePlatformConfig` (row 83, shared with Settings — the voice-provisioning toggle) and `restartCompanionSession`, which is not an `api.*` member at all but a separate export of `lib/api.ts` called by the restricted-tools section's live-apply.

No `api.ts` member was added, renamed or removed by this card. Every section component, and `CompanionChat`/`CompanionTerminal`, is the same component the classic page renders — so each control keeps exactly the gating, confirm step and human-only posture it has today, including the grant-reach confirm (`@decision 3c4e0df6`).

## The one change inside a shared component

`CompanionChat` gained an optional `visible` prop, defaulting to `true`. Default `true` keeps the classic page byte-identical.

Keeping the Chat panel mounted while hidden means `display:none` during a Manage detour, and a hidden element reports `scrollTop`/`scrollHeight`/`clientHeight` as 0 — so the autoscroll effect's `scrollTop = scrollHeight` writes 0 to 0 and changes nothing, while `atBottomRef` stays `true` because `onScroll` never fires on a hidden element.

**What that costs, measured rather than reasoned** (Chromium, a 40-turn conversation, a real inbound frame dispatched at the live socket while the panel was hidden; the control is the same run with the re-pin effect removed and the build's exit code checked, so the bundle really was re-emitted):

| | returns at | at bottom? | the message that arrived |
|---|---|---|---|
| with the re-pin | `scrollTop` 3068 of 3514 | yes | in view |
| without it | `scrollTop` 3017 of 3514 | no | off-screen, and no unread badge |

The browser **restores** the pre-hide `scrollTop` on re-display; it does not zero it. So the reader comes back exactly where they were — which is correct for someone who had deliberately scrolled up, and wrong for someone who was at the live edge, because the conversation grew underneath them. The failure is silent: `atBottomRef` never flipped, so the autoscroll effect kept taking its at-bottom branch and never counted an unread.

> An earlier draft of this record claimed the reader "landed at the top of the conversation". That was reasoned from the zeroed measurements, never measured, and it is **wrong** — the browser's restore means the position is stale, not reset. The fix is the same either way; the explanation was not.

## Do not (scroll)

- **Do not replace the re-pin with a save/restore of `scrollTop` around the hide.** The browser already restores it correctly (measured: 120 before the hide, 120 after), so a manual restore is redundant for the scrolled-up reader and would fight the browser for the at-bottom one. Only the at-bottom case is broken, and only re-pinning to the new bottom fixes it.
