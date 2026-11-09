import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { describeCron, type Schedule } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, SectionLabel, Chip } from "./ui";
import { relativeResets } from "./atlasHome";
import { color, font, fs, radius } from "../theme";

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
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: ({ signal }) => api.schedules(signal) });
  const mine = (schedules.data ?? []).filter((s) => agentIds.has(s.agentId));
  if (mine.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: fs.sm, color: color.text3 }}>
        <span style={{ color: color.text2 }}>Schedules</span>
        <span>· none —</span>
        <button onClick={() => navigate("/automation")} title="Create a schedule on the Automation page"
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: color.accentFg, fontFamily: font.ui, fontSize: fs.sm }}>
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

// One schedule: name first, then its cadence in words, then who it fires; the status sits at the far
// end. The whole row is a link to the Automation page's Time tab (where the edit lives), never a control
// of its own. The row wraps instead of squeezing, so at phone width the chip and the status drop to a
// second line rather than breaking a word one letter per line.
//
// The cadence text is the shared `describeCron`, the same words the Automation table shows, and it
// returns the raw cron for any shape it doesn't model. The raw cron is always on the hover title.
function ScheduleRow({ s, agentName }: { s: Schedule; agentName: string }) {
  const navigate = useNavigate();
  const cadence = describeCron(s.cron);
  const exact = s.nextFireAt ? exactMinute(s.nextFireAt) : null;
  return (
    <button type="button" className="loom-projsched-row" data-testid="project-schedule-row"
      onClick={() => navigate("/automation")}
      title={`${s.name}: ${s.cron}. Edit it on the Automation page.`}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 10, rowGap: 4, width: "100%",
        textAlign: "left", cursor: "pointer", color: color.text2, borderRadius: radius.sm, padding: "6px 8px" }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500, color: color.text, minWidth: 0, overflowWrap: "break-word" }}>{s.name}</span>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text2 }}>{cadence}</span>
      <Chip label="agent" value={agentName} style={{ whiteSpace: "nowrap", flexShrink: 0 }} />
      <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3, whiteSpace: "nowrap" }}>kind:{s.kind}</span>
      <span style={{ marginLeft: "auto", fontFamily: font.mono, fontSize: fs.xs, whiteSpace: "nowrap", color: color.text3 }}
        title={s.enabled && exact ? exact : undefined}>
        {s.enabled
          ? <>next <span style={{ color: color.text2 }}>{nextFireLabel(s.nextFireAt)}</span></>
          : "paused"}
      </span>
    </button>
  );
}

// "in 2h 19m" within a week (the countdown grammar the fleet gauges use), a short date beyond it, where
// "in 203d 22h" stops being readable. No seconds and no locale-long timestamp either way.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function nextFireLabel(nextFireAt: string | null): string {
  if (!nextFireAt) return "—";
  const at = Date.parse(nextFireAt);
  if (Number.isFinite(at) && at - Date.now() > WEEK_MS) {
    return `on ${new Date(at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`;
  }
  return relativeResets(nextFireAt);
}

// The exact local fire time for the hover title: "2026-11-09 03:00". A cron fires on the minute, so
// seconds would only add noise, and a fixed shape avoids the browser-locale timestamp.
function exactMinute(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
