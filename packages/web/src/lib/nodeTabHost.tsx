// Where a page's OWN sub-tab query lives — card 41eab0eb.
//
// 🔴 THE PROBLEM THIS SOLVES. An Atlas node's tabs are `?tab=` on the node's own path, and card
// 41eab0eb makes seven cross-project surfaces tabs of the Workspace node. Three of those pages
// ALREADY own `?tab=` for sub-tabs of their own (Actors' Profiles|Skills, Automation's Time|Events,
// the Companion node's Chat|Manage|Terminal). Hosted as a node tab they would collide on one key:
// `/home?tab=actors`, then a click on Skills writes `?tab=skills`, the host no longer recognises its
// own tab, and the whole node falls back to Overview. Not a styling wart — the page genuinely breaks.
//
// So the HOST declares which key the guest may use, and the guest asks rather than assuming. Standing
// alone (which is what the classic shell always does) there is no host, the key is `tab`, and every
// address the classic shell has ever produced is byte-identical. Hosted, the key is the host's choice
// (`sub` today) and the host's own `tab` is untouched.
//
// @decision 41eab0eb — a page that owns a sub-tab query must read its key from here, never hardcode
// "tab". Hardcoding it is invisible under the classic shell and silently breaks the node that hosts it.
import { createContext, useContext, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

export type NodeTabHost = {
  /** The query key a hosted page's own sub-tab must use, so it cannot collide with the host's `tab`. */
  subKey: string;
};

const NodeTabHostContext = createContext<NodeTabHost | null>(null);

/** Wrap a node-tab body so the page inside it reads `subKey` instead of `tab`. */
export function NodeTabHostProvider({ subKey, children }: { subKey: string; children: ReactNode }) {
  // A stable object per key so a hosted page is not re-rendered by a new identity every frame.
  return (
    <NodeTabHostContext.Provider value={HOSTS[subKey] ?? { subKey }}>
      {children}
    </NodeTabHostContext.Provider>
  );
}

const HOSTS: Record<string, NodeTabHost> = { sub: { subKey: "sub" } };

export type TabHost = {
  /** The query key THIS page's own tab lives under — `tab` standalone, the host's key when hosted. */
  key: string;
  /** True when this page is rendered as another node's tab body. */
  hosted: boolean;
  /**
   * An address for this page with `patch` applied on top of the query it is CURRENTLY showing at.
   * A `null` value deletes its key. Merging (rather than building from scratch) is what keeps the
   * host's own `tab=` — and any sibling param the page itself carries, like the Companion node's
   * `sec=` — alive across one of this page's own tab links.
   */
  href: (patch: Record<string, string | null>) => string;
  /** The same merge, written to the address bar with `replace` (a sub-tab is not a history step). */
  set: (patch: Record<string, string | null>) => void;
};

/**
 * The key and the link builder for a page that owns a sub-tab query.
 *
 * The path is read off the LOCATION rather than passed in: a hosted body renders at the host's own
 * path and a standalone one at its own, so the live pathname is already the right answer in both
 * cases and there is no second copy of a route literal to drift.
 */
export function useTabHost(): TabHost {
  const host = useContext(NodeTabHostContext);
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const key = host?.subKey ?? "tab";

  const merge = (patch: Record<string, string | null>): URLSearchParams => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    return next;
  };

  return {
    key,
    hosted: !!host,
    href: (patch) => {
      const query = merge(patch).toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    set: (patch) => setParams(merge(patch), { replace: true }),
  };
}
