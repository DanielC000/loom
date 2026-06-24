// Board-column manager — the real editor that replaced the Settings "one key: Label per line" textarea.
//
// Edits the project's EFFECTIVE columns (resolveConfig: platform default → override) and persists the
// whole desired layout through card B's ATOMIC endpoint (api.updateProjectColumns → PUT
// /api/projects/:id/columns), NEVER the blind config PATCH. The server owns the hard invariant (no card
// ever references a missing column): it diffs desired-vs-current, re-keys renamed columns' cards old→new
// and removed columns' cards → defaultLanding, all in one transaction. This UI stages every change
// (reorder / label / role / key-rename / add / delete) locally, validates the two required roles
// client-side, and applies the batch atomically on Save.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { resolveConfig, COLUMN_PRESETS, presetById, presetToDesired, ACCENT_PALETTE, DEFAULT_COLUMN_PRESET_ID, type ColumnRole, type Project } from "@loom/shared";
import { api, type DesiredColumn } from "../lib/api";
import { Button, Input, Select, Badge, PresetAccentDots } from "./ui";
import { color, font, radius, tone, roleTone, type Tone } from "../theme";

// The eight lifecycle roles, in board order, with a human label and which two are REQUIRED exactly once
// (defaultLanding + terminal — the server's hard floor). Kept here so the badge, the assignment dropdown,
// and the validator all read one table. The signal tone comes from the shared `roleTone` map (theme.ts)
// so the role coloring here can never drift from the board header's lane coloring.
interface RoleMeta { label: string; short: string; t: Tone; required?: boolean; }
const ROLE_META: Record<ColumnRole, RoleMeta> = {
  intake: { label: "Intake", short: "INTAKE", t: roleTone.intake },
  defaultLanding: { label: "Default landing", short: "LANDING", t: roleTone.defaultLanding, required: true },
  workReady: { label: "Work ready", short: "READY", t: roleTone.workReady },
  active: { label: "Active", short: "ACTIVE", t: roleTone.active },
  review: { label: "Review", short: "REVIEW", t: roleTone.review },
  parked: { label: "Parked", short: "PARKED", t: roleTone.parked },
  humanHold: { label: "Human hold", short: "HOLD", t: roleTone.humanHold },
  terminal: { label: "Terminal (done)", short: "DONE", t: roleTone.terminal, required: true },
};
const ROLE_ORDER: ColumnRole[] = ["intake", "defaultLanding", "workReady", "active", "review", "parked", "humanHold", "terminal"];

// A staged row. `uid` is a stable client identity (drag + React key) that survives a key/label edit, so a
// rename doesn't remount the row. `originalKey` is the key this column had on the SERVER (undefined = a
// freshly-added column) — a row whose key drifts from its originalKey is a rename (sent as prevKey, the
// server re-keys its cards). `keyOpen` reveals the advanced key editor; `keyTouched` stops label→key
// auto-slug once the user types a key by hand.
interface Row {
  uid: string;
  key: string;
  label: string;
  role?: ColumnRole;
  // Per-column accent + soft WIP limit. Editable in-row (the swatch picker + WIP field below) AND carried
  // through untouched when not edited — the atomic PUT replaces the whole array, so an absent field here
  // would strip a column's accent / WIP limit. undefined = absent (cleared) → omitted by toDesired.
  accentColor?: string;
  wipLimit?: number;
  originalKey?: string;
  keyOpen: boolean;
  keyTouched: boolean;
}

let UID = 0;
const nextUid = () => `row-${UID++}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// The desired layout this UI will PUT — strip the client-only fields, and set prevKey only on a real
// rename of an existing column (key changed AND the column already existed server-side). accentColor +
// wipLimit are carried through untouched (absent stays absent) so a Settings Save preserves the per-column
// accent / soft WIP limit a preset or the board-header editor set — mirrors Board.tsx's columnsToDesired,
// since the atomic PUT replaces the entire array (an omitted field would silently strip it).
function toDesired(rows: Row[]): DesiredColumn[] {
  return rows.map((r) => {
    const d: DesiredColumn = { key: r.key.trim(), label: r.label.trim() };
    if (r.role) d.role = r.role;
    if (r.accentColor !== undefined) d.accentColor = r.accentColor;
    if (r.wipLimit !== undefined) d.wipLimit = r.wipLimit;
    if (r.originalKey && r.originalKey !== r.key.trim()) d.prevKey = r.originalKey;
    return d;
  });
}

// Client-side guards mirroring the server's hard rejects, surfaced BEFORE the call so an invalid layout
// can't be saved (and the user is told why). The server is still authoritative — this is fast feedback,
// not the source of truth. Returns the first blocking error, or null when the layout is sendable.
function validate(rows: Row[]): string | null {
  if (rows.length === 0) return "A board must keep at least one column.";
  for (const r of rows) {
    if (!r.key.trim()) return "Every column needs a key.";
    if (!r.label.trim()) return "Every column needs a label.";
  }
  const keys = rows.map((r) => r.key.trim());
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) return `Duplicate column key "${dupe}" — keys must be unique.`;
  const landing = rows.filter((r) => r.role === "defaultLanding").length;
  if (landing !== 1) return `Assign exactly one Default-landing column (currently ${landing}).`;
  const terminal = rows.filter((r) => r.role === "terminal").length;
  if (terminal !== 1) return `Assign exactly one Terminal (done) column (currently ${terminal}).`;
  for (const role of ROLE_ORDER) {
    if (role === "defaultLanding" || role === "terminal") continue;
    if (rows.filter((r) => r.role === role).length > 1) return `Role "${ROLE_META[role].label}" is on more than one column.`;
  }
  return null;
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const a = [...arr];
  const [m] = a.splice(from, 1);
  if (m !== undefined) a.splice(to, 0, m);
  return a;
}

export function ColumnManager({ project }: { project: Project }) {
  const qc = useQueryClient();
  // Edit the EFFECTIVE columns (override or inherited default) — saving materializes the full array as
  // the project's override. Seeded once on mount (keyed by project id upstream → a switch remounts).
  const seedRows = useMemo<Row[]>(() => resolveConfig(project.config).kanbanColumns.map((c) => ({
    uid: nextUid(), key: c.key, label: c.label, role: c.role, accentColor: c.accentColor, wipLimit: c.wipLimit,
    originalKey: c.key, keyOpen: false, keyTouched: true,
  })), [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<Row[]>(seedRows);
  const baseline = useRef(JSON.stringify(toDesired(seedRows)));
  // Soft warnings from the LAST successful apply (a manual Save or a Reset-to-preset), surfaced inline.
  const [warnings, setWarnings] = useState<string[]>([]);
  // Preset chosen in the Reset-to-preset control (defaults to today's board).
  const [resetPresetId, setResetPresetId] = useState(DEFAULT_COLUMN_PRESET_ID);
  const [resetConfirming, setResetConfirming] = useState(false);

  // Re-seed the staged rows from the server's canonical, just-stored columns — clearing dirty and
  // re-baselining the originalKeys so a subsequent rename diffs against the new persisted keys.
  const reseedFrom = (cols: { key: string; label: string; role?: ColumnRole; accentColor?: string; wipLimit?: number }[]) => {
    const fresh: Row[] = cols.map((c) => ({
      uid: nextUid(), key: c.key, label: c.label, role: c.role, accentColor: c.accentColor, wipLimit: c.wipLimit,
      originalKey: c.key, keyOpen: false, keyTouched: true,
    }));
    setRows(fresh);
    baseline.current = JSON.stringify(toDesired(fresh));
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["board", project.id] });
  };

  // Live card counts per column key — so each row shows its load, a rename can preview "moves N cards",
  // and a delete can warn how many cards will re-home. Polls in step with the board view.
  const board = useQuery({ queryKey: ["board", project.id], queryFn: () => api.board(project.id), refetchInterval: 4000 });
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of board.data?.tasks ?? []) m.set(t.columnKey, (m.get(t.columnKey) ?? 0) + 1);
    return m;
  }, [board.data]);
  // Cards a column currently holds, keyed by the SERVER key (originalKey) — local key edits don't move
  // cards until save, so the count must follow the original key, not the staged one.
  const cardsOf = (r: Row) => (r.originalKey ? counts.get(r.originalKey) ?? 0 : 0);
  const landingLabel = rows.find((r) => r.role === "defaultLanding")?.label ?? "Default landing";

  const desired = toDesired(rows);
  const dirty = JSON.stringify(desired) !== baseline.current;
  const error = validate(rows);

  const save = useMutation({
    mutationFn: () => api.updateProjectColumns(project.id, desired),
    meta: { inlineError: true }, // surfaced inline below (no blocking window.alert)
    onSuccess: (res) => { reseedFrom(res.columns); setWarnings(res.warnings); },
  });

  // Reset-to-preset: apply a chosen preset to the CURRENT board through the SAME atomic columns API
  // (no new endpoint). The server diffs preset-vs-current — re-keys/removes/adds, and cards in dropped
  // columns fall back to the preset's defaultLanding — then returns its soft warnings (surfaced below).
  const applyPreset = useMutation({
    mutationFn: () => api.updateProjectColumns(project.id, presetToDesired(presetById(resetPresetId))),
    meta: { inlineError: true },
    onSuccess: (res) => { reseedFrom(res.columns); setWarnings(res.warnings); setResetConfirming(false); },
  });

  const patchRow = (uid: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...p } : r)));
  const removeRow = (uid: string) => setRows((rs) => rs.filter((r) => r.uid !== uid));
  const addRow = () => setRows((rs) => {
    const newRow: Row = { uid: nextUid(), key: "", label: "New column", role: undefined, originalKey: undefined, keyOpen: true, keyTouched: false };
    // Insert just BEFORE the terminal (done) lane so a new column reads with the left→right→Done flow,
    // not appended after Done. No terminal lane → append at the end (graceful fallback).
    const termIdx = rs.findIndex((r) => r.role === "terminal");
    return termIdx >= 0 ? [...rs.slice(0, termIdx), newRow, ...rs.slice(termIdx)] : [...rs, newRow];
  });
  const onLabel = (uid: string, label: string) => setRows((rs) => rs.map((r) => {
    if (r.uid !== uid) return r;
    // Auto-slug the key from the label for a NEW, un-touched column (one less field to fill); a column
    // that exists server-side or whose key was hand-edited keeps its key (renames are deliberate).
    const key = !r.originalKey && !r.keyTouched ? slug(label) : r.key;
    return { ...r, label, key };
  }));

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setRows((rs) => {
      const from = rs.findIndex((r) => r.uid === e.active.id);
      const to = rs.findIndex((r) => r.uid === e.over!.id);
      return from < 0 || to < 0 ? rs : arrayMove(rs, from, to);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Drag <span style={{ color: color.textDim }}>⠿</span> to reorder · rename inline · assign a lifecycle
        role · set an accent or WIP limit · delete or add a lane. Saving re-keys cards atomically — nothing
        is ever orphaned.
      </p>

      <DndContext onDragEnd={onDragEnd}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r) => (
            <ColumnRowView key={r.uid} row={r} cards={cardsOf(r)} landingLabel={landingLabel}
              onLabel={(v) => onLabel(r.uid, v)}
              onKey={(v) => patchRow(r.uid, { key: v, keyTouched: true })}
              onRole={(role) => patchRow(r.uid, { role })}
              onAccent={(accentColor) => patchRow(r.uid, { accentColor })}
              onWip={(wipLimit) => patchRow(r.uid, { wipLimit })}
              onToggleKey={() => patchRow(r.uid, { keyOpen: !r.keyOpen })}
              onRemove={() => removeRow(r.uid)} />
          ))}
        </div>
      </DndContext>

      <div>
        <Button onClick={addRow} style={{ borderStyle: "dashed" }}>+ Add column</Button>
      </div>

      {/* Soft warnings the server returned on the last successful apply (a Save or a Reset-to-preset),
          e.g. a dropped non-required role. */}
      {warnings.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {warnings.map((w, i) => (
            <span key={i} style={{ color: color.amber, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5 }}>⚠ {w}</span>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={!dirty || !!error || save.isPending} onClick={() => save.mutate()}
          title={error ?? undefined}>
          {save.isPending ? "Saving…" : "Save layout"}
        </Button>
        {error
          ? <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{error}</span>
          : dirty
            ? <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>unsaved changes</span>
            : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        {save.isError && (
          <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono, textAlign: "right" }}>
            {(save.error as Error).message}
          </span>
        )}
      </div>

      {/* Reset-to-preset: replace the whole board with a ready-made layout. Re-keys cards atomically —
          cards in dropped lanes fall to the preset's default-landing column. Two-step confirm (it's a
          board-wide change), and it applies IMMEDIATELY via the same atomic API (no separate Save). */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
          reset to a preset board
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Select value={resetPresetId} onChange={(e) => { setResetPresetId(e.target.value); setResetConfirming(false); }}
            aria-label="Preset board" style={{ width: 170 }} disabled={applyPreset.isPending}>
            {COLUMN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.id === DEFAULT_COLUMN_PRESET_ID ? " (default)" : ""}</option>
            ))}
          </Select>
          {resetConfirming ? (
            <>
              <Button variant="danger" disabled={applyPreset.isPending} onClick={() => applyPreset.mutate()}>
                {applyPreset.isPending ? "Applying…" : "Apply & re-key cards"}
              </Button>
              <Button variant="ghost" disabled={applyPreset.isPending} onClick={() => setResetConfirming(false)}>Cancel</Button>
            </>
          ) : (
            <Button onClick={() => setResetConfirming(true)} disabled={applyPreset.isPending}>Reset board</Button>
          )}
          {applyPreset.isError && (
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(applyPreset.error as Error).message}</span>
          )}
        </div>
        <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono, lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <PresetAccentDots accents={presetById(resetPresetId).columns.map((c) => c.accentColor)}
            title={presetById(resetPresetId).columns.map((c) => c.label).join(" → ")} />
          <span>
            {presetById(resetPresetId).columns.map((c) => c.label).join(" → ")}
            {resetConfirming ? " · cards in dropped lanes move to the preset's default landing" : ""}
          </span>
        </span>
      </div>
    </div>
  );
}

// One staged column row: drag grip, inline label, role badge + assignment, live card count, advanced key
// editor (with a "moves N cards" preview on a rename), and a two-step delete (the second step previews
// where the lane's cards re-home). Draggable (the grip) AND droppable (the whole row) so a drop anywhere
// over a row targets it — see onDragEnd's reorder.
function ColumnRowView({ row, cards, landingLabel, onLabel, onKey, onRole, onAccent, onWip, onToggleKey, onRemove }: {
  row: Row; cards: number; landingLabel: string;
  onLabel: (v: string) => void; onKey: (v: string) => void; onRole: (role: ColumnRole | undefined) => void;
  onAccent: (v: string | undefined) => void; onWip: (v: number | undefined) => void;
  onToggleKey: () => void; onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [accentOpen, setAccentOpen] = useState(false);
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: row.uid });
  const { setNodeRef: dragRef, listeners, attributes, transform, isDragging } = useDraggable({ id: row.uid });
  const renamed = !!row.originalKey && row.originalKey !== row.key.trim();
  const meta = row.role ? ROLE_META[row.role] : null;

  return (
    <div ref={dropRef}
      style={{
        // All-longhand borders (never the `border` shorthand) so toggling the left accent / hover color
        // on rerender doesn't trip React's shorthand-vs-longhand conflict warning.
        borderWidth: 1, borderStyle: "solid", borderColor: isOver ? color.phosphor : color.border,
        borderLeftWidth: 2, borderLeftColor: meta ? tone[meta.t] : color.border,
        borderRadius: radius.base, background: color.panel2,
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translateY(${transform.y}px)` : undefined,
      }}>
      <div ref={dragRef} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px" }}>
        <span {...listeners} {...attributes} title="Drag to reorder"
          style={{ cursor: "grab", color: color.textMuted, touchAction: "none", userSelect: "none", lineHeight: "16px" }}>⠿</span>

        <Input value={row.label} onChange={(e) => onLabel(e.target.value)} aria-label="Column label"
          placeholder="Column label" style={{ flex: 1, minWidth: 120 }} />

        {/* Role badge (read) + assignment (write). The badge is the at-a-glance state; the select edits it. */}
        {meta
          ? <Badge tone={meta.t}>{meta.short}{meta.required ? "" : ""}</Badge>
          : <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, padding: "2px 8px", border: `1px dashed ${color.border}`, borderRadius: radius.sm }}>NO ROLE</span>}
        <Select value={row.role ?? ""} onChange={(e) => onRole((e.target.value || undefined) as ColumnRole | undefined)}
          aria-label="Lifecycle role" style={{ width: 150 }}>
          <option value="">— no role —</option>
          {ROLE_ORDER.map((role) => (
            <option key={role} value={role}>{ROLE_META[role].label}{ROLE_META[role].required ? " *" : ""}</option>
          ))}
        </Select>

        <span title={`${cards} card${cards === 1 ? "" : "s"} in this column`}
          style={{ fontFamily: font.mono, fontSize: 11, color: cards ? color.text : color.textMuted, minWidth: 56, textAlign: "right" }}>
          {cards} card{cards === 1 ? "" : "s"}
        </span>

        {/* Per-column accent swatch (opens the restrained palette below) — a filled chip in the current
            accent, or a dashed empty chip when un-accented. Token-consistent: the palette is the shared
            ACCENT_PALETTE, not a free hex picker. */}
        <button type="button" onClick={() => setAccentOpen((o) => !o)} aria-expanded={accentOpen}
          aria-label="Accent color" title={row.accentColor ? "Change the column accent color" : "Set a column accent color"}
          style={{
            width: 20, height: 20, flexShrink: 0, padding: 0, cursor: "pointer", borderRadius: radius.sm,
            borderWidth: row.accentColor ? 1 : 1, borderStyle: row.accentColor ? "solid" : "dashed",
            borderColor: accentOpen ? color.cyan : row.accentColor ? color.borderStrong : color.border,
            background: row.accentColor ?? "transparent",
          }} />

        {/* Soft WIP limit — small, empty-allowed. Empty clears it (field absent), matching carry-through. */}
        <Input value={row.wipLimit ?? ""} onChange={(e) => {
            const v = e.target.value.trim();
            const n = v === "" ? undefined : Math.max(0, Math.floor(Number(v)));
            onWip(v === "" || Number.isNaN(n!) ? undefined : n);
          }}
          type="number" min={0} inputMode="numeric" aria-label="WIP limit" placeholder="WIP" title="Soft WIP limit (advisory; empty = none)"
          style={{ width: 56, flexShrink: 0, textAlign: "right" }} />

        <Button variant="ghost" onClick={onToggleKey} aria-expanded={row.keyOpen}
          title="Advanced: edit the stable column key" style={{ color: row.keyOpen ? color.cyan : color.textMuted }}>key</Button>

        {confirming ? (
          <>
            <Button variant="danger" onClick={onRemove}>Remove</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => { if (cards > 0) setConfirming(true); else onRemove(); }}
            title="Delete this column">✕</Button>
        )}
      </div>

      {/* Delete-with-cards confirm: what happens to the lane's cards on save. */}
      {confirming && cards > 0 && (
        <div style={{ padding: "0 9px 8px 28px", fontFamily: font.mono, fontSize: 11, color: color.amber, lineHeight: 1.5 }}>
          {cards} card{cards === 1 ? "" : "s"} will move to <span style={{ color: color.text }}>{landingLabel}</span> when you save.
        </div>
      )}

      {/* Accent palette — the restrained, token-consistent swatch set (shared ACCENT_PALETTE) plus a clear
          choice. Picks a per-column accent WITHOUT applying a whole preset; clearing removes it (absent). */}
      {accentOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 9px 8px 28px", flexWrap: "wrap" }}>
          <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>accent</span>
          {ACCENT_PALETTE.map((s) => {
            const selected = row.accentColor === s.value;
            return (
              <button key={s.value} type="button" aria-label={s.name} aria-pressed={selected} title={s.name}
                onClick={() => { onAccent(s.value); setAccentOpen(false); }}
                style={{
                  width: 18, height: 18, flexShrink: 0, padding: 0, cursor: "pointer", borderRadius: radius.sm,
                  background: s.value, borderWidth: 2, borderStyle: "solid",
                  borderColor: selected ? color.text : "transparent",
                }} />
            );
          })}
          <button type="button" aria-label="No accent" aria-pressed={!row.accentColor} title="No accent"
            onClick={() => { onAccent(undefined); setAccentOpen(false); }}
            style={{
              fontFamily: font.mono, fontSize: 11, cursor: "pointer", padding: "2px 8px", borderRadius: radius.sm,
              background: "transparent", borderWidth: 1, borderStyle: "dashed",
              borderColor: !row.accentColor ? color.text : color.border,
              color: !row.accentColor ? color.text : color.textMuted,
            }}>none</button>
        </div>
      )}

      {/* Advanced key editor — de-emphasized; renaming an existing column with cards previews the re-key. */}
      {row.keyOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 9px 8px 28px", flexWrap: "wrap" }}>
          <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>key</span>
          <Input value={row.key} onChange={(e) => onKey(e.target.value)} aria-label="Column key" spellCheck={false}
            placeholder="stable_key" style={{ width: 200 }} />
          {renamed && (
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.amber }}>
              rename {row.originalKey} → {row.key.trim() || "?"}{cards > 0 ? ` · moves ${cards} card${cards === 1 ? "" : "s"}` : ""}
            </span>
          )}
          {!row.originalKey && (
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>new column — pick a stable key (it's how cards reference this lane)</span>
          )}
        </div>
      )}
    </div>
  );
}
