import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Panel, Button, Input, SectionLabel, Badge } from "../components/ui";
import { color, font } from "../theme";

// Loom's OWN skill set — the editable store (~/.loom/skills) that the daemon injects into every
// session as project-local skills (shadowing the user's personal ~/.claude/skills). Edits apply on
// the next spawn (skills are read at session start).
export default function Skills() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0); // bumped on revert to force the editor to remount on the bundled content

  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const current = useQuery({ queryKey: ["skill", selected], queryFn: () => api.skill(selected!), enabled: !!selected });

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
  const revert = useMutation({
    mutationFn: (name: string) => api.resetSkill(name),
    onSuccess: (r) => {
      qc.setQueryData(["skill", r.name], { name: r.name, content: r.content }); // sync editor to bundled content (no refetch race)
      qc.invalidateQueries({ queryKey: ["skills"] });
      setReloadNonce((n) => n + 1); // remount the editor onto the restored content
    },
  });

  const validNew = /^[a-z0-9][a-z0-9-]{0,63}$/.test(newName);
  const bundled = skills.data?.find((s) => s.name === selected)?.bundled ?? false;

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
            <Button key={s.name} variant={s.name === selected ? "primary" : "default"} style={{ textAlign: "left" }}
              onClick={() => setSelected(s.name)} title={s.description || s.name}>
              {s.name}{s.bundled ? "  ·  bundled" : ""}
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
          <SkillEditor key={`${selected}:${reloadNonce}`} name={selected} content={current.data.content} bundled={bundled}
            onSave={(content) => save.mutate({ name: selected, content })} saving={save.isPending}
            onDelete={() => remove.mutate(selected)} deleting={remove.isPending}
            onRevert={() => revert.mutate(selected)} reverting={revert.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select a skill to edit its SKILL.md, or create a new one.</p>}
      </Panel>
    </div>
  );
}

// Remounted per skill (key=name) so the textarea resets on switch; after Save the query refetches and
// `dirty` clears against the new content. Mirrors the topic-preset / task-drawer editors.
function SkillEditor({ name, content, bundled, onSave, saving, onDelete, deleting, onRevert, reverting }:
  { name: string; content: string; bundled: boolean; onSave: (c: string) => void; saving: boolean;
    onDelete: () => void; deleting: boolean; onRevert: () => void; reverting: boolean }) {
  const [text, setText] = useState(content);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const dirty = text !== content;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{name}</strong>
        {bundled && <Badge tone="cyan">bundled</Badge>}
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
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 360, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 10,
        }} />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(text)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setText(content)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        <span style={{ flex: 1 }} />
        {bundled && (confirmRevert ? (
          <>
            <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>discard edits & restore shipped?</span>
            <Button variant="danger" disabled={reverting} onClick={onRevert}>Revert</Button>
            <Button onClick={() => setConfirmRevert(false)}>Cancel</Button>
          </>
        ) : <Button onClick={() => setConfirmRevert(true)} title="Discard edits and restore this skill to its shipped (bundled) version">Revert to bundled</Button>)}
      </div>
    </div>
  );
}
