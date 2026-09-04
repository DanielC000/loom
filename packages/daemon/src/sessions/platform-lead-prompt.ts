import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import { resumeDocSizeWarning } from "./resume-doc-notes.js";
import { readCodescapeToolDriftNote, readCodescapeBuildDriftNote } from "../codescape/drift-notice.js";

/**
 * Card 2fed1663 — lineage-scope the Platform Lead resume doc so concurrent Leads never contend on one
 * shared file. `/platform-lead` doctrine promotes running MULTIPLE concurrent Leads AND rewriting ONE
 * living resume doc "in place"; those conflict — a second live Lead's rewrite invalidated the first's
 * read, and the loser SKIPPED recording its whole session rather than clobber (observed 2026-07-01).
 *
 * The fix: every recycle LINEAGE (the chain a Lead's successors form via `recycledFrom`) gets its own
 * resume doc. The base filename `PLATFORM-LEAD-RESUME.md` keeps TWO roles: (1) the SEED SOURCE copied
 * into a fresh lineage's own file so it never cold-boots empty, and (2) the SINGLE-LEAD DEFAULT — the
 * first lineage ever observed (an app_meta marker, claimed once, permanently) keeps reading/writing the
 * plain base file forever, so an existing single-Lead user sees zero filename churn. Only a SECOND (or
 * later, or concurrent) lineage gets its own `PLATFORM-LEAD-RESUME-<lineageId>.md`.
 */

export const PLATFORM_LEAD_RESUME_BASENAME = "PLATFORM-LEAD-RESUME.md";

/** app_meta key: the lineageId that claimed the plain base filename (set once, first-claim wins). Exported
 *  so the hermetic test can reset it between independently-scoped scenarios sharing one Db instance. */
export const PRIMARY_LINEAGE_META_KEY = "platform.primaryLeadLineageId";

/** Absolute path of the base resume doc (the seed source + the single-Lead default). */
export function platformLeadBaseResumeDocPath(homePath: string): string {
  return path.join(homePath, PLATFORM_LEAD_RESUME_BASENAME);
}

/** Absolute path of ONE lineage's own resume doc (never the base file). */
export function platformLeadLineageResumeDocPath(homePath: string, lineageId: string): string {
  return path.join(homePath, `PLATFORM-LEAD-RESUME-${lineageId}.md`);
}

/**
 * Walk a session's `recycledFrom` chain back to its LINEAGE ROOT — the original session with no
 * predecessor. Every successor in a recycle chain shares its root's id as the stable `lineageId`. A
 * fresh (non-recycled) session is its own root. Cycle-guarded (defensive; a real chain never cycles).
 */
export function lineageRootId(db: Db, session: { id: string; recycledFrom?: string | null }): string {
  let current: { id: string; recycledFrom?: string | null } = session;
  const seen = new Set<string>([current.id]);
  while (current.recycledFrom && !seen.has(current.recycledFrom)) {
    const prev = db.getSession(current.recycledFrom);
    if (!prev) break;
    seen.add(prev.id);
    current = prev;
  }
  return current.id;
}

/**
 * Walk a session's recycle-successor chain FORWARD, starting from `sessionId`, to find the LIVE end
 * of its lineage — the complement to {@link lineageRootId} (which walks BACKWARD to the root). At each
 * step it follows `db.getSuccessor` (the session, if any, whose `recycledFrom` points at the current
 * one) until it finds a live session or the chain runs out. Cycle-guarded (defensive; a real chain
 * never cycles). Returns null if `sessionId` doesn't exist or no live session exists anywhere forward
 * in its lineage.
 */
export function liveLineageSuccessor(db: Db, sessionId: string): Session | null {
  let current: Session | undefined = db.getSession(sessionId);
  const seen = new Set<string>();
  while (current) {
    if (current.processState === "live") return current;
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = db.getSuccessor(current.id);
  }
  return null;
}

/**
 * Resolve the ABSOLUTE resume-doc path for a Platform Lead spawn (fresh or recycle-successor), given
 * its lineageId. IMPURE (reads/writes app_meta + the filesystem) — the only piece of this feature that
 * can't be pure, since "who owns the base file" and "has this lineage's doc been seeded" are durable
 * facts, not derivable from the lineageId alone.
 *
 * - First lineage ever observed (no marker set yet) claims the base file PERMANENTLY.
 * - That SAME lineage's later successors resolve back to the base file (marker match).
 * - Any OTHER lineage gets its own per-lineage file, SEEDED once from the base doc's content if the
 *   base doc exists (best-effort; a copy failure never blocks a spawn — the agent starts fresh instead).
 */
export function resolvePlatformLeadResumeDocPath(db: Db, homePath: string, lineageId: string): string {
  const basePath = platformLeadBaseResumeDocPath(homePath);
  let primary = db.getMeta(PRIMARY_LINEAGE_META_KEY);
  if (!primary) {
    db.setMeta(PRIMARY_LINEAGE_META_KEY, lineageId);
    primary = lineageId;
  }
  if (primary === lineageId) return basePath;

  const lineagePath = platformLeadLineageResumeDocPath(homePath, lineageId);
  if (!fs.existsSync(lineagePath) && fs.existsSync(basePath)) {
    try {
      fs.copyFileSync(basePath, lineagePath);
    } catch {
      /* best-effort seed — the successor Lead just starts its doc fresh instead of cold-booting on the base's content */
    }
  }
  return lineagePath;
}

/**
 * Compose the "Where things live" pre-block for a PLATFORM LEAD spawn — mirrors
 * `composeManagerStartupPrompt` (a265e28) but carries a single already-RESOLVED resume-doc path (the
 * Lead's home has no project vault of its own to derive one from). PURE: the caller decides the actual
 * path (base vs. per-lineage, on-disk seeding) and hands it in ready to emit. `notes`, if non-empty
 * (see {@link composeResumeDocOperationalNotes}), is prepended ahead of the pointer block itself — the
 * agent sees a size/staleness warning BEFORE it's told where to read.
 */
export function composePlatformLeadStartupPrompt(startupPrompt: string | undefined, resumeDocPath: string, notes?: string): string {
  const block =
    "## Where things live (your resume doc)\n" +
    `- **Resume doc:** \`${resumeDocPath}\`\n\n` +
    "Read + rewrite your living resume doc at the exact absolute path above, verbatim — do not " +
    "reconstruct it, and never Glob for it (a broad Glob from your home directory hits the search timeout).";
  const withNotes = notes?.trim() ? `${notes.trim()}\n\n${block}` : block;
  const own = startupPrompt?.trim();
  return own ? `${withNotes}\n\n${own}` : withNotes;
}

/** How far a resolved doc's mtime must lag the freshest sibling's before it's "material" enough to flag
 *  (not every few-hour gap — a Lead legitimately idling overnight shouldn't trigger this every morning). */
const SIBLING_STALENESS_MS = 48 * 60 * 60 * 1000;

/** Matches every Platform Lead resume-doc filename this feature knows about: the shared base file
 *  (`PLATFORM-LEAD-RESUME.md`) and any per-lineage sibling (`PLATFORM-LEAD-RESUME-<lineageId>.md`). */
function isResumeDocFilename(name: string): boolean {
  return /^PLATFORM-LEAD-RESUME(-.+)?\.md$/.test(name);
}

/**
 * Find the most-recently-modified sibling resume doc in `homePath`, excluding `excludePath`. ONE bounded
 * directory listing (never recursive, never a Glob) — `homePath` is `LOOM_HOME`, a small Loom-managed
 * directory (not the user's Obsidian vault), so this is cheap and safe on the spawn path. Returns null if
 * none exist or `homePath` is unreadable (never throws — a spawn must never be blocked by this).
 */
export function findFreshestSiblingResumeDoc(homePath: string, excludePath: string): { path: string; mtimeMs: number } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(homePath);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!isResumeDocFilename(name)) continue;
    const candidate = path.join(homePath, name);
    if (candidate === excludePath) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(candidate).mtimeMs;
    } catch {
      continue; // race: listed then removed — skip rather than throw
    }
    if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
  }
  return best;
}

/**
 * Compose the operational note block injected ahead of the resume-doc pointer (mirrors the other
 * `[loom:*]` nudges elsewhere in Loom). IMPURE (stats the filesystem) but never throws and never blocks a
 * spawn — every fs call is guarded. Two independent checks, either/both/neither may fire:
 *
 * 1. **Size** — the resolved doc is nearing the harness Read caps, so a successor sees the warning
 *    BEFORE its first Read fails rather than silently exceeding it. Delegates to the shared
 *    `resumeDocSizeWarning` (`resume-doc-notes.ts`) — the SAME check a project manager's
 *    `Orchestrator Log.md` gets, card 809cc4b5.
 * 2. **Staleness** — the resolved doc's own mtime materially lags a sibling resume doc (the shared base,
 *    or another lineage's own file) living in the same home. Surfaced as a DIRECTED pointer — the
 *    daemon already knows which sibling is freshest — so the agent needn't hand-sort the directory
 *    itself (mirrors the /platform-lead doctrine's own "inherit the freshest sibling handoff" guidance).
 *    Fires whenever a fresher sibling exists and either the resolved doc doesn't exist yet or the gap
 *    exceeds {@link SIBLING_STALENESS_MS}.
 * 3. **Codescape tool drift** (card `350bc307`) — {@link readCodescapeToolDriftNote} reports whether the
 *    RUNNING Codescape MCP server currently advertises a tool `pty/host.ts`'s CODESCAPE_TOOL_ALLOW/
 *    CODESCAPE_WRITE_TOOLS partition hasn't classified yet. This is the ADDRESSED signal for that check
 *    (not a log line) — the Lead owns platform-wide concerns and reads every `[loom:*]` kickoff note as
 *    a directive, so a non-empty finding rides the SAME already-established channel as the two checks
 *    above rather than a new, easy-to-ignore surface. Fails soft like the others: no state yet, or
 *    codescape disabled/never probed, silently contributes nothing.
 * 4. **Codescape build drift** (card `ce1bed6e`) — {@link readCodescapeBuildDriftNote}, the SAME
 *    ADDRESSED-signal shape as check 3, for the drift-restart starvation problem: a build-drift restart
 *    deferred (or its one allowance already spent) with the remaining stability window unstated, so a
 *    rebuild of the SAME commit looks safe when it would actually replace the candidate and starve the
 *    restart. This is the REMEDIATION audience only (the Lead notices and can intervene) — it does not
 *    reach the PREVENTION audience (a codescape-enabled project's own session, who could just not rebuild
 *    again); that is a separate, shared channel out of this card's scope. Fails soft like the others.
 *
 * Returns "" when none of the checks above fire (the common, healthy-state case).
 *
 * Card `7f0888b5` — reported by another Loom project, the sibling of `f17c5a76`'s size-warning fix: the
 * staleness note used to compare two mtimes and render NEITHER, handing the recipient a bare verdict
 * ("your doc is stale") with no way to check it against an action they themselves took. Worse than the
 * size note's old defect — that one at least carried the raw measurement — because the recommended action
 * here is a doc ROTATION (destructive-ish, irreversible-ish): the originating incident was a Lead told to
 * rotate a doc it had rotated 7 minutes earlier. `now` (default `Date.now()`, injectable like
 * `resumeDocSizeWarning`'s own param) stamps WHEN this comparison ran, distinct from send/delivery time;
 * both compared mtimes are rendered as absolute ISO-8601 timestamps and labelled which is which, so the
 * recipient can diff them directly against their own actions instead of trusting the derived verdict.
 */
export function composeResumeDocOperationalNotes(homePath: string, resumeDocPath: string, now: number = Date.now()): string {
  const notes: string[] = [];

  const sizeNote = resumeDocSizeWarning(resumeDocPath, now);
  if (sizeNote) notes.push(sizeNote);

  const toolDriftNote = readCodescapeToolDriftNote(homePath);
  if (toolDriftNote) notes.push(toolDriftNote);

  const buildDriftNote = readCodescapeBuildDriftNote(homePath);
  if (buildDriftNote) notes.push(buildDriftNote);

  let resolvedMtimeMs: number | null = null;
  try {
    resolvedMtimeMs = fs.statSync(resumeDocPath).mtimeMs;
  } catch {
    /* doc doesn't exist yet (a fresh, unseeded lineage) — nothing to stale-check against */
  }

  const sibling = findFreshestSiblingResumeDoc(homePath, resumeDocPath);
  if (sibling && (resolvedMtimeMs === null || sibling.mtimeMs - resolvedMtimeMs >= SIBLING_STALENESS_MS)) {
    const measuredAt = new Date(now).toISOString();
    const siblingModifiedAt = new Date(sibling.mtimeMs).toISOString();
    const ownModifiedAt = resolvedMtimeMs === null ? "does not exist yet" : new Date(resolvedMtimeMs).toISOString();
    notes.push(
      `[loom:resume-doc-stale] A sibling resume doc at \`${sibling.path}\` (last modified ${siblingModifiedAt}) ` +
      `was modified more recently than your lineage's own doc at \`${resumeDocPath}\` (last modified ` +
      `${ownModifiedAt}) — measured-at ${measuredAt} (NOT this message's send time; a delayed or ` +
      `re-injected delivery can widen the gap between the two, so don't assume the two are close ` +
      `together). If you rotated, or otherwise changed, your own doc at or after that own-doc timestamp, ` +
      `this comparison is stale — re-check both files' current mtimes yourself before acting on it. ` +
      `Otherwise, the sibling may hold more current state — check it before trusting your own doc as ` +
      `fully current.`,
    );
  }

  return notes.join("\n\n");
}
