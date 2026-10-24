# The keyboard shortcuts carry into Atlas by construction — the gap was that nobody had ever pressed the keys

Card `a1c6e339` — Atlas build plan P2-8 (`docs/plans/atlas-ui/03-decomposition.md`), closing parity gaps §J.3 and §J.10 of `docs/plans/atlas-ui/01-parity-checklist.md`.

## 1 · The inventory: where each shortcut lives, and where its host lives in Atlas

Derived by grepping every `metaKey|ctrlKey` site in `packages/web/src` — there are **seven**, six of them the §F rows — and then tracing each component's real import sites. The §F table names the *components*; it does not say which page mounts them, and for two of them the answer is not the one the table's "Where" column implies.

| Shortcut | Handler | Host page(s) today | In Atlas |
|---|---|---|---|
| ⌘/Ctrl+Enter · send a turn | `Composer.tsx` `onComposeKey` | `/platform`, `/terminals`, `/overview`, `/session/:id` | same addresses |
| ⌘/Ctrl+Enter · save a preset | `PresetPrompts.tsx` `PresetForm` | inside `Composer`'s own popover ⇒ as above | same |
| ⌘/Ctrl+Enter · save a queued turn | `SessionQueue.tsx` `QueueEditor` | inside `TerminalCard` ⇒ as above | same |
| ⌘/Ctrl+Enter · save a startup prompt | `AgentPromptEditor.tsx` | **`/platform` only** (`PlatformView`) | Platform node, Home tab |
| ⌘/Ctrl+F · scoped in-doc find | `DocFind.tsx` | `/repository` › Files (`pages/Vault.tsx`) | Repository node (project tier) |
| ⌘/Ctrl+V, ⌘/Ctrl+C · smart clipboard | `Terminal.tsx` `attachCustomKeyEventHandler` | every host above, plus `/companion`'s read-only Terminal | same |
| ⌘/Ctrl+K · Command Palette | `CommandPalette.tsx` | `App.tsx` overlays | passed to `AtlasShell` as `overlays` — already covered by P1-5 |

Three corrections to the §F table fall out of that trace, and each one changes where a test has to look:

- **The four ⌘/Ctrl+Enter editors are not four surfaces.** Three of them (`Composer`, `PresetPrompts`, `SessionQueue`) are reachable only *through* `components/TerminalCard.tsx` — the preset editor lives inside the composer's own popover, and the queue editor inside the same card's queue drawer. One mounted `TerminalCard` is all three.
- **The "Agents editor" has exactly one host, and it is not the Agents node.** `AgentPromptEditor` is imported in `pages/PlatformView.tsx` and nowhere else; it edits a *reserved-home* agent's `startupPrompt`. P2-2's Atlas Agents node (`pages/AgentsNode.tsx`) does not mount it, and neither does `/projects`, whose own agent editor is a plain textarea — see §4.
- **`/session/:id` has no tree node at all.** It is a `PARAM_PAGES` address (P1-2) mounted by both shells, and P2-7 (the session node) is mockups-only so far. So the session-cockpit copy of these shortcuts is reached through that param route under *both* shells and moves only when P2-7 lands.

## 2 · No product code changed, and why that is a proof rather than an assumption

Every one of these handlers is attached to a **component** — a React `onKeyDown` on the field for the four Enter editors, a `window` listener owned by `DocFind`'s own effect, `attachCustomKeyEventHandler` on the xterm instance. None is attached by a page, a route or a shell. Phase 1 mounts each host's *existing component* verbatim from the one declaration in `src/nav.tsx` that both shells map, so a host Atlas has not rebuilt carries its shortcut by construction.

One host **was** rebuilt in phase 2: `/platform` (card `c07ff42a`, P2-4) is now a five-tab node, and its Home tab renders `PlatformAgentsSection` (the agent cards, each with an `AgentPromptEditor`) and `PlatformSessionsSection` (the live session tiles, each a `TerminalCard` with a `Composer`, a `SessionQueue` and a `TerminalPane`). Four of the six shortcuts therefore sit inside a rebuilt frame — which is why `e2e/atlas-keyboard-shortcuts.spec.ts` puts its weight there rather than spreading evenly over the verbatim mounts.

Three further facts, each checked rather than assumed, close the remaining ways a rebuild could have interfered:

1. **Both rebuilt layouts share the same sections.** `PlatformAgentsSection` and `PlatformSessionsSection` are rendered by `ClassicPlatformLayout` *and* `AtlasPlatformLayout` from one definition, so the classic page and the Atlas node cannot drift into mounting different editors.
2. **Nothing in the Atlas frame intercepts these keys.** Every `addEventListener("keydown")` in `packages/web/src` was read, all twelve: ten of them handle `Escape` and nothing else (`AtlasTree`'s quick-spawn dialog, `Board`'s two task dialogs, `Composer`'s large editor, `TerminalCard`'s maximize overlay, `SetupWizard`, `SessionTaskCard`, `DefaultHarness`, `requests.tsx`, and the shared `lib/useDismissable.ts`). Several of those are newly reachable from an Atlas surface — the quick-spawn dialog is Atlas-only, and `Board` is now embedded in the project node and the Platform node's Board tab — but none of them reads Enter, F, V or C. The other two sites are `CommandPalette` (⌘K) and `DocFind` itself.
3. **`DocFind`'s container is self-contained.** Its scroll container, its sticky bar and its `isDocActive()` gate all live inside `pages/Vault.tsx`'s own `74vh` panel, so the surrounding shell's layout cannot change where the bar lands or when the gate opens.

### Do not

- **Do not re-wire a shortcut per Atlas surface.** The handler belongs to the component; adding a shell-level or node-level copy would give one key two handlers and make "which one fired" unanswerable.
- **Do not read this record as "shortcuts are automatically fine."** It says they are fine *for the hosts Atlas mounts verbatim or rebuilt out of the same sections*. A future card that rebuilds a host by writing new markup instead of re-placing the existing component — P2-7's session node is the next candidate — breaks that premise and owes its own leg in this spec.

## 3 · How each leg is made non-vacuous

A key that "works" is easy to assert falsely: a box that empties, a bar that appears, an empty byte recording. Each leg is therefore paired with the control that would catch it passing for the wrong reason.

- **The four Enter editors** each get a **bare-Enter leg first**: Enter alone must insert a newline and *not* submit. Without it, a box cleared by anything at all — a re-render, a draft reset — reads as a successful send.
- **The composer and the agents editor exercise both modifiers.** The handler is `e.metaKey || e.ctrlKey`, so a single-modifier test passes with the other half broken (the reasoning `atlas-shell-chrome.spec.ts` already gives for ⌘K/Ctrl+K). The preset and queue editors get one modifier plus the bare-Enter control — stated plainly rather than implied, because two of the four `||`s are genuinely covered by argument-from-identical-shape, not by measurement.
- **The queue editor's negative is read over REST, not off the DOM.** While the editor is open the drawer's only copy of the new text is the textarea's *value*, and Playwright's text engine does not match a textarea value — so a DOM `toHaveCount(0)` there would pass whether or not the save had fired. The daemon's own FIFO is the authority.
- **`DocFind` is tested in both polarities.** It opens when the doc is the active region and does *nothing* when the last pointerdown was on the file tree. The second half is the behaviour that keeps the browser's native find working everywhere else; an unconditional handler would hijack ⌘F app-wide and still pass a one-polarity test. The match is witnessed through the CSS Custom Highlight registry (`CSS.highlights`), because a Highlight paints no element — the bar's `1/1` readout alone only proves it counted.
- **Both clipboard absence claims are preceded by a positive control on the same page at the same moment.** Ctrl+C with nothing selected must still emit `\x03` (which is also the SIGINT half of "smart"), and an ordinary Ctrl+B must still emit `\x02` — so the later "Ctrl+V emitted no `\x16`" and "the copy emitted no `\x03`" are measured zeroes rather than a broken recorder's zero.
- **Clipboard writes are recorded at `navigator.clipboard.writeText`, not read back from the OS clipboard.** A headless context has no clipboard-read permission, and `Terminal.tsx`'s own call is `.catch(() => {})` — so a rejected real write is indistinguishable from no write at all when read from the other side. The wrapper records and calls through, the same shape as the `WebSocket.send` stdin recorder it sits beside.
- **The agents editor pins identity instead of trusting position.** `platform.spec.ts` addresses the disclosure as `.first()` and calls it "the operator's". That is a DOM-order guess. This spec expands it and asserts the textarea's value equals what REST says the operator agent holds, which both pins the guess and would catch the editor being wired to the wrong agent.

### Do not

- **Do not drop a bare-Enter leg or a control-byte control to shorten a test.** Each one is the only thing standing between its assertion and a confident false green.
- **Do not replace the clipboard recorder with a `navigator.clipboard.readText()`.** It needs a permission the harness does not grant, and its failure mode is a silent empty read.

## 4 · What was deliberately not changed

- **`/projects`' own agent editor still has no ⌘/Ctrl+Enter.** `pages/Projects.tsx`'s `AgentEditor` edits an ordinary project agent's `startupPrompt` through a plain textarea with no key handler, while `/platform`'s reserved-home editor has one. That is a real inconsistency, it predates Atlas entirely, and it is not a parity gap — §F never claimed the shortcut was there. Carded separately as `c6b80cf7`.
- **No discoverability affordance was added.** The card is parity, and parity is "the same keys still fire." Worth knowing for whoever picks that up, though: the session composer already advertises its own shortcut in its placeholder — `Send a turn to this session…  (Ctrl/Cmd+Enter)` — so one of the four editors is already discoverable and the other three (preset form, queue editor, startup-prompt editor) are not. Eyeballed at 1600×1000 under the Atlas Platform node.
- **`docs/plans/atlas-ui/01-parity-checklist.md` was not edited.** Its §F rows still read `⚠️ NOT IN MOCKUPS`, which is a true statement about the mockups. P3-sign-off is the card that produces a signed-off copy of the checklist against the *built* Atlas; the corrections in §1 above are written here for it to pick up, the same way P2-5 recorded its "the Workspace node has no board" correction rather than editing the row.

## 5 · Found while measuring: ⌘/Ctrl+C copied and cleared the model, but the selection HIGHLIGHT stayed painted

**FIXED since, by card `6b8ff4a2` — root cause and the current contract: `docs/decisions/6b8ff4a2-terminal-selection-repaint-after-copy.md`.** This section is kept as the measurement that found it; its own prohibitions are superseded below.

At the time of this card, `Terminal.tsx`'s smart-copy branch was `writeText(term.getSelection())` followed by `term.clearSelection()`. The copy was correct and the model really was cleared — but the selection the user could see was **not** repainted away.

Measured on this build, with a throwaway diagnostic driving the real canned-pty terminal (`.xterm-selection`'s child elements, and whether the wrapped `navigator.clipboard.writeText` fired):

| Probe | `.xterm-selection` children | clipboard |
|---|---|---|
| at rest | 0 | — |
| after a double-click | 2, painted (non-zero area) | — |
| **after ⌘/Ctrl+C** | **2, still painted** | `["LOOM-KBD-CLIPBOARD"]` |
| after an ordinary click elsewhere | 0 | — |

The last row is the control that makes this a finding rather than a broken instrument: the renderer *can* take the selection layer back to empty, and does so on a plain click. So the highlight survives `clearSelection()` specifically, until some later event repaints it.

It is **identical under both shells**, so Atlas introduced nothing here — it is pre-existing, and small (a stale highlight, not a lost copy and not a missed interrupt). It is also exactly the kind of thing a parity card must not quietly assert away: the first draft of this spec asserted `.xterm-selection div` count 0 after the copy, which would have forced either a wrong "it clears" claim or a silently weakened test.

### Do not

- **Do not restore this section's old prohibition.** It read "do not assert the selection highlight is gone after a copy," and card `6b8ff4a2` made that assertion true and required: the spec's clipboard leg now asserts a painted area of 0, twice, 400ms apart. The live prohibitions live in that card's own record.
- **Do not witness the MODEL's clear through the DOM either way.** A second ⌘/Ctrl+C falling through as SIGINT and copying nothing is still the only thing that proves `hasSelection()` went false; the painted-area check is a separate claim about the highlight, not a substitute for it.
- **Do not "fix" a defect like this inside a parity card.** Changing `Terminal.tsx`'s repaint behaviour is a behavioural change to a component every session mounts, and it needed its own card and its own verification — which is what `6b8ff4a2` was.
