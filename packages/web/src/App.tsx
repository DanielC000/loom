import { useEffect, useRef } from "react";
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
import { NavTab, Badge, Select } from "./components/ui";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { api } from "./lib/api";
import { useAttention } from "./lib/attention";
import { ActiveProjectProvider, useActiveProject } from "./lib/activeProject";
import { color, font } from "./theme";
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
function Bell() {
  const { items, count } = useAttention();
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }, []);
  useEffect(() => {
    if (seen.current === null) { seen.current = new Set(items.map((i) => i.key)); return; }
    for (const it of items) {
      if (!seen.current.has(it.key) && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`Loom · ${it.kind}`, { body: it.text });
      }
    }
    seen.current = new Set(items.map((i) => i.key)); // drop departed keys so a re-occurrence re-notifies
  }, [items]);

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

export default function App() {
  return (
    <ActiveProjectProvider>
      <div style={{ minHeight: "100vh" }}>
        <CommandPalette />
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
          </Routes>
        </main>
      </div>
    </ActiveProjectProvider>
  );
}
