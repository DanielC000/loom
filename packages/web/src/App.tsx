import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReviewPanel from "./pages/ReviewPanel";
import { NAV_PAGES, type NavGroup } from "./nav";
import { NavTab, Badge, Select } from "./components/ui";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { api } from "./lib/api";
import { useAttention, useNewAttention, type AttentionItem } from "./lib/attention";
import { useDismissable } from "./lib/useDismissable";
import { ActiveProjectProvider, useActiveProject } from "./lib/activeProject";
import { color, font, radius, tone } from "./theme";
import { Dot } from "./components/ui";
import { page } from "./ui";

// Live global orchestration status (RUNNING / PAUSED), polled into the top bar.
function GlobalStatus() {
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 4000 });
  if (!status.data) return null;
  const globalPaused = status.data.pausedScopes.includes("global");
  return <Badge tone={globalPaused ? "red" : "phosphor"}>{globalPaused ? "paused" : "running"}</Badge>;
}

// Shell alert bell: count of attention-queue items + a browser Notification when a NEW one appears
// (seeded silently on first load so a reload doesn't replay the backlog). Click → Mission Control.
// The new-item detection lives in useNewAttention so the bell and the in-app toast stack share it.
function Bell() {
  const { count } = useAttention();
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }, []);
  useNewAttention((it) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Loom · ${it.kind}`, { body: it.text });
    }
  });

  return (
    <button onClick={() => navigate("/")} title="attention queue"
      style={{ fontFamily: font.mono, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
        color: count ? color.amber : color.textDim, border: `1px solid ${count ? color.amber : color.borderStrong}`,
        background: "transparent", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
      Alerts {count}
    </button>
  );
}

// Header active-project selector. Persists the one project that scopes the detail pages
// (the nav items marked with a scope dot — Overview / Board / Runs / Orchestration / Vault /
// Git / Schedules / Settings). Mission Control, Terminals and the other god-eye pages ignore it
// — hence the quiet tooltip rather than hiding the control per route. Lives on the LEFT, right
// after the logo, so the active scope reads before the destinations it scopes.
function ActiveProjectControl() {
  const { projectId, setProjectId, projects } = useActiveProject();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
      <Select value={projects.length ? projectId : ""} onChange={(e) => setProjectId(e.target.value)}
        title="Scopes the project-scoped pages (marked with a dot). God-eye pages ignore this.">
        {projects.length === 0 && <option value="">— none —</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
    </span>
  );
}

// The running daemon's Loom version (Releases v1 Part 3), fetched from GET /api/version and shown as a
// quiet `v0.1.0` chip at the far right of the header. Unobtrusive: dim, monospace, never shifts layout —
// renders nothing until the version resolves, so a slow/absent endpoint just leaves the spot empty.
function VersionTag() {
  const v = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: Infinity, refetchOnWindowFocus: false });
  if (!v.data?.version) return null;
  return (
    <span title="Loom version" style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: "0.04em", color: color.textMuted }}>
      v{v.data.version}
    </span>
  );
}

// A subtle marker on nav items that respond to the active-project picker (see ActiveProjectControl).
function ScopeDot() {
  return (
    <span title="scoped to the active project"
      style={{ width: 4, height: 4, borderRadius: 4, background: color.cyan, opacity: 0.85, display: "inline-block", marginLeft: 5, flex: "none", verticalAlign: "middle" }} />
  );
}

// Thin vertical hairline used to separate the header's left-cluster groups.
function HeaderDivider() {
  return <span aria-hidden style={{ width: 1, height: 20, background: color.border, flex: "none" }} />;
}

// The "More ▾" overflow menu: the non-primary nav pages, grouped by section. Mirrors the
// SpawnControls dropdown pattern (position:relative wrapper, useDismissable click-outside/Escape
// close, Panel/borderStrong/token styling, zIndex). The button shows the active (phosphor) state
// when the current route is one of its items, so a nested page still reads as "selected" from the
// collapsed header.
const MORE_GROUPS: { key: NavGroup; label: string }[] = [
  { key: "operate", label: "Operate" },
  { key: "project", label: "Project" },
  { key: "config", label: "Config" },
  { key: "system", label: "System" },
];

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const items = NAV_PAGES.filter((p) => !p.primary);
  const isActive = items.some((p) => p.to === location.pathname);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={() => setOpen((o) => !o)} className={`loom-navtab${isActive ? " is-active" : ""}`}
        style={{ background: "transparent", border: "none", borderBottom: `2px solid ${isActive ? color.phosphor : "transparent"}`, cursor: "pointer" }}>
        More ▾
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 6, zIndex: 30, minWidth: 200,
          background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, overflow: "hidden",
          display: "flex", flexDirection: "column", padding: "4px 0", boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
          {MORE_GROUPS.map((g) => {
            const groupItems = items.filter((p) => p.group === g.key);
            if (groupItems.length === 0) return null;
            return (
              <div key={g.key}>
                <div style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, padding: "6px 12px 2px" }}>{g.label}</div>
                {groupItems.map((p) => {
                  const active = location.pathname === p.to;
                  return (
                    <button key={p.to} className="loom-btn loom-btn-ghost"
                      onClick={() => { setOpen(false); navigate(p.to); }}
                      style={{ display: "inline-flex", alignItems: "center", textAlign: "left", background: "transparent", border: "none",
                        color: active ? color.phosphor : color.text, fontFamily: font.mono, fontSize: 12, padding: "6px 12px", cursor: "pointer" }}>
                      {p.label}{p.scoped && <ScopeDot />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// In-app surface of the same "new attention item" signal the bell uses: a transient toast stack so
// the human notices a merge-request / rate-limit / stuck-busy / idle-escalation without watching the
// bell. Shares useNewAttention with the bell, so each new item pings once per surface — never twice
// on one surface. Each toast auto-dismisses (~6s), has a manual ×, and clicks through to the item.
const TOAST_TTL_MS = 6000;
let nextToastId = 0;

function ToastContainer() {
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<{ id: number; item: AttentionItem }[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  useNewAttention((item) => {
    const id = nextToastId++;
    setToasts((ts) => [...ts, { id, item }]);
  });

  if (toasts.length === 0) return null;
  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 2000, maxWidth: 380 }}>
      {toasts.map(({ id, item }) => (
        <Toast key={id} item={item}
          onDismiss={() => dismiss(id)}
          onOpen={() => {
            navigate(item.workerSessionId ? `/review/${item.workerSessionId}` : "/");
            dismiss(id);
          }} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss, onOpen }: { item: AttentionItem; onDismiss: () => void; onOpen: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true)); // mount → slide/fade in
    const ttl = setTimeout(onDismiss, TOAST_TTL_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(ttl); };
  }, []); // run once: a re-rendered onDismiss closure must not reset the timer
  const c = tone[item.tone];
  return (
    <div onClick={onOpen} title={item.workerSessionId ? "open" : undefined}
      style={{
        display: "flex", alignItems: "flex-start", gap: 10, width: 360,
        background: color.panel, border: `1px solid ${color.borderStrong}`, borderLeft: `3px solid ${c}`,
        borderRadius: radius.base, padding: "10px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        cursor: item.workerSessionId ? "pointer" : "default",
        opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 160ms ease, transform 160ms ease",
      }}>
      <Dot tone={item.tone} glow={item.tone === "amber" || item.tone === "red"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: font.mono, fontSize: 11, color: c, textTransform: "uppercase", letterSpacing: "0.06em" }}>{item.kind}</div>
        <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, marginTop: 3, wordBreak: "break-word" }}>{item.text}</div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="dismiss"
        style={{ background: "transparent", border: "none", color: color.textMuted, cursor: "pointer", fontFamily: font.mono, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

export default function App() {
  return (
    <ActiveProjectProvider>
      <div style={{ minHeight: "100vh" }}>
        <CommandPalette />
        <ToastContainer />
        <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 20px", borderBottom: `1px solid ${color.border}` }}>
          <Logo />
          <HeaderDivider />
          <ActiveProjectControl />
          <HeaderDivider />
          <nav style={{ display: "flex", gap: 18, alignItems: "center" }}>
            {NAV_PAGES.filter((p) => p.primary).map((p) => (
              <NavTab key={p.to} to={p.to} end={p.end}>
                {p.nav ?? p.label}{p.scoped && <ScopeDot />}
              </NavTab>
            ))}
            <MoreMenu />
          </nav>
          <span style={{ flex: 1 }} />
          <Bell />
          <GlobalStatus />
          <VersionTag />
        </header>
        <main style={page}>
          <Routes>
            {NAV_PAGES.map((p) => (
              <Route key={p.to} path={p.to} element={p.element} />
            ))}
            <Route path="/review/:workerId" element={<ReviewPanel />} />
          </Routes>
        </main>
      </div>
    </ActiveProjectProvider>
  );
}
