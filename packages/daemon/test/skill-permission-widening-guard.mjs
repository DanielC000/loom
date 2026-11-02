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
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
 *  top-level-only matching. */
function topLevelKeysOf(block) {
  const keys = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m) keys.push(m[1].toLowerCase());
  }
  return keys;
}

const FORBIDDEN_FRONTMATTER_KEYS = new Set(["allowed-tools", "hooks"]);

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
const FENCED_SHELL_RE = /^[ \t]{0,3}```!/m;

/** Scans one file's raw text; returns a list of violation labels (empty array = clean). */
function scanContent(raw) {
  const violations = [];
  const block = frontmatterBlockOf(raw);
  if (block) {
    for (const key of topLevelKeysOf(block)) {
      if (FORBIDDEN_FRONTMATTER_KEYS.has(key)) violations.push(`frontmatter '${key}:'`);
    }
  }
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
