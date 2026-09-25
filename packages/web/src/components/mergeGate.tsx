// Merge-gate cadence UI — the Overview GATE STRIP and the cadence editor Settings shares with it.
//
// Owner decision (request cb3ebeea, card 00664e74): Direction A · Gate Strip, plus two borrowings —
// direction B's Attention-row escalation on a failed periodic gate, and direction C's recent-gates verdict
// strip inside A's expanded editor. Mockups + the state vocabulary: vault `Projects/Loom/Mockups/
// 2026-09-25 Merge Gate Interval/`.
//
// The strip is instrumentation, not a notification banner: never dismissable, and it states a plain
// sentence rather than an alert. That sentence is why A won — "3 / 5 ungated" is not self-evident.
//
// Everything visual comes from the existing kit + tokens; the ONE new primitive is the tick track, which
// degrades to the kit's own Meter above TICK_TRACK_MAX (a track you have to count is not glanceable).

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrchestrationConfig } from "@loom/shared";
import { api } from "../lib/api";
import { color, font, radius, tone as toneMap, type Tone } from "../theme";
import { Badge, Button, Chip, Input, Meter, Segmented } from "./ui";
import { AttentionRow } from "./fleet";
import { alertUnlessCredentialGuard, errorText } from "../lib/loopbackCredential";
import {
  ago, badgeForInterval, bisectLabel, cadenceConfigWrite, cadenceOf, gateFailureAttentionText,
  intervalError, intervalFieldOf, isEscalatedFailure, landingLabel, readMergeGate, RECENT_VERDICT_CAP,
  shortSha, showsTicks, TICK_TRACK_MAX, verdictMark, weakeningNote, type MergeGateCadence, type MergeGateStatus, type MergeGateVerdict,
} from "../lib/mergeGate";

// ── Shared query ─────────────────────────────────────────────────────────────────────────────────────
// There is NO project-scoped ws channel for merge-gate state, so the contract's fallback applies: POLL.
// 15s (not the 3s the session/event feeds use) because this state only moves when a merge LANDS — a
// several-times-a-minute poll would add load for no extra freshness. Every mutating action below
// invalidates this key directly, so a PATCH or a gate-next shows up immediately rather than up to 15s
// later. `retry: false` so an older daemon's 404 — which api.mergeGateStatus resolves to `null`, not an
// error — settles in ONE request instead of being retried as a transient failure.
const MERGE_GATE_POLL_MS = 15_000;

export function useMergeGateStatus(projectId: string | null, repoKey?: string | null) {
  return useQuery({
    // repoKey is part of the key: the endpoint is per-repo, so two repos' statuses must never share a
    // cache entry (one would silently render the other's counter).
    queryKey: ["mergeGateStatus", projectId, repoKey ?? null],
    queryFn: () => api.mergeGateStatus(projectId!, repoKey),
    enabled: !!projectId,
    refetchInterval: MERGE_GATE_POLL_MS,
    retry: false,
  });
}

/** Invalidate the cadence status after a config save, so Settings and the strip re-read together. */
export function useInvalidateMergeGateStatus() {
  const qc = useQueryClient();
  return (projectId: string | null) => {
    void qc.invalidateQueries({ queryKey: ["mergeGateStatus", projectId] });
  };
}

// ── Tick track ───────────────────────────────────────────────────────────────────────────────────────
// `used` filled dots out of `interval`, plus a hollow ring for the gated landing when it is next. Above
// TICK_TRACK_MAX it becomes a Meter — the same primitive the worst-context tile beside it already uses.

export function TickTrack({ used, interval, tone, nextGated }: {
  used: number; interval: number | null; tone: Tone; nextGated: boolean;
}) {
  if (interval === null || interval <= 0) return null;
  const filled = Math.max(0, Math.min(used, interval));
  const label = nextGated
    ? `${used} of ${interval} ungated merges used; the next merge is gated`
    : `${used} of ${interval} ungated merges used`;
  if (!showsTicks(interval)) {
    return <Meter value={filled} max={interval} tone={tone} width={110} />;
  }
  return (
    <span role="img" aria-label={label} data-testid="merge-gate-ticks"
      style={{ display: "inline-flex", gap: 4, alignItems: "center", flex: "none" }}>
      {Array.from({ length: interval }, (_, i) => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: 7, flex: "none", display: "block",
          background: i < filled ? toneMap[tone] : color.borderStrong,
        }} />
      ))}
      {nextGated && (
        <span style={{
          width: 7, height: 7, borderRadius: 7, flex: "none", display: "block",
          background: "transparent", boxShadow: `inset 0 0 0 1px ${toneMap[tone]}`,
        }} />
      )}
    </span>
  );
}

/** "3 / 5 ungated" — the fraction, in the state's own tone. */
function Counter({ used, interval, tone }: { used: number; interval: number | null; tone: Tone }) {
  return (
    <span data-testid="merge-gate-counter" style={{ fontFamily: font.mono, fontSize: 13, color: toneMap[tone], whiteSpace: "nowrap", flex: "none" }}>
      {used} <span style={{ color: color.textMuted, fontSize: 11 }}>/ {interval ?? "—"} ungated</span>
    </span>
  );
}

// ── Verdict strip (direction C's borrowing) ──────────────────────────────────────────────────────────
// The last six periodic gates, oldest first. A single failure is an event; a run of them means the
// interval is set too high for this project, which is the actual decision the number should drive.

export function VerdictStrip({ recent }: { recent: MergeGateVerdict[] }) {
  const shown = recent.slice(-RECENT_VERDICT_CAP);
  if (shown.length === 0) {
    return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>no periodic gates yet</span>;
  }
  const label = `Last ${shown.length} periodic ${shown.length === 1 ? "gate" : "gates"}: ${shown.map((v) => v.result).join(", ")}`;
  // `result` is already the word for each kind ("pass" / "fail" / "cleared"), so the label stays truthful
  // as the union grows.
  return (
    <span role="img" aria-label={label} data-testid="merge-gate-verdicts"
      style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {shown.map((v, i) => {
        const m = verdictMark(v);
        const c = toneMap[m.tone];
        return (
          <b key={`${v.at}-${i}`} title={m.title} data-verdict={m.kind}
            style={{
              width: 16, height: 16, borderRadius: radius.sm, display: "grid", placeItems: "center",
              fontFamily: font.mono, fontSize: 11, fontWeight: 400, lineHeight: 1,
              border: `1px solid ${c}`, color: c,
              ...(m.kind === "fail" ? { background: "var(--loom-red-dim, transparent)" } : null),
            }}>
            {m.glyph}
          </b>
        );
      })}
    </span>
  );
}

// ── The cadence editor body — ONE control, mounted by both surfaces ──────────────────────────────────
// Settings mounts it stacked inside its own Panel; the strip mounts it as a drop-down under the strip.
// Sharing it is what guarantees the two surfaces can never word the same validation differently.

export interface CadenceDraft {
  cadence: MergeGateCadence;
  intervalRaw: string;
}

export function CadenceControls({ draft, onChange, idPrefix, layout }: {
  draft: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
  idPrefix: string;
  layout: "row" | "stack";
}) {
  const err = draft.cadence === "interval" ? intervalError(draft.intervalRaw) : null;
  const blankIsNever = draft.cadence === "interval" && draft.intervalRaw.trim() === "";
  const fieldId = `${idPrefix}-interval`;
  const disabled = draft.cadence !== "interval";
  return (
    <div style={{
      display: "flex", gap: layout === "row" ? 22 : 12,
      flexDirection: layout === "row" ? "row" : "column",
      flexWrap: "wrap", alignItems: layout === "row" ? "flex-start" : "stretch",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <FieldLabel>Cadence</FieldLabel>
        <Segmented<MergeGateCadence>
          value={draft.cadence}
          onChange={(cadence) => onChange({ ...draft, cadence })}
          items={[
            { key: "every", label: "Every merge" },
            { key: "interval", label: "Every Nth merge" },
            { key: "never", label: "Never" },
          ]}
          ariaLabel="Merge gate cadence"
          data-testid="merge-gate-cadence"
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, maxWidth: 420 }}>
        <FieldLabel htmlFor={fieldId}>Ungated merges between gates</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Input id={fieldId} data-testid="merge-gate-interval" inputMode="numeric" value={draft.intervalRaw}
            disabled={disabled}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${fieldId}-error` : undefined}
            placeholder={disabled ? "not used at this cadence" : "5"}
            onChange={(e) => onChange({ ...draft, intervalRaw: e.target.value })}
            style={{ width: disabled ? 264 : 96, ...(err ? { borderColor: color.red } : null) }} />
          {!disabled && <Hint>merges</Hint>}
        </div>
        {err && <span id={`${fieldId}-error`} role="alert" data-testid="merge-gate-interval-error"
          style={{ fontFamily: font.mono, fontSize: 11, color: color.red }}>{err}</span>}
        {disabled && (
          <Hint>
            {draft.cadence === "every"
              ? <>an interval only applies at the <b style={{ color: color.text, fontWeight: 400 }}>every Nth</b> cadence</>
              : <>pick <b style={{ color: color.text, fontWeight: 400 }}>every Nth merge</b> to gate periodically instead</>}
          </Hint>
        )}
        {!disabled && !err && (
          <Hint>
            {blankIsNever
              ? <>blank = <b style={{ color: color.text, fontWeight: 400 }}>never gated</b> — every merge lands unverified</>
              : <>{draft.intervalRaw.trim()} merges land <b style={{ color: color.text, fontWeight: 400 }}>without</b> the gate; the next one runs it. A pass resets the counter to 0.</>}
          </Hint>
        )}
      </div>
    </div>
  );
}

/** Whether a draft may be saved. Blank at the `interval` cadence is legal (it means `never`). */
export function cadenceDraftValid(draft: CadenceDraft): boolean {
  return draft.cadence !== "interval" || intervalError(draft.intervalRaw) === null;
}

/** The draft a stored override starts from — shared so both surfaces seed identically. */
export function cadenceDraftFrom(override: Partial<OrchestrationConfig> | undefined): CadenceDraft {
  return { cadence: cadenceOf(override), intervalRaw: intervalFieldOf(override) };
}

// ── The weakening strip ──────────────────────────────────────────────────────────────────────────────
// Same shape Settings already uses for a rotation-guard weakening. Amber for `every Nth` (the bisect
// cost); red for `never` (nothing is verified at all).

export function CadenceWeakening({ cadence, interval }: { cadence: MergeGateCadence; interval: number | null }) {
  const note = weakeningNote(cadence, interval);
  if (!note) return null;
  const c = note.tone === "red" ? color.red : color.amber;
  return (
    <div data-testid={note.tone === "red" ? "merge-gate-warn-never" : "merge-gate-warn-interval"}
      style={{ display: "flex", gap: 8, padding: "8px 10px", border: `1px solid ${c}`, borderRadius: radius.base, background: color.panel2 }}>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: c, lineHeight: 1.6 }}>{note.text}</span>
    </div>
  );
}

// ── The Overview gate strip ──────────────────────────────────────────────────────────────────────────

export function MergeGateStrip({ projectId, override, gateCommand, multiRepo }: {
  projectId: string | null;
  /** This project's STORED orchestration override — the editor writes cadence/interval back onto it. */
  override: Partial<OrchestrationConfig> | undefined;
  /** The RESOLVED gate command, shown at the `every` cadence so the row says what actually runs. */
  gateCommand: string;
  /**
   * Whether this project carries a repo REGISTRY beyond its primary repo. The status endpoint is
   * per-repo and this strip reads the PRIMARY, so on a multi-repo project every number here is narrower
   * than the page around it implies — and a counter that silently describes one of several repos is worse
   * than no counter. When true the strip names its repo, so the scope is stated rather than assumed.
   */
  multiRepo?: boolean;
}) {
  const status = useMergeGateStatus(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CadenceDraft>(() => cadenceDraftFrom(override));
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Re-seed the draft from the live status whenever the editor OPENS, so it never shows a stale cadence
  // after a save made on the Settings page (or by another browser tab) — the strip polls, the draft does not.
  useEffect(() => {
    if (!editing) return;
    const s = status.data;
    setDraft(s
      ? { cadence: s.cadence, intervalRaw: s.interval === null ? "" : String(s.interval) }
      : cadenceDraftFrom(override));
    // Intentionally keyed on `editing` alone: re-seeding on every 5s poll would clobber typing mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("no active project");
      const stored = await api.projectConfig(projectId);
      const write = cadenceConfigWrite(draft.cadence, draft.intervalRaw);
      const orch: Partial<OrchestrationConfig> = { ...stored.orchestration };
      delete orch.mergeGate;
      delete orch.mergeGateInterval;
      Object.assign(orch, write.set);
      return api.updateProjectConfig(projectId, { ...stored, orchestration: orch }, write.unset);
    },
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["mergeGateStatus", projectId] });
    },
    // Surfaced INLINE beside the Save button (below), so the global alert handler must stand down for it.
    meta: { inlineError: true },
  });

  const gateNext = useMutation({
    mutationFn: () => api.gateNextMerge(projectId!),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["mergeGateStatus", projectId] }); },
    onError: alertUnlessCredentialGuard,
  });

  // GRACEFUL DEGRADATION (DoD): a daemon without the merge-gate routes 404s, which api.mergeGateStatus
  // resolves to `null`. Render NOTHING rather than an error — an older daemon simply does not have the
  // feature, and a broken-looking strip is worse than no strip. Same for a genuine fetch failure: the
  // cockpit already surfaces daemon-down elsewhere, and this row has nothing true to say without data.
  if (!projectId || status.data == null) return null;

  const s: MergeGateStatus = status.data;
  const read = readMergeGate(s);
  const t = toneMap[read.tone];
  const escalated = isEscalatedFailure(s);
  const showTrack = s.cadence === "interval" && !escalated;
  const failure = escalated ? s.lastFailure : null;
  const range = bisectLabel(failure);
  const landing = landingLabel(failure);
  const dirty = draft.cadence !== s.cadence
    || (draft.cadence === "interval" && draft.intervalRaw.trim() !== (s.interval === null ? "" : String(s.interval)));

  return (
    <section data-testid="merge-gate-strip" aria-label="Merge gate cadence">
      <div className="loom-gate-strip" style={{
        background: color.panel, padding: "7px 12px",
        borderStyle: "solid", borderWidth: "1px 1px 1px 3px",
        borderTopColor: color.border, borderRightColor: color.border, borderLeftColor: t,
        // The two values that flip when the editor opens, so the strip and the panel below read as one
        // surface. Longhand throughout: mixing these with `border`/`borderRadius` shorthands makes React
        // remove them on rerender and warn, and the warning is about a genuine styling hazard.
        borderBottomColor: editing ? "transparent" : color.border,
        borderTopLeftRadius: radius.base, borderTopRightRadius: radius.base,
        borderBottomLeftRadius: editing ? 0 : radius.base,
        borderBottomRightRadius: editing ? 0 : radius.base,
      }}>
        <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
          Merge gate
        </span>
        <Badge tone={read.tone} data-testid="merge-gate-badge" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {read.glow && <span aria-hidden style={{ width: 8, height: 8, borderRadius: 8, background: t, boxShadow: `0 0 6px ${t}`, display: "inline-block" }} />}
          {read.badge}
        </Badge>
        {showTrack && <TickTrack used={s.ungatedSinceLastPass} interval={s.interval} tone={read.tone} nextGated={s.nextLandingGated} />}
        {showTrack && <Counter used={s.ungatedSinceLastPass} interval={s.interval} tone={read.tone} />}
        <span className="loom-gate-msg" data-testid="merge-gate-sentence" title={read.sentence}
          style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
          {read.sentence}
        </span>
        <span className="loom-gate-spacer" aria-hidden />
        {/* The right-hand controls. `flex: none` throughout, so the sentence above is the one part that
            gives way as the window narrows — no control is ever pushed off the row. */}
        {multiRepo && <Chip label="repo" value={s.repoKey ?? "primary"} title="This gate state is for one repo. The other repos in this project have their own cadence and their own counter." />}
        {read.state === "every" && !!gateCommand && (
          <Chip label="cmd" value={gateCommand} style={{ maxWidth: "32ch", whiteSpace: "nowrap", overflow: "hidden" }} />
        )}
        {read.state !== "failed" && s.lastPassAt && (
          <Chip label="last pass" value={ago(s.lastPassAt)} />
        )}
        {failure && (
          <>
            {landing && <Chip label={landing.label} value={landing.value} />}
            <Chip label="failed" value={ago(failure.at)} tone="red" />
            {range && <Chip label="bisect" value={range} tone="red" />}
          </>
        )}
        {read.state === "failed" && (
          <Button data-testid="merge-gate-open-log" onClick={() => navigate("/gates")}
            title="Open the Gates page — the full run history for this project's gates">Open gate log</Button>
        )}
        {!s.nextLandingGated && read.state !== "failed" && (
          <Button data-testid="merge-gate-next" disabled={gateNext.isPending}
            title="Run the real gate command on the next merge, whatever the cadence says"
            onClick={() => gateNext.mutate()}>{gateNext.isPending ? "Arming…" : "Gate the next merge"}</Button>
        )}
        {editing
          ? <Button variant="ghost" data-testid="merge-gate-edit-cancel" onClick={() => setEditing(false)}>Cancel</Button>
          : <Button data-testid="merge-gate-edit" onClick={() => setEditing(true)}>Change cadence</Button>}
      </div>

      {editing && (
        <div data-testid="merge-gate-editor" style={{
          background: color.panel2, padding: 12, display: "flex", flexDirection: "column", gap: 12,
          borderStyle: "solid", borderWidth: "0 1px 1px 3px",
          borderRightColor: color.border, borderBottomColor: color.border, borderLeftColor: t,
          borderBottomLeftRadius: radius.base, borderBottomRightRadius: radius.base,
        }}>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
            <CadenceControls draft={draft} onChange={setDraft} idPrefix="strip" layout="row" />
            <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
              <FieldLabel>Last periodic gates</FieldLabel>
              <VerdictStrip recent={s.recent} />
              <Hint>last pass {ago(s.lastPassAt)}</Hint>
            </div>
            <div style={{ marginLeft: "auto", alignSelf: "center", display: "flex", gap: 8, alignItems: "center" }}>
              {save.isError && <span role="alert" style={{ fontFamily: font.mono, fontSize: 11, color: color.red }}>{errorText(save.error)}</span>}
              <Button variant="primary" data-testid="merge-gate-save"
                disabled={!cadenceDraftValid(draft) || !dirty || save.isPending}
                title={!dirty ? "No cadence change to save" : undefined}
                onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save cadence"}</Button>
            </div>
          </div>
          <CadenceWeakening cadence={draft.cadence} interval={draft.cadence === "interval" ? (Number(draft.intervalRaw.trim()) || null) : null} />
        </div>
      )}
    </section>
  );
}

// ── The Attention escalation (direction B's borrowing) ───────────────────────────────────────────────
// The strip is enough to notice a failure while you are looking at Overview; the Attention row is what
// makes it survive you NOT looking. Rendered as the ordinary AttentionRow shape, so it reads as one of
// Loom's existing escalations rather than new alarm chrome.

export function MergeGateAttention({ status }: { status: MergeGateStatus | null | undefined }) {
  const navigate = useNavigate();
  const text = status ? gateFailureAttentionText(status) : null;
  if (!status || !text) return null;
  return (
    <div data-testid="merge-gate-attention">
      <AttentionRow
        item={{ key: `merge-gate-failed:${status.lastFailure?.at ?? ""}`, tone: "red", kind: "MERGE GATE", text }}
        onOpen={() => navigate("/gates")}
      />
    </div>
  );
}

/** Whether a status contributes an Attention row — so Overview's "Attention (N)" count stays truthful. */
export function mergeGateAttentionCount(status: MergeGateStatus | null | undefined): number {
  return status && gateFailureAttentionText(status) ? 1 : 0;
}

// ── The Settings cadence panel ───────────────────────────────────────────────────────────────────────
// Replaces the single "Merge gate off" checkbox. A checkbox can only express on or off; with an interval
// there are three cadences. The panel also shows the LIVE counter — the same numbers the strip shows — so
// Settings and Overview can never disagree about where the project stands.

export function MergeGateCadencePanel({ projectId, draft, onChange }: {
  projectId: string | null;
  draft: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
}) {
  const status = useMergeGateStatus(projectId);
  const s = status.data ?? null;
  const effective = draft.cadence === "every"
    ? "every merge"
    : draft.cadence === "never"
      ? "never"
      : intervalError(draft.intervalRaw) || draft.intervalRaw.trim() === ""
        ? "every Nth merge"
        : badgeForInterval(Number(draft.intervalRaw.trim())).toLowerCase();

  return (
    <div data-testid="merge-gate-panel" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <CadenceControls draft={draft} onChange={onChange} idPrefix="settings" layout="stack" />
      <Hint>effective: {effective} · human-set only</Hint>
      <div style={{ marginTop: 8, paddingLeft: 13, borderLeft: `2px solid ${toneMap[draft.cadence === "every" ? "phosphor" : draft.cadence === "never" ? "red" : "amber"]}`, display: "flex", flexDirection: "column", gap: 10 }}>
        {s && <LiveCounterRow status={s} />}
        {!s && <Hint>live counter unavailable — this daemon does not report merge-gate state</Hint>}
        <CadenceWeakening cadence={draft.cadence} interval={draft.cadence === "interval" ? (Number(draft.intervalRaw.trim()) || null) : null} />
      </div>
    </div>
  );
}

/** The live status line in Settings — the SAME numbers the Overview strip reads, never a second source. */
function LiveCounterRow({ status: s }: { status: MergeGateStatus }) {
  const read = readMergeGate(s);
  const showTrack = s.cadence === "interval" && !isEscalatedFailure(s);
  return (
    <div data-testid="merge-gate-live" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>now</span>
      {showTrack && <TickTrack used={s.ungatedSinceLastPass} interval={s.interval} tone={read.tone} nextGated={s.nextLandingGated} />}
      <span style={{ fontFamily: font.mono, fontSize: 13, color: toneMap[read.tone] }}>
        {showTrack
          ? <>{s.ungatedSinceLastPass} <span style={{ fontSize: 11, color: color.textMuted }}>/ {s.interval} ungated since the last passing gate</span></>
          : <>{s.ungatedSinceLastPass} <span style={{ fontSize: 11, color: color.textMuted }}>{s.ungatedSinceLastPass === 1 ? "merge" : "merges"} landed unverified since the last passing gate</span></>}
      </span>
      <span style={{ flex: 1 }} />
      <VerdictStrip recent={s.recent} />
      <Hint>last pass {ago(s.lastPassAt)}</Hint>
      {/* There is deliberately no "reset counter" control: this number is how much unverified work is
          sitting on the default branch, so zeroing it by hand without a gate would make it lie. Only a
          passing gate clears it, and "Gate the next merge" on the Overview strip is how you ask for one. */}
      <Hint>resets on the next passing gate</Hint>
    </div>
  );
}

// ── Local text bits (the two label/hint shapes both surfaces use) ────────────────────────────────────

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{children}</span>;
}

// Re-exported for the surfaces that only need the classification, not the whole strip.
export { readMergeGate, shortSha, TICK_TRACK_MAX };
