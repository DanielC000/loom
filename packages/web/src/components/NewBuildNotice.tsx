import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dot } from "./ui";
import { color, font, wash, fs } from "../theme";
import { api } from "../lib/api";
import { WEB_BUNDLE_QUERY_KEY, isDismissed, isSuperseded, markDismissed, ownBundle } from "../lib/newBuild";

// Card e98bf784 — "A new version of Loom is available. Reload", for a tab still running a superseded JS
// bundle after a daemon_restart rebuilt web. Mounted once in App.tsx's ShellBanners, which BOTH shells
// render (the Atlas shell receives it as a prop), so this one mount covers it.
//
// Styling deliberately mirrors the sibling UpdateBanner — the established slim-bar "a newer version
// exists → act" lane — but tinted CYAN rather than amber: amber is that npm-release banner's lane, cyan
// is the "reload to apply" lane. Both can be up at once, so they must stay apart.
//
// ⛔ NEVER auto-reload. The owner may have unsent composer text, and destroying unfinished input is a
// standing red line — the reload is a button they press. (An offer, never an automatic apply.)
//
// NO POLL: the query refetches on window focus, and FleetSocketProvider invalidates it on a ws RECONNECT
// (the strongest restart signal — a daemon restart always drops the socket). There is no refetchInterval.
export function NewBuildNotice() {
  // Never runs under `pnpm web`: there the tab's own script is /src/main.tsx and the daemon still reports
  // its own unrelated dist build, so every dev tab would false-alarm permanently. Vite statically replaces
  // import.meta.env.DEV, so this whole query is dead code in a production build.
  const enabled = !import.meta.env.DEV;
  const q = useQuery({
    queryKey: WEB_BUNDLE_QUERY_KEY,
    queryFn: ({ signal }) => api.webBundle(signal),
    enabled,
    refetchOnWindowFocus: true,
    // No refetchInterval by design — see the header.
  });

  const served = q.data?.webBundle ?? null;
  const superseded = enabled && isSuperseded(ownBundle(), served);

  // Dismissal is keyed to the SERVED hash, so dismissing one build never suppresses the NEXT one.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(served ? isDismissed(served) : false); }, [served]);

  if (!superseded || !served || dismissed) return null;

  return (
    <div role="status" data-testid="new-build-notice"
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "7px 20px",
        background: wash(color.attn, 8), borderBottom: `1px solid ${color.attn}`,
        fontSize: fs.sm }}>
      <Dot tone="attn" glow />
      {/* Flexes rather than sitting at its natural width so that at narrow widths it keeps the Dot
          company on the first row and wraps INTERNALLY, instead of being pushed whole onto the next
          row and leaving the Dot stranded alone. */}
      <span style={{ color: color.text, flex: "1 1 200px", minWidth: 0 }}>
        A new version of Loom is available.{" "}
        <span style={{ color: color.text2 }}>This tab is running an older build.</span>
      </span>
      {/* The two controls wrap as ONE unit. Left as separate flex children they split at narrow widths,
          stranding the dismiss × alone on its own row away from the action it belongs to. */}
      <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
        <Button variant="primary" data-testid="new-build-notice-reload"
          onClick={() => window.location.reload()}
          // ≥44px tall so the primary action is a real touch target at narrow widths, where this bar wraps.
          style={{ padding: "11px 14px", minHeight: 44, whiteSpace: "nowrap" }}>
          Reload
        </Button>
        <button data-testid="new-build-notice-dismiss" onClick={() => { markDismissed(served); setDismissed(true); }}
          title="dismiss" aria-label="dismiss"
          style={{ background: "transparent", border: "none", color: color.text3, cursor: "pointer",
            fontFamily: font.mono, fontSize: fs.lg, lineHeight: 1, minWidth: 44, minHeight: 44 }}>
          ×
        </button>
      </span>
    </div>
  );
}
