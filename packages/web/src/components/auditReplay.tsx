import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem, AuditTimeline, AuditEvent, AuditSessionRef, AuditScope } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity } from "../lib/sessions";
import { Panel, SectionLabel, Button, Chip, Dot, Select } from "./ui";
import { color, font, radius, tone, type Tone } from "../theme";

// RUN REPLAY — the audit-log observability surface. Renders a selected session/wave's durable event
// timeline (scrub by AuditEvent.seq) plus a run-vs-run diff, both READ-ONLY over the audit endpoints
// (GET /api/audit/{session,wave,diff}). The sibling review/merge pane owns the diff/merge surface; this
// owns the replay + run comparison. Pure presentation over @loom/shared DTOs — no new backend.
//
// "Why this exists": once a wave is three agents deep you're left reading logs to reconstruct what
// happened. The scrubber lets you step the wave forward event-by-event; the diff lets you ask "what did
// this run do differently from its predecessor / another run" without diffing two transcripts by hand.

// Per-kind signal tone — terminal outcomes red, in-flight/attention amber, completions phosphor, the
// rest informational cyan. worker_report splits on its status (blocked vs done).
function eventTone(e: AuditEvent): Tone {
  const k = e.kind;
  if (k === "worker_report") {
    const st = (e.detail as { status?: string } | null)?.status;
    return st === "blocked" ? "amber" : st === "done" ? "phosphor" : "cyan";
  }
  if (k === "merge_rejected" || k === "worker_report_rejected" || k === "idle_escalated" ||
      k === "context_escalated" || k === "session_recovery_abandoned" || k === "session_died" ||
      k === "schedule_fire_failed" || k === "worker_report_undelivered") return "red";
  if (k === "merge_request" || k === "worker_stuck" || k === "idle_report" || k === "redirect_worker") return "amber";
  if (k === "merge_done" || k === "recycle_complete" || k === "session_recovered") return "phosphor";
  if (k === "build_gate_retry_attempt" || k === "build_gate_retry") return "cyan";
  return "cyan";
}

// The session that an event is "about" — its worker when present, else its manager. The timeline ships
// the actor lookup so we resolve role/lineage without a second fetch.
function actorRef(t: AuditTimeline, e: AuditEvent): AuditSessionRef | undefined {
  return t.sessions[e.workerSessionId ?? e.managerSessionId];
}

// A short human line from an event's durable detail (kind-specific; "" when there's nothing useful).
function detailLine(e: AuditEvent): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const s = (k: string) => (d[k] == null ? "" : String(d[k]));
  switch (e.kind) {
    case "worker_report": return `${s("status")}${s("summary") ? ` — ${s("summary").slice(0, 90)}` : ""}`;
    case "merge_request": return `${s("branch")}${d.filesChanged != null ? ` · ${s("filesChanged")} files` : ""}`;
    case "merge_done":
    case "merge_rejected": return s("branch");
    case "idle_report": return `${s("state")}${s("detail") ? ` — ${s("detail").slice(0, 80)}` : ""}`;
    case "idle_escalated": return `${s("unanswered")} unanswered nudges`;
    case "context_escalated": return `~${s("pct")}% context · ${s("unanswered")} ignored nudges`;
    case "worker_stuck": return `busy ${s("minutesBusy")}m`;
    case "build_gate_retry_attempt": return `gate retry${s("priorClass") ? ` (was ${s("priorClass")})` : ""}`;
    case "build_gate_retry": return `gate retry: ${d.passed != null ? (d.passed ? "passed" : "still failed") : "?"}`;
    case "session_message":
    case "session_message_queued": return s("text").slice(0, 90);
    default: return "";
  }
}

const timeOfDay = (iso: string) => new Date(iso).toLocaleTimeString();

// One event line in the replay stream. `state`: "past" (already played), "current" (the scrub head),
// "future" (dimmed, not yet reached).
function ReplayEvent({ t, e, state }: { t: AuditTimeline; e: AuditEvent; state: "past" | "current" | "future" }) {
  const tn = eventTone(e);
  const ref = actorRef(t, e);
  const detail = detailLine(e);
  const future = state === "future";
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8, padding: "2px 6px",
      fontFamily: font.mono, fontSize: 12, opacity: future ? 0.34 : 1,
      borderLeft: `2px solid ${state === "current" ? tone[tn] : "transparent"}`,
      background: state === "current" ? color.panel2 : "transparent",
    }}>
      <span style={{ color: color.textMuted, width: 26, textAlign: "right", flexShrink: 0 }}>{e.seq}</span>
      <Dot tone={tn} glow={state === "current"} />
      <span style={{ color: tone[tn], whiteSpace: "nowrap" }}>{e.kind}</span>
      <span style={{ color: color.textMuted, whiteSpace: "nowrap" }}>
        {ref ? `${ref.role ?? "session"} ${ref.id.slice(0, 8)}` : (e.workerSessionId ?? e.managerSessionId).slice(0, 8)}
      </span>
      {detail && <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>}
      <span style={{ flex: 1 }} />
      <span style={{ color: color.textMuted, whiteSpace: "nowrap", flexShrink: 0 }}>{timeOfDay(e.ts)}</span>
    </div>
  );
}

// ── Run-vs-run diff ──────────────────────────────────────────────────────────────
// Compares the selected timeline against another run (or its recycledFrom predecessor). Shows the
// outcome deltas (per-kind counts) + the sequence alignment (added in B / removed from A). A `same`
// step is collapsed to a count so the changes stand out.
function RunDiff({ rootId, scope, compareTo, onClose }: {
  rootId: string; scope: AuditScope; compareTo: string; onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["auditDiff", scope, rootId, compareTo],
    queryFn: () => api.auditDiff(rootId, compareTo === "predecessor" ? undefined : compareTo, scope),
    retry: false,
  });

  if (q.isLoading) return <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "8px 6px" }}>diffing…</div>;
  if (q.isError) {
    return (
      <div style={{ fontFamily: font.mono, fontSize: 12, color: color.amber, padding: "8px 6px", display: "flex", gap: 10, alignItems: "center" }}>
        <span>{(q.error as Error).message}</span>
        <Button variant="ghost" onClick={onClose}>Dismiss</Button>
      </div>
    );
  }
  const d = q.data!;
  const changedKinds = d.kindDeltas.filter((k) => k.delta !== 0);
  const changedSteps = d.steps.filter((s) => s.op !== "same");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>
          A {d.a.rootId.slice(0, 8)} ({d.a.eventCount}) vs B {d.b.rootId.slice(0, 8)} ({d.b.eventCount})
        </span>
        <span style={{ flex: 1 }} />
        <Chip label="same" value={d.summary.sameCount} />
        <Chip label="+added" value={d.summary.addedCount} tone={d.summary.addedCount ? "phosphor" : "muted"} />
        <Chip label="−removed" value={d.summary.removedCount} tone={d.summary.removedCount ? "red" : "muted"} />
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>

      {!d.summary.changed && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>Identical event sequences.</span>}

      {changedKinds.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {changedKinds.map((k) => (
            <span key={k.kind} title={`A:${k.a} B:${k.b}`} style={{
              fontFamily: font.mono, fontSize: 11, padding: "1px 6px", borderRadius: radius.sm,
              border: `1px solid ${color.border}`, color: k.delta > 0 ? color.phosphor : color.red,
            }}>
              {k.kind} {k.delta > 0 ? "+" : ""}{k.delta}
            </span>
          ))}
        </div>
      )}

      {changedSteps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 180, overflow: "auto" }}>
          {changedSteps.map((s, i) => {
            const ev = s.b ?? s.a!;
            const added = s.op === "added";
            return (
              <div key={i} style={{ display: "flex", gap: 8, fontFamily: font.mono, fontSize: 11, alignItems: "baseline" }}>
                <span style={{ color: added ? color.phosphor : color.red, width: 14, flexShrink: 0 }}>{added ? "+B" : "−A"}</span>
                <span style={{ color: color.textDim }}>{s.signature}</span>
                <span style={{ color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detailLine(ev)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Wave-scope subject label: the manager wave head, matching the project · mgr id8 (live) form.
function managerLabel(m: SessionListItem): string {
  return `${m.projectName} · mgr ${m.id.slice(0, 8)}${m.processState === "live" ? " (live)" : ""}`;
}
// Session-scope subject label for a focused agent: role + short id + a branch/agent hint.
function subjectLabel(s: SessionListItem): string {
  const role = s.role ?? "session";
  const hint = s.branch ?? s.agentName ?? "";
  return `${role} ${s.id.slice(0, 8)}${hint ? ` · ${hint}` : ""}${s.processState === "live" ? " (live)" : ""}`;
}

export function AuditReplayPanel({ managers }: { managers: SessionListItem[] }) {
  // The selected replay SUBJECT. In `wave` scope it's always a manager (the wave head); in `session`
  // scope it's the anchored manager OR one of its workers (so you can focus a single agent's slice).
  const [rootId, setRootId] = useState<string>(managers[0]?.id ?? "");
  const [scope, setScope] = useState<AuditScope>("wave");
  // null = follow the live edge (show the whole timeline); a number = an explicit scrub position.
  const [seq, setSeq] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [compareTo, setCompareTo] = useState<string>(""); // "" = closed; "predecessor" or a session id

  // The full session set drives `session` scope: a manager's workers are sessions whose parent is it.
  // Reuse the shared ["allSessions"] cache the rest of Mission Control already polls (no new prop).
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 5000 });
  const allSessions = sessionsQ.data ?? [];

  // Climb a subject to its anchoring MANAGER: a worker → its parent; a manager (or unknown) → itself.
  // In `wave` scope rootId is already a manager, so this is identity there.
  const managerOf = (id: string): string => {
    const s = allSessions.find((x) => x.id === id);
    return s?.role === "worker" && s.parentSessionId ? s.parentSessionId : id;
  };
  const anchorManagerId = managerOf(rootId);
  // The anchored manager (from the live managers prop if present, else any known session row).
  const anchorManager = managers.find((m) => m.id === anchorManagerId)
    ?? allSessions.find((s) => s.id === anchorManagerId);
  // A manager's workers, live-then-recency ordered — the agents you can focus in `session` scope.
  const anchorWorkers = allSessions
    .filter((s) => s.role === "worker" && s.parentSessionId === anchorManagerId)
    .sort(bySessionActivity);

  // The dropdown subjects: managers in `wave` scope; the anchored manager + its workers in `session`.
  const subjectOptions: { id: string; label: string }[] =
    scope === "wave"
      ? managers.map((m) => ({ id: m.id, label: managerLabel(m) }))
      : [
          ...(anchorManager ? [{ id: anchorManager.id, label: `manager ${anchorManager.id.slice(0, 8)} · all agents` }] : []),
          ...anchorWorkers.map((w) => ({ id: w.id, label: subjectLabel(w) })),
        ];

  // If the selected subject went away, fall back to a valid root. Scope-aware: `wave` validates against
  // managers; `session` validates against any known session (manager or worker) so focusing a worker
  // isn't clobbered back to a manager. Wait for the session list before judging session validity.
  useEffect(() => {
    if (scope === "wave") {
      if ((!rootId || !managers.some((m) => m.id === rootId)) && managers[0]) setRootId(managers[0].id);
    } else if (sessionsQ.data) {
      if (!allSessions.some((s) => s.id === rootId) && managers[0]) setRootId(managers[0].id);
    }
  }, [managers, rootId, scope, sessionsQ.data]);
  // Reset the scrub + any open diff when the subject or scope changes.
  useEffect(() => { setSeq(null); setPlaying(false); setCompareTo(""); }, [rootId, scope]);

  // Flip scope, reconciling the subject: → wave climbs a focused worker back to its manager (wave needs
  // a manager root); → session keeps the manager as the anchor so you can then focus one of its workers.
  const flipScope = (sc: AuditScope) => {
    if (sc === scope) return;
    if (sc === "wave") setRootId((id) => managerOf(id));
    setScope(sc);
  };

  const q = useQuery({
    queryKey: ["audit", scope, rootId],
    queryFn: () => (scope === "wave" ? api.auditWave(rootId) : api.auditSession(rootId)),
    enabled: !!rootId,
    refetchInterval: 5000,
  });
  const timeline = q.data;
  const events = timeline?.events ?? [];
  const last = Math.max(0, events.length - 1);
  const cur = seq === null ? last : Math.min(seq, last);

  // Auto-advance the scrub head while playing; stop at the end.
  useEffect(() => {
    if (!playing || events.length === 0) return;
    const iv = window.setInterval(() => {
      setSeq((s) => {
        const next = (s ?? 0) + 1;
        if (next >= events.length - 1) { setPlaying(false); return events.length - 1; }
        return next;
      });
    }, 650);
    return () => window.clearInterval(iv);
  }, [playing, events.length]);

  const play = () => {
    if (events.length === 0) return;
    if (seq === null || seq >= last) setSeq(0); // restart from the top when at the live edge
    setPlaying(true);
  };

  if (managers.length === 0) {
    return (
      <div>
        <SectionLabel>Wave replay</SectionLabel>
        <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No manager waves to replay yet.</span></Panel>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel>Wave replay</SectionLabel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Subject + scope + compare controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Select value={rootId} onChange={(e) => setRootId(e.target.value)} style={{ minWidth: 240 }}>
            {subjectOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </Select>
          <div style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: radius.base, overflow: "hidden" }}>
            {(["wave", "session"] as const).map((sc) => (
              <button key={sc} onClick={() => flipScope(sc)} className="loom-btn"
                title={sc === "wave" ? "The whole manager wave (every agent)" : "Focus one agent — the manager or one of its workers"}
                style={{
                  background: scope === sc ? color.panel2 : "transparent", border: "none",
                  color: scope === sc ? color.phosphor : color.textMuted,
                  fontFamily: font.mono, fontSize: 12, padding: "4px 12px", cursor: "pointer",
                }}>{sc}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {/* Compare against another run in the SAME scope so the diff isn't mismatched (RunDiff passes
              the current scope to both sides). Session-scope subjects are agents; wave-scope are managers. */}
          <Select value={compareTo} onChange={(e) => setCompareTo(e.target.value)} style={{ minWidth: 170 }}>
            <option value="">compare run…</option>
            <option value="predecessor">vs predecessor</option>
            {subjectOptions.filter((o) => o.id !== rootId).map((o) => (
              <option key={o.id} value={o.id}>vs {o.label}</option>
            ))}
          </Select>
        </div>

        {/* Span summary */}
        {timeline && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
            <Chip label="events" value={timeline.eventCount} />
            <Chip label="actors" value={Object.keys(timeline.sessions).length} />
            {timeline.firstTs && <span>{timeOfDay(timeline.firstTs)} → {timeline.lastTs ? timeOfDay(timeline.lastTs) : "—"}</span>}
          </div>
        )}

        {/* Scrubber + transport */}
        {events.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button variant="ghost" title="Step back" onClick={() => { setPlaying(false); setSeq(Math.max(0, cur - 1)); }}>‹</Button>
            <Button variant={playing ? "primary" : "default"} onClick={() => (playing ? setPlaying(false) : play())} style={{ minWidth: 64 }}>
              {playing ? "❚❚ Pause" : "▶ Play"}
            </Button>
            <Button variant="ghost" title="Step forward" onClick={() => { setPlaying(false); setSeq(Math.min(last, cur + 1)); }}>›</Button>
            <input type="range" min={0} max={last} value={cur}
              onChange={(e) => { setPlaying(false); setSeq(Number(e.target.value)); }}
              style={{ flex: 1, accentColor: color.phosphor }} aria-label="Replay position" />
            <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, minWidth: 64, textAlign: "right" }}>
              {cur + 1}/{events.length}
            </span>
            {seq !== null && cur < last && <Button variant="ghost" title="Jump to live edge" onClick={() => setSeq(null)}>↦ live</Button>}
          </div>
        )}

        {/* Event stream up to the scrub head; future events dimmed */}
        <div style={{ maxHeight: "40vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
          {q.isLoading && <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>loading timeline…</span>}
          {timeline && events.length === 0 && <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No events recorded for this {scope}.</span>}
          {events.map((e) => (
            <ReplayEvent key={e.id} t={timeline!} e={e} state={e.seq < cur ? "past" : e.seq === cur ? "current" : "future"} />
          ))}
        </div>

        {/* Run-vs-run diff (lazy — only when a comparison is chosen) */}
        {compareTo && rootId && (
          <RunDiff rootId={rootId} scope={scope} compareTo={compareTo} onClose={() => setCompareTo("")} />
        )}
      </Panel>
    </div>
  );
}
