import fs from "node:fs";
import path from "node:path";
import type { RotationMarker } from "@loom/shared";

/**
 * rotation-check.ts — card 1069c8e1: the daemon-native "Loom capability" for resume-doc rotation
 * integrity, replacing multiple independent hand-rolls (a committed script for the Loom Orchestrator,
 * ad hoc/no protection elsewhere) with one data-driven check every seat can opt into via its own
 * `orchestration.rotationMarkers` / `rotationLiveCommitmentsHeading` / `rotationLiveCommitmentsFloor`
 * config (see config.ts).
 *
 * DELIBERATELY NOT SHARED CODE with `packages/daemon/scripts/rotation-gate.mjs` — that script is FROZEN
 * for this card (card 1069c8e1's own hard bound: "do NOT touch rotation-gate.mjs... migrate, then
 * retire, never the reverse"). This module is a FRESH TypeScript port of its algorithm, driven by
 * per-project config instead of a hardcoded array. Because it is a port of logic already debugged in
 * production, it does not automatically inherit any bug the script already fixed — see the two
 * regression tests in `test/rotation-check.mjs` for the two specific historical bugs this port must be
 * PROVEN not to have reintroduced:
 *   1. The section-boundary NAME-ANCHOR fail-open (card `a681aed5`) — anchoring the LIVE-COMMITMENTS-
 *      style section's END boundary on a heading's NAME silently fell back to end-of-file once that
 *      heading was renamed, sweeping in an unrelated trailing numbered list and INFLATING the count
 *      (fails OPEN — a doc that lost real commitments can still read as passing). `findSectionBoundary`
 *      below is anchored STRUCTURALLY by markdown heading DEPTH instead, exactly like the script's fix.
 *   2. The EQUALITY-VS-FLOOR bug (card `34a6f07e`) — an exact-count check let a doc dodge protection by
 *      keeping new commitments OUT of the counted section (a fixed arity doesn't merely fail to catch
 *      overflow, it CREATES an incentive to produce it). The floor check below is `>=`, never `===`.
 *
 * ⚠️ HONEST LIMIT (card 1069c8e1 DoD-4, carried verbatim from the script this succeeds): every marker
 * check here is an EXACT-SUBSTRING grep. It can prove a token's literal text is still present; it CANNOT
 * see a rule that survived rotation only in reworded, summarized, or reorganized form. A green from this
 * module means "nothing was blatantly deleted" — a candidate set that nothing obviously vanished — never
 * a verdict that no meaning was lost. This must never ship advertised as proof of preservation.
 */

export const HONEST_LIMIT_NOTE =
  "[resume-doc-check] limit: every check above is an exact-substring grep — it proves literal text " +
  "survived, not that no meaning was lost to rewording. Treat a green as a candidate set, not a verdict.";

/** A marker not yet configured for this seat at all (both `rotationMarkers` empty and
 *  `rotationLiveCommitmentsHeading` unset) — distinct from `ok:true`, so an unconfigured seat is never
 *  mistaken for a checked-and-protected one. See `checkRotation`'s own `configured` field. */
export const UNCONFIGURED_WARNING =
  "[resume-doc-check] NOTHING IS CONFIGURED for this seat — ok:true here means nothing was actually " +
  "checked, not that this doc is protected. Set orchestration.rotationMarkers (and optionally " +
  "rotationLiveCommitmentsHeading/rotationLiveCommitmentsFloor) to protect it.";

function textIncludes(text: string, marker: RotationMarker): boolean {
  const haystack = marker.caseSensitive ? text : text.toLowerCase();
  const needle = marker.caseSensitive ? marker.token : marker.token.toLowerCase();
  return haystack.includes(needle);
}

export interface MarkerCheckResult {
  missing: RotationMarker[];
  /** token -> which text satisfied it. Only markers that were FOUND appear here. */
  satisfiedBy: Map<string, "active" | "rules">;
}

/**
 * A marker is satisfied by `activeText` first (checked first so an active-doc hit is never reported as
 * coming from `rulesText` even if the token also happens to appear there); only if absent from
 * `activeText` AND `rulesText` is non-null is `rulesText` consulted. A marker absent from BOTH is
 * missing — `rulesText` only ever ADDS a place to look, it never removes `activeText` as a valid source
 * (mirrors `rotation-gate.mjs`'s own `--rules` union semantics).
 */
export function checkMarkers(activeText: string, markers: readonly RotationMarker[], rulesText: string | null): MarkerCheckResult {
  const missing: RotationMarker[] = [];
  const satisfiedBy = new Map<string, "active" | "rules">();
  for (const marker of markers) {
    if (textIncludes(activeText, marker)) {
      satisfiedBy.set(marker.token, "active");
    } else if (rulesText !== null && textIncludes(rulesText, marker)) {
      satisfiedBy.set(marker.token, "rules");
    } else {
      missing.push(marker);
    }
  }
  return { missing, satisfiedBy };
}

/** Returns the heading depth (1-6) of a markdown heading line, or null if `line` isn't one. */
function headingLevel(line: string): number | null {
  const m = line.match(/^(#{1,6})\s/);
  return m ? m[1]!.length : null;
}

/**
 * Finds the first line at or after `fromIndex` that is a REAL markdown heading (so a prose mention of
 * the heading token elsewhere in the doc is inert — never itself a heading line) AND contains `token`
 * (case-insensitive). Returns the line index, or -1.
 */
function findHeadingLine(lines: readonly string[], token: string, fromIndex: number): number {
  const needle = token.toLowerCase();
  const headingRe = /^#{1,6}\s/;
  for (let i = fromIndex; i < lines.length; i++) {
    if (headingRe.test(lines[i]!) && lines[i]!.toLowerCase().includes(needle)) return i;
  }
  return -1;
}

/**
 * Finds the first line at or after `fromIndex` that is a markdown heading whose LEVEL is <= `maxLevel` —
 * i.e. a SIBLING or ANCESTOR section boundary. Returns the line index, or -1 (section runs to EOF).
 *
 * Deliberately structural: depends only on heading DEPTH, never any heading's NAME/text — this is the
 * fix for the fail-open regression described in this file's header (card `a681aed5`). A deeper heading
 * (e.g. a sub-note nested inside the section) must not prematurely end it; a shallower heading must end
 * it even though it isn't the same depth. "Same level or shallower" is the rule that gets both right.
 */
function findSectionBoundary(lines: readonly string[], fromIndex: number, maxLevel: number): number {
  for (let i = fromIndex; i < lines.length; i++) {
    const lvl = headingLevel(lines[i]!);
    if (lvl !== null && lvl <= maxLevel) return i;
  }
  return -1;
}

export interface NumberedSectionCount {
  /** null only when `headingToken`'s heading line could not be found at all. */
  count: number | null;
  /** Always names WHERE the section was measured, so a mismatch is self-diagnosable. */
  diagnostic: string;
}

/**
 * Counts `/^\d+\. /` numbered items strictly between `headingToken`'s heading LINE and the next
 * section-boundary heading line after it (same level or shallower — see `findSectionBoundary`; or EOF if
 * there is none).
 */
export function countNumberedSection(text: string, headingToken: string): NumberedSectionCount {
  const lines = text.split(/\r\n|\r|\n/);
  const startLine = findHeadingLine(lines, headingToken, 0);
  if (startLine === -1) {
    return { count: null, diagnostic: `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in the active doc` };
  }
  const startLevel = headingLevel(lines[startLine]!)!;
  const endLine = findSectionBoundary(lines, startLine + 1, startLevel);
  const sectionLines = lines.slice(startLine + 1, endLine === -1 ? lines.length : endLine);
  const matches = sectionLines.join("\n").match(/^\d+\. /gm);
  const startDesc = `heading line ${startLine + 1} ("${lines[startLine]!.trim()}")`;
  const endDesc =
    endLine === -1
      ? `end of file (no heading at level <= ${startLevel} found after it)`
      : `heading line ${endLine + 1} ("${lines[endLine]!.trim()}")`;
  return { count: matches ? matches.length : 0, diagnostic: `measured from ${startDesc} to ${endDesc}` };
}

export interface ArchiveInfo {
  exists: boolean;
  isFile: boolean;
  size: number;
}

export interface ByteCheckInput {
  /** The active doc's real on-disk byte count (fs.statSync(...).size — never a decoded-string length,
   *  so multi-byte characters count correctly), measured by the caller. */
  activeBytes: number;
  /** The CALLER's own pre-edit measurement — this module has no access to the previous version and
   *  never tries to infer it (mirrors `rotation-gate.mjs`'s `--was`). */
  preEditBytes: number;
}

export interface RotationCheckInput {
  activeText: string;
  /** Union source for markers (present in activeText OR rulesText) — null (the common case) means no
   *  union, every marker must be found in activeText alone. */
  rulesText?: string | null;
  markers: readonly RotationMarker[];
  /** "" disables the LIVE-COMMITMENTS-style floor check entirely for this seat. */
  commitmentsHeading: string;
  commitmentsFloor: number;
  /** Rotation-mode archive-existence check (mirrors `--archive`); omit/null for lint-mode (any-time). */
  archive?: ArchiveInfo | null;
  /** Cut-scoped shrinkage check (mirrors `--was`); omit/null to skip it. */
  byteCheck?: ByteCheckInput | null;
}

export interface RotationCheckResult {
  /** Whether this seat has set up ANY protection at all (markers and/or the commitments-floor check).
   *  false means `ok:true` below is VACUOUS — nothing was actually checked. Always read this before
   *  trusting `ok`. */
  configured: boolean;
  ok: boolean;
  missingMarkers: string[];
  markerSources: Record<string, "active" | "rules">;
  liveCommitments: {
    enabled: boolean;
    count: number | null;
    floor: number;
    ok: boolean;
    diagnostic: string;
  };
  archiveCheck: { checked: boolean; ok: boolean; reason?: string };
  byteCheck: { checked: boolean; ok: boolean; activeBytes?: number; preEditBytes?: number; reason?: string };
  /** DoD-4, carried verbatim — see this file's header. Always present, pass or fail. */
  honestLimitNote: string;
  /** Present (and loud) only when `configured` is false. */
  unconfiguredWarning?: string;
}

/** Pure — takes already-read file contents/stats, never touches the filesystem itself (the MCP tool
 *  handler owns all fs I/O and error handling; this function never throws). */
export function checkRotation(input: RotationCheckInput): RotationCheckResult {
  const rulesText = input.rulesText ?? null;
  const { missing, satisfiedBy } = checkMarkers(input.activeText, input.markers, rulesText);
  const markerSources: Record<string, "active" | "rules"> = {};
  for (const [token, src] of satisfiedBy) markerSources[token] = src;

  const commitmentsEnabled = input.commitmentsHeading !== "";
  const liveCommitments = commitmentsEnabled
    ? (() => {
        const section = countNumberedSection(input.activeText, input.commitmentsHeading);
        const ok = section.count !== null && section.count >= input.commitmentsFloor;
        return { enabled: true, count: section.count, floor: input.commitmentsFloor, ok, diagnostic: section.diagnostic };
      })()
    : { enabled: false, count: null, floor: input.commitmentsFloor, ok: true, diagnostic: "disabled — no rotationLiveCommitmentsHeading configured for this seat" };

  let archiveCheck: RotationCheckResult["archiveCheck"];
  if (!input.archive) {
    archiveCheck = { checked: false, ok: true };
  } else {
    const failures: string[] = [];
    if (!input.archive.exists) failures.push("archive path does not exist or is unreadable");
    else if (!input.archive.isFile) failures.push("archive path is not a regular file");
    else if (input.archive.size === 0) failures.push("archive file is empty");
    archiveCheck = { checked: true, ok: failures.length === 0, reason: failures.length ? failures.join("; ") : undefined };
  }

  let byteCheck: RotationCheckResult["byteCheck"];
  if (!input.byteCheck) {
    byteCheck = { checked: false, ok: true };
  } else {
    const { activeBytes, preEditBytes } = input.byteCheck;
    const shrank = activeBytes < preEditBytes;
    byteCheck = {
      checked: true,
      ok: shrank,
      activeBytes,
      preEditBytes,
      reason: shrank ? undefined : `active doc is ${activeBytes} byte(s), not smaller than preEditBytes ${preEditBytes} byte(s)`,
    };
  }

  const configured = input.markers.length > 0 || commitmentsEnabled;
  const ok = missing.length === 0 && liveCommitments.ok && archiveCheck.ok && byteCheck.ok;

  const result: RotationCheckResult = {
    configured,
    ok,
    missingMarkers: missing.map((m) => m.token),
    markerSources,
    liveCommitments,
    archiveCheck,
    byteCheck,
    honestLimitNote: HONEST_LIMIT_NOTE,
  };
  if (!configured) result.unconfiguredWarning = UNCONFIGURED_WARNING;
  return result;
}

/**
 * Code review (🟡, card 1069c8e1): both `resume_doc_check` tool descriptions assert "there is NO path
 * argument, so you can never check the wrong file" — true for the ACTIVE doc (which this module always
 * resolves itself), overstated as written once `archivePath` is in play: it IS a caller-supplied host
 * path that reaches `fs.statSync`. Contain it under the project's own `vaultPath` — the same place the
 * rotation doctrine already documents an archive living (`<name>.archive/<date>.md`, a sibling of the
 * active doc) — rather than accepting an arbitrary absolute path, so `archivePath` can't be used to
 * probe (exists / is-a-file / is-empty) host paths outside the project's own vault. Mirrors
 * `resolveResumeDocPath`'s own containment check (`sessions/resume-doc-notes.ts`), but REFUSES on an
 * escape instead of silently falling back — there is no "authoritative default" to fall back to for an
 * optional, caller-supplied archive path the way there is for the resume doc's own basename.
 *
 * Card 3c30258f: also the containment used for `rulesPath` (a THIRD caller-supplied host path reaching
 * `fs.readFileSync`) — same vault-scoped treatment, never a third unguarded path. `fieldName` names the
 * offending field in the returned error so a caller can't misattribute which argument was rejected.
 */
export function containUnderVault(
  vaultPath: string,
  candidatePath: string,
  fieldName: string = "archivePath",
): { ok: true; value: string } | { ok: false; error: string } {
  const resolvedVault = path.resolve(vaultPath);
  const resolvedCandidate = path.resolve(vaultPath, candidatePath);
  const within = resolvedCandidate === resolvedVault || resolvedCandidate.startsWith(resolvedVault + path.sep);
  if (!within) return { ok: false, error: `${fieldName} must resolve inside this project's vaultPath (${vaultPath}) — got ${resolvedCandidate}` };
  return { ok: true, value: resolvedCandidate };
}

export interface RunResumeDocCheckOptions {
  /** The caller's OWN resolved resume-doc absolute path — resolved by the CALLER (resolveResumeDocPath /
   *  resolvePlatformLeadResumeDocPath), never accepted as raw MCP-tool input. See this card's own design
   *  note: "no --active path argument" is the load-bearing decision that closes the class of error where
   *  a caller checks a file it named rather than the one it actually holds. */
  resumeDocPath: string;
  markers: readonly RotationMarker[];
  commitmentsHeading: string;
  commitmentsFloor: number;
  /** Optional union source for markers — an internal seam (a real path a caller resolves), not currently
   *  exposed as MCP-tool input (kept minimal for this card; see rotation-check.ts's own module doc). */
  rulesPath?: string | null;
  archivePath?: string | null;
  preEditBytes?: number | null;
}

export interface RunResumeDocCheckResult extends RotationCheckResult {
  resumeDocPath: string;
  /** false when the active doc could not be read at all (e.g. a fresh seat that hasn't written its
   *  resume doc yet) — distinct from a doc that WAS read and found missing markers, so a caller never
   *  confuses "doesn't exist yet" with "lost its protection." */
  docFound: boolean;
}

/**
 * The impure half: resolves file contents/stats for `checkRotation` and never throws — every fs call is
 * guarded, mirroring `resumeDocSizeWarning`'s own never-throw contract (this runs on an MCP tool call, so
 * a stat/read error must degrade to a reportable result, not crash the caller's turn).
 */
export function runResumeDocCheck(opts: RunResumeDocCheckOptions): RunResumeDocCheckResult {
  const configured = opts.markers.length > 0 || opts.commitmentsHeading !== "";

  let activeText: string | null;
  try {
    activeText = fs.readFileSync(opts.resumeDocPath, "utf8");
  } catch {
    activeText = null;
  }
  if (activeText === null) {
    const result: RunResumeDocCheckResult = {
      resumeDocPath: opts.resumeDocPath,
      docFound: false,
      configured,
      ok: false,
      missingMarkers: opts.markers.map((m) => m.token),
      markerSources: {},
      liveCommitments: {
        enabled: opts.commitmentsHeading !== "",
        count: null,
        floor: opts.commitmentsFloor,
        ok: false,
        diagnostic: `active doc not found at ${opts.resumeDocPath}`,
      },
      archiveCheck: { checked: false, ok: true },
      byteCheck: { checked: false, ok: true },
      honestLimitNote: HONEST_LIMIT_NOTE,
    };
    if (!configured) result.unconfiguredWarning = UNCONFIGURED_WARNING;
    return result;
  }

  let rulesText: string | null = null;
  if (opts.rulesPath) {
    try { rulesText = fs.readFileSync(opts.rulesPath, "utf8"); } catch { rulesText = null; }
  }

  let archive: ArchiveInfo | null = null;
  if (opts.archivePath) {
    try {
      const stat = fs.statSync(opts.archivePath);
      archive = { exists: true, isFile: stat.isFile(), size: stat.size };
    } catch {
      archive = { exists: false, isFile: false, size: 0 };
    }
  }

  let byteCheck: ByteCheckInput | null = null;
  if (opts.preEditBytes != null) {
    let activeBytes: number;
    try {
      activeBytes = fs.statSync(opts.resumeDocPath).size;
    } catch {
      // Race (deleted between the read above and this stat) — fall back to the string we already hold
      // rather than fail the whole check over a byte-count nicety.
      activeBytes = Buffer.byteLength(activeText, "utf8");
    }
    byteCheck = { activeBytes, preEditBytes: opts.preEditBytes };
  }

  const result = checkRotation({
    activeText, rulesText, markers: opts.markers,
    commitmentsHeading: opts.commitmentsHeading, commitmentsFloor: opts.commitmentsFloor,
    archive, byteCheck,
  });
  return { ...result, resumeDocPath: opts.resumeDocPath, docFound: true };
}
