import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import Markdown from "../components/Markdown";
import { Panel, Select } from "../components/ui";
import { color, font } from "../theme";

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
          <Panel style={{ height: "74vh", overflow: "auto", padding: 6 }}>
            {tree.data?.filter((e) => e.type === "file").map((e) => {
              const active = file === e.path;
              return (
                <button key={e.path} onClick={() => setFile(e.path)}
                  style={{
                    display: "block", width: "100%", textAlign: "left", background: "none", cursor: "pointer",
                    border: "none", borderLeft: `2px solid ${active ? color.phosphor : "transparent"}`,
                    color: active ? color.text : color.textDim, padding: "2px 8px",
                    fontFamily: font.mono, fontSize: 12,
                  }}>{e.path}</button>
              );
            })}
            {tree.data?.length === 0 && <p style={{ color: color.textMuted }}>Empty vault folder.</p>}
          </Panel>
          <Panel style={{ height: "74vh", overflow: "auto" }}>
            {file
              ? content.data?.content === undefined
                ? <p style={{ color: color.textMuted }}>…</p>
                : file.toLowerCase().endsWith(".md")
                  ? <Markdown
                      source={content.data.content}
                      files={(tree.data ?? []).filter((e) => e.type === "file").map((e) => e.path)}
                      onOpen={(p) => setFile(p)}
                    />
                  : <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 13, color: color.text }}>{content.data.content}</pre>
              : <p style={{ color: color.textMuted }}>Select a file to view (read-only).</p>}
          </Panel>
        </div>
      )}
    </div>
  );
}

export function ProjectSelect({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: { id: string; name: string }[] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— select —</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
    </span>
  );
}
