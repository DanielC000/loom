// The Atlas session node's tab set — ONE declaration, read by the node itself (components/SessionNode.tsx
// via TerminalCard) and by the frame's crumb trail (components/AtlasShell.tsx). Card 525c8ad9 (Atlas
// P2-7); the shape it encodes is the one TerminalCard's own `tabDefs` already built, verified against
// the code rather than taken from round 2's diagram: Terminal + Transcript always, Timeline for a
// manager, Diff for a worker — so 3 tabs for either of those roles and 2 for anything else.
//
// It lives in lib/ rather than beside the component because the SHELL reads it too, and a shell that
// imported the node would pull the whole session surface into every Atlas route. Nothing here fetches
// or renders; it is pure address arithmetic.

/** The pane a session node can show. Identical to TerminalCard's own `TerminalTab`, which aliases it. */
export type SessionNodeTab = "terminal" | "transcript" | "timeline" | "diff";

/**
 * Render order, and the single source of it. TerminalCard's own `tabDefs` maps over this and the labels
 * below, so the tab ROW a node draws and the tab CRUMB the frame names it by are built from one list.
 */
export const SESSION_NODE_TAB_ORDER: readonly SessionNodeTab[] = ["terminal", "transcript", "timeline", "diff"];

export const SESSION_NODE_TAB_LABEL: Record<SessionNodeTab, string> = {
  terminal: "Terminal",
  transcript: "Transcript",
  timeline: "Timeline",
  diff: "Diff",
};

/**
 * Which tabs a session of this role offers, in render order. Role-scoped exactly as
 * `Overview.tsx`'s SessionCockpit scopes TerminalCard's `tabs` prop today — a manager contributes its
 * orchestration Timeline, a worker its branch Diff — so the Atlas node and the classic cockpit can
 * never disagree about a session's tab set.
 */
export function sessionNodeTabsFor(role: string | null | undefined): SessionNodeTab[] {
  return SESSION_NODE_TAB_ORDER.filter((t) =>
    t === "timeline" ? role === "manager" : t === "diff" ? role === "worker" : true);
}

/**
 * The tab an address actually lands on. An unknown, absent or role-inapplicable `?tab=` falls back to
 * Terminal rather than rendering an empty pane — the same stale-selection guard TerminalCard applies to
 * its own local tab state.
 */
export function activeSessionNodeTab(role: string | null | undefined, raw: string | null | undefined): SessionNodeTab {
  const tabs = sessionNodeTabsFor(role);
  return tabs.find((t) => t === raw) ?? "terminal";
}

/**
 * A tab's own address.
 *
 * Diff is deliberately NOT a `?tab=diff` on /session/:id: `nav.tsx`'s PARAM_PAGES already declares
 * `/review/:workerId` to BE the worker node's Diff tab, so giving it a second address would leave one
 * surface reachable two ways, with two crumb trails, and nothing to keep them in step. Terminal is the
 * node's own bare path for the same reason — a default tab that still carried a query param would make
 * the canonical address of a session ambiguous.
 */
export function sessionNodeTabHref(sessionId: string, tab: SessionNodeTab): string {
  if (tab === "diff") return `/review/${sessionId}`;
  if (tab === "terminal") return `/session/${sessionId}`;
  return `/session/${sessionId}?tab=${tab}`;
}
