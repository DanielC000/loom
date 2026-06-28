import { color, font, radius, tone } from "../theme";
import { type FileDiff, riskTone, statusGlyph } from "../lib/diff";
import { Dot } from "./ui";

// Per-line color for a unified diff: green additions / red deletions / cyan hunk headers.
function lineColor(ln: string): string {
  if (ln.startsWith("@@")) return color.cyan;
  if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) return color.textMuted;
  if (ln.startsWith("+")) return color.phosphor;
  if (ln.startsWith("-")) return color.red;
  return color.textDim;
}

// Unified diff with green additions / red deletions / cyan hunk headers. Kept for the Orchestration
// view's raw whole-patch render; the review pane uses the per-file FileDiffBlock below.
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 }}>
      {lines.map((ln, i) => (
        <div key={i} style={{ color: lineColor(ln) }}>{ln || " "}</div>
      ))}
    </pre>
  );
}

// The hunks of ONE file, rendered with per-line coloring + a faint hunk-header band. Pulled out so
// the collapsible FileDiffBlock can show/hide it without re-laying the lines.
function FileHunks({ file }: { file: FileDiff }) {
  if (file.binary) return <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "8px 10px" }}>Binary file — no text diff.</div>;
  if (file.hunks.length === 0) return <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "8px 10px" }}>No textual changes.</div>;
  return (
    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 12, lineHeight: 1.5, padding: "4px 10px 8px" }}>
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div style={{ color: color.cyan, background: "rgba(91,200,255,0.06)", margin: "4px -10px 2px", padding: "1px 10px" }}>{h.header}</div>
          {h.lines.map((ln, i) => (
            <div key={i} style={{ color: lineColor(ln) }}>{ln || " "}</div>
          ))}
        </div>
      ))}
    </pre>
  );
}

// A single file in the review pane: a clickable header (status glyph + risk dot + path + ± counts)
// that collapses/expands its hunks. Controlled by the parent so the pane can open high-risk files and
// fold the low-risk noise (attention where it matters) AND expand a file on jump-from-overview. The
// header carries an `id` anchor so the file overview can scroll to it.
export function FileDiffBlock({ file, open, onToggle, anchorId }: { file: FileDiff; open: boolean; onToggle: () => void; anchorId?: string }) {
  const t = riskTone(file.risk);
  return (
    <div id={anchorId} style={{ border: `1px solid ${color.border}`, borderRadius: radius.base, overflow: "hidden", scrollMarginTop: 12 }}>
      <button
        onClick={onToggle}
        className="loom-btn"
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
          background: color.panel2, border: "none", borderBottom: open ? `1px solid ${color.border}` : "none",
          padding: "6px 10px", cursor: "pointer", fontFamily: font.mono, fontSize: 12,
        }}
        title={open ? "Collapse" : "Expand"}
      >
        <span aria-hidden style={{ color: color.textMuted, width: 10, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <StatusGlyph status={file.status} />
        <Dot tone={t} glow={file.risk === "high"} title={`risk: ${file.risk}`} />
        <span style={{ color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? <><span style={{ color: color.textMuted }}>{file.oldPath} → </span>{file.path}</> : file.path}
        </span>
        {file.insertions > 0 && <span style={{ color: color.phosphor, flexShrink: 0 }}>+{file.insertions}</span>}
        {file.deletions > 0 && <span style={{ color: color.red, flexShrink: 0 }}>−{file.deletions}</span>}
      </button>
      {open && <FileHunks file={file} />}
    </div>
  );
}

// A/D/R/M status tag, tinted by meaning (added=phosphor, deleted=red, renamed=cyan, modified=dim).
export function StatusGlyph({ status }: { status: FileDiff["status"] }) {
  const c = status === "added" ? color.phosphor : status === "deleted" ? color.red : status === "renamed" ? color.cyan : color.textDim;
  return (
    <span title={status} style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 700, color: c, width: 12, textAlign: "center", flexShrink: 0 }}>
      {statusGlyph(status)}
    </span>
  );
}

// One row of the file overview/navigator: risk dot + status glyph + path + ± counts. Clicking jumps
// to (and expands) the file's diff block below. Compact so a multi-file branch scans in one glance.
export function FileOverviewRow({ file, onJump }: { file: FileDiff; onJump: () => void }) {
  const t = riskTone(file.risk);
  return (
    <button
      onClick={onJump}
      className="loom-btn loom-tree-row"
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
        background: "transparent", border: "none", padding: "3px 6px", cursor: "pointer",
        fontFamily: font.mono, fontSize: 12, borderRadius: radius.sm,
      }}
      title={file.reasons.length ? `${file.risk} risk — ${file.reasons.join("; ")}` : `${file.risk} risk`}
    >
      <Dot tone={t} glow={file.risk === "high"} />
      <StatusGlyph status={file.status} />
      <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{file.path}</span>
      {file.insertions > 0 && <span style={{ color: color.phosphor, flexShrink: 0 }}>+{file.insertions}</span>}
      {file.deletions > 0 && <span style={{ color: color.red, flexShrink: 0 }}>−{file.deletions}</span>}
      {file.risk !== "low" && (
        <span style={{ color: tone[t], textTransform: "uppercase", fontSize: 9, letterSpacing: "0.08em", flexShrink: 0 }}>{file.risk}</span>
      )}
    </button>
  );
}
