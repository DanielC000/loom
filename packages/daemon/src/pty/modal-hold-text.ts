/**
 * @decision 20ff76de — the ONE phrase naming BOTH steps of getting out of a mid-session modal hold. Every surface that
 * tells a human (composer 409, Lead card, owner alert, parent nudge) uses it, so none can drift back to "any human input
 * releases the hold" (raw terminal bytes never release).
 */
export const MODAL_RESOLVE_STEPS = "resolve the prompt in the terminal, then press Resume deliveries";
