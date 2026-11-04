// The pure line-level diff behind every "what changed between these two texts" view in the app.
//
// Extracted VERBATIM from pages/Skills.tsx (card 75ea3f73) when the released-skill panel needed the
// same render for on-disk-vs-store content. Lives in `lib/` rather than beside its one renderer so the
// LCS stays unit-testable by `test/lineDiff.mjs` under Node's type stripping (a `.tsx` file cannot be
// imported that way) — the same reason `lib/diff.ts` sits here rather than in `components/Diff.tsx`.

export type DLine = { t: "+" | "-" | " "; text: string };

// Line-level LCS diff. Backtracks a forward DP so equal lines are " ", base-only "-", shipped-only "+".
// Comparison strips a trailing \r so a CRLF/LF skew between base and shipped doesn't read as whole-file
// churn (mirrors the daemon's normalizeForCompare tolerance); display keeps the raw text (`text`).
export function diffLines(a: string, b: string): DLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const An = A.map((l) => l.replace(/\r$/, "")), Bn = B.map((l) => l.replace(/\r$/, ""));
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = An[i] === Bn[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (An[i] === Bn[j]) { out.push({ t: " ", text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ t: "-", text: A[i]! }); i++; }
    else { out.push({ t: "+", text: B[j]! }); j++; }
  }
  while (i < n) out.push({ t: "-", text: A[i++]! });
  while (j < m) out.push({ t: "+", text: B[j++]! });
  return out;
}

export type DiffRow = DLine | { t: "fold"; n: number };

// Collapse runs of >CONTEXT unchanged lines into a fold marker, keeping CONTEXT lines around each change.
export function collapse(lines: DLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.t !== " ") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) { out.push(lines[i]!); i++; continue; }
    let n = 0;
    while (i < lines.length && !keep[i]) { n++; i++; }
    out.push({ t: "fold", n });
  }
  return out;
}
