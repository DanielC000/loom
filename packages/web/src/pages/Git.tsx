import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { card } from "../ui";
import { ProjectSelect } from "./Vault";

// Read-only git view: branches + commit log (§: no commit/checkout/push from the UI in phase 1).
export default function Git() {
  const [projectId, setProjectId] = useState<string>("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const branches = useQuery({ queryKey: ["git-branches", projectId], queryFn: () => api.gitBranches(projectId), enabled: !!projectId });
  const log = useQuery({ queryKey: ["git-log", projectId], queryFn: () => api.gitLog(projectId), enabled: !!projectId });

  return (
    <div>
      <ProjectSelect value={projectId} onChange={setProjectId} projects={projects.data ?? []} />
      {projectId && (
        <>
          <div style={{ ...card, marginTop: 12 }}>
            <strong>Branches</strong>
            <div style={{ marginTop: 6 }}>
              {branches.data?.all.map((b) => (
                <span key={b} style={{ marginRight: 10, color: b === branches.data?.current ? "#9ad" : "#ccc" }}>
                  {b === branches.data?.current ? "● " : ""}{b}
                </span>
              ))}
            </div>
          </div>
          <div style={{ ...card, maxHeight: "60vh", overflow: "auto" }}>
            <strong>Commits</strong>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
              <tbody>
                {log.data?.map((c) => (
                  <tr key={c.hash} style={{ borderTop: "1px solid #222" }}>
                    <td style={{ color: "#888", fontFamily: "monospace", padding: "3px 8px 3px 0" }}>{c.hash.slice(0, 7)}</td>
                    <td style={{ padding: "3px 8px 3px 0" }}>{c.message}</td>
                    <td style={{ color: "#888", padding: "3px 0" }}>{c.author}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
