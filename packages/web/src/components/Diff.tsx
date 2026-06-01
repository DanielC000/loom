import { color, font } from "../theme";

// Unified diff with green additions / red deletions / cyan hunk headers.
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 }}>
      {lines.map((ln, i) => {
        let c: string = color.textDim;
        if (ln.startsWith("@@")) c = color.cyan;
        else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) c = color.textMuted;
        else if (ln.startsWith("+")) c = color.phosphor;
        else if (ln.startsWith("-")) c = color.red;
        return <div key={i} style={{ color: c }}>{ln || " "}</div>;
      })}
    </pre>
  );
}
