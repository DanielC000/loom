// ⌘/Ctrl+Enter — "save what I just typed" — for a multi-line editor with a Save beside it.
//
// Shared, because two editors of the SAME field had drifted: AgentPromptEditor bound this and
// agentEditor's own `AgentEditor` did not, so one keystroke saved a startup prompt on the Platform
// node and inserted a newline on the Projects page (card c6b80cf7) — a copied one-liner is what let
// them differ. The other three ⌘/Ctrl+Enter sites (Composer, PresetPrompts, SessionQueue) deliberately
// do NOT route through this: each sends into a live session from inside the terminal card, so folding
// them in would change the session input path.
//
// A BARE Enter is untouched: it inserts a newline, as it must in a prose field, so the modifier is the
// whole discriminator (⌘ or Ctrl, both accepted everywhere rather than sniffing the platform). With
// nothing to save the keystroke is left to the browser rather than consumed — no affordance either
// way: MEASURED in Chromium, a MODIFIED Enter in a textarea inserts no character of its own, so an
// inert ⌘/Ctrl+Enter changes neither the text nor the agent.
import type { KeyboardEvent } from "react";

/** An `onKeyDown` that runs `submit` on ⌘/Ctrl+Enter while `enabled`, and otherwise does nothing. */
export function modEnterSubmit(enabled: boolean, submit: () => void): (e: KeyboardEvent<Element>) => void {
  return (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !enabled) return;
    e.preventDefault();
    submit();
  };
}
