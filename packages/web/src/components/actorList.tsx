import { color, fs, radius, toneFill, type Tone } from "../theme";

// Small pieces shared by the two Actors bodies, Profiles and Skills (Atlas audit A-32 / A-40, card
// 4a5f13ec): the row's muted description line, the list filter's matcher, and the empty editor pane's
// guide parts.

/** Case-insensitive substring match of `query` against any of `fields`. An empty query matches all. */
export function matchesFilter(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

/** One muted, ellipsised line under a list row's name. `text2`, not `text3`: `text3` measures ~3.1:1 on
 *  a panel, under the 4.5:1 floor that e2e actors.spec.ts asserts for every text run on a selected row. */
export function RowDescription({ text }: { text: string }) {
  return (
    <span style={{ color: color.text2, fontSize: fs.sm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

/** Term and explanation rows for an empty-pane guide. */
export function GuideList({ items }: { items: [string, string][] }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: 16, rowGap: 8 }}>
      {items.map(([term, text]) => (
        <div key={term} style={{ display: "contents" }}>
          <dt style={{ color: color.text, fontSize: fs.sm }}>{term}</dt>
          <dd style={{ margin: 0, color: color.text2, fontSize: fs.sm, lineHeight: 1.5 }}>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Decodes one of the list's status dots, which otherwise explain themselves only on hover. */
export function DotLegend({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, color: color.text2, fontSize: fs.sm }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: radius.base, background: toneFill[tone], flexShrink: 0 }} />
      {label}
    </span>
  );
}
