import fs from "node:fs";
import path from "node:path";

/**
 * Shared resume-doc size-warning check ({@link resumeDocSizeWarning}) — the SAME check + threshold +
 * message covers both the Platform Lead's resume doc and a project manager's `Orchestrator Log.md`.
 *
 * @decision 809cc4b5 — one shared check, not two near-duplicate implementations, and this byte
 * threshold is set with real margin below the harness's actual measured break point, not just under
 * its raw byte cap.
 *
 * This byte number is a coarse PRE-FILTER for whether the note fires at all, never a predictor of where
 * a given doc actually sits against the harness's real (token) cap — bytes-per-token density swings too
 * hard with markup for that. Do NOT add a tokenizer here to make it precise: the harness already reports
 * the real token count on every `Read`, for free; {@link resumeDocSizeWarning}'s message tells the agent
 * to check that number instead of trusting this byte figure.
 *
 * @decision 774a9701 — this figure decides only whether the warning fires, never how close a doc
 * actually is to the harness's real cap; bytes-per-token swings too far with markup density for a byte
 * count to answer that on its own.
 */
export const RESUME_DOC_WARN_BYTES = 45 * 1024;

/** Platform default resume-doc basename — Loom's own convention (mirrors `PLATFORM_DEFAULTS.orchestration.resumeDocFilename`). */
export const DEFAULT_RESUME_DOC_FILENAME = "Orchestrator Log.md";

/**
 * @decision c1f2f095 — resolve every resume-doc consumer's path through this ONE function; two
 * independent resolution formulas can silently diverge on a project with a non-default
 * `resumeDocFilename`.
 *
 * Defense-in-depth: `filenameOverride` is already validated as a strict bare filename (no separators, no
 * `..`) by the agent-facing config schema (`mcp/platform.ts`'s `resumeDocFilenameSchema`) before it's
 * ever stored, but this resolver re-checks the joined result independently — if it ever resolves outside
 * `vaultPath` (a bypassed/corrupted stored value, e.g. a direct DB edit, or a future caller that skips
 * the validator), it silently falls back to the default filename rather than let the daemon vouch for an
 * escaped path in a TRUSTED prompt block.
 */
export function resolveResumeDocPath(vaultPath: string, filenameOverride?: string | null): string {
  // No vault bound (`""`) — there's no vault root to resolve against; every caller MUST check this
  // before using the result (a bare `path.resolve("")` would otherwise silently root against the
  // DAEMON's own cwd rather than fail cleanly). Belt-and-suspenders: both current callers already
  // guard, this is defense-in-depth for a future one that doesn't.
  if (!vaultPath) return "";
  const filename = filenameOverride?.trim() || DEFAULT_RESUME_DOC_FILENAME;
  const resolvedVaultPath = path.resolve(vaultPath);
  const candidate = path.resolve(vaultPath, filename);
  const withinVault = candidate === resolvedVaultPath || candidate.startsWith(resolvedVaultPath + path.sep);
  if (!withinVault) return path.join(vaultPath, DEFAULT_RESUME_DOC_FILENAME);
  return path.join(vaultPath, filename);
}

/**
 * Returns a `[loom:resume-doc-size]` warning note if `absPath` exists and is at/over
 * {@link RESUME_DOC_WARN_BYTES}, else `""`. NEVER throws: a missing file (nothing written yet), a
 * permission error, or a locked file all resolve to "nothing to warn about" — this runs on both a
 * spawn-composition path and a periodic watcher tick, neither of which may ever fail on a stat error.
 *
 * `now` (default `Date.now()`, injectable for deterministic tests — mirrors `ResumeDocWatcher.tick`'s
 * own `now` param) is stamped into the note as `measured-at`, distinct from whatever send/delivery
 * timestamp the surrounding transport may show. Deliberately NOT suppressed when stale — the note
 * instead tells the recipient how to check freshness and recover cheaply.
 *
 * @decision f17c5a76 — the note is timestamped at the moment it's stat'd, never silently dropped for
 * being possibly stale, because a silent drop loses the signal entirely.
 *
 * The byte figure is a pre-filter only, so the message points the agent at their own last `Read`'s real
 * token count rather than the KB number. The rotation recipe conditions on the doc's actual content
 * (standing rules/method vs. transient state) instead of assuming a blind reduce-to-state-only rewrite
 * is always safe.
 *
 * @decision 774a9701 — a `Write` immediately following a cap-truncated `Read` of this SAME path fails
 * "File has not been read yet", so the recipe never has the agent Read then Write back to the same
 * resume-doc path.
 */
export function resumeDocSizeWarning(absPath: string, now: number = Date.now()): string {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size < RESUME_DOC_WARN_BYTES) return "";
    const kb = Math.round(stat.size / 1024);
    const measuredAt = new Date(now).toISOString();
    return (
      `[loom:resume-doc-size] Your resume doc (\`${absPath}\`) was ~${kb}KB as of ${measuredAt} ` +
      `(measured-at — NOT this message's send time; a delayed or re-injected delivery can widen the gap ` +
      `between the two, so don't assume the two are close together). If you rotated, or otherwise ` +
      `changed this doc, at or after that timestamp, this number is stale — re-check the doc's own ` +
      `current size yourself (cheap) before acting on it. Otherwise, treat it as a heads-up, not a ` +
      `verdict: this KB figure only decides whether this note fires at all — the harness caps are a hard ` +
      `~256KB byte cap, and a tighter ~25k-token cap that bites first, and bytes-per-token swings a lot ` +
      `with markup density (as low as ~2 bytes/token for emoji/bold-heavy prose, vs. ~4-5 for plain ` +
      `prose), so this byte number cannot tell you how close you actually are. **The real test: your ` +
      `last full \`Read\` of this file already printed its own token count** (the harness reports it ` +
      `automatically, e.g. "NNNNN tokens, cap 25000") — check THAT number against ~25k, not this KB figure. ` +
      `If you haven't read it recently and don't recall the count, treat this note as reason enough to ` +
      `rotate soon rather than guessing.\n\n` +
      `Rotate per your doctrine's size budget — but deal with the doc's CONTENT first, not just its size: ` +
      `if it holds mostly standing rules/method rather than transient state (common for a resume doc ` +
      `written in this genre), those must be CARRIED FORWARD or HOMED (project memory, a design doc, ` +
      `wherever they actually belong) before you reduce to a state-only doc — a doc that's mostly rules ` +
      `has no "small fresh doc holding only current state" that stays true, and archiving the old one ` +
      `unread would discard them silently. Only jump straight to a state-only rewrite if this doc ` +
      `genuinely holds nothing but transient state.\n\n` +
      `**Do NOT Read this file and then Write directly back to that SAME path** — a Read that gets ` +
      `cap-truncated does not satisfy the Write tool's "read it first" guard for that path, and you'll be ` +
      `stuck (don't fall into a delete-then-rewrite or scratchpad-copy workaround to get around that). ` +
      `Safe recipe: (1) move the file AS-IS, unread — a plain shell \`mv\` (or PowerShell \`Move-Item\`) ` +
      `to \`<name>.archive/<YYYY-MM-DD>-NN.md\` needs no Read of its content at all; (2) if you need to ` +
      `see the old content to decide what must be carried forward, Read the ARCHIVED copy instead (page ` +
      `with offset/limit if it's large) — that's a different path you will never Write back to, so it's ` +
      `safe; (3) Write your doc — content carried forward as decided above — at the now-vacant original ` +
      `path; a Write to a path that no longer exists needs no prior Read either.`
    );
  } catch {
    return "";
  }
}
