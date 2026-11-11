import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SkillPermissionVector } from "@loom/shared";
import { api, type SkillMergePreview, type SkillFileState } from "../lib/api";
import { LineDiff } from "../components/LineDiff";
import { Panel, Button, Input, SectionLabel, Badge, Segmented, Explainer } from "../components/ui";
import Markdown from "../components/Markdown";
import { DotLegend, GuideList, RowDescription, matchesFilter } from "../components/actorList";
import { color, font, radius, toneFill, type Tone, fs } from "../theme";
import { errorText } from "../lib/loopbackCredential";

// Loom's OWN skill set — the editable store (~/.loom/skills) that the daemon injects into every
// session as project-local skills, leaving the user's personal ~/.claude/skills untouched. Edits
// apply on the next spawn (skills are read at session start).
//
// @decision d63585ca — a PERSONAL skill beats a project-local one of the same name, so the copy on
// this page must never tell the user Loom's skills shadow theirs; it is the opposite.
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

  const skills = useQuery({ queryKey: ["skills"], queryFn: ({ signal }) => api.skills(signal) });
  const current = useQuery({ queryKey: ["skill", selected], queryFn: ({ signal }) => api.skill(selected!, signal), enabled: !!selected });

  // Edition discovery (same shared query key as Platform.tsx → one cached fetch). The dev/self-host
  // edition has a Platform home; an end-user npm install gets `project: null` back (card 8d82be67 — the
  // route is always 200). "Publish to repo" is dev-only — held hidden until this settles so an end user
  // never flashes it.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: ({ signal }) => api.platformHome(signal), retry: false });
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
    meta: { inlineError: true },
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

  const [filter, setFilter] = useState("");
  const filtered = (skills.data ?? []).filter((s) => matchesFilter(filter, s.name, s.description));
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
  // User (non-bundled) skills only — card 509176c8: a locked role's deliver-all default withholds any
  // user skill that isn't stamped "human", so an agent-written or unstamped one silently never reaches a
  // Companion/Setup/etc. session. `provenance` is undefined for a bundled skill (not applicable there).
  const provenance = selectedSkill?.provenance ?? null;
  // card 87a51903 — read off the LIST entry (not the single-skill read) so the sidebar dot and the
  // editor banner can never disagree about the same skill; both are derived from one server scan.
  const permissionVectors = selectedSkill?.permissionWidening ?? [];

  return (
    // The list→editor shell, shared with Profiles (the Actors page's other body) — tracks and the phone
    // fold live in `.loom-actor-split` (styles/global.css); an inline `300px 1fr` here overflowed the
    // page at 390px.
    <div className="loom-actor-split">
      <Panel style={{ alignSelf: "start" }}>
        <SectionLabel>Skills</SectionLabel>
        <Explainer style={{ marginBottom: 10 }}>
          Loom's own skills, injected into every session as project-local — your personal
          <code> ~/.claude/skills</code> is untouched and takes precedence, so Loom's names are chosen
          not to collide. Edits apply on the next spawn.
        </Explainer>
        {/* Same filter shape as the Projects rail (audit A-32): one Input, matching name + description. */}
        {!!skills.data?.length && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Input placeholder="Filter skills…" value={filter} onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter skills" style={{ flex: 1, minWidth: 0 }} />
            <span data-testid="skills-filter-count" style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3, flexShrink: 0 }}>
              {filtered.length === skills.data.length ? skills.data.length : `${filtered.length}/${skills.data.length}`}
            </span>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {filtered.map((s) => (
            // Selection reads as `loom-btn-on`, never the primary CTA fill, so the muted "· bundled" stays
            // legible on a selected row (audit A-09). Same treatment as the Profiles list.
            <Button key={s.name} data-testid={`skill-row-${s.name}`} className={s.name === selected ? "loom-btn-on" : undefined} aria-pressed={s.name === selected}
              style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}
              onClick={() => setSelected(s.name)} title={s.description || s.name}>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}<span style={{ color: color.text3 }}>{s.bundled ? "  ·  bundled" : "  ·  local"}</span>
                </span>
                {s.description && <RowDescription text={s.description} />}
              </span>
              <StatusDots customized={!!s.customized} updateAvailable={!!s.updateAvailable}
                notTrusted={!s.bundled && s.provenance !== "human"}
                vectors={s.permissionWidening ?? []} />
            </Button>
          ))}
          {skills.data?.length === 0 && <span style={{ color: color.text3, fontSize: fs.sm }}>No skills yet.</span>}
          {!!skills.data?.length && filtered.length === 0 && (
            <span style={{ color: color.text3, fontSize: fs.sm }}>No skills match the filter.</span>
          )}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
          <Input placeholder="new-skill-name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <Button variant="primary" disabled={!validNew || create.isPending} onClick={() => create.mutate(newName)}>+ New</Button>
        </div>
      </Panel>

      <Panel style={{ minHeight: "72vh", padding: 12 }}>
        {selected && current.data ? (
          <SkillEditor key={`${selected}:${reloadNonce}`} name={selected} content={current.data.content}
            bundled={bundled} customized={customized} updateAvailable={updateAvailable}
            mdCustomized={mdCustomized} mdUpdateAvailable={mdUpdateAvailable} provenance={provenance} canPublish={isDev}
            permissionVectors={permissionVectors}
            onSave={(content) => save.mutate({ name: selected, content })} saving={save.isPending}
            onDelete={() => remove.mutate(selected)} deleting={remove.isPending}
            onReset={() => reset.mutate(selected)} resetting={reset.isPending}
            onAdopt={(content) => adopt.mutate(content)} adopting={adopt.isPending} adoptError={adopt.error as Error | null}
            onPublish={() => publish.mutate(selected)} publishing={publish.isPending} />
        ) : <SkillsGuide count={skills.data?.length ?? null} />}
      </Panel>
    </div>
  );
}

// The editor pane before anything is selected (audit A-40). It used to be one grey sentence over ~830px
// of nothing; now it says what to do and decodes the list's status dots, which otherwise only explain
// themselves on hover. The lead sentence is kept verbatim (e2e skills.spec.ts reads it).
function SkillsGuide({ count }: { count: number | null }) {
  return (
    <div data-testid="skills-guide" style={{ padding: 12, maxWidth: 560, display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, color: color.text2, lineHeight: 1.5 }}>
        {count === 0
          ? "No skills yet. Type a name in the box beside + New (lowercase letters, digits and dashes) to make the first one."
          : "Select a skill to edit its SKILL.md, or create a new one."}
      </p>
      <GuideList items={[
        ["bundled", "Ships with Loom. Your edits are kept, and Loom offers its own updates for you to adopt."],
        ["local", "Created here. It is yours to edit or delete."],
        ["Preview", "Reads the SKILL.md as formatted text. Edit switches back to the source."],
      ]} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel style={{ margin: 0 }}>List markers</SectionLabel>
        <DotLegend tone="muted" label="Customized: you edited this skill" />
        <DotLegend tone="attn" label="Update available, or not delivered to locked roles (hover the dot)" />
        <DotLegend tone="danger" label="Grants tools or runs shell when it loads" />
      </div>
    </div>
  );
}

// Compact sidebar status: a muted dot for "customized", an attn dot for "update available". Restrained —
// the full-text badges live in the editor header; here it's a glanceable signal with a hover title.
// The permission-widening dot is RED, the one red signal on this page: amber already carries two
// unrelated states here, and this ranks above both (card 87a51903).
function StatusDots({ customized, updateAvailable, notTrusted, vectors }: {
  customized: boolean; updateAvailable: boolean; notTrusted: boolean; vectors: SkillPermissionVector[];
}) {
  if (!customized && !updateAvailable && !notTrusted && !vectors.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      {customized && <Dot tone="muted" title="Customized — you edited this skill" />}
      {updateAvailable && <Dot tone="attn" title="Update available — Loom shipped a newer version" />}
      {notTrusted && <Dot tone="attn" title="Not delivered to locked roles (Companion, Setup…) — save it here to trust it" />}
      {!!vectors.length && <Dot tone="danger" title={`${PERMISSION_SIGNAL_LABEL}: ${vectors.map((v) => PERMISSION_VECTORS[v].code).join(", ")}`} />}
    </span>
  );
}
function Dot({ tone, title }: { tone: Tone; title: string }) {
  return <span title={title} style={{ width: 7, height: 7, borderRadius: radius.base, background: toneFill[tone], display: "inline-block" }} />;
}

// --- Permission-widening disclosure (card 87a51903) -------------------------------------------------
// Claude Code's skill loader honours these with no workspace-trust gate, so a skill carrying one does
// more than its text implies. Loom deliberately does NOT strip them — a human-written skill may want
// them, the same trust tier as a permission allowDelta — so this surface is purely informational.
// Detection is server-side (`skills/permissionWidening.ts`); the copy below is the only place that
// translates a vector id into what it actually does.
//
// @decision 87a51903 — disclose, never strip. Do not turn this notice into a gate, and do not
// re-derive detection in the client: the server field is the one source.
const PERMISSION_SIGNAL_LABEL = "Grants tools or runs shell";
// `code` is the construct VERBATIM, so it doubles as what to search the SKILL.md for; `where` and `does`
// are prose and stay OUTSIDE the code span.
const PERMISSION_VECTORS: Record<SkillPermissionVector, { code: string; where: string; does: string }> = {
  "allowed-tools": {
    code: "allowed-tools:",
    where: "in the frontmatter",
    does: "pre-approves the listed tools for the turn that loads this skill, so those calls skip the permission check",
  },
  hooks: {
    code: "hooks:",
    where: "in the frontmatter",
    does: "registers shell hooks that keep running for the rest of the session, on later turns too — denying tools does not stop them",
  },
  "frontmatter-unrecognized": {
    code: "(unrecognized syntax)",
    where: "in the frontmatter",
    does: "uses a YAML form this scan can't confidently read (a quoted key, a flow mapping, an anchor/alias/tag, …), so it can't rule out a hidden grant",
  },
  "frontmatter-fence-unrecognized": {
    code: "(unrecognized fence)",
    where: "in the frontmatter",
    does: "opens or closes its frontmatter block in a way the installed CLI's own loader reads differently than this scan does, so it can't rule out a hidden grant",
  },
  "shell-inline": {
    code: "!`cmd`",
    where: "in the body",
    does: "runs a shell command when the skill loads, before the agent takes its first turn",
  },
  "shell-fenced": {
    code: "```!",
    where: "in the body",
    does: "runs the block's shell commands when the skill loads, before the agent takes its first turn",
  },
};

// The banner: a red hairline, one row per detected vector — same restrained shape as UpdateBanner's
// amber one, never a filled block. Rendered under the header badge, above the editor, so the reader
// sees what the skill does before they read (or edit) it.
function PermissionWideningBanner({ vectors }: { vectors: SkillPermissionVector[] }) {
  return (
    <div data-testid="skill-permission-warning"
      style={{ border: `1px solid ${color.danger}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
        background: color.inset, display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ color: color.danger, fontSize: fs.sm }}>
        This skill widens what a session can do.
      </span>
      <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        {vectors.map((v) => (
          <li key={v} data-testid={`skill-permission-vector-${v}`}
            style={{ color: color.text2, fontSize: fs.sm, lineHeight: 1.55 }}>
            <code style={{ color: color.text, fontFamily: font.mono }}>{PERMISSION_VECTORS[v].code}</code>{" "}
            {PERMISSION_VECTORS[v].where} — {PERMISSION_VECTORS[v].does}.
          </li>
        ))}
      </ul>
      {/* Separated by a hairline, not by a dimmer tone: `color.text3` measures 3.14:1 on this panel,
          under the 4.5:1 floor for text this size — and this is the line that tells the reader nothing is
          broken, so it must not be the least readable thing in the banner. */}
      <span style={{ color: color.text2, fontSize: fs.sm, lineHeight: 1.55,
        borderTop: `1px solid ${color.line}`, paddingTop: 6 }}>
        Loom does not remove these. If you wrote or installed this skill on purpose, nothing is wrong —
        edit the SKILL.md above to drop them if you didn't mean to.
      </span>
    </div>
  );
}

// Remounted per skill (key=name:nonce) so the textarea resets on switch / reset / adopt; after Save the
// query refetches and `dirty` clears against the new content. Mirrors the agent-preset / task editors.
function SkillEditor({
  name, content, bundled, customized, updateAvailable, mdCustomized, mdUpdateAvailable, provenance, canPublish,
  permissionVectors,
  onSave, saving, onDelete, deleting, onReset, resetting, onAdopt, adopting, adoptError, onPublish, publishing,
}: {
  name: string; content: string; bundled: boolean; customized: boolean; updateAvailable: boolean;
  mdCustomized: boolean; mdUpdateAvailable: boolean; provenance: "agent" | "human" | null; canPublish: boolean;
  permissionVectors: SkillPermissionVector[];
  onSave: (c: string) => void; saving: boolean; onDelete: () => void; deleting: boolean;
  onReset: () => void; resetting: boolean; onAdopt: (content?: string) => void; adopting: boolean; adoptError: Error | null;
  onPublish: () => void; publishing: boolean;
}) {
  const [text, setText] = useState(content);
  const [confirmDel, setConfirmDel] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [resolver, setResolver] = useState<(SkillMergePreview & { clean: false }) | null>(null);
  const dirty = text !== content;
  // "saved" only after a Save in this session has actually landed (card dd83149f, audit A-12): the text
  // this Save wrote must be what the server now serves. A refused write never becomes `content`. The
  // "Save to trust" re-save deliberately does not set it: it writes what is already served, so a refused
  // one would read as saved.
  const [savedText, setSavedText] = useState<string | null>(null);
  const showSaved = !dirty && !saving && savedText !== null && savedText === content;
  // card 509176c8: a user skill not stamped "human" is withheld from every locked-role session (Companion,
  // Setup, …) under their deliver-all default — surface it, and give a way to re-stamp it WITHOUT
  // requiring an edit (the ordinary Save button is disabled with nothing dirty to save).
  const notTrusted = !bundled && provenance !== "human";

  // Adopt step 1 — dry-run the merge. Clean → one-click adopt (empty body). Conflict → open the resolver.
  const preview = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.skillMergePreview(name),
    onSuccess: (p) => { if (p.clean) onAdopt(undefined); else setResolver(p); },
  });
  const adoptBusy = preview.isPending || adopting;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.ui, color: color.text }}>{name}</strong>
        {bundled && <Badge tone="muted">bundled</Badge>}
        {customized && <Badge tone="muted">customized</Badge>}
        {updateAvailable && <Badge tone="attn">update available</Badge>}
        {notTrusted && (
          <span title="Not delivered to locked roles (Companion, Setup, Elevated Operator, Workspace Auditor…) under their deliver-all default — save it here to trust it.">
            <Badge tone="attn">not delivered to locked roles</Badge>
          </span>
        )}
        {!!permissionVectors.length && (
          <span data-testid="skill-permission-badge"
            title={`${PERMISSION_SIGNAL_LABEL}: ${permissionVectors.map((v) => PERMISSION_VECTORS[v].code).join(", ")}`}>
            <Badge tone="danger">{PERMISSION_SIGNAL_LABEL}</Badge>
          </span>
        )}
        <span style={{ color: color.text3, fontSize: fs.sm }}>· SKILL.md</span>
        <span style={{ flex: 1 }} />
        <Segmented ariaLabel="SKILL.md view" value={view} onChange={setView}
          items={[{ key: "edit", label: "Edit" }, { key: "preview", label: "Preview" }]} />
        {/* Delete is a LOCAL-skill action only (audit A-36). On a bundled skill it removed the store copy
            (losing any edits) and the next daemon boot re-seeded the shipped version, so it read as a
            delete but behaved as a delayed reset. "Reset to shipped" below is the honest form of that. */}
        {!bundled && (confirmDel ? (
          <>
            <span style={{ color: color.danger, fontSize: fs.sm }}>delete {name}?</span>
            <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
          </>
        ) : <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete</Button>)}
      </div>

      {/* Permission-widening notice (card 87a51903) — FIRST of the banners: it describes what the skill
          will DO to a session, which outranks the customization/update states below it. Informational
          only; Loom never strips these. */}
      {!!permissionVectors.length && <PermissionWideningBanner vectors={permissionVectors} />}

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

      {/* Preview renders the CURRENT text (unsaved edits included), so it doubles as a check before Save.
          A store skill can be agent-written; the renderer blocks external images by default. */}
      {view === "preview" ? (
        <div data-testid="skill-preview"
          style={{ flex: 1, minHeight: 360, overflow: "auto", background: color.inset, border: `1px solid ${color.line}`,
            borderRadius: radius.sm, padding: "10px 16px" }}>
          <Markdown source={text} files={[]} onOpen={() => {}} />
        </div>
      ) : (
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${name} SKILL.md`}
          style={{
            flex: 1, minHeight: 360, width: "100%", boxSizing: "border-box", resize: "none",
            fontFamily: font.mono, fontSize: fs.body, lineHeight: 1.5,
            background: color.inset, color: color.text, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 10,
          }} />
      )}
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => { setSavedText(text); onSave(text); }}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setText(content)}>Discard changes</Button>
          : showSaved && <span data-testid="skill-saved" style={{ color: color.liveFg, fontSize: fs.sm }}>saved</span>}
        {/* Re-save WITHOUT an edit, purely to re-stamp "human" — the ordinary Save button above is
            disabled with nothing dirty, so without this a skill with no pending edit has no way to earn
            the "human" stamp it needs to reach a locked role. Hidden while dirty: Save already covers it. */}
        {notTrusted && !dirty && (
          <Button disabled={saving} onClick={() => onSave(content)} title='Re-save this skill as-is to stamp it "human" and let it reach locked-role sessions'>
            {saving ? "Saving…" : "Save to trust"}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {bundled && canPublish && (confirmPublish ? (
          <>
            <span style={{ color: color.attnText, fontSize: fs.sm }}>write store edits into the repo asset?</span>
            <Button variant="primary" disabled={publishing} onClick={() => { onPublish(); setConfirmPublish(false); }}>Publish</Button>
            <Button onClick={() => setConfirmPublish(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmPublish(true)} title="Write this skill's store edits back into the repo's bundled asset (you commit it)">Publish to repo</Button>)}
        {bundled && (confirmReset ? (
          <>
            <span style={{ color: color.attnText, fontSize: fs.sm }}>discard edits & restore shipped?</span>
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
    queryFn: ({ signal }) => api.skillUpdateDiff(name, signal),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.attn}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.attnText, fontSize: fs.sm }}>
          Loom shipped an update to this skill.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide changes" : "What changed"}</Button>
        <Button variant="primary" disabled={adoptBusy} onClick={onAdopt} title="Merge the shipped update onto your edits">
          {adoptBusy ? "Adopting…" : "Adopt update"}
        </Button>
      </div>
      {error && <span style={{ color: color.danger, fontSize: fs.sm }}>{errorText(error)}</span>}
      {showDiff && (
        diff.isLoading ? <span style={{ color: color.text3, fontSize: fs.sm }}>Loading diff…</span>
        : diff.data ? <FileDiffList name={name} files={diff.data.files} />
        : <span style={{ color: color.danger, fontSize: fs.sm }}>Couldn't load the diff.</span>
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
  const diff = useQuery({ queryKey: ["skill", name, "update-diff"], queryFn: ({ signal }) => api.skillUpdateDiff(name, signal) });
  const diverged = (diff.data?.files ?? []).filter((f) => f.path !== "SKILL.md" && (f.customized || f.updateAvailable));
  if (!diverged.length) return null;
  return (
    <div style={{ border: `1px solid ${color.lineStrong}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.text2, fontSize: fs.sm }}>
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
    return <span style={{ color: color.text3, fontSize: fs.sm }}>No file differs from the shipped version.</span>;
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
    queryFn: ({ signal }) => api.skillFileDiff(name, file.path, signal),
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
    <div style={{ border: `1px solid ${color.line}`, borderRadius: radius.sm, background: color.surface }}>
      <button onClick={() => setOpen((v) => !v)} title={open ? `Hide ${file.path}` : `Show what differs in ${file.path}`}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "6px 8px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: color.text3, fontSize: fs.sm, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text, flexShrink: 0 }}>{file.path}</span>
        {file.customized && <Badge tone="muted">customized</Badge>}
        {file.updateAvailable && <Badge tone="attn">update available</Badge>}
      </button>
      {open && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          {!d ? (
            diff.isLoading ? <span style={{ color: color.text3, fontSize: fs.sm }}>Loading diff…</span>
              : <span style={{ color: color.danger, fontSize: fs.sm }}>Couldn't load this file's diff.</span>
          ) : file.customized && file.updateAvailable ? (
            // BOTH — the state that had no non-destructive exit. Show the two changes SEPARATELY, each
            // anchored on the common base, so "what I changed" and "what Loom changed" stay legible
            // instead of collapsing into one confusing mine-vs-shipped diff.
            <>
              <DiffBlock kind="mine" label="Your edits (base → your copy)" tone="muted"><LineDiff base={d.base} shipped={d.mine} /></DiffBlock>
              <DiffBlock kind="shipped" label="What Loom shipped (base → shipped)" tone="muted"><LineDiff base={d.base} shipped={d.shipped} /></DiffBlock>
            </>
          ) : file.customized ? (
            <DiffBlock kind="mine" label="Your copy vs shipped" tone="muted"><LineDiff base={d.shipped} shipped={d.mine} /></DiffBlock>
          ) : (
            <DiffBlock kind="shipped" label="What Loom shipped (base → shipped)" tone="muted"><LineDiff base={d.base} shipped={d.shipped} /></DiffBlock>
          )}

          {resolve.error && (
            <span style={{ color: color.danger, fontSize: fs.sm }}>{errorText(resolve.error)}</span>
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
                  <span style={{ color: color.attnText, fontSize: fs.sm }}>discard your edits to this file?</span>
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
            <span style={{ color: color.text3, fontSize: fs.sm }}>
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
  const accent = toneFill[tone];
  return (
    <div data-diff-kind={kind} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: fs.sm,
        color: color.text2 }}>
        <span style={{ width: 7, height: 7, borderRadius: radius.base, background: accent, display: "inline-block", flexShrink: 0 }} />
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
    queryFn: ({ signal }) => api.skillUpdateDiff(name, signal),
    enabled: showDiff,
  });
  return (
    <div style={{ border: `1px solid ${color.lineStrong}`, borderRadius: radius.base, padding: "8px 10px", marginBottom: 8,
      background: color.inset, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: color.text2, fontSize: fs.sm }}>
          Your saved copy differs from the current shipped version.
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide differences" : "Compare with shipped"}</Button>
        {confirmSync ? (
          <>
            <span style={{ color: color.attnText, fontSize: fs.sm }}>discard your copy & sync?</span>
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
        diff.isLoading ? <span style={{ color: color.text3, fontSize: fs.sm }}>Loading diff…</span>
        : diff.data ? <LineDiff base={mine} shipped={diff.data.shipped} />
        : <span style={{ color: color.danger, fontSize: fs.sm }}>Couldn't load the diff.</span>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${color.line}` }}>
            <strong style={{ fontFamily: font.ui, color: color.text }}>Resolve update</strong>
            <Badge tone="muted">{name}</Badge>
            <span style={{ color: color.text3, fontSize: fs.sm }}>
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
                  <span style={{ fontSize: fs.sm, color: color.text2 }}>Conflict {idx + 1}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <HunkSide label="Your version" tone="muted" active={choice === "mine"} lines={p.mine}
                      onPick={() => setChoices((c) => c.map((v, k) => (k === idx ? "mine" : v)))} />
                    <HunkSide label="Shipped version" tone="muted" active={choice === "shipped"} lines={p.shipped}
                      onPick={() => setChoices((c) => c.map((v, k) => (k === idx ? "shipped" : v)))} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ borderTop: `1px solid ${color.line}`, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            {showPreview && (
              <pre style={{ margin: 0, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
                fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5, color: color.text2,
                background: color.inset, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8 }}>
                {resolved.replace(/\r/g, "")}
              </pre>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide result" : "Preview result"}</Button>
              {error && <span style={{ color: color.danger, fontSize: fs.sm }}>{errorText(error)}</span>}
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
  const accent = toneFill[tone];
  return (
    <button onClick={onPick} title={`Keep this version (${label})`}
      style={{ textAlign: "left", cursor: "pointer", borderRadius: radius.sm, padding: 8,
        background: active ? color.surface : color.inset,
        border: `1px solid ${active ? color.accentEdge : color.line}`,
        boxShadow: active ? `inset 0 0 0 1px ${color.lineStrong}` : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: radius.base, background: accent, display: "inline-block" }} />
        <span style={{ fontSize: fs.sm, color: active ? color.accentFg : color.text2 }}>
          {label}{active ? " ✓" : ""}
        </span>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: font.mono, fontSize: fs.mono,
        lineHeight: 1.5, color: active ? color.text : color.text3 }}>
        {lines.length ? lines.join("\n").replace(/\r/g, "") : <span style={{ color: color.text3 }}>(empty — removes these lines)</span>}
      </pre>
    </button>
  );
}

// `LineDiff` (the base → shipped line diff this page renders in every compare block above) and its LCS
// now live in components/LineDiff.tsx + lib/lineDiff.ts — card 75ea3f73 moved them, unchanged, so the
// released-skill panel renders its on-disk-vs-store diff through the SAME component rather than a
// second copy that could drift from this one.

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

// `diffLines` / `collapse` moved to lib/lineDiff.ts, unchanged (card 75ea3f73) — a `.ts` module so
// test/lineDiff.mjs can import them under Node's type stripping, which a `.tsx` page cannot offer.
