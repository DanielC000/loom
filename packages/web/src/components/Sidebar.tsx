// The Instrument Rail — Loom's left sidebar nav (Direction A, owner-picked 2026-07-17; replaces the
// old top header). A 60px icon-only rail at rest that expands to full labels on hover / keyboard focus
// / pin, OVERLAYING the cockpit (a 60px gutter is reserved; the expanded rail floats over content so
// switching to labels never reflows the page and the terminal keeps its width). Every destination from
// NAV_PAGES is grouped (Operate · Project · Config · System) with hairline separators; scope dots,
// the Requests badge, the Alerts badge and the RUNNING pill all survive the collapse. Reuses the
// Terminal-Cockpit tokens/kit verbatim — the rail chrome lives in styles/global.css (.loom-rail*).
import { useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useVisibleNavPages, type NavGroup } from "../nav";
import { NavIcon, AlertsIcon, PinIcon } from "./navIcons";
import { LogoMark } from "./Logo";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAttention } from "../lib/attention";
import { useDismissable } from "../lib/useDismissable";
import { color, font, radius } from "../theme";

const PIN_KEY = "loom.railPinned";

// The rail's group order + display labels. Derived from the shared NavGroup union so it can never
// drift from nav.tsx; Settings is pulled OUT of its System group and rendered in the footer (next to
// Alerts + the running pill), mirroring the mockup.
const GROUPS: { key: NavGroup; label: string }[] = [
  { key: "operate", label: "Operate" },
  { key: "project", label: "Project" },
  { key: "config", label: "Config" },
  { key: "system", label: "System" },
];

// A scope marker on nav items that respond to the active-project picker (Overview / Board / Memory /
// Runs / Repository / Settings). Hidden while the rail is collapsed (there's no room beside the icon).
function ScopeDot() {
  return <span className="loom-rail-scopedot" title="scoped to the active project" />;
}

// Active-project chip + picker, rail-styled. Reuses the fleet's shared session cache to mark projects
// with a live session (a phosphor dot on the signature + a per-row count), same logic as the old header
// control. The dropdown is position:fixed (measured off the trigger on open) so it escapes the rail's
// overflow:hidden clip while staying a DOM descendant of the dismissable wrapper (click-outside still works).
function RailProjectControl({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { projectId, setProjectId, projects } = useActiveProject();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const ref = useDismissable<HTMLDivElement>(open, () => { setOpen(false); onOpenChange(false); });

  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const liveByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessionsQ.data ?? []) {
      if (s.role === "assistant") continue;
      if (s.processState !== "live" && s.processState !== "starting") continue;
      m.set(s.projectId, (m.get(s.projectId) ?? 0) + 1);
    }
    return m;
  }, [sessionsQ.data]);

  const { live: liveProjects, idle: idleProjects } = useMemo(() => {
    const live = projects.filter((p) => (liveByProject.get(p.id) ?? 0) > 0);
    const idle = projects.filter((p) => (liveByProject.get(p.id) ?? 0) === 0);
    return { live, idle };
  }, [projects, liveByProject]);

  const hasOptions = projects.length > 0;
  const current = projects.find((p) => p.id === projectId);
  const currentLive = current ? (liveByProject.get(current.id) ?? 0) : 0;
  const initial = (current?.name ?? "—").trim().charAt(0).toUpperCase() || "—";

  const toggle = () => {
    if (!hasOptions) return;
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    const next = !open;
    setOpen(next);
    onOpenChange(next);
  };
  const choose = (id: string) => { setProjectId(id); setOpen(false); onOpenChange(false); };

  const renderItem = (p: (typeof projects)[number]) => {
    const count = liveByProject.get(p.id) ?? 0;
    const selected = p.id === projectId;
    return (
      <button key={p.id} role="option" aria-selected={selected}
        onClick={() => choose(p.id)}
        onMouseEnter={() => setHoveredId(p.id)} onMouseLeave={() => setHoveredId((h) => (h === p.id ? null : h))}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
          background: hoveredId === p.id ? color.panel2 : "transparent", border: "none", cursor: "pointer",
          color: selected ? color.phosphor : color.text, fontFamily: font.mono, fontSize: 13, padding: "6px 12px" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
        {count > 0 && (
          <span title={`${count} live session${count === 1 ? "" : "s"}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", color: color.textDim, fontSize: 11 }}>
            {count}
            <span style={{ width: 8, height: 8, borderRadius: 8, background: color.phosphor, boxShadow: `0 0 6px ${color.phosphor}` }} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div ref={ref}>
      <button ref={btnRef} className="loom-rail-proj" onClick={toggle} disabled={!hasOptions}
        aria-haspopup="listbox" aria-expanded={open} title="Active project — scopes the dotted pages. God-eye pages ignore it.">
        <span className="loom-rail-sig">{initial}{currentLive > 0 && <span className="loom-rail-sig-live" />}</span>
        <span className="loom-rail-lbl loom-rail-proj-meta">
          <span className="loom-rail-eyebrow">Project</span>
          <span className="loom-rail-proj-name">{hasOptions ? (current?.name ?? "Select project") : "— none —"}</span>
        </span>
        <span className="loom-rail-lbl loom-rail-caret" aria-hidden>▾</span>
      </button>
      {open && rect && hasOptions && (
        <div role="listbox"
          style={{ position: "fixed", left: rect.right + 8, top: rect.top, zIndex: 60, minWidth: 220, maxWidth: 320,
            // Capped to the viewport space below the trigger + scrollable: a fixed-position panel can't be
            // brought into view by window-scrolling, so with no cap a long project list would render rows
            // permanently below the fold (unreachable by mouse, keyboard, or Playwright's auto-scroll alike).
            maxHeight: `calc(100vh - ${rect.top + 16}px)`, overflowY: "auto", overflowX: "hidden",
            background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base,
            display: "flex", flexDirection: "column", padding: "4px 0", boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
          {liveProjects.map(renderItem)}
          {liveProjects.length > 0 && idleProjects.length > 0 && (
            <div aria-hidden style={{ height: 1, background: color.border, margin: "4px 0" }} />
          )}
          {idleProjects.map(renderItem)}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const pages = useVisibleNavPages();
  const [pinned, setPinned] = useState<boolean>(() => localStorage.getItem(PIN_KEY) === "1");
  const [projOpen, setProjOpen] = useState(false);

  // Alerts = the heuristic/session attention queue (merge-review, idle, context, rate-limit, stuck-busy,
  // crash-loop, orphaned-fleet). Pending manager→human REQUESTS are DELIBERATELY excluded here — they get
  // their own Requests badge below, so counting them in both made the two badges show the same number and
  // mean the same thing (they read identical 4/4 whenever pending requests dominated the queue). A request
  // item is the one attention kind that carries a `questionId` (the structural "is a request" check —
  // preferred over a kind-string compare, see lib/attention.ts), so filtering on its absence de-dups the
  // two badges. Requests badge = pending requests, from the shared openQuestions poll (react-query dedups
  // it with the attention hook's own use of the key).
  const { items: attentionItems } = useAttention();
  const alertCount = attentionItems.filter((it) => !it.questionId).length;
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 4000 });
  const pendingRequests = (questions.data ?? []).filter((q) => q.state === "pending").length;
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 4000 });
  const globalPaused = status.data?.pausedScopes.includes("global") ?? false;
  const version = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: Infinity, refetchOnWindowFocus: false });

  const togglePin = () => setPinned((p) => { const next = !p; localStorage.setItem(PIN_KEY, next ? "1" : "0"); return next; });

  const railClass = `loom-rail${pinned ? " is-pinned" : ""}${projOpen ? " is-open" : ""}`;

  return (
    <>
      <aside className={railClass} aria-label="Primary navigation">
        {/* Brand + pin. The mark carries the phosphor signal; clicking the row toggles pin. */}
        <button className="loom-rail-brand" onClick={togglePin} title={pinned ? "Unpin sidebar" : "Pin sidebar open"}>
          <span className="loom-rail-mark"><LogoMark size={20} /></span>
          <span className="loom-rail-lbl loom-rail-wordmark">loom</span>
          <span className="loom-rail-pinbtn loom-rail-revealonly" aria-hidden><PinIcon /></span>
        </button>

        <RailProjectControl onOpenChange={setProjOpen} />

        <nav className="loom-rail-nav">
          {GROUPS.map((g, gi) => {
            const items = pages.filter((p) => p.group === g.key && p.to !== "/settings");
            if (items.length === 0) return null;
            return (
              <div key={g.key}>
                {gi > 0 && <div className="loom-rail-sep" aria-hidden />}
                <div className={`loom-rail-grp${gi === 0 ? " is-first" : ""}`}>{g.label}</div>
                {items.map((p) => (
                  <NavLink key={p.to} to={p.to} end={p.end}
                    className={({ isActive }) => `loom-rail-item${isActive ? " is-active" : ""}`}>
                    <span className="loom-rail-ico"><NavIcon to={p.to} /></span>
                    <span className="loom-rail-lbl">{p.label}</span>
                    {p.scoped && <ScopeDot />}
                    {p.to === "/inbox" && pendingRequests > 0 && <span className="loom-rail-badge">{pendingRequests}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Footer: Alerts (→ Mission Control), Settings + the live running/paused pill, version. */}
        <div className="loom-rail-foot">
          <button className={`loom-rail-statrow${alertCount ? " is-alert" : ""}`} onClick={() => navigate("/")} title="attention queue">
            <span className="loom-rail-ico"><AlertsIcon /></span>
            <span className="loom-rail-lbl">Alerts</span>
            {alertCount > 0 && <span className="loom-rail-badge">{alertCount}</span>}
          </button>
          <NavLink to="/settings" className={({ isActive }) => `loom-rail-statrow${isActive ? " is-active" : ""}`}>
            <span className="loom-rail-ico"><NavIcon to="/settings" /></span>
            <span className="loom-rail-lbl">Settings</span>
            <ScopeDot />
            {status.data && (
              <span className="loom-rail-lbl loom-rail-runpill" style={globalPaused ? { color: color.red, borderColor: color.red } : undefined}>
                {globalPaused ? "paused" : "running"}
              </span>
            )}
          </NavLink>
          {version.data?.version && <div className="loom-rail-ver" title="Loom version">v{version.data.version}</div>}
        </div>
      </aside>
      <div className="loom-railgutter" aria-hidden />
    </>
  );
}
