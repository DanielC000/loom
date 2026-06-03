import { useEffect, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MissionControl from "./pages/MissionControl";
import Workspace from "./pages/Workspace";
import Terminals from "./pages/Terminals";
import Vault from "./pages/Vault";
import Git from "./pages/Git";
import Board from "./pages/Board";
import Orchestration from "./pages/Orchestration";
import ReviewPanel from "./pages/ReviewPanel";
import Skills from "./pages/Skills";
import Profiles from "./pages/Profiles";
import Schedules from "./pages/Schedules";
import Usage from "./pages/Usage";
import Settings from "./pages/Settings";
import { NavTab, Badge, Select } from "./components/ui";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { api } from "./lib/api";
import { useAttention, useNewAttention, type AttentionItem } from "./lib/attention";
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
// (Board / Git / Vault / Orchestration). Mission Control + Terminals stay god-eye and ignore it —
// hence the quiet hint rather than hiding the control per route.
function ActiveProjectControl() {
  const { projectId, setProjectId, projects } = useActiveProject();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
      <Select value={projects.length ? projectId : ""} onChange={(e) => setProjectId(e.target.value)}>
        {projects.length === 0 && <option value="">— none —</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>(scopes detail pages)</span>
    </span>
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
        <header style={{ display: "flex", alignItems: "center", gap: 24, padding: "10px 20px", borderBottom: `1px solid ${color.border}` }}>
          <Logo />
          <nav style={{ display: "flex", gap: 18 }}>
            <NavTab to="/" end>Mission</NavTab>
            <NavTab to="/workspace">Workspace</NavTab>
            <NavTab to="/terminals">Terminals</NavTab>
            <NavTab to="/board">Board</NavTab>
            <NavTab to="/orchestration">Orchestration</NavTab>
            <NavTab to="/vault">Vault</NavTab>
            <NavTab to="/git">Git</NavTab>
            <NavTab to="/skills">Skills</NavTab>
            <NavTab to="/profiles">Profiles</NavTab>
            <NavTab to="/schedules">Schedules</NavTab>
            <NavTab to="/usage">Usage</NavTab>
            <NavTab to="/settings">Settings</NavTab>
          </nav>
          <span style={{ flex: 1 }} />
          <ActiveProjectControl />
          <Bell />
          <GlobalStatus />
        </header>
        <main style={page}>
          <Routes>
            <Route path="/" element={<MissionControl />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/terminals" element={<Terminals />} />
            <Route path="/board" element={<Board />} />
            <Route path="/orchestration" element={<Orchestration />} />
            <Route path="/review/:workerId" element={<ReviewPanel />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/git" element={<Git />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </ActiveProjectProvider>
  );
}
