import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { resumeDocSizeWarning } from "./resume-doc-notes.js";
import { readCodescapeToolDriftNote, readCodescapeBuildDriftNote } from "../codescape/drift-notice.js";
import { stripEscapeAndControlChars } from "../security/control-chars.js";
import { isLoomDev } from "../paths.js";

// Recycle-lineage helpers (`lineageRootId`/`liveLineageSuccessor`/`lineageResolvedPendingOp`) moved to
// `./lineage.js` (card `1c51de69`) — a general session-lineage module, not specific to this file's own
// Platform Lead resume-doc scoping (card `2fed1663`). Import from there directly; this file no longer
// re-exports them (Code Review, `f96c209a`-follow-up — a re-export with no consumer just adds a hop for
// a reader debugging `peekPendingMerge`, the exact reader DoD-2 was written for).

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
      // @decision e7dabf95 — read + STRIP + write here (never a raw copyFileSync): this is the one place
      // Loom's own code touches the base doc's bytes and hands them to a session that didn't author them.
      const seeded = stripEscapeAndControlChars(fs.readFileSync(basePath, "utf8")).text;
      fs.writeFileSync(lineagePath, seeded);
    } catch {
      /* best-effort seed — the successor Lead just starts its doc fresh instead of cold-booting on the base's content */
    }
  }
  return lineagePath;
}

/**
 * Card f437d4e9 C4: the `/platform-lead` doctrine skill ships to every end user now (dropped from
 * `DEV_ONLY_SKILLS`), so the dev-only rules it used to carry — the self-hosting `daemon_restart`/deploy
 * framing and the "don't auto-drive Loom's own product development" carve-out — were stripped from the
 * shared skill text (true for every `platform`-role install, dev and end-user alike) and live HERE
 * instead: appended at SPAWN TIME, never stored, by `composePlatformLeadStartupPrompt` below, whenever
 * `isLoomDev()` is true — so a hand-edited dev Lead agent prompt can never silently lose it (unlike a
 * stored-prompt migration, which skips an edited row by design). Appended LAST (after the agent's own,
 * possibly user-edited, startupPrompt) so it survives regardless of what that prompt says.
 */
export const PLATFORM_LEAD_PROMPT_DEV_ADDENDUM = `DEV ADDENDUM (this self-hosting install only — not part of the shared /platform-lead skill, which ships to every end user): you also own Loom's own self-hosting deploy. A daemon restart affects ALL projects and is itself a deploy — the largest blast radius on this surface, dropping every live session across every project. You hold \`daemon_restart\` directly: confirm with the human first, then execute it yourself rather than relaying through a project manager. And do NOT auto-drive Loom-product development — that is the owner's own flow. Loom's own roadmap, bugs and dev cards are the owner's to direct; field and triage escalations about them onto the board, but don't dispatch workers against Loom's own development on your own initiative — act on it only on an explicit owner directive. \`skill_write\`/\`skill_edit\` can also edit this repo's BUNDLED shipped doctrine skills on this install (not just your own workspace skill store) — before doing so on a bundled skill, read \`gate_queue\`; a \`merge\` entry for that repo's project means a commit to its mainline forfeits it.`;

/**
 * Compose the "Where things live" pre-block for a PLATFORM LEAD spawn — mirrors
 * `composeManagerStartupPrompt` (a265e28) but carries a single already-RESOLVED resume-doc path (the
 * Lead's home has no project vault of its own to derive one from). The caller decides the actual path
 * (base vs. per-lineage, on-disk seeding) and hands it in ready to emit. `notes`, if non-empty (see
 * {@link composeResumeDocOperationalNotes}), is prepended ahead of the pointer block itself — the agent
 * sees a size/staleness warning BEFORE it's told where to read. Reads `isLoomDev()` at call time (like
 * every other reader of that flag) to append {@link PLATFORM_LEAD_PROMPT_DEV_ADDENDUM} last, on every
 * fresh/recycle/forced-restart spawn of this role — never on a plain resume, which calls this function
 * not at all (see `sessions/service.ts`'s own `resume()` doc: "resume injects nothing"), so there is no
 * duplication risk across a Lead's lifetime.
 */
export function composePlatformLeadStartupPrompt(startupPrompt: string | undefined, resumeDocPath: string, notes?: string, projectWorkDir?: string): string {
  const workDirLine = projectWorkDir?.trim()
    ? `- **Your home project's work dir (also \`$LOOM_PROJECT_WORK_DIR\`):** \`${projectWorkDir.trim()}\`\n`
    : "";
  const block =
    "## Where things live (your resume doc)\n" +
    `- **Resume doc:** \`${resumeDocPath}\`\n` +
    workDirLine +
    "\n" +
    "Read + rewrite your living resume doc at the exact absolute path above, verbatim — do not " +
    "reconstruct it, and never Glob for it (a broad Glob from your home directory hits the search timeout).";
  const withNotes = notes?.trim() ? `${notes.trim()}\n\n${block}` : block;
  const own = startupPrompt?.trim();
  const withOwn = own ? `${withNotes}\n\n${own}` : withNotes;
  return isLoomDev() ? `${withOwn}\n\n${PLATFORM_LEAD_PROMPT_DEV_ADDENDUM}` : withOwn;
}

/** How far a resolved doc's mtime must lag the freshest sibling's before it's "material" enough to flag
 *  (not every few-hour gap — a Lead legitimately idling overnight shouldn't trigger this every morning). */
const SIBLING_STALENESS_MS = 48 * 60 * 60 * 1000;

/** Matches every Platform Lead resume-doc filename this feature knows about: the shared base file
 *  (`PLATFORM-LEAD-RESUME.md`) and any per-lineage sibling (`PLATFORM-LEAD-RESUME-<lineageId>.md`).
 *  Exported (card 14f14d92) so the boot-time resume-doc snapshot can enumerate every Platform Lead
 *  resume doc living in a home dir — the SAME pattern this file already uses for staleness detection,
 *  not a second hand-rolled regex that could silently drift from it. */
export function isResumeDocFilename(name: string): boolean {
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
 * spawn — every fs call is guarded. Up to four independent checks, any subset may fire:
 *
 * 1. **Size** — the resolved doc is nearing the harness Read caps, so a successor sees the warning
 *    BEFORE its first Read fails rather than silently exceeding it. Delegates to the shared
 *    `resumeDocSizeWarning` (`resume-doc-notes.ts`) — the SAME check a project manager's own
 *    `Orchestrator Log.md` gets.
 * 2. **Staleness** — the resolved doc's own mtime materially lags a sibling resume doc (the shared base,
 *    or another lineage's own file) living in the same home. Surfaced as a DIRECTED pointer — the
 *    daemon already knows which sibling is freshest — so the agent needn't hand-sort the directory
 *    itself (mirrors the /platform-lead doctrine's own "inherit the freshest sibling handoff" guidance).
 *    Fires whenever a fresher sibling exists and either the resolved doc doesn't exist yet or the gap
 *    exceeds {@link SIBLING_STALENESS_MS}.
 * 3. **Codescape tool drift** (`350bc307`) — {@link readCodescapeToolDriftNote} reports whether the
 *    RUNNING Codescape MCP server currently advertises a tool `pty/host.ts`'s CODESCAPE_TOOL_ALLOW/
 *    CODESCAPE_WRITE_TOOLS partition hasn't classified yet. Fails soft: no state yet, or codescape
 *    disabled/never probed, silently contributes nothing.
 * 4. **Codescape build drift** (`ce1bed6e`) — {@link readCodescapeBuildDriftNote}, the SAME
 *    ADDRESSED-signal shape as check 3, for the drift-restart starvation problem: a build-drift restart
 *    deferred (or its one allowance already spent) with the remaining stability window unstated, so a
 *    rebuild of the SAME commit looks safe when it would actually replace the candidate and starve the
 *    restart. Fails soft like the others.
 *
 * Returns "" when none of the checks above fire (the common, healthy-state case).
 *
 * @decision 809cc4b5 — the size check is the SAME shared check a project manager's own resume doc
 * gets, not a second near-duplicate implementation.
 *
 * `now` (default `Date.now()`, injectable like `resumeDocSizeWarning`'s own param) stamps WHEN this
 * comparison ran, distinct from send/delivery time; both compared mtimes are rendered as absolute
 * ISO-8601 timestamps and labelled which is which.
 *
 * @decision 7f0888b5 — this lets the recipient diff both timestamps directly against their own actions
 * instead of trusting a bare derived verdict, for a recommended action (a doc ROTATION) that is
 * destructive-ish and irreversible-ish.
 *
 * @decision 350bc307 — this note rides the SAME already-established Lead kickoff channel as the size/
 * staleness checks above, not a new surface, because the Lead already reads every `[loom:*]` note as
 * a directive.
 *
 * @decision ce1bed6e — this note reaches the REMEDIATION audience (the Lead, who can intervene) only,
 * never the PREVENTION audience (the rebuilding session) — that is a separate, out-of-scope channel.
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
