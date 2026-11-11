import { color, font, radius, tone, fs } from "../theme";
import { type DiffLineKind, type FileDiff, hunkLineKind, riskTone, statusGlyph } from "../lib/diff";
import { Dot } from "./ui";

// The ONE place a classified diff line kind (from lib/diff) maps to a theme color: green adds / red
// deletions / cyan hunk headers / dim context / muted file headers.
const KIND_COLOR: Record<DiffLineKind, string> = {
  add: color.liveFg,
  del: color.danger,
  hunk: color.text2,
  context: color.text2,
  meta: color.text3,
};

// The hunks of ONE file, rendered with per-line coloring + a faint hunk-header band. Pulled out so
// the collapsible FileDiffBlock can show/hide it without re-laying the lines.
function FileHunks({ file }: { file: FileDiff }) {
  if (file.binary) return <div style={{ fontSize: fs.sm, color: color.text3, padding: "8px 10px" }}>Binary file — no text diff.</div>;
  if (file.hunks.length === 0) return <div style={{ fontSize: fs.sm, color: color.text3, padding: "8px 10px" }}>No textual changes.</div>;
  return (
    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5, padding: "4px 10px 8px" }}>
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div style={{ color: color.text2, background: color.surface2, margin: "4px -10px 2px", padding: "1px 10px" }}>{h.header}</div>
          {h.lines.map((ln, i) => (
            <div key={i} style={{ color: KIND_COLOR[hunkLineKind(ln)] }}>{ln || " "}</div>
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
    <div id={anchorId} style={{ border: `1px solid ${color.line}`, borderRadius: radius.base, overflow: "hidden", scrollMarginTop: 12 }}>
      <button
        onClick={onToggle}
        className="loom-btn"
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
          background: color.inset, border: "none", borderBottom: open ? `1px solid ${color.line}` : "none",
          padding: "6px 10px", cursor: "pointer", fontFamily: font.mono, fontSize: fs.mono,
        }}
        title={open ? "Collapse" : "Expand"}
      >
        <span aria-hidden style={{ color: color.text3, width: 10, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <StatusGlyph status={file.status} />
        <Dot tone={t} glow={file.risk === "high"} title={`risk: ${file.risk}`} />
        <span style={{ color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? <><span style={{ color: color.text3 }}>{file.oldPath} → </span>{file.path}</> : file.path}
        </span>
        {file.insertions > 0 && <span style={{ color: color.liveFg, flexShrink: 0 }}>+{file.insertions}</span>}
        {file.deletions > 0 && <span style={{ color: color.danger, flexShrink: 0 }}>−{file.deletions}</span>}
      </button>
      {open && <FileHunks file={file} />}
    </div>
  );
}

// A/D/R/M status tag, tinted by meaning (added=phosphor, deleted=red, renamed=cyan, modified=dim).
export function StatusGlyph({ status }: { status: FileDiff["status"] }) {
  const c = status === "added" ? color.liveFg : status === "deleted" ? color.danger : color.text2;
  return (
    <span title={status} style={{ fontFamily: font.mono, fontSize: fs.mono, fontWeight: 700, color: c, width: 12, textAlign: "center", flexShrink: 0 }}>
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
        fontFamily: font.mono, fontSize: fs.mono, borderRadius: radius.sm,
      }}
      title={file.reasons.length ? `${file.risk} risk — ${file.reasons.join("; ")}` : `${file.risk} risk`}
    >
      <Dot tone={t} glow={file.risk === "high"} />
      <StatusGlyph status={file.status} />
      <span style={{ color: color.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{file.path}</span>
      {file.insertions > 0 && <span style={{ color: color.liveFg, flexShrink: 0 }}>+{file.insertions}</span>}
      {file.deletions > 0 && <span style={{ color: color.danger, flexShrink: 0 }}>−{file.deletions}</span>}
      {file.risk !== "low" && (
        <span style={{ color: tone[t], fontSize: fs.xs, flexShrink: 0 }}>{file.risk}</span>
      )}
    </button>
  );
}
