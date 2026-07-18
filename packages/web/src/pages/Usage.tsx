import { useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SessionListItem, UsageHistory, UsageHistoryTotals, UsageHistoryAgent, UsageHistoryProject, SessionUsageHistory, SessionUsageTotals, SessionUsageAgent, SessionUsageProject, SessionUsageDay, SessionUsageSession } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { isRateLimited } from "../lib/attention";
import { Panel, SectionLabel, StatusPill, Badge, Chip, Meter, Select } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// USAGE — a god-eye page split into THREE deliberately separate, distinctly-labeled planes:
//
//  1. INTERACTIVE SESSIONS ("est. consumption · over time"): the OWNER'S OWN interactive-session usage
//     over time, from GET /api/usage/sessions/history — a real per-day/-project/-agent time series sampled
//     token-free from the transcripts the engine already writes (epic c9924bcd). Its dollar figure is an
//     ESTIMATE of what the tokens would cost on metered API — plan consumption, not a separate bill. This
//     is where the real cumulative numbers live, so it leads the page.
//
//  2. LIVE OCCUPANCY ("live · now"): every live session's CONTEXT occupancy. Sessions already report
//     `ctxInputTokens` (the measured size of the engine's CURRENT context, i.e. last-assistant input
//     usage) + `model`; we size each meter with the shared contextWindowForModel and colour it at
//     CONTEXT_WARN_RATIO, exactly as Mission Control's fleet rows do. Pure view over /api/sessions.
//
//  3. AGENT RUNS (historical): token/cost totals aggregated from the `runs` table — the API RUNS plane
//     (distinct from interactive sessions), via GET /api/usage/history.
//
// HONESTY NOTE (load-bearing): the three planes measure DIFFERENT things and must NEVER be summed.
//   • INTERACTIVE "cost" is CUMULATIVE ESTIMATED interactive-session consumption (what the tokens would
//     cost on metered API), summed from per-interval deltas — plan usage, not a metered bill.
//   • LIVE "ctx in use" is the CURRENT context SIZE (an occupancy snapshot, can exceed 100%, UNBILLED);
//     its dollar figure is an ESTIMATE of ONE input pass at list rates — never cumulative spend.
//   • AGENT-RUNS "cost" is CUMULATIVE BILLED spend recorded per finished Agent Run (the runs plane).
// They live in separate sections with their own labels + tag tones; the page never sums one into another.
//
// SCOPE CONTROLS (page-local, NOT coupled to the header active project — this page stays god-eye):
//   • Project filters ALL THREE sections.
//   • Window (24h / 7d / 30d / All) governs the two HISTORICAL sections (Interactive sessions + Agent
//     Runs); live occupancy is always "now".

// Hand-maintained input-token list prices (USD per million input tokens), matched by model id.
// These are Anthropic's published STANDARD-context input rates as a coarse reference — NOT a billing
// source, and NOT the premium >200k long-context tier. Used ONLY to put an *estimated* dollar figure
// on the current context size (one input pass), so the operator can eyeball relative cost.
const INPUT_USD_PER_MTOK: { match: RegExp; usd: number }[] = [
  { match: /opus/i, usd: 15 },
  { match: /sonnet/i, usd: 3 },
  { match: /haiku/i, usd: 1 },
];
function inputRateForModel(model?: string | null): number | null {
  if (!model) return null;
  for (const { match, usd } of INPUT_USD_PER_MTOK) if (match.test(model)) return usd;
  return null;
}
// Estimated USD to send the CURRENT context once at the model's input rate. null = unknown model.
function estContextCost(ctx: number, model?: string | null): number | null {
  const rate = inputRateForModel(model);
  return rate == null ? null : (ctx / 1_000_000) * rate;
}

function occupancy(s: SessionListItem): number {
  const ctx = s.ctxInputTokens ?? 0;
  const win = contextWindowForModel(s.model);
  return win > 0 ? ctx / win : 0;
}
function occupancyTone(s: SessionListItem): Tone {
  if (isRateLimited(s)) return "red";
  return occupancy(s) > CONTEXT_WARN_RATIO ? "amber" : "phosphor";
}

// "claude-opus-4-8[1m]" → "opus-4-8[1m]" — drop the vendor prefix, keep the meaningful tail.
function shortModel(model?: string | null): string {
  if (!model) return "—";
  return model.replace(/^claude-/i, "");
}
function fmtTokens(n: number): string {
  // Interactive cache-read totals reach the billions over a wide window — keep the readout legible with a
  // B tier above M/k rather than printing "6020.4M".
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `<$0.01`;
  // Thousands separators — estimated interactive totals run to the thousands ($6,020.00 reads far better
  // than $6020.00).
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// Prompt-cache hit ratio (cacheRead / (cacheRead + cacheCreation + input)) — the fixed-prefix cache-health
// tripwire. null = no usage in the row to divide by (never rendered as a misleading "0%").
function fmtRatio(r: number | null): string {
  return r == null ? "—" : `${Math.round(r * 100)}%`;
}
// Warm (read-dominated, byte-stable prefix) reads phosphor-green; a collapsing ratio (broken prefix,
// re-paying the whole prefix every turn) escalates amber then red; unmeasured stays muted.
function ratioTone(r: number | null): Tone {
  if (r == null) return "muted";
  if (r >= 0.8) return "phosphor";
  if (r >= 0.4) return "amber";
  return "red";
}

// ── Historical window controls ─────────────────────────────────────────────────
type Timespan = "24h" | "7d" | "30d" | "all";
const TIMESPANS: { key: Timespan; label: string; window: string }[] = [
  { key: "24h", label: "Last 24 hours", window: "past 24 hours" },
  { key: "7d", label: "Last 7 days", window: "past 7 days" },
  { key: "30d", label: "Last 30 days", window: "past 30 days" },
  { key: "all", label: "All time", window: "all time" },
];
const SPAN_MS: Record<Exclude<Timespan, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
// The window cutoff to request. "All" sends the epoch — the server floors it at 1 year ago, so this is
// "everything Loom still retains" without the client guessing the retention bound.
function sinceIsoFor(span: Timespan): string {
  if (span === "all") return new Date(0).toISOString();
  return new Date(Date.now() - SPAN_MS[span]).toISOString();
}
// Total throughput across a run-usage row: every billed token class summed.
function totalTokens(t: UsageHistoryTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}
// Same sum for an interactive-session usage row (totals / per-day / per-project / per-agent all share the
// SessionUsageTotals token fields).
function sessionTotalTokens(t: SessionUsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}

export default function Usage() {
  const { projects } = useActiveProject();
  // Page-local scope (NOT the header active project): "all" or a projectId. Filters BOTH sections.
  const [scope, setScope] = useState<string>("all");
  // Window: governs the historical section ONLY.
  const [span, setSpan] = useState<Timespan>("7d");

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 2000 });
  const allSessions = sessions.data ?? [];
  const all = scope === "all" ? allSessions : allSessions.filter((s) => s.projectId === scope);

  const spanMeta = TIMESPANS.find((t) => t.key === span)!;
  const history = useQuery({
    queryKey: ["usageHistory", span, scope],
    queryFn: () => api.usageHistory(sinceIsoFor(span), scope),
    refetchInterval: 10000,
  });
  // The owner's interactive-session usage (estimated plan consumption) over the same window + scope (the headline new plane).
  const sessionHistory = useQuery({
    queryKey: ["sessionUsageHistory", span, scope],
    queryFn: () => api.sessionUsageHistory(sinceIsoFor(span), scope),
    refetchInterval: 30000,
  });

  // Overall LIVE aggregates over the scoped sessions. totalCtx is summed context-in-use (not cumulative
  // spend); totalCost is the sum of each session's estimated one-pass input cost — a relative gauge.
  const totalCtx = all.reduce((sum, s) => sum + (s.ctxInputTokens ?? 0), 0);
  const totalCost = all.reduce((sum, s) => sum + (estContextCost(s.ctxInputTokens ?? 0, s.model) ?? 0), 0);
  const rateLimited = all.filter(isRateLimited);

  // Highest-occupancy sessions surfaced first — the ones closest to a compaction / context wall.
  const topOccupancy = [...all]
    .filter((s) => (s.ctxInputTokens ?? 0) > 0)
    .sort((a, b) => occupancy(b) - occupancy(a))
    .slice(0, 5);

  // Group by project, ranked by freshest member (consistent with Mission Control's fleet ordering).
  const byProject = new Map<string, SessionListItem[]>();
  for (const s of all)
    (byProject.get(s.projectName) ?? byProject.set(s.projectName, []).get(s.projectName)!).push(s);
  const projectNames = [...byProject.keys()]
    .sort((a, b) => mostRecentActivity(byProject.get(b)!) - mostRecentActivity(byProject.get(a)!));

  const scopeName = scope === "all" ? "all projects" : (projects.find((p) => p.id === scope)?.name ?? "project");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Scope controls (page-local) ───────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <Field label="Project">
          <Select value={scope} onChange={(e) => setScope(e.target.value)} style={{ minWidth: 180 }}>
            <option value="all">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Window">
          <Select value={span} onChange={(e) => setSpan(e.target.value as Timespan)} style={{ minWidth: 150 }}>
            {TIMESPANS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
        </Field>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, maxWidth: 340, lineHeight: 1.5, textAlign: "right" }}>
          Project filters all three sections. Window governs the two historical sections (Interactive
          sessions &amp; Agent&nbsp;Runs) — live occupancy is always now.
        </span>
      </div>

      {/* ════ INTERACTIVE SESSIONS (historical · est. consumption) ════ — the headline new plane, placed first. */}
      <SessionUsageSection
        query={sessionHistory}
        scope={scope}
        scopeName={scopeName}
        window={spanMeta.window}
        allTime={span === "all"}
      />

      {/* ════ LIVE OCCUPANCY ════ */}
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionHead title="Live occupancy" tag="live · now" tagTone="phosphor" />

        {/* Aggregate strip */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Stat label="sessions" value={String(all.length)} />
          <Stat label="ctx in use" value={fmtTokens(totalCtx)} tone="cyan" />
          <Stat label="est. ctx cost" value={fmtUsd(totalCost)} tone="phosphor" />
          <Stat label="rate-limited" value={String(rateLimited.length)} tone={rateLimited.length ? "red" : "muted"} />
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, maxWidth: 340, lineHeight: 1.5, textAlign: "right" }}>
            "ctx in use" = current context size, not cumulative spend. Cost is an estimate of one input
            pass at list rates — relative gauge only.
          </span>
        </div>

        {sessions.isLoading && <Panel><span style={{ color: color.textMuted }}>Loading sessions…</span></Panel>}
        {!sessions.isLoading && all.length === 0 && (
          <Panel><span style={{ color: color.textMuted }}>No live sessions {scope === "all" ? "" : `in ${scopeName}`}.</span></Panel>
        )}

        {/* Highest occupancy */}
        {topOccupancy.length > 0 && (
          <div>
            <SectionLabel>Highest occupancy</SectionLabel>
            <Panel>
              {topOccupancy.map((s) => <UsageRow key={s.id} s={s} showProject />)}
            </Panel>
          </div>
        )}

        {/* Per-project breakdown */}
        {projectNames.length > 0 && (
          <div>
            <SectionLabel>By project</SectionLabel>
            {projectNames.map((pn) => {
              const rows = byProject.get(pn)!.slice().sort(bySessionActivity);
              const projCtx = rows.reduce((sum, s) => sum + (s.ctxInputTokens ?? 0), 0);
              const projCost = rows.reduce((sum, s) => sum + (estContextCost(s.ctxInputTokens ?? 0, s.model) ?? 0), 0);
              const projLimited = rows.filter(isRateLimited).length;
              return (
                <Panel key={pn} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{pn}</span>
                    <Chip label="ctx" value={fmtTokens(projCtx)} tone="cyan" />
                    <Chip label="est." value={fmtUsd(projCost)} />
                    {projLimited > 0 && <Badge tone="red">{projLimited} rate-limited</Badge>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{rows.length} session{rows.length === 1 ? "" : "s"}</span>
                  </div>
                  {rows.map((s) => <UsageRow key={s.id} s={s} />)}
                </Panel>
              );
            })}
          </div>
        )}
      </section>

      {/* ════ AGENT RUNS (historical) ════ */}
      <HistorySection
        query={history}
        scope={scope}
        scopeName={scopeName}
        window={spanMeta.window}
      />
    </div>
  );
}

// ── Live-occupancy row (unchanged behaviour) ─────────────────────────────────────
function UsageRow({ s, showProject }: { s: SessionListItem; showProject?: boolean }) {
  const ctx = s.ctxInputTokens ?? 0;
  const win = contextWindowForModel(s.model);
  // Unknown models fall back to the 200k default window, so a session on a larger real window can
  // measure >100% (seen up to 456%). Clamp the readout to 100% to match the already-clamped Meter bar,
  // and flag the overflow with a trailing "+" rather than printing a bug-looking 456%.
  const rawPct = Math.round(occupancy(s) * 100);
  const pct = Math.min(100, rawPct);
  const t = occupancyTone(s);
  const cost = estContextCost(ctx, s.model);
  const limited = isRateLimited(s);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.border}` }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text, minWidth: 132 }}>
        <span style={{ color: s.role === "manager" ? color.phosphor : color.textDim }}>{s.role === "manager" ? "★ " : ""}{s.role ?? "session"}</span>{" "}
        <span style={{ color: color.textMuted }}>{s.id.slice(0, 8)}</span>
      </span>
      {showProject && <Chip value={s.projectName} tone="cyan" />}
      <Chip label="model" value={shortModel(s.model)} />
      <StatusPill tone={s.processState === "live" ? "phosphor" : "muted"} label={s.processState} />
      {limited && <Badge tone="red">rate-limited</Badge>}
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, minWidth: 96, textAlign: "right" }}>
          {fmtTokens(ctx)} / {fmtTokens(win)}
        </span>
        <Meter value={ctx} max={win} tone={t} width={90} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[t], minWidth: 36, textAlign: "right" }}>{pct}%{rawPct > 100 ? "+" : ""}</span>
        {cost != null && <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, minWidth: 52, textAlign: "right" }}>{fmtUsd(cost)} est.</span>}
      </span>
    </div>
  );
}

// ── Historical (Agent Runs) section ──────────────────────────────────────────────
function HistorySection({
  query, scope, scopeName, window,
}: {
  query: UseQueryResult<UsageHistory>;
  scope: string;
  scopeName: string;
  window: string;
}) {
  const [agentSort, setAgentSort] = useState<"tokens" | "cost">("cost");
  const data = query.data;
  const totals = data?.totals;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionHead title="Agent Runs" tag={window} tagTone="cyan" />
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, lineHeight: 1.5, marginTop: -8 }}>
        Cumulative BILLED token + cost totals from finished Agent Runs — not the live occupancy above, and
        not interactive-session usage. Cost meters relative spend; runs whose model had no recorded price
        count $0.
      </span>

      {query.isLoading && <Panel><span style={{ color: color.textMuted }}>Loading run history…</span></Panel>}
      {query.isError && (
        <Panel><span style={{ color: color.red, fontFamily: font.mono, fontSize: 12 }}>Couldn't load run history: {(query.error as Error)?.message ?? "unknown error"}</span></Panel>
      )}

      {!query.isLoading && !query.isError && totals && (
        totals.runs === 0 ? (
          <Panel style={{ padding: 20 }}>
            <div style={{ fontFamily: font.head, fontSize: 13, color: color.textDim, marginBottom: 6 }}>
              No agent runs in this window
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, lineHeight: 1.6, maxWidth: 560 }}>
              No Agent Runs recorded for {scopeName} in this window ({window}). Interactive Claude Code
              sessions aren't tracked here — only API-style Agent Runs persist usage history. Try a wider
              window, or this stays empty until a run completes.
            </div>
          </Panel>
        ) : (
          <>
            {/* Aggregate strip — distinctly BILLED, never summed with live occupancy. */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <Stat label="runs" value={String(totals.runs)} tone="phosphor" />
              <Stat label="input tok" value={fmtTokens(totals.inputTokens)} tone="cyan" />
              <Stat label="output tok" value={fmtTokens(totals.outputTokens)} tone="cyan" />
              <Stat label="cache tok" value={fmtTokens(totals.cacheCreationTokens + totals.cacheReadTokens)} tone="muted" />
              <Stat label="cost (billed)" value={fmtUsd(totals.costUsd)} tone="amber" />
            </div>

            {/* Per-project breakdown — only meaningful in the "all" scope. */}
            {scope === "all" && data!.byProject.length > 0 && (() => {
              const max = Math.max(...data!.byProject.map(totalTokens), 1);
              return (
                <div>
                  <SectionLabel>By project</SectionLabel>
                  <Panel>
                    {[...data!.byProject]
                      .sort((a, b) => b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a))
                      .map((p) => (
                        <HistoryRow key={p.projectId} name={p.projectName ?? p.projectId.slice(0, 8)} row={p} max={max} />
                      ))}
                  </Panel>
                </div>
              );
            })()}

            {/* Per-agent breakdown — sortable by tokens / cost. */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <SectionLabel style={{ margin: 0 }}>By agent</SectionLabel>
                <span style={{ flex: 1 }} />
                <SortToggle value={agentSort} onChange={setAgentSort} />
              </div>
              <Panel>
                {data!.byAgent.length === 0 && (
                  <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No per-agent rows.</span>
                )}
                {(() => {
                  const max = Math.max(...data!.byAgent.map(totalTokens), 1);
                  return [...data!.byAgent]
                    .sort((a, b) => agentSort === "cost"
                      ? (b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a))
                      : (totalTokens(b) - totalTokens(a) || b.costUsd - a.costUsd))
                    .map((a) => (
                      <HistoryRow key={a.agentId} name={a.agentName ?? a.agentId.slice(0, 8)} subtitle={a.projectName} row={a} max={max} />
                    ));
                })()}
              </Panel>
            </div>
          </>
        )
      )}
    </section>
  );
}

// A breakdown row's leading label: the primary name with an optional secondary subtitle stacked under it
// (the owning project for agent rows — e.g. "Dev" · "Fire Studio"), so identically-named agents across
// projects read unambiguously. With no subtitle it lays out exactly like the old single-line name.
function RowName({ name, subtitle }: { name: string; subtitle?: string | null }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", minWidth: 160, maxWidth: 200, overflow: "hidden" }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {subtitle && (
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</span>
      )}
    </span>
  );
}

// One historical breakdown row (project or agent): name, run count, a token meter relative to the
// section's max, and the billed cost. `subtitle` (the owning project, for agent rows) renders as a small
// secondary label so identically-named agents across projects disambiguate.
function HistoryRow({ name, subtitle, row, max }: { name: string; subtitle?: string | null; row: UsageHistoryProject | UsageHistoryAgent; max?: number }) {
  const tok = totalTokens(row);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.border}` }}>
      <RowName name={name} subtitle={subtitle} />
      <Chip label="runs" value={String(row.runs)} />
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, minWidth: 64, textAlign: "right" }}>{fmtTokens(tok)} tok</span>
        {max != null && <Meter value={tok} max={max} tone="cyan" width={90} />}
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.amber, minWidth: 64, textAlign: "right" }}>{fmtUsd(row.costUsd)}</span>
      </span>
    </div>
  );
}

function SortToggle({ value, onChange }: { value: "tokens" | "cost"; onChange: (v: "tokens" | "cost") => void }) {
  const items: { key: "tokens" | "cost"; label: string }[] = [
    { key: "cost", label: "Cost" },
    { key: "tokens", label: "Tokens" },
  ];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>sort</span>
      <span style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: 4, overflow: "hidden" }}>
        {items.map((it) => {
          const active = value === it.key;
          return (
            <button key={it.key} onClick={() => onChange(it.key)}
              style={{
                background: active ? color.phosphorDim : "transparent",
                color: active ? color.phosphor : color.textDim,
                border: "none", padding: "3px 10px", fontFamily: font.mono, fontSize: 11,
                cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
              {it.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}

// ── Interactive-sessions (historical · est. consumption) section ──────────────────
// The owner's OWN interactive-session usage over the window: totals, an over-time chart from byDay, a
// per-project breakdown (in "all" scope), and a sortable per-agent breakdown. Its dollar figure is an
// ESTIMATE of plan consumption (what the tokens would cost on metered API), NOT a metered bill —
// DISTINCT from live occupancy (a context snapshot) and Agent Runs (the runs plane, genuinely metered);
// the section never sums into either.
function SessionUsageSection({
  query, scope, scopeName, window, allTime,
}: {
  query: UseQueryResult<SessionUsageHistory>;
  scope: string;
  scopeName: string;
  window: string;
  allTime: boolean;
}) {
  const [agentSort, setAgentSort] = useState<"tokens" | "cost">("cost");
  const [chartMetric, setChartMetric] = useState<"cost" | "tokens">("cost");
  const data = query.data;
  const totals = data?.totals;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionHead title="Interactive sessions" tag="est. consumption · over time" tagTone="amber" />
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, lineHeight: 1.5, marginTop: -8 }}>
        Your interactive-session usage over time — cumulative tokens + an ESTIMATE of what they'd cost on
        metered API, sampled token-free from session transcripts. On a flat Claude subscription this is what
        you're consuming, not a separate bill — distinct from the live occupancy snapshot below (current
        context size) and the Agent&nbsp;Runs plane further down; the page never sums across the three.
      </span>

      {query.isLoading && <Panel><span style={{ color: color.textMuted }}>Loading interactive-session usage…</span></Panel>}
      {query.isError && (
        <Panel><span style={{ color: color.red, fontFamily: font.mono, fontSize: 12 }}>Couldn't load interactive-session usage: {(query.error as Error)?.message ?? "unknown error"}</span></Panel>
      )}

      {!query.isLoading && !query.isError && totals && (
        totals.samples === 0 ? (
          <Panel style={{ padding: 20 }}>
            <div style={{ fontFamily: font.head, fontSize: 13, color: color.textDim, marginBottom: 6 }}>
              No interactive-session usage in this window
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, lineHeight: 1.6, maxWidth: 560 }}>
              No interactive-session usage recorded for {scopeName} in this window ({window}). Try a
              wider window, or this fills in as the owner's sessions run and the daemon samples them.
            </div>
          </Panel>
        ) : (
          <>
            {/* Aggregate strip — an ESTIMATE of plan consumption, never summed with the other planes. */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <Stat label="est. consumption" value={fmtUsd(totals.costUsd)} tone="amber" />
              <Stat label="input tok" value={fmtTokens(totals.inputTokens)} tone="cyan" />
              <Stat label="output tok" value={fmtTokens(totals.outputTokens)} tone="cyan" />
              <Stat label="cache tok" value={fmtTokens(totals.cacheCreationTokens + totals.cacheReadTokens)} tone="muted" />
              <Stat label="cache hit" value={fmtRatio(totals.cacheHitRatio)} tone={ratioTone(totals.cacheHitRatio)} />
              <Stat label="samples" value={fmtTokens(totals.samples)} tone="muted" />
            </div>
            <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, lineHeight: 1.5 }}>
              "cache hit" = cache_read / (cache_read + cache_creation + input) across this whole scope/window —
              a warm, byte-stable session startup prefix keeps this near 100%; a broken prefix (re-paying the
              prefix as cache_creation every turn) collapses it toward 0%. Blended across every sampled
              session here — see "By session" below for the per-session read that isolates one fixed prefix.
            </span>

            {/* Over-time chart from byDay — ascending by day, legible up to ~365 buckets. */}
            <ByDayChart byDay={data!.byDay} metric={chartMetric} onMetric={setChartMetric} allTime={allTime} />

            {/* Per-project breakdown — only meaningful in the "all" scope. */}
            {scope === "all" && data!.byProject.length > 0 && (() => {
              const max = Math.max(...data!.byProject.map(sessionTotalTokens), 1);
              return (
                <div>
                  <SectionLabel>By project</SectionLabel>
                  <Panel>
                    {[...data!.byProject]
                      .sort((a, b) => b.costUsd - a.costUsd || sessionTotalTokens(b) - sessionTotalTokens(a))
                      .map((p) => (
                        <SessionHistoryRow key={p.projectId} name={p.projectName ?? p.projectId.slice(0, 8)} row={p} max={max} />
                      ))}
                  </Panel>
                </div>
              );
            })()}

            {/* Per-agent breakdown — sortable by tokens / cost. */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <SectionLabel style={{ margin: 0 }}>By agent</SectionLabel>
                <span style={{ flex: 1 }} />
                <SortToggle value={agentSort} onChange={setAgentSort} />
              </div>
              <Panel>
                {data!.byAgent.length === 0 && (
                  <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No per-agent rows.</span>
                )}
                {(() => {
                  const max = Math.max(...data!.byAgent.map(sessionTotalTokens), 1);
                  return [...data!.byAgent]
                    .sort((a, b) => agentSort === "cost"
                      ? (b.costUsd - a.costUsd || sessionTotalTokens(b) - sessionTotalTokens(a))
                      : (sessionTotalTokens(b) - sessionTotalTokens(a) || b.costUsd - a.costUsd))
                    .map((a) => (
                      <SessionHistoryRow key={a.agentId ?? "—"} name={a.agentName ?? (a.agentId ? a.agentId.slice(0, 8) : "(no agent)")} subtitle={a.projectName} row={a} max={max} />
                    ));
                })()}
              </Panel>
            </div>

            {/* Per-SESSION breakdown — the prompt-cache hit-ratio tripwire (rec#1 follow-up, card 0dd60be4):
                one session = one fixed startup prefix, so ITS ratio (unlike the blended byAgent/byProject
                rows above) is the direct empirical read on whether that prefix stayed byte-stable. Capped
                + ranked by cost server-side; managers — this project's long-running sessions — are marked
                with the same ★ the live-occupancy section uses. */}
            <div>
              <SectionLabel>By session · cache hit ratio</SectionLabel>
              <Panel>
                {data!.bySession.length === 0 && (
                  <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No per-session rows.</span>
                )}
                {data!.bySession.map((s) => <SessionRatioRow key={s.sessionId} row={s} />)}
              </Panel>
            </div>
          </>
        )
      )}
    </section>
  );
}

// One interactive-session breakdown row (project or agent): name, sample count, a token meter relative to
// the section's max, and the estimated cost. `subtitle` (the owning project, for agent rows) renders as a
// small secondary label so identically-named agents across projects disambiguate.
function SessionHistoryRow({ name, subtitle, row, max }: { name: string; subtitle?: string | null; row: SessionUsageProject | SessionUsageAgent; max?: number }) {
  const tok = sessionTotalTokens(row);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.border}` }}>
      <RowName name={name} subtitle={subtitle} />
      <Chip label="samples" value={fmtTokens(row.samples)} />
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, minWidth: 64, textAlign: "right" }}>{fmtTokens(tok)} tok</span>
        {max != null && <Meter value={tok} max={max} tone="cyan" width={90} />}
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.amber, minWidth: 72, textAlign: "right" }}>{fmtUsd(row.costUsd)}</span>
      </span>
    </div>
  );
}

// One per-session breakdown row — the cache-hit-ratio tripwire's actual unit of measure. Marks a manager
// session with the same ★ the live-occupancy section uses (role-derived, not a guess), shows sample/token
// volume for context, and renders cacheHitRatio as a color-coded percentage (warm→phosphor, degrading→
// amber→red, unmeasured→muted "—").
function SessionRatioRow({ row }: { row: SessionUsageSession }) {
  const tok = sessionTotalTokens(row);
  const isManager = row.role === "manager";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.border}` }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, minWidth: 160, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ color: isManager ? color.phosphor : color.textDim }}>{isManager ? "★ " : ""}{row.role ?? "session"}</span>{" "}
        <span style={{ color: color.textMuted }}>{row.sessionId.slice(0, 8)}</span>
      </span>
      <RowName name={row.agentName ?? "(no agent)"} subtitle={row.projectName} />
      <Chip label="samples" value={fmtTokens(row.samples)} />
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, minWidth: 64, textAlign: "right" }}>{fmtTokens(tok)} tok</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: tone[ratioTone(row.cacheHitRatio)], minWidth: 44, textAlign: "right", fontWeight: 700 }}>
          {fmtRatio(row.cacheHitRatio)}
        </span>
      </span>
    </div>
  );
}

// Over-time bar chart for the interactive-session series. Bars ascend by day and fill the width, so a
// 7-day window reads as a few wide bars and the 365-bucket "all time" window as a dense sparkline-of-bars;
// each bar's height scales to the window's peak. The metric toggle switches between estimated cost and
// total tokens. A non-zero day always paints at least a hairline so sparse early days stay visible.
function ByDayChart({
  byDay, metric, onMetric, allTime,
}: {
  byDay: SessionUsageDay[];
  metric: "cost" | "tokens";
  onMetric: (m: "cost" | "tokens") => void;
  allTime: boolean;
}) {
  const valueOf = (d: SessionUsageDay) => (metric === "cost" ? d.costUsd : sessionTotalTokens(d));
  const fmtVal = (v: number) => (metric === "cost" ? fmtUsd(v) : `${fmtTokens(v)} tok`);
  const vals = byDay.map(valueOf);
  const peak = Math.max(...vals, 0);
  const dense = byDay.length > 60;
  const first = byDay[0]?.day;
  const last = byDay[byDay.length - 1]?.day;
  const tColor = metric === "cost" ? color.amber : color.cyan;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <SectionLabel style={{ margin: 0 }}>By day</SectionLabel>
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
          {byDay.length} day{byDay.length === 1 ? "" : "s"} · peak {fmtVal(peak)}
        </span>
        <span style={{ flex: 1 }} />
        <MetricToggle value={metric} onChange={onMetric} />
      </div>
      <Panel>
        <div
          role="img"
          aria-label={`Interactive-session ${metric === "cost" ? "estimated cost" : "total tokens"} per day, ${byDay.length} days, peak ${fmtVal(peak)}`}
          style={{ display: "flex", alignItems: "flex-end", gap: dense ? 1 : 3, height: 88, borderBottom: `1px solid ${color.border}`, paddingBottom: 1 }}
        >
          {byDay.map((d) => {
            const v = valueOf(d);
            const h = peak > 0 && v > 0 ? Math.max(2, Math.round((v / peak) * 86)) : v > 0 ? 2 : 0;
            return (
              <div
                key={d.day}
                title={`${d.day} · ${fmtVal(v)}`}
                style={{
                  flex: 1, minWidth: 1, height: Math.max(h, 1),
                  background: v > 0 ? tColor : color.border,
                  opacity: v > 0 ? 1 : 0.4, borderRadius: 1,
                }}
              />
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
          <span>{first ?? ""}</span>
          <span>{first && last && first !== last ? last : ""}</span>
        </div>
        {allTime && (
          <div style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, lineHeight: 1.5, marginTop: 8 }}>
            Early points are coarse — one backfilled sample per session at its last activity — and get finer
            going forward as the daemon samples live sessions on an interval.
          </div>
        )}
      </Panel>
    </div>
  );
}

// Cost / Tokens toggle for the by-day chart — same shape as SortToggle, but it picks the charted measure.
function MetricToggle({ value, onChange }: { value: "cost" | "tokens"; onChange: (v: "cost" | "tokens") => void }) {
  const items: { key: "cost" | "tokens"; label: string }[] = [
    { key: "cost", label: "Cost" },
    { key: "tokens", label: "Tokens" },
  ];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>chart</span>
      <span style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: 4, overflow: "hidden" }}>
        {items.map((it) => {
          const active = value === it.key;
          return (
            <button key={it.key} onClick={() => onChange(it.key)}
              style={{
                background: active ? color.phosphorDim : "transparent",
                color: active ? color.phosphor : color.textDim,
                border: "none", padding: "3px 10px", fontFamily: font.mono, fontSize: 11,
                cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
              {it.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────────
// Section header with a right-aligned tag pill so the live vs historical distinction reads at a glance.
function SectionHead({ title, tag, tagTone }: { title: string; tag: string; tagTone: Tone }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${color.border}`, paddingBottom: 6 }}>
      <span style={{ fontFamily: font.head, fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.text }}>{title}</span>
      <Badge tone={tagTone}>{tag}</Badge>
    </div>
  );
}

// A labelled form control (label above the field), for the scope-control bar.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value, tone: t = "phosphor" }: { label: string; value: string; tone?: Tone }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", border: `1px solid ${color.border}`, borderRadius: 4, padding: "4px 12px", minWidth: 72 }}>
      <span style={{ fontFamily: font.mono, fontSize: 20, color: tone[t] }}>{value}</span>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>{label}</span>
    </span>
  );
}
