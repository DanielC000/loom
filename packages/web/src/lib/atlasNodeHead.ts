import { createContext, useContext } from "react";

// The Atlas frame's node-head SLOT (card 525c8ad9, Atlas P2-7).
//
// The frame owns the `<h1>` that names the node; a node that has live STATE and LIFECYCLE controls (a
// session: its busy pill, harness tag, context meter, Fork / Stop / maximize) needs those on the SAME
// row, or the page states its identity twice — once as the heading and again as the card header right
// below it, which is exactly the duplication this card removes.
//
// They cannot simply be moved INTO the shell: the controls belong to the page (the fork/stop mutations)
// and to TerminalCard (its maximize state), neither of which the shell can see. So the shell publishes
// an empty element and the node portals its own header into it. One slot, one portal — the shell stays
// generic, the node keeps ownership of its own controls, and nothing has to be lifted or duplicated.
//
// `null` is the honest default: it is what EVERY consumer reads under the classic shell, which renders
// no node head at all, so a portal target is never assumed to exist.
export const AtlasNodeHeadContext = createContext<HTMLElement | null>(null);

/** The element the Atlas frame's node head exposes, or null outside that frame (the classic shell). */
export function useAtlasNodeHeadSlot(): HTMLElement | null {
  return useContext(AtlasNodeHeadContext);
}

/**
 * True when the Atlas frame is already stating this surface's identity — its crumb trail, its node
 * head `<h1>` and its tab row all name the node before the page renders a thing. A page carrying its
 * OWN title + description block suppresses that block when this reads true. Every block suppressed
 * this way carries `data-testid="page-identity"`, so one locator covers the whole set —
 * `atlas-page-identity.spec.ts` reads both polarities off it.
 *
 * @decision a7f23a2f — never re-express this as a read of the Atlas SWITCH (`useAtlasUi`). That reads
 * which shell the browser renders, not whether THIS mount sits inside the frame's content region —
 * the only condition a surface with mounts on both sides survives.
 */
export function useFrameOwnsNodeIdentity(): boolean {
  return useAtlasNodeHeadSlot() !== null;
}
