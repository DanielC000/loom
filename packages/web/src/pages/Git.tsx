import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, SectionLabel, Dot } from "../components/ui";
import { color, font } from "../theme";

// Read-only git view: branches + commit log (§: no commit/checkout/push from the UI in phase 1).
// Scoped to the header's active project (see lib/activeProject).
export default function Git() {
  const { projectId } = useActiveProject();
  const branches = useQuery({ queryKey: ["git-branches", projectId], queryFn: () => api.gitBranches(projectId), enabled: !!projectId });
  const log = useQuery({ queryKey: ["git-log", projectId], queryFn: () => api.gitLog(projectId), enabled: !!projectId });

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && (
        <>
          <Panel style={{ marginTop: 12 }}>
            <SectionLabel>Branches</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {branches.data?.all.map((b) => {
                const current = b === branches.data?.current;
                return (
                  <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 12, color: current ? color.phosphor : color.textDim }}>
                    {current && <Dot tone="phosphor" glow />}{b}
                  </span>
                );
              })}
            </div>
          </Panel>
          <Panel style={{ maxHeight: "60vh", overflow: "auto" }}>
            <SectionLabel>Commits</SectionLabel>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: font.mono, fontSize: 13 }}>
              <tbody>
                {log.data?.map((c) => (
                  <tr key={c.hash} style={{ borderTop: `1px solid ${color.border}` }}>
                    <td style={{ color: color.cyan, padding: "3px 8px 3px 0", whiteSpace: "nowrap" }}>{c.hash.slice(0, 7)}</td>
                    <td style={{ color: color.text, padding: "3px 8px 3px 0" }}>{c.message}</td>
                    <td style={{ color: color.textMuted, padding: "3px 0", whiteSpace: "nowrap" }}>{c.author}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
