import { Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import MissionControl from "./pages/MissionControl";
import Workspace from "./pages/Workspace";
import Terminals from "./pages/Terminals";
import Vault from "./pages/Vault";
import Git from "./pages/Git";
import Board from "./pages/Board";
import Orchestration from "./pages/Orchestration";
import { NavTab, Badge } from "./components/ui";
import { api } from "./lib/api";
import { color, font } from "./theme";
import { page } from "./ui";

// Live global orchestration status (RUNNING / PAUSED), polled into the top bar.
function GlobalStatus() {
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 4000 });
  if (!status.data) return null;
  const globalPaused = status.data.pausedScopes.includes("global");
  return <Badge tone={globalPaused ? "red" : "phosphor"}>{globalPaused ? "paused" : "running"}</Badge>;
}

export default function App() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 24, padding: "10px 20px", borderBottom: `1px solid ${color.border}` }}>
        <strong style={{ fontFamily: font.head, letterSpacing: "0.18em", color: color.text, fontSize: 15 }}>LOOM</strong>
        <nav style={{ display: "flex", gap: 18 }}>
          <NavTab to="/" end>Mission</NavTab>
          <NavTab to="/workspace">Workspace</NavTab>
          <NavTab to="/terminals">Terminals</NavTab>
          <NavTab to="/board">Board</NavTab>
          <NavTab to="/orchestration">Orchestration</NavTab>
          <NavTab to="/vault">Vault</NavTab>
          <NavTab to="/git">Git</NavTab>
        </nav>
        <span style={{ flex: 1 }} />
        <GlobalStatus />
      </header>
      <main style={page}>
        <Routes>
          <Route path="/" element={<MissionControl />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/terminals" element={<Terminals />} />
          <Route path="/board" element={<Board />} />
          <Route path="/orchestration" element={<Orchestration />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/git" element={<Git />} />
        </Routes>
      </main>
    </div>
  );
}
