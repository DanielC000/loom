import type { ReactNode } from "react";
import type { SessionUsageTotals } from "@loom/shared";
import { Badge, Select } from "./ui";
import { sentenceCase } from "../lib/textCase";
import { color, font, tone, type Tone, fs, radius } from "../theme";

// THE USAGE KIT — the token/cost formatting, the historical window control, and the small presentational
// primitives SHARED by every usage surface.
//
// ⭐ EXTRACTED FROM pages/Usage.tsx, NOT COPIED (card 30266229, for the per-project Usage tab). Every
// declaration below moved here and is imported BACK by that page, so there is exactly one spelling of
// what a token count, a dollar estimate, a cache-hit tone and the four windows look like. A second copy
// would drift the moment one surface's formatter was tuned, invisibly: both pages would still render
// plausible numbers, just differently.
//
// Three moved with a change, and all three are ADDITIVE — every existing call site renders exactly as
// it did: `RowName` gained optional width/maxWidth/indent (and a ReactNode `name`, so a title can be a
// link) defaulting to its old fixed geometry, `Stat` gained an optional `testId`, and `SortToggle`/
// `MetricToggle` — two byte-identical copies in Usage.tsx differing only in a leading word — are one
// implementation here behind their two original names.

// What deliberately did NOT move: Usage.tsx's live-occupancy helpers (`shortModel`, `occupancy`,
// `estContextCost`, the input-price table) and its runs-plane `totalTokens` — they belong to planes the
// project tab has not got, and hoisting them would make this the UNION of two pages, not their
// intersection.

// ── Token / cost / ratio formatting ───────────────────────────────────────────
export function fmtTokens(n: number): string {
  // Interactive cache-read totals reach the billions over a wide window — keep the readout legible with a
  // B tier above M/k rather than printing "6020.4M".
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `<$0.01`;
  // Thousands separators — estimated interactive totals run to the thousands ($6,020.00 reads far better
  // than $6020.00).
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Prompt-cache hit ratio (cacheRead / (cacheRead + cacheCreation + input)) — the fixed-prefix cache-health
// tripwire. null = no usage in the row to divide by (never rendered as a misleading "0%").
export function fmtRatio(r: number | null): string {
  return r == null ? "—" : `${Math.round(r * 100)}%`;
}

// Warm (read-dominated, byte-stable prefix) reads phosphor-green; a collapsing ratio (broken prefix,
// re-paying the whole prefix every turn) escalates amber then red; unmeasured stays muted.
export function ratioTone(r: number | null): Tone {
  if (r == null) return "muted";
  if (r >= 0.8) return "live";
  if (r >= 0.4) return "attn";
  return "danger";
}

// Every billed token class on an interactive-session usage row summed (totals / per-day / per-project /
// per-agent / per-session / per-TASK all share the SessionUsageTotals token fields).
export function sessionTotalTokens(t: SessionUsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}

// ── Historical window controls ─────────────────────────────────────────────────
export type Timespan = "24h" | "7d" | "30d" | "all";
export const TIMESPANS: { key: Timespan; label: string; window: string }[] = [
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
export function sinceIsoFor(span: Timespan): string {
  if (span === "all") return new Date(0).toISOString();
  return new Date(Date.now() - SPAN_MS[span]).toISOString();
}

/** The window `<Select>`, so every usage surface offers the same four windows with the same labels. */
export function WindowSelect({ value, onChange, testId }: {
  value: Timespan;
  onChange: (v: Timespan) => void;
  testId?: string;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Timespan)}
      data-testid={testId} style={{ minWidth: 150 }}>
      {TIMESPANS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
    </Select>
  );
}

// ── Shared presentational primitives ──────────────────────────────────────────
// Section header with a right-aligned tag pill so the live vs historical distinction reads at a glance.
export function SectionHead({ title, tag, tagTone }: { title: string; tag: string; tagTone: Tone }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${color.line}`, paddingBottom: 6 }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.body, fontWeight: 700, color: color.text }}>{title}</span>
      <Badge tone={tagTone}>{tag}</Badge>
    </div>
  );
}

// A labelled form control (label above the field), for a scope-control bar.
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text3 }}>{sentenceCase(label)}</span>
      {children}
    </label>
  );
}

export function Stat({ label, value, tone: t = "live", testId }: { label: string; value: string; tone?: Tone; testId?: string }) {
  return (
    <span data-testid={testId}
      style={{ display: "inline-flex", flexDirection: "column", border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: "4px 12px", minWidth: 72 }}>
      <span style={{ fontFamily: font.mono, fontSize: fs.h1, color: tone[t] }}>{value}</span>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text3 }}>{sentenceCase(label)}</span>
    </span>
  );
}

// A breakdown row's leading label: the primary name with an optional secondary subtitle stacked under it
// (the owning project for agent rows — e.g. "Dev" · "Fire Studio"), so identically-named agents across
// projects read unambiguously. With no subtitle it lays out exactly like the old single-line name.
export function RowName({ name, subtitle, width = 160, maxWidth = 200, indent = 0 }: {
  name: ReactNode;
  subtitle?: string | null;
  /** Overridden by the project Usage tab, whose task titles are sentences rather than agent names. */
  width?: number;
  maxWidth?: number;
  /** Left inset for a nested (child / relation) row — the kit's one concession to a TREE of rows. */
  indent?: number;
}) {
  return (
    <span style={{ display: "flex", flexDirection: "column", minWidth: width, maxWidth, overflow: "hidden", paddingLeft: indent }}>
      <span style={{ fontSize: fs.sm, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {subtitle && (
        <span style={{ fontSize: fs.xs, color: color.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</span>
      )}
    </span>
  );
}

/** The cost / tokens sort toggle shared by every ranked usage breakdown. */
export function SortToggle({ value, onChange }: { value: "tokens" | "cost"; onChange: (v: "tokens" | "cost") => void }) {
  return <SegToggle value={value} onChange={onChange} lead="sort" />;
}

/** The same chip pair, labelled for whatever measure it picks (the by-day chart's "chart cost|tokens"). */
export function MetricToggle({ value, onChange }: { value: "cost" | "tokens"; onChange: (v: "cost" | "tokens") => void }) {
  return <SegToggle value={value} onChange={onChange} lead="chart" />;
}

// One segmented cost|tokens control. SortToggle and MetricToggle were two byte-identical copies of this
// in Usage.tsx differing only in their leading word; they stay two named exports because the two read
// differently at the call site, but there is one implementation.
function SegToggle<T extends "tokens" | "cost">({ value, onChange, lead }: {
  value: T; onChange: (v: T) => void; lead: string;
}) {
  const items = [{ key: "cost", label: "Cost" }, { key: "tokens", label: "Tokens" }] as const;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: fs.sm, color: color.text3 }}>{lead}</span>
      <span style={{ display: "inline-flex", border: `1px solid ${color.line}`, borderRadius: radius.sm, overflow: "hidden" }}>
        {items.map((it) => {
          const active = value === it.key;
          return (
            <button key={it.key} onClick={() => onChange(it.key as T)}
              style={{
                background: active ? color.selected : "transparent",
                color: active ? color.accentFg : color.text2,
                border: "none", padding: "3px 10px", fontFamily: font.ui, fontSize: fs.sm,
                cursor: "pointer",
              }}>
              {it.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}
