import { useMemo } from "react";
import { collapse, diffLines } from "../lib/lineDiff";
import { color, font, radius, fs } from "../theme";

// "What changed": a computed line diff of base → shipped (green additions / red removals). Long
// unchanged runs collapse to a fold so the eye lands on the change. The texts this renders (a SKILL.md,
// a reference doc) are small, so the O(n·m) LCS is fine.
//
// Shared by the Skills page's per-file compare view and the released-skill panel (card 75ea3f73) — ONE
// renderer, so the two can never disagree about how a diff reads. The LCS itself is in lib/lineDiff.ts.
export function LineDiff({ base, shipped }: { base: string; shipped: string }) {
  const rows = useMemo(() => collapse(diffLines(base, shipped)), [base, shipped]);
  if (rows.every((r) => r.t === " " || r.t === "fold")) {
    return <span style={{ color: color.text3, fontSize: fs.sm }}>No textual change.</span>;
  }
  return (
    <pre style={{ margin: 0, maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
      fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5,
      background: color.surface, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: 8 }}>
      {rows.map((r, i) => {
        if (r.t === "fold") return <div key={i} style={{ color: color.text3 }}>{`  ⋯ ${r.n} unchanged ${r.n === 1 ? "line" : "lines"}`}</div>;
        const c = r.t === "+" ? color.liveFg : r.t === "-" ? color.danger : color.text2;
        const text = r.text.replace(/\r$/, "");
        return <div key={i} style={{ color: c }}>{`${r.t} ${text}`}</div>;
      })}
    </pre>
  );
}
