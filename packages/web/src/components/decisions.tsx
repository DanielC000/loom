import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuestionInboxItem } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, Dot, SectionLabel } from "./ui";
import { color, font, radius, tone } from "../theme";
import { questionStateChip, isDecisionWatchdog, relativeAge } from "../lib/questions";

// Manager→human DECISION INBOX web surfaces (card 8701bdbb, child B). The shared state chip (surface 4)
// + the GLOBAL "waiting on me" inbox with a per-project facet (surface 3 · A). Native to the terminal-
// cockpit kit — reuses Panel/Button/Dot + the `theme` tokens; DECISION NEEDED is signed with the existing
// `cyan` token (#5bc8ff), the one signed "actionable question" color.

// ── DecisionStateChip (surface 4) ───────────────────────────────────────────────
// pending (cyan · waiting on you) → answered (muted · waiting on the manager's pickup) → consumed
// (muted ✓ · terminal), with the watchdog re-escalating an ignored `answered` to amber "WAITING ON MGR".
// A bordered dot-pill, tone-driven via the single questionStateChip source of truth.
export function DecisionStateChip({ q, now }: { q: Pick<QuestionInboxItem, "state" | "answeredAt">; now: number }) {
  const spec = questionStateChip(q, now);
  const c = tone[spec.tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono, fontSize: 11,
      textTransform: "uppercase", letterSpacing: "0.06em", color: c, border: `1px solid ${c}`, borderRadius: radius.sm, padding: "1px 8px" }}>
      <Dot tone={spec.tone} glow={spec.tone === "amber"} />
      {spec.label}
    </span>
  );
}

// ── Nudge mgr (watchdog action) ─────────────────────────────────────────────────
// Re-poke a manager sitting on an answered-but-unpulled decision. Reuses the EXISTING human-only turn
// injector (POST /input) — NOT a new answer path (the answer route stays the only chosenOption/note writer).
// Disabled when the asking session isn't live (nothing to nudge).
function NudgeMgrButton({ q }: { q: QuestionInboxItem }) {
  const [done, setDone] = useState(false);
  const nudge = useMutation({
    mutationFn: () => api.sendInput(q.sessionId, `[loom] Reminder: your question "${q.title}" was answered — pull it (question_pull) at that decision point.`),
    onSuccess: () => { setDone(true); window.setTimeout(() => setDone(false), 4000); },
    onError: (e) => window.alert((e as Error).message),
  });
  return (
    <Button variant="default" disabled={!q.sessionLive || nudge.isPending}
      title={q.sessionLive ? "Re-nudge the manager to pull this answered decision" : "The asking session isn't live — nothing to nudge"}
      onClick={() => nudge.mutate()}>
      {done ? "✓ nudged" : nudge.isPending ? "Nudging…" : "Nudge mgr"}
    </Button>
  );
}

// ── DecisionRow — one inbox entry ───────────────────────────────────────────────
// A pending row signs its left edge cyan (waiting on you); the watchdog case signs it amber. Shows the
// title, the manager/project/age line, an options-or-note hint, the state chip, and the action
// (Answer → for pending, View for answered/consumed, + Nudge mgr on the watchdog case).
function DecisionRow({ q, now }: { q: QuestionInboxItem; now: number }) {
  const navigate = useNavigate();
  const watchdog = isDecisionWatchdog(q, now);
  const edge = q.state === "pending" ? color.cyan : watchdog ? color.amber : "transparent";
  const hint = q.options && q.options.length > 0
    ? `${q.options.length} option${q.options.length === 1 ? "" : "s"}${q.recommendation ? ` · rec. ${q.recommendation}` : ""}`
    : "note only";
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 5, borderLeft: `3px solid ${edge}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Dot tone={q.state === "pending" ? "cyan" : watchdog ? "amber" : "muted"} glow={watchdog} />
            <span style={{ color: color.cyan }}>{q.projectName}</span>
            <span>· mgr {q.sessionId.slice(0, 8)}</span>
            <span>· {q.state === "pending" ? "asked" : "answered"} {relativeAge(q.state === "pending" ? q.createdAt : q.answeredAt, now)}</span>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <DecisionStateChip q={q} now={now} />
          {q.state === "pending"
            ? <Button variant="primary" onClick={() => navigate(`/question/${q.id}`)}>Answer →</Button>
            : watchdog
              ? <NudgeMgrButton q={q} />
              : <Button variant="ghost" onClick={() => navigate(`/question/${q.id}`)} style={{ padding: "0 6px" }}>View</Button>}
        </div>
      </div>
      {/* second line: options/note hint (pending) or the recorded answer (answered/consumed) */}
      {q.state === "pending" ? (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>{hint}</span>
      ) : (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: watchdog ? color.amber : color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {watchdog ? "answered, not picked up — " : "answered: "}
          {q.chosenOption ? q.chosenOption : q.note ? `“${q.note}”` : "—"}
        </span>
      )}
    </Panel>
  );
}

// ── DecisionInbox (surface 3 · A — GLOBAL) ──────────────────────────────────────
// One cross-project "waiting on me" queue with a per-project FACET (the owner picked global-with-facet,
// NOT separate per-project inboxes). Pending decisions rank first (waiting on you), then answered
// (waiting on the manager) below. The facet chips narrow WITHOUT leaving the one destination.
export function DecisionInbox() {
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 3000 });
  const qc = useQueryClient();
  const [facet, setFacet] = useState<string>("all"); // projectId | "all"
  const now = Date.now();

  const items = questions.data ?? [];
  // Facet chips: one per project present in the queue, with its open-decision count. "all" leads.
  const projects = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const q of items) {
      const cur = m.get(q.projectId);
      if (cur) cur.count += 1;
      else m.set(q.projectId, { id: q.projectId, name: q.projectName, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [items]);

  // A facet that no longer matches any row (its last decision was answered+consumed away) falls back to all.
  const activeFacet = facet !== "all" && projects.some((p) => p.id === facet) ? facet : "all";
  const filtered = activeFacet === "all" ? items : items.filter((q) => q.projectId === activeFacet);
  // Pending first (waiting on you), then answered (waiting on the manager); each group newest-first (the
  // server already returns createdAt DESC).
  const pending = filtered.filter((q) => q.state === "pending");
  const answered = filtered.filter((q) => q.state !== "pending");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Waiting on me ({items.length})</SectionLabel>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => qc.invalidateQueries({ queryKey: ["openQuestions"] })}>Refresh</Button>
      </div>

      {/* project facet */}
      {projects.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <FacetChip label="all" count={items.length} active={activeFacet === "all"} onClick={() => setFacet("all")} />
          {projects.map((p) => (
            <FacetChip key={p.id} label={p.name} count={p.count} active={activeFacet === p.id} onClick={() => setFacet(p.id)} />
          ))}
        </div>
      )}

      {items.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Nothing is waiting on you. Managers surface decisions here when they need your call.</span></Panel>}

      {pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((q) => <DecisionRow key={q.id} q={q} now={now} />)}
        </div>
      )}
      {answered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel style={{ margin: "4px 0 0", color: color.textMuted }}>Answered · waiting on manager pickup</SectionLabel>
          {answered.map((q) => <DecisionRow key={q.id} q={q} now={now} />)}
        </div>
      )}
    </div>
  );
}

// A facet filter chip: project name + open-decision count; the active one is phosphor-outlined.
function FacetChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, background: active ? color.panel2 : "transparent",
        border: `1px solid ${active ? color.phosphor : color.border}`, borderRadius: radius.sm, padding: "2px 8px", cursor: "pointer",
        fontFamily: font.mono, fontSize: 11, color: active ? color.phosphor : color.textDim }}>
      {label}
      <span style={{ color: active ? color.phosphor : color.textMuted }}>{count}</span>
    </button>
  );
}
