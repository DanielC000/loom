import type { SkillPermissionVector } from "@loom/shared";
import {
  detectPermissionWidening,
  frontmatterUnrecognizedSyntax,
  FRONTMATTER_RE,
  FRONTMATTER_KEY_LINE_RE,
  INLINE_SHELL_RE,
  FENCED_SHELL_RE,
} from "./permissionWidening.js";

/**
 * @decision 51a2462a — never let `skillWriteData` land agent-written content carrying
 * `allowed-tools`/`hooks`/a shell trigger, and never deliver a non-human-provenance store skill's
 * widening vectors unstripped — both gates live here, never re-derived at either call site.
 *
 * `permissionWidening.ts` stays a read-only detector by its own design (decision record 87a51903) —
 * refusing or rewriting an agent-written skill's content is kept in THIS separate module instead,
 * importing that module's own exported patterns rather than copying them.
 *
 * Two independent uses, from two different callers:
 *  - `permissionWideningRefusalError` — `skillWriteData` (mcp/skillTools.ts) calls this BEFORE any
 *    write, on every skill_write/skill_edit call, on both the loom-setup and loom-platform surfaces,
 *    for BOTH the user-store branch and the dev-only bundled-asset branch. Every `skillWriteData` call
 *    is agent-authored by construction (see that function's own doc) — there is no human-REST path
 *    through it, so this check has nothing to carve an exception for.
 *  - `stripPermissionWidening` — `skills/inject.ts` calls this for every STORE skill it delivers whose
 *    provenance is NOT human (agent-stamped, or unstamped — fail closed, the same posture decision
 *    record 509176c8 uses for locked-role delivery) and that is not a bundled asset. Defense in depth
 *    for content that predates the refuse above, or that reached the store out of band.
 */

const BOM = "﻿";

/** Splits off a leading UTF-8 BOM (U+FEFF), if present. `detectPermissionWidening`'s own
 *  `FRONTMATTER_RE`/`frontmatterReadIncomplete` are anchored at the literal start of the string, so a
 *  BOM ahead of a real `---` block hides it from both — a KNOWN blind spot (card 22813c50 investigates
 *  whether Claude Code's own loader honours a BOM-led frontmatter at all). Both callers below fail
 *  CLOSED regardless of that open question: a BOM-led block is scanned as if it were ordinary
 *  frontmatter, by scanning the returned `body` rather than the literal start of `content`. */
function splitLeadingBom(content: string): { body: string; hasBom: boolean } {
  const hasBom = content.startsWith(BOM);
  return { body: hasBom ? content.slice(BOM.length) : content, hasBom };
}

/** Human-readable label for each vector, for the refuse error text below. Keyed by the SAME
 *  `SkillPermissionVector` union `detectPermissionWidening` returns — a missing case is a compile error,
 *  not a silent fallback, so a future vector can't ship a refusal with nothing to say about it. */
const VECTOR_LABEL: Record<SkillPermissionVector, string> = {
  "allowed-tools": "a frontmatter `allowed-tools:` grant",
  hooks: "a frontmatter `hooks:` registration",
  "frontmatter-unrecognized": "frontmatter syntax this detector cannot confidently parse (e.g. a quoted "
    + "key, a flow mapping, an anchor/alias/tag value, an explicit/tagged/merge key)",
  "shell-inline": "an inline `` !`cmd` `` shell injection",
  "shell-fenced": "a fenced ` ```! ` shell block",
};

/**
 * `undefined` when `content` is clean; otherwise a ready-to-return error string naming every detected
 * vector in both plain words and by its `SkillPermissionVector` id. Call this BEFORE any write in
 * `skillWriteData` — it never mutates anything itself.
 */
export function permissionWideningRefusalError(content: string): string | undefined {
  const vectors = detectPermissionWidening(splitLeadingBom(content).body);
  if (vectors.length === 0) return undefined;
  const named = vectors.map((v) => VECTOR_LABEL[v]).join(", ");
  return (
    `skill_write/skill_edit refused: this content carries ${named} (${vectors.join(", ")}) — an ` +
    "agent-written skill may not grant tools, register hooks, or run shell commands outside the " +
    "normal permission classifier. Remove it and resubmit, or ask a human to add it through the Skills UI."
  );
}

/** The frontmatter top-level keys this module strips, WITH their nested/continuation lines. Same two
 *  names `permissionWideningRefusalError`/the write-time refuse above cover — kept as its own const so
 *  a future third frontmatter vector is a one-line addition here, not a re-derivation. */
const STRIPPED_FRONTMATTER_KEYS = new Set(["allowed-tools", "hooks"]);

/**
 * Remove `allowed-tools`/`hooks` from `content`'s frontmatter block, WITH each key's nested/continuation
 * lines (a bounded line scan over the ONE block `FRONTMATTER_RE` matches, mirroring
 * `topLevelFrontmatterKeys`'s own column-0 key boundary) — never a full YAML parse. A top-level key line
 * NOT in `STRIPPED_FRONTMATTER_KEYS` ends whatever run of skipped lines came before it; a line that
 * isn't itself a top-level key (blank, a comment, an indented continuation) inherits the previous key's
 * skip/keep state, since it belongs to that key's own YAML node. Every other field, and its own exact
 * line text, is reproduced byte-for-byte including order; only the flagged key(s)' lines are dropped.
 * Preserves the file's own line-ending style (CRLF stays CRLF, LF stays LF) for the rebuilt block, and
 * leaves everything outside the matched block (including a trailing/non-matching `---` elsewhere)
 * completely untouched. A no-op (`content` returned unchanged, same reference) when there is no
 * frontmatter block to find.
 */
function stripFrontmatterKeys(content: string): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return content;
  const whole = match[0];
  const block = match[1] ?? ""; // the capture group always matches when the whole regex does
  const eol = whole.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let skipping = false;
  for (const line of block.split(/\r?\n/)) {
    const key = line.match(FRONTMATTER_KEY_LINE_RE)?.[1]?.toLowerCase();
    if (key != null) skipping = STRIPPED_FRONTMATTER_KEYS.has(key);
    if (!skipping) kept.push(line);
  }
  const newWhole = `---${eol}${kept.join(eol)}${eol}---`;
  return newWhole + content.slice(whole.length);
}

/** `new RegExp` with the SAME source as `re`, with a `g` flag added (a no-op if it already has one) —
 *  so a global pass over every occurrence reuses the exact pattern `detectPermissionWidening` tests
 *  with, never a hand-copied second instance. */
function withGlobalFlag(re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, `${re.flags}g`);
}

// A "whole run" variant of each shared trigger pattern — matching one-or-more trigger characters (`!+`)
// where the shared pattern matches exactly one. Derived from the imported patterns' own `.source` — never
// a hand-authored second copy of the lookbehind/fence bound — so a future change to either shared pattern
// is picked up here automatically. `FENCED_SHELL_RE`'s source already ends in the trigger `!`, so
// appending `+` is enough; `INLINE_SHELL_RE`'s trigger `!` is the first character AFTER its lookbehind
// group, located via that group's own closing `)`.
//
// @decision 51a2462a round 3 — a stacked trigger (`` !!!`cmd` ``, a ` ```!!! ` fence) must strip in ONE
// application, not one `!` per fixpoint pass — a long enough run could otherwise outrun
// `STRIP_FIXPOINT_MAX_PASSES` (see that const's own doc).
const FENCED_SHELL_RUN_RE = new RegExp(`${FENCED_SHELL_RE.source}+`, FENCED_SHELL_RE.flags);
const INLINE_LOOKBEHIND_END = INLINE_SHELL_RE.source.indexOf(")") + 1;
const INLINE_SHELL_RUN_RE = new RegExp(
  INLINE_SHELL_RE.source.slice(0, INLINE_LOOKBEHIND_END) +
    INLINE_SHELL_RE.source.slice(INLINE_LOOKBEHIND_END).replace(/^!/, "!+"),
  INLINE_SHELL_RE.flags,
);

/**
 * Drop the WHOLE run of TRIGGER characters from every inline/fenced shell construct in `content`, leaving
 * everything else (including the command text) visible for review: `` !+`cmd` `` → `` `cmd` `` (an inert
 * code span — the leading `!`(s) are what make Claude Code's loader treat it as a shell injection) and
 * ` ```!+ ` → ` ``` ` (an ordinary fenced block — the trailing `!`(s) info-string character(s) are what
 * mark it as a shell directive). A single pass removes an ENTIRE stacked run, not one `!` at a time (round
 * 3 — see `INLINE_SHELL_RUN_RE`/`FENCED_SHELL_RUN_RE`'s own doc). A no-op when neither construct is present.
 */
function stripShellTriggers(content: string): string {
  return content
    .replace(withGlobalFlag(INLINE_SHELL_RUN_RE), (m) => m.replace(/^!+/, ""))
    .replace(withGlobalFlag(FENCED_SHELL_RUN_RE), (m) => m.replace(/!+$/, ""));
}

// Loop `stripFrontmatterKeys`+`stripShellTriggers` to a fixpoint rather than trusting one pass, in case
// stripping one vector ever exposes another. Round 3's whole-run strip above means a single pass now
// resolves any realistic stacked trigger on its own — this loop is kept as DEFENCE IN DEPTH, not because
// it's still load-bearing for that case.
//
// @decision 51a2462a round 2 — the caller-visible `null` fallback on `stripPermissionWidening` below is
// what actually keeps this fail-closed if the bound is ever hit anyway.
const STRIP_FIXPOINT_MAX_PASSES = 16;

/**
 * The content `skills/inject.ts` delivers for an agent-provenance (or unstamped) store skill: every
 * vector `detectPermissionWidening` flags, removed (see `stripFrontmatterKeys`/`stripShellTriggers`,
 * looped to a fixpoint — see `STRIP_FIXPOINT_MAX_PASSES`'s own doc). Returns `content` UNCHANGED (same
 * reference) when clean, so a caller can skip a write on `===`.
 *
 * @decision 51a2462a round 2 — returns `null`, never partially-stripped, when the fixpoint result is
 * still non-empty; the caller MUST withhold the content entirely, same as a write failure (see
 * `skills/inject.ts`'s `stripPermissionWideningFile`).
 *
 * BOM-aware (see `splitLeadingBom`): a leading BOM is held aside, the scan/strip run past it, and it's
 * re-prepended to a successful (non-null) result — so a BOM-led skill is never wrongly read as clean
 * (fail closed).
 *
 * Idempotent, and `detectPermissionWidening(stripPermissionWidening(x))` is always `[]` OR the result is
 * `null` — both follow from sharing ONE pattern set with the detector, never a second copy that could
 * disagree afterward.
 *
 * @decision 712148f1 (round 2) — never move the allowlist check below `stripFrontmatterKeys`: that
 * function's quote-tolerant key match would DELETE a quoted hazard line instead of withholding it whole.
 */
export function stripPermissionWidening(content: string): string | null {
  const { body, hasBom } = splitLeadingBom(content);
  if (detectPermissionWidening(body).length === 0) return content;
  if (frontmatterUnrecognizedSyntax(body)) return null;
  let current = body;
  for (let i = 0; i < STRIP_FIXPOINT_MAX_PASSES; i++) {
    const next = stripShellTriggers(stripFrontmatterKeys(current));
    if (next === current) break;
    current = next;
  }
  if (detectPermissionWidening(current).length > 0) return null; // fail closed — see this fn's own doc
  return hasBom ? `${BOM}${current}` : current;
}
