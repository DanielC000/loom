# b6896a96 — the composer's corner cluster paints above the Spark popover

The composer's preset ("Spark") popover is a deliberate full-bleed overlay of the textarea it belongs to:
`position:absolute; left:0; right:0; bottom:0; min-height:100%`, rising from the bottom-right corner so it
never pushes layout and the `flex:1` xterm beside it never rescales. Its trigger — the sparkle button —
lives in a second absolutely-positioned cluster pinned to that same bottom-right corner, together with the
expand-to-large-editor button.

The two boxes therefore occupy the same pixels, and the popover carried the higher `z-index` (30 against the
cluster's auto). Paint order decides hit-testing, so while the popover was open it swallowed every pointer
event over its own trigger.

## What that cost

Measured on card `aac0de44` by a Playwright probe: at all five sample points across the trigger's 22x18 box,
`document.elementFromPoint` returned the popover, so the trigger was hit 0/5 times. A real
`page.mouse.click` at the trigger's centre left `aria-expanded="true"` and the dialog visible.

Two separate defects follow:

- **Accessibility.** The trigger advertises `aria-haspopup="dialog"` + `aria-expanded`, which promises a
  control that toggles. A toggle that cannot be collapsed by activating it breaks that contract. Escape and
  outside-click did work, but neither is the affordance the attribute names, and neither is discoverable.
- **The expand button was dead too.** Its own handler reads
  `setPresetsOpen(false); setExpanded(true)` — it was written to be clicked while the popover is open. It
  could not be.

Keyboard activation was never affected: focus and `Enter`/`Space` do not hit-test, so the bug was
pointer-only. That is precisely why it survived — the markup is correct and the control works for a
keyboard user.

## The fix

The cluster is the composer's persistent chrome; the popover is transient content. So the cluster paints
above it (`zIndex: 31`), rather than the popover being re-anchored away from the corner.

Rejected alternative: offsetting the popover's `bottom` to clear the cluster. It works, but it dismantles
the documented geometry — the panel stops being full-bleed, a strip of textarea shows through beneath it,
and the panel has to grow further upward over the terminal to hold the same content.

Two consequences of floating the cluster, both handled where they arise:

- `PresetPromptsPopover` reserves `TRIGGER_CLUSTER_RESERVE` (26px) of bottom padding so its content rests
  clear of the icons instead of under them.
- While open, the cluster wears the popover's own surface as a small corner chip
  (`PRESET_OVERLAY_SURFACE`, one exported constant shared by both files) so rows scrolling past it are
  cleanly occluded rather than showing through the glyphs. A negative margin bleeds the chip 2px into the
  corner without moving either button, so the trigger's hit box is byte-identical open or closed.

## Do not

- **Do not drop the cluster's `zIndex` below the popover's**, and do not raise the popover's above it. That
  is the whole defect; it reappears in full, pointer-only, and no unit test can see it.
- **Do not re-declare the popover's surface colour as a second literal.** `PRESET_OVERLAY_SURFACE` is
  exported from `PresetPrompts.tsx` and consumed by `Composer.tsx` precisely so retuning one surface cannot
  leave the chip behind on the old value.
- **Do not remove the popover's bottom padding** (or shrink it below the cluster's reach) to reclaim
  vertical space — the last preset row then sits underneath the icons.
- **Do not treat Escape / outside-click as sufficient dismissal for an `aria-expanded` control.** They are
  additions to activating the trigger, never a substitute for it.
