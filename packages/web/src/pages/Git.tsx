import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, SectionLabel, Dot, Button, Input } from "../components/ui";
import { color, font } from "../theme";

// Git view: branches + commit log (read), plus WRITE actions — checkout, create-branch, commit
// (stage-all + message), and push. Writes go through the daemon's HUMAN-only REST surface (no agent
// MCP tool); each returns a structured { ok, error } the UI shows. Scoped to the header's active project.
export default function Git() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const branches = useQuery({ queryKey: ["git-branches", projectId], queryFn: () => api.gitBranches(projectId), enabled: !!projectId });
  const log = useQuery({ queryKey: ["git-log", projectId], queryFn: () => api.gitLog(projectId), enabled: !!projectId });

  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");

  // Every write refetches branches + log so the view reflects the new HEAD/commit, and surfaces the
  // structured result (ok or git's own error) in the shared feedback line.
  const refresh = () => { qc.invalidateQueries({ queryKey: ["git-branches", projectId] }); qc.invalidateQueries({ queryKey: ["git-log", projectId] }); };
  const report = (ok: boolean, text: string) => setFeedback({ ok, text });

  const checkout = useMutation({
    mutationFn: (branch: string) => api.gitCheckout(projectId, branch),
    onSuccess: (r) => { refresh(); report(r.ok, r.ok ? `Switched to ${r.branch}` : (r.error ?? "checkout failed")); },
    onError: (e) => report(false, String(e)),
  });
  const createBranch = useMutation({
    mutationFn: (name: string) => api.gitCreateBranch(projectId, name),
    onSuccess: (r) => { refresh(); if (r.ok) setNewBranch(""); report(r.ok, r.ok ? `Created + switched to ${r.branch}` : (r.error ?? "create-branch failed")); },
    onError: (e) => report(false, String(e)),
  });
  const commit = useMutation({
    mutationFn: (msg: string) => api.gitCommit(projectId, msg),
    onSuccess: (r) => { refresh(); if (r.ok) setMessage(""); report(r.ok, r.ok ? `Committed ${r.hash?.slice(0, 7)}` : (r.error ?? "commit failed")); },
    onError: (e) => report(false, String(e)),
  });
  const push = useMutation({
    mutationFn: () => api.gitPush(projectId),
    onSuccess: (r) => { refresh(); report(r.ok, r.ok ? `Pushed ${r.branch}` : (r.error ?? "push failed")); },
    onError: (e) => report(false, String(e)),
  });
  const busy = checkout.isPending || createBranch.isPending || commit.isPending || push.isPending;

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && (
        <>
          {feedback && (
            <Panel style={{ marginTop: 12, borderColor: feedback.ok ? color.phosphor : color.red }}>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: feedback.ok ? color.phosphor : color.red }}>
                {feedback.ok ? "✓ " : "✗ "}{feedback.text}
              </span>
            </Panel>
          )}

          <Panel style={{ marginTop: 12 }}>
            <SectionLabel>Branches</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              {branches.data?.all.map((b) => {
                const current = b === branches.data?.current;
                return (
                  <button key={b} title={current ? "current branch" : "checkout"} disabled={current || busy}
                    onClick={() => checkout.mutate(b)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none",
                      cursor: current ? "default" : "pointer", padding: 0,
                      fontFamily: font.mono, fontSize: 12, color: current ? color.phosphor : color.textDim,
                    }}>
                    {current && <Dot tone="phosphor" glow />}{b}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${color.border}` }}>
              <Input placeholder="new-branch-name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim() && !busy) createBranch.mutate(newBranch.trim()); }}
                style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={!newBranch.trim() || busy} onClick={() => createBranch.mutate(newBranch.trim())}>+ Branch</Button>
              <Button disabled={busy} onClick={() => push.mutate()}>{push.isPending ? "Pushing…" : "Push"}</Button>
            </div>
          </Panel>

          <Panel>
            <SectionLabel>Commit</SectionLabel>
            <div style={{ display: "flex", gap: 6 }}>
              <Input placeholder="commit message (stages all changes)" value={message} onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && message.trim() && !busy) commit.mutate(message.trim()); }}
                style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={!message.trim() || busy} onClick={() => commit.mutate(message.trim())}>{commit.isPending ? "Committing…" : "Commit"}</Button>
            </div>
          </Panel>

          <Panel style={{ maxHeight: "50vh", overflow: "auto" }}>
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
