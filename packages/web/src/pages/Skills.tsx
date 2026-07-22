import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type SkillMergePreview, type SkillFileState } from "../lib/api";
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
  // SKILL.md-only pair (NOT the OR'd aggregate above) — gates the destructive DivergedBanner below,
  // which offers "sync to shipped" against a SKILL.md diff. A reference/script file has no edit surface
  // and no diff UI of its own, so a reference-file-only divergence must never trigger that banner: it'd
  // show an empty diff and offer to discard the very edit the daemon's per-file protection preserves.
  const mdCustomized = !!selectedSkill?.mdCustomized;
  const mdUpdateAvailable = !!selectedSkill?.mdUpdateAvailable;

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
            bundled={bundled} customized={customized} updateAvailable={updateAvailable}
            mdCustomized={mdCustomized} mdUpdateAvailable={mdUpdateAvailable} canPublish={isDev}
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
  name, content, bundled, customized, updateAvailable, mdCustomized, mdUpdateAvailable, canPublish,
  onSave, saving, onDelete, deleting, onReset, resetting, onAdopt, adopting, adoptError, onPublish, publishing,
}: {
  name: string; content: string; bundled: boolean; customized: boolean; updateAvailable: boolean;
  mdCustomized: boolean; mdUpdateAvailable: boolean; canPublish: boolean;
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

      {/* Diverged banner — SKILL.md itself customized but no shipped SKILL.md update pending (mine ≠ base,
          base == shipped, SKILL.md-only — NOT the OR'd aggregate). This ALSO catches the "mine behind
          both" staleness state (board card dd940682), which is data-identical to an ordinary
          customization: either way SKILL.md's served copy differs from the current shipped version.
          adopt can't help (it's gated on updateAvailable), so we surface a compare + a clear sync-to-shipped
          path instead of leaving the divergence invisible behind the "customized" badge alone.
          Deliberately scoped to mdCustomized/mdUpdateAvailable (board card 75a0755d, CR M3) and it STAYS
          that way now that the per-file compare exists (board card c01fd791 — decided, not pending): this
          banner's "Sync to shipped" is a WHOLE-DIRECTORY discard, so widening its trigger to a reference-
          file divergence would offer a discard broader than the diff justifying it — the same defect in a
          new shape. A supporting file's divergence is surfaced by FilesDivergedBanner below instead, which
          resolves it PER FILE behind that file's own diff. The only directory-wide discard remains the
          explicit "Reset to shipped" button. */}
      {mdCustomized && !mdUpdateAvailable && (
        <DivergedBanner name={name} mine={content} onSync={onReset} syncing={resetting} />
      )}

      {/* Supporting files (references/**, scripts/**) diverge with no shipped update pending anywhere.
          The `!updateAvailable` gate keeps this from double-reporting what UpdateBanner's file list
          already covers; the banner self-suppresses if no supporting file actually diverges. */}
      {bundled && customized && !updateAvailable && <FilesDivergedBanner name={name} />}

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
        : diff.data ? <FileDiffList name={name} files={diff.data.files} />
        : <span style={{ color: color.red, fontSize: 12 }}>Couldn't load the diff.</span>
      )}
    </div>
  );
}

// Reference/script files diverge but NO shipped update is pending anywhere in the skill (board card
// c01fd791, residual state 1). These files have no editor and no diff of their own, so before this they
// showed only as a sidebar dot with nothing to inspect and no remedy short of Reset — a whole-directory
// discard. Here they get a real per-file diff and a per-file resolution.
//
// Gated by the caller on `customized && !updateAvailable`, then renders NOTHING unless a non-SKILL.md
// file actually diverges — so the SKILL.md-only case (already served by DivergedBanner) shows no second
// banner. The query key is the SAME one both other banners' expanders use, so react-query serves it from
// cache rather than issuing an extra read.
function FilesDivergedBanner({ name }: { name: string }) {
  const [showFiles, setShowFiles] = useState(false);
  const diff = useQuery({ queryKey: ["skill", name, "update-diff"], queryFn: () => api.skillUpdateDiff(name) });
  const diverged = (diff.data?.files ?? []).filter((f) => f.path !== "SKILL.md" && (f.customized || f.updateAvailable));
  if (!diverged.length) return null;
  return (
    <div style={{ border: `1px solid ${color.cyan}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.panel2, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.cyan, fontFamily: font.mono, fontSize: 12 }}>
          {diverged.length} supporting {diverged.length === 1 ? "file differs" : "files differ"} from the shipped version.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowFiles((v) => !v)}>{showFiles ? "Hide files" : "Review files"}</Button>
      </div>
      {showFiles && <FileDiffList name={name} files={diff.data!.files} />}
    </div>
  );
}

// The per-file compare view. Lists every tracked file that diverges — SKILL.md alongside references/**
// and scripts/** — so "which file changed" is answerable instead of implied. Rows are collapsed by
// default and fetch their content only when expanded (the summary carries flags only).
function FileDiffList({ name, files }: {
  name: string; files: SkillFileState[];
}) {
  const diverged = files.filter((f) => f.customized || f.updateAvailable);
  if (!diverged.length) {
    return <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No file differs from the shipped version.</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {diverged.map((f) => <FileDiffRow key={f.path} name={name} file={f} />)}
    </div>
  );
}

// One file's row: path + its own state chips, expanding to a real diff and (for a supporting file) the
// resolution buttons. The buttons are rendered ONLY inside the expanded body, below the diff — the
// card's governing constraint is that no discard is ever offered behind a diff that doesn't show what
// is being discarded, so the diff is structurally the precondition for the action, not a sibling of it.
// EVERY row — SKILL.md included — gets its content from `skillFileDiff`, never from the summary read.
// The summary carries `base`/`shipped` but NOT `mine`, so an earlier shortcut that rendered SKILL.md
// from it had to substitute `base` for `mine` — which made the "Your edits (base → your copy)" block
// render LineDiff(base, base): reliably EMPTY for the common customized-AND-updateAvailable state, under
// a label explicitly promising the user's own edits, right beside a destructive button. That is this
// card's own defect (a diff that doesn't show what it claims) pointed at a different pane. One extra
// lazy fetch when a row is expanded is the correct price; `skillFileDiff` accepts SKILL.md precisely so
// this path can stay uniform.
function FileDiffRow({ name, file }: { name: string; file: SkillFileState }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmTake, setConfirmTake] = useState(false);
  const diff = useQuery({
    queryKey: ["skill", name, "file-diff", file.path],
    queryFn: () => api.skillFileDiff(name, file.path),
    enabled: open, // content tier: fetched only when this row is actually expanded
  });
  // Resolve one file. `meta.inlineError` is REQUIRED, not decorative: main.tsx installs a global
  // MutationCache onError that window.alert()s every failed mutation, so without the opt-out a stale-
  // shipped 409 would render inline here AND pop a blocking modal on top of it.
  const resolve = useMutation({
    mutationFn: (take: "mine" | "shipped") => api.resolveSkillFile(name, file.path, take, diff.data!.shippedHash),
    meta: { inlineError: true },
    onSuccess: () => {
      setConfirmTake(false);
      qc.invalidateQueries({ queryKey: ["skills"] });                            // clears the dot + header badge
      qc.invalidateQueries({ queryKey: ["skill", name, "update-diff"] });         // re-reads the per-file summary
      qc.invalidateQueries({ queryKey: ["skill", name, "file-diff", file.path] });
    },
  });

  const resolvable = file.path !== "SKILL.md";
  const d = diff.data;
  return (
    <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.sm, background: color.panel }}>
      <button onClick={() => setOpen((v) => !v)} title={open ? `Hide ${file.path}` : `Show what differs in ${file.path}`}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "6px 8px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text, flexShrink: 0 }}>{file.path}</span>
        {file.customized && <Badge tone="cyan">customized</Badge>}
        {file.updateAvailable && <Badge tone="amber">update available</Badge>}
      </button>
      {open && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          {!d ? (
            diff.isLoading ? <span style={{ color: color.textMuted, fontSize: 12 }}>Loading diff…</span>
              : <span style={{ color: color.red, fontSize: 12 }}>Couldn't load this file's diff.</span>
          ) : file.customized && file.updateAvailable ? (
            // BOTH — the state that had no non-destructive exit. Show the two changes SEPARATELY, each
            // anchored on the common base, so "what I changed" and "what Loom changed" stay legible
            // instead of collapsing into one confusing mine-vs-shipped diff.
            <>
              <DiffBlock kind="mine" label="Your edits (base → your copy)" tone="cyan"><LineDiff base={d.base} shipped={d.mine} /></DiffBlock>
              <DiffBlock kind="shipped" label="What Loom shipped (base → shipped)" tone="amber"><LineDiff base={d.base} shipped={d.shipped} /></DiffBlock>
            </>
          ) : file.customized ? (
            <DiffBlock kind="mine" label="Your copy vs shipped" tone="cyan"><LineDiff base={d.shipped} shipped={d.mine} /></DiffBlock>
          ) : (
            <DiffBlock kind="shipped" label="What Loom shipped (base → shipped)" tone="amber"><LineDiff base={d.base} shipped={d.shipped} /></DiffBlock>
          )}

          {resolve.error && (
            <span style={{ color: color.red, fontFamily: font.mono, fontSize: 11 }}>{(resolve.error as Error).message}</span>
          )}

          {resolvable && d && file.customized && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {file.updateAvailable && (
                <Button disabled={resolve.isPending} onClick={() => resolve.mutate("mine")}
                  title="Keep your version of this file and stop offering the shipped update — nothing is discarded">
                  {resolve.isPending ? "Working…" : "Keep mine"}
                </Button>
              )}
              <span style={{ flex: 1 }} />
              {confirmTake ? (
                <>
                  <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>discard your edits to this file?</span>
                  <Button variant="danger" disabled={resolve.isPending} onClick={() => resolve.mutate("shipped")}>Take shipped</Button>
                  <Button onClick={() => setConfirmTake(false)}>Cancel</Button>
                </>
              ) : (
                <Button onClick={() => setConfirmTake(true)} title="Replace your version of this file with the shipped one">
                  Take shipped
                </Button>
              )}
            </div>
          )}
          {resolvable && file.updateAvailable && !file.customized && (
            <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 11 }}>
              You haven't edited this file — adopting the update syncs it automatically.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// A labelled diff block. The label carries the reading direction ("base → your copy"), which is what
// makes the two-diff state-3 view legible; the tone dot matches the badge colour for the same concept.
// `kind` is emitted as data-diff-kind so a test can assert on the contents of THIS pane specifically —
// a page-wide text assertion is satisfiable by the same text appearing in the sibling diff or the
// editor below, which is precisely how a first attempt at the regression pin passed against the bug.
function DiffBlock({ kind, label, tone, children }: { kind: "mine" | "shipped"; label: string; tone: Tone; children: ReactNode }) {
  const accent = tone === "cyan" ? color.cyan : color.amber;
  return (
    <div data-diff-kind={kind} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11,
        color: color.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: accent, display: "inline-block", flexShrink: 0 }} />
        {label}
      </span>
      {children}
    </div>
  );
}

// "Diverged from shipped" banner: shown when the store copy differs from the current shipped version but
// NO Loom update is pending (customized · not update-available). Covers two indistinguishable cases — an
// intentional user edit, and the adopt-staleness state where `mine` was left behind older than shipped
// (card dd940682). Either way the user can preview the divergence (their copy vs shipped) and, if they
// didn't mean to keep edits, sync to the current shipped content via reset (mine=base=shipped). Cyan
// hairline (a neutral state signal), distinct from the amber "update available" banner.
function DivergedBanner({ name, mine, onSync, syncing }: { name: string; mine: string; onSync: () => void; syncing: boolean }) {
  const [showDiff, setShowDiff] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  // update-diff returns { base, shipped } for any bundled skill (no update-available guard), so it's the
  // way to fetch the current shipped content here. We diff the SAVED store copy (`mine`) against shipped.
  const diff = useQuery({
    queryKey: ["skill", name, "update-diff"],
    queryFn: () => api.skillUpdateDiff(name),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.cyan}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.panel2, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.cyan, fontFamily: font.mono, fontSize: 12 }}>
          Your saved copy differs from the current shipped version.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide differences" : "Compare with shipped"}</Button>
        {confirmSync ? (
          <>
            <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>discard your copy & sync?</span>
            <Button variant="danger" disabled={syncing} onClick={onSync}>Sync</Button>
            <Button onClick={() => setConfirmSync(false)}>Cancel</Button>
          </>
        ) : (
          <Button onClick={() => setConfirmSync(true)} title="Discard your copy and sync this skill to the current shipped version">
            Sync to shipped
          </Button>
        )}
      </div>
      {showDiff && (
        diff.isLoading ? <span style={{ color: color.textMuted, fontSize: 12 }}>Loading diff…</span>
        : diff.data ? <LineDiff base={mine} shipped={diff.data.shipped} />
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
// Comparison strips a trailing \r so a CRLF/LF skew between base and shipped doesn't read as whole-file
// churn (mirrors the daemon's normalizeForCompare tolerance); display keeps the raw text (`text`).
function diffLines(a: string, b: string): DLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const An = A.map((l) => l.replace(/\r$/, "")), Bn = B.map((l) => l.replace(/\r$/, ""));
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = An[i] === Bn[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (An[i] === Bn[j]) { out.push({ t: " ", text: A[i]! }); i++; j++; }
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
