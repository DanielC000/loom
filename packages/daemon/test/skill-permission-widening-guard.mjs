import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source-text scan
// STANDING GUARD (card 36101180, from investigate-first card 28b2ca6f) — WHY THIS EXISTS: a bundled skill
// under packages/daemon/assets/skills/** ships to every loomctl install with no per-install review step.
// Card 28b2ca6f's probe (research/skill-frontmatter-permission-widening-2026-11-02.md — the project's
// `research/` work dir, not this repo) found three permission-widening vectors Claude Code's skill
// loader recognizes with NO workspace-trust gate:
//   - frontmatter `allowed-tools:` — pre-approves tools for the invoking turn; in `auto` mode (Loom's
//     default) it lets a body `!` command run at render with no classifier pass at all (P3 vs P4).
//   - frontmatter `hooks:` — registers a shell hook that keeps firing for the REST OF THE SESSION. Not a
//     tool, so `--disallowedTools`/a companion's `restrictedTools` deny list cannot contain it (P9).
//   - a body inline `` !`cmd` `` or a fenced ` ```! ` block — runs a shell command AT RENDER TIME, before
//     any model turn, deferred to the classifier only when NO `allowed-tools` grant covers it (P1/P2).
// Measured 0/14 bundled skill dirs use any of the three today (card 28b2ca6f, re-verified by this guard's
// own real scan below). Merge review is the actual gate; this lint makes a FUTURE addition a deliberate
// review point instead of a silent one.
//
// SCOPE: every packages/daemon/assets/skills/<name>/SKILL.md, plus every file under
// packages/daemon/assets/skills/<name>/references/**, recursively. Deliberately excludes scripts/** executable
// helpers (e.g. orchestrate/scripts/, web-design/scripts/) and any other top-level file (e.g.
// web-design/NOTICE) — neither is loaded as skill frontmatter/body by Claude Code's skill renderer, so
// neither vector applies to them.
//
// Run: node packages/daemon/test/skill-permission-widening-guard.mjs (no build needed — pure text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(TEST_DIR, "..", "assets", "skills");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── Scanning primitives ──────────────────────────────────────────────────────────────────────────────

// Frontmatter block: only the FIRST `---`-delimited block, anchored at the very start of the file — the
// same bound `skills/store.ts`'s own `descriptionOf()` uses. A later `---` in the body (an ordinary
// markdown horizontal rule) is never mistaken for a second frontmatter block, and never scanned as one.
//
// The `(?:...)?` wrapping the body+newline (card 22813c50, N1) mirrors permissionWidening.ts's own fix
// so an EMPTY frontmatter block (adjacent `---`/`---` lines, no blank line between) still matches.
//
// @decision 712148f1 — this file deliberately keeps its OWN copy of these patterns (no build step);
// widen it IN LOCKSTEP with skills/permissionWidening.ts's own patterns, or this lint silently stops
// catching what the real detector would catch.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

/** Returns the frontmatter block's raw text, or null if `raw` has none (e.g. an ordinary references/**
 *  reference doc, which carries no frontmatter at all). */
function frontmatterBlockOf(raw) {
  return raw.match(FRONTMATTER_RE)?.[1] ?? null;
}

/** Top-level (column-0, unindented) YAML mapping keys in a frontmatter block. A hand-rolled line scan,
 *  not a full YAML parser (none is a dependency of this package) — but "proper" in the sense the card
 *  asks for: it is bounded to the real frontmatter block (never the whole file, unlike a naive
 *  whole-file `/allowed-tools:/`-style regex, which would also match the string inside this very file's
 *  own comments or a reference doc's PROSE describing the vector), and it requires NO leading
 *  whitespace, so an indented/nested key (`foo:\n  hooks: bar`) correctly does NOT count as top-level.
 *  Every bundled SKILL.md today is flat (`name:`/`description:` only — verified by hand, 2026-11-02), so
 *  nothing fancier is needed; a future skill with real nested structure still gets correct
 *  top-level-only matching.
 *
 *  @decision 712148f1 — tolerates an optional wrapping quote and optional whitespace before the colon
 *  (fail-closed widening, mirroring skills/permissionWidening.ts's own FRONTMATTER_KEY_LINE_RE). */
function topLevelKeysOf(block) {
  const keys = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^["']?([A-Za-z0-9_-]+)["']?[ \t]*:/);
    if (m) keys.push(m[1].toLowerCase());
  }
  return keys;
}

/** A key named inside a flow-mapping context (e.g. `{name: x, allowed-tools: Bash}`) — see
 *  skills/permissionWidening.ts's FLOW_MAPPING_KEY_RE, mirrored here (card 712148f1). Gated on the block
 *  containing a literal `{` (mirrors that module's own gate) — without it, an ordinary line whose plain
 *  value merely contains a comma (`name: x, hooks: not a key`) would false-positive with no `{` anywhere. */
const FLOW_MAPPING_KEY_RE = /[{,][ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*:/;
function flowMappingKeysOf(block) {
  if (!block.includes("{")) return [];
  const keys = [];
  const re = new RegExp(FLOW_MAPPING_KEY_RE.source, "g");
  let m;
  while ((m = re.exec(block))) keys.push(m[1].toLowerCase());
  return keys;
}

const FORBIDDEN_FRONTMATTER_KEYS = new Set(["allowed-tools", "hooks"]);

// card 712148f1 round 2: the fail-closed ALLOWLIST, mirrored here IN LOCKSTEP with
// skills/permissionWidening.ts's own PLAIN_TOP_LEVEL_KEY_LINE_RE/SEQUENCE_ITEM_RE/
// FRONTMATTER_VALUE_START_FORBIDDEN_RE/frontmatterUnrecognizedSyntax — widen both together, or this lint
// silently stops catching what the real detector would catch. See that module's own doc for why this is
// an allowlist (boring shapes pass) rather than a denylist (named dangerous shapes) — a denylist of YAML
// key syntax can't converge.
const PLAIN_TOP_LEVEL_KEY_LINE_RE = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/;
const SEQUENCE_ITEM_RE = /^-(?:[ \t]|$)/;
const FRONTMATTER_VALUE_START_FORBIDDEN_RE = /^[&*!]/;
// card 712148f1 round 3, MAJOR 1: an indented line is neutral ONLY after a top-level key has already
// been seen — mirrors skills/permissionWidening.ts's own fix IN LOCKSTEP. A root block may itself be
// indented in real YAML, so indentation with no preceding top-level key is "anything else", not a
// blanket continuation exemption.
function frontmatterUnrecognizedSyntax(block) {
  let prevTopLevelKeyEmpty = false;
  let seenTopLevelKey = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (seenTopLevelKey) continue;
      return true;
    }
    if (SEQUENCE_ITEM_RE.test(line)) {
      if (prevTopLevelKeyEmpty) continue;
      return true;
    }
    const m = line.match(PLAIN_TOP_LEVEL_KEY_LINE_RE);
    if (!m) return true;
    seenTopLevelKey = true;
    const value = (m[2] ?? "").trim();
    prevTopLevelKeyEmpty = value === "";
    if (value !== "" && FRONTMATTER_VALUE_START_FORBIDDEN_RE.test(value)) return true;
  }
  return false;
}

// card 99f2ae1a — a literal port of the installed CLI's own recovered `bk` regex (static byte-offset
// scan of claude.exe), mirroring skills/permissionWidening.ts's own REAL_LOADER_FENCE_RE IN LOCKSTEP.
// Used ONLY to ask "does the real loader see a live frontmatter block here, and with what body" — it is
// WIDER than FRONTMATTER_RE above on both fences (JS `\s*` on the open admits NBSP/VT/a repeated CR/a
// second BOM after the dashes; the close has no line-start requirement at all).
const REAL_LOADER_FENCE_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

// card 99f2ae1a round 2 (Code Review item 4) — mirrors permissionWidening.ts's own BOM constant +
// splitLeadingBom helper IN LOCKSTEP (this file deliberately never imports that module, per its own
// header, so it keeps its own copy — card 9d01b4c1's shared-helper discipline, mirrored here). Before
// this fix, the guard's own frontmatterFenceUnrecognized below never split a leading BOM at all, so it
// disagreed with the real module on a BOM-prefixed evasion fixture.
const BOM = "﻿";
function splitLeadingBom(content) {
  return content.startsWith(BOM) ? content.slice(BOM.length) : content;
}

// card 99f2ae1a round 2 (Code Review false positive (a)) — mirrors permissionWidening.ts's own
// stripLeadingBlankLines IN LOCKSTEP: a blank/whitespace-only line right after the opening fence is NOT
// a real disagreement (only REAL_LOADER_FENCE_RE's own open tolerance swallows it), so it is stripped
// from BOTH bodies before comparing.
function stripLeadingBlankLines(s) {
  return s.replace(/^(?:[ \t]*\r?\n)+/, "");
}

/** True when the real loader's own fence regex sees a live block this file's own FRONTMATTER_RE either
 *  misses entirely or captures a DIFFERENT body for — mirrors permissionWidening.ts's own
 *  frontmatterFenceUnrecognized IN LOCKSTEP. Operates on the RAW content (self-splitting one leading BOM
 *  internally, same as the real module), not `frontmatterBlockOf`'s already-extracted block, since it
 *  needs both regexes' own capture to disagree about. The trailing `\r?\n` stripped off the real capture
 *  before comparing is the same group-boundary normalization that function's own doc explains (the two
 *  regexes bound an ordinary, boring block's capture differently even when they agree on where it ends). */
function frontmatterFenceUnrecognized(raw) {
  const body = splitLeadingBom(raw);
  const real = body.match(REAL_LOADER_FENCE_RE);
  if (!real) return false; // the real loader sees no live block here either — nothing to disagree about
  const realBody = stripLeadingBlankLines((real[1] ?? "").replace(/\r?\n$/, ""));
  const loom = body.match(FRONTMATTER_RE);
  const loomBody = stripLeadingBlankLines(loom?.[1] ?? "");
  return loom == null || realBody !== loomBody;
}

// Body injection forms, per card 28b2ca6f's probes (P1/P2, P8/P9) and the Claude Code skills docs it
// quotes: an inline `!` immediately followed by a backtick-delimited command, or a fenced code block
// whose info string is bare `!`. Both run at RENDER time.
//
// The inline pattern's `(?<!\`)` guard is load-bearing, not cosmetic: without it, ordinary prose that
// merely DISCUSSES the backtick character — e.g. "the `!` character, like `ls`" — false-positives,
// because that text contains the literal two-character substring "!`" (the closing backtick of the
// FIRST code span sits directly after the "!"), and the following non-backtick run then a backtick from
// the SECOND, unrelated code span satisfies the rest of a naive pattern. Requiring the "!" itself NOT be
// preceded by a backtick rules this out: in genuine `` !`cmd` `` syntax the "!" sits OUTSIDE any code
// span, immediately before the one it opens — never immediately after one that just closed.
const INLINE_SHELL_RE = /(?<!`)!`[^`\n]+`/;
// @decision 712148f1 — NOT anchored to a line start (mirrors skills/permissionWidening.ts's own widening).
const FENCED_SHELL_RE = /```!/;

/** Scans one file's raw text; returns a list of violation labels (empty array = clean). */
function scanContent(raw) {
  const violations = [];
  const block = frontmatterBlockOf(raw);
  if (block) {
    const keys = [...topLevelKeysOf(block), ...flowMappingKeysOf(block)];
    for (const key of keys) {
      if (FORBIDDEN_FRONTMATTER_KEYS.has(key)) violations.push(`frontmatter '${key}:'`);
    }
    // card 712148f1 round 2: apply the SAME allowlist the real detector folds into the
    // `frontmatter-unrecognized` vector — a bundled skill's frontmatter must use only the boring,
    // recognized YAML shapes too, regardless of whether a specific hazardous key is also matched.
    if (frontmatterUnrecognizedSyntax(block)) violations.push("frontmatter (unrecognized YAML syntax)");
  }
  // card 99f2ae1a — runs regardless of whether `block` was found above: the whole point of this check is
  // the case where the real loader sees a live block that this file's own FRONTMATTER_RE missed entirely.
  if (frontmatterFenceUnrecognized(raw)) violations.push("frontmatter (unrecognized fence shape)");
  if (INLINE_SHELL_RE.test(raw)) violations.push("inline shell injection (!`cmd`)");
  if (FENCED_SHELL_RE.test(raw)) violations.push("fenced shell injection (```!)");
  return violations;
}

// ── Self-test: positive controls — each of the three vectors, in isolation, must be caught ──────────

check("(self) frontmatter allowed-tools: is flagged",
  scanContent("---\nname: x\nallowed-tools: Bash(*)\n---\nbody\n").includes("frontmatter 'allowed-tools:'"));
check("(self) frontmatter hooks: is flagged",
  scanContent("---\nname: x\nhooks:\n  Stop:\n    - type: command\n---\nbody\n").includes("frontmatter 'hooks:'"));
check("(self) inline !`cmd` is flagged",
  scanContent("---\nname: x\n---\nRun this first: !`node sentinel.js A`\n").includes("inline shell injection (!`cmd`)"));
check("(self) a fenced ```! block is flagged",
  scanContent("---\nname: x\n---\nbody\n\n```!\nnode sentinel.js B\n```\n").includes("fenced shell injection (```!)"));
check("(self) CRLF line endings don't defeat either body pattern",
  scanContent("---\r\nname: x\r\n---\r\nRun: !`node sentinel.js A`\r\n\r\n```!\r\nnode sentinel.js B\r\n```\r\n")
    .includes("inline shell injection (!`cmd`)"));

// ── Self-test: negative controls — the scanner must NOT over-match ordinary doctrine prose ───────────

check("(self) a nested, indented hooks: key is NOT top-level and is NOT flagged",
  scanContent("---\nname: x\ncapabilities:\n  hooks: not-the-same-field\n---\nbody\n").length === 0);
check("(self) prose with two separate code spans and a bare ! between them is NOT flagged "
    + "(the false-positive this guard's (?<!`) lookbehind exists to rule out)",
  scanContent("---\nname: x\n---\nthe `!` character, like `ls`, is ordinary markdown.\n").length === 0);
check("(self) a body mention of the field NAMES in prose (no leading-column key, no !` syntax) is NOT flagged",
  scanContent("---\nname: x\n---\nDon't set allowed-tools or hooks in a bundled skill's frontmatter.\n").length === 0);
check("(self) a clean, realistic SKILL.md-shaped fixture is NOT flagged",
  scanContent(
    "---\nname: example\ndescription: An ordinary doctrine skill with no permission-widening frontmatter.\n---\n\n"
      + "# Example\n\nFollow the repo's `CLAUDE.md` and run `pnpm build` before you report done. "
      + "Never use `!` to mean \"not\" in a shell conditional without quoting it.\n",
  ).length === 0);

// card 712148f1 round 2: the allowlist self-test — a quoted key is caught, a plain column-0 block
// sequence under an empty-valued key is NOT.
check("(self) a double-quoted frontmatter key is flagged as unrecognized YAML syntax",
  scanContent('---\nname: x\n"allowed-tools": Bash(*)\n---\nbody\n').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) a column-0 block sequence under an empty-valued key is NOT flagged (allowlisted form)",
  scanContent("---\nname: x\ntags:\n- a\n- b\n---\nbody\n").length === 0);

// card 712148f1 round 3, MAJOR 1: the four CR round-2 repros — an indented ROOT (no top-level key seen
// yet) is now unrecognized syntax, not a blanket-neutral continuation.
check("(self) [MAJOR1] an indented allowed-tools: line with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n  allowed-tools: Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] an indented escaped-character quoted key with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n  "allowed\\x2dtools": Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] a comment then an indented quoted key with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n# c\n  "hook\\x73": {}\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] an indented explicit-key pair with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n ? allowed-tools\n : Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));

// card 99f2ae1a — the real loader's bk vs. this file's own FRONTMATTER_RE fence-shape evasions: each one
// is LIVE to the installed claude.exe (static byte-offset verified, docs/decisions/99f2ae1a-*.md) but
// was CLEAN to every Loom path before this card. All five must now be flagged.
check("(self) [99f2ae1a] a closing --- that doesn't start its own line is flagged as an unrecognized fence",
  scanContent("---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody").includes("frontmatter (unrecognized fence shape)"));
check("(self) [99f2ae1a] an opening fence followed by NBSP is flagged as an unrecognized fence",
  scanContent("--- \nhooks:\n  Stop: []\n---\nbody").includes("frontmatter (unrecognized fence shape)"));
check("(self) [99f2ae1a] an opening fence followed by a repeated CR is flagged as an unrecognized fence",
  scanContent("---\r\r\nhooks:\n  Stop: []\n---\nbody").includes("frontmatter (unrecognized fence shape)"));
check("(self) [99f2ae1a] an opening fence followed by a second BOM is flagged as an unrecognized fence",
  scanContent("---﻿\nhooks:\n  Stop: []\n---\nbody").includes("frontmatter (unrecognized fence shape)"));
check("(self) [99f2ae1a] an opening fence followed by a vertical tab is flagged as an unrecognized fence",
  scanContent("---\u000B\nhooks:\n  Stop: []\n---\nbody").includes("frontmatter (unrecognized fence shape)"));
// Accepted over-match, named per the manager's explicit sign-off: a VALUE containing the literal `---`
// makes the real loader truncate ITS OWN parse there too (its close has no line-start requirement), so
// whatever follows (here, the `hooks:` line) was never actually live to the real loader either — but
// Loom's own line-oriented FRONTMATTER_RE correctly continues past it to the true closing fence, so the
// two captures disagree and this is withheld. Safe-direction false positive, not a miss.
check("(self) [99f2ae1a] a value containing a literal --- is flagged as an unrecognized fence "
    + "(accepted over-match — the real loader truncates its own parse there too, so nothing past the "
    + "embedded --- was ever live to it either, but Loom's wider capture disagrees and withholds)",
  scanContent("---\nname: a---b\nhooks: y\n---\nbody").includes("frontmatter (unrecognized fence shape)"));
// card 99f2ae1a round 2 (Code Review item 4): a leading BOM at the very START of the file (position 0,
// before the `---`), combined with a mid-line close evasion — before this fix, frontmatterFenceUnrecognized
// never split this BOM at all, so it disagreed with the real module (which already self-splits).
check("(self) [99f2ae1a][r2] a file-start BOM combined with a mid-line-close evasion is STILL flagged as "
    + "an unrecognized fence (the guard's own copy now splits one leading BOM, same as the real module)",
  scanContent("﻿---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody")
    .includes("frontmatter (unrecognized fence shape)"));
// card 99f2ae1a round 2 (false positive (a)): a blank line directly after the opening fence is NOT a
// real disagreement — before this fix, this fixture wrongly raised the fence vector too.
check("(self) [99f2ae1a][r2][fp-a] a blank line directly after the opening fence, hiding a real hooks: "
    + "key, is NOT flagged for its fence shape (the hooks: key itself is still flagged separately)",
  !scanContent("---\n\nhooks:\n  Stop: []\n---\nbody\n").includes("frontmatter (unrecognized fence shape)")
    && scanContent("---\n\nhooks:\n  Stop: []\n---\nbody\n").includes("frontmatter 'hooks:'"));
// Negative control: the fence check must not newly flag ordinary, boring content it already passed.
check("(self) [99f2ae1a] an ordinary boring fence with a real hooks: key is NOT flagged for its fence shape "
    + "(only for the hooks: key itself, via the pre-existing check)",
  !scanContent("---\nname: x\nhooks:\n  Stop: []\n---\nbody\n").includes("frontmatter (unrecognized fence shape)"));
check("(self) [99f2ae1a] a clean, realistic SKILL.md-shaped fixture is NOT flagged for its fence shape",
  !scanContent(
    "---\nname: example\ndescription: An ordinary doctrine skill with no permission-widening frontmatter.\n---\n\n"
      + "# Example\n\nFollow the repo's `CLAUDE.md` and run `pnpm build` before you report done.\n",
  ).includes("frontmatter (unrecognized fence shape)"));

// ── The real scan: every packages/daemon/assets/skills/<name>/SKILL.md + references/** file ──────────

/** Recursively collects every file under `dir` (files only, no dir entries); [] if `dir` doesn't exist. */
function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

// A reasoned per-file allowlist for a file that legitimately needs one of the three vectors (e.g. a
// future skill that genuinely must pre-approve a tool, or a reference doc that must quote the exact
// injection syntax to document it defensively). EMPTY TODAY — card 28b2ca6f measured 0/14 real hits, and
// none of the dispositions it recommends calls for one. Keys are POSIX-style paths relative to
// SKILLS_DIR (e.g. "worker/SKILL.md"), matching how `hits` below reports them.
const ALLOWLIST = new Map([
  // "<name>/SKILL.md": "<reason, with a card id>",
]);

const skillDirs = fs.existsSync(SKILLS_DIR)
  ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  : [];

const targets = [];
for (const name of skillDirs) {
  const skillMd = path.join(SKILLS_DIR, name, "SKILL.md");
  if (fs.existsSync(skillMd)) targets.push(skillMd);
  targets.push(...walkFiles(path.join(SKILLS_DIR, name, "references")));
}

const hits = [];
const allowlistUsed = new Set(); // ALLOWLIST entries that actually suppressed a real violation this run
for (const file of targets) {
  const rel = path.relative(SKILLS_DIR, file).split(path.sep).join("/");
  const raw = fs.readFileSync(file, "utf8");
  const violations = scanContent(raw);
  if (violations.length === 0) continue;
  if (ALLOWLIST.has(rel)) { allowlistUsed.add(rel); continue; }
  hits.push(`${rel}: ${violations.join(", ")}`);
}

check(
  `(scan) no packages/daemon/assets/skills/**/SKILL.md or references/** file carries a permission-widening `
    + `frontmatter key or body shell-injection form outside the reasoned ALLOWLIST${hits.length ? ` — FOUND:\n    ${hits.join("\n    ")}` : ""}`,
  hits.length === 0,
);
// A stale allowlist entry — one that no longer matches a real violation (the thing it excused was fixed
// or removed) — would silently stop doing anything rather than fail loudly; checking it HERE, not just
// trusting ALLOWLIST's own emptiness today, keeps this honest once a future entry is ever added.
const staleAllowlistEntries = [...ALLOWLIST.keys()].filter((k) => !allowlistUsed.has(k));
check(`(scan) every ALLOWLIST entry still suppresses a real, currently-present violation (no stale/forgotten `
    + `entry)${staleAllowlistEntries.length ? ` — STALE: ${staleAllowlistEntries.join(", ")}` : ""}`,
  staleAllowlistEntries.length === 0);
check(`(scan) the scan is non-vacuous: it saw at least 10 bundled skill dirs and at least 15 SKILL.md/references files`,
  skillDirs.length >= 10 && targets.length >= 15);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
