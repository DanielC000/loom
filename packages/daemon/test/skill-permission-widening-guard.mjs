import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below; this
// guard dynamic-imports the compiled detector and does a real-file source-text scan over bundled assets
//
// @decision 36101180 — a bundled skill's frontmatter `allowed-tools:`/`hooks:`, or a body inline
// `` !`cmd` ``/fenced ` ```! ` block, widens permissions or runs a shell command with no workspace-trust
// gate once shipped; this guard fails the build on any of the three rather than letting one ship silently.
//
// SCOPE: every packages/daemon/assets/skills/<name>/SKILL.md, plus every file under
// packages/daemon/assets/skills/<name>/references/**, recursively. Deliberately excludes scripts/** executable
// helpers (e.g. orchestrate/scripts/, web-design/scripts/) and any other top-level file (e.g.
// web-design/NOTICE) — neither is loaded as skill frontmatter/body by Claude Code's skill renderer, so
// neither vector applies to them.
//
// Run after build: node packages/daemon/test/skill-permission-widening-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(TEST_DIR, "..", "assets", "skills");

// @decision 87a51903 says no second copy of these detection patterns may exist — this guard used to keep
// its own text-copy regexes (lockstep-checked against this same export by the now-deleted
// skill-permission-widening-lockstep.mjs). It now calls the real detector directly instead.
const { detectPermissionWidening } = await import("../dist/skills/permissionWidening.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Human-readable labels for each vector id `detectPermissionWidening` returns — presentation only; this
// map never re-derives any of the detection LOGIC itself, which lives solely in the real module now.
const VECTOR_LABEL = {
  "allowed-tools": "frontmatter 'allowed-tools:'",
  hooks: "frontmatter 'hooks:'",
  "frontmatter-unrecognized": "frontmatter (unrecognized YAML syntax)",
  "frontmatter-fence-unrecognized": "frontmatter (unrecognized fence shape)",
  "shell-inline": "inline shell injection (!`cmd`)",
  "shell-fenced": "fenced shell injection (```!)",
};

/** Scans one file's raw text via the real detector; returns a list of readable violation labels (empty
 *  array = clean). A vector id with no entry in VECTOR_LABEL is a bug in THIS map, not the detector — it
 *  would throw `undefined` into the join below rather than silently drop the finding. */
function scanContent(raw) {
  return detectPermissionWidening(raw).map((v) => {
    const label = VECTOR_LABEL[v];
    if (label == null) throw new Error(`skill-permission-widening-guard.mjs: no VECTOR_LABEL entry for detector vector "${v}"`);
    return label;
  });
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

// card 712148f1 round 3, MAJOR 1: an indented ROOT (no top-level key seen yet) is unrecognized syntax,
// not a blanket-neutral continuation.
check("(self) [MAJOR1] an indented allowed-tools: line with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n  allowed-tools: Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] an indented escaped-character quoted key with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n  "allowed\\x2dtools": Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] a comment then an indented quoted key with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n# c\n  "hook\\x73": {}\n---').includes("frontmatter (unrecognized YAML syntax)"));
check("(self) [MAJOR1] an indented explicit-key pair with NO preceding top-level key is flagged unrecognized",
  scanContent('---\n ? allowed-tools\n : Bash\n---').includes("frontmatter (unrecognized YAML syntax)"));

// card 99f2ae1a — the real loader's bk vs. the detector's own frontmatter fence-shape evasions: each one
// is LIVE to the installed claude.exe (static byte-offset verified, docs/decisions/99f2ae1a-*.md) but was
// CLEAN to every Loom path before this card. All five must be flagged.
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
// before the `---`), combined with a mid-line close evasion.
check("(self) [99f2ae1a][r2] a file-start BOM combined with a mid-line-close evasion is STILL flagged as "
    + "an unrecognized fence",
  scanContent("﻿---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody")
    .includes("frontmatter (unrecognized fence shape)"));
// card 99f2ae1a round 2 (false positive (a)): a blank line directly after the opening fence is NOT a
// real disagreement.
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
