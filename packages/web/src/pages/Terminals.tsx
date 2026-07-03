import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, ShellTerminal } from "@loom/shared";
import { api } from "../lib/api";
import { byManagerThenCreated, groupSessionRows, type SessionRowGroup } from "../lib/sessions";
import { useStopSession, useForkSession } from "../lib/useSessionActions";
import { TerminalPane } from "../components/Terminal";
import { TerminalTile } from "../components/TerminalTile";
import { TerminalCard } from "../components/TerminalCard";
import { Button, Select, Input, StatusPill, SectionLabel } from "../components/ui";
import { color, font } from "../theme";

// Tiles flow horizontally then wrap; reused per manager row and the catch-all rows. alignItems:"start" so
// each tile hugs its own content up to its cap rather than being stretched to the tallest tile in the row
// (which padded a bare card out below its composer). Content-dynamic per-card height is the intended shape.
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12, alignItems: "start" };

// One rendered row of the Claude-sessions grid. A "manager" row = its manager tile first then the
// workers it parented; "orphans"/"standalone" are the trailing catch-all rows. The grouping itself
// lives in lib/sessions.ts (groupSessionRows) — pure + hermetically tested; companions are excluded there.
type SessionRow = SessionRowGroup<SessionListItem>;

// Global Live Terminals grid: all running sessions, with a project filter, tiled, maximizable.
// Also reachable per-project by pre-selecting the filter.
export default function Terminals() {
  const [filter, setFilter] = useState<string>("");      // projectName filter ("" = all)

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });
  const stop = useStopSession();
  const fork = useForkSession();
  // Companion (assistant-role) sessions are EXCLUDED here at the source: a companion is driven ONLY
  // through its chat surface (/companion, over /ws/companion/:id), never a raw pty tile + STDIN
  // Composer. Filtering at `live` keeps them out of every downstream view — the project dropdown, the
  // counts, `shown`, and all grouping sub-lists (managers/orphans/standalone) — so a companion can
  // never leak a raw-STDIN path onto this page.
  const live = (sessions.data ?? []).filter((s) => s.processState === "live" && s.role !== "assistant");
  const projectNames = useMemo(() => [...new Set(live.map((s) => s.projectName))].sort(), [live]);
  // Tile order: the STABLE shared key (lib/sessions.ts byManagerThenCreated) — managers first, then
  // createdAt DESC (newest first), tiebreak by id within each bucket. A session keeps its slot whether
  // it's busy or idle, so the grid never reshuffles on a poll (the old activity sort made rows jump).
  // Shared with Overview so the two flat live-grids can't drift.
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort(byManagerThenCreated);
  // Manager-centric layout: one ROW per manager — the manager tile leftmost, then ITS workers to
  // the right ordered newest→oldest (createdAt DESC). Workers attach to their manager via
  // parentSessionId. Two catch-all rows trail the manager rows so nothing is dropped: orphan workers
  // (parent absent from the live set — a recycled/stopped manager) and standalone sessions (no role /
  // no parent — plain human sessions, platform leads — which must never anchor a manager row).
  // The grouping itself is the pure, hermetically-tested groupSessionRows (lib/sessions.ts), which also
  // drops companion/assistant sessions at the source so they can never render a pty tile in any row.
  const rows = useMemo<SessionRow[]>(() => groupSessionRows(shown), [shown]);

  // The slim bound-task bar is fetched + rendered by TerminalTile itself (per-session), so no task
  // lookup or prop pass is needed here — every tile shows it automatically, identically to Overview.
  const renderTile = (s: SessionListItem) => (
    <TerminalTile key={s.id} s={s} height={540} showProject
      onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
      onStop={() => stop.mutate(s.id)} stopPending={stop.isPending} />
  );

  return (
    <div>
      <ShellsSection />
      <div style={{ marginBottom: 12, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All ({live.length})</option>
          {projectNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </div>
      {shown.length === 0 && <p style={{ color: color.textMuted }}>No running sessions.</p>}
      {rows.map((row) => (
        <section key={row.key} style={{ marginBottom: 20 }}>
          <RowHeader row={row} />
          <div style={gridStyle}>{row.list.map(renderTile)}</div>
        </section>
      ))}
    </div>
  );
}

// Header for one Claude-sessions row. A manager row names its manager (project · agent · id) and the
// worker count; the catch-all rows get a plain descriptive label + member count.
function RowHeader({ row }: { row: SessionRow }) {
  if (row.kind === "manager") {
    const m = row.list[0]!; // a manager row is built as [manager, ...workers], so [0] always exists
    const workers = row.list.length - 1;
    return (
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusPill tone={m.busy ? "amber" : "phosphor"} glow={m.busy} label="manager" />
        <span style={{ fontFamily: font.mono, textTransform: "none", letterSpacing: 0 }}>
          {m.projectName} · {m.agentName} · {m.id.slice(0, 8)}
        </span>
        <span style={{ color: color.textMuted, fontWeight: 400 }}>({workers} worker{workers === 1 ? "" : "s"})</span>
      </SectionLabel>
    );
  }
  const label = row.kind === "orphans"
    ? "Orphan workers — parent manager stopped or recycled"
    : "Standalone sessions";
  return (
    <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label}
      <span style={{ color: color.textMuted, fontWeight: 400 }}>({row.list.length})</span>
    </SectionLabel>
  );
}

// Plain shell terminals (human-spawned pwsh/cmd/bash in a repo cwd). A separate lane above the Claude
// sessions — different lifecycle (ephemeral, not a DB Session) and a resizable xterm.
function ShellsSection() {
  const qc = useQueryClient();
  const [spawning, setSpawning] = useState(false);
  const shells = useQuery({ queryKey: ["terminals"], queryFn: api.terminals, refetchInterval: 4000 });
  const kill = useMutation({
    mutationFn: (id: string) => api.killTerminal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals"] }),
  });
  const live = (shells.data ?? []).filter((t) => t.alive);

  return (
    <section style={{ marginBottom: 20 }}>
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Shells
        <span style={{ color: color.textMuted, fontWeight: 400 }}>({live.length})</span>
        <Button variant="primary" style={{ padding: "0 8px", marginLeft: 4 }} onClick={() => setSpawning(true)}>+ Shell</Button>
      </SectionLabel>
      {live.length === 0 && <p style={{ color: color.textMuted, marginTop: 0 }}>No shells. Open one in a project's repo with “+ Shell”.</p>}
      {live.length > 0 && (
        <div style={gridStyle}>
          {live.map((t) => <ShellTile key={t.id} t={t} onKill={() => kill.mutate(t.id)} killing={kill.isPending} />)}
        </div>
      )}
      {spawning && <SpawnShellModal onClose={() => setSpawning(false)} />}
    </section>
  );
}

// A plain shell terminal, on the shared <TerminalCard> frame (terminal-unification epic, stage 4). A raw
// shell is NOT a DB Session — it takes keystrokes straight into xterm — so it keeps its DISTINCT body via
// `renderBody` (a resizable FitAddon pane, no turn-Composer / queue / wakes / task) and its DISTINCT
// lifecycle: hard **Kill** (confirm-gated), never graceful Stop. It gains **Maximize** from the base (was
// missing). Fork is withheld (a shell has no conversation to branch). The base's default identity/status
// title is overridden with the shell's own "shell" pill (no live `busy` signal); the Kill/confirm cluster
// rides in `actionsExtra` so the base's built-in confirm-less kill button never doubles it up. FILL height
// ("460px") keeps the old fixed-box pane that the resizable grid fits to — a shell has no grid to hug.
function ShellTile({ t, onKill, killing }: { t: ShellTerminal; onKill: () => void; killing: boolean }) {
  // Kill hard-terminates the process tree, so gate it behind an inline confirm — mirrors the
  // Schedules/Profiles/Skills delete pattern (a confirm/cancel pair in place of the action button).
  const [confirmKill, setConfirmKill] = useState(false);
  const killCluster = confirmKill ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>kill shell?</span>
      <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
        onClick={(ev) => { ev.stopPropagation(); onKill(); }}>Confirm</Button>
      <Button style={{ padding: "0 8px" }}
        onClick={(ev) => { ev.stopPropagation(); setConfirmKill(false); }}>Cancel</Button>
    </span>
  ) : (
    <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
      title="Kill this shell — hard terminate the process tree"
      onClick={(ev) => { ev.stopPropagation(); setConfirmKill(true); }}>Kill</Button>
  );

  return (
    <TerminalCard
      session={{ id: t.id }}
      height="460px"
      offerFork={false}
      lifecycle="none"
      maximizable
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          <StatusPill tone="phosphor" label="shell" />
          <span title={`${t.command}\n${t.cwd}`}>{t.label} · {t.id.slice(0, 8)}</span>
        </span>
      }
      actionsExtra={killCluster}
      renderBody={() => (
        // A resizable shell fits the pane to its box (FitAddon) — NOT readOnly (that disables stdin; a
        // shell must take keystrokes) and no Composer (it's not a turn-based DB Session).
        <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={t.id} resizable /></div>
      )}
    />
  );
}

// "+ Shell" modal: pick a project (cwd = its repoPath), an executable (prefilled with the host's
// detected default), and optional args. The spawn is a HUMAN-only REST call (never an MCP tool).
function SpawnShellModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const defaultShell = useQuery({ queryKey: ["defaultShell"], queryFn: api.defaultShell });
  const [projectId, setProjectId] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  // Prefill once the queries land: first project + the host default shell.
  useEffect(() => { const first = projects.data?.[0]; if (!projectId && first) setProjectId(first.id); }, [projects.data, projectId]);
  useEffect(() => { if (!command && defaultShell.data?.command) setCommand(defaultShell.data.command); }, [defaultShell.data, command]);

  const create = useMutation({
    mutationFn: () => api.createTerminal({
      projectId,
      command: command.trim() || undefined,
      args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["terminals"] }); onClose(); },
  });

  const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
  const box: CSSProperties = { width: 520, maxWidth: "90vw", padding: 16, background: color.panel, border: `1px solid ${color.border}`, borderRadius: 6 };
  const labelStyle: CSSProperties = { fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim, display: "block", marginBottom: 4 };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <SectionLabel>Open a shell</SectionLabel>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Project (cwd = its repo)</label>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: "100%" }}>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Executable</label>
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pwsh / bash / …" style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Args (optional, space-separated)</label>
          <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-NoLogo" style={{ width: "100%" }} />
        </div>
        {create.isError && <p style={{ color: color.red, fontSize: 12 }}>Failed to spawn — check the executable path.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!projectId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Opening…" : "Open shell"}
          </Button>
        </div>
      </div>
    </div>
  );
}
