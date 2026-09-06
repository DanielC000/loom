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
 *
 * LIVE COMMITMENTS FLOOR NOW UNIONED WITH `rules` TOO (card e312b207, owner-approved option (a): move
 * §LIVE COMMITMENTS into the non-rotating `Orchestrator Rules.md`, and move its count guard with it).
 * Before this card, `countNumberedSection` was called against `input.activeText` alone, while the marker
 * check already unioned against `rules` — so moving the section into the rules file would have made every
 * future rotation's floor check refuse a perfectly correct doc. `countNumberedSectionUnion` closes that
 * gap the same way the marker union already works: active tried first (byte-identical behavior while the
 * section stays in the active doc), rules only when active has no such heading, and a hard, fail-closed
 * refusal (never a vacuous "0 items, nothing to check, ok:true") when the heading is in neither file. See
 * `countNumberedSectionUnion`'s own doc below for the full reasoning — it mirrors `rotation-gate.mjs`'s
 * own extension of the exact same shape.
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
 * UNION over `activeText` and `rulesText` (card e312b207, owner-approved option (a): move
 * §LIVE COMMITMENTS into the non-rotating `Orchestrator Rules.md`, and move its count guard with it).
 * Mirrors `checkMarkers`'s own precedence exactly: `activeText` is tried FIRST, so a section still in
 * place there is measured byte-identically to before this card; `rulesText` is consulted ONLY when
 * `activeText` carries no such heading at all. This makes the two landings (this guard shipping the
 * union, the lead moving the section into the rules file) order-independent — the same red-window-free
 * reason the marker union exists (this module's own header + `rotation-gate.mjs`'s header for the full
 * reasoning): neither ordering of "guard ships" vs. "vault moves" ever produces a seat where a section
 * that genuinely still exists somewhere durable reads as missing.
 *
 * FAIL-CLOSED: `count: null, source: null` when the heading is in NEITHER text — the catastrophic "the
 * block was lost outright" case. Callers must treat a null count as a hard failure (never "0 items,
 * nothing to check, ok:true") exactly as the single-file `countNumberedSection` already required — the
 * union only widens WHERE a hit can come from, never what happens when there is no hit at all.
 *
 * AMBIGUITY (code review, card e312b207): `findHeadingLine` matches ANY heading containing the token, so
 * a post-move breadcrumb left in the active doc — e.g. "## §LIVE COMMITMENTS — moved to Orchestrator
 * Rules.md" — still counts as "found in active" and SHADOWS the now-authoritative rules-file section
 * (active wins by precedence; the rules file is never even read for the count). A doc in that shape can
 * green at exit 0 while the real, current block goes unmeasured. This function does not change WHICH
 * count wins (hard-failing "found in both" would reopen a red window during the migration, and is a
 * deliberate non-goal here) — it makes the shape VISIBLE via `ambiguous`/`otherCount`/`otherDiagnostic`
 * so a caller (`checkRotation` below) can surface a loud, non-gating warning instead of a silent green.
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
  /** Symmetric twin of `archiveCheck` for the `rulesPath` union input (card 870edbcf). `checked:false`
   *  means no rulesPath was supplied at all (silent, as before this card). `checked:true, ok:false` means
   *  one WAS supplied but could not be read — `resolvedPath` names exactly what was tried and `reason`
   *  explains it, so a wrong-based path (e.g. vault-root-relative instead of project-vault-relative) is
   *  self-diagnosing instead of a mystery. This field is deliberately NOT itself folded into the overall
   *  `ok` below (see the comment at that computation) — `rulesCheck.ok:false` never DIRECTLY flips `ok`.
   *  ⚠️ It can still flip `ok` INDIRECTLY, though (card e312b207 correction — this was previously
   *  overstated as "unaffected," full stop): if the active doc is missing a marker or the LIVE COMMITMENTS
   *  heading, an unreadable `rulesPath` removes the union's only other place to look, so that marker/the
   *  commitments floor then genuinely fails and `ok` follows it down. "Not folded into `ok`" only means a
   *  failed READ is never itself an `ok`-flipping event when the active doc alone already satisfies
   *  everything — it is not a promise that `ok` stays green regardless of what's missing from the active
   *  doc. Always read this field alongside `ok`, the same way `unconfiguredWarning` must be read alongside
   *  a vacuous `ok:true` — a red `ok` with `rulesCheck.ok:false` means "diagnose the rulesPath first,"
   *  not "the content is genuinely gone." */
  rulesCheck: { checked: boolean; ok: boolean; resolvedPath?: string; reason?: string };
  liveCommitments: {
    enabled: boolean;
    count: number | null;
    floor: number;
    ok: boolean;
    diagnostic: string;
    /** Card e312b207: which text the count actually came from (union with `rules`, active tried first).
     *  null when disabled, when the section was found in neither text (the fail-closed case — `ok` is
     *  already false then too), or on the docFound:false early-return path (nothing was ever read). */
    source: "active" | "rules" | null;
    /** Card e312b207, code review (T3): true when the heading was found in BOTH the active doc and the
     *  rules file — see `countNumberedSectionUnion`'s own doc for why this is surfaced (never gated). */
    ambiguous?: true;
    /** Present only when `ambiguous` is true — the count/diagnostic the rules file would have produced,
     *  so a caller can report both sides, not just the winner (`count`/`diagnostic` above, from active). */
    otherCount?: number;
    otherDiagnostic?: string;
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
}

/** Derives `rulesCheck` from a `RulesInput` — the ONE place this mapping happens, shared by `checkRotation`
 *  below AND `runResumeDocCheck`'s `docFound:false` early return (card 1083e8f4, Finding 1), so the two
 *  paths can never disagree about what a supplied `rules` value means. */
function deriveRulesCheck(rules: RulesInput | undefined): RotationCheckResult["rulesCheck"] {
  if (!rules) return { checked: false, ok: true };
  if ("text" in rules) return { checked: true, ok: true, resolvedPath: rules.resolvedPath };
  return { checked: true, ok: false, resolvedPath: rules.resolvedPath, reason: rules.error };
}

/** Pure — takes already-read file contents/stats, never touches the filesystem itself (the MCP tool
 *  handler owns all fs I/O and error handling; this function never throws). */
export function checkRotation(input: RotationCheckInput): RotationCheckResult {
  const rulesText = input.rules && "text" in input.rules ? input.rules.text : null;
  const { missing, satisfiedBy } = checkMarkers(input.activeText, input.markers, rulesText);
  const markerSources: Record<string, "active" | "rules"> = {};
  for (const [token, src] of satisfiedBy) markerSources[token] = src;

  const rulesCheck = deriveRulesCheck(input.rules);

  const commitmentsEnabled = input.commitmentsHeading !== "";
  const liveCommitments = commitmentsEnabled
    ? (() => {
        // Card e312b207: unioned with `rulesText` — active tried first, rules only when active carries
        // no such heading at all. `section.count === null` (found in neither) is the fail-closed case:
        // `ok` is false, never a vacuous "0 items, nothing to check, pass". See countNumberedSectionUnion.
        const section = countNumberedSectionUnion(input.activeText, rulesText, input.commitmentsHeading);
        const ok = section.count !== null && section.count >= input.commitmentsFloor;
        return {
          enabled: true, count: section.count, floor: input.commitmentsFloor, ok, diagnostic: section.diagnostic, source: section.source,
          ...(section.ambiguous ? { ambiguous: section.ambiguous as true, otherCount: section.otherCount, otherDiagnostic: section.otherDiagnostic } : {}),
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
  // DoD-2 decision (card 870edbcf): rulesCheck deliberately does NOT drive `ok` here, unlike archiveCheck.
  // Rejected: folding it in like archiveCheck — that would flip a green result to false purely because an
  // OPTIONAL supplementary verification source was unavailable, even when every marker is still genuinely
  // present in the active doc itself (the union's whole point is that this is a legitimate pass). That
  // would also be a behavior change for any existing caller that passes rulesPath speculatively. Chosen
  // instead: report-only, with `rulesCheck` always present and loud whenever a rulesPath was supplied and
  // failed — the same "loud field" shape this module already uses for `unconfiguredWarning` on a vacuous
  // `ok:true`. archiveCheck stays different on purpose: it validates a required rotation ARTIFACT (the
  // archive this rotation is producing), not an optional verification aid.
  //
  // ⚠️ CORRECTION (card e312b207 code review): "ok unaffected" above describes `rulesCheck.ok` NOT being a
  // DIRECT term in the `ok` formula below — it does NOT mean a failed rulesPath read can never change `ok`
  // at all. It still can, INDIRECTLY, through `liveCommitments.ok`/`missing` themselves: once the union is
  // the ONLY place a marker or the LIVE COMMITMENTS heading survives (e.g. after it moves out of the
  // active doc into the rules file), an unreadable rulesPath removes that sole remaining source, and the
  // corresponding check genuinely fails — dragging `ok` down with it, same as if the content were simply
  // absent. This is correct behavior, not a bug: "the rules file couldn't be read" and "nothing durable
  // protects this any more" are the same practical situation from the caller's side. The one thing that
  // truly never happens is `rulesCheck.ok:false` flipping `ok` while everything it could have supplemented
  // is ALREADY satisfied by the active doc alone — that is the shape this decision protects.
  const ok = missing.length === 0 && liveCommitments.ok && archiveCheck.ok && byteCheck.ok;

  const result: RotationCheckResult = {
    configured,
    ok,
    missingMarkers: missing.map((m) => m.token),
    markerSources,
    rulesCheck,
    liveCommitments,
    archiveCheck,
    byteCheck,
    honestLimitNote: HONEST_LIMIT_NOTE,
  };
  if (!configured) result.unconfiguredWarning = UNCONFIGURED_WARNING;
  if (liveCommitments.ambiguous) {
    result.ambiguityWarning =
      `[resume-doc-check] AMBIGUOUS: the "${input.commitmentsHeading}" heading was found in BOTH the ` +
      `active doc (${liveCommitments.count} item(s)) and the rules file (${liveCommitments.otherCount} ` +
      `item(s)) — the active doc's count wins by precedence (see countNumberedSectionUnion), and the ` +
      `rules file's count was NOT used for this result. This is the expected transient RESIDUE of a doc ` +
      `mid-migration into the rules file (e.g. a leftover heading where only a plain prose pointer should ` +
      `remain) — it should be resolved (trim the active doc's heading down to prose), not left standing.`;
  }
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
  /** Optional union source for markers — a real path a caller resolves and vault-contains before calling
   *  in (card 3c30258f exposed this as MCP-tool input on both `resume_doc_check` surfaces; see
   *  rotation-check.ts's own module doc). A supplied-but-unreadable path degrades the union to
   *  active-only, same as before, but is now reported via the result's `rulesCheck` (card 870edbcf) —
   *  see this file's module doc. */
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
    activeText, rules, markers: opts.markers,
    commitmentsHeading: opts.commitmentsHeading, commitmentsFloor: opts.commitmentsFloor,
    archive, byteCheck,
  });
  return { ...result, resumeDocPath: opts.resumeDocPath, docFound: true };
}
