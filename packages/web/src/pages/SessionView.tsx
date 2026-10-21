import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useAtlasUi } from "../lib/atlasUi";
import { activeSessionNodeTab } from "../lib/sessionNodeTabs";
import { useStopSession, useForkSession } from "../lib/useSessionActions";
import { SessionNode } from "../components/SessionNode";
import { TerminalTile } from "../components/TerminalTile";
import { Panel, Button, SectionLabel, StatusPill } from "../components/ui";
import { color, font } from "../theme";

// Deep-linkable SINGLE-session view (/session/:id) — the destination a non-merge attention alert
// (STUCK-BUSY / CRASH-LOOPED / MANAGER ASLEEP / QUEUE DRAINED / CONTEXT OVERFLOW) opens
// to, so "Open" lands on the session the alert is ACTUALLY about rather than the merge-review panel it
// used to mis-route to (card a16dfafb). A LIVE session renders the shared TerminalTile (the same Fork/
// Stop surface as the Terminals page); an EXITED one (e.g. a crash-looped session) has no live terminal,
// so it shows its status + lastError and routes the human to the Archive replay of its captured transcript.
export default function SessionView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { setProjectId } = useActiveProject();
  // The Atlas node's tab is an ADDRESS. Read here and resolved against the session's own role so an
  // unknown or role-inapplicable `?tab=` lands on Terminal rather than an empty pane.
  const [search] = useSearchParams();
  const tabParam = search.get("tab");

  // Resolve from the LIVE feed first (the common case — the alert is about a running session), then fall
  // back to a BY-ID archived fetch for an exited session (crash-looped sessions auto-archive on exit) —
  // a direct lookup, not a `.find()` over the (now paginated) full archived list, so this resolves an
  // archived session regardless of how far back it sits in archive order. A null from both ⇒ a graceful
  // "not found" rather than a blank page.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const live = (sessions.data ?? []).find((s) => s.id === id);
  const archived = useQuery({
    queryKey: ["archivedSessionById", id], queryFn: () => api.archivedSessionById(id), refetchInterval: 15000,
    enabled: !!id && !live,
  });
  const session: SessionListItem | undefined = live ?? archived.data ?? undefined;

  // Fork/Stop wired exactly like the Terminals page: graceful stop (Ctrl-C ×2, clean + resumable) and
  // fork (branch an idle conversation into a new session), both invalidating the live feed on success.
  const stop = useStopSession();
  const fork = useForkSession();

  // Inside the ATLAS frame this row is the THIRD statement of the same identity in a column that has
  // already given it twice — the crumb trail is the address, and the node head names the session and
  // carries its state. `← back` is redundant against the entity tree and "SESSION" against the crumb,
  // so the whole row goes (card 525c8ad9). Under the CLASSIC shell nothing above the page says any of
  // it, so the row is exactly as load-bearing as it always was and stays untouched.
  const [atlasOn] = useAtlasUi();
  const header = (label: string) => atlasOn ? null : (
    <div data-testid="session-view-header" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
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

  // A real fetch failure (403 remote-access denial, 500, network drop) is NOT the same claim as "this id
  // was never archived / got deleted" — `archivedSessionById` only resolves 404 to `null`, so anything
  // else surfaces here as a thrown query error. Rendering both the same way would assert a cause (genuine
  // absence) the code never actually established (code review finding: this is exactly the false-not-found
  // this card exists to prevent, just moved one layer down to a transport-level failure).
  if (!session && archived.isError) {
    return (
      <div>
        {header("Session")}
        <Panel><span style={{ color: color.red }}>Couldn’t load this session’s archive record — {(archived.error as Error).message}. Try again.</span></Panel>
      </div>
    );
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
  // Under Atlas the same session is the NODE itself (card 525c8ad9): the same terminal, composer, queue,
  // wakes and bound task, laid out as a flowing node under the frame's own head rather than as a card,
  // with its tab an address (`?tab=`) instead of a card-local toggle.
  if (session.processState === "live" || session.processState === "starting") {
    if (atlasOn) return <SessionNode session={session} tab={activeSessionNodeTab(session.role, tabParam)} />;
    return (
      <div>
        {header("Session")}
        <TerminalTile s={session} height="76vh" showProject
          onFork={() => fork.mutate(id)} forkPending={fork.isPending}
          onStop={() => stop.mutate(id)} stopPending={stop.isPending} />
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
