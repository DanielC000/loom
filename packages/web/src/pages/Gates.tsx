import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import type { GateRun, GateHistoryRow, GateType, GateOutcome, TaskPriority } from "@loom/shared";
import { api } from "../lib/api";
import { Panel, Button, SectionLabel } from "../components/ui";
import { color, font, radius, space } from "../theme";

// Gates page (card a1c86452) — the god-eye view of Loom's daemon-executed gates (merge, worker run_gate,
// deploy) across every project, all serialized through ONE daemon-global GateSemaphore. Owner-approved
// HYBRID: Direction 1's active-gate LANE-HERO on top (the semaphore lane + its queue, with the P-behind-P
// head-of-line block called out) + Direction 2's settled HISTORY table below. Its own per-project filter
// (default ALL). Reads two read-only endpoints: /api/gates/active (the live registry snapshot) and
// /api/gates/history (paginated settled events). Matches the mockup set at Mockups/2026-07-21 Gates Page.

const HISTORY_PAGE = 50;

// ── time helpers ──────────────────────────────────────────────────────────────
// A 1s tick so the running/queued elapsed clocks advance live (the lane-hero's amber elapsed + queue wait).
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// "7m 41s" / "44s" — an elapsed/duration in whole seconds, tabular for a steady clock.
function fmtSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
}
function fmtDurationMs(ms: number | null): string {
  return ms == null ? "—" : fmtSeconds(ms / 1000);
}
// "4m ago" / "2h 5m ago" / "just now" — a coarse relative time for a settled row.
function relTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const remM = min % 60;
  if (hr < 24) return remM > 0 ? `${hr}h ${remM}m ago` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ── gate-type + outcome + priority styling (kept on the existing token palette) ──
const KIND_COLOR: Record<GateType, string> = { merge: color.phosphor, deploy: color.amber, worker: color.cyan };
const KIND_LABEL: Record<GateType, string> = { merge: "merge", deploy: "deploy", worker: "worker" };
const OUTCOME_COLOR: Record<GateOutcome, string> = { pass: color.phosphor, reject: color.red, timeout: color.red, kill: color.red };
const OUTCOME_GLOW: Record<GateOutcome, boolean> = { pass: false, reject: false, timeout: true, kill: true };
const PRIORITY_RANK: Record<TaskPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const PRIORITY_COLOR: Record<TaskPriority, string> = { p0: color.red, p1: color.red, p2: color.amber, p3: color.textMuted };

// A long-running lane cue mirroring the mockup: warn (amber) once a running gate passes this, since the
// default gateCommandTimeoutMs is minutes and a lane held this long is worth the eye.
const LONG_RUN_WARN_SECONDS = 420;

export default function Gates() {
  const now = useNow();
  // Filter is a projectId, or "*" for ALL (default). Kept in component state (not the URL) — the page is a
  // god-eye view, not the header-picker-scoped kind.
  const [filter, setFilter] = useState<string>("*");

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const active = useQuery({
    queryKey: ["gates-active"],
    queryFn: () => api.gatesActive(),
    refetchInterval: 2000, // the live lane occupancy changes as gates are admitted/settle
  });
  const history = useInfiniteQuery({
    queryKey: ["gates-history", filter],
    queryFn: ({ pageParam }) =>
      api.gatesHistory({ projectId: filter === "*" ? undefined : filter, limit: HISTORY_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // Poll ONLY while a single page is loaded — refetching an infinite query re-runs every loaded page, so
    // stop polling once the user has paged (mirrors the archived-sessions pagination pattern).
    refetchInterval: (q) => ((q.state.data?.pages.length ?? 1) <= 1 ? 5000 : false),
  });

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [projects.data]);

  const cap = active.data?.cap ?? 1;
  const globalActive = active.data?.activeCount ?? 0;
  const globalQueued = active.data?.queuedCount ?? 0;
  const gates = active.data?.gates ?? [];
  const shownGates = filter === "*" ? gates : gates.filter((g) => g.projectId === filter);
  const running = shownGates.filter((g) => g.phase === "running");
  const queued = shownGates
    .filter((g) => g.phase === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));

  const historyRows = history.data?.pages.flatMap((p) => p.items) ?? [];
  const historyTotal = history.data?.pages[0]?.total ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(4) }}>
      <PageHead cap={cap} activeCount={globalActive} queuedCount={globalQueued} />

      <ProjectFilter
        projects={(projects.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
        value={filter}
        onChange={setFilter}
      />

      <section>
        <SectionLabel style={{ margin: `0 0 ${space(3)}` }}>Active · Lane occupancy</SectionLabel>
        <LaneHero
          cap={cap}
          globalActive={globalActive}
          globalQueued={globalQueued}
          running={running}
          queued={queued}
          filterLabel={filter === "*" ? null : projectName(filter)}
          loading={active.isLoading}
          now={now}
        />
      </section>

      <section>
        <SectionLabel style={{ margin: `0 0 ${space(3)}` }}>
          History <span style={{ color: color.textMuted, fontWeight: 400 }}>· {historyTotal} run{historyTotal === 1 ? "" : "s"}</span>
        </SectionLabel>
        <HistoryTable
          rows={historyRows}
          now={now}
          loading={history.isLoading}
          error={history.isError}
          projectName={projectName}
        />
        {history.hasNextPage && (
          <div style={{ marginTop: space(3) }}>
            <Button onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
              {history.isFetchingNextPage ? "Loading…" : `Load more (${historyRows.length} of ${historyTotal})`}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Page header — title + subtitle + the global semaphore occupancy lamps ────────
function PageHead({ cap, activeCount, queuedCount }: { cap: number; activeCount: number; queuedCount: number }) {
  const laneTone = activeCount > 0 ? color.amber : color.borderStrong;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: space(4), flexWrap: "wrap" }}>
      <div>
        <h1 style={{ fontFamily: font.head, fontWeight: 600, fontSize: 22, letterSpacing: "0.14em", textTransform: "uppercase", margin: 0, color: color.text }}>
          Gates
        </h1>
        <div style={{ color: color.textDim, fontSize: 12, marginTop: 2 }}>
          Every gate serializes through the GateSemaphore — {cap} lane{cap === 1 ? "" : "s"} by default
        </div>
      </div>
      <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: space(4) }}>
        <Lamp color={laneTone} glow={activeCount > 0} label={`${activeCount} / ${cap} lane${cap === 1 ? "" : "s"} busy`} />
        <Lamp color={queuedCount > 0 ? color.cyan : color.borderStrong} label={`${queuedCount} queued`} />
      </div>
    </div>
  );
}

function Lamp({ color: c, glow, label }: { color: string; glow?: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: color.textDim }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: c, ...(glow ? { boxShadow: `0 0 6px ${c}` } : null) }} />
      {label}
    </span>
  );
}

// ── Per-project filter — All + one chip per project (active = phosphor) ──────────
function ProjectFilter({
  projects, value, onChange,
}: {
  projects: { id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const chips = [{ id: "*", name: "All" }, ...projects];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: color.textMuted, marginRight: 4 }}>
        Project
      </span>
      {chips.map((c) => {
        const on = value === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            aria-pressed={on}
            className="loom-btn"
            style={{
              cursor: "pointer",
              fontFamily: font.mono,
              fontSize: 11,
              letterSpacing: "0.04em",
              padding: "3px 10px",
              borderRadius: radius.base,
              border: `1px solid ${on ? color.phosphor : color.border}`,
              color: on ? color.phosphor : color.textDim,
              background: on ? color.phosphorDim : "transparent",
            }}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

// ── The lane-hero (Direction 1): the semaphore lane(s) holding running gates + the queue beside them ──
function LaneHero({
  cap, globalActive, globalQueued, running, queued, filterLabel, loading, now,
}: {
  cap: number;
  globalActive: number;
  globalQueued: number;
  running: GateRun[];
  queued: GateRun[];
  filterLabel: string | null;
  loading: boolean;
  now: number;
}) {
  // Head-of-line block: a queued gate strictly MORE urgent than a gate currently holding a lane. This is
  // the exact pain the owner wanted rendered (a P1 merge stuck behind a P3 worker self-check).
  const holGate = queued.find(
    (q) => q.priority != null && running.some((r) => PRIORITY_RANK[q.priority!] < PRIORITY_RANK[r.priority ?? "p3"]),
  );
  const holBlocker = holGate
    ? running.find((r) => PRIORITY_RANK[holGate.priority!] < PRIORITY_RANK[r.priority ?? "p3"])
    : undefined;

  // One slot per lane: fill with running gates, the rest are idle. Never fewer than the running count.
  const laneCount = Math.max(cap, running.length);
  const laneSlots = Array.from({ length: laneCount }, (_, i) => running[i] ?? null);

  const emptyForFilter = !loading && running.length === 0 && queued.length === 0;

  return (
    <Panel grid style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
          Semaphore
        </span>
        <span style={{ fontSize: 12, color: color.textMuted }}>
          <b style={{ color: color.amber, fontWeight: 500 }}>{globalActive}</b> of {cap} lane{cap === 1 ? "" : "s"} busy · {globalQueued} queued · maxConcurrentGates <b style={{ color: color.amber, fontWeight: 500 }}>{cap}</b>
        </span>
      </div>

      {loading ? (
        <div style={{ color: color.textMuted, fontSize: 12, padding: "8px 2px" }}>Reading the live semaphore…</div>
      ) : emptyForFilter ? (
        <div style={{ color: color.textMuted, fontSize: 12, padding: "8px 2px" }}>
          No gate is running or queued{filterLabel ? ` for ${filterLabel}` : ""}.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "stretch", gap: 0, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "none", width: 320, minWidth: 260 }}>
            {laneSlots.map((g, i) => (
              <LaneSlot key={g?.id ?? `idle-${i}`} index={i} gate={g} now={now} filterLabel={filterLabel} globalActive={globalActive} />
            ))}
          </div>
          <div style={{ flex: "none", width: 44, display: "flex", alignItems: "center", justifyContent: "center", color: color.textMuted, fontSize: 18 }}>
            ◂
          </div>
          <div style={{ flex: 1, minWidth: 240, border: `1px dashed ${color.borderStrong}`, borderRadius: radius.base, padding: 12, background: color.panel2 }}>
            <div style={{ fontFamily: font.head, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: color.textMuted, marginBottom: 10 }}>
              Queue — waiting for a lane ({queued.length})
            </div>
            {queued.length === 0 ? (
              <div style={{ color: color.textMuted, fontSize: 12 }}>Queue empty — no gate waiting for a lane.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {queued.map((g, i) => (
                  <QueueCard key={g.id} gate={g} position={i + 1} now={now} isHol={g.id === holGate?.id} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {holGate && holBlocker && (
        <div style={{ marginTop: 12, padding: "8px 12px", border: `1px solid ${color.red}`, borderLeftWidth: 3, borderRadius: radius.base, background: "rgba(255,92,92,0.05)", fontSize: 12, color: color.text }}>
          <b style={{ color: color.red, fontWeight: 500 }}>Head-of-line block.</b>{" "}
          A {(holGate.priority ?? "").toUpperCase()} {KIND_LABEL[holGate.gateType]} gate
          {holGate.projectName ? ` (${holGate.projectName})` : ""} has waited{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtSeconds((now - Date.parse(holGate.since)) / 1000)}</span>{" "}
          behind a {(holBlocker.priority ?? "").toUpperCase()} {KIND_LABEL[holBlocker.gateType]} gate. Gates serialize; the lane frees when the running gate settles or times out.
        </div>
      )}
    </Panel>
  );
}

// One lane slot — a running gate card, or an idle placeholder when the lane isn't held for this view.
function LaneSlot({
  index, gate, now, filterLabel, globalActive,
}: {
  index: number;
  gate: GateRun | null;
  now: number;
  filterLabel: string | null;
  globalActive: number;
}) {
  const slotLabel = `Lane ${String(index + 1).padStart(2, "0")}`;
  if (!gate) {
    // Idle FOR THIS VIEW. Be honest about WHY: the lane may still be globally busy with another project's
    // gate (when filtered), vs genuinely free.
    const heldElsewhere = filterLabel != null && globalActive > 0;
    return (
      <div>
        <div style={slotLblStyle}>{slotLabel}</div>
        <div style={{ border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: 12, opacity: 0.6 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: color.textDim }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: color.textMuted }} />
            Idle
          </div>
          <div style={{ fontSize: 12, color: color.textDim, marginTop: 6 }}>
            {heldElsewhere ? "Lane held by another project's gate" : "Lane free"}
          </div>
          <div style={{ fontSize: 11, color: color.textMuted, marginTop: 3 }}>
            {heldElsewhere
              ? `A gate on ${filterLabel} is next in line when the lane frees`
              : filterLabel
                ? `A gate on ${filterLabel} would start immediately`
                : "A new gate would start immediately"}
          </div>
        </div>
      </div>
    );
  }
  const elapsedSec = (now - Date.parse(gate.since)) / 1000;
  const warn = elapsedSec > LONG_RUN_WARN_SECONDS;
  return (
    <div>
      <div style={slotLblStyle}>{slotLabel}</div>
      <div style={{ position: "relative", border: `1px solid ${color.amber}`, borderRadius: radius.base, background: "linear-gradient(180deg,rgba(255,178,62,0.05),transparent)", padding: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: color.amber }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: color.amber, boxShadow: `0 0 6px ${color.amber}` }} />
            Running
          </span>
          <KindTag gate={gate} />
          <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", fontSize: 18, color: warn ? color.red : color.amber }}>
            {fmtSeconds(elapsedSec)}
          </span>
        </div>
        <div style={{ fontSize: 14, color: color.text, marginBottom: 2 }}>{gate.projectName}</div>
        {gate.branch && <div style={{ fontSize: 11, color: color.textDim, fontFamily: font.mono }}>{gate.branch}</div>}
        <div style={{ fontSize: 11, color: color.textMuted, marginTop: 5 }}>
          {gate.workerLabel ?? "—"}
          {gate.priority ? ` · ${gate.priority.toUpperCase()}` : ""}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, overflow: "hidden" }}>
          {/* Reuse the board card's oscilloscope sweep (loom-merge-sweep) — the shared running-gate liveness
              cue, already reduced-motion-aware in global.css. */}
          <span className="loom-merge-sweep" />
        </div>
      </div>
    </div>
  );
}

const slotLblStyle: CSSProperties = { fontFamily: font.head, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: color.textMuted, marginBottom: 6 };

// One queued gate — numbered, with its kind, project/branch, priority chip, and live wait.
function QueueCard({ gate, position, now, isHol }: { gate: GateRun; position: number; now: number; isHol: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
      border: `1px solid ${color.border}`,
      borderLeft: `2px solid ${isHol ? color.red : color.borderStrong}`,
      borderRadius: radius.sm,
      background: isHol ? "linear-gradient(90deg,rgba(255,92,92,0.06),transparent 60%)" : color.panel,
    }}>
      <span style={{ fontFamily: font.head, fontWeight: 700, fontSize: 13, color: isHol ? color.red : color.textMuted, width: 20, textAlign: "center", flex: "none" }}>
        {position}
      </span>
      <KindTag gate={gate} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gate.projectName}</div>
        <div style={{ fontSize: 10, color: color.textMuted, fontFamily: font.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {gate.branch ?? gate.workerLabel ?? "—"}
        </div>
      </div>
      {gate.priority && <PriorityTag priority={gate.priority} />}
      <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, color: color.textDim, flex: "none" }}>
        waited {fmtSeconds((now - Date.parse(gate.since)) / 1000)}
      </span>
    </div>
  );
}

function KindTag({ gate }: { gate: GateRun }) {
  const c = KIND_COLOR[gate.gateType];
  return (
    <span style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: radius.sm, border: `1px solid ${c}`, color: c, flex: "none" }}>
      {KIND_LABEL[gate.gateType]}
    </span>
  );
}

function PriorityTag({ priority }: { priority: TaskPriority }) {
  const c = PRIORITY_COLOR[priority];
  return (
    <span style={{ fontSize: 9, letterSpacing: "0.07em", textTransform: "uppercase", padding: "1px 6px", borderRadius: radius.sm, border: `1px solid ${c}`, color: c, flex: "none" }}>
      {priority}
    </span>
  );
}

// ── The history table (Direction 2): settled gate runs, newest first ─────────────
function HistoryTable({
  rows, now, loading, error, projectName,
}: {
  rows: GateHistoryRow[];
  now: number;
  loading: boolean;
  error: boolean;
  projectName: (id: string) => string;
}) {
  if (error) {
    return <Panel style={{ padding: 16, color: color.red, fontSize: 12 }}>Couldn't load gate history.</Panel>;
  }
  if (loading) {
    return <Panel style={{ padding: 16, color: color.textMuted, fontSize: 12 }}>Loading gate history…</Panel>;
  }
  if (rows.length === 0) {
    return <Panel style={{ padding: 16, color: color.textMuted, fontSize: 12 }}>No gate history yet — settled merge, worker, and deploy gates will appear here newest-first.</Panel>;
  }
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["Outcome", "Kind", "Project", "Branch", "Worker", "Duration", "Ended"].map((h) => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HistoryRow key={r.id} row={r} now={now} projectName={projectName} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({ row, now, projectName }: { row: GateHistoryRow; now: number; projectName: (id: string) => string }) {
  const kindC = KIND_COLOR[row.gateType];
  const outC = OUTCOME_COLOR[row.outcome];
  const killed = row.outcome === "kill" || row.outcome === "timeout";
  return (
    <tr className="loom-gate-row">
      <td style={tdStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: outC }}>
          <span style={{ width: 7, height: 7, borderRadius: 7, background: outC, ...(OUTCOME_GLOW[row.outcome] ? { boxShadow: `0 0 5px ${outC}` } : null) }} />
          {row.outcome}
        </span>
      </td>
      <td style={tdStyle}><span style={{ fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: kindC }}>{KIND_LABEL[row.gateType]}</span></td>
      <td style={tdStyle}>{row.projectName ?? (row.projectId ? projectName(row.projectId) : "—")}</td>
      <td style={{ ...tdStyle, color: color.textDim, fontFamily: font.mono }}>{row.branch ?? "—"}</td>
      <td style={{ ...tdStyle, color: color.textDim, fontFamily: font.mono }} title={row.failingTest ?? undefined}>
        {row.workerLabel ?? "—"}
        {row.failingTest && <span style={{ color: color.red }}> · {row.failingTest}</span>}
      </td>
      <td style={tdStyle}>
        <span style={{ fontVariantNumeric: "tabular-nums", color: killed ? color.red : color.text }}>
          {fmtDurationMs(row.durationMs)}
        </span>
      </td>
      <td style={{ ...tdStyle, color: color.textMuted, fontFamily: font.mono }}>{relTime(row.endedAt, now)}</td>
    </tr>
  );
}

const thStyle: CSSProperties = { textAlign: "left", fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, padding: "10px 12px 8px", borderBottom: `1px solid ${color.border}`, whiteSpace: "nowrap" };
const tdStyle: CSSProperties = { padding: "9px 12px", borderBottom: `1px solid ${color.border}`, whiteSpace: "nowrap" };
