import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TranscriptTurn } from "../lib/api";
import { color, font } from "../theme";
import { Badge, Button, Input } from "./ui";

type RoleFilter = "all" | "user" | "assistant";

// Split `text` into plain runs + <mark>ed runs for every case-insensitive occurrence of `q`.
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i <= text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={k++} style={{ background: color.phosphorDim, color: color.text, borderRadius: 2 }}>
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return out;
}

// Renders Claude's session JSONL as a clean, ordered conversation — the canonical history
// surface (terminal scrollback is best-effort live-only). Refreshes periodically.
// Search filters/highlights turns in-memory; role chips narrow to user/assistant.
// Source = a plain session transcript (default) OR a run-scoped one. Run runs serve the retained
// snapshot (transcriptRef) when the live JSONL is gone, which the session-transcript route can't do
// for a run session (it only snapshot-falls-back on archivedAt). Pass `runRef` to use the run route.
export function TranscriptPane({ sessionId, runRef }: { sessionId: string; runRef?: { projectId: string; runId: string } }) {
  const t = useQuery(
    runRef
      ? { queryKey: ["run-transcript", runRef.projectId, runRef.runId], queryFn: () => api.runTranscript(runRef.projectId, runRef.runId), refetchInterval: 5000 }
      : { queryKey: ["transcript", sessionId], queryFn: () => api.transcript(sessionId), refetchInterval: 5000 },
  );
  const turns = t.data;

  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  // Debounce the typed query so long transcripts don't re-filter on every keystroke.
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim()), 120);
    return () => clearTimeout(id);
  }, [query]);

  const filtered = useMemo(() => {
    if (!turns) return [];
    const needle = q.toLowerCase();
    return turns.filter((turn) => {
      if (role !== "all" && turn.role !== role) return false;
      if (needle && !turn.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [turns, q, role]);

  const active = q !== "" || role !== "all";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 8,
          borderBottom: `1px solid ${color.border}`,
          flexShrink: 0,
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search transcript…"
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Search transcript"
        />
        <RoleChip label="all" current={role} onPick={setRole} />
        <RoleChip label="user" current={role} onPick={setRole} />
        <RoleChip label="assistant" current={role} onPick={setRole} />
        {active && (
          <Badge tone={filtered.length ? "phosphor" : "muted"}>
            {filtered.length} / {turns?.length ?? 0}
          </Badge>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {turns?.length === 0 && (
          <p style={{ color: color.textMuted }}>No transcript yet (engine session id not captured, or no turns).</p>
        )}
        {turns && turns.length > 0 && filtered.length === 0 && (
          <p style={{ color: color.textMuted }}>No turns match.</p>
        )}
        {filtered.map((turn, i) => (
          <Turn key={i} turn={turn} q={q} />
        ))}
      </div>
    </div>
  );
}

function RoleChip({ label, current, onPick }: { label: RoleFilter; current: RoleFilter; onPick: (r: RoleFilter) => void }) {
  return (
    <Button variant={current === label ? "primary" : "ghost"} onClick={() => onPick(label)} style={{ textTransform: "uppercase" }}>
      {label}
    </Button>
  );
}

function Turn({ turn, q }: { turn: TranscriptTurn; q: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: turn.role === "user" ? "#8c8" : "#9ad", marginBottom: 2 }}>{turn.role}</div>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 13, color: color.text }}>
        {highlight(turn.text, q)}
      </pre>
    </div>
  );
}
