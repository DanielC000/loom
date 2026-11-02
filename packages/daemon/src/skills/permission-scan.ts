import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SkillPermissionVector } from "@loom/shared";
import { claudeSkillsDir } from "../pty/claude-doctrine.js";
import { CLAUDE_DOCTRINE_DIR, CWD_SKILLS_SCAN_SCOPE } from "../pty/claude-dirname.js";
import { detectPermissionWidening, frontmatterReadIncomplete } from "./permissionWidening.js";
import { fingerprintSkillDir } from "./inject.js";

/** Card 015fdb23 — bounds for the spawn-time cwd-skills permission-frontmatter scan, so a pathological
 *  `.claude/skills` directory can't add unbounded latency to every in-scope spawn. See the decision
 *  record for why these are not raised casually. */
export const PERMISSION_SCAN_MAX_ENTRIES = 64;
export const PERMISSION_SCAN_MAX_READ_BYTES = 4096;

/** CR round 3, finding 1: bound on how many entry NAMES a single `"entries"` truncation reports — the
 *  cap hit itself is always reported (see {@link SkillPermissionScanTruncation}), but a pathological
 *  directory padded with thousands of dummy entries must not make the truncation report itself unbounded.
 *  `skippedCount` on that same entry always carries the TRUE count, even once `names` is cut off here. */
export const TRUNCATION_NAMES_MAX = 32;

/** Re-exported from `../pty/claude-dirname.js` (CR round 4, item 7 — that leaf module is now the real
 *  source of truth, kept import-light so `companion/attention-push.ts` can reuse this label without
 *  acquiring this file's own `inject.js`/pty-doctrine imports transitively). Every existing consumer of
 *  this export from here is unaffected. */
export { CWD_SKILLS_SCAN_SCOPE };

/** This scan's own vocabulary is narrower than {@link SkillPermissionVector}: `shell-inline`/
 *  `shell-fenced` are excluded on purpose — `disableSkillShellExecution` (this same card) already
 *  neutralizes both for every `LOOM_DRIVEN_ROLES` session (`assistant` included), so flagging them here
 *  too would warn about a vector that no longer executes for the role this scan's escalation path cares
 *  about. See the decision record ("already neutralized" note, card 979f29b9). */
export type SkillPermissionField = Extract<SkillPermissionVector, "allowed-tools" | "hooks">;
const SCAN_FIELDS: readonly SkillPermissionField[] = ["allowed-tools", "hooks"];

export interface SkillPermissionFinding {
  name: string;
  fields: SkillPermissionField[];
  /** sha256 of the exact bytes scanned (`head`, below) — never persisted on the durable event itself;
   *  used only as the dedupe key's per-skill component (see SessionService.handleSkillPermissionFrontmatterWarning). */
  contentHash: string;
}

/**
 * @decision 015fdb23 — a scan-bound hit is itself reported, never swallowed silently; see the decision
 * record's "Round 3" section for why and the two `cap` shapes.
 */
export interface SkillPermissionScanTruncation {
  /** `"entries"` — the directory held more than {@link PERMISSION_SCAN_MAX_ENTRIES}; `names` lists the
   *  entries beyond the cap never even looked at (bounded to {@link TRUNCATION_NAMES_MAX} —
   *  `skippedCount` always carries the TRUE number skipped). `"readBytes"` — a scanned skill's own
   *  frontmatter block didn't close within {@link PERMISSION_SCAN_MAX_READ_BYTES} (see
   *  `frontmatterReadIncomplete`'s own doc — never reported merely because the FILE is larger than the
   *  cap), so detection may have missed a field past where the read stopped; `names` is that one skill's
   *  name. */
  cap: "entries" | "readBytes";
  names: string[];
  /** Only meaningful for `cap === "entries"` — the TRUE count skipped, even once `names` is bounded. */
  skippedCount?: number;
  /**
   * `cap === "readBytes"` only — the affected skill's real SKILL.md file size and mtime (`fstatSync`,
   * read in the same call as the head itself — never a second stat). CR round 4, item 4: these make the
   * push-dedupe key (`SessionService.handleSkillPermissionFrontmatterWarning`) content-aware for a
   * truncation, not just a real finding — a hooked skill whose file keeps changing size/mtime while
   * still past the cap must keep re-alerting, never dedupe forever against stale truncation metadata.
   */
  size?: number;
  mtimeMs?: number;
}

export interface SkillPermissionScanResult {
  findings: SkillPermissionFinding[];
  truncated: SkillPermissionScanTruncation[];
  /**
   * `true` means "this result may be missing a real finding" (a non-ENOENT `readdir` error, or an
   * existing-but-unreadable SKILL.md), never "something was detected." Treat it like a real finding for
   * dedupe purposes — never clear a stale dedupe key on it (see the handler's own doc).
   *
   * @decision 015fdb23 — a scan that could not fully run is never reported as clean merely because it
   * produced no findings.
   */
  incomplete: boolean;
}

/**
 * @decision 015fdb23 — scans ONLY `<cwd>/.claude/skills`, DETECT ONLY (never strips/blocks — Loom does
 * not own this file). See the decision record (folds in card 979f29b9's "warn only" ruling) for the
 * scope limit and why a Loom-owned name is excluded.
 *
 * Flags a non-Loom-owned skill carrying `allowed-tools:`/`hooks:` frontmatter via the ONE shared
 * detector (`detectPermissionWidening`, card 87a51903 — never a second hand-rolled pattern set),
 * filtered to {@link SCAN_FIELDS}.
 *
 * `claimedFingerprints` (CR round 3, finding 3) — `InjectSkillsResult.claimedFingerprints` from the SAME
 * `injectSkills` call this scan runs right after. A `claimedByLoom` name is excluded from the scan ONLY
 * when its CURRENT on-disk content fingerprint matches one Loom itself recorded placing there; bare
 * manifest membership is never enough — a claimed name whose SKILL.md was edited since placement (to
 * add `hooks:`/`allowed-tools:`) has no matching fingerprint and so IS scanned, exactly like any other
 * non-Loom-owned content. Omitted (or a name with no entry in the map) ⇒ that name cannot be verified and
 * is scanned too — fail toward scanning, never toward trusting an unverifiable claim.
 *
 * Bounded and best-effort: at most `PERMISSION_SCAN_MAX_ENTRIES` directory entries (in `readdirSync`'s
 * own order) are considered; each candidate's SKILL.md is read up to `PERMISSION_SCAN_MAX_READ_BYTES`
 * only (frontmatter lives at the top of the file) — the entries cap being hit, or a candidate's own
 * frontmatter block not closing within that read, is reported via `truncated` (see
 * {@link SkillPermissionScanTruncation}), never silently. Never throws: a MISSING SKILL.md (nothing to
 * flag) is silent, but a genuine I/O error reading an EXISTING one, or a non-ENOENT `readdir` failure on
 * the target dir itself, sets `incomplete:true` on the result rather than being folded into "clean". A
 * symlinked/junctioned skill dir is skipped outright, never followed.
 *
 * ⚠️ `detectPermissionWidening`'s own frontmatter bound requires the CLOSING `---` fence to be present
 * in the string it's given — unlike an `|$` fallback, it finds nothing at all if the read was truncated
 * before reaching that fence. At `PERMISSION_SCAN_MAX_READ_BYTES` (4096), this never happens for a real
 * SKILL.md (frontmatter blocks are a handful of lines); a frontmatter block that somehow exceeds the cap
 * now surfaces via `truncated` (cap `"readBytes"`) instead of vanishing — see the decision record. CR
 * round 4, item 1: a FILE larger than the cap, whose frontmatter closed well within it, is NOT this case
 * — `frontmatterReadIncomplete` (`permissionWidening.ts`) is what tells the two apart.
 */
export function scanCwdSkillsForPermissionFrontmatter(
  cwd: string,
  claimedByLoom: ReadonlySet<string> | readonly string[],
  claimedFingerprints?: ReadonlyMap<string, ReadonlySet<string>>,
): SkillPermissionScanResult {
  const claimed = claimedByLoom instanceof Set ? claimedByLoom : new Set(claimedByLoom);
  const targetDir = claudeSkillsDir(cwd); // same resolution injectSkills itself uses — can never disagree
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (e) {
    // ENOENT (no .claude/skills dir at all) is the normal, legitimate "nothing to scan" case. Any other
    // error (EACCES/EBUSY/EMFILE/…) means the scan genuinely could not run and must never be reported the
    // same way as a verified-clean directory (CR round 4, item 2).
    const incomplete = (e as NodeJS.ErrnoException)?.code !== "ENOENT";
    return { findings: [], truncated: [], incomplete };
  }
  const findings: SkillPermissionFinding[] = [];
  const truncated: SkillPermissionScanTruncation[] = [];
  let incomplete = false;
  if (entries.length > PERMISSION_SCAN_MAX_ENTRIES) {
    const skipped = entries.slice(PERMISSION_SCAN_MAX_ENTRIES);
    truncated.push({ cap: "entries", names: skipped.slice(0, TRUNCATION_NAMES_MAX).map((e) => e.name), skippedCount: skipped.length });
  }
  for (const entry of entries.slice(0, PERMISSION_SCAN_MAX_ENTRIES)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue; // never follow a symlinked skill dir
    const name = entry.name;
    if (claimed.has(name)) {
      const recordedFps = claimedFingerprints?.get(name);
      const currentFp = recordedFps ? fingerprintSkillDir(path.join(targetDir, name)) : null;
      // Genuinely Loom's own, unmodified since placement — trust it, skip the scan for this name.
      if (recordedFps && currentFp && recordedFps.has(currentFp)) continue;
      // Claimed, but no verifiable match (edited since, or no recorded fingerprint at all) — fall through
      // and scan it like any other non-Loom-owned content.
    }
    const head = readHead(path.join(targetDir, name, "SKILL.md"), PERMISSION_SCAN_MAX_READ_BYTES);
    if (!head.ok) {
      // "missing" (no SKILL.md under this entry) is normal — nothing to flag. "error" (exists but could
      // not be read — EACCES/EBUSY/…) is a real scan gap, never silently folded into a clean result.
      if (head.reason === "error") incomplete = true;
      continue;
    }
    // CR round 4, item 1: only a frontmatter block that itself didn't close within what was read is a
    // real missed-detection risk — a big BODY past the cap, with the frontmatter closed well within it,
    // is not. See `frontmatterReadIncomplete`'s own doc.
    if (head.truncated && frontmatterReadIncomplete(head.content)) {
      truncated.push({ cap: "readBytes", names: [name], size: head.size, mtimeMs: head.mtimeMs });
    }
    const fields = detectPermissionWidening(head.content).filter((v): v is SkillPermissionField => (SCAN_FIELDS as readonly string[]).includes(v));
    if (fields.length) findings.push({ name, fields, contentHash: createHash("sha256").update(head.content, "utf8").digest("hex") });
  }
  return { findings, truncated, incomplete };
}

/** The repo-relative `SKILL.md` path for a flagged skill, for a loud log line naming exactly where the
 *  finding lives (card 979f29b9's requirement (a)) — derived the same way {@link claudeSkillsDir} is,
 *  never a second hand-rolled `.claude/skills/...` join. */
export function skillPermissionFindingPath(name: string): string {
  return `${CLAUDE_DOCTRINE_DIR}/skills/${name}/SKILL.md`;
}

/** Reads at most `maxBytes` of `file`. Never throws. `truncated` (CR round 3, finding 1) is true when
 *  the REAL file size exceeds `maxBytes` — confirmed via `fstatSync` on the already-open fd, never
 *  inferred from "we read exactly `maxBytes` bytes" (a file whose real size IS exactly `maxBytes` would
 *  otherwise be a false positive). `size`/`mtimeMs` (CR round 4, item 4) are read off the SAME `fstatSync`
 *  call, never a second stat.
 *
 *  `ok:false` distinguishes two cases the caller must NOT conflate (CR round 4, item 2): `"missing"` —
 *  no SKILL.md under this entry, the ordinary case, nothing to flag — vs. `"error"` — the file EXISTS but
 *  couldn't be opened/read/stat'd (EACCES/EBUSY/an I/O error mid-read/…), a real scan gap the caller must
 *  report as `incomplete`, never silently fold into a clean result. */
function readHead(
  file: string,
  maxBytes: number,
): { ok: true; content: string; truncated: boolean; size: number; mtimeMs: number } | { ok: false; reason: "missing" | "error" } {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "error" };
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const st = fs.fstatSync(fd);
    return { ok: true, content: buf.toString("utf8", 0, n), truncated: st.size > maxBytes, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, reason: "error" }; // opened fine, but read/stat failed mid-flight — a real error, not "missing"
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}
