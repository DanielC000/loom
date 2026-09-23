import path from "node:path";
import { pathToFileURL } from "node:url";
import { diffBranch, normalizeDiffstatPath, type DiffBranchDeps, type DiffstatFile } from "./worktrees.js";
import { boundedSimpleGit, withTimeout } from "./bounded.js";
import { COMMENT_ANCHOR_LINT_SCRIPT } from "../paths.js";

export interface UnanchoredCommentBlock {
  file: string;
  startLine: number;
  endLine: number;
  length: number;
}

export interface DetectUnanchoredAddedCommentBlocksResult {
  blocks: UnanchoredCommentBlock[];
  // true iff `blocks` was capped by MAX_BLOCKS — `totalCount` (below) is what actually qualified.
  truncated: boolean;
  // Every qualifying block found, BEFORE the MAX_BLOCKS cap — equals blocks.length when !truncated.
  totalCount: number;
  // The threshold actually applied — read from the packaged comment-anchor-lint.mjs, never a second
  // hardcoded number (`formatUnanchoredCommentBlocksAdvisory` reads it back from here). `null` whenever
  // detection never ran at all (script missing/incompatible, no in-scope file, git failure) — as opposed
  // to a genuine empty result from a resolved threshold finding nothing.
  minLines: number | null;
}

const EMPTY_RESULT: DetectUnanchoredAddedCommentBlocksResult = { blocks: [], truncated: false, totalCount: 0, minLines: null };

// Bounded so a branch that (legitimately or not) adds many long unanchored blocks can't blow up either
// response — same posture as WORKER_COMMIT_LOG_MAX_ENTRIES/HOOK_POINTER_ANCHOR_CAP elsewhere.
const MAX_BLOCKS = 20;

// Mirrors git/worktrees.ts's own (unexported) GIT_OP_TIMEOUT_MS default — this file issues its own direct
// git calls (see detectUnanchoredAddedCommentBlocks below) rather than routing every one of them through
// diffBranch, so it needs its own fallback when a caller omits deps.timeoutMs.
const GIT_OP_TIMEOUT_MS = 15_000;

interface CommentAnchorLintModule {
  DEFAULT_MIN_LINES?: unknown;
  extractCommentBlocks?: (lines: string[]) => { startLine: number; endLine: number; length: number; anchorIds: string[] }[];
  isInScope?: (repoRoot: string, filePath: string) => string | null;
}

interface WellFormedCommentAnchorLintModule {
  DEFAULT_MIN_LINES: number;
  extractCommentBlocks: (lines: string[]) => { startLine: number; endLine: number; length: number; anchorIds: string[] }[];
  isInScope: (repoRoot: string, filePath: string) => string | null;
}

function isWellFormedCommentAnchorLintModule(mod: CommentAnchorLintModule): mod is WellFormedCommentAnchorLintModule {
  return typeof mod.extractCommentBlocks === "function" && typeof mod.isInScope === "function" && typeof mod.DEFAULT_MIN_LINES === "number";
}

// TEST SEAM ONLY — production code must never call this. Lets a test point the loader at a throwaway
// fixture (a well-formed module, a broken one, or one whose import hangs) without touching this daemon's
// OWN packaged asset on disk, and forces a fresh load on the next call.
let scriptPathOverrideForTest: string | null = null;
export function __setCommentAnchorLintScriptPathForTest(scriptPath: string | null): void {
  scriptPathOverrideForTest = scriptPath;
  modulePromise = undefined;
}

/**
 * @decision 9d0c004e — never import a WORKTREE's own copy of comment-anchor-lint.mjs here: untrusted
 * branch content can hang `import()` past the diff's own timeout, or freeze the daemon's whole event
 * loop. Import only this daemon's OWN packaged copy, once, memoized for the process's lifetime.
 */
let modulePromise: Promise<WellFormedCommentAnchorLintModule | null> | undefined;
function loadCommentAnchorLintModule(): Promise<WellFormedCommentAnchorLintModule | null> {
  if (!modulePromise) {
    const scriptPath = scriptPathOverrideForTest ?? COMMENT_ANCHOR_LINT_SCRIPT;
    modulePromise = (async () => {
      try {
        // Windows: dynamic import() needs a file:// URL, never a bare drive-letter path
        // (ERR_UNSUPPORTED_ESM_URL_SCHEME) — same caveat git/worktrees.ts's own loadExcludedTestDirNames
        // already documents for the identical shape.
        const mod = (await import(pathToFileURL(scriptPath).href)) as CommentAnchorLintModule;
        if (!isWellFormedCommentAnchorLintModule(mod)) {
          console.error(`[unanchored-comment-blocks] advisory disabled: ${scriptPath} is missing an expected export (extractCommentBlocks/isInScope/DEFAULT_MIN_LINES)`);
          return null;
        }
        return mod;
      } catch (e) {
        console.error(`[unanchored-comment-blocks] advisory disabled: failed to load ${scriptPath} (${e instanceof Error ? e.message : String(e)})`);
        return null;
      }
    })();
  }
  return modulePromise;
}

/**
 * Parse a unified `git diff` patch into `file -> Set<new-file line numbers this diff ADDS>`. Only `+`
 * lines inside a hunk count; a `-` (removed) line never advances the new-file line counter, and a `+++
 * /dev/null` (a deleted file) is skipped entirely (nothing to scan in a file that no longer exists). File
 * paths are kept exactly as git renders them in the patch (posix, `a/`/`b/` prefix stripped, and always
 * the REAL post-rename destination — never the `--stat` bracket form `normalizeDiffstatPath` handles).
 */
function parseAddedLineNumbers(patch: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const rest = raw.slice(4).trim();
      currentFile = rest === "/dev/null" ? null : rest.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    // Preamble lines (`diff --git a/x b/y`, `index ..`, `--- a/x`, `rename from/to`, `similarity index`)
    // all fall through here harmlessly — none of them starts with `+`/`-` in a way that could corrupt
    // `newLine` beyond the next `@@`, which always resets it before it's read again.
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ")
      || raw.startsWith("rename ") || raw.startsWith("similarity index")) continue;
    if (currentFile === null) continue;
    if (raw.startsWith("+")) {
      let set = result.get(currentFile);
      if (!set) { set = new Set(); result.set(currentFile, set); }
      set.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed — doesn't exist in the new file, doesn't advance the new-file line counter
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line
    } else {
      newLine++; // context line
    }
  }
  return result;
}

export interface DetectUnanchoredAddedCommentBlocksHint {
  /** A pre-fetched diffstat file list (e.g. reviewWorkerMerge's own diffBranch summary) — when supplied,
   *  this detector skips its own diffstat-only git call and reuses this one instead. Optional; omit for
   *  the plain no-hint path (worker_report has no pre-existing diffstat of its own to reuse). */
  allFiles?: DiffstatFile[];
}

/**
 * Diff-scoped detector for the worker_report/worker_merge comment-anchor advisory (card 9d0c004e):
 * comment blocks a branch ADDS that carry no `@decision` anchor and whose branch-ADDED line COUNT is >=
 * comment-anchor-lint.mjs's own line threshold (a block partially grown by this branch counts once its
 * newly-added lines alone clear the bar; an unchanged legacy block, zero added lines, never does).
 * Reuses `extractCommentBlocks`/`isInScope`/`DEFAULT_MIN_LINES` from the daemon's OWN packaged copy of
 * that script — see the import posture and cost-model rationale at {@link loadCommentAnchorLintModule}.
 *
 * Reads file content at the BRANCH TIP (`git show <branch>:<file>`), never the worktree — an uncommitted
 * edit there would shift line numbers relative to what the diff (against the committed `branch`) says.
 * FAILS SAFE unconditionally to `{blocks: [], truncated: false, totalCount: 0, minLines: null}` — never
 * throws; both call sites are hot paths whose own contract is advisory-only, never-blocking.
 */
export async function detectUnanchoredAddedCommentBlocks(
  repoPath: string, branch: string, base: string,
  deps: DiffBranchDeps = {}, hint: DetectUnanchoredAddedCommentBlocksHint = {},
): Promise<DetectUnanchoredAddedCommentBlocksResult> {
  try {
    const mod = await loadCommentAnchorLintModule();
    if (!mod) return EMPTY_RESULT;
    const { extractCommentBlocks, isInScope, DEFAULT_MIN_LINES: minLines } = mod;

    const allFiles = hint.allFiles ?? (await diffBranch(repoPath, branch, base, { includePatch: false }, deps)).allFiles;

    // Rename-safe candidate scoping (see normalizeDiffstatPath's own doc) — `f.file` may carry `--stat`'s
    // rename rendering, neither a real path nor a valid pathspec.
    const candidates = new Set<string>();
    for (const f of allFiles) {
      if (f.binary) continue;
      const p = normalizeDiffstatPath(f.file);
      if (isInScope(repoPath, path.join(repoPath, p)) !== null) candidates.add(p);
    }
    if (candidates.size === 0) return { blocks: [], truncated: false, totalCount: 0, minLines };

    const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
    const git = boundedSimpleGit(repoPath, timeoutMs);
    const range = `${base}...${branch}`;
    const patch = await withTimeout(
      git.diff([range, "--", ...candidates]), timeoutMs, "git diff (unanchored-comment-blocks, scoped)",
    );
    if (!patch) return { blocks: [], truncated: false, totalCount: 0, minLines };

    const addedLinesByFile = parseAddedLineNumbers(patch);
    const blocks: UnanchoredCommentBlock[] = [];
    let totalCount = 0;

    for (const [file, added] of addedLinesByFile) {
      if (added.size === 0) continue;
      let content: string;
      try {
        content = await withTimeout(git.show([`${branch}:${file}`]), timeoutMs, "git show (unanchored-comment-blocks, file content at branch tip)");
      } catch {
        continue; // deleted/renamed-away/unreadable at the branch tip — nothing to scan
      }
      const fileBlocks = extractCommentBlocks(content.split(/\r?\n/));
      for (const b of fileBlocks) {
        if (b.anchorIds.length > 0) continue;
        let addedCount = 0;
        for (let ln = b.startLine; ln <= b.endLine; ln++) if (added.has(ln)) addedCount++;
        if (addedCount < minLines) continue;
        totalCount++;
        if (blocks.length < MAX_BLOCKS) blocks.push({ file, startLine: b.startLine, endLine: b.endLine, length: b.length });
      }
    }
    return { blocks, truncated: totalCount > blocks.length, totalCount, minLines };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Render a non-empty {@link detectUnanchoredAddedCommentBlocks} result as the advisory text handed to
 * either surface (card 9d0c004e) — phrased as a directive per the card's own scope, never as a block.
 * `audience` picks the verb: the WORKER can extract and re-report itself; the MANAGER can only direct the
 * worker to, before confirming. Returns `undefined` for an empty result so both call sites can do
 * `if (note) warning = ...` without a separate emptiness check.
 */
export function formatUnanchoredCommentBlocksAdvisory(
  result: DetectUnanchoredAddedCommentBlocksResult, audience: "worker" | "manager",
): string | undefined {
  if (result.blocks.length === 0 || result.minLines === null) return undefined;
  const list = result.blocks.map((b) => `${b.file}:${b.startLine}-${b.endLine} (${b.length} lines)`).join(", ");
  const more = result.truncated ? ` (showing ${result.blocks.length} of ${result.totalCount} — list truncated)` : "";
  const action = audience === "worker"
    ? "classify each: a class A guard (keep inline) or a class B decision/incident narrative (extract to a record, then re-report)"
    : "classify each: a class A guard (keep inline), or a class B decision/incident narrative (extract to a record before confirming)";
  return `NEW UNANCHORED COMMENT BLOCK(S): this branch adds ${result.totalCount} comment block(s) with >= ${result.minLines} newly-added line(s) and no @decision anchor: ${list}${more}. Please ${action} — see the doctrine's "Extracting a decision record" section. Advisory only; this never blocks.`;
}
