import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { TerminalTile } from "../components/TerminalTile";
import { Panel, Button, SectionLabel, StatusPill } from "../components/ui";
import { color, font } from "../theme";

// Deep-linkable SINGLE-session view (/session/:id) — the destination a non-merge attention alert
// (STUCK-BUSY / CRASH-LOOPED / MANAGER ASLEEP / NEEDS A HUMAN / QUEUE DRAINED / CONTEXT OVERFLOW) opens
// to, so "Open" lands on the session the alert is ACTUALLY about rather than the merge-review panel it
// used to mis-route to (card a16dfafb). A LIVE session renders the shared TerminalTile (the same Fork/
// Stop surface as the Terminals page); an EXITED one (e.g. a crash-looped session) has no live terminal,
// so it shows its status + lastError and routes the human to the Archive replay of its captured transcript.
export default function SessionView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setProjectId } = useActiveProject();

  // Resolve from the LIVE feed first (the common case — the alert is about a running session), then fall
  // back to the archived feed for an exited session (crash-looped sessions auto-archive on exit). A null
  // from both ⇒ a graceful "not found" rather than a blank page.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const live = (sessions.data ?? []).find((s) => s.id === id);
  const archived = useQuery({
    queryKey: ["allArchivedSessions"], queryFn: api.allArchivedSessions, refetchInterval: 15000,
    enabled: !!id && !live,
  });
  const session: SessionListItem | undefined = live ?? (archived.data ?? []).find((s) => s.id === id);

  // Fork/Stop wired exactly like the Terminals page: graceful stop (Ctrl-C ×2, clean + resumable) and
  // fork (branch an idle conversation into a new session), both invalidating the live feed on success.
  const stop = useMutation({
    mutationFn: () => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const fork = useMutation({
    mutationFn: () => api.forkSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });

  const header = (label: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      <Button onClick={() => navigate(-1)}>← back</Button>
      <span style={{ fontFamily: font.head, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{label}</span>
      {session && (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          {session.projectName} · {session.agentName}{session.role ? ` · ${session.role}` : ""} · {session.id.slice(0, 8)}
        </span>
      )}
    </div>
  );

  // Still resolving (neither feed has answered) — don't flash "not found" before the archived fetch lands.
  if (!session && (sessions.isLoading || archived.isLoading)) {
    return <div>{header("Session")}<Panel><span style={{ color: color.textMuted }}>Loading…</span></Panel></div>;
  }

  if (!session) {
    return (
      <div>
        {header("Session")}
        <Panel><span style={{ color: color.textMuted }}>Session {id.slice(0, 8)} not found — it may have been deleted from the archive.</span></Panel>
      </div>
    );
  }

  // LIVE (or starting): the full terminal tile — read the scrollback, message it, Fork or Stop it here.
  if (session.processState === "live" || session.processState === "starting") {
    return (
      <div>
        {header("Session")}
        <TerminalTile s={session} height="76vh" showProject
          onFork={() => fork.mutate()} forkPending={fork.isPending}
          onStop={() => stop.mutate()} stopPending={stop.isPending} />
      </div>
    );
  }

  // EXITED: no live terminal. Surface the final status + lastError and route to the Archive replay of the
  // captured transcript (scoped to this session's project so the Archive page lands on the right tree).
  const openArchive = () => { setProjectId(session.projectId); navigate("/archive"); };
  return (
    <div>
      {header("Session ended")}
      <Panel style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill tone="muted" label={session.processState} />
          <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
            last active {new Date(session.lastActivity).toLocaleString()}
          </span>
        </div>
        {session.lastError ? (
          <div>
            <SectionLabel style={{ marginTop: 0 }}>Last error</SectionLabel>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: 12,
              color: color.red, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: 4, padding: "8px 10px" }}>
              {session.lastError}
            </pre>
          </div>
        ) : (
          <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No error recorded — the session exited cleanly.</span>
        )}
        <div>
          <Button variant="primary" onClick={openArchive}>View transcript in Archive →</Button>
        </div>
      </Panel>
    </div>
  );
}
