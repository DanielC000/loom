import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { activeSessionNodeTab } from "../lib/sessionNodeTabs";
import { SessionNode } from "../components/SessionNode";
import { Panel, Button, SectionLabel, StatusPill } from "../components/ui";
import { color, font, fs, radius } from "../theme";

// Deep-linkable SINGLE-session view (/session/:id) — the destination a non-merge attention alert
// (STUCK-BUSY / CRASH-LOOPED / MANAGER ASLEEP / QUEUE DRAINED / CONTEXT OVERFLOW) opens
// to, so "Open" lands on the session the alert is ACTUALLY about rather than the merge-review panel it
// used to mis-route to (card a16dfafb). A LIVE session renders the session node; an EXITED one (e.g. a crash-looped session) has no live terminal,
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
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const live = (sessions.data ?? []).find((s) => s.id === id);
  const archived = useQuery({
    queryKey: ["archivedSessionById", id], queryFn: ({ signal }) => api.archivedSessionById(id, signal), refetchInterval: 15000,
    enabled: !!id && !live,
  });
  const session: SessionListItem | undefined = live ?? archived.data ?? undefined;

  // Still resolving (neither feed has answered) — don't flash "not found" before the archived fetch lands.
  if (!session && (sessions.isLoading || archived.isLoading)) {
    return <Panel><span style={{ color: color.text3 }}>Loading…</span></Panel>;
  }

  // A real fetch failure (403 remote-access denial, 500, network drop) is NOT the same claim as "this id
  // was never archived / got deleted" — `archivedSessionById` only resolves 404 to `null`, so anything
  // else surfaces here as a thrown query error. Rendering both the same way would assert a cause (genuine
  // absence) the code never actually established (code review finding: this is exactly the false-not-found
  // this card exists to prevent, just moved one layer down to a transport-level failure).
  if (!session && archived.isError) {
    return (
      <Panel><span style={{ color: color.danger }}>Couldn’t load this session’s archive record — {(archived.error as Error).message}. Try again.</span></Panel>
    );
  }

  if (!session) {
    return (
      <Panel><span style={{ color: color.text3 }}>Session {id.slice(0, 8)} not found — it may have been deleted from the archive.</span></Panel>
    );
  }

  // LIVE (or starting): the session NODE (card 525c8ad9) — its terminal, composer, queue, wakes and bound
  // task, laid out under the frame's own head, with Fork and Stop in that head and the tab an address
  // (`?tab=`). The frame's crumb trail and node head already name the session, so this page adds no
  // header row of its own in any state.
  if (session.processState === "live" || session.processState === "starting") {
    return <SessionNode session={session} tab={activeSessionNodeTab(session.role, tabParam)} />;
  }

  // EXITED: no live terminal. Surface the final status + lastError and route to the Archive replay of the
  // captured transcript (scoped to this session's project so the Archive page lands on the right tree).
  const openArchive = () => { setProjectId(session.projectId); navigate("/archive"); };
  return (
    <div>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill tone="muted" label={session.processState} />
          <span style={{ fontSize: fs.sm, color: color.text2 }}>
            last active {new Date(session.lastActivity).toLocaleString()}
          </span>
        </div>
        {session.lastError ? (
          <div>
            <SectionLabel style={{ marginTop: 0 }}>Last error</SectionLabel>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: fs.mono,
              color: color.danger, background: color.inset, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: "8px 10px" }}>
              {session.lastError}
            </pre>
          </div>
        ) : (
          <span style={{ color: color.text3, fontSize: fs.sm }}>No error recorded — the session exited cleanly.</span>
        )}
        <div>
          <Button variant="primary" onClick={openArchive}>View transcript in Archive →</Button>
        </div>
      </Panel>
    </div>
  );
}
