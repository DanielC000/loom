import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { DeveloperPlatformView } from "./DeveloperPlatformView";
import { EndUserPlatformView } from "./EndUserPlatformView";
import { color, font, radius } from "../theme";

// The single consolidated Platform page — ONE nav tab → one /platform route. It renders ONE of two
// view-components decided by EDITION, where the edition signal is the SAME one useVisibleNavPages uses:
// the reserved "Loom Platform" home existing (GET /api/platform/home → 200 + project ⇒ DEV edition;
// 404 / no project ⇒ SHIPPING edition — it only resolves under LOOM_DEV). Dev defaults to the full
// Developer surface (Lead/Auditor go-live, sessions, schedules, history, board) plus a "View as:
// Developer | End-user" toggle that PREVIEWS the End-user surface; shipping renders the End-user surface
// (the operator + Workspace Auditor + B6 cadence) ONLY, with no toggle.
//
// HARD INVARIANT (the whole reason this is owner-gated): the toggle is a PURE CLIENT-SIDE VIEW SWITCH.
// `viewAs` is plain React state (persisted to localStorage only for stickiness). It decides which view
// COMPONENT mounts and NOTHING else — it is never read by, passed to, or wired into any spawn / role /
// stop REST call. Each view keeps its OWN existing role-bound api calls, all edition-driven and decided
// SERVER-SIDE (Developer → startSession "platform"/"auditor"; End-user → "setup"/"workspace-auditor").
// A dev previewing "End-user" still holds their real platform capability server-side — the toggle only
// changes what UI renders, never what role/auth any request carries.
type ViewAs = "developer" | "enduser";
const VIEW_AS_KEY = "loom.platformViewAs";

export default function Platform() {
  // retry:false so a shipping user's expected 404 settles to "shipping" without spinning the default 3
  // retries first. Same query key as useVisibleNavPages → one shared, cached fetch.
  const home = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = home.isSuccess && !!home.data?.project;

  const [viewAs, setViewAs] = useState<ViewAs>(() =>
    localStorage.getItem(VIEW_AS_KEY) === "enduser" ? "enduser" : "developer");
  const setView = (v: ViewAs) => { setViewAs(v); localStorage.setItem(VIEW_AS_KEY, v); };

  // Hold until the edition signal settles, so a shipping user never flashes the dev surface.
  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Platform home…</p>;

  // Shipping edition: the end-user surface only — no "View as" toggle (a shipping user never sees "Developer").
  if (!isDev) return <EndUserPlatformView />;

  // Dev edition: default the Developer surface + a client-only "View as" preview toggle.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ViewAsToggle value={viewAs} onChange={setView} />
      {viewAs === "developer" ? <DeveloperPlatformView /> : <EndUserPlatformView />}
    </div>
  );
}

// Dev-only segmented control. Purely cosmetic — it sets local `viewAs` state and nothing else (see the
// HARD INVARIANT above). Shown only in the dev edition, so a shipping build never renders it.
function ViewAsToggle({ value, onChange }: { value: ViewAs; onChange: (v: ViewAs) => void }) {
  const options: { key: ViewAs; label: string }[] = [
    { key: "developer", label: "Developer" },
    { key: "enduser", label: "End-user" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>View as</span>
      <div role="group" aria-label="Preview edition"
        style={{ display: "inline-flex", border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, overflow: "hidden" }}>
        {options.map((o) => {
          const active = value === o.key;
          return (
            <button key={o.key} onClick={() => onChange(o.key)} aria-pressed={active}
              title={o.key === "developer" ? "The dev Loom Platform surface" : "Preview the shipping end-user surface (client-side only)"}
              style={{
                fontFamily: font.mono, fontSize: 12, padding: "4px 14px", cursor: "pointer", border: "none",
                background: active ? color.phosphor : "transparent",
                color: active ? color.bg : color.textDim,
                fontWeight: active ? 700 : 400,
              }}>
              {o.label}
            </button>
          );
        })}
      </div>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
        client-side preview — your real platform capability is unchanged
      </span>
    </div>
  );
}
