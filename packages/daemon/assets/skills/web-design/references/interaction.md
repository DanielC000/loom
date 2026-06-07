# Interaction & states

Most "unfinished"-feeling UI is missing states. A component isn't done when it looks right at rest —
it's done when every state a user can put it in looks deliberate.

## The eight states

Design and build all eight for any interactive element:

1. **Default** — at rest.
2. **Hover** — pointer over it (desktop only; gate behind `@media (hover: hover)`).
3. **Focus** — keyboard-focused; must be visibly distinct (see focus rings below).
4. **Active** — being pressed (e.g. `scale(0.97)` on a button).
5. **Disabled** — unavailable; visibly inert and not focusable, with a reason if non-obvious.
6. **Loading** — work in progress; prefer a skeleton over a spinner (below).
7. **Error** — something failed; show what and how to recover.
8. **Success** — it worked; confirm without a celebration the user didn't ask for.

Empty states count too: a list/table/search with no results needs a designed empty state, not a blank
void.

## Focus

- **Never `outline: none` without a replacement.** Removing the outline and providing nothing strands
  keyboard users. If you remove the default outline, add a visible **`:focus-visible`** ring —
  ~2–3px, ≥3:1 contrast against its background, with a small offset so it doesn't crowd the element.
- `:focus-visible` (not `:focus`) keeps the ring for keyboard users without flashing it on every mouse
  click.

## Forms

- **Placeholders are not labels.** A placeholder vanishes on input and fails accessibility — every
  field needs a real, persistent label.
- **Validate on blur**, not on every keystroke — don't yell at someone mid-typing. Show success/error
  once they leave the field, then update live as they fix it.
- Error text sits with the field it's about and says how to fix it (see `ux-writing.md`).

## Feedback patterns

- **Skeletons beat spinners** for content that's loading into a known layout — they preview the shape
  and reduce perceived wait. Spinners are for short, indeterminate waits.
- **Perceived performance is real performance.** A fast, smooth spinner *feels* faster than a slow
  one; a 180ms select feels snappier than a 400ms one even though both are "instant enough." Subsequent
  tooltips should skip the open delay once the user is clearly hovering a group.
- **Optimistic updates** (apply the change instantly, reconcile with the server after) — only for
  **low-stakes, near-certain** actions. Don't optimistically confirm a payment.

## Undo over confirm

- **Prefer undo to a confirmation dialog.** "Deleted. [Undo]" respects the common case (the user meant
  it) and still protects the mistake, without interrupting everyone with a modal. Reserve confirm
  dialogs for truly destructive, unrecoverable actions.

## Overlays & keyboard

- Use the platform primitives — `<dialog>`, the Popover API, `inert` to disable background content
  while a modal is open — rather than re-implementing focus trapping and stacking by hand.
- Support **roving tabindex** for composite widgets (toolbars, menus) and provide **skip links** so
  keyboard users can jump past repeated navigation.
- Remember the **clipped-overflow bug**: a dropdown/menu/tooltip swallowed by an ancestor's
  `overflow: hidden`. Portal it to the top layer or remove the clip.
