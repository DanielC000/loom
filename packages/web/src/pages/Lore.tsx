import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectMemoryEntry } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { SectionLabel, Segmented, Meter, Chip, Badge } from "../components/ui";
import { color, font, radius, tone, type Tone } from "../theme";

// Lore — the read-only, per-project window into project_memory: the durable knowledge the fleet writes
// and recalls via the `memory` MCP (memory_write/read/list/forget). Wired to the real read surface
// (GET /api/projects/:id/memory → api.projectMemory). Pinned "always in context" entries surface as
// cards up top; every entry lists with a recall badge + magnitude Meter (the usage signal) and sorts by
// recall (default) / recent / title; clicking one opens a note-detail panel with markdown + [[wikilink]]
// rendering. READ-ONLY by design — writing and forgetting stay the memory MCP's job (no edit affordances).
//
// Built to the owner-approved EXPLORER + USAGE mockup (Projects/Loom/Mockups/Memory-Viz-Mockups-Jul2026)
// using the real theme tokens + kit primitives (SectionLabel / Segmented / Meter / Chip / Badge).

type SortKey = "recall" | "recent" | "title";

// Magnitude of an entry's recall relative to the most-recalled entry, tiering the usage cue: heavily
// recalled → phosphor, mid → cyan, rarely → muted. Mirrors the mockup's hi/mid/low thresholds.
function magTone(count: number, max: number): Tone {
  const f = max > 0 ? count / max : 0;
  return f >= 0.66 ? "phosphor" : f >= 0.33 ? "cyan" : "muted";
}

// The app ships in English only, so pin the locale (an undefined locale would render the viewer's system
// locale, e.g. "16. Juli") — a "Jul 16" short date matching the rest of the cockpit.
const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const fmtDateFull = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

// ── The recall signal: ↺ N, tinted by magnitude (the "usage" half of EXPLORER + USAGE) ──────────────
function RecallBadge({ count, max }: { count: number; max: number }) {
  const f = max > 0 ? count / max : 0;
  const nColor = f >= 0.66 ? color.phosphor : f >= 0.33 ? color.cyan : color.text;
  return (
    <span title={`Recalled ${count} time${count === 1 ? "" : "s"} into agent context`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: font.mono, fontSize: 11, color: color.textDim, whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ color: color.textMuted }}>↺</span>
      <span style={{ color: nColor, fontWeight: 500 }}>{count}</span>
    </span>
  );
}

// ── Minimal markdown → React (headings, bullet lists, inline `code` / **bold** / [[wikilink]]) ───────
// React escapes text children by default, so agent-written note content can never inject markup — this
// renders to real elements, never dangerouslySetInnerHTML. Matches the mockup's small renderer.
const h3Style: CSSProperties = { fontFamily: font.head, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: color.textDim, margin: "16px 0 7px" };
const pStyle: CSSProperties = { margin: "0 0 10px", color: color.text, fontSize: 12.5, lineHeight: 1.65 };
const ulStyle: CSSProperties = { margin: "0 0 10px", paddingLeft: 18 };
const liStyle: CSSProperties = { color: color.text, fontSize: 12.5, lineHeight: 1.6, marginBottom: 4 };
const codeStyle: CSSProperties = { fontFamily: font.mono, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "0 4px", fontSize: 11.5, color: color.amber };

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\[\[([^\]]+)\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      // [[wikilink]] — a read-only visual affordance (no resolvable target in this view).
      nodes.push(
        <span key={`${keyPrefix}-w${i}`} title="wikilink"
          style={{ color: color.cyan, borderBottom: `1px dotted rgba(91,200,255,0.5)` }}>
          <span aria-hidden style={{ opacity: 0.5 }}>[[</span>{m[1]}<span aria-hidden style={{ opacity: 0.5 }}>]]</span>
        </span>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c${i}`} style={codeStyle}>{m[2]}</code>);
    } else if (m[3] !== undefined) {
      nodes.push(<b key={`${keyPrefix}-b${i}`} style={{ color: color.text, fontWeight: 600 }}>{m[3]}</b>);
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ src }: { src: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  let n = 0;
  const flush = () => {
    if (list) {
      const items = list;
      const key = `ul${n++}`;
      blocks.push(<ul key={key} style={ulStyle}>{items.map((li, j) => <li key={j} style={liStyle}>{renderInline(li, `${key}-${j}`)}</li>)}</ul>);
      list = null;
    }
  };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    if (!line) { flush(); continue; }
    if (line.startsWith("### ")) { flush(); const k = `h${n++}`; blocks.push(<h3 key={k} style={h3Style}>{renderInline(line.slice(4), k)}</h3>); }
    else if (line.startsWith("- ")) { (list = list ?? []).push(line.slice(2)); }
    else { flush(); const k = `p${n++}`; blocks.push(<p key={k} style={pStyle}>{renderInline(line, k)}</p>); }
  }
  flush();
  return <>{blocks}</>;
}

// ── Pinned "always in context" card ──────────────────────────────────────────────────────────────────
function PinCard({ entry, max, selected, onOpen }: { entry: ProjectMemoryEntry; max: number; selected: boolean; onOpen: () => void }) {
  const title = entry.title || entry.key;
  return (
    <div onClick={onOpen} className="lore-pincard" title={title}
      style={{
        background: color.panel, border: `1px solid ${selected ? color.phosphor : color.border}`,
        borderRadius: radius.base, padding: "11px 12px 10px", display: "flex", flexDirection: "column", gap: 8,
        cursor: "pointer", position: "relative",
        boxShadow: selected ? `inset 0 0 0 1px ${color.phosphorDim}, inset 2px 0 0 ${color.amber}` : `inset 2px 0 0 ${color.amber}`,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: font.head, fontWeight: 600, fontSize: 13, color: color.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span aria-hidden title="Pinned — always injected" style={{ color: color.amber, fontSize: 12, flexShrink: 0 }}>★</span>
      </div>
      <span style={{ fontSize: 11, color: color.cyan, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.key}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 1 }}>
        <RecallBadge count={entry.retrievalCount} max={max} />
        <Meter value={entry.retrievalCount} max={max} tone={magTone(entry.retrievalCount, max)} width={64} />
        <span style={{ flex: 1 }} />
        <span title="Injected into every agent kickoff"
          style={{ fontFamily: font.mono, fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: color.amber, border: `1px solid rgba(255,178,62,0.4)`, borderRadius: radius.sm, padding: "1px 5px", whiteSpace: "nowrap" }}>always</span>
      </div>
    </div>
  );
}

// ── One row in the all-entries list ──────────────────────────────────────────────────────────────────
const ROW_COLS = "16px minmax(0, 1fr) 128px 78px 18px";
function NoteRow({ entry, max, selected, onOpen }: { entry: ProjectMemoryEntry; max: number; selected: boolean; onOpen: () => void }) {
  const title = entry.title || entry.key;
  return (
    <div onClick={onOpen} className="lore-row" role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{
        display: "grid", gridTemplateColumns: ROW_COLS, alignItems: "center", gap: 12,
        padding: "10px", borderBottom: `1px solid ${color.border}`, cursor: "pointer",
        background: selected ? color.panel : "transparent",
        boxShadow: selected ? `inset 2px 0 0 ${color.phosphor}` : "none",
      }}>
      <span aria-hidden title={entry.pinned ? "Pinned" : undefined} style={{ textAlign: "center", color: color.amber, fontSize: 11 }}>{entry.pinned ? "★" : ""}</span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontFamily: font.head, fontWeight: 500, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ fontSize: 11, color: color.cyan, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.key}</span>
      </span>
      <span className="lore-row-recall" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
        <RecallBadge count={entry.retrievalCount} max={max} />
        <span className="lore-meter"><Meter value={entry.retrievalCount} max={max} tone={magTone(entry.retrievalCount, max)} width={56} /></span>
      </span>
      <span style={{ fontSize: 11, color: color.textMuted, textAlign: "right", whiteSpace: "nowrap" }} title={fmtDateFull(entry.updatedAt)}>{fmtDate(entry.updatedAt)}</span>
      <span className="lore-caret" aria-hidden style={{ color: selected ? color.phosphor : color.textMuted, fontSize: 12, textAlign: "center" }}>▸</span>
    </div>
  );
}

// ── The note-detail panel ────────────────────────────────────────────────────────────────────────────
function NoteDetail({ entry, max, onClose }: { entry: ProjectMemoryEntry; max: number; onClose: () => void }) {
  const t = magTone(entry.retrievalCount, max);
  return (
    <div style={{
      position: "sticky", top: 16, background: color.panel, border: `1px solid ${color.borderStrong}`,
      borderRadius: radius.base, overflow: "hidden", display: "flex", flexDirection: "column",
      maxHeight: "calc(100vh - 150px)",
    }}>
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${color.border}`, background: color.panel2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontFamily: font.head, fontWeight: 700, fontSize: 16, color: color.text, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{entry.title || entry.key}</span>
          {entry.pinned && <Badge tone="amber">★ Pinned</Badge>}
          <button onClick={onClose} title="Close" aria-label="Close entry"
            style={{ background: "transparent", border: `1px solid ${color.borderStrong}`, color: color.textDim, borderRadius: radius.base, cursor: "pointer", padding: "2px 8px", fontFamily: font.mono, fontSize: 13, flexShrink: 0 }}>✕</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <Chip label="key" value={entry.key} tone="cyan" />
          <Chip label="↺ recall" value={entry.retrievalCount} tone={t} />
          <Chip label="updated" value={fmtDate(entry.updatedAt)} />
          <Chip label="state" value={entry.pinned ? "always-injected" : "relevance-injected"} tone={entry.pinned ? "phosphor" : undefined} />
        </div>
      </div>
      <div style={{ padding: "15px 16px 18px", overflowY: "auto" }}>
        <Markdown src={entry.text} />
      </div>
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${color.border}`, background: color.panel2, display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: color.textMuted }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 6, background: color.textMuted, flexShrink: 0 }} />
        <span>Read-only — written &amp; forgotten by the fleet&apos;s memory MCP</span>
      </div>
    </div>
  );
}

// Scoped styles: hover affordances (inline styles can't express :hover) + the responsive collapse. On a
// narrow viewport collapse to one column, stack pinned cards, and hand the row's width to the entry title
// by dropping the magnitude meter + caret. Mirrors the mockup's hover + mobile states. Kept as a class
// block (like .loom-board-grid) so the rules live with the component.
const LORE_CSS = `
.lore-row { transition: background 80ms linear; }
.lore-row:hover { background: var(--loom-panel-2); }
.lore-row:focus-visible { outline: 2px solid var(--loom-phosphor); outline-offset: -2px; }
.lore-pincard { transition: border-color 90ms linear, background 90ms linear; }
.lore-pincard:hover { border-color: var(--loom-border-strong); background: #12161a; }
@media (max-width: 640px) {
  .lore-body-grid { grid-template-columns: 1fr !important; }
  .lore-pinned-row { grid-template-columns: 1fr !important; }
}
@media (max-width: 560px) {
  .lore-meter { display: none; }
  .lore-caret { display: none; }
}`;

export default function Lore() {
  const { projectId, projects } = useActiveProject();
  const q = useQuery({ queryKey: ["projectMemory", projectId], queryFn: () => api.projectMemory(projectId), enabled: !!projectId });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recall");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const entries = q.data ?? [];
  const projectName = projects.find((p) => p.id === projectId)?.name ?? "";
  const maxRecall = useMemo(() => entries.reduce((m, e) => Math.max(m, e.retrievalCount), 0), [entries]);
  const pinnedCount = useMemo(() => entries.filter((e) => e.pinned).length, [entries]);

  const term = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!term) return entries;
    return entries.filter((e) => e.title.toLowerCase().includes(term) || e.key.toLowerCase().includes(term) || e.text.toLowerCase().includes(term));
  }, [entries, term]);

  const sorted = useMemo(() => {
    const c = [...filtered];
    if (sort === "recall") c.sort((a, b) => b.retrievalCount - a.retrievalCount || a.title.localeCompare(b.title));
    else if (sort === "recent") c.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else c.sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key));
    return c;
  }, [filtered, sort]);

  // Selection is looked up against the FULL list, so a filtered-out entry keeps its detail panel open.
  const selected = openKey ? entries.find((e) => e.key === openKey) ?? null : null;
  const pinned = useMemo(() => sorted.filter((e) => e.pinned), [sorted]);

  const header = (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <h1 style={{ fontFamily: font.head, fontWeight: 700, fontSize: 22, letterSpacing: "0.02em", color: color.text, margin: 0, display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ color: color.phosphor, fontSize: 18 }}>◈</span> Lore
        </h1>
        <span style={{ color: color.textDim, fontSize: 12.5, maxWidth: "62ch" }}>
          The durable knowledge your fleet writes and recalls — <b style={{ color: color.text, fontWeight: 500 }}>{entries.length}</b>{" "}
          {entries.length === 1 ? "entry" : "entries"}{projectName ? <> in <b style={{ color: color.text, fontWeight: 500 }}>{projectName}</b></> : null}. Read-only; agents write via the <b style={{ color: color.text, fontWeight: 500 }}>memory</b> MCP.
        </span>
      </div>
      <span style={{ flex: 1 }} />
      {entries.length > 0 && (
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <span aria-hidden style={{ position: "absolute", left: 10, color: color.textMuted, fontSize: 13, pointerEvents: "none" }}>⌕</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} className="loom-field"
            placeholder="Search titles & content…" aria-label="Search Lore"
            style={{ background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "7px 10px 7px 30px", fontFamily: font.mono, fontSize: 13, width: 260 }} />
        </div>
      )}
    </div>
  );

  const footStrip = (
    <div style={{ marginTop: 26, paddingTop: 12, borderTop: `1px solid ${color.border}`, color: color.textMuted, fontSize: 11, display: "flex", gap: 18, flexWrap: "wrap" }}>
      <span><b style={{ color: color.textDim, fontWeight: 500 }}>◈ Lore</b> · per-project shared memory</span>
      <span><b style={{ color: color.textDim, fontWeight: 500 }}>{entries.length}</b> entries · <b style={{ color: color.textDim, fontWeight: 500 }}>{pinnedCount}</b> pinned</span>
      <span>Recall = how often the fleet pulls an entry into context</span>
    </div>
  );

  let bodyContent: ReactNode;
  if (!projectId) {
    bodyContent = <div style={{ padding: "48px 10px", textAlign: "center", color: color.textMuted, fontSize: 12.5 }}>Select a project to view its Lore.</div>;
  } else if (q.isLoading) {
    bodyContent = <div style={{ padding: "48px 10px", textAlign: "center", color: color.textMuted, fontSize: 12.5 }}>Loading…</div>;
  } else if (q.isError) {
    bodyContent = <div style={{ padding: "48px 10px", textAlign: "center", color: color.red, fontSize: 12.5 }}>Couldn&apos;t load this project&apos;s Lore.</div>;
  } else if (entries.length === 0) {
    // Empty state — a project whose fleet hasn't written any memory yet.
    bodyContent = (
      <div style={{ border: `1px dashed ${color.borderStrong}`, borderRadius: radius.base, padding: "54px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 8 }}>
        <span aria-hidden style={{ fontSize: 32, color: color.textMuted }}>◈</span>
        <h2 style={{ fontFamily: font.head, fontWeight: 600, fontSize: 16, color: color.text, margin: 0 }}>No Lore yet</h2>
        <p style={{ color: color.textDim, fontSize: 12.5, maxWidth: "52ch", margin: 0, lineHeight: 1.6 }}>
          This project&apos;s fleet hasn&apos;t written any memory. As agents work, they capture durable facts, decisions, and hard-won gotchas with <code style={{ ...codeStyle, color: color.cyan }}>memory_write</code> — and those entries are recalled back into future agents&apos; context automatically.
        </p>
        <span style={{ fontSize: 11, color: color.textMuted }}>Pinned entries are always injected · unpinned entries surface by relevance</span>
      </div>
    );
  } else {
    const listBody = (
      <div>
        {/* Pinned "always in context" — hidden while a search narrows the list (pinned still appear inline). */}
        {pinned.length > 0 && !term && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 12px" }}>
              <SectionLabel style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span aria-hidden style={{ color: color.amber, fontSize: 12 }}>★</span> Pinned
                <span style={{ fontFamily: font.mono, fontWeight: 400, letterSpacing: "0.02em", textTransform: "none", color: color.textMuted, fontSize: 11 }}>always in agent context</span>
              </SectionLabel>
            </div>
            <div className="lore-pinned-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10, marginBottom: 26 }}>
              {pinned.map((e) => (
                <PinCard key={e.key} entry={e} max={maxRecall} selected={selected?.key === e.key} onOpen={() => setOpenKey(e.key)} />
              ))}
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 12px" }}>
          <SectionLabel style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
            {term ? "Results" : "All entries"}
            <span style={{ fontFamily: font.mono, fontWeight: 400, letterSpacing: "0.02em", textTransform: "none", color: color.textMuted, fontSize: 11 }}>{sorted.length}{term ? ` of ${entries.length}` : ""}</span>
          </SectionLabel>
          <span style={{ flex: 1 }} />
          <span style={{ color: color.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort</span>
          <Segmented<SortKey> value={sort} onChange={setSort} ariaLabel="Sort entries"
            items={[{ key: "recall", label: "Recall" }, { key: "recent", label: "Recent" }, { key: "title", label: "Title" }]} />
        </div>

        {sorted.length > 0 ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: ROW_COLS, gap: 12, padding: "0 10px 7px", color: color.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <span /><span>Entry</span><span style={{ textAlign: "right" }}>Recall</span><span style={{ textAlign: "right" }}>Updated</span><span className="lore-caret" style={{ textAlign: "center" }} aria-hidden>▸</span>
            </div>
            <div style={{ borderTop: `1px solid ${color.border}` }}>
              {sorted.map((e) => (
                <NoteRow key={e.key} entry={e} max={maxRecall} selected={selected?.key === e.key} onOpen={() => setOpenKey(e.key)} />
              ))}
            </div>
          </>
        ) : (
          <div style={{ padding: "34px 10px", textAlign: "center", color: color.textMuted, fontSize: 12.5 }}>No entries match “{search.trim()}”.</div>
        )}
      </div>
    );

    bodyContent = (
      <div className="lore-body-grid" style={{ display: "grid", gridTemplateColumns: selected ? "minmax(0, 1.35fr) minmax(0, 1fr)" : "1fr", gap: 26, alignItems: "start" }}>
        {listBody}
        {selected && <NoteDetail entry={selected} max={maxRecall} onClose={() => setOpenKey(null)} />}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <style>{LORE_CSS}</style>
      {header}
      {bodyContent}
      {projectId && !q.isLoading && !q.isError && footStrip}
    </div>
  );
}
