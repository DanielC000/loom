// The ⌘K palette's filtering and ranking (card bafbca40, Atlas audit finding A-29). A pure module so
// the ordering, which is the part of the palette with a real specification, is pinned by a hermetic
// unit test (test/palette-commands.mjs) rather than only by a browser.
//
// The audit's own repro is the spec: typing "bra" must surface the AUDIT-Bravo PROJECT, not just a
// request whose text happens to contain the letters. A plain `includes` cannot tell those apart, so a
// match is graded by WHERE it lands — the whole label, its start, the start of a word inside it, the
// middle of it, and last an entity row's context (the project a session or agent belongs to) — and
// the grade decides the order before anything else does.

/** What a row IS. The hint column prints this word, so a reader never has to infer it. */
export type PaletteKind = "page" | "project" | "agent" | "session" | "review" | "request";

export type PaletteRow = {
  /** Stable across renders and unique in the list — the option's DOM id derives from it. */
  key: string;
  kind: PaletteKind;
  /** The row's own name, the text a query is matched against first. */
  label: string;
  /**
   * Where the row lives — "Workspace" or a project's name. It is what tells two rows with one label
   * apart (the project Settings tab and the workspace Settings node). Searchable for a session or an
   * agent, so typing a project's name also finds what runs in it; display-only for a PAGE, whose
   * context is just the active project — matching it would answer every query that names that
   * project with a dozen tab rows, burying the project's own sessions beneath them (measured).
   */
  context?: string;
  /** The full text for the label's hover title, when it is longer than what the row shows. */
  tooltip?: string;
};

/**
 * How well `query` matches a row, lower is better, `null` for no match. Case-insensitive; the query
 * is trimmed, and an empty one matches every row equally.
 */
export function matchGrade(row: Pick<PaletteRow, "kind" | "label" | "context">, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = row.label.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  // A word start: after a space, a dash, a dot, a slash, an underscore or a "·". This is what makes
  // "bra" a strong match for "AUDIT-Bravo" and a weak one for "Library".
  const at = label.indexOf(q);
  if (at > 0) {
    let i = at;
    while (i !== -1) {
      if (/[\s\-._/·]/.test(label[i - 1] ?? "")) return 2;
      i = label.indexOf(q, i + 1);
    }
    return 3;
  }
  if (row.kind !== "page" && row.context && row.context.toLowerCase().includes(q)) return 4;
  return null;
}

/**
 * The rows a query keeps, best match first. Within one grade the INPUT order holds (the sort is
 * stable), so the caller's own grouping — pages, then projects, sessions, agents, then what needs
 * you — is the tiebreak, and an empty query shows the list exactly as the caller built it.
 */
export function rankPaletteRows<T extends PaletteRow>(rows: readonly T[], query: string): T[] {
  const graded: { row: T; grade: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const grade = matchGrade(row, query);
    if (grade !== null) graded.push({ row, grade, i });
  });
  graded.sort((a, b) => a.grade - b.grade || a.i - b.i);
  return graded.map((g) => g.row);
}

/** The next active index for an arrow key, wrapping at both ends. `-1` when there is nothing to pick. */
export function stepActive(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
