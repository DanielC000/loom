import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";

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
 * path (base vs. per-lineage, on-disk seeding) and hands it in ready to emit.
 */
export function composePlatformLeadStartupPrompt(startupPrompt: string | undefined, resumeDocPath: string): string {
  const block =
    "## Where things live (your resume doc)\n" +
    `- **Resume doc:** \`${resumeDocPath}\`\n\n` +
    "Read + rewrite your living resume doc at the exact absolute path above, verbatim — do not " +
    "reconstruct it, and never Glob for it (a broad Glob from your home directory hits the search timeout).";
  const own = startupPrompt?.trim();
  return own ? `${block}\n\n${own}` : block;
}
