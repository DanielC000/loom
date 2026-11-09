# fa8a2887 — the Atlas tree is one Tab stop, and the shell has a skip link

Card `fa8a2887`, finding A-30 of the owner's Atlas audit (epic `898a64ef`). With 5 projects it took 21 Tab presses to get from the top of `/home` to the page, 3 more for every project (twist, row, `＋`).

## What was built

- **Skip link** (`AtlasShell.tsx`): the shell's first focusable element, "Skip to content". Hidden until focused, then pinned top-left. Activating it focuses `<main id="atlas-content" tabIndex={-1}>`; the next Tab lands on the page's first control.
- **Roving focus** (`AtlasTree.tsx`): the same approach as the board's (card `591fe6ed`, `lib/boardFocus.ts`). Row controls are marked `data-atlas-tree-item` and read off the DOM at keypress time. Exactly one has `tabIndex=0`: the last row the user focused, else the landed row (`.is-active` / `aria-current`), else the first. It is resolved in a layout effect after every render, so a row that leaves the DOM (a branch collapsed, a session ended) hands the stop on before paint.
- Keys: ↑↓ next/previous row, Home/End first/last, → expands a closed row and steps into the first child of an open one, ← collapses an open row and steps out to the parent of a closed one, Enter activates natively (the rows are real links and buttons).
- The twist buttons are `tabIndex=-1`: → and ← do their job. A project row's `＋` (quick spawn) is reachable only on the row holding the stop, so the tree costs at most two stops whatever the project count.

## Why native roles, not `role="tree"`

The rows stay `<a>` and `<button>`. A `role="treeitem"` on them would erase the link and button roles that the e2e suite and assistive tech both address them by. Correct tree semantics would also need `aria-owns` from each row to its child list, because the child `<ul>` is a sibling of the row control, not its child. The board made the same call: it has a roving grid without `role="grid"`. The keyboard contract is the tree-view pattern's; the semantics stay honest about what each control does.

## Do not

- Do not put the twists back in the Tab order, or the `＋` of a row that is not holding the stop. Either one makes the stop count grow with the project count again.
- Do not keep a second, hand-maintained list of tree rows to navigate. The order is the DOM's.
- Do not make `<main>` a Tab stop. It is `tabIndex=-1` so it can only be a skip target.
