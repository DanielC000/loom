// Line-icon set for the Atlas tree. One 24×24 stroke glyph per destination, keyed by its route `to`
// so the tree can render an icon for every NAV_PAGES / ATLAS_HOMES entry without threading the SVG
// through the nav arrays. Monochrome `currentColor` so each icon themes
// with the cockpit kit (dim at rest, phosphor when its item is active). Paths are hand-authored to
// read at ~19px; drawn 1.6–1.7 stroke to match the terminal-cockpit line weight.

import type { ReactElement } from "react";

// Shared <svg> wrapper — the caller sizes it via CSS (.loom-atlas-ico svg { width/height }).
function G({ children, sw = 1.6 }: { children: ReactElement | ReactElement[]; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

// Route → glyph. Keys are the exact `to` values in nav.tsx (single source of truth for destinations).
const ICONS: Record<string, ReactElement> = {
  // The two Atlas home nodes (card fd99b2d7). Not NAV_PAGES destinations, but they key off `to`
  // through the same NavIcon, so they live in the same map.
  // One glyph for both: they ARE the same kind of node, a tier's own home, told apart by their depth
  // in the tree rather than by two near-identical house outlines.
  "/home": <G><path d="M4 10.5 12 4l8 6.5V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19v-8.5Z" /><path d="M9.6 20.4v-6h4.8v6" /></G>,
  "/project": <G><path d="M4 10.5 12 4l8 6.5V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19v-8.5Z" /><path d="M9.6 20.4v-6h4.8v6" /></G>,
  // The Agents node (card c6160c7d). Deliberately NOT /actors' two-people glyph: Actors is where a
  // rig is DEFINED, Agents is where one is STARTED, and two near-identical figures in one tree
  // would read as the same destination twice. A single figure with a play mark says "start this".
  "/agents": <G><circle cx="10" cy="7.6" r="3.2" /><path d="M3.8 19.4a6.2 6.2 0 0 1 10.3-4.6" /><path d="M15.8 14.2l4.4 2.8-4.4 2.8v-5.6Z" /></G>,
  "/platform": <G><path d="M12 3.4 3.4 8l8.6 4.6L20.6 8 12 3.4Z" /><path d="M3.4 12.4 12 17l8.6-4.6" /><path d="M3.4 16.4 12 21l8.6-4.6" /></G>,
  "/terminals": <G sw={1.7}><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="M7 10l3 2.5-3 2.5M12.5 15.5H17" /></G>,
  "/board": <G sw={1.7}><rect x="3.5" y="4" width="4.6" height="16" rx="1.2" /><rect x="9.7" y="4" width="4.6" height="11" rx="1.2" /><rect x="15.9" y="4" width="4.6" height="13" rx="1.2" /></G>,
  "/memory": <G><path d="M6 3.6h10a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5.6a2 2 0 0 1 2-2Z" /><path d="M4 16.6h13M8 8h5" /></G>,
  "/inbox": <G><path d="M3.6 13.5 6 5.6a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 5.6l2.4 7.9" /><path d="M3.6 13.5V18a1.6 1.6 0 0 0 1.6 1.6h13.6A1.6 1.6 0 0 0 20.4 18v-4.5h-5a3 3 0 0 1-6 0H3.6Z" /></G>,
  "/runs": <G><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5l5 3.5-5 3.5V8.5Z" /></G>,
  "/archive": <G><rect x="3.5" y="4.5" width="17" height="4.2" rx="1.2" /><path d="M5 8.7V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.7" /><path d="M10 12.4h4" /></G>,
  "/repository": <G><circle cx="7" cy="6" r="2.4" /><circle cx="7" cy="18" r="2.4" /><circle cx="17" cy="9" r="2.4" /><path d="M7 8.4v7.2M7 13.5a6 6 0 0 1 6.2-4.3" /></G>,
  // Not a destination any more (card acbb6df6): the tree draws this folder on every project row.
  "/projects": <G><path d="M3.5 6.4a2 2 0 0 1 2-2h3a2 2 0 0 1 1.5.7l1 1.2h6.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2V6.4Z" /></G>,
  "/actors": <G><circle cx="9" cy="8.4" r="3" /><path d="M3.6 19a5.4 5.4 0 0 1 10.8 0" /><path d="M15.4 6a3 3 0 0 1 0 5.4M16.6 14.6a5.4 5.4 0 0 1 3.8 4.4" /></G>,
  "/companion": <G><path d="M20 14a2 2 0 0 1-2 2H8.5L4 19.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8Z" /><path d="M8.5 9.5h7M8.5 12.5h4" /></G>,
  "/automation": <G><circle cx="12" cy="12" r="8.5" /><path d="M12 7.4V12l3.1 2" /></G>,
  "/usage": <G><path d="M4 4v16h16" /><rect x="7.5" y="11" width="2.6" height="6" rx=".6" /><rect x="12" y="7.5" width="2.6" height="9.5" rx=".6" /><rect x="16.5" y="13.5" width="2.6" height="3.5" rx=".6" /></G>,
  "/settings": <G><path d="M4 7h9M19 7h1M4 12h4M14 12h6M4 17h11M19 17h1" /><circle cx="15" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="17" cy="17" r="2" /></G>,
  // The Workspace tier's Settings node (card 595e2a47). The SAME sliders glyph as `/settings` above,
  // for the same reason `/home` and `/project` share one: they are the same kind of node told apart
  // by depth, and two near-identical slider stacks would read as two different things.
  "/workspace-settings": <G><path d="M4 7h9M19 7h1M4 12h4M14 12h6M4 17h11M19 17h1" /><circle cx="15" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="17" cy="17" r="2" /></G>,
  // The Workspace tier's Terminals node (card b439c2dc). The SAME prompt-in-a-frame glyph as
  // `/terminals` above, on the same rule `/workspace-settings` and `/home`/`/project` follow: they
  // are the same KIND of node told apart by depth, and a second terminal outline differing only in
  // its stroke would read as a different thing rather than the same thing one tier up.
  "/workspace-terminals": <G sw={1.7}><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="M7 10l3 2.5-3 2.5M12.5 15.5H17" /></G>,
};

// Fallback glyph for a route with no dedicated icon (a future destination added to nav.tsx before its
// icon lands): a neutral outlined square, so the tree never renders an empty icon slot.
const FALLBACK: ReactElement = <G><rect x="4.5" y="4.5" width="15" height="15" rx="2" /></G>;

export function NavIcon({ to }: { to: string }): ReactElement {
  return ICONS[to] ?? FALLBACK;
}
