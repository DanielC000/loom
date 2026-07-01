// Client-side analysis of a worker branch's unified diff (the BranchDiff.patch string), for the
// review/merge gate's fast-triage surface. Pure, dependency-free, and unit-shaped so the ReviewPanel
// and the Mission Control review queue read the SAME derivation. No backend: everything here is
// computed from the patch git already produced — an auto-summary, a per-file overview, and a
// pragmatic risk ranking so a human's attention lands on the load-bearing changes first.

export type RiskLevel = "high" | "medium" | "low";

export interface FileDiff {
  path: string; // the new path (or the surviving path for a delete)
  oldPath?: string; // set only when renamed (a/<oldPath> → b/<path>)
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  insertions: number;
  deletions: number;
  hunks: { header: string; lines: string[] }[];
  risk: RiskLevel;
  reasons: string[]; // why this file carries its risk level (human-readable)
}

export interface DiffAnalysis {
  files: FileDiff[];
  totalInsertions: number;
  totalDeletions: number;
  highRisk: number;
  mediumRisk: number;
  areas: { area: string; count: number }[]; // touched subsystems, most-touched first
  headline: string; // one-line derived intent — labelled as auto-derived in the UI
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const riskOrder = (r: RiskLevel): number => RISK_RANK[r];

// ── Risk heuristics ─────────────────────────────────────────────────────────────
// Pragmatic v1: path + change-shape signals, NOT semantic analysis. Each match contributes a level
// and a reason; a file takes the highest level it matches. Tuned to Loom's own load-bearing surfaces
// (the spawn recipe, the merge/worktree code, the trust-boundary writers, the gateway) but the
// generic signals (deletes, lockfiles, migrations, large churn) apply to any repo.
const SIGNALS: { test: RegExp; level: RiskLevel; reason: string }[] = [
  { test: /(^|\/)(pty\/host|git\/worktrees|git\/writer|vault\/writer|gateway\/server|restart|db|sessions\/service)\.ts$/, level: "high", reason: "load-bearing / invariant file" },
  { test: /(^|\/)mcp\/[^/]+\.ts$/, level: "high", reason: "MCP trust-boundary surface" },
  { test: /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/, level: "high", reason: "dependency lockfile" },
  { test: /(migration|migrate|\bschema\b|\.sql)$|\/migrations?\//i, level: "high", reason: "schema / migration" },
  { test: /(^|\/)package\.json$/, level: "medium", reason: "package manifest" },
  { test: /(^|\/)CLAUDE\.md$/, level: "medium", reason: "project doctrine (CLAUDE.md)" },
  { test: /(^|\/)\.github\/|(^|\/)(turbo|tsconfig[^/]*|vite\.config[^/]*)\.json$|\.(yml|yaml)$/, level: "medium", reason: "build / CI config" },
];

function riskFor(f: Pick<FileDiff, "path" | "status" | "insertions" | "deletions">): { risk: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let risk: RiskLevel = "low";
  const bump = (level: RiskLevel, reason: string) => {
    reasons.push(reason);
    if (RISK_RANK[level] > RISK_RANK[risk]) risk = level;
  };

  if (f.status === "deleted") bump("high", "file deleted");
  else if (f.status === "renamed") bump("medium", "file renamed / moved");

  for (const s of SIGNALS) if (s.test.test(f.path)) bump(s.level, s.reason);

  const churn = f.insertions + f.deletions;
  if (churn >= 200) bump("high", `large change (${churn} lines)`);
  else if (churn >= 80) bump("medium", `sizeable change (${churn} lines)`);

  return { risk, reasons };
}

// ── Path → subsystem (for the area roll-up) ──────────────────────────────────────
// pnpm monorepo aware: packages/<pkg> → "<pkg>", and a daemon source file rolls up to its
// subsystem ("daemon/<sub>") to match the project's commit-scope vocabulary. Anything else falls to
// its top-level directory (or "(root)" for a repo-root file).
function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "packages" && parts.length >= 2) {
    const pkg = parts[1] ?? "";
    if (pkg === "daemon" && parts[2] === "src" && parts[3]) {
      // packages/daemon/src/<sub>/… → daemon/<sub>; a file directly under src → daemon
      return parts.length > 4 ? `daemon/${parts[3]}` : "daemon";
    }
    return pkg;
  }
  return parts.length > 1 ? (parts[0] ?? "(root)") : "(root)";
}

// ── Unified-diff parser ──────────────────────────────────────────────────────────
// Splits a `git diff` patch into per-file blocks at each `diff --git` boundary and reads each block's
// status (added/deleted/renamed/modified), binary flag, +/- counts, and hunks. Defensive: a malformed
// or empty patch yields []; an unrecognised header falls back to the a/ b/ paths.
const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

export function parseDiff(patch: string): FileDiff[] {
  if (!patch.trim()) return [];
  const lines = patch.split("\n");
  const files: FileDiff[] = [];

  // Find the indices of each `diff --git` line, then carve [i, next) blocks.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]?.startsWith("diff --git ")) starts.push(i);
  if (starts.length === 0) return [];

  for (let s = 0; s < starts.length; s++) {
    const block = lines.slice(starts[s], s + 1 < starts.length ? starts[s + 1] : lines.length);
    const header = block[0] ?? "";
    const m = GIT_HEADER.exec(header);
    let oldPath: string | undefined = m?.[1];
    let newPath: string | undefined = m?.[2];

    let status: FileDiff["status"] = "modified";
    let binary = false;
    let renamed = false;
    let insertions = 0;
    let deletions = 0;
    const hunks: { header: string; lines: string[] }[] = [];
    let cur: { header: string; lines: string[] } | null = null;

    for (let i = 1; i < block.length; i++) {
      const ln = block[i];
      if (ln === undefined) continue;
      if (ln.startsWith("new file mode")) status = "added";
      else if (ln.startsWith("deleted file mode")) status = "deleted";
      else if (ln.startsWith("rename from ")) { renamed = true; oldPath = ln.slice("rename from ".length); }
      else if (ln.startsWith("rename to ")) { renamed = true; newPath = ln.slice("rename to ".length); }
      else if (ln.startsWith("Binary files") || ln.startsWith("GIT binary patch")) binary = true;
      // The ---/+++ file headers always precede the first @@, so gate them on !cur: once a hunk is
      // open every line is content, including an in-hunk line that happens to start with "--- "/"+++ "
      // (e.g. a deleted `-- comment` rendering as `--- comment`). Without the guard such a content line
      // was mis-read as a header and silently vanished from the rendered diff AND the ± counts.
      else if (!cur && ln.startsWith("--- ")) { const p = ln.slice(4); if (p !== "/dev/null" && p.startsWith("a/")) oldPath = p.slice(2); }
      else if (!cur && ln.startsWith("+++ ")) { const p = ln.slice(4); if (p !== "/dev/null" && p.startsWith("b/")) newPath = p.slice(2); }
      else if (ln.startsWith("@@")) { cur = { header: ln, lines: [] }; hunks.push(cur); }
      else if (cur) {
        // Inside a hunk the first char alone classifies the line — '+' added, '-' removed, ' ' context,
        // '\' the no-newline marker. The old `!startsWith("+++"/"---")` guards were there to skip the
        // file headers, but those are now gated above on !cur, so the guards only mis-dropped real
        // content lines (a `+++ x` add / `--- x` delete) from the counts.
        cur.lines.push(ln);
        if (ln.startsWith("+")) insertions++;
        else if (ln.startsWith("-")) deletions++;
      }
    }

    if (renamed && status === "modified") status = "renamed";
    const path = newPath ?? oldPath ?? "(unknown)";
    const { risk, reasons } = riskFor({ path, status, insertions, deletions });
    files.push({
      path,
      oldPath: renamed ? oldPath : undefined,
      status,
      binary,
      insertions,
      deletions,
      hunks,
      risk,
      reasons,
    });
  }

  return files;
}

// The authoritative diffstat git already computed (a BranchDiff numstat from git/worktrees.ts). When
// supplied, the HEADLINE totals (file / insertion / deletion counts shown to the approver) are
// single-sourced from it rather than re-derived from the client parse. The two agree today, but a
// client-parse undercount must never surface two disagreeing totals on one approver panel — the chip
// reads the numstat, so the summary must too. The per-file overview still uses the parsed files (it
// needs the hunks); only the headline numbers are reconciled to the backend source.
export interface DiffNumstat { filesChanged: number; insertions: number; deletions: number; }

// ── Auto-summary ─────────────────────────────────────────────────────────────────
// A cheap derived headline + the touched-area roll-up. No model call: the "intent" is inferred from
// change shape (mostly-added → "Adds", mostly-removed → "Removes", else "Updates") and the dominant
// subsystem(s). Labelled as auto-derived in the UI so it reads as a hint, not ground truth. Pass the
// authoritative `numstat` to single-source the headline file/±totals from git (see DiffNumstat above).
export function analyzeDiff(patch: string, numstat?: DiffNumstat): DiffAnalysis {
  const files = parseDiff(patch);
  const totalInsertions = numstat?.insertions ?? files.reduce((a, f) => a + f.insertions, 0);
  const totalDeletions = numstat?.deletions ?? files.reduce((a, f) => a + f.deletions, 0);
  const fileCount = numstat?.filesChanged ?? files.length;
  const highRisk = files.filter((f) => f.risk === "high").length;
  const mediumRisk = files.filter((f) => f.risk === "medium").length;

  const areaCounts = new Map<string, number>();
  for (const f of files) areaCounts.set(areaOf(f.path), (areaCounts.get(areaOf(f.path)) ?? 0) + 1);
  const areas = [...areaCounts.entries()].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count);

  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;
  const renamed = files.filter((f) => f.status === "renamed").length;

  let verb = "Updates";
  if (totalInsertions > totalDeletions * 3 && deleted === 0) verb = "Adds";
  else if (totalDeletions > totalInsertions * 3 && added === 0) verb = "Removes";
  else if (added > 0 && deleted === 0 && totalDeletions < totalInsertions) verb = "Extends";

  const areaPhrase = areas.length === 0
    ? "no files"
    : areas.slice(0, 3).map((a) => a.area).join(", ") + (areas.length > 3 ? ` +${areas.length - 3} more` : "");

  const extras: string[] = [];
  if (added) extras.push(`${added} new`);
  if (deleted) extras.push(`${deleted} deleted`);
  if (renamed) extras.push(`${renamed} moved`);

  const headline = fileCount === 0
    ? "No file changes vs main."
    : `${verb} ${fileCount} file${fileCount === 1 ? "" : "s"} in ${areaPhrase}${extras.length ? ` (${extras.join(", ")})` : ""}.`;

  return { files, totalInsertions, totalDeletions, highRisk, mediumRisk, areas, headline };
}

// Risk → signal tone (matches the theme's Tone vocabulary; imported where rendered).
export const riskTone = (r: RiskLevel): "red" | "amber" | "muted" =>
  r === "high" ? "red" : r === "medium" ? "amber" : "muted";

// Status → a compact single-letter glyph for the file overview (A/D/R/M).
export const statusGlyph = (s: FileDiff["status"]): string =>
  s === "added" ? "A" : s === "deleted" ? "D" : s === "renamed" ? "R" : "M";

// ── Diff line classification (drives per-line color) ───────────────────────────────
// The semantic kind of a single rendered diff line. Kept pure here (the lib is dependency-free and
// node-testable); the UI maps each kind to a theme color in one place (Diff.tsx › KIND_COLOR).
//   add → green · del → red · hunk → cyan @@ band · context → dim · meta → muted file header
export type DiffLineKind = "add" | "del" | "hunk" | "context" | "meta";

// Classifier for the lines INSIDE a parsed hunk (FileDiff.hunks[].lines), the merge-gate per-file diff.
// Keyed on the FIRST CHAR ONLY: '+' add, '-' del, '@' hunk header, anything else context. parseDiff
// strips the real `+++ b/` / `--- a/` file headers, so a hunk content line NEVER begins with a true file
// header — a deleted line whose CONTENT starts with `---`/`--`/`+++` (a markdown thematic break, a YAML
// front-matter delimiter, a SQL/CLI `-- comment`) is a genuine deletion and must read as "del" (RED),
// NOT the muted "meta" header gray that a shared colorizer wrongly gave it. There is deliberately NO
// "meta" case here; do NOT special-case `+++`/`---`. (rawPatchLineKind below DOES see real headers.)
export function hunkLineKind(ln: string): DiffLineKind {
  switch (ln[0]) {
    case "@": return "hunk";
    case "+": return "add";
    case "-": return "del";
    default: return "context";
  }
}

// Classifier for a RAW unified patch rendered line-by-line (the fleet-card expansion's worker branch-diff
// DiffView), which legitimately CONTAINS the `diff --git`/`index `/`+++ b/`/`--- a/` file headers and
// dims them as "meta". This header-dimming is WRONG for FileHunks (header-stripped content), which uses
// hunkLineKind — the two callers have opposite needs and must stay separate (the merge-gate render-bug
// split). Header check precedes +/- so `--- a/`/`+++ b/` dim before the +/- fallthrough.
export function rawPatchLineKind(ln: string): DiffLineKind {
  if (ln.startsWith("@@")) return "hunk";
  if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ")) return "meta";
  if (ln.startsWith("+")) return "add";
  if (ln.startsWith("-")) return "del";
  return "context";
}
