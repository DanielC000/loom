import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Panel, Badge, SectionLabel } from "../components/ui";
import { SuggestionRow, SUGGESTIONS_KEY } from "../components/PresetPrompts";
import { api } from "../lib/api";
import { color, font, radius, type Tone } from "../theme";
import type { PlatformEdition } from "./platformEdition";

// The Atlas Platform node's FINDINGS tab (card c07ff42a, Atlas build plan P2-4). Two things the auditor
// produces, which today have no first-class home between them:
//
//   1. FILED FINDINGS — what the auditor wrote onto the reserved home's board. The classic layout shows
//      these only as chips on an individual auditor RUN row (RunHistory's `showFindings`), so reading
//      "what has the auditor found" means expanding runs one at a time. Here they are one list, newest
//      first, each resolved to its board card.
//   2. PENDING PRESET SUGGESTIONS — preset candidates the auditor proposed from recurring prompts, with
//      inline Adopt / Dismiss. Today these are reachable ONLY through a live session's composer "Spark"
//      popover, which means they are invisible unless a session happens to be open. That is the gap the
//      approved round-4 design closes by giving them a tab of their own.
//
// COMPOSITION ONLY — no new api.ts member. Three existing reads, and the two writes come from the SHARED
// SuggestionRow (components/PresetPrompts.tsx), so Adopt/Dismiss — including its 409 stale-row recovery
// and its both-keys invalidation — has exactly one implementation across the composer popover and here.
//
// @decision 8adccd37 — never read the edition-preview toggle here; take the resolved `edition` as a prop.
//
// This surface's one edition fork is `edition.findingEventKind`, a static literal in the config, and BOTH
// of its values name an ordinary, ungated read — so previewing the other edition can never reach a route
// the daemon would not already serve this install.
export function PlatformFindings({ edition, projectId }: { edition: PlatformEdition; projectId: string }) {
  // The event KIND is itself the home scope: the daemon emits `audit_finding` only from the reserved
  // Platform board's Auditor and `workspace_audit_suggestion` only from the user home's workspace
  // auditor (see platformEdition.ts's PlatformFindingKind note). So no join against a session list is
  // needed to keep one edition's findings out of the other's — which also means an ARCHIVED auditor
  // run's findings still appear, where a session-list join would silently have dropped them.
  const events = useQuery({
    queryKey: ["orchestrationEventsByKinds", edition.findingEventKind],
    queryFn: () => api.orchestrationEventsByKinds([edition.findingEventKind]),
    refetchInterval: 8000,
  });
  // The SAME key + fetcher RunHistory and the Board tab use, so this shares their cache entry rather
  // than issuing a third read of the same board.
  const board = useQuery({
    queryKey: ["board", projectId],
    queryFn: () => api.board(projectId),
    refetchInterval: 8000,
  });
  const suggestions = useQuery({ queryKey: SUGGESTIONS_KEY, queryFn: () => api.presetPromptSuggestions() });

  const tasks = board.data?.tasks ?? [];
  const findings = [...(events.data ?? [])].sort((a, b) => b.ts.localeCompare(a.ts));
  const pending = [...(suggestions.data ?? [])].sort((a, b) => a.position - b.position);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {edition.copy.findings.label}
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            {edition.copy.findings.hint}
          </span>
        </SectionLabel>
        {findings.length === 0 ? (
          <Panel style={{ padding: 12 }}>
            <span style={{ color: color.textMuted, fontSize: 12 }}>{edition.copy.findings.empty}</span>
          </Panel>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {findings.map((f) => (
              <FindingRow key={f.id} ts={f.ts} runId={f.managerSessionId} taskId={f.taskId ?? null}
                detail={f.detail} onBoard={tasks.some((t) => t.id === f.taskId)}
                boardTitle={tasks.find((t) => t.id === f.taskId)?.title} />
            ))}
          </div>
        )}
      </section>

      {/* Only rendered when the auditor has actually proposed something — the same rule the composer
          popover's own suggestions block follows, so an empty store adds no furniture here either. */}
      {pending.length > 0 && (
        <section>
          <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            Suggested presets
            <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
              preset prompts the Auditor proposed from prompts you repeat — adopting one adds it to every composer
            </span>
          </SectionLabel>
          {/* Wider than the popover it also renders in, but capped: a prompt preview wants a readable
              measure, not the full width of a desktop node. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 8, maxWidth: 1040 }}>
            {pending.map((s) => <SuggestionRow key={s.id} suggestion={s} />)}
          </div>
        </section>
      )}
    </div>
  );
}

// `detail` is the daemon's own free-form event payload, so every read of it is defensive: a severity it
// does not recognise is rendered as-is rather than dropped or coerced to a tone it never meant.
const SEVERITY_TONE: Record<string, Tone> = {
  critical: "red",
  high: "red",
  medium: "amber",
  low: "muted",
};

function FindingRow({ ts, runId, taskId, detail, onBoard, boardTitle }: {
  ts: string;
  runId: string;
  taskId: string | null;
  detail?: Record<string, unknown>;
  onBoard: boolean;
  boardTitle?: string;
}) {
  // The BOARD's own title wins when the card still exists — a human may have retitled it since, and the
  // event payload froze the original. The frozen title is the fallback for a card that is gone.
  const frozenTitle = typeof detail?.title === "string" ? detail.title : undefined;
  const title = boardTitle ?? frozenTitle ?? "finding";
  const severity = typeof detail?.severity === "string" ? detail.severity : undefined;
  const tone: Tone = severity ? SEVERITY_TONE[severity] ?? "cyan" : "muted";

  return (
    <Panel data-testid="platform-finding"
      style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {severity
        ? <Badge tone={tone}>{severity}</Badge>
        : <Badge tone="muted">filed</Badge>}
      <span style={{ fontFamily: font.mono, fontSize: 12.5, color: color.text, flex: 1, minWidth: 180 }}>
        {title}
      </span>
      <span title={`filed by run ${runId}`} style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
        {new Date(ts).toLocaleString()} · run {runId.slice(0, 8)}
      </span>
      {onBoard && taskId ? (
        // The findings list is a READ; triage happens on the board. `?task=` is the board's own existing
        // deep link (pages/Board.tsx consumes and clears it), and `tab=board` keeps the Platform node on
        // its own board rather than the active project's — so one click lands on the card's dialog.
        <Link to={`/platform?tab=board&task=${encodeURIComponent(taskId)}`}
          title="Open this finding's card on the Platform board"
          style={{ fontFamily: font.mono, fontSize: 11, color: color.cyan, textDecoration: "none",
            border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "2px 8px" }}>
          Open on the board →
        </Link>
      ) : (
        // A finding whose card was deleted stays listed rather than vanishing: the finding was still
        // filed, and silently dropping the row would misreport the auditor's own history.
        <span title="This finding's board card no longer exists"
          style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted,
            border: `1px solid ${color.border}`, borderRadius: radius.base, padding: "2px 8px" }}>
          card removed
        </span>
      )}
    </Panel>
  );
}
