import { useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SessionListItem, UsageHistory, UsageHistoryTotals, UsageHistoryAgent, UsageHistoryProject } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { isRateLimited } from "../lib/attention";
import { Panel, SectionLabel, StatusPill, Badge, Chip, Meter, Select } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// USAGE — a god-eye page split into TWO deliberately separate, distinctly-labeled views:
//
//  1. LIVE OCCUPANCY ("live · now"): every live session's CONTEXT occupancy. Sessions already report
//     `ctxInputTokens` (the measured size of the engine's CURRENT context, i.e. last-assistant input
//     usage) + `model`; we size each meter with the shared contextWindowForModel and colour it at
//     CONTEXT_WARN_RATIO, exactly as Mission Control's fleet rows do. Pure view over /api/sessions.
//
//  2. AGENT RUNS (historical): token/cost totals aggregated from the `runs` table — Loom's ONLY
//     persisted time-series usage (interactive sessions keep no history), via GET /api/usage/history.
//
// HONESTY NOTE (load-bearing): the two views measure DIFFERENT things and must never be conflated.
//   • LIVE "ctx in use" is the CURRENT context SIZE (an occupancy snapshot, can exceed 100%, UNBILLED);
//     its dollar figure is an ESTIMATE of ONE input pass at list rates — never cumulative spend.
//   • HISTORICAL "cost" is CUMULATIVE BILLED spend recorded per finished Agent Run.
// They live in separate sections with their own labels; the page never sums one into the other.
//
// SCOPE CONTROLS (page-local, NOT coupled to the header active project — this page stays god-eye):
//   • Project filters BOTH sections.
//   • Window (24h / 7d / 30d / All) governs ONLY the historical section; live occupancy is always "now".

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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  return n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`;
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
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, maxWidth: 320, lineHeight: 1.5, textAlign: "right" }}>
          Project filters both sections. Window governs the Agent&nbsp;Runs history only — live occupancy is always now.
        </span>
      </div>

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
                      <HistoryRow key={a.agentId} name={a.agentName ?? a.agentId.slice(0, 8)} row={a} max={max} />
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

// One historical breakdown row (project or agent): name, run count, a token meter relative to the
// section's max, and the billed cost.
function HistoryRow({ name, row, max }: { name: string; row: UsageHistoryProject | UsageHistoryAgent; max?: number }) {
  const tok = totalTokens(row);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.border}` }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text, minWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
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
