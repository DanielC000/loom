import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";

// Phase-1 viewport skeleton. Real pages (Dashboard, Topic views, Live Terminals grid,
// read-only Vault browser, read-only Git view, Task board, Transcript view) build out from here.
export default function App() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui", padding: 24, color: "#e6e6e6", background: "#0b0b0c", minHeight: "100vh" }}>
      <h1 style={{ marginTop: 0 }}>Loom</h1>
      <p style={{ color: "#9ad" }}>Local-first AI project workspace — daemon viewport.</p>

      <h2>Projects</h2>
      {projects.isLoading && <p>Loading…</p>}
      {projects.isError && <p style={{ color: "#e88" }}>Daemon not reachable. Start it with <code>pnpm daemon</code>.</p>}
      <ul>
        {projects.data?.map((p) => (
          <li key={p.id}>{p.name} <span style={{ color: "#777" }}>— {p.repoPath}</span></li>
        ))}
        {projects.data?.length === 0 && <li style={{ color: "#777" }}>No projects yet.</li>}
      </ul>

      <p style={{ color: "#666", marginTop: 32, fontSize: 13 }}>
        Next build steps: project create/bind, Topic views, Live Terminals grid (uses
        <code> TerminalPane</code>), read-only Vault + Git, Task board, Transcript view.
      </p>
    </div>
  );
}
