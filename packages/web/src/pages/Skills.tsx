import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type SkillMergePreview } from "../lib/api";
import { Panel, Button, Input, SectionLabel, Badge } from "../components/ui";
import { color, font, radius, type Tone } from "../theme";

// Loom's OWN skill set — the editable store (~/.loom/skills) that the daemon injects into every
// session as project-local skills (shadowing the user's personal ~/.claude/skills). Edits apply on
// the next spawn (skills are read at session start).
//
// Bundled skills carry a precise customization state derived server-side from three versions —
// `base` (shipped content at last sync), `mine` (the user's store copy, what sessions use), and the
// current `shipped` asset (see `End-User Skill Customization.md`):
//   customized            mine ≠ base                 (the user edited it)
//   update available      base ≠ shipped              (Loom shipped a newer asset)
//   customized · update…  both                        (edited AND a shipped update is waiting)
//   (none)                in sync / pristine
// "Adopt update" 3-way-merges the shipped delta onto the user's edits without losing them.
export default function Skills() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0); // bumped on reset/adopt to remount the editor onto fresh content

  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const current = useQuery({ queryKey: ["skill", selected], queryFn: () => api.skill(selected!), enabled: !!selected });

  // Edition discovery (same shared query key as Platform.tsx → one cached fetch). The dev/self-host
  // edition has a Platform home; an end-user npm install 404s it. "Publish to repo" is dev-only — held
  // hidden until this settles so an end user never flashes it.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = platformHome.isSuccess && !!platformHome.data?.project;

  const create = useMutation({
    mutationFn: (name: string) => api.createSkill(name),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["skills"] }); setSelected(r.name); setNewName(""); },
  });
  const save = useMutation({
    mutationFn: (v: { name: string; content: string }) => api.saveSkill(v.name, v.content),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ["skills"] }); qc.invalidateQueries({ queryKey: ["skill", v.name] }); },
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.deleteSkill(name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["skills"] }); setSelected(null); },
  });
  const reset = useMutation({
    mutationFn: (name: string) => api.resetSkill(name),
    onSuccess: (r) => {
      qc.setQueryData(["skill", r.name], { name: r.name, content: r.content }); // sync editor to shipped content (no refetch race)
      qc.invalidateQueries({ queryKey: ["skills"] });
      setReloadNonce((n) => n + 1); // remount the editor onto the restored content
    },
  });
  // Adopt the shipped update: empty content one-clicks a clean auto-merge; resolved full content lands a
  // conflict resolution. Mirrors `reset` — refresh the editor onto the merged content and remount it,
  // which also closes the resolver (the editor's local state resets on the key change).
  const adopt = useMutation({
    mutationFn: (content?: string) => api.adoptSkill(selected!, content),
    onSuccess: (r) => {
      qc.setQueryData(["skill", r.name], { name: r.name, content: r.content });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", r.name, "update-diff"] });
      setReloadNonce((n) => n + 1);
    },
  });
  const publish = useMutation({
    mutationFn: (name: string) => api.publishSkill(name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["skills"] }); }, // refetch clears the update-available flag (base advances)
  });

  const validNew = /^[a-z0-9][a-z0-9-]{0,63}$/.test(newName);
  const selectedSkill = skills.data?.find((s) => s.name === selected);
  const bundled = selectedSkill?.bundled ?? false;
  const customized = !!selectedSkill?.customized;
  const updateAvailable = !!selectedSkill?.updateAvailable;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
      <Panel style={{ alignSelf: "start" }}>
        <SectionLabel>Skills</SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "0 0 10px", fontFamily: font.mono, lineHeight: 1.5 }}>
          Loom's own skills, injected into every session as project-local — they shadow your personal
          <code> ~/.claude/skills</code>. Edits apply on the next spawn.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {skills.data?.map((s) => (
            <Button key={s.name} variant={s.name === selected ? "primary" : "default"}
              style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}
              onClick={() => setSelected(s.name)} title={s.description || s.name}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.name}<span style={{ color: color.textMuted }}>{s.bundled ? "  ·  bundled" : "  ·  local"}</span>
              </span>
              <StatusDots customized={!!s.customized} updateAvailable={!!s.updateAvailable} />
            </Button>
          ))}
          {skills.data?.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No skills yet.</span>}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
          <Input placeholder="new-skill-name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
          <Button variant="primary" disabled={!validNew || create.isPending} onClick={() => create.mutate(newName)}>+ New</Button>
        </div>
      </Panel>

      <Panel style={{ minHeight: "72vh", padding: 12 }}>
        {selected && current.data ? (
          <SkillEditor key={`${selected}:${reloadNonce}`} name={selected} content={current.data.content}
            bundled={bundled} customized={customized} updateAvailable={updateAvailable} canPublish={isDev}
            onSave={(content) => save.mutate({ name: selected, content })} saving={save.isPending}
            onDelete={() => remove.mutate(selected)} deleting={remove.isPending}
            onReset={() => reset.mutate(selected)} resetting={reset.isPending}
            onAdopt={(content) => adopt.mutate(content)} adopting={adopt.isPending} adoptError={adopt.error as Error | null}
            onPublish={() => publish.mutate(selected)} publishing={publish.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a skill to edit its SKILL.md, or create a new one.</p>}
      </Panel>
    </div>
  );
}

// Compact sidebar status: a cyan dot for "customized", an amber dot for "update available". Restrained —
// the full-text badges live in the editor header; here it's a glanceable signal with a hover title.
function StatusDots({ customized, updateAvailable }: { customized: boolean; updateAvailable: boolean }) {
  if (!customized && !updateAvailable) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      {customized && <Dot tone="cyan" title="Customized — you edited this skill" />}
      {updateAvailable && <Dot tone="amber" title="Update available — Loom shipped a newer version" />}
    </span>
  );
}
function Dot({ tone, title }: { tone: Tone; title: string }) {
  const c = { cyan: color.cyan, amber: color.amber } as Record<string, string>;
  return <span title={title} style={{ width: 7, height: 7, borderRadius: 7, background: c[tone] ?? color.textMuted, display: "inline-block" }} />;
}

// Remounted per skill (key=name:nonce) so the textarea resets on switch / reset / adopt; after Save the
// query refetches and `dirty` clears against the new content. Mirrors the agent-preset / task editors.
function SkillEditor({
  name, content, bundled, customized, updateAvailable, canPublish,
  onSave, saving, onDelete, deleting, onReset, resetting, onAdopt, adopting, adoptError, onPublish, publishing,
}: {
  name: string; content: string; bundled: boolean; customized: boolean; updateAvailable: boolean; canPublish: boolean;
  onSave: (c: string) => void; saving: boolean; onDelete: () => void; deleting: boolean;
  onReset: () => void; resetting: boolean; onAdopt: (content?: string) => void; adopting: boolean; adoptError: Error | null;
  onPublish: () => void; publishing: boolean;
}) {
  const [text, setText] = useState(content);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [resolver, setResolver] = useState<(SkillMergePreview & { clean: false }) | null>(null);
  const dirty = text !== content;

  // Adopt step 1 — dry-run the merge. Clean → one-click adopt (empty body). Conflict → open the resolver.
  const preview = useMutation({
    mutationFn: () => api.skillMergePreview(name),
    onSuccess: (p) => { if (p.clean) onAdopt(undefined); else setResolver(p); },
  });
  const adoptBusy = preview.isPending || adopting;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{name}</strong>
        {bundled && <Badge tone="muted">bundled</Badge>}
        {customized && <Badge tone="cyan">customized</Badge>}
        {updateAvailable && <Badge tone="amber">update available</Badge>}
        <span style={{ color: color.textMuted, fontSize: 12 }}>· SKILL.md</span>
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete {name}?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>}
      </div>

      {/* Update banner — only when Loom has shipped a newer version. Groups the adopt affordance with a
          "what shipped changed" expander so the user sees the incoming change before adopting. */}
      {updateAvailable && (
        <UpdateBanner name={name} onAdopt={() => preview.mutate()} adoptBusy={adoptBusy}
          error={(preview.error as Error | null) ?? adoptError} />
      )}

      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 360, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 10,
        }} />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(text)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setText(content)}>Discard changes</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        {bundled && canPublish && (confirmPublish ? (
          <>
            <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>write store edits into the repo asset?</span>
            <Button variant="primary" disabled={publishing} onClick={() => { onPublish(); setConfirmPublish(false); }}>Publish</Button>
            <Button onClick={() => setConfirmPublish(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmPublish(true)} title="Write this skill's store edits back into the repo's bundled asset (you commit it)">Publish to repo</Button>)}
        {bundled && (confirmReset ? (
          <>
            <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>discard edits & restore shipped?</span>
            <Button variant="danger" disabled={resetting} onClick={onReset}>Reset</Button>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmReset(true)} title="Discard your edits and restore this skill to its shipped version">Reset to shipped</Button>)}
      </div>

      {resolver && (
        <ConflictResolver name={name} preview={resolver} applying={adopting} error={adoptError}
          onApply={(resolved) => onAdopt(resolved)} onCancel={() => setResolver(null)} />
      )}
    </div>
  );
}

// "Update available" banner: the adopt button + a collapsible base→shipped diff so the user previews the
// incoming change before adopting. Amber hairline, not a filled block — restrained signal of state.
function UpdateBanner({ name, onAdopt, adoptBusy, error }: { name: string; onAdopt: () => void; adoptBusy: boolean; error: Error | null }) {
  const [showDiff, setShowDiff] = useState(false);
  const diff = useQuery({
    queryKey: ["skill", name, "update-diff"],
    queryFn: () => api.skillUpdateDiff(name),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.amber}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.panel2, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>
          Loom shipped an update to this skill.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide changes" : "What changed"}</Button>
        <Button variant="primary" disabled={adoptBusy} onClick={onAdopt} title="Merge the shipped update onto your edits">
          {adoptBusy ? "Adopting…" : "Adopt update"}
        </Button>
      </div>
      {error && <span style={{ color: color.red, fontFamily: font.mono, fontSize: 11 }}>{error.message}</span>}
      {showDiff && (
        diff.isLoading ? <span style={{ color: color.textMuted, fontSize: 12 }}>Loading diff…</span>
        : diff.data ? <LineDiff base={diff.data.base} shipped={diff.data.shipped} />
        : <span style={{ color: color.red, fontSize: 12 }}>Couldn't load the diff.</span>
      )}
    </div>
  );
}

// Conflict resolver: a focused overlay. The 3-way merge couldn't auto-apply because the shipped update
// overlaps the user's edits — so per hunk they keep theirs or take the shipped version. We assemble the
// full file from those choices and POST it. (Per-hunk accept/reject; a resolved preview shows the result.)
function ConflictResolver({
  name, preview, onApply, onCancel, applying, error,
}: { name: string; preview: SkillMergePreview & { clean: false }; onApply: (content: string) => void; onCancel: () => void; applying: boolean; error: Error | null }) {
  const parts = useMemo(() => parseMerged(preview.merged), [preview.merged]);
  const conflictCount = parts.filter((p) => p.kind === "conflict").length;
  // Default every hunk to "mine" — preserve the user's edits unless they explicitly take the shipped side.
  const [choices, setChoices] = useState<("mine" | "shipped")[]>(() => new Array(conflictCount).fill("mine"));
  const [showPreview, setShowPreview] = useState(false);
  const resolved = useMemo(() => assemble(parts, choices), [parts, choices]);

  let ci = -1; // running conflict index as we walk the parts in document order
  return (
    <div role="dialog" aria-label={`Resolve update conflicts for ${name}`}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: "8vh", zIndex: 1000 }}
      onClick={onCancel}>
      <Panel style={{ width: "min(920px, 92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column", padding: 0 }}>
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${color.border}` }}>
            <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Resolve update</strong>
            <Badge tone="cyan">{name}</Badge>
            <span style={{ color: color.textMuted, fontSize: 12 }}>
              {conflictCount} conflicting {conflictCount === 1 ? "hunk" : "hunks"} — keep yours or take shipped
            </span>
            <span style={{ flex: 1 }} />
            <Button onClick={onCancel}>Cancel</Button>
          </div>

          <div style={{ overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            {parts.map((p, i) => {
              if (p.kind !== "conflict") return null;
              ci += 1;
              const idx = ci;
              const choice = choices[idx];
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>Conflict {idx + 1}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <HunkSide label="Your version" tone="cyan" active={choice === "mine"} lines={p.mine}
                      onPick={() => setChoices((c) => c.map((v, k) => (k === idx ? "mine" : v)))} />
                    <HunkSide label="Shipped version" tone="amber" active={choice === "shipped"} lines={p.shipped}
                      onPick={() => setChoices((c) => c.map((v, k) => (k === idx ? "shipped" : v)))} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${color.border}`, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            {showPreview && (
              <pre style={{ margin: 0, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
                fontFamily: font.mono, fontSize: 12, lineHeight: 1.5, color: color.textDim,
                background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: 8 }}>
                {resolved.replace(/\r/g, "")}
              </pre>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide result" : "Preview result"}</Button>
              {error && <span style={{ color: color.red, fontFamily: font.mono, fontSize: 11 }}>{error.message}</span>}
              <span style={{ flex: 1 }} />
              <Button variant="primary" disabled={applying} onClick={() => onApply(resolved)}>
                {applying ? "Adopting…" : "Adopt resolved"}
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// One side of a conflict hunk — clickable to select. The active side gets a phosphor border; the other
// reads dim, so the chosen resolution is obvious at a glance.
function HunkSide({ label, tone, active, lines, onPick }: { label: string; tone: Tone; active: boolean; lines: string[]; onPick: () => void }) {
  const accent = tone === "cyan" ? color.cyan : color.amber;
  return (
    <button onClick={onPick} title={`Keep this version (${label})`}
      style={{ textAlign: "left", cursor: "pointer", borderRadius: radius.sm, padding: 8,
        background: active ? color.panel : color.panel2,
        border: `1px solid ${active ? color.phosphor : color.border}`,
        boxShadow: active ? `inset 0 0 0 1px ${color.phosphorDim}` : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: accent, display: "inline-block" }} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: active ? color.phosphor : color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {label}{active ? " ✓" : ""}
        </span>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: 12,
        lineHeight: 1.5, color: active ? color.text : color.textMuted }}>
        {lines.length ? lines.join("\n").replace(/\r/g, "") : <span style={{ color: color.textMuted }}>(empty — removes these lines)</span>}
      </pre>
    </button>
  );
}

// "What shipped changed": a computed line diff of base → shipped (green additions / red removals). Long
// unchanged runs collapse to a fold so the eye lands on the change. SKILL.md files are small, so the
// O(n·m) LCS is fine.
function LineDiff({ base, shipped }: { base: string; shipped: string }) {
  const rows = useMemo(() => collapse(diffLines(base, shipped)), [base, shipped]);
  if (rows.every((r) => r.t === " " || r.t === "fold")) {
    return <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No textual change.</span>;
  }
  return (
    <pre style={{ margin: 0, maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
      fontFamily: font.mono, fontSize: 12, lineHeight: 1.5,
      background: color.panel, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: 8 }}>
      {rows.map((r, i) => {
        if (r.t === "fold") return <div key={i} style={{ color: color.textMuted }}>{`  ⋯ ${r.n} unchanged ${r.n === 1 ? "line" : "lines"}`}</div>;
        const c = r.t === "+" ? color.phosphor : r.t === "-" ? color.red : color.textDim;
        const text = r.text.replace(/\r$/, "");
        return <div key={i} style={{ color: c }}>{`${r.t} ${text}`}</div>;
      })}
    </pre>
  );
}

// --- merge / diff helpers (pure) ----------------------------------------------------------------

type Part = { kind: "text"; lines: string[] } | { kind: "conflict"; mine: string[]; base: string[]; shipped: string[] };

// Split a git-style 3-way merge into ordered plain-text and conflict regions. Marker lines may carry a
// trailing \r (CRLF assets), so we key on the leading marker only and keep every other line verbatim;
// split("\n")→join("\n") is lossless, so reassembly preserves the original line endings exactly.
function parseMerged(merged: string): Part[] {
  const lines = merged.split("\n");
  const parts: Part[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith("<<<<<<<")) {
      if (text.length) { parts.push({ kind: "text", lines: text }); text = []; }
      i++; // skip "<<<<<<< mine"
      const mine: string[] = [], base: string[] = [], shipped: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("|||||||")) mine.push(lines[i++]!);
      i++; // skip "||||||| base"
      while (i < lines.length && !lines[i]!.startsWith("=======")) base.push(lines[i++]!);
      i++; // skip "======="
      while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) shipped.push(lines[i++]!);
      i++; // skip ">>>>>>> shipped"
      parts.push({ kind: "conflict", mine, base, shipped });
    } else {
      text.push(lines[i++]!);
    }
  }
  if (text.length) parts.push({ kind: "text", lines: text });
  return parts;
}

// Reassemble the full file from per-hunk choices: plain text verbatim, chosen side per conflict.
function assemble(parts: Part[], choices: ("mine" | "shipped")[]): string {
  let ci = 0;
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") out.push(...p.lines);
    else { const c = choices[ci++] ?? "mine"; out.push(...(c === "shipped" ? p.shipped : p.mine)); }
  }
  return out.join("\n");
}

type DLine = { t: "+" | "-" | " "; text: string };
// Line-level LCS diff. Backtracks a forward DP so equal lines are " ", base-only "-", shipped-only "+".
function diffLines(a: string, b: string): DLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: " ", text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ t: "-", text: A[i]! }); i++; }
    else { out.push({ t: "+", text: B[j]! }); j++; }
  }
  while (i < n) out.push({ t: "-", text: A[i++]! });
  while (j < m) out.push({ t: "+", text: B[j++]! });
  return out;
}

type DiffRow = DLine | { t: "fold"; n: number };
// Collapse runs of >CONTEXT unchanged lines into a fold marker, keeping CONTEXT lines around each change.
function collapse(lines: DLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.t !== " ") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) { out.push(lines[i]!); i++; continue; }
    let n = 0;
    while (i < lines.length && !keep[i]) { n++; i++; }
    out.push({ t: "fold", n });
  }
  return out;
}
