import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING PRIVACY GUARD (card f3ce53f1) — WHY THIS EXISTS: Codescape is a PRIVATE product (project
// memory `codescape-is-private-no-user-visible-surface`, owner directive 2026-07-22). End users of
// `loomctl` cannot obtain it, so THEY AND THEIR AGENTS MUST NOT BE ABLE TO LEARN IT EXISTS — no rendered
// UI, no shipped skill/doctrine mention, no REST field, no string in the built web bundle. FOUR separate
// disclosure surfaces were found in a single day (2026-07-22: `187873f9` shipped-skill-bundle mentions,
// `503a30a0` the rendered Settings row, this card's own REST label, `3bd8ef17` an agent-writable schema
// key) — three were found only because someone happened to grep a staged package. A privacy invariant
// enforced by one-off fixes and nobody's ongoing attention WILL regress. DO NOT DELETE THIS FILE OR
// WEAKEN ITS ASSERTIONS as "over-strict" — that is exactly the failure mode it exists to catch.
//
// Coverage map (so a future reader doesn't have to hunt across files):
//   - Staged/curated public skill-DIRECTORY omission (is `codescape/` itself excluded from the npm
//     package?) — covered by `platform-dev-flag.mjs` test group (3), via the real `curateSkillDirs()`.
//     NOT duplicated here.
//   - Non-dev `GET /api/integrations` has no codescape-named field (this card's own part-1 DoD, both
//     directions — gated AND still present under LOOM_DEV=1) — covered by `platform-config.mjs` test
//     group (14). NOT duplicated here (that file already owns the daemon/Db/app.inject scaffolding).
//   - Core-skill DOCTRINE TEXT scan (this file, section A): the skill-dir-omission check above only
//     proves the `codescape/` skill folder is dropped — it does NOT prove the CORE skills that always
//     ship (`/worker`, `/orchestrate`, …) stay free of a stray "codescape" sentence re-added by hand
//     (exactly how `187873f9` had to fix them). New coverage, not duplicated elsewhere.
//   - Published DIST/ASSETS scan (this file, section B): EVERY root `scripts/build-npm-package.mjs`
//     actually copies into the published tarball — `packages/web/dist`, `packages/daemon/dist`,
//     `packages/shared/dist`, and (curated) `packages/daemon/assets` — not just the web bundle (card
//     `97776a17` widened this from a web-dist-only scan after the daemon dist, the LARGEST shipped
//     surface, was found completely unscanned). The root list is IMPORTED from `build-npm-package.mjs`
//     (`PACKAGED_ROOTS`), never hand-duplicated, so the two cannot drift. New coverage, not duplicated
//     elsewhere. Used to carry one narrow, temporary, card-3bd8ef17-scoped exception (an agent-writable
//     schema key that dragged the shared default-config literal into the bundle) — retired once that card
//     fixed the root cause; see section B's own comment.
//
// Run after a build (needs packages/daemon/assets/skills, packages/web/dist, packages/daemon/dist, and
// packages/shared/dist to all exist):
//   pnpm build && node packages/daemon/test/codescape-privacy-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { curateSkillDirs } from "../../../scripts/curate-release-skills.mjs";
import { PACKAGED_ROOTS, repoRoot } from "../../../scripts/build-npm-package.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Recursively collect files under `dir`, optionally filtered to names matching `extRe`. Omit `extRe` to collect every file. */
function walkFiles(dir, extRe) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!extRe || extRe.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// =====================================================================================================
// SECTION A — core (always-shipped) skill doctrine must never mention codescape.
// =====================================================================================================

// Strict (fatal) UTF-8 decoding — a skill dir ships more than Markdown (scripts/, references/, …, per
// card 75a0755d) and a codescape mention can hide in any of them, not just .md. A file that isn't valid
// UTF-8 is treated as binary/non-text and skipped rather than crashing the scan.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Scan every shipped text file under `skillRootDir` for a case-insensitive "codescape" mention, line-numbered. */
function scanSkillDirForCodescapeMentions(skillRootDir) {
  const hits = [];
  for (const file of walkFiles(skillRootDir)) {
    let text;
    try {
      text = utf8Decoder.decode(fs.readFileSync(file));
    } catch {
      continue; // not valid UTF-8 — not a text file this guard can meaningfully scan
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/codescape/i.test(line)) hits.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

{
  const assetSkills = path.join(__dirname, "..", "assets", "skills");
  const allSkillDirs = fs.readdirSync(assetSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const shippedSkillDirs = curateSkillDirs(allSkillDirs); // excludes the codescape skill itself + other dev-only/install-specific dirs

  // --- Falsification FIRST — prove the scanner can actually catch a leak before trusting its "clean"
  // result below. A synthetic temp skill dir with an injected mention, structurally identical to a real
  // shipped skill (a SKILL.md + a nested references/*.md, mirroring e.g. the worker skill's layout). ---
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codescape-guard-"));
  try {
    fs.mkdirSync(path.join(fakeRoot, "references"), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "SKILL.md"), "# fake skill\n\nNormal line.\nMentions Codescape by name here.\n");
    fs.writeFileSync(path.join(fakeRoot, "references", "notes.md"), "nothing to see\n");
    // Non-.md fixture: a skill's scripts/ ships to end users too (card 75a0755d) — this is the case
    // this card is about, so the falsification must inject here, not only in a .md file.
    fs.writeFileSync(path.join(fakeRoot, "scripts", "helper.mjs"), "// setup\nconst thing = 1;\n// a Codescape mention buried in a script comment\n");
    // A non-UTF-8 (binary) file must be skipped, not crash the scan.
    fs.writeFileSync(path.join(fakeRoot, "scripts", "opaque.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xff, 0xd8, 0xff]));

    const mdFileHit = { file: path.join(fakeRoot, "SKILL.md"), line: 4 };
    const nonMdFileHit = { file: path.join(fakeRoot, "scripts", "helper.mjs"), line: 3 };
    const fakeHits = scanSkillDirForCodescapeMentions(fakeRoot);
    check(
      "[falsification] scanner catches an injected codescape mention in a .md file",
      fakeHits.some((h) => h.file === mdFileHit.file && h.line === mdFileHit.line)
    );
    check(
      "[falsification] scanner catches an injected codescape mention in a non-.md file",
      fakeHits.some((h) => h.file === nonMdFileHit.file && h.line === nonMdFileHit.line)
    );
    check("[falsification] scanner skips a non-UTF-8 file instead of crashing", fakeHits.length === 2);
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }

  // --- The real assertion: every skill that actually SHIPS (core + any non-dev-only) must be clean. ---
  let leakHits = [];
  for (const name of shippedSkillDirs) {
    leakHits.push(...scanSkillDirForCodescapeMentions(path.join(assetSkills, name)));
  }
  if (leakHits.length > 0) {
    for (const h of leakHits) console.log(`  LEAK  ${h.file}:${h.line}: ${h.text}`);
  }
  check(`(A) no shipped skill's doctrine mentions codescape anywhere (${shippedSkillDirs.length} shipped skill dirs scanned)`, leakHits.length === 0);
}

// =====================================================================================================
// SECTION B — every root `scripts/build-npm-package.mjs` actually ships (card 97776a17).
// =====================================================================================================
//
// Card `3bd8ef17` fixed the root cause: the codescape config shape (`ResolvedConfig.codescape` /
// `PlatformConfig.integrations`) is no longer part of `resolveConfig()`/`PLATFORM_DEFAULTS` — the ONE
// function+object `packages/web` calls client-side (Settings.tsx and friends, for effective-value hints).
// The per-project/daemon-global resolution moved to `resolveCodescapeConfig`/`resolveCodescapeIntegrationPath`
// (`packages/shared/src/config.ts`), which `packages/web` must NEVER import — that's what keeps the
// `codescape` property key itself out of the bundle, not a string-strip of the built output. This
// previously carried a TEMPORARY, narrow exception for exactly this gap (bare `codescape:`/`.codescape`
// object-property occurrences) — now retired; a plain case-insensitive scan is the whole check.
//
// DENYLIST, not allowlist (card 50827766) — WHY: an extension ALLOWLIST inverts this guard's safe
// default. A file type nobody thought to list is silently unmonitored and the guard still reports PASS —
// it can't tell "scanned and clean" from "never looked". That's exactly how `.json` went unscanned for
// this guard's entire existence until card `61fa0950` (commit `64c4895`) had to notice and add it by
// hand after `vite.config.ts`'s `build.manifest: true` started emitting `dist/.vite/manifest.json` (a
// shipped file mapping SOURCE FILE PATHS to output chunks — a codescape-named source file would leak
// into that mapping even with zero codescape imports in the bundle itself). A denylist means a NEW text
// type defaults to *scanned*, not *ignored*. Skip ONLY genuinely-binary asset types a Vite build can
// emit, each named because it cannot carry a meaningful text string: raster/icon images (`png`, `jpe?g`,
// `gif`, `ico`, `webp`, `bmp`, `avif`), and font binaries (`woff2?`, `ttf`, `eot`, `otf`). Notably `svg`
// is NOT skipped — it's XML/text and a published package ships `favicon.svg`. Tradeoff, stated so the
// next person doesn't quietly narrow this back to an allowlist: scanning every non-binary file costs a
// little gate runtime, and a binary type that happens to contain the literal byte sequence would
// false-positive — both acceptable for a guard whose failure mode is a confidentiality leak, where fail
// loud beats fail silent.
const BINARY_ASSET_EXT_RE = /\.(png|jpe?g|gif|ico|webp|bmp|avif|woff2?|ttf|eot|otf)$/i;

/**
 * Scan every non-binary file for a case-insensitive "codescape" mention. Pass an explicit `files` list to
 * scan exactly those files instead of walking `distRoot` fresh (used below for the daemon-assets root,
 * whose `skills/` subtree is curated rather than scanned wholesale). This is the SAME predicate + coverage
 * every root check below applies — reuse this (don't hand-roll a fresh extension list) for any other "does
 * this built/published output leak codescape" check, including a manual published-tarball re-audit (the
 * kind run for card `ffe0a82d`, against downloaded npm tarballs) so that audit and this guard can never
 * again silently disagree about what "clean" means.
 */
function scanDistForCodescapeMentions(distRoot, { files } = {}) {
  const hits = [];
  for (const file of files ?? walkFiles(distRoot)) {
    if (BINARY_ASSET_EXT_RE.test(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    if (/codescape/i.test(content)) hits.push(file);
  }
  return hits;
}

/**
 * Every file that actually ships under the daemon-assets root once dev-only skill dirs are curated out —
 * mirrors build-npm-package.mjs's OWN curation (via the same `curateSkillDirs`) so this list can never
 * diverge from what's actually staged. Without this, a wholesale walk of `packages/daemon/assets` would
 * scan the (correctly unshipped, LOOM_DEV-gated) `skills/codescape/` doctrine itself and false-positive on
 * content that never reaches an end user — section A already proves the SHIPPED skills are clean; this
 * just has to avoid re-flagging the ones that are deliberately never shipped.
 */
function shippedAssetsFiles(assetsRoot) {
  const skillsDir = path.join(assetsRoot, "skills");
  const out = [];
  const walkExceptSkills = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (full === skillsDir) continue;
      if (entry.isDirectory()) walkExceptSkills(full);
      else out.push(full);
    }
  };
  walkExceptSkills(assetsRoot);
  if (fs.existsSync(skillsDir)) {
    const allSkillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const shipped = new Set(curateSkillDirs(allSkillDirs));
    for (const name of allSkillDirs) {
      if (shipped.has(name)) out.push(...walkFiles(path.join(skillsDir, name)));
    }
  }
  return out;
}

// =====================================================================================================
// KNOWN PRE-EXISTING LEAK QUARANTINE (card 97776a17, blocking fix: `ffe0a82d`) — DO NOT GROW THIS LIST.
// =====================================================================================================
// Widening this guard's scope (this card) immediately re-discovered the pre-existing codescape leak that
// `ffe0a82d` already tracks as OWNER-GATED — deleting/renaming these files is NOT this card's call. But a
// guard that just skips these paths (or the directories/roots they live in) would re-blind itself on
// exactly the surface it exists to watch, and the NEXT file that starts leaking would go unnoticed right
// alongside them. So this is a LITERAL, HAND-LISTED inventory of every file known to leak TODAY — not a
// pattern, not a directory skip, and DERIVED FROM NOTHING (no "skip anything under a codescape-named
// directory", no regex over the leak shape) — a codescape-named file NOT on this exact list is a HARD
// FAILURE below (a new leak, or this one spreading to a file not already accounted for); a file ON this
// list is a loud, non-fatal WARNING naming `ffe0a82d`. The exemption can only ever SHRINK — as `ffe0a82d`
// work removes/renames a listed file, delete its entry here; never add to this list to make a gate green.
//
// Provenance: the packages/daemon/dist/* entries (24) match `ffe0a82d`'s own measurement (`grep -ril
// codescape packages/daemon/dist/`), which was scoped to published tarballs. The packages/shared/dist/*
// entries (2) were NOT in `ffe0a82d`'s original audit — they were found by THIS card (`97776a17`) widening
// the guard to a root `ffe0a82d` never scanned (packages/shared/src/config.ts's `resolveCodescapeConfig`/
// `resolveCodescapeIntegrationPath`, compiled). Report this to the owner alongside `ffe0a82d`: the real
// leak surface is wider than that card currently records.
//
// Paths are relative to the repo root, POSIX-separated (portable across OSes/worktrees).
const KNOWN_LEAKING_FILES = [
  // packages/daemon/dist — 24 files, matches ffe0a82d's own measured count.
  "packages/daemon/dist/codescape/manifest.d.ts",
  "packages/daemon/dist/codescape/manifest.d.ts.map",
  "packages/daemon/dist/codescape/manifest.js",
  "packages/daemon/dist/codescape/manifest.js.map",
  "packages/daemon/dist/codescape/supervisor.d.ts",
  "packages/daemon/dist/codescape/supervisor.d.ts.map",
  "packages/daemon/dist/codescape/supervisor.js",
  "packages/daemon/dist/codescape/supervisor.js.map",
  "packages/daemon/dist/gateway/server.js",
  "packages/daemon/dist/git/worktrees.d.ts",
  "packages/daemon/dist/git/worktrees.js",
  "packages/daemon/dist/index.js",
  "packages/daemon/dist/integrations/detect.d.ts",
  "packages/daemon/dist/integrations/detect.js",
  "packages/daemon/dist/mcp/orchestration.js",
  "packages/daemon/dist/mcp/platform.js",
  "packages/daemon/dist/paths.d.ts",
  "packages/daemon/dist/paths.js",
  "packages/daemon/dist/pty/host.d.ts",
  "packages/daemon/dist/pty/host.js",
  "packages/daemon/dist/sessions/service.d.ts",
  "packages/daemon/dist/sessions/service.js",
  "packages/daemon/dist/skills/store.d.ts",
  "packages/daemon/dist/skills/store.js",
  // packages/shared/dist — 2 files, found by THIS card (97776a17), NOT in ffe0a82d's original audit.
  "packages/shared/dist/config.d.ts",
  "packages/shared/dist/config.js",
];

if (KNOWN_LEAKING_FILES.length === 0) {
  console.log(
    "\n🔔 KNOWN_LEAKING_FILES is now EMPTY — this quarantine block is dead code. DELETE this whole block " +
      "(and this notice) from codescape-privacy-guard.mjs. Leaving an empty quarantine in place is a " +
      "permanent hole waiting for the next leak to silently slide into it."
  );
}

/** Absolute path → repo-root-relative, POSIX-separated (matches KNOWN_LEAKING_FILES' format). */
function toRepoRelativePosix(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

// Accumulates every KNOWN_LEAKING_FILES entry actually observed as still-leaking across all root checks
// below, for the final countdown.
const observedKnownLeaks = [];

/**
 * Falsification-then-real-scan for one shipped root: prove the scanner catches an injected mention in a
 * file type never previously allowlisted (`.svg`) and skips a binary type carrying the same bytes (`.png`)
 * — proven RED-first, per root, before trusting that root's real "clean" result below — then scan the
 * real built root (or `realFiles`, when the root needs curation). A hit matching `KNOWN_LEAKING_FILES` is
 * a loud non-fatal warning; any other hit is a hard failure.
 */
function checkRootForCodescapeLeaks(label, rootDir, { realFiles } = {}) {
  if (!fs.existsSync(rootDir)) {
    check(`(B) ${label} exists (run \`pnpm build\` first — dist scan needs real build output)`, false);
    return;
  }

  const fakeDist = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codescape-bundle-guard-"));
  try {
    fs.writeFileSync(path.join(fakeDist, "index.js"), 'const x = 1;\n');
    fs.writeFileSync(path.join(fakeDist, "favicon.svg"), "<svg><!-- Codescape mark --></svg>\n");
    fs.writeFileSync(
      path.join(fakeDist, "logo.png"),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("Codescape", "utf8")])
    );
    const fakeHits = scanDistForCodescapeMentions(fakeDist);
    check(
      `[falsification] ${label}: scanner catches a codescape mention in a type never previously allowlisted (.svg)`,
      fakeHits.includes(path.join(fakeDist, "favicon.svg"))
    );
    check(
      `[falsification] ${label}: scanner skips a denylisted binary type even though it carries the byte sequence (.png)`,
      !fakeHits.includes(path.join(fakeDist, "logo.png"))
    );
  } finally {
    fs.rmSync(fakeDist, { recursive: true, force: true });
  }

  // --- The real assertion: scan every file this root actually ships, splitting quarantined (known,
  // pre-existing, ffe0a82d-blocked) hits from anything else (a new leak or this one spreading). ---
  const hits = realFiles ? scanDistForCodescapeMentions(rootDir, { files: realFiles }) : scanDistForCodescapeMentions(rootDir);
  const scannedCount = (realFiles ?? walkFiles(rootDir)).filter((f) => !BINARY_ASSET_EXT_RE.test(f)).length;

  const known = [];
  const unknown = [];
  for (const f of hits) {
    const rel = toRepoRelativePosix(f);
    if (KNOWN_LEAKING_FILES.includes(rel)) known.push(rel);
    else unknown.push(f);
  }

  if (known.length > 0) {
    console.log(`  ⚠  KNOWN PRE-EXISTING LEAK (blocking card: ffe0a82d), NOT a gate failure — ${known.length} quarantined file(s) in ${label}:`);
    for (const rel of known) console.log(`       ${rel}`);
    observedKnownLeaks.push(...known);
  }
  if (unknown.length > 0) {
    for (const f of unknown) console.log(`  LEAK  ${f}: contains a codescape-named string (NOT in the known ffe0a82d quarantine — new leak or spread)`);
  }
  check(`(B) ${label} carries no codescape-named string outside the known ffe0a82d quarantine (${scannedCount} files scanned)`, unknown.length === 0);
}

checkRootForCodescapeLeaks("packages/web/dist (built web bundle)", PACKAGED_ROOTS.webDist);
checkRootForCodescapeLeaks("packages/daemon/dist (published as dist/)", PACKAGED_ROOTS.daemonDist);
checkRootForCodescapeLeaks("packages/shared/dist (bundled as node_modules/@loom/shared/dist)", PACKAGED_ROOTS.sharedDist);
checkRootForCodescapeLeaks("packages/daemon/assets, curated (published as assets/)", PACKAGED_ROOTS.daemonAssets, {
  realFiles: fs.existsSync(PACKAGED_ROOTS.daemonAssets) ? shippedAssetsFiles(PACKAGED_ROOTS.daemonAssets) : undefined,
});

if (observedKnownLeaks.length > 0) {
  console.log(
    `\n⚠  ${observedKnownLeaks.length} known-leaking file(s) remain under the ffe0a82d quarantine ` +
      `(of ${KNOWN_LEAKING_FILES.length} listed) — not a gate failure, but not fixed either. Blocking card: ffe0a82d.`
  );
} else if (KNOWN_LEAKING_FILES.length > 0) {
  console.log(
    `\n✅ 0 of ${KNOWN_LEAKING_FILES.length} listed quarantine files are still leaking — prune ` +
      "KNOWN_LEAKING_FILES down as ffe0a82d work lands each fix, and delete the whole block once it's empty."
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no codescape-named string reaches an end-user-reachable surface outside the known, tracked ffe0a82d quarantine."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
