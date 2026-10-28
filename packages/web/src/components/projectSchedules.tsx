import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Schedule } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, SectionLabel, Chip } from "./ui";
import { color, font } from "../theme";

// THE PROJECT'S CRON SCHEDULES, read-only — one component, two mounts.
//
// It was local to pages/Overview.tsx until card 102bc915, which needed the SAME rendering on the
// Atlas project node (where no surface carried project-scoped schedules at all: only the god-eye,
// all-projects /automation page did, and under Atlas that is a WORKSPACE-tier tab). The move is a
// pure extraction — same JSX, same props, same query — so the classic page's render is byte-identical
// and the two mounts cannot drift into two ideas of what "this project's schedules" means.
//
// Read-only on BOTH mounts, deliberately: create / enable / delete live on the Automation page's Time
// tab, which owns the builder and its own agent picker. This is a window onto that surface, and the
// empty state is a pointer to it rather than a second, thinner copy of the form.
//
// Owns its OWN section chrome: with schedules, the full SectionLabel + Panel; with NONE, a single
// muted pointer line (no heading, no Panel box) so an empty project doesn't spend a whole section on
// "add one". That asymmetry is why the caller passes no label of its own.
//
// @decision 102bc915 — keep this a read-only window with ONE implementation. Do not add create /
// enable / delete here, and do not fork a second copy for a new mount: /automation owns the writes.

export function ProjectSchedules({ agentIds, agentName }: { agentIds: Set<string>; agentName: (id: string) => string }) {
  const navigate = useNavigate();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const mine = (schedules.data ?? []).filter((s) => agentIds.has(s.agentId));
  if (mine.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Schedules</span>
        <span>· none —</span>
        <button onClick={() => navigate("/automation")} title="Create a schedule on the Automation page"
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: color.cyan, fontFamily: font.mono, fontSize: 11 }}>
          add one on the Automation page →
        </button>
      </div>
    );
  }
  return (
    <section>
      <SectionLabel>Schedules</SectionLabel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {mine.map((s) => <ScheduleRow key={s.id} s={s} agentName={agentName(s.agentId)} />)}
      </Panel>
    </section>
  );
}

function ScheduleRow({ s, agentName }: { s: Schedule; agentName: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim,
      border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 8px" }}>
      <span style={{ color: color.cyan }}>{s.cron}</span>
      <Chip label="agent" value={agentName} />
      <span style={{ fontSize: 10, color: s.kind === "auditor" ? color.phosphor : color.amber }}>kind:{s.kind}</span>
      <span style={{ flex: 1 }}>next · {s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : "—"}</span>
      <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted }}>{s.enabled ? "ON" : "OFF"}</span>
    </div>
  );
}
