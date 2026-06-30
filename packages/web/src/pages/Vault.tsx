import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { VaultEntry } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import Markdown, { CollapseContext } from "../components/Markdown";
import DocFind from "../components/DocFind";
import { Panel, Button, Input } from "../components/ui";
import { color, font, radius } from "../theme";

// Vault browser + file viewer/editor. The left pane is a real collapsible folder TREE built from the
// flat VaultEntry[] (dirs included); the right pane is a type-aware viewer — Markdown (with inline
// images), images, PDFs, editable text, and a download card for opaque binaries. Edit/new/delete still
// commit through the daemon's shared vault-commit path. Scoped to the header's active project.

// ── File-kind classification (by extension) ─────────────────────────────────────
type Kind = "md" | "image" | "pdf" | "text" | "binary";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
// Generous text/code set so non-md source files stay editable; anything else with no viewer → binary card.
const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "json", "jsonc", "csv", "tsv", "log", "yml", "yaml", "toml", "ini",
  "cfg", "conf", "env", "xml", "html", "htm", "css", "scss", "sass", "less", "js", "jsx", "ts", "tsx",
  "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "sh", "bash",
  "zsh", "fish", "ps1", "sql", "graphql", "gql", "vue", "svelte", "r", "lua", "pl", "php", "swift",
  "dart", "scala", "clj", "ex", "exs", "hs", "diff", "patch", "properties", "gradle", "bat", "cmd",
  "tf", "tfvars", "rst", "adoc", "tex",
]);
const TEXT_BASENAME = new Set(["dockerfile", "makefile", "license", "readme", "changelog", "authors", "copying", "notice", "procfile", ".gitignore", ".env", ".editorconfig"]);

function extOf(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  return base.includes(".") ? (base.split(".").pop() ?? "") : "";
}
function classify(path: string): Kind {
  const ext = extOf(path);
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (ext === "md" || ext === "markdown") return "md";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  if (!base.includes(".") && TEXT_BASENAME.has(base)) return "text";
  return "binary";
}
function humanSize(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ── Tree model ──────────────────────────────────────────────────────────────────
interface TreeNode { name: string; path: string; type: "file" | "dir"; children: TreeNode[]; }

function buildTree(entries: VaultEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirIndex = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const existing = dirIndex.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : path.slice(0, slash));
    const node: TreeNode = { name: slash === -1 ? path : path.slice(slash + 1), path, type: "dir", children: [] };
    parent.children.push(node);
    dirIndex.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.type === "dir") { ensureDir(e.path); continue; }
    const slash = e.path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : e.path.slice(0, slash));
    parent.children.push({ name: slash === -1 ? e.path : e.path.slice(slash + 1), path: e.path, type: "file", children: [] });
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

// Every ancestor directory path of a file/dir path ("a/b/c.md" → ["a","a/b"]).
function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export default function Vault() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [file, setFile] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The scrollable doc-view box is the scope boundary for the in-doc find bar (Ctrl+F) + its search
  // region; the registry lets find expand collapsed header sections that hold a match.
  const docContainerRef = useRef<HTMLDivElement>(null);
  const collapseRegistry = useMemo(() => new Map<HTMLElement, () => void>(), []);

  // Reset open file + editor + tree state when the active project changes.
  useEffect(() => { setFile(""); setEditing(false); setNewName(""); setQuery(""); setExpanded(new Set()); }, [projectId]);
  useEffect(() => { setEditing(false); }, [file]); // leave edit mode when switching files

  const tree = useQuery({ queryKey: ["vault", projectId], queryFn: () => api.vaultTree(projectId), enabled: !!projectId });
  const entries = tree.data ?? [];
  const kind = file ? classify(file) : null;
  const isTextual = kind === "md" || kind === "text";

  // Only the text/md viewers fetch the file CONTENT (a string). Images/PDFs/binaries are served by the
  // raw endpoint (URL only) — never read as text, so a binary can't garble the pane.
  const content = useQuery({
    queryKey: ["vaultFile", projectId, file],
    queryFn: () => api.vaultFile(projectId, file),
    enabled: !!projectId && !!file && isTextual,
    placeholderData: keepPreviousData,
  });

  const nodes = useMemo(() => buildTree(entries), [entries]);
  const fileList = useMemo(() => entries.filter((e) => e.type === "file").map((e) => e.path), [entries]);

  // Filter: when a query is present, restrict the tree to branches containing a path-substring match and
  // force every surviving folder open (so matches are visible without manual expansion).
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return null;
    const set = new Set<string>();
    for (const e of entries) {
      if (!e.path.toLowerCase().includes(q)) continue;
      set.add(e.path);
      for (const a of ancestorDirs(e.path)) set.add(a);
    }
    return set;
  }, [entries, q]);

  const toggle = (path: string) =>
    setExpanded((prev) => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const expandDirs = (paths: string[]) =>
    setExpanded((prev) => { const next = new Set(prev); for (const p of paths) next.add(p); return next; });

  // Selecting a file keeps its branch open so it stays visible after the filter clears.
  const openFile = (path: string) => { expandDirs(ancestorDirs(path)); setFile(path); };

  const save = useMutation({
    mutationFn: (v: { path: string; content: string }) => api.saveVaultFile(projectId, v.path, v.content),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ["vaultFile", projectId, v.path] }); qc.invalidateQueries({ queryKey: ["vault", projectId] }); setEditing(false); },
  });
  const create = useMutation({
    mutationFn: (name: string) => api.createVaultFile(projectId, name),
    onSuccess: (_r, name) => { qc.invalidateQueries({ queryKey: ["vault", projectId] }); setNewName(""); openFile(name); setEditing(true); },
  });
  const remove = useMutation({
    mutationFn: (path: string) => api.deleteVaultFile(projectId, path),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vault", projectId] }); setFile(""); },
  });

  // New-file path: vault-relative, no leading slash / no `..` (the daemon guards too, but fail fast in the UI).
  const validNew = newName.length > 0 && !newName.startsWith("/") && !/(^|[/\\])\.\.([/\\]|$)/.test(newName) && !entries.some((e) => e.path === newName);

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && (
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, marginTop: 12 }}>
          <Panel style={{ height: "74vh", overflow: "hidden", padding: 6, display: "flex", flexDirection: "column" }}>
            <Input
              placeholder="Filter files…" value={query} onChange={(e) => setQuery(e.target.value)}
              style={{ marginBottom: 6 }}
            />
            <div style={{ flex: 1, overflow: "auto", margin: "0 -2px" }}>
              {nodes.length === 0 && <p style={{ color: color.textMuted, padding: 8 }}>Empty vault folder.</p>}
              {nodes.length > 0 && visible && visible.size === 0 && <p style={{ color: color.textMuted, padding: 8 }}>No files match “{query.trim()}”.</p>}
              <TreeView nodes={nodes} depth={0} expanded={expanded} visible={visible} active={file} onToggle={toggle} onSelect={openFile} />
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
                  <Breadcrumb path={file} onDir={(d) => expandDirs([...ancestorDirs(d), d])} />
                  <span style={{ flex: 1 }} />
                  {isTextual && !editing && (
                    <Button onClick={() => setEditing(true)} disabled={content.data?.content === undefined}>Edit</Button>
                  )}
                  <DeleteButton name={file} onDelete={() => remove.mutate(file)} deleting={remove.isPending} />
                </div>
                <div ref={docContainerRef} style={{ flex: 1, overflow: "auto", position: "relative" }}>
                  {editing && isTextual ? (
                    content.data?.content === undefined
                      ? <p style={{ color: color.textMuted }}>…</p>
                      : <VaultEditor key={file} content={content.data.content}
                          onSave={(c) => save.mutate({ path: file, content: c })} saving={save.isPending}
                          onCancel={() => setEditing(false)} />
                  ) : (
                    <CollapseContext.Provider value={collapseRegistry}>
                      {kind === "md" && <DocFind containerRef={docContainerRef} registry={collapseRegistry} docKey={file} />}
                      <ContentView projectId={projectId} path={file} kind={kind!} content={content.data?.content} loading={content.isLoading} files={fileList} onOpen={openFile} />
                    </CollapseContext.Provider>
                  )}
                </div>
              </>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

// ── Tree view ─────────────────────────────────────────────────────────────────
function TreeView({ nodes, depth, expanded, visible, active, onToggle, onSelect }: {
  nodes: TreeNode[]; depth: number; expanded: Set<string>; visible: Set<string> | null;
  active: string; onToggle: (p: string) => void; onSelect: (p: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (visible && !visible.has(node.path)) return null;
        if (node.type === "dir") {
          const open = visible ? true : expanded.has(node.path);
          return (
            <div key={node.path}>
              <Row depth={depth} onClick={() => onToggle(node.path)}>
                <Chevron open={open} />
                <FolderIcon open={open} />
                <span style={{ color: color.textDim }}>{node.name}</span>
              </Row>
              {open && <TreeView nodes={node.children} depth={depth + 1} expanded={expanded} visible={visible} active={active} onToggle={onToggle} onSelect={onSelect} />}
            </div>
          );
        }
        const isActive = active === node.path;
        return (
          <Row key={node.path} depth={depth} active={isActive} onClick={() => onSelect(node.path)}>
            <span style={{ width: 12, flexShrink: 0 }} />
            <FileIcon kind={classify(node.path)} />
            <span style={{ color: isActive ? color.text : color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
          </Row>
        );
      })}
    </>
  );
}

function Row({ depth, active, onClick, children }: { depth: number; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="loom-tree-row" title=""
      style={{
        display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
        background: active ? color.phosphorDim : "transparent", cursor: "pointer",
        border: "none", borderLeft: `2px solid ${active ? color.phosphor : "transparent"}`,
        padding: "3px 8px", paddingLeft: 6 + depth * 14,
        fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.4,
      }}>
      {children}
    </button>
  );
}

// ── Icons (currentColor-friendly inline SVG, restrained) ────────────────────────
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease", color: color.textMuted }}>
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0, color: color.cyan }}>
      {open
        ? <path d="M2 4.5 a1 1 0 0 1 1-1 h3 l1.2 1.2 H13 a1 1 0 0 1 1 1 v.3 H4.2 L2.5 11 Z M2 5.8 L3.6 12 a1 1 0 0 0 1 .8 h8.4 a1 1 0 0 0 1-.8 L15 7 a.6 .6 0 0 0-.6-.7 H4.5 a1 1 0 0 0-1 .8 Z" fill="currentColor" opacity="0.85" />
        : <path d="M2 4 a1 1 0 0 1 1-1 h3 l1.2 1.2 H13 a1 1 0 0 1 1 1 V12 a1 1 0 0 1-1 1 H3 a1 1 0 0 1-1-1 Z" fill="currentColor" opacity="0.85" />}
    </svg>
  );
}
const KIND_TINT: Record<Kind, string> = { md: color.phosphor, image: color.cyan, pdf: color.red, text: color.textDim, binary: color.textMuted };
function FileIcon({ kind }: { kind: Kind }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0, color: KIND_TINT[kind] }}>
      <path d="M4 1.5 h5 L13 5.5 V14 a.5 .5 0 0 1-.5 .5 h-8 A.5 .5 0 0 1 4 14 Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 1.5 V5.5 H13" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

// ── Path breadcrumb ─────────────────────────────────────────────────────────────
function Breadcrumb({ path, onDir }: { path: string; onDir: (dir: string) => void }) {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1] ?? path;
  const dirs = parts.slice(0, -1);
  return (
    <span style={{ fontFamily: font.mono, fontSize: 13, display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 2, minWidth: 0 }}>
      {dirs.map((seg, i) => {
        const dirPath = parts.slice(0, i + 1).join("/");
        return (
          <span key={dirPath} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button onClick={() => onDir(dirPath)} className="loom-crumb"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.textMuted, fontFamily: font.mono, fontSize: 13 }}>{seg}</button>
            <span style={{ color: color.textMuted }}>/</span>
          </span>
        );
      })}
      <span style={{ color: color.text }}>{fileName}</span>
    </span>
  );
}

// ── Content viewers ─────────────────────────────────────────────────────────────
function ContentView({ projectId, path, kind, content, loading, files, onOpen }: {
  projectId: string; path: string; kind: Kind; content: string | undefined; loading: boolean;
  files: string[]; onOpen: (p: string) => void;
}) {
  const rawUrl = api.vaultRawUrl(projectId, path);

  if (kind === "image") {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 8, overflow: "auto" }}>
        <img src={rawUrl} alt={path} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: radius.base, border: `1px solid ${color.border}`, background: color.panel2 }} />
      </div>
    );
  }
  if (kind === "pdf") {
    // First-party bytes from our own daemon (nosniff + application/pdf). An <object> defers to the
    // browser's native PDF viewer; a sandbox isn't practical here — it disables Chrome's built-in PDF
    // plugin (blank/broken page) — so we rely on the trusted same-origin endpoint and a download fallback.
    return (
      <object data={rawUrl} type="application/pdf"
        style={{ width: "100%", height: "100%", border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2 }}>
        <BinaryCard projectId={projectId} path={path} rawUrl={rawUrl} note="This browser can’t display PDFs inline." />
      </object>
    );
  }
  if (kind === "binary") return <BinaryCard projectId={projectId} path={path} rawUrl={rawUrl} />;

  // md / text
  if (loading && content === undefined) return <p style={{ color: color.textMuted }}>…</p>;
  if (content === undefined) return <p style={{ color: color.textMuted }}>…</p>;
  if (kind === "md") {
    return (
      <Markdown
        source={content}
        files={files}
        currentPath={path}
        onOpen={onOpen}
        assetSrc={(vaultPath) => api.vaultRawUrl(projectId, vaultPath)}
      />
    );
  }
  return <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 13, color: color.text }}>{content}</pre>;
}

// Opaque binary (no viewer): a clean card with size + download — never dump bytes as text.
function BinaryCard({ projectId, path, rawUrl, note }: { projectId: string; path: string; rawUrl: string; note?: string }) {
  const head = useQuery({ queryKey: ["vaultHead", projectId, path], queryFn: () => api.vaultRawHead(projectId, path) });
  const name = path.split("/").pop() ?? path;
  const ext = extOf(path);
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ textAlign: "center", border: `1px solid ${color.border}`, borderRadius: radius.base, background: color.panel2, padding: "28px 36px", maxWidth: 420 }}>
        <svg width="40" height="40" viewBox="0 0 16 16" aria-hidden style={{ color: color.textMuted, marginBottom: 10 }}>
          <path d="M4 1.5 h5 L13 5.5 V14 a.5 .5 0 0 1-.5 .5 h-8 A.5 .5 0 0 1 4 14 Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M9 1.5 V5.5 H13" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
        <div style={{ fontFamily: font.mono, fontSize: 13, color: color.text, marginBottom: 4, wordBreak: "break-all" }}>{name}</div>
        <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, marginBottom: 16 }}>
          {note ?? `Binary file${ext ? ` · .${ext}` : ""}`} · {head.isLoading ? "…" : humanSize(head.data?.size ?? null)}
        </div>
        <a href={rawUrl} download={name} className="loom-btn loom-btn-primary"
          style={{ display: "inline-block", textDecoration: "none", color: color.phosphor, border: `1px solid ${color.phosphor}`, borderRadius: radius.base, padding: "6px 14px", fontFamily: font.mono, fontSize: 12 }}>
          Download file
        </a>
      </div>
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
