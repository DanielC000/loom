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
 * for this card: migrate off it, never edit it. This module is a fresh TypeScript port of its algorithm;
 * because it is a port of logic already debugged in production, it does not automatically inherit any bug
 * the script already fixed — see the two regression tests in `test/rotation-check.mjs` for the historical
 * bugs this port must be proven not to have reintroduced: @decision a681aed5 (the section-boundary
 * NAME-ANCHOR fail-open; `findSectionBoundary` below anchors STRUCTURALLY by heading DEPTH instead) and
 * @decision 34a6f07e (the EQUALITY-VS-FLOOR bug; the floor check below is `>=`, never `===`).
 *
 * ⚠️ HONEST LIMIT (card 1069c8e1 DoD-4, carried verbatim from the script this succeeds): every marker
 * check here is an EXACT-SUBSTRING grep. It can prove a token's literal text is still present; it CANNOT
 * see a rule that survived rotation only in reworded, summarized, or reorganized form. A green from this
 * module means "nothing was blatantly deleted" — a candidate set that nothing obviously vanished — never
 * a verdict that no meaning was lost. This must never ship advertised as proof of preservation.
 *
 * @decision e312b207 — the LIVE COMMITMENTS floor is now UNIONED with `rules` too, mirroring the marker
 * union's own precedence; see `countNumberedSectionUnion` below for the mechanism.
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
  /** null only when `headingToken`'s heading line could not be found at all IN THIS TEXT. */
  count: number | null;
  /** ALWAYS a non-empty string — on a hit it names WHERE the section was measured (so a mismatch is
   *  self-diagnosable); on a miss (count:null) it still explains what was searched for. Never omitted
   *  either way — unlike `NumberedSectionUnionCount`'s `otherDiagnostic`, which genuinely IS conditional. */
  diagnostic: string;
}

/**
 * Counts `/^\d+\. /` numbered items strictly between `headingToken`'s heading LINE and the next
 * section-boundary heading line after it (same level or shallower — see `findSectionBoundary`; or EOF if
 * there is none). Single-text only — see `countNumberedSectionUnion` below for the active/rules union
 * built on top of this (card e312b207).
 */
export function countNumberedSection(text: string, headingToken: string): NumberedSectionCount {
  const lines = text.split(/\r\n|\r|\n/);
  const startLine = findHeadingLine(lines, headingToken, 0);
  if (startLine === -1) {
    // Code review (card e312b207, item 5a): this text is generic — `countNumberedSectionUnion` calls it
    // against `rulesText` just as often as `activeText` — so the message must not name a specific caller.
    // (Today every union caller discards this exact string on the not-found path and builds its own
    // union-aware message instead, so nothing currently leaks the old "active doc" wording — but a FUTURE
    // direct caller of this exported function would have, which is the trap this fixes.)
    return { count: null, diagnostic: `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in this text` };
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

export interface NumberedSectionUnionCount extends NumberedSectionCount {
  /** Which text the count actually came from — null only alongside `count: null` (found in neither). */
  source: "active" | "rules" | null;
  /**
   * Card e312b207 change requested by code review (T3): true when the heading was found in BOTH texts —
   * `activeText` still wins by precedence (see this function's own doc), but this shape is the expected
   * transient RESIDUE of a doc mid-migration into the rules file (e.g. a leftover heading where only a
   * plain prose pointer should remain) rather than a genuine steady state, and must never pass silently.
   * Absent (not merely `false`) whenever it doesn't apply, so a caller can test truthiness directly.
   */
  ambiguous?: true;
  /** Present only when `ambiguous` is true — the count/diagnostic the OTHER file (rules) would have
   *  produced, so a caller can report both sides, not just the winner. */
  otherCount?: number;
  otherDiagnostic?: string;
}

/**
 * @decision e312b207 — UNION over `activeText` and `rulesText`: `activeText` tried FIRST (measured
 * byte-identically to before this card while the section stays there), `rulesText` consulted ONLY when
 * `activeText` carries no such heading at all. FAIL-CLOSED: `count: null, source: null` when the heading
 * is in NEITHER text — callers must treat a null count as a hard failure, never a vacuous "0 items,
 * nothing to check, ok:true".
 *
 * AMBIGUITY: a post-move breadcrumb heading left in the active doc SHADOWS the now-authoritative
 * rules-file section (active wins by precedence; the rules file is never even read for the count in that
 * case). This function does not change WHICH count wins when that happens — hard-failing "found in both"
 * would reopen a red window during the migration, and is a deliberate non-goal here — it only makes the
 * shape VISIBLE via `ambiguous`/`otherCount`/`otherDiagnostic` so a caller (`checkRotation` below) can
 * surface a loud, non-gating warning instead of a silent green.
 */
export function countNumberedSectionUnion(activeText: string, rulesText: string | null, headingToken: string): NumberedSectionUnionCount {
  const inActive = countNumberedSection(activeText, headingToken);
  const inRules = rulesText !== null ? countNumberedSection(rulesText, headingToken) : null;
  if (inActive.count !== null) {
    if (inRules !== null && inRules.count !== null) {
      return { ...inActive, source: "active", ambiguous: true, otherCount: inRules.count, otherDiagnostic: inRules.diagnostic };
    }
    return { ...inActive, source: "active" };
  }
  if (inRules !== null && inRules.count !== null) {
    return { count: inRules.count, diagnostic: `${inRules.diagnostic} (in rules)`, source: "rules" };
  }
  return {
    count: null,
    source: null,
    diagnostic:
      rulesText !== null
        ? `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in the active doc or rules file`
        : `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in the active doc`,
  };
}

/**
 * Card f6985338: N-file generalization of the single-`rules`-file union above, used ONLY on the NEW
 * `rulesFiles` code path in `checkRotation` (see that function's own branch comment) — the ORIGINAL
 * `checkMarkers`/`countNumberedSectionUnion` above stay completely untouched and remain the code path for
 * a caller that supplies at most the legacy singular `rules` field, which is what makes that call
 * BYTE-IDENTICAL to pre-f6985338 behavior (this card's own DoD-1 — the regression that matters most).
 *
 * `label` is what a caller sees in `markerSources`/`liveCommitments.source` when THIS source is what
 * satisfied a check — "rules" for the legacy singular `rules` field (so a caller mixing the old field with
 * the new `rulesFiles` list still gets the familiar label for that one), or the file's own `resolvedPath`
 * for anything supplied via `rulesFiles` (this is the "which file satisfied it" DoD-3 asks for).
 */
export interface RuleFileSource {
  label: string;
  text: string;
}

/** A single supplied-and-attempted rules FILE in the `rulesFiles` list — unlike the legacy `RulesInput`,
 *  never `null` (an entry only exists here because a path was actually supplied and read/attempted). */
export type RulesFileEntry = { resolvedPath: string; text: string } | { resolvedPath: string; error: string };

export interface MarkerCheckResultMulti {
  missing: RotationMarker[];
  /** token -> "active" or the satisfying source's `label` (see `RuleFileSource` above). Only FOUND markers
   *  appear here — mirrors `MarkerCheckResult.satisfiedBy` exactly, just widened from a 2-value union to
   *  any source label. */
  satisfiedBy: Map<string, string>;
}

/**
 * N-file marker union (card f6985338). Same precedence rule as `checkMarkers`: `activeText` first, then
 * `sources` IN THE ORDER GIVEN — the first source that contains a marker wins, mirroring exactly how the
 * single-file version tries `rulesText` only after `activeText` comes up empty. A marker absent from
 * `activeText` and every source in `sources` is missing.
 */
export function checkMarkersUnion(
  activeText: string,
  markers: readonly RotationMarker[],
  sources: readonly RuleFileSource[],
): MarkerCheckResultMulti {
  const missing: RotationMarker[] = [];
  const satisfiedBy = new Map<string, string>();
  for (const marker of markers) {
    if (textIncludes(activeText, marker)) {
      satisfiedBy.set(marker.token, "active");
      continue;
    }
    const hit = sources.find((s) => textIncludes(s.text, marker));
    if (hit) satisfiedBy.set(marker.token, hit.label);
    else missing.push(marker);
  }
  return { missing, satisfiedBy };
}

export interface NumberedSectionUnionCountMulti {
  count: number | null;
  diagnostic: string;
  /** "active", a source's `label`, or null (found nowhere) — generalizes `NumberedSectionUnionCount.source`
   *  from a 3-value union to any source label. */
  source: string | null;
  /** true when the heading was ALSO found somewhere else besides the winning `source` — generalizes the
   *  single-file version's `ambiguous` boolean to N files; see `others` below for the per-source detail
   *  the single-file version reported as singular `otherCount`/`otherDiagnostic`. Absent (not merely
   *  false) whenever there is no other location, so a caller can test truthiness directly. */
  ambiguous?: true;
  /** Present only when `ambiguous` is true — every OTHER place (besides the winning `source`) the heading
   *  was found, each with its own count/diagnostic, so a caller can report all of them, not just the
   *  winner. Never present alongside `ambiguous` absent. */
  others?: { source: string; count: number; diagnostic: string }[];
}

/**
 * N-file generalization of `countNumberedSectionUnion` (card f6985338). Same precedence as the single-file
 * version: `activeText` tried first, then `sources` IN ORDER — the first source with the heading wins.
 * FAIL-CLOSED exactly like the single-file version: `count: null, source: null` when the heading is in
 * NEITHER `activeText` NOR any source — never a vacuous "0 items, ok:true".
 */
export function countNumberedSectionUnionMulti(
  activeText: string,
  sources: readonly RuleFileSource[],
  headingToken: string,
): NumberedSectionUnionCountMulti {
  const inActive = countNumberedSection(activeText, headingToken);
  const inSources = sources
    .map((s) => ({ label: s.label, result: countNumberedSection(s.text, headingToken) }))
    .filter((s): s is { label: string; result: NumberedSectionCount & { count: number } } => s.result.count !== null);

  if (inActive.count !== null) {
    const others = inSources.map((s) => ({ source: s.label, count: s.result.count, diagnostic: s.result.diagnostic }));
    return { ...inActive, source: "active", ...(others.length > 0 ? { ambiguous: true as const, others } : {}) };
  }
  if (inSources.length > 0) {
    const [first, ...rest] = inSources;
    return {
      count: first!.result.count,
      diagnostic: `${first!.result.diagnostic} (in ${first!.label})`,
      source: first!.label,
      ...(rest.length > 0
        ? { ambiguous: true as const, others: rest.map((s) => ({ source: s.label, count: s.result.count, diagnostic: s.result.diagnostic })) }
        : {}),
    };
  }
  return {
    count: null,
    source: null,
    diagnostic:
      sources.length > 0
        ? `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in the active doc or any supplied rules file`
        : `no heading line matching /^#{1,6}\\s.*${headingToken}/i found in the active doc`,
  };
}

export interface ArchiveInfo {
  exists: boolean;
  isFile: boolean;
  size: number;
  /** The RESOLVED path this check actually stat'd (card f596215c) — always folded into a failure reason
   *  below, so "does not exist" can never be mistaken for a claim about the file the caller NAMED when
   *  what actually failed was resolution to a different path than they expected. Optional only so an
   *  older hand-built literal (e.g. a pre-existing test fixture) doesn't need updating; every real caller
   *  supplies it. */
  path?: string;
}

export interface ByteCheckInput {
  /** The active doc's real on-disk byte count (fs.statSync(...).size — never a decoded-string length,
   *  so multi-byte characters count correctly), measured by the caller. */
  activeBytes: number;
  /** The CALLER's own pre-edit measurement — this module has no access to the previous version and
   *  never tries to infer it (mirrors `rotation-gate.mjs`'s `--was`). */
  preEditBytes: number;
}

/**
 * The rules-file union input — ONE field, not two (card 1083e8f4, Finding 2). Before this card,
 * `RotationCheckInput` carried `rulesText`/`rulesInfo` as two SEPARATE fields with an invariant
 * (`rulesInfo.readable === true` implies `rulesText !== null`) that nothing enforced — `checkRotation`'s
 * marker union derived from `rulesText` alone while `rulesCheck` derived from `rulesInfo` alone, so a
 * caller (or fixture) that set one without the other silently produced `rulesCheck.ok:true` on a union
 * that never happened. Folding both into one value makes that divergence structurally impossible: the
 * union source and the reported check are now the SAME read of the SAME field. `null`/omitted means no
 * rulesPath was supplied at all — the check stays silent, exactly as before this card. `{resolvedPath,
 * text}` is a successful read (`resolvedPath` mirrors `ArchiveInfo.path`, card f596215c); `{resolvedPath,
 * error}` is a supplied-but-unreadable path, self-diagnosing via `resolvedPath` + `error`.
 */
export type RulesInput = { resolvedPath: string; text: string } | { resolvedPath: string; error: string } | null;

export interface RotationCheckInput {
  activeText: string;
  /** Union source for markers (present in activeText OR rules.text) AND the source for `rulesCheck` below
   *  — see `RulesInput`'s own doc for why this is now one field instead of two. */
  rules?: RulesInput;
  /** Card f6985338: ADDITIONAL rules files beyond the singular `rules` above (the `rulesPaths` MCP-tool
   *  argument, already-read by the caller — mirrors `rules` itself: an entry is a successful read OR a
   *  read failure, never silently dropped). Omitted/empty ⇒ `checkRotation` runs the ORIGINAL single-file
   *  code path below completely unchanged — this is what makes a caller supplying only the legacy `rules`
   *  field BYTE-IDENTICAL to pre-f6985338 behavior (DoD-1, the regression that matters most). Non-empty ⇒
   *  markers/the commitments floor union across `rules` (if present, labeled "rules") AND every entry here
   *  (labeled by its own `resolvedPath` — see `RuleFileSource`), and `rulesChecks` below reports each
   *  entry's own readability so a missing file FAILS VISIBLY (DoD-4) rather than silently not counting. */
  rulesFiles?: readonly RulesFileEntry[];
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
  /** token -> the source that satisfied it. "active" | "rules" on the ORIGINAL single-rules-file path
   *  (untouched, byte-identical); on the NEW `rulesFiles` union path (card f6985338) a marker satisfied by
   *  one of THOSE files reports that file's own `resolvedPath` instead of the generic "rules" — this is
   *  the "which file satisfied it" DoD-3 asks for. Widened from a 2-value union to `string` for this
   *  reason; every existing "active"/"rules" comparison still holds unchanged. */
  markerSources: Record<string, string>;
  /** Symmetric twin of `archiveCheck` for the `rulesPath` union input (card 870edbcf). `checked:false`
   *  means no rulesPath was supplied at all (silent, as before this card). `checked:true, ok:false` means
   *  one WAS supplied but could not be read — `resolvedPath` names exactly what was tried and `reason`
   *  explains it, so a wrong-based path (e.g. vault-root-relative instead of project-vault-relative) is
   *  self-diagnosing instead of a mystery. This field is
   *  deliberately NOT itself folded into the overall `ok` below (see the comment at that computation) —
   *  `rulesCheck.ok:false` never DIRECTLY flips `ok`, though it still can INDIRECTLY, through
   *  `liveCommitments`/`missingMarkers`. @decision e312b207 — always read this field alongside `ok`;
   *  a red `ok` with `rulesCheck.ok:false` means "diagnose the rulesPath first," not necessarily "the
   *  content is genuinely gone." */
  rulesCheck: { checked: boolean; ok: boolean; resolvedPath?: string; reason?: string };
  /** Card f6985338: per-`rulesFiles`-entry breakdown, ONE entry per file in `rulesFiles`, same order,
   *  mirroring `rulesCheck`'s own {checked,ok,resolvedPath,reason} shape (`checked` always true here — an
   *  entry only exists because a path was actually supplied and attempted). ABSENT (not merely `[]`) when
   *  `rulesFiles` was empty/omitted — `rulesCheck` above is the complete story for that call, unchanged.
   *  ⚠️ DoD-4: an unreadable file is a REAL entry here with `ok:false` + `reason` — never silently dropped,
   *  which would read as "there were fewer files than actually supplied." */
  rulesChecks?: Array<{ checked: true; ok: boolean; resolvedPath: string; reason?: string }>;
  liveCommitments: {
    enabled: boolean;
    count: number | null;
    floor: number;
    ok: boolean;
    diagnostic: string;
    /** Card e312b207: which text the count actually came from (union with `rules`, active tried first).
     *  null when disabled, when the section was found in neither text (the fail-closed case — `ok` is
     *  already false then too), or on the docFound:false early-return path (nothing was ever read).
     *  Card f6985338: widened from "active"|"rules"|null to `string | null` — on the `rulesFiles` union
     *  path this can also be one of those files' own `resolvedPath`; the ORIGINAL single-rules-file path
     *  only ever produces "active"|"rules"|null, unchanged. */
    source: string | null;
    /** Card e312b207, code review (T3): true when the heading was found in BOTH the active doc and the
     *  rules file — see `countNumberedSectionUnion`'s own doc for why this is surfaced (never gated).
     *  Card f6985338: on the `rulesFiles` union path this instead means "found somewhere besides the
     *  winning source" (possibly more than one other place) — see `otherSources` below for that case. */
    ambiguous?: true;
    /** Present only when `ambiguous` is true AND the count came from the ORIGINAL single-rules-file path —
     *  the count/diagnostic the rules file would have produced, so a caller can report both sides, not
     *  just the winner (`count`/`diagnostic` above, from active). Card f6985338: on the `rulesFiles` union
     *  path, use `otherSources` (plural) instead — there can be more than one other place. */
    otherCount?: number;
    otherDiagnostic?: string;
    /** Card f6985338: present only when `ambiguous` is true AND the count came from the `rulesFiles` union
     *  path — every OTHER place (besides the winning `source`) the heading was also found, each with its
     *  own count/diagnostic. Mutually exclusive with `otherCount`/`otherDiagnostic` above (those are the
     *  single-other-file shape from the original path; this is the N-file shape from the new path). */
    otherSources?: { source: string; count: number; diagnostic: string }[];
  };
  archiveCheck: { checked: boolean; ok: boolean; reason?: string };
  byteCheck: { checked: boolean; ok: boolean; activeBytes?: number; preEditBytes?: number; reason?: string };
  /** DoD-4, carried verbatim — see this file's header. Always present, pass or fail. */
  honestLimitNote: string;
  /** Present (and loud) only when `configured` is false. */
  unconfiguredWarning?: string;
  /** Present (and loud) only when `liveCommitments.ambiguous` is true — see that field's own doc and
   *  `countNumberedSectionUnion`'s (card e312b207, code review T3). Never gates `ok`. */
  ambiguityWarning?: string;
  /** Code review N1 (card f6985338): present (and loud) whenever ANY supplied rules source — the legacy
   *  singular `rules` field OR any `rulesFiles` entry — could not be read. `rulesCheck`/`rulesChecks`
   *  already report this per-file, but ONLY nested; DoD-4 asked for "fail visibly," and a field nobody
   *  reads unless they already suspect a problem is not visible enough on its own. This is a TOP-LEVEL
   *  warning, the same idiom `unconfiguredWarning`/`ambiguityWarning` already use, so a reader scanning
   *  only top-level fields still sees it. Applies to the SINGULAR `rulesPath` path too, not just the
   *  `rulesFiles` union — the singular path is the more dangerous blind spot precisely because it is the
   *  one every existing seat already uses. ⚠️ Deliberately does NOT drive `ok` (same DoD-2/870edbcf
   *  reasoning as `rulesCheck` itself — see the `ok` computation's own comment) — a rules file that
   *  cannot be read is not itself proof that protection was lost; it only becomes a real failure when
   *  `missingMarkers`/`liveCommitments.ok` say so, which they already do independently. */
  rulesUnreadableWarning?: string;
}

/** Derives `rulesCheck` from a `RulesInput` — the ONE place this mapping happens, shared by `checkRotation`
 *  below AND `runResumeDocCheck`'s `docFound:false` early return (card 1083e8f4, Finding 1), so the two
 *  paths can never disagree about what a supplied `rules` value means. */
function deriveRulesCheck(rules: RulesInput | undefined): RotationCheckResult["rulesCheck"] {
  if (!rules) return { checked: false, ok: true };
  if ("text" in rules) return { checked: true, ok: true, resolvedPath: rules.resolvedPath };
  return { checked: true, ok: false, resolvedPath: rules.resolvedPath, reason: rules.error };
}

/** Derives `rulesChecks` from a `rulesFiles` list — the ONE place this mapping happens (mirrors
 *  `deriveRulesCheck`'s own reasoning), shared by `checkRotation` below AND `runResumeDocCheck`'s
 *  `docFound:false` early return, so the two paths can never disagree about what a supplied `rulesFiles`
 *  list means (card f6985338, DoD-4: a missing/unreadable file must fail VISIBLY on EITHER path). */
function deriveRulesChecks(rulesFiles: readonly RulesFileEntry[] | undefined): RotationCheckResult["rulesChecks"] {
  if (!rulesFiles || rulesFiles.length === 0) return undefined;
  return rulesFiles.map((r) =>
    "text" in r
      ? { checked: true as const, ok: true, resolvedPath: r.resolvedPath }
      : { checked: true as const, ok: false, resolvedPath: r.resolvedPath, reason: r.error },
  );
}

/**
 * Derives `rulesUnreadableWarning` from the SAME `rulesCheck`/`rulesChecks` values a caller already
 * computed (code review N1, card f6985338) — the ONE place this mapping happens, shared by `checkRotation`
 * AND `runResumeDocCheck`'s `docFound:false` early return, so the two paths can never disagree about
 * whether a supplied-but-unreadable rules source is worth a top-level warning. Applies to the SINGULAR
 * `rulesCheck` too, not just the plural `rulesChecks` — see the field's own doc for why the singular path
 * is the more dangerous blind spot.
 */
function deriveRulesUnreadableWarning(
  rulesCheck: RotationCheckResult["rulesCheck"],
  rulesChecks: RotationCheckResult["rulesChecks"],
): string | undefined {
  const unreadable: { resolvedPath: string; reason?: string }[] = [];
  if (rulesCheck.checked && !rulesCheck.ok) unreadable.push({ resolvedPath: rulesCheck.resolvedPath!, reason: rulesCheck.reason });
  if (rulesChecks) for (const rc of rulesChecks) if (!rc.ok) unreadable.push({ resolvedPath: rc.resolvedPath, reason: rc.reason });
  if (unreadable.length === 0) return undefined;
  return (
    `[resume-doc-check] ${unreadable.length} rules file(s) could not be read and are NOT contributing to ` +
    `this result: ${unreadable.map((u) => `${u.resolvedPath}${u.reason ? ` (${u.reason})` : ""}`).join("; ")}. ` +
    `A marker or the LIVE COMMITMENTS floor that ONLY lived in one of these files reads as genuinely ` +
    `missing above, never as "satisfied elsewhere" — but if it ALSO lives in the active doc or another ` +
    `readable file, this result can still be a legitimate ok:true while quietly running with less ` +
    `protection than intended. Fix the path(s) or the file(s).`
  );
}

/**
 * @decision f6985338 — builds the ordered, DEDUPED `RuleFileSource` list for the multi-file union:
 * `rules` first (if present, labeled "rules"), then every readable `rulesFiles` entry labeled by its own
 * `resolvedPath` — but an entry whose `resolvedPath` was ALREADY SEEN is SKIPPED, never pushed a second
 * time. Without this, the same on-disk file passed as both `rulesPath` and in `rulesPaths` reads as TWO
 * DIFFERENT places the heading/marker was found, tripping a false `ambiguous`/`ambiguityWarning`. Dedup
 * by `resolvedPath` (not by content): a caller who names the same file twice always meant one file; two
 * different files that happen to share content are never merged.
 */
function buildRuleSources(rules: RulesInput | undefined, rulesFiles: readonly RulesFileEntry[]): RuleFileSource[] {
  const sources: RuleFileSource[] = [];
  const seen = new Set<string>();
  if (rules && "text" in rules) {
    sources.push({ label: "rules", text: rules.text });
    seen.add(rules.resolvedPath);
  }
  for (const rf of rulesFiles) {
    if (!("text" in rf)) continue;
    if (seen.has(rf.resolvedPath)) continue;
    seen.add(rf.resolvedPath);
    sources.push({ label: rf.resolvedPath, text: rf.text });
  }
  return sources;
}

/** Pure — takes already-read file contents/stats, never touches the filesystem itself (the MCP tool
 *  handler owns all fs I/O and error handling; this function never throws). */
export function checkRotation(input: RotationCheckInput): RotationCheckResult {
  const rulesText = input.rules && "text" in input.rules ? input.rules.text : null;
  // Card f6985338: `rulesFiles` non-empty is what selects the NEW N-file union path below. Empty/omitted
  // (the overwhelmingly common case, and every pre-f6985338 caller) runs the branch that follows —
  // completely untouched, calling the exact same `checkMarkers`/`countNumberedSectionUnion` this module
  // has always called — so a caller that never passes `rulesFiles` gets byte-identical output (DoD-1).
  const rulesFiles = input.rulesFiles ?? [];
  const hasMultiFiles = rulesFiles.length > 0;

  let missing: RotationMarker[];
  let markerSources: Record<string, string>;
  if (!hasMultiFiles) {
    const r = checkMarkers(input.activeText, input.markers, rulesText);
    missing = r.missing;
    markerSources = {};
    for (const [token, src] of r.satisfiedBy) markerSources[token] = src;
  } else {
    // NEW path: union across `rules` (if present, labeled "rules" — same label the original path uses,
    // so a marker satisfied by the legacy field reads identically whether or not `rulesFiles` is ALSO
    // supplied) AND every `rulesFiles` entry, labeled by its own `resolvedPath` (DoD-3), DEDUPED by
    // resolvedPath (code review N3) so the same on-disk file never counts as two different places.
    const sources = buildRuleSources(input.rules, rulesFiles);
    const r = checkMarkersUnion(input.activeText, input.markers, sources);
    missing = r.missing;
    markerSources = {};
    for (const [token, src] of r.satisfiedBy) markerSources[token] = src;
  }

  const rulesCheck = deriveRulesCheck(input.rules);
  const rulesChecks = deriveRulesChecks(input.rulesFiles);

  const commitmentsEnabled = input.commitmentsHeading !== "";
  const liveCommitments: RotationCheckResult["liveCommitments"] = commitmentsEnabled
    ? (() => {
        if (!hasMultiFiles) {
          // Card e312b207: unioned with `rulesText` — active tried first, rules only when active carries
          // no such heading at all. `section.count === null` (found in neither) is the fail-closed case:
          // `ok` is false, never a vacuous "0 items, nothing to check, pass". See countNumberedSectionUnion.
          const section = countNumberedSectionUnion(input.activeText, rulesText, input.commitmentsHeading);
          const ok = section.count !== null && section.count >= input.commitmentsFloor;
          return {
            enabled: true, count: section.count, floor: input.commitmentsFloor, ok, diagnostic: section.diagnostic, source: section.source,
            ...(section.ambiguous ? { ambiguous: section.ambiguous as true, otherCount: section.otherCount, otherDiagnostic: section.otherDiagnostic } : {}),
          };
        }
        // NEW path (card f6985338): same DEDUPED union set as the marker check above.
        const sources = buildRuleSources(input.rules, rulesFiles);
        const section = countNumberedSectionUnionMulti(input.activeText, sources, input.commitmentsHeading);
        const ok = section.count !== null && section.count >= input.commitmentsFloor;
        return {
          enabled: true, count: section.count, floor: input.commitmentsFloor, ok, diagnostic: section.diagnostic, source: section.source,
          ...(section.ambiguous ? { ambiguous: section.ambiguous as true, otherSources: section.others } : {}),
        };
      })()
    : { enabled: false, count: null, floor: input.commitmentsFloor, ok: true, diagnostic: "disabled — no rotationLiveCommitmentsHeading configured for this seat", source: null };

  let archiveCheck: RotationCheckResult["archiveCheck"];
  if (!input.archive) {
    archiveCheck = { checked: false, ok: true };
  } else {
    const triedPath = input.archive.path ?? "(resolved path not recorded)";
    const failures: string[] = [];
    if (!input.archive.exists) failures.push(`archive path does not exist or is unreadable: ${triedPath}`);
    else if (!input.archive.isFile) failures.push(`archive path is not a regular file: ${triedPath}`);
    else if (input.archive.size === 0) failures.push(`archive file is empty: ${triedPath}`);
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
  // @decision 870edbcf — rulesCheck deliberately does NOT drive `ok` here, unlike archiveCheck: it is an
  // optional supplementary verification source (unlike archiveCheck, which validates a required rotation
  // ARTIFACT), so an unreadable rulesPath must not flip an otherwise-green `ok` to false.
  // @decision e312b207 — CORRECTION: "not folded into `ok`" does NOT mean `rulesCheck.ok:false` can never
  // affect `ok` at all. It still can, INDIRECTLY, through `liveCommitments`/`missing`, once the union is
  // the ONLY place a marker or the LIVE COMMITMENTS heading survives.
  const ok = missing.length === 0 && liveCommitments.ok && archiveCheck.ok && byteCheck.ok;

  const result: RotationCheckResult = {
    configured,
    ok,
    missingMarkers: missing.map((m) => m.token),
    markerSources,
    rulesCheck,
    ...(rulesChecks ? { rulesChecks } : {}),
    liveCommitments,
    archiveCheck,
    byteCheck,
    honestLimitNote: HONEST_LIMIT_NOTE,
  };
  if (!configured) result.unconfiguredWarning = UNCONFIGURED_WARNING;
  if (liveCommitments.ambiguous) {
    result.ambiguityWarning = liveCommitments.otherSources
      ? // Card f6985338 (N-file path): enumerate every OTHER place the heading was found, not just one.
        `[resume-doc-check] AMBIGUOUS: the "${input.commitmentsHeading}" heading was found in MULTIPLE ` +
        `places — the winner is "${liveCommitments.source}" (${liveCommitments.count} item(s)); also found ` +
        `in: ${liveCommitments.otherSources.map((o) => `"${o.source}" (${o.count} item(s))`).join(", ")}. ` +
        `The winner's count is what this result uses (see countNumberedSectionUnionMulti) — the others were ` +
        `NOT used. This is the expected transient RESIDUE of a doc mid-migration between rules files (e.g. a ` +
        `leftover heading where only a plain prose pointer should remain) — it should be resolved, not left ` +
        `standing.`
      : `[resume-doc-check] AMBIGUOUS: the "${input.commitmentsHeading}" heading was found in BOTH the ` +
        `active doc (${liveCommitments.count} item(s)) and the rules file (${liveCommitments.otherCount} ` +
        `item(s)) — the active doc's count wins by precedence (see countNumberedSectionUnion), and the ` +
        `rules file's count was NOT used for this result. This is the expected transient RESIDUE of a doc ` +
        `mid-migration into the rules file (e.g. a leftover heading where only a plain prose pointer should ` +
        `remain) — it should be resolved (trim the active doc's heading down to prose), not left standing.`;
  }
  // Code review N1 (card f6985338): a TOP-LEVEL warning whenever ANY supplied rules source failed to
  // read — the legacy singular `rules` field AND every `rulesFiles` entry, so the singular path (the one
  // every existing seat already uses) gets the same visibility as the new plural one. Never drives `ok`.
  const rulesUnreadableWarning = deriveRulesUnreadableWarning(rulesCheck, rulesChecks);
  if (rulesUnreadableWarning) result.rulesUnreadableWarning = rulesUnreadableWarning;
  return result;
}

/**
 * Code review (card 1069c8e1): the `resume_doc_check` tool descriptions assert "no path argument, so you
 * can never check the wrong file" — true for the ACTIVE doc, but overstated once `archivePath` (a
 * caller-supplied host path reaching `fs.statSync`) is in play. Contain it under the project's own
 * `vaultPath` — the same place the rotation doctrine already documents an archive living
 * (`<name>.archive/<date>.md`, a sibling of the active doc) — rather than accepting an arbitrary absolute
 * path, so it can't probe host paths outside the vault. Mirrors `resolveResumeDocPath`'s own containment
 * check (`sessions/resume-doc-notes.ts`), but REFUSES on an escape instead of silently falling back —
 * there is no authoritative default for an optional path the way there is for the resume doc's own
 * basename. Card 3c30258f: also `rulesPath` (a THIRD caller-supplied host path), same treatment, never a
 * third unguarded path. `fieldName` names the offending field in the returned error so a caller can't
 * misattribute which argument was rejected.
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
  /** Optional union source for markers — a real path a caller resolves and vault-contains before calling
   *  in (card 3c30258f exposed this as MCP-tool input on both `resume_doc_check` surfaces; see
   *  rotation-check.ts's own module doc). A supplied-but-unreadable path degrades the union to
   *  active-only, same as before, but is now reported via the result's `rulesCheck` (card 870edbcf) —
   *  see this file's module doc. */
  rulesPath?: string | null;
  /** Card f6985338: ADDITIONAL rules files beyond `rulesPath` above (the `rulesPaths` MCP-tool argument —
   *  each already vault-contained by the caller, mirroring `rulesPath` itself). Omitted/empty ⇒
   *  byte-identical to pre-f6985338 behavior (only `rulesPath` — or nothing — is ever consulted). A path
   *  that cannot be read is a real, visible failure (`rulesChecks`), never silently dropped from the
   *  union (DoD-4). */
  rulesPaths?: readonly string[] | null;
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

  // Resolved BEFORE the docFound:false early return below (card 1083e8f4, Finding 1) — this used to be
  // resolved only on the found-doc path, so the early return hardcoded `rulesCheck: {checked:false,
  // ok:true}` regardless of whether `opts.rulesPath` was actually supplied, contradicting the field's own
  // doc ("checked:false means no rulesPath was supplied at all") for a seat that hasn't written its resume
  // doc yet. Resolving it once, up here, and feeding BOTH branches through the same `deriveRulesCheck`
  // (via `checkRotation` on the found-doc path, directly below on the not-found path) makes the two paths
  // structurally unable to diverge.
  let rules: RulesInput = null;
  if (opts.rulesPath) {
    try {
      const text = fs.readFileSync(opts.rulesPath, "utf8");
      rules = { resolvedPath: opts.rulesPath, text };
    } catch {
      rules = { resolvedPath: opts.rulesPath, error: `rules path does not exist or is unreadable: ${opts.rulesPath}` };
    }
  }

  // Card f6985338: resolved up here too (same reasoning as `rules` above) so the docFound:false early
  // return and the found-doc path below can never disagree about what a supplied `rulesPaths` list means.
  const rulesFiles: RulesFileEntry[] = (opts.rulesPaths ?? []).map((p) => {
    try {
      const text = fs.readFileSync(p, "utf8");
      return { resolvedPath: p, text };
    } catch {
      return { resolvedPath: p, error: `rules path does not exist or is unreadable: ${p}` };
    }
  });

  const rulesChecks = deriveRulesChecks(rulesFiles);

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
      rulesCheck: deriveRulesCheck(rules),
      ...(rulesChecks ? { rulesChecks } : {}),
      liveCommitments: {
        enabled: opts.commitmentsHeading !== "",
        count: null,
        floor: opts.commitmentsFloor,
        ok: false,
        source: null,
        diagnostic: `active doc not found at ${opts.resumeDocPath}`,
      },
      archiveCheck: { checked: false, ok: true },
      byteCheck: { checked: false, ok: true },
      honestLimitNote: HONEST_LIMIT_NOTE,
    };
    if (!configured) result.unconfiguredWarning = UNCONFIGURED_WARNING;
    // Code review N1: same top-level warning as checkRotation's found-doc path — a supplied-but-unreadable
    // rules source is worth surfacing even when the active doc itself is missing.
    const rulesUnreadableWarning = deriveRulesUnreadableWarning(result.rulesCheck, result.rulesChecks);
    if (rulesUnreadableWarning) result.rulesUnreadableWarning = rulesUnreadableWarning;
    return result;
  }

  let archive: ArchiveInfo | null = null;
  if (opts.archivePath) {
    try {
      const stat = fs.statSync(opts.archivePath);
      archive = { exists: true, isFile: stat.isFile(), size: stat.size, path: opts.archivePath };
    } catch {
      archive = { exists: false, isFile: false, size: 0, path: opts.archivePath };
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
    activeText, rules, rulesFiles, markers: opts.markers,
    commitmentsHeading: opts.commitmentsHeading, commitmentsFloor: opts.commitmentsFloor,
    archive, byteCheck,
  });
  return { ...result, resumeDocPath: opts.resumeDocPath, docFound: true };
}
