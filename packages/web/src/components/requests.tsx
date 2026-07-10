import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuestionInboxItem, QuestionType, PermissionScope } from "@loom/shared";
import { PERMISSION_SCOPES } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Dot, SectionLabel, Badge, Select } from "./ui";
import { DecisionStateChip } from "./decisions";
import { color, font, radius, tone, type Tone } from "../theme";
import {
  isDecisionWatchdog, relativeAge,
  REQUEST_TYPE_TONE, REQUEST_TYPE_ORDER,
  requestActionLabel, requestNeedsChip, requestAnswerBadge, requestHint, requestOutcome,
} from "../lib/questions";

// The REQUESTS INBOX (card 695ebab0 — the durable Requests object generalized from the decision inbox).
// A manager/orchestrator asks the human NON-BLOCKING for one of four kinds of Request — decision · input ·
// permission · credential — each answered asynchronously here. Direction A "signal rows": one durable
// record per row, its left edge signed by the type's color. Native to the terminal-cockpit kit — reuses
// Panel/Button/Dot/Badge/Select + the `theme` tokens; the four type colors map onto the EXISTING signal
// palette (decision=cyan · input=phosphor · permission=red · credential=amber), no new color system.

// ── RequestTypeTag ──────────────────────────────────────────────────────────────
// A bordered pill in the type's signal tone (Badge uppercases the label). One place a type reads as a tag.
export function RequestTypeTag({ type }: { type: QuestionType }) {
  return <Badge tone={REQUEST_TYPE_TONE[type]}>{type}</Badge>;
}

// ── RequestNeedsChip ──────────────────────────────────────────────────────────────
// A pending row's short "what's needed" chip ("needs pick"/"needs answer"/"needs auth"/"needs secret"),
// tinted by the type tone. Distinct from the lifecycle DecisionStateChip (which drives answered/consumed).
function RequestNeedsChip({ type }: { type: QuestionType }) {
  const c = tone[REQUEST_TYPE_TONE[type]];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono, fontSize: 11,
      textTransform: "uppercase", letterSpacing: "0.06em", color: c, border: `1px solid ${c}`, borderRadius: radius.sm, padding: "1px 8px" }}>
      <Dot tone={REQUEST_TYPE_TONE[type]} />
      {requestNeedsChip(type)}
    </span>
  );
}

// ── Nudge mgr (watchdog action) ─────────────────────────────────────────────────
// Re-poke a manager sitting on an answered-but-unpulled request. Reuses the EXISTING human-only turn
// injector (POST /input) — NOT a new answer path. Disabled when the asking session isn't live.
function NudgeMgrButton({ q }: { q: QuestionInboxItem }) {
  const [done, setDone] = useState(false);
  const nudge = useMutation({
    mutationFn: () => api.sendInput(q.sessionId, `[loom] Reminder: your request "${q.title}" was answered — pull it (question_pull) at that decision point.`),
    onSuccess: () => { setDone(true); window.setTimeout(() => setDone(false), 4000); },
    onError: (e) => window.alert((e as Error).message),
  });
  return (
    <Button variant="default" disabled={!q.sessionLive || nudge.isPending}
      title={q.sessionLive ? "Re-nudge the manager to pull this answered request" : "The asking session isn't live — nothing to nudge"}
      onClick={() => nudge.mutate()}>
      {done ? "✓ nudged" : nudge.isPending ? "Nudging…" : "Nudge mgr"}
    </Button>
  );
}

// A soft-linked task chip: "task #xxxx" (the request's `taskId`, a NON-FK soft link — a dangling id is
// tolerated, never a crash). `onClick` (when set) navigates to the card; otherwise it's inert metadata.
function LinkedTaskChip({ taskId, title, onClick }: { taskId: string; title?: string; onClick?: () => void }) {
  const label = `task #${taskId.slice(0, 8)}${title ? ` · ${title}` : ""}`;
  const style = { fontFamily: font.mono, fontSize: 11, color: color.cyan, border: `1px solid ${color.border}`,
    borderRadius: radius.sm, padding: "1px 6px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const };
  if (!onClick) return <span title={label} style={style}>{label}</span>;
  return (
    <button onClick={onClick} title={`Open ${label}`}
      style={{ ...style, background: "transparent", cursor: "pointer", textAlign: "left" }}>{label}</button>
  );
}

// ── RequestRow — one inbox entry (Direction A signal row) ─────────────────────────
// The left edge is signed the type's color while pending (amber on the answered-stuck watchdog case). The
// row action opens the detail MODAL in place (no route push); answered rows get a View that opens the same.
function RequestRow({ q, now, onOpen }: { q: QuestionInboxItem; now: number; onOpen: (id: string) => void }) {
  const watchdog = isDecisionWatchdog(q, now);
  const typeTone = REQUEST_TYPE_TONE[q.type];
  const edge = q.state === "pending" ? tone[typeTone] : watchdog ? color.amber : "transparent";
  const metaDot = q.state === "pending" ? typeTone : watchdog ? "amber" : "muted";
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 5, borderLeft: `3px solid ${edge}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Dot tone={metaDot} glow={watchdog} />
            <span style={{ color: color.cyan }}>{q.projectName}</span>
            <span>· agent {q.sessionId.slice(0, 8)}</span>
            <span>· {q.state === "pending" ? "asked" : "answered"} {relativeAge(q.state === "pending" ? q.createdAt : q.answeredAt, now)}</span>
            {q.taskId && <LinkedTaskChip taskId={q.taskId} />}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <RequestTypeTag type={q.type} />
          {q.state === "pending"
            ? <RequestNeedsChip type={q.type} />
            : <DecisionStateChip q={q} now={now} />}
          {q.state === "pending"
            ? <Button variant="primary" onClick={() => onOpen(q.id)}>{requestActionLabel(q.type)}</Button>
            : watchdog
              ? <NudgeMgrButton q={q} />
              : <Button variant="ghost" onClick={() => onOpen(q.id)} style={{ padding: "0 6px" }}>View</Button>}
        </div>
      </div>
      {/* second line: the type-colored hint (pending) or the recorded outcome (answered/consumed). */}
      {q.state === "pending" ? (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[typeTone] }}>{requestHint(q)}</span>
      ) : (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: watchdog ? color.amber : color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {watchdog ? "answered, not picked up — " : "answered: "}
          {requestOutcome(q)}
        </span>
      )}
    </Panel>
  );
}

// A filter chip: a leading colored dot (type filters) + label + count; the active one is phosphor-outlined.
function FilterChip({ label, count, active, dotTone, onClick }:
  { label: string; count: number; active: boolean; dotTone?: Tone; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, background: active ? color.panel2 : "transparent",
        border: `1px solid ${active ? color.phosphor : color.border}`, borderRadius: radius.sm, padding: "2px 8px", cursor: "pointer",
        fontFamily: font.mono, fontSize: 11, color: active ? color.phosphor : color.textDim }}>
      {dotTone && <Dot tone={dotTone} />}
      {label}
      <span style={{ color: active ? color.phosphor : color.textMuted }}>{count}</span>
    </button>
  );
}

// ── RequestsInbox (GLOBAL "waiting on me") ────────────────────────────────────────
// One cross-project queue with a TYPE filter (all + one per type, with counts) AND the existing per-project
// facet — both narrow WITHOUT leaving this destination. Pending rank first, then answered below. Row action
// opens the detail modal in place.
export function RequestsInbox() {
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 3000 });
  const qc = useQueryClient();
  const [typeFacet, setTypeFacet] = useState<QuestionType | "all">("all");
  const [projFacet, setProjFacet] = useState<string>("all"); // projectId | "all"
  const [openId, setOpenId] = useState<string | null>(null);
  const now = Date.now();

  const items = questions.data ?? [];
  // Type counts (over the whole queue) — one chip per type, "all" leads.
  const typeCounts = useMemo(() => {
    const m = new Map<QuestionType, number>();
    for (const q of items) m.set(q.type, (m.get(q.type) ?? 0) + 1);
    return m;
  }, [items]);
  // Project facet chips: one per project present, with its open count.
  const projects = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const q of items) {
      const cur = m.get(q.projectId);
      if (cur) cur.count += 1;
      else m.set(q.projectId, { id: q.projectId, name: q.projectName, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [items]);

  // A facet that no longer matches any row falls back to "all".
  const activeType = typeFacet !== "all" && (typeCounts.get(typeFacet) ?? 0) > 0 ? typeFacet : "all";
  const activeProj = projFacet !== "all" && projects.some((p) => p.id === projFacet) ? projFacet : "all";
  const filtered = items.filter((q) =>
    (activeType === "all" || q.type === activeType) &&
    (activeProj === "all" || q.projectId === activeProj));
  const pending = filtered.filter((q) => q.state === "pending");
  const answered = filtered.filter((q) => q.state !== "pending");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Waiting on me ({items.length})</SectionLabel>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => qc.invalidateQueries({ queryKey: ["openQuestions"] })}>Refresh</Button>
      </div>

      {/* type filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <FilterChip label="all" count={items.length} active={activeType === "all"} onClick={() => setTypeFacet("all")} />
        {REQUEST_TYPE_ORDER.filter((t) => (typeCounts.get(t) ?? 0) > 0).map((t) => (
          <FilterChip key={t} label={t} count={typeCounts.get(t) ?? 0} dotTone={REQUEST_TYPE_TONE[t]}
            active={activeType === t} onClick={() => setTypeFacet(t)} />
        ))}
      </div>

      {/* project facet */}
      {projects.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <FilterChip label="all projects" count={items.length} active={activeProj === "all"} onClick={() => setProjFacet("all")} />
          {projects.map((p) => (
            <FilterChip key={p.id} label={p.name} count={p.count} active={activeProj === p.id} onClick={() => setProjFacet(p.id)} />
          ))}
        </div>
      )}

      {items.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Nothing is waiting on you. Managers surface requests here when they need your call.</span></Panel>}
      {items.length > 0 && filtered.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No requests match this filter.</span></Panel>}

      {pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((q) => <RequestRow key={q.id} q={q} now={now} onOpen={setOpenId} />)}
        </div>
      )}
      {answered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel style={{ margin: "4px 0 0", color: color.textMuted }}>Answered · waiting on manager pickup</SectionLabel>
          {answered.map((q) => <RequestRow key={q.id} q={q} now={now} onOpen={setOpenId} />)}
        </div>
      )}

      {openId && <RequestModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ── RequestModal ──────────────────────────────────────────────────────────────────
// The detail/response as a centered dialog OVER the current page (Mission/Overview/Board/Requests) — the
// owner picked "answer without leaving the page you're on". Backdrop or ✕ closes; the same content also
// renders at /question/:id as a deep-link (see pages/QuestionAnswer.tsx).
export function RequestModal({ id, onClose }: { id: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} role="dialog" aria-modal
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 60, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "100%", background: color.panel, border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.base, padding: 16, display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SectionLabel style={{ margin: 0, flex: 1 }}>Request · {id.slice(0, 8)}</SectionLabel>
          <Button onClick={onClose} title="Close (Esc)">✕</Button>
        </div>
        <RequestDetail id={id} onClose={onClose} />
      </div>
    </div>
  );
}

// ── RequestDetail — the reusable detail/response body (4 affordances) ──────────────
// Renders the header (type tag · agent·project · linked-task chip · state chip · live-session link), the
// "The ask" panel, and the TYPE-APPROPRIATE control (decision · input · permission · credential) or, once
// answered/consumed, the recorded readout. Used by BOTH the modal and the /question/:id deep-link page.
// `onClose`, when set (the modal), is called before a linked-task navigation so the dialog closes first.
export function RequestDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const navigate = useNavigate();
  const active = useActiveProject();
  const q = useQuery({ queryKey: ["question", id], queryFn: () => api.question(id), enabled: !!id, retry: false });
  const question = q.data;
  const now = Date.now();

  // Best-effort linked-task title (soft link — tolerate a dangling id). Only fetched when a taskId is set.
  const tasks = useQuery({
    queryKey: ["tasks", question?.projectId],
    queryFn: () => api.tasks(question!.projectId),
    enabled: !!question?.taskId && !!question?.projectId,
  });
  const linkedTitle = question?.taskId ? tasks.data?.find((t) => t.id === question.taskId)?.title : undefined;

  const openLinkedTask = () => {
    if (!question?.taskId) return;
    // Soft link → the board scoped to the request's project, drawer open on the card. `?task=` is consumed
    // by Board and cleared; a dangling id just opens the board (no crash).
    active.setProjectId(question.projectId);
    onClose?.();
    navigate(`/board?task=${encodeURIComponent(question.taskId)}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {q.isError && <Panel><span style={{ color: color.red, fontSize: 12 }}>Request not found (it may have been removed).</span></Panel>}
      {q.isLoading && <Panel><span style={{ color: color.textMuted, fontSize: 12 }}>Loading…</span></Panel>}

      {question && (
        <>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <RequestTypeTag type={question.type} />
            <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
              agent {question.sessionId.slice(0, 8)} · <span style={{ color: color.cyan }}>{question.projectName}</span>
            </span>
            {question.taskId && <LinkedTaskChip taskId={question.taskId} title={linkedTitle} onClick={openLinkedTask} />}
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
              asked {relativeAge(question.createdAt, now)}
            </span>
            <DecisionStateChip q={question} now={now} />
            {question.sessionLive && (
              <button onClick={() => { onClose?.(); navigate(`/session/${question.sessionId}`); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: color.cyan, fontFamily: font.mono, fontSize: 12, padding: 0 }}>
                open live session ↗
              </button>
            )}
          </div>

          {/* The asking session is confirmed gone for good — say so before the human answers into a no-op. */}
          {question.sessionOrphaned && (
            <Panel style={{ borderLeft: `3px solid ${color.amber}` }}>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: color.amber }}>
                The asking session is gone for good and can never come back to pull an answer — submitting
                below will record your answer, but nothing will ever act on it automatically.
              </span>
            </Panel>
          )}

          {/* THE ASK */}
          <Panel style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `2px solid ${tone[REQUEST_TYPE_TONE[question.type]]}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <SectionLabel style={{ margin: 0 }}>The ask</SectionLabel>
              <span style={{ flex: 1 }} />
              <Badge tone={REQUEST_TYPE_TONE[question.type]}>{requestAnswerBadge(question)}</Badge>
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 15, color: color.text, lineHeight: 1.45 }}>{question.title}</div>
            {question.body && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{question.body}</div>}
          </Panel>

          {/* Resolved → the recorded readout; pending → the type-specific control. */}
          {question.state !== "pending"
            ? <AnsweredReadout q={question} />
            : <RequestControl q={question} />}
        </>
      )}
    </div>
  );
}

// The recorded answer for a non-pending request. A credential NEVER shows a value — only that it was
// provided, encrypted. Decision/input show the chosen option + note; permission shows the authorize/deny
// outcome + note.
function AnsweredReadout({ q }: { q: QuestionInboxItem }) {
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SectionLabel style={{ margin: 0 }}>{q.state === "consumed" ? "Answered · the manager pulled it" : "Answered · waiting on manager pickup"}</SectionLabel>
      {q.type === "credential" ? (
        <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim }}>provided · encrypted, not shown</div>
      ) : q.type === "permission" ? (
        <div style={{ fontFamily: font.mono, fontSize: 13, color: q.chosenOption === "authorize" ? color.phosphor : color.red }}>{requestOutcome(q)}</div>
      ) : (
        <>
          {q.chosenOption && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>Chose: <span style={{ color: color.cyan }}>{q.chosenOption}</span></div>}
          {q.note && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, whiteSpace: "pre-wrap" }}>Note: {q.note}</div>}
          {!q.chosenOption && !q.note && <span style={{ color: color.textMuted, fontSize: 12 }}>—</span>}
        </>
      )}
    </Panel>
  );
}

// Dispatch a PENDING request to its type-appropriate control.
function RequestControl({ q }: { q: QuestionInboxItem }) {
  switch (q.type) {
    case "permission": return <PermissionControl q={q} />;
    case "credential": return <CredentialControl q={q} />;
    case "input": return <InputControl q={q} />;
    default: return <DecisionControl q={q} />;
  }
}

// Shared submit-invalidation + a small success flash. Every control funnels its answer through here so the
// inbox + this question both refetch the moment the write lands.
function useAnswerMutation(id: string, mutationFn: () => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["question", id] });
      qc.invalidateQueries({ queryKey: ["openQuestions"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
}

const textareaStyle = {
  width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, background: color.panel2, color: color.text,
  border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "8px 10px", fontFamily: font.mono, fontSize: 13,
};

// decision — options as selectable choices (recommendation flagged) + an always-optional note. Picking an
// offered option is a convenience; a human may answer by free-text note alone (mirrors the answer route).
function DecisionControl({ q }: { q: QuestionInboxItem }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const hasOptions = !!q.options && q.options.length > 0;
  const answer = useAnswerMutation(q.id, () => api.answerQuestion(q.id, { chosenOption: choice, note: note.trim() || undefined }));
  const canSubmit = choice != null || note.trim().length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {hasOptions && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel>Options — pick one (optional)</SectionLabel>
          {q.options!.map((opt, i) => {
            const selected = choice === opt;
            const recommended = q.recommendation === opt;
            return (
              <Panel key={i} selected={selected} onClick={() => setChoice(opt)}
                style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <span aria-hidden style={{ width: 14, height: 14, borderRadius: 14, flexShrink: 0, marginTop: 2,
                  border: `2px solid ${selected ? color.cyan : color.borderStrong}`, background: selected ? color.cyan : "transparent",
                  boxShadow: selected ? `inset 0 0 0 2px ${color.panel}` : "none" }} />
                <span style={{ flex: 1, fontFamily: font.mono, fontSize: 13, color: color.text }}>{opt}</span>
                {recommended && <Badge tone="phosphor">recommended</Badge>}
              </Panel>
            );
          })}
        </div>
      )}
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>
          Note {hasOptions ? "(type your answer here, or add context for your pick)" : "(required — this is your answer)"}
        </SectionLabel>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder={hasOptions ? "add context for the manager…" : "your decision — e.g. “go ahead”, “hold off, do X first”…"}
          style={textareaStyle} />
        <SubmitRow label="Submit answer" disabled={!canSubmit} pending={answer.isPending} success={answer.isSuccess} onSubmit={() => answer.mutate()} />
      </Panel>
    </div>
  );
}

// input — a single required free-text answer (no options). The note IS the answer.
function InputControl({ q }: { q: QuestionInboxItem }) {
  const [note, setNote] = useState("");
  const answer = useAnswerMutation(q.id, () => api.answerQuestion(q.id, { note: note.trim() }));
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel style={{ margin: 0 }}>Your answer (required)</SectionLabel>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4}
        placeholder="type your answer…" style={textareaStyle} />
      <SubmitRow label="Submit answer" disabled={note.trim().length === 0} pending={answer.isPending} success={answer.isSuccess} onSubmit={() => answer.mutate()} />
    </Panel>
  );
}

// permission — Authorize / Deny + a scope picker (once / standing) with an optional expiry (standing only)
// + an optional note. The answer route only carries {decision, note}; the human's scope/expiry choice is
// folded into the note (Loom does not enforce the requested scope — it's the manager's to read), so the
// grant lifetime is never silently dropped.
function PermissionControl({ q }: { q: QuestionInboxItem }) {
  const [scope, setScope] = useState<PermissionScope>(q.permissionScope ?? "once");
  const [expiry, setExpiry] = useState<string>("");
  const [note, setNote] = useState("");
  const composeNote = (): string | undefined => {
    const scopeText = scope === "standing" ? `scope: standing${expiry ? ` until ${expiry}` : ""}` : "scope: once";
    const parts = [scopeText, note.trim()].filter(Boolean);
    return parts.join(" · ") || undefined;
  };
  const authorize = useAnswerMutation(q.id, () => api.answerPermissionQuestion(q.id, "authorize", composeNote()));
  const deny = useAnswerMutation(q.id, () => api.answerPermissionQuestion(q.id, "deny", note.trim() || undefined));
  const pending = authorize.isPending || deny.isPending;
  const kv = (label: string, value: string) => (
    <div style={{ display: "flex", gap: 10, fontFamily: font.mono, fontSize: 13 }}>
      <span style={{ color: color.textMuted, minWidth: 90 }}>{label}</span>
      <span style={{ color: color.text, whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel style={{ margin: 0 }}>Action</SectionLabel>
        {kv("Action", q.permissionAction ?? "—")}
        {kv("Requested", q.permissionScope ?? "once")}
        {q.permissionExpiresAt && kv("Until", q.permissionExpiresAt)}
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Scope</SectionLabel>
        <div style={{ display: "flex", gap: 8 }}>
          {PERMISSION_SCOPES.map((s) => {
            const selected = scope === s;
            return (
              <Panel key={s} selected={selected} onClick={() => setScope(s)}
                style={{ flex: 1, cursor: "pointer", display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: font.mono, fontSize: 13, color: selected ? color.phosphor : color.text }}>{s}</span>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
                  {s === "once" ? "this action only" : "keep authorizing this class"}
                </span>
              </Panel>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: scope === "standing" ? color.textDim : color.textMuted }}>Expiry</span>
          <Select value={expiry} disabled={scope !== "standing"} onChange={(e) => setExpiry(e.target.value)}
            title={scope === "standing" ? "Optional expiry for a standing grant" : "Enable by choosing the standing scope"}>
            <option value="">no expiry</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </Select>
        </div>
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Note (optional)</SectionLabel>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="add context for the manager…" style={textareaStyle} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" disabled={pending} onClick={() => authorize.mutate()}>{authorize.isPending ? "Authorizing…" : "Authorize"}</Button>
          <Button variant="danger" disabled={pending} onClick={() => deny.mutate()}>{deny.isPending ? "Denying…" : "Deny"}</Button>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Sends your decision to agent {q.sessionId.slice(0, 8)}.</span>
        </div>
        {(authorize.isSuccess || deny.isSuccess) && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ answered — the manager was nudged to pull it.</span>}
      </Panel>
    </div>
  );
}

// credential — NEVER-ECHO. A prominent banner, the target env-var name, and a MASKED secret input with a
// show/hide toggle. The plaintext is envelope-encrypted at the daemon's one write boundary and never
// returned; this UI must not imply otherwise.
function CredentialControl({ q }: { q: QuestionInboxItem }) {
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const answer = useAnswerMutation(q.id, () => api.answerCredentialQuestion(q.id, secret));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Panel style={{ borderLeft: `3px solid ${color.amber}`, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.amber }}>Write-only secret</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.5 }}>
          Stored envelope-encrypted (AES-256-GCM), exposed only to the agent’s environment, and NEVER echoed
          back to the agent or shown here again. Store it once — you won’t see it after.
        </span>
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Secret value</SectionLabel>
        {q.credentialEnvVar && (
          <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
            target env var: <span style={{ color: color.amber }}>{q.credentialEnvVar}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type={reveal ? "text" : "password"} value={secret} onChange={(e) => setSecret(e.target.value)}
            autoComplete="off" spellCheck={false} placeholder="paste the secret value…"
            style={{ flex: 1, ...textareaStyle, resize: undefined }} />
          <Button type="button" onClick={() => setReveal((r) => !r)} aria-pressed={reveal}
            title={reveal ? "Hide the secret" : "Show the secret"}>{reveal ? "Hide" : "Show"}</Button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button variant="primary" disabled={secret.trim().length === 0 || answer.isPending} onClick={() => answer.mutate()}>
            {answer.isPending ? "Storing…" : "Store securely"}
          </Button>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Encrypted at rest · never returned.</span>
        </div>
        {answer.isSuccess && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ stored — encrypted, and the manager was nudged to pull it.</span>}
      </Panel>
    </div>
  );
}

// The shared submit row (decision / input): a primary button + a one-line explainer + a success flash.
function SubmitRow({ label, disabled, pending, success, onSubmit }:
  { label: string; disabled: boolean; pending: boolean; success: boolean; onSubmit: () => void }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button variant="primary" disabled={disabled || pending} onClick={onSubmit}>{pending ? "Submitting…" : label}</Button>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Records your answer and nudges the manager to pull it.</span>
      </div>
      {success && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ answered — the manager was nudged to pull it.</span>}
    </>
  );
}

// ── RequestHistory — a searchable/filterable view of consumed requests ─────────────
// `openQuestions(true)` folds in the terminal (consumed) history. A console-style table with a search box
// + type/project/outcome/date filters. Clicking a row opens the same detail modal (read-only readout).
export function RequestHistory() {
  const questions = useQuery({ queryKey: ["openQuestions", "history"], queryFn: () => api.openQuestions(true), refetchInterval: 5000 });
  const [search, setSearch] = useState("");
  const [typeF, setTypeF] = useState<QuestionType | "all">("all");
  const [projF, setProjF] = useState<string>("all");
  const [outcomeF, setOutcomeF] = useState<"all" | "authorized" | "denied" | "answered" | "provided">("all");
  const [dateF, setDateF] = useState<"all" | "24h" | "7d" | "30d">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const now = Date.now();

  const all = questions.data ?? [];
  const consumed = useMemo(() => all.filter((q) => q.state === "consumed"), [all]);
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const q of consumed) m.set(q.projectId, q.projectName);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [consumed]);

  // Outcome bucket for a consumed request — drives the outcome filter.
  const outcomeOf = (q: QuestionInboxItem): "authorized" | "denied" | "answered" | "provided" =>
    q.type === "credential" ? "provided"
      : q.type === "permission" ? (q.chosenOption === "authorize" ? "authorized" : "denied")
        : "answered";
  const withinDate = (iso: string | null): boolean => {
    if (dateF === "all") return true;
    if (!iso) return false;
    const ms = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 }[dateF];
    return now - Date.parse(iso) <= ms;
  };
  const s = search.trim().toLowerCase();
  const rows = consumed.filter((q) =>
    (typeF === "all" || q.type === typeF) &&
    (projF === "all" || q.projectId === projF) &&
    (outcomeF === "all" || outcomeOf(q) === outcomeF) &&
    withinDate(q.answeredAt) &&
    (s === "" || `${q.title} ${q.note ?? ""} ${q.chosenOption ?? ""} ${q.agentName} ${q.projectName}`.toLowerCase().includes(s)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>History ({consumed.length} consumed)</SectionLabel>
      {/* filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search titles / answers / agents…"
          style={{ flex: "1 1 220px", minWidth: 180, ...textareaStyle, resize: undefined }} />
        <Select value={typeF} onChange={(e) => setTypeF(e.target.value as QuestionType | "all")}>
          <option value="all">all types</option>
          {REQUEST_TYPE_ORDER.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select value={projF} onChange={(e) => setProjF(e.target.value)}>
          <option value="all">all projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select value={outcomeF} onChange={(e) => setOutcomeF(e.target.value as typeof outcomeF)}>
          <option value="all">all outcomes</option>
          <option value="authorized">authorized</option>
          <option value="denied">denied</option>
          <option value="answered">answered</option>
          <option value="provided">provided</option>
        </Select>
        <Select value={dateF} onChange={(e) => setDateF(e.target.value as typeof dateF)}>
          <option value="all">any time</option>
          <option value="24h">last 24h</option>
          <option value="7d">last 7 days</option>
          <option value="30d">last 30 days</option>
        </Select>
      </div>

      {consumed.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No consumed requests yet — answered requests land here once the manager pulls them.</span></Panel>}
      {consumed.length > 0 && rows.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No history matches your search.</span></Panel>}

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((q) => (
            <button key={q.id} onClick={() => setOpenId(q.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer",
                background: color.panel, border: `1px solid ${color.border}`, borderLeft: `3px solid ${tone[REQUEST_TYPE_TONE[q.type]]}`,
                borderRadius: radius.sm, padding: "6px 10px" }}>
              <RequestTypeTag type={q.type} />
              <span style={{ flex: "2 1 200px", minWidth: 0, fontFamily: font.mono, fontSize: 12, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
              <span style={{ flex: "1 1 120px", minWidth: 0, fontFamily: font.mono, fontSize: 11, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.projectName} · {q.sessionId.slice(0, 8)}</span>
              <span style={{ flex: "2 1 200px", minWidth: 0, fontFamily: font.mono, fontSize: 11, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={requestOutcome(q)}>{requestOutcome(q)}</span>
              {q.taskId && <LinkedTaskChip taskId={q.taskId} />}
              <span style={{ flexShrink: 0, fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{relativeAge(q.answeredAt, now)}</span>
            </button>
          ))}
        </div>
      )}

      {openId && <RequestModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
