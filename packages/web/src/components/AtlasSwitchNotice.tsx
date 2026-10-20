import { Button } from "./ui";
import { color, font, radius, tone } from "../theme";
import { dismissAtlasUiExternalChange, useAtlasUiExternalChange } from "../lib/atlasUi";

// Offers a cross-tab UI-preference change instead of applying it (card 757c80dd). lib/atlasUi.ts's
// `onStorage` carries the reason: hot-swapping the shell would unmount every page in this tab and
// destroy whatever the user was part-way through typing.
//
// Mounted at the app root for BOTH shells (App.tsx › ShellOverlays), because the tab receiving the
// change can be on either one. Renders null whenever there is nothing to offer, which is almost always.
export function AtlasSwitchNotice() {
  const pending = useAtlasUiExternalChange();
  if (!pending) return null;
  return (
    <div role="status" data-testid="atlas-switch-notice"
      style={{
        // Bottom-CENTRE, not the bottom-right corner: that corner is ToastContainer's own fixed stack
        // (App.tsx), at the same right/bottom/z-index, and the two would land exactly on top of each
        // other whenever an operational toast is up. Centring keeps this out of that lane without
        // coupling the two, and clears the rail gutter and the Atlas tree in both shells.
        position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 16, zIndex: 2000, maxWidth: 380,
        display: "flex", alignItems: "center", gap: 10,
        background: color.panel, border: `1px solid ${color.borderStrong}`, borderLeft: `3px solid ${tone.cyan}`,
        borderRadius: radius.base, padding: "9px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        fontFamily: font.mono, fontSize: 12,
      }}>
      <span style={{ color: color.textDim }}>The UI preference changed in another tab.</span>
      <Button data-testid="atlas-switch-notice-reload" onClick={() => window.location.reload()}
        style={{ padding: "4px 10px", whiteSpace: "nowrap" }}>Reload to apply</Button>
      <button onClick={dismissAtlasUiExternalChange} title="dismiss" aria-label="dismiss"
        style={{ background: "transparent", border: "none", color: color.textMuted, cursor: "pointer",
          fontFamily: font.mono, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}
