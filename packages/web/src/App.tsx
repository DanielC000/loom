import { NavLink, Route, Routes } from "react-router-dom";
import Workspace from "./pages/Workspace";
import Terminals from "./pages/Terminals";
import Vault from "./pages/Vault";
import Git from "./pages/Git";
import { page } from "./ui";

const navStyle = ({ isActive }: { isActive: boolean }) =>
  ({ color: isActive ? "#9ad" : "#ccc", textDecoration: "none", marginRight: 16 });

export default function App() {
  return (
    <div style={{ background: "#0b0b0c", minHeight: "100vh", fontFamily: "ui-sans-serif, system-ui" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 20, padding: "12px 20px", borderBottom: "1px solid #2a2a2e", color: "#e6e6e6" }}>
        <strong style={{ color: "#fff" }}>Loom</strong>
        <nav>
          <NavLink to="/" style={navStyle} end>Workspace</NavLink>
          <NavLink to="/terminals" style={navStyle}>Terminals</NavLink>
          <NavLink to="/vault" style={navStyle}>Vault</NavLink>
          <NavLink to="/git" style={navStyle}>Git</NavLink>
        </nav>
      </header>
      <main style={page}>
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/terminals" element={<Terminals />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/git" element={<Git />} />
        </Routes>
      </main>
    </div>
  );
}
