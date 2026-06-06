import { useQuery } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent, UsageLimitsStatus, UsageWindow } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { isRateLimited, type AttentionItem } from "../lib/attention";
import { Panel, StatusPill, Chip, Meter, Button, Dot } from "./ui";
import { color, font, radius, tone, type Tone } from "../theme";

// Shared FLEET widgets — the projects→managers→workers roll-up cards, fleet rows, plan-usage strip,
// attention rows, activity rows, and their roll-up helpers. Extracted from MissionControl (the
// god-eye view) so the project-scoped Overview page can compose the SAME widgets against a
// project-filtered session set. Pure presentation off existing endpoints; no new backend.

export function sessionStatus(s: SessionListItem): { tone: Tone; label: string; glow?: boolean } {
  if (isRateLimited(s)) return { tone: "red", label: "rate-limited" };
  if (s.processState !== "live") return { tone: "muted", label: s.processState };
  if (s.busy) return { tone: "amber", label: "busy", glow: true };
  return { tone: "phosphor", label: "idle" };
}

export function Stat({ label, value, tone: t = "phosphor" }: { label: string; value: number; tone?: Tone }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", border: `1px solid ${color.border}`, borderRadius: 4, padding: "4px 12px", minWidth: 64 }}>
      <span style={{ fontFamily: font.mono, fontSize: 20, color: tone[t] }}>{value}</span>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>{label}</span>
    </span>
  );
}

// ── Plan-usage strip ───────────────────────────────────────────────────────────
// The user's REAL Claude *account/plan* usage (rate-limit headroom) — 5h + 7d windows, per-model
// weekly + extra-usage — from the daemon's single cached OAuth poll (GET /api/usage/limits). The
// daemon polls modestly; the UI just re-reads the cache. Every failure mode comes back as
// `available:false` + a reason → a small muted note, never an error/crash.

// Utilization → tone, consistent with CONTEXT_WARN_RATIO styling: phosphor < 80% ≤ amber < 95% ≤ red.
function usageTone(utilization: number): Tone {
  if (utilization >= 95) return "red";
  if (utilization >= 80) return "amber";
  return "phosphor";
}

// ms-from-now → "3d 4h" / "1h 42m" / "12m" / "now". "—" when there's no reset instant.
function resetCountdown(resetsAt: string | null): string {
  if (!resetsAt) return "—";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsageGauge({ label, window: w }: { label: string; window: UsageWindow }) {
  const util = Math.round(w.utilization);
  const t = usageTone(w.utilization);
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 12px", minWidth: 132 }}>
      <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: font.mono, fontSize: 14, color: tone[t] }}>{util}%</span>
      </span>
      <Meter value={util} max={100} tone={t} width={110} />
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>resets in {resetCountdown(w.resetsAt)}</span>
    </div>
  );
}

export function PlanUsageStrip() {
  // The daemon caches; a light refetch keeps the countdowns and percentages fresh.
  const usage = useQuery<UsageLimitsStatus>({ queryKey: ["usageLimits"], queryFn: api.usageLimits, refetchInterval: 30_000 });
  const data = usage.data;

  if (!data || !data.available) {
    const reason = data && !data.available ? data.reason : usage.isLoading ? "loading…" : "no data";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>plan usage</span>
        <span title={reason} style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>unavailable</span>
      </div>
    );
  }

  const extra = data.extraUsage;
  // Extra-usage utilization is null until metered → derive from credits when we can.
  const extraUtil = extra
    ? extra.utilization ?? (extra.monthlyLimit && extra.usedCredits != null ? (extra.usedCredits / extra.monthlyLimit) * 100 : 0)
    : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>plan usage</span>
      <UsageGauge label="5h session" window={data.fiveHour} />
      <UsageGauge label="7d weekly" window={data.sevenDay} />
      {data.sevenDayOpus && <UsageGauge label="7d opus" window={data.sevenDayOpus} />}
      {data.sevenDaySonnet && <UsageGauge label="7d sonnet" window={data.sevenDaySonnet} />}
      {extra?.isEnabled && (
        <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 12px", minWidth: 132 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>extra usage</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: font.mono, fontSize: 14, color: tone[usageTone(extraUtil)] }}>{Math.round(extraUtil)}%</span>
          </span>
          <Meter value={extraUtil} max={100} tone={usageTone(extraUtil)} width={110} />
          <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
            {extra.usedCredits ?? 0}/{extra.monthlyLimit ?? "—"} credits
          </span>
        </div>
      )}
    </div>
  );
}

export function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 10px", marginBottom: 6 }}>
      <Dot tone={item.tone} glow={item.tone === "amber"} />
      <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[item.tone], textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{item.kind}</span>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
      <span style={{ flex: 1 }} />
      {onOpen && <Button onClick={onOpen}>Open</Button>}
    </div>
  );
}

export function FleetRow({ s, star }: { s: SessionListItem; star?: boolean }) {
  const st = sessionStatus(s);
  const ctx = s.ctxInputTokens ?? 0;
  const window = contextWindowForModel(s.model);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: star ? color.phosphor : color.text, fontWeight: star ? 700 : 400 }}>
        {star ? "★ " : ""}{star ? "mgr " : "w:"}{s.id.slice(0, 8)}
      </span>
      <StatusPill tone={st.tone} label={st.label} glow={st.glow} />
      {s.taskId && <Chip label="task" value={s.taskId.slice(0, 8)} />}
      {s.branch && <Chip label="branch" value={s.branch} tone="cyan" />}
      {ctx > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Meter value={ctx} max={window} tone={ctx > window * CONTEXT_WARN_RATIO ? "amber" : "phosphor"} width={60} />
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{(ctx / 1000).toFixed(1)}k</span>
        </span>
      )}
    </div>
  );
}

// ── Fleet summary (small mode) ─────────────────────────────────────────────────
// A FIXED-SIZE per-project card: a roll-up status, manager/worker counts, a worker-state
// composition bar, worst-case context pressure, and a hint of the busiest manager. Expands to the
// full FleetRow list. Same component kit + tokens as the rest of the page (no new color/chart deps).

// Roll-up status — worst-of across the project's sessions: rate-limited > busy > idle > no-live-mgr.
export function fleetRollup(sessions: SessionListItem[]): { tone: Tone; label: string; glow?: boolean } {
  if (sessions.some(isRateLimited)) return { tone: "red", label: "rate-limited" };
  if (sessions.some((s) => s.processState === "live" && s.busy)) return { tone: "amber", label: "busy", glow: true };
  if (sessions.some((s) => s.role === "manager" && s.processState === "live")) return { tone: "phosphor", label: "idle" };
  return { tone: "muted", label: "no live manager" };
}

// Worker-state tally for the composition bar — each worker lands in exactly one bucket.
export function workerBuckets(workers: SessionListItem[]) {
  let busy = 0, idle = 0, rl = 0, offline = 0;
  for (const w of workers) {
    if (isRateLimited(w)) rl++;
    else if (w.processState !== "live") offline++;
    else if (w.busy) busy++;
    else idle++;
  }
  return { busy, idle, rl, offline, total: workers.length };
}

// Worst-case context occupancy across the fleet (the session closest to its window) — the figure
// that signals "someone needs recycling soon". 0/0 when no session reports ctx.
export function worstContext(sessions: SessionListItem[]): { ctx: number; window: number; ratio: number } {
  let ctx = 0, window = 0, ratio = 0;
  for (const s of sessions) {
    const c = s.ctxInputTokens ?? 0;
    if (c <= 0) continue;
    const w = contextWindowForModel(s.model);
    const r = c / w;
    if (r > ratio) { ratio = r; ctx = c; window = w; }
  }
  return { ctx, window, ratio };
}

const SEG_TONE = { busy: "amber", idle: "phosphor", rl: "red", offline: "muted" } as const;

// Stacked horizontal bar of worker states (flex-weighted by count). Degrades cleanly: 0 workers →
// an empty track; 1 worker → a single full segment.
function CompBar({ buckets }: { buckets: ReturnType<typeof workerBuckets> }) {
  const segs = ([["busy", buckets.busy], ["idle", buckets.idle], ["rl", buckets.rl], ["offline", buckets.offline]] as const)
    .filter(([, n]) => n > 0);
  return (
    <div style={{ display: "flex", height: 8, width: "100%", borderRadius: radius.sm, overflow: "hidden", background: color.border }}>
      {segs.map(([key, n]) => (
        <div key={key} title={`${key} ${n}`} style={{ flexGrow: n, flexBasis: 0, background: tone[SEG_TONE[key]] }} />
      ))}
    </div>
  );
}

export function FleetCard({ name, managers, workers, attention, onExpand }: {
  name: string;
  managers: SessionListItem[]; // activity-sorted by the caller
  workers: SessionListItem[];
  attention: number;
  onExpand: () => void;
}) {
  const sessions = [...managers, ...workers];
  const roll = fleetRollup(sessions);
  const buckets = workerBuckets(workers);
  const wc = worstContext(sessions);
  const ctxHot = wc.ratio > CONTEXT_WARN_RATIO;
  const topMgr = managers[0];
  const topSt = topMgr ? sessionStatus(topMgr) : null;

  return (
    <Panel style={{ height: 188, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
      {/* header: roll-up dot + name + expand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot tone={roll.tone} glow={roll.glow} />
        <span style={{ fontFamily: font.head, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "0 6px" }} title="Expand" onClick={onExpand}>⤢</Button>
      </div>

      {/* status + counts */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusPill tone={roll.tone} label={roll.label} glow={roll.glow} />
        <span style={{ flex: 1 }} />
        <Chip label="mgr" value={managers.length} />
        <Chip label="wkr" value={workers.length} />
        {attention > 0 && <Chip label="attn" value={attention} tone="red" />}
      </div>

      {/* worker-state composition bar + legend */}
      <CompBar buckets={buckets} />
      <div style={{ display: "flex", gap: 10, fontFamily: font.mono, fontSize: 10 }}>
        <span style={{ color: color.amber }}>busy {buckets.busy}</span>
        <span style={{ color: color.phosphor }}>idle {buckets.idle}</span>
        {buckets.rl > 0 && <span style={{ color: color.red }}>rl {buckets.rl}</span>}
        {buckets.offline > 0 && <span style={{ color: color.textMuted }}>off {buckets.offline}</span>}
        {buckets.total === 0 && <span style={{ color: color.textMuted }}>no workers</span>}
      </div>

      {/* worst-case context pressure */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, width: 28 }}>ctx</span>
        <Meter value={wc.ctx} max={wc.window || 1} tone={ctxHot ? "amber" : "phosphor"} width={110} />
        <span style={{ fontFamily: font.mono, fontSize: 10, color: ctxHot ? color.amber : color.textMuted }}>
          {wc.ctx > 0 ? `${Math.round(wc.ratio * 100)}%` : "—"}
        </span>
      </div>

      {/* busiest / most-recent manager hint */}
      <div style={{ marginTop: "auto", fontFamily: font.mono, fontSize: 11, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {topMgr && topSt
          ? <>★ mgr {topMgr.id.slice(0, 8)} · <span style={{ color: tone[topSt.tone] }}>{topSt.label}</span></>
          : <span style={{ color: color.textMuted }}>no live manager</span>}
      </div>
    </Panel>
  );
}

export function EventRow({ e }: { e: OrchestrationEvent }) {
  return (
    <div style={{ display: "flex", gap: 8, fontFamily: font.mono, fontSize: 12, padding: "2px 0", borderBottom: `1px solid ${color.border}` }}>
      <span style={{ color: color.textMuted, whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</span>
      <span style={{ color: color.cyan, whiteSpace: "nowrap" }}>{e.kind}</span>
      <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)}` : ""}{e.taskId ? ` t:${e.taskId.slice(0, 8)}` : ""}
      </span>
    </div>
  );
}
