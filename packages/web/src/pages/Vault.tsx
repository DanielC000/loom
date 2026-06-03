import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import Markdown from "../components/Markdown";
import { Panel, Button, Input } from "../components/ui";
import { color, font } from "../theme";

// Vault browser + file editor. Reads the tree/file (read-only preview) and now also writes:
// edit/save, create-new-file, and delete — each commits through the daemon's shared vault-commit
// path (the same one the auto-committer uses). Scoped to the header's active project.
export default function Vault() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [file, setFile] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  // Reset the open file + editor state when the active project changes.
  useEffect(() => { setFile(""); setEditing(false); setNewName(""); }, [projectId]);
  useEffect(() => { setEditing(false); }, [file]); // leave edit mode when switching files

  const tree = useQuery({ queryKey: ["vault", projectId], queryFn: () => api.vaultTree(projectId), enabled: !!projectId });
  const content = useQuery({ queryKey: ["vaultFile", projectId, file], queryFn: () => api.vaultFile(projectId, file), enabled: !!projectId && !!file, placeholderData: keepPreviousData });

  const save = useMutation({
    mutationFn: (v: { path: string; content: string }) => api.saveVaultFile(projectId, v.path, v.content),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ["vaultFile", projectId, v.path] }); qc.invalidateQueries({ queryKey: ["vault", projectId] }); setEditing(false); },
  });
  const create = useMutation({
    mutationFn: (name: string) => api.createVaultFile(projectId, name),
    onSuccess: (_r, name) => { qc.invalidateQueries({ queryKey: ["vault", projectId] }); setNewName(""); setFile(name); setEditing(true); },
  });
  const remove = useMutation({
    mutationFn: (path: string) => api.deleteVaultFile(projectId, path),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vault", projectId] }); setFile(""); },
  });

  // New-file path: vault-relative, no leading slash / no `..` (the daemon guards too, but fail fast in the UI).
  const validNew = newName.length > 0 && !newName.startsWith("/") && !/(^|[/\\])\.\.([/\\]|$)/.test(newName) && !tree.data?.some((e) => e.path === newName);

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 12, marginTop: 12 }}>
          <Panel style={{ height: "74vh", overflow: "auto", padding: 6, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, overflow: "auto" }}>
              {tree.data?.filter((e) => e.type === "file").map((e) => {
                const active = file === e.path;
                return (
                  <button key={e.path} onClick={() => setFile(e.path)}
                    style={{
                      display: "block", width: "100%", textAlign: "left", background: "none", cursor: "pointer",
                      border: "none", borderLeft: `2px solid ${active ? color.phosphor : "transparent"}`,
                      color: active ? color.text : color.textDim, padding: "2px 8px",
                      fontFamily: font.mono, fontSize: 12,
                    }}>{e.path}</button>
                );
              })}
              {tree.data?.length === 0 && <p style={{ color: color.textMuted }}>Empty vault folder.</p>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${color.border}` }}>
              <Input placeholder="folder/new-note.md" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && validNew && !create.isPending) create.mutate(newName); }} style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={!validNew || create.isPending} onClick={() => create.mutate(newName)}>+ New</Button>
            </div>
          </Panel>
          <Panel style={{ height: "74vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {!file && <p style={{ color: color.textMuted, padding: 12 }}>Select a file to view, or create a new one.</p>}
            {file && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{file}</span>
                  <span style={{ flex: 1 }} />
                  {!editing && <Button onClick={() => setEditing(true)} disabled={content.data?.content === undefined}>Edit</Button>}
                  <DeleteButton name={file} onDelete={() => remove.mutate(file)} deleting={remove.isPending} />
                </div>
                <div style={{ flex: 1, overflow: "auto" }}>
                  {content.data?.content === undefined
                    ? <p style={{ color: color.textMuted }}>…</p>
                    : editing
                      ? <VaultEditor key={file} content={content.data.content}
                          onSave={(c) => save.mutate({ path: file, content: c })} saving={save.isPending}
                          onCancel={() => setEditing(false)} />
                      : file.toLowerCase().endsWith(".md")
                        ? <Markdown
                            source={content.data.content}
                            files={(tree.data ?? []).filter((e) => e.type === "file").map((e) => e.path)}
                            onOpen={(p) => setFile(p)}
                          />
                        : <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 13, color: color.text }}>{content.data.content}</pre>}
                </div>
              </>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

// Delete-with-confirm, mirroring the Skills editor's inline confirm.
function DeleteButton({ name, onDelete, deleting }: { name: string; onDelete: () => void; deleting: boolean }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); }, [name]);
  if (!confirm) return <Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button>;
  return (
    <>
      <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>delete?</span>
      <Button variant="danger" disabled={deleting} onClick={onDelete}>Confirm</Button>
      <Button onClick={() => setConfirm(false)}>Cancel</Button>
    </>
  );
}

// Remounted per file (key=path) so the textarea resets on switch; after Save the file query
// refetches and `dirty` clears against the saved content. Save writes + commits server-side.
function VaultEditor({ content, onSave, saving, onCancel }:
  { content: string; onSave: (c: string) => void; saving: boolean; onCancel: () => void }) {
  const [text, setText] = useState(content);
  const dirty = text !== content;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 320, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 10,
        }} />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(text)}>{saving ? "Saving…" : "Save"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
        {dirty && <span style={{ color: color.amber, fontSize: 12, fontFamily: font.mono }}>unsaved changes</span>}
      </div>
    </div>
  );
}
