import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuestionInboxItem } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, SectionLabel, Badge } from "../components/ui";
import { DecisionStateChip } from "../components/decisions";
import { relativeAge } from "../lib/questions";
import { color, font, radius } from "../theme";

// The ANSWER PAGE (card 8701bdbb, child B · surface 2) — a sibling of ReviewPanel. A manager→human
// decision, answered in ONE selection + an always-optional note (a pure-blocker with no options → the
// note IS the answer, and is required). Submits the EXISTING human-only answer route (api.answerQuestion,
// the sole writer of chosenOption/note). Remounted per id (key) so pick/note/result never carry across a
// navigation, mirroring ReviewPanel.
export default function QuestionAnswer() {
  const { id = "" } = useParams();
  return <QuestionAnswerInner key={id} id={id} />;
}

function QuestionAnswerInner({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["question", id], queryFn: () => api.question(id), enabled: !!id, retry: false });
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const now = Date.now();

  const question = q.data;
  const hasOptions = !!question?.options && question.options.length > 0;
  const pending = question?.state === "pending";
  // Mirror the answer route's validation: picking an offered option is optional even when options exist —
  // the human may answer by free-text note alone. Submit is enabled when EITHER an option is selected OR
  // the note is non-empty; only a fully-empty answer is rejected. Gated on the same rule as the route so
  // the human never round-trips a 400.
  const canSubmit = pending && (choice != null || note.trim().length > 0);

  const answer = useMutation({
    mutationFn: () => api.answerQuestion(id, { chosenOption: choice, note: note.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["question", id] });
      qc.invalidateQueries({ queryKey: ["openQuestions"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Button onClick={() => navigate(-1)}>← back</Button>
        <span style={{ fontFamily: font.head, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Decision</span>
        {question && (
          <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
            mgr {question.sessionId.slice(0, 8)} · <span style={{ color: color.cyan }}>{question.projectName}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {question && (
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
            asked {relativeAge(question.createdAt, now)}
          </span>
        )}
        {question && <DecisionStateChip q={question} now={now} />}
        {question?.sessionLive && (
          <button onClick={() => navigate(`/session/${question.sessionId}`)}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: color.cyan, fontFamily: font.mono, fontSize: 12, padding: 0 }}>
            open live session ↗
          </button>
        )}
      </div>

      {q.isError && <Panel><span style={{ color: color.red, fontSize: 12 }}>Question not found (it may have been removed).</span></Panel>}
      {q.isLoading && <Panel><span style={{ color: color.textMuted, fontSize: 12 }}>Loading…</span></Panel>}

      {question && (
        <>
          {/* The asking session is confirmed gone for good (hard-deleted, or a resume already proved it
              unresumable) — submitting an answer here still records it, but no manager will ever pull it.
              Say so up front rather than letting the human submit into a silent no-op. */}
          {question.sessionOrphaned && (
            <Panel style={{ borderLeft: `3px solid ${color.amber}` }}>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: color.amber }}>
                The asking session is gone for good and can never come back to pull an answer — submitting
                below will record your note, but nothing will ever act on it automatically.
              </span>
            </Panel>
          )}
          {/* THE ASK */}
          <Panel style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `2px solid ${color.cyan}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <SectionLabel style={{ margin: 0 }}>The ask</SectionLabel>
              <span style={{ flex: 1 }} />
              <Badge tone="cyan">{hasOptions ? "pick one or write a note" : "note only"}</Badge>
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 15, color: color.text, lineHeight: 1.45 }}>{question.title}</div>
            {question.body && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{question.body}</div>}
          </Panel>

          {/* If already resolved, show the recorded answer instead of a live form. */}
          {!pending && (
            <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SectionLabel style={{ margin: 0 }}>{question.state === "consumed" ? "Answered · the manager pulled it" : "Answered · waiting on manager pickup"}</SectionLabel>
              {question.chosenOption && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>Chose: <span style={{ color: color.cyan }}>{question.chosenOption}</span></div>}
              {question.note && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, whiteSpace: "pre-wrap" }}>Note: {question.note}</div>}
              {!question.chosenOption && !question.note && <span style={{ color: color.textMuted, fontSize: 12 }}>—</span>}
            </Panel>
          )}

          {/* PICK ONE — the options as selectable choices, recommendation flagged. */}
          {pending && hasOptions && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel>Options — pick one (optional)</SectionLabel>
              {question.options!.map((opt, i) => {
                const selected = choice === opt;
                const recommended = question.recommendation === opt;
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

          {/* NOTE — always present; the pure-blocker's only (required) payload. */}
          {pending && (
            <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionLabel style={{ margin: 0 }}>
                Note {hasOptions ? "(type your answer here, or add context for your pick)" : "(required — this is your answer)"}
              </SectionLabel>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                placeholder={hasOptions ? "add context for the manager…" : "your decision — e.g. “go ahead”, “hold off, do X first”…"}
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: color.panel2, color: color.text,
                  border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "8px 10px", fontFamily: font.mono, fontSize: 13 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Button variant="primary" disabled={!canSubmit || answer.isPending} onClick={() => answer.mutate()}>
                  {answer.isPending ? "Submitting…" : "Submit answer"}
                </Button>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
                  Sends your {hasOptions ? "answer" : "note"} to mgr {question.sessionId.slice(0, 8)} and marks this decision answered.
                </span>
              </div>
              {answer.isSuccess && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ answered — the manager was nudged to pull it.</span>}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
