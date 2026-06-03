import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { isRateLimited } from "../lib/attention";
import { Panel, SectionLabel, StatusPill, Badge, Chip, Meter } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// TOKEN USAGE — a god-eye view of every live session's CONTEXT occupancy. Sessions already report
// `ctxInputTokens` (the measured size of the engine's CURRENT context, i.e. last-assistant input
// usage) + `model`; we size each meter with the shared contextWindowForModel and colour it at
// CONTEXT_WARN_RATIO, exactly as Mission Control's fleet rows do. Pure view over /api/sessions — no
// new endpoint.
//
// HONESTY NOTE (load-bearing): ctxInputTokens is the CURRENT context size, NOT cumulative billed
// tokens. Every "tokens" figure here is "context in use right now", and every dollar figure is an
// ESTIMATE of one input pass at that context size — never cumulative session spend. Labels say so.

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
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function fmtUsd(n: number): string {
  return n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`;
}

export default function Usage() {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 2000 });
  const all = sessions.data ?? [];

  // Overall aggregates. totalCtx is summed context-in-use (not cumulative spend); totalCost is the
  // sum of each session's estimated one-pass input cost — a relative gauge, not a bill.
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
        <Panel><span style={{ color: color.textMuted }}>No sessions.</span></Panel>
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
    </div>
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
