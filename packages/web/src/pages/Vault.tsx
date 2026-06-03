import { useEffect, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import Markdown from "../components/Markdown";
import { Panel } from "../components/ui";
import { color, font } from "../theme";

// Read-only vault browser + file viewer (§7: no editing from the UI in phase 1).
// Scoped to the header's active project (see lib/activeProject).
export default function Vault() {
  const { projectId } = useActiveProject();
  const [file, setFile] = useState<string>("");
  useEffect(() => { setFile(""); }, [projectId]); // reset the open file when the active project changes

  const tree = useQuery({ queryKey: ["vault", projectId], queryFn: () => api.vaultTree(projectId), enabled: !!projectId });
  const content = useQuery({ queryKey: ["vaultFile", projectId, file], queryFn: () => api.vaultFile(projectId, file), enabled: !!projectId && !!file, placeholderData: keepPreviousData });

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
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
