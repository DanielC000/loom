import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PresetPrompt, PresetPromptSuggestion } from "@loom/shared";
import { api } from "../lib/api";
import { Button, SectionLabel } from "./ui";
import { color, font, radius } from "../theme";
import { useDismissable } from "../lib/useDismissable";

// Preset Prompts — the terminal-card "action buttons" popover. A GLOBAL list of label+prompt presets
// (one shared store, same on every terminal card — keyed without the sessionId so the cache is shared);
// clicking a preset SENDS its prompt straight to THIS tile's session over the coordinated input path
// (api.sendInput — the same busy-gated enqueue the Composer uses), no extra confirm. The list is managed
// INLINE here (add / edit / delete via the /api/preset-prompts CRUD). Human/UI data only — no MCP path.

const PRESETS_KEY = ["presetPrompts"] as const;
const SUGGESTIONS_KEY = ["presetPromptSuggestions"] as const;

export function PresetPromptsButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <Button style={{ padding: "0 8px" }} aria-haspopup="dialog" aria-expanded={open}
        title="Preset prompts — send a saved prompt to this session"
        onClick={(ev) => { ev.stopPropagation(); setOpen((o) => !o); }}>Presets</Button>
      {open && <PresetPopover sessionId={sessionId} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PresetPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const presets = useQuery({ queryKey: PRESETS_KEY, queryFn: () => api.presetPrompts() });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Open with focus on the dialog itself (not a send button) so a stray Enter on open can't fire a
  // preset at the live agent; Tab then reaches the controls. Esc / outside-click dismiss via useDismissable.
  useEffect(() => { dialogRef.current?.focus(); }, []);

  const send = useMutation({
    mutationFn: (p: PresetPrompt) => api.sendInput(sessionId, p.prompt),
    onSuccess: (r) => { if (r.delivered || r.position) onClose(); else setSendErr("session not live"); },
    onError: () => setSendErr("send failed"),
  });

  const list = [...(presets.data ?? [])].sort((a, b) => a.position - b.position);
  const empty = !presets.isLoading && list.length === 0 && editing !== "new";

  return (
    <div ref={dialogRef} role="dialog" aria-label="Preset prompts" tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 20, width: 300,
        maxHeight: 380, overflowY: "auto", background: color.panel, border: `1px solid ${color.borderStrong}`,
        borderRadius: radius.base, padding: 8, display: "flex", flexDirection: "column", gap: 6, outline: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel style={{ margin: 0 }}>Preset prompts</SectionLabel>
        <Button variant="ghost" style={{ padding: "2px 8px" }} disabled={editing === "new"}
          onClick={() => setEditing("new")}>+ Add</Button>
      </div>

      {presets.isLoading && <Muted>Loading…</Muted>}
      {presets.isError && <Muted tone="red">Couldn't load presets.</Muted>}
      {empty && <Muted>No presets yet — add one.</Muted>}
      {sendErr && <Muted tone="red">{sendErr}</Muted>}

      {list.map((p) => editing === p.id
        ? <PresetForm key={p.id} preset={p} onDone={() => setEditing(null)} />
        : <PresetRow key={p.id} preset={p} sending={send.isPending}
            onSend={() => { setSendErr(null); send.mutate(p); }} onEdit={() => setEditing(p.id)} />)}

      {editing === "new" && <PresetForm onDone={() => setEditing(null)} />}

      <SuggestionsSection />
    </div>
  );
}

// "Suggested from your usage" — pending preset candidates the Platform Auditor proposed from recurring
// prompts. Renders NOTHING unless there's at least one pending suggestion (no empty placeholder, no
// divider) so it stays invisible until it has something to offer. Adopt mints a real preset (appears in
// the list above immediately — we invalidate BOTH the shared presets query and this one); Dismiss just
// drops it. A 409 (already adopted/dismissed elsewhere — stale list / double-click) refetches + shows a
// quiet inline note instead of crashing. Buttons disable while their row's mutation is in flight.
function SuggestionsSection() {
  const suggestions = useQuery({ queryKey: SUGGESTIONS_KEY, queryFn: () => api.presetPromptSuggestions() });
  const list = [...(suggestions.data ?? [])].sort((a, b) => a.position - b.position);
  if (list.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4, paddingTop: 8,
      borderTop: `1px solid ${color.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: color.cyan, flex: "0 0 auto" }} />
        <SectionLabel style={{ margin: 0 }}>Suggested from your usage</SectionLabel>
      </div>
      {list.map((s) => <SuggestionRow key={s.id} suggestion={s} />)}
    </div>
  );
}

function SuggestionRow({ suggestion }: { suggestion: PresetPromptSuggestion }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  // On a 409 the row is stale (adopted/dismissed elsewhere) — refetch so it drops off the list, and show
  // the server's reason quietly. Other errors keep the row and surface the message.
  const onError = (e: unknown) => {
    setErr(e instanceof Error ? e.message : "Something went wrong.");
    qc.invalidateQueries({ queryKey: SUGGESTIONS_KEY });
  };

  // meta.inlineError opts out of main.tsx's global blocking alert — we render our own quiet inline
  // message instead (the 409 path must NOT pop a modal that wedges the flow).
  const adopt = useMutation({
    mutationFn: () => api.adoptPresetPromptSuggestion(suggestion.id),
    onSuccess: () => {
      // The new preset appears in the list above; this suggestion leaves pending. Refresh both.
      qc.invalidateQueries({ queryKey: PRESETS_KEY });
      qc.invalidateQueries({ queryKey: SUGGESTIONS_KEY });
    },
    onError,
    meta: { inlineError: true },
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissPresetPromptSuggestion(suggestion.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: SUGGESTIONS_KEY }),
    onError,
    meta: { inlineError: true },
  });
  const busy = adopt.isPending || dismiss.isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, border: `1px solid ${color.border}`,
      borderRadius: radius.sm, padding: 8, background: color.panel2 }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, fontWeight: 600, color: color.text }}>
        {suggestion.label}
      </span>
      <span title={suggestion.prompt}
        style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, lineHeight: 1.4,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {suggestion.prompt}
      </span>
      {suggestion.rationale && (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.cyan, lineHeight: 1.4 }}>
          {suggestion.rationale}
        </span>
      )}
      {err && <Muted tone="red">{err}</Muted>}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button variant="ghost" style={{ padding: "2px 10px" }} disabled={busy}
          onClick={() => { setErr(null); dismiss.mutate(); }}>Dismiss</Button>
        <Button variant="primary" style={{ padding: "2px 10px" }} disabled={busy}
          onClick={() => { setErr(null); adopt.mutate(); }}>Adopt</Button>
      </div>
    </div>
  );
}

function PresetRow({ preset, onSend, sending, onEdit }: {
  preset: PresetPrompt; onSend: () => void; sending: boolean; onEdit: () => void;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deletePresetPrompt(preset.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PRESETS_KEY }),
  });
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
      <button type="button" onClick={onSend} disabled={sending || del.isPending} title={preset.prompt}
        className="loom-btn loom-btn-default"
        style={{ flex: 1, minWidth: 0, textAlign: "left", color: color.text, fontFamily: font.mono,
          fontSize: 12, padding: "5px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preset.label}
      </button>
      <IconButton label={`Edit ${preset.label}`} onClick={onEdit} disabled={del.isPending}>✎</IconButton>
      <IconButton label={`Delete ${preset.label}`} onClick={() => del.mutate()} disabled={del.isPending} danger>×</IconButton>
    </div>
  );
}

function PresetForm({ preset, onDone }: { preset?: PresetPrompt; onDone: () => void }) {
  const qc = useQueryClient();
  const editing = preset !== undefined;
  const [label, setLabel] = useState(preset?.label ?? "");
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [err, setErr] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => { labelRef.current?.focus(); }, []);

  const save = useMutation({
    mutationFn: () => editing
      ? api.updatePresetPrompt(preset!.id, { label: label.trim(), prompt })
      : api.createPresetPrompt({ label: label.trim(), prompt }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: PRESETS_KEY }); onDone(); },
    onError: (e) => setErr(e instanceof Error ? e.message : "Couldn't save the preset."),
  });
  const canSave = label.trim().length > 0 && prompt.trim().length > 0 && !save.isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${color.border}`,
      borderRadius: radius.sm, padding: 8 }}>
      <FieldLabel text="Label">
        <input ref={labelRef} value={label} maxLength={200}
          onChange={(e) => { setLabel(e.target.value); setErr(null); }}
          placeholder="Run tests" className="loom-field" style={fieldStyle} />
      </FieldLabel>
      <FieldLabel text="Prompt">
        <textarea value={prompt} rows={3}
          onChange={(e) => { setPrompt(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) { e.preventDefault(); save.mutate(); } }}
          placeholder="The prompt text sent to the session…"
          className="loom-field" style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.45 }} />
      </FieldLabel>
      {err && <Muted tone="red">{err}</Muted>}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button variant="ghost" style={{ padding: "2px 10px" }} onClick={onDone}>Cancel</Button>
        <Button variant="primary" style={{ padding: "2px 10px" }} disabled={!canSave} onClick={() => save.mutate()}>
          {editing ? "Save changes" : "Add preset"}
        </Button>
      </div>
    </div>
  );
}

// ── small local helpers ────────────────────────────────────────────────────────
const fieldStyle = {
  width: "100%", boxSizing: "border-box" as const, background: color.panel2, color: color.text,
  border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "4px 8px",
  fontFamily: font.mono, fontSize: 12,
};

function FieldLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.08em", color: color.textMuted }}>{text}</span>
      {children}
    </label>
  );
}

function Muted({ children, tone }: { children: ReactNode; tone?: "red" }) {
  return <span style={{ fontFamily: font.mono, fontSize: 11, color: tone === "red" ? color.red : color.textMuted, padding: "2px 0" }}>{children}</span>;
}

function IconButton({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={`loom-btn loom-btn-${danger ? "danger" : "ghost"}`}
      style={{ padding: "0 7px", fontFamily: font.mono, fontSize: 13, lineHeight: 1,
        color: danger ? color.red : color.textDim }}>
      {children}
    </button>
  );
}
