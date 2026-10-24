import { createContext, useContext, type ReactNode } from "react";

// ── The dev End-user PREVIEW flag, as a CONTEXT rather than a prop thread ─────────────────────────────
//
// @decision b472645a — only `pages/Platform.tsx` may mount this provider, and nothing below it may read
// the `ViewAsToggle`, its persisted `loom.platformViewAs` key, or browser storage to decide the preview.
// Pinned in test/platform-edition.mjs.
//
// WHY A CONTEXT, where that card's other gated surfaces each take a threaded `previewOnly` prop (card
// edfd8295). Threading works for them because every gated leaf is a component `pages/PlatformView.tsx`
// itself mounts. It does not reach the Board's connected-requests rail, for two reasons a prop cannot be
// threaded past:
//
//   1. The control sits THREE hops inside `pages/Board.tsx` (Board → TaskDrawer → ConnectedRequestsRail →
//      ConnectedRequestRow) — a component with five mount sites, exactly one of which is the preview. Each
//      intermediate hop would have to carry a flag that is none of its business, which is precisely the
//      pressure that makes the next author of a deep control skip the gate instead of extending it.
//   2. The WRITES it reaches are not in Board's tree at all. "Open request ↗" calls the app-root
//      `RequestModalProvider` (`components/requests.tsx`), mounted beside the router in `App.tsx` — so no
//      prop from Platform.tsx can ever reach the answer / permission / credential controls themselves,
//      however many hops it is threaded through.
//
// A context answers both without moving the decision: Platform.tsx still DECIDES (the provider is mounted
// at exactly the one place that already passes `previewOnly`), everything below still merely RECEIVES a
// boolean, and a consumer reads it wherever it happens to sit — including in a subtree a prop cannot reach.
const PreviewOnlyContext = createContext(false);

// Mounted ONLY around the dev "View as: End-user" preview, so it deliberately takes no `value`: being
// inside it IS the statement. A value prop would let a caller mount it with `false` and believe they had
// gated something — the one mistake a boolean context should not make possible.
export function PreviewOnlyProvider({ children }: { children: ReactNode }) {
  return <PreviewOnlyContext.Provider value={true}>{children}</PreviewOnlyContext.Provider>;
}

/** True when this subtree is a dev install's read-only End-user preview; false everywhere else. */
export function usePreviewOnly(): boolean {
  return useContext(PreviewOnlyContext);
}

// The held control's own tooltip. It lives HERE, not beside PlatformView.tsx's own
// PREVIEW_DISABLED_TITLE/NOTE pair, because PlatformView imports Board — so a Board-side control reading
// that constant would close an import cycle. Same register as that pair ("acting here is disabled"),
// named for what this particular control would otherwise have done.
export const PREVIEW_REQUEST_HELD_TITLE =
  "Preview only on a dev install — answering this home's requests here is disabled";
