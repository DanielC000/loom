import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent, UsageLimitsStatus, UsageWindow } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { isRateLimited, usePendingDecisionsBySession, type AttentionItem, type PendingDecision } from "../lib/attention";
import { fleetRollup, workerBuckets, capArchived } from "../lib/fleet";
import { DecisionStateChip } from "./decisions";
import { useOpenRequest } from "./requests";
import { Panel, StatusPill, Chip, Meter, Button, Dot } from "./ui";
import { color, font, radius, tone, type Tone } from "../theme";

// The pure roll-up math lives in lib/fleet.ts (JSX-free, so the hermetic node test can import it); the
// widgets re-export it so existing consumers (Overview) keep importing from the components/fleet barrel.
export { fleetRollup, workerBuckets };

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

export function AttentionRow({ item, onOpen, onDismiss }: { item: AttentionItem; onOpen?: () => void; onDismiss?: () => void }) {
  // A pending Request of ANY type (live or orphaned) reads as an answerable ask: a cyan left-edge, a
  // PENDING state chip, and an "Answer →" (not the generic "Open") — distinct from the phosphor MERGE
  // REQUEST and the red/amber alerts. Orphaned still routes to the same answer page (its own amber
  // tone/text already flags the asker is gone), just via item.tone rather than a hardcoded second border
  // color. `questionId` (not a literal kind string) is the structural marker — the kind LABEL now varies
  // by request type (DECISION/SECRET/PERMISSION/INPUT NEEDED), so it can no longer be compared literally.
  const decision = item.questionId != null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${color.border}`,
      borderLeft: decision ? `3px solid ${color.cyan}` : `1px solid ${color.border}`, borderRadius: 4, padding: "6px 10px", marginBottom: 6 }}>
      <Dot tone={item.tone} glow={item.tone === "amber"} />
      <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[item.tone], textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{item.kind}</span>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
      <span style={{ flex: 1 }} />
      {decision && <DecisionStateChip q={{ state: "pending", answeredAt: null }} now={0} />}
      {item.rateLimitSessionId && <ClearRateLimitButton sessionId={item.rateLimitSessionId} />}
      {onOpen && <Button variant={decision ? "primary" : "default"} onClick={onOpen}>{decision ? "Answer →" : "Open"}</Button>}
      {/* Dismiss — STUCK-BUSY only (passed when item.dismissKey is set). The heuristic false-positives
          on a legitimately long turn; this hides THIS episode (re-appears on the next one). */}
      {onDismiss && (
        <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss this alert"
          title="Dismiss — hides this stuck-busy alert until the session acts again"
          style={{ padding: "0 6px", fontSize: 15, lineHeight: 1 }}>×</Button>
      )}
    </div>
  );
}

// Per-session "clear / retry now" for a RATE-LIMITED attention item — mirrors the global Clear-usage-
// hold button but scoped to one session: POST /api/sessions/:id/rate-limit/clear ends the park, drops
// the global latch, and re-submits the held turn. HUMAN-only REST (no agent MCP surface). On success
// we invalidate the session poll so the cleared row drops out of the queue promptly.
function ClearRateLimitButton({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api.clearSessionRateLimit(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
    onError: (e) => window.alert((e as Error).message),
  });
  return (
    <Button variant="default" disabled={clear.isPending}
      title="Clear this session's rate-limit park and re-submit its held turn now"
      onClick={() => clear.mutate()}>
      {clear.isPending ? "Clearing…" : "Clear / retry"}
    </Button>
  );
}

export function FleetRow({ s, star }: { s: SessionListItem; star?: boolean }) {
  const openRequest = useOpenRequest();
  const decisions = usePendingDecisionsBySession();
  const decision = decisions.get(s.id);
  const st = sessionStatus(s);
  const ctx = s.ctxInputTokens ?? 0;
  const window = contextWindowForModel(s.model);
  const hot = ctx > window * CONTEXT_WARN_RATIO;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: star ? color.phosphor : color.text, fontWeight: star ? 700 : 400 }}>
        {star ? "★ " : ""}{star ? "mgr " : "w:"}{s.id.slice(0, 8)}
      </span>
      <StatusPill tone={st.tone} label={st.label} glow={st.glow} />
      {/* Decision affordance (surface 5): a manager holding a pending decision flags it inline + jumps
          straight to the answer page — derived from the SAME pending-decision signal as the inbox + bell. */}
      {decision && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: font.mono, fontSize: 11, color: color.cyan,
            border: `1px solid ${color.cyan}`, borderRadius: radius.sm, padding: "1px 7px" }}>
            <Dot tone="cyan" />{decision.count} decision{decision.count === 1 ? "" : "s"} · waiting on you
          </span>
          <Button variant="primary" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => openRequest(decision.questionId)}>Answer →</Button>
        </span>
      )}
      {s.taskId && <Chip label="task" value={s.taskId.slice(0, 8)} />}
      {s.branch && <Chip label="branch" value={s.branch} tone="cyan" />}
      {ctx > 0 && (
        // Context consumption: occupancy of the model's window. Loom drives the subscription CLI, so this
        // is token CONSUMPTION (% of context window), never a dollar bill — the figure that signals
        // "this agent needs recycling soon", with the absolute token count for scale.
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={`${ctx.toLocaleString()} input tokens · ${Math.round((ctx / window) * 100)}% of the ${(window / 1000).toFixed(0)}k window`}>
          <Meter value={ctx} max={window} tone={hot ? "amber" : "phosphor"} width={60} />
          <span style={{ fontFamily: font.mono, fontSize: 11, color: hot ? color.amber : color.textMuted }}>{Math.round((ctx / window) * 100)}%</span>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{(ctx / 1000).toFixed(1)}k</span>
        </span>
      )}
    </div>
  );
}

// Wave/fleet CONSUMPTION roll-up — total context tokens across a session set + the worst-case occupancy.
// Framed as usage/consumption (tokens, % of window), deliberately NOT a $ API bill: Loom runs the
// subscription CLI, so there is no per-call dollar cost — the honest signal is how much context the wave
// is burning and who is closest to overflow. Rendered inline in the expanded fleet panel header.
export function totalContext(sessions: SessionListItem[]): { tokens: number; reporting: number } {
  let tokens = 0, reporting = 0;
  for (const s of sessions) {
    const c = s.ctxInputTokens ?? 0;
    if (c > 0) { tokens += c; reporting++; }
  }
  return { tokens, reporting };
}

export function WaveConsumption({ sessions }: { sessions: SessionListItem[] }) {
  const total = totalContext(sessions);
  const wc = worstContext(sessions);
  const hot = wc.ratio > CONTEXT_WARN_RATIO;
  if (total.reporting === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 11 }}
      title={`${total.tokens.toLocaleString()} input tokens in context across ${total.reporting} reporting session${total.reporting === 1 ? "" : "s"} (subscription usage, not an API $ bill)`}>
      <span style={{ color: color.textMuted }}>consumption</span>
      <span style={{ color: color.text }}>{(total.tokens / 1000).toFixed(0)}k ctx</span>
      <span style={{ color: color.textMuted }}>·</span>
      <span style={{ color: color.textMuted }}>peak</span>
      <Meter value={wc.ctx} max={wc.window || 1} tone={hot ? "amber" : "phosphor"} width={70} />
      <span style={{ color: hot ? color.amber : color.textMuted }}>{wc.ctx > 0 ? `${Math.round(wc.ratio * 100)}%` : "—"}</span>
    </span>
  );
}

// ── Fleet summary (small mode) ─────────────────────────────────────────────────
// A FIXED-SIZE per-project card: a roll-up status, manager/worker counts, a worker-state
// composition bar, worst-case context pressure, and a hint of the busiest manager. Expands to the
// full FleetRow list. Same component kit + tokens as the rest of the page (no new color/chart deps).
// (fleetRollup + workerBuckets live in lib/fleet.ts — imported + re-exported above.)

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

export function FleetCard({ name, managers, workers, archived = [], attention, onExpand, muted }: {
  name: string;
  managers: SessionListItem[]; // activity-sorted by the caller
  workers: SessionListItem[];
  // The project's ARCHIVED (exited) sessions — ArchivedSessionListItem extends SessionListItem, so they
  // drop in as-is. Folded in (capped) as muted history so the card doesn't go blank right after a wave
  // auto-archives. Optional + defaulted, so every existing call site stays byte-identical when omitted.
  archived?: SessionListItem[];
  attention: number;
  onExpand: () => void;
  // A fully-archived project (zero live sessions) — de-emphasize the whole card so finished waves stay
  // glanceable without crowding the active fleet. A restrained lower-contrast treatment (opacity), not a
  // new visual language. Optional + defaulted-off, so live cards stay byte-identical.
  muted?: boolean;
}) {
  const openRequest = useOpenRequest();
  const decisions = usePendingDecisionsBySession();
  const running = [...managers, ...workers];
  // A manager on this card holding a pending decision → the cyan card affordance (surface 5). Pick the
  // first such manager (activity-sorted by the caller) as the "Answer →" jump target.
  const mgrWithDecision = managers.find((m) => decisions.has(m.id));
  const decision: PendingDecision | undefined = mgrWithDecision ? decisions.get(mgrWithDecision.id) : undefined;
  // Cap the archived rows folded into the card's buckets so a big archive can't dominate the composition
  // bar; the header below still reports the TRUE archived total. Archived rows are exited → offline bucket.
  const foldedArchived = capArchived(archived);
  const archivedWorkers = foldedArchived.filter((s) => s.role !== "manager");
  const roll = fleetRollup(running); // severity from live state only (see lib/fleet.ts)
  const buckets = workerBuckets([...workers, ...archivedWorkers]);
  const wc = worstContext(running); // ctx pressure is a live recycle signal — finished sessions excluded
  const ctxHot = wc.ratio > CONTEXT_WARN_RATIO;
  const topMgr = mgrWithDecision ?? managers[0];
  const topSt = topMgr ? sessionStatus(topMgr) : null;

  return (
    <Panel style={{ height: 206, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden",
      ...(decision ? { borderLeft: `3px solid ${color.cyan}` } : null), ...(muted ? { opacity: 0.6 } : null) }}>
      {/* header: roll-up dot + name + expand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot tone={roll.tone} glow={roll.glow} />
        <span style={{ fontFamily: font.head, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "0 6px" }} title="Expand" onClick={onExpand}>⤢</Button>
      </div>

      {/* running / archived split — the "both-in-one" summary. Archived reads as clearly secondary. */}
      <div style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, whiteSpace: "nowrap" }}>
        running {running.length}
        {archived.length > 0 && <span style={{ color: color.textDim }}> · archived {archived.length}</span>}
      </div>

      {/* status + counts */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusPill tone={roll.tone} label={roll.label} glow={roll.glow} />
        <span style={{ flex: 1 }} />
        {decision && <Chip label="decision" value={decision.count} tone="cyan" />}
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

      {/* busiest / most-recent manager hint — a held decision takes over the footer with an Answer → jump */}
      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, fontFamily: font.mono, fontSize: 11, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {topMgr && topSt
            ? <>★ mgr {topMgr.id.slice(0, 8)} · <span style={{ color: decision ? color.cyan : tone[topSt.tone] }}>{decision ? "waiting on you" : topSt.label}</span></>
            : <span style={{ color: color.textMuted }}>no live manager</span>}
        </div>
        {decision && (
          <Button variant="primary" style={{ padding: "1px 8px", fontSize: 11, flexShrink: 0 }}
            onClick={() => openRequest(decision.questionId)}>Answer →</Button>
        )}
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
