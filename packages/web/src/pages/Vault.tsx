import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { card, input } from "../ui";
import Markdown from "../components/Markdown";

// Read-only vault browser + file viewer (§7: no editing from the UI in phase 1).
export default function Vault() {
  const [projectId, setProjectId] = useState<string>("");
  const [file, setFile] = useState<string>("");

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tree = useQuery({ queryKey: ["vault", projectId], queryFn: () => api.vaultTree(projectId), enabled: !!projectId });
  const content = useQuery({ queryKey: ["vaultFile", projectId, file], queryFn: () => api.vaultFile(projectId, file), enabled: !!projectId && !!file });

  return (
    <div>
      <ProjectSelect value={projectId} onChange={(v) => { setProjectId(v); setFile(""); }} projects={projects.data ?? []} />
      {projectId && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 12, marginTop: 12 }}>
          <div style={{ ...card, height: "74vh", overflow: "auto" }}>
            {tree.data?.filter((e) => e.type === "file").map((e) => (
              <div key={e.path}>
                <button style={{ background: "none", border: "none", color: file === e.path ? "#9ad" : "#ccc", cursor: "pointer", padding: "2px 0", textAlign: "left", font: "inherit" }}
                  onClick={() => setFile(e.path)}>{e.path}</button>
              </div>
            ))}
            {tree.data?.length === 0 && <p style={{ color: "#777" }}>Empty vault folder.</p>}
          </div>
          <div style={{ ...card, height: "74vh", overflow: "auto" }}>
            {file
              ? content.data?.content === undefined
                ? <p style={{ color: "#777" }}>…</p>
                : file.toLowerCase().endsWith(".md")
                  ? <Markdown
                      source={content.data.content}
                      files={(tree.data ?? []).filter((e) => e.type === "file").map((e) => e.path)}
                      onOpen={(p) => setFile(p)}
                    />
                  : <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13 }}>{content.data.content}</pre>
              : <p style={{ color: "#777" }}>Select a file to view (read-only).</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectSelect({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: { id: string; name: string }[] }) {
  return (
    <span>Project:{" "}
      <select style={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— select —</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </span>
  );
}
