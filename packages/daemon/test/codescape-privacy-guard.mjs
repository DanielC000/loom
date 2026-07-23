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
//   - Built WEB BUNDLE scan (this file, section B): the one surface every install actually serves to the
//     browser. New coverage, not duplicated elsewhere. Used to carry one narrow, temporary, card-3bd8ef17-
//     scoped exception (an agent-writable schema key that dragged the shared default-config literal into
//     the bundle) — retired once that card fixed the root cause; see section B's own comment.
//
// Run after a build (needs both packages/daemon/assets/skills and packages/web/dist to exist):
//   pnpm build && node packages/daemon/test/codescape-privacy-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const { curateSkillDirs } = await import("../../../scripts/curate-release-skills.mjs");
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
// SECTION B — the built web bundle (what every install actually serves to the browser).
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
 * Scan every non-binary file under `distRoot` for a case-insensitive "codescape" mention. This is the
 * SAME predicate + coverage the built web bundle check below applies — reuse this (don't hand-roll a
 * fresh extension list) for any other "does this built/published output leak codescape" check, including
 * a manual published-tarball re-audit (the kind run for card `ffe0a82d`, against downloaded npm tarballs)
 * so that audit and this guard can never again silently disagree about what "clean" means.
 */
function scanDistForCodescapeMentions(distRoot) {
  const hits = [];
  for (const file of walkFiles(distRoot)) {
    if (BINARY_ASSET_EXT_RE.test(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    if (/codescape/i.test(content)) hits.push(file);
  }
  return hits;
}

{
  const webDist = path.join(__dirname, "..", "..", "web", "dist");
  if (!fs.existsSync(webDist)) {
    check("(B) packages/web/dist exists (run `pnpm build` first — web bundle scan needs real build output)", false);
  } else {
    // --- Falsification FIRST — prove the scanner can actually catch a leak before trusting its "clean"
    // result, specifically in a file type that was NEVER in the old allowlist (`.svg` — a real shipped
    // file, `favicon.svg`), and prove the binary skip-list is genuinely a skip, not just "doesn't match
    // by luck": a fake binary asset carries the literal byte sequence but must NOT be reported. ---
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
        "[falsification] scanner catches a codescape mention in a type never previously allowlisted (.svg)",
        fakeHits.includes(path.join(fakeDist, "favicon.svg"))
      );
      check(
        "[falsification] scanner skips a denylisted binary type even though it carries the byte sequence (.png)",
        !fakeHits.includes(path.join(fakeDist, "logo.png"))
      );
    } finally {
      fs.rmSync(fakeDist, { recursive: true, force: true });
    }

    // --- The real assertion: scan every served asset in the actual built bundle. ---
    const hits = scanDistForCodescapeMentions(webDist);
    const scannedCount = walkFiles(webDist).filter((f) => !BINARY_ASSET_EXT_RE.test(f)).length;
    if (hits.length > 0) {
      for (const f of hits) console.log(`  LEAK  ${f}: contains a codescape-named string`);
    }
    check(`(B) built web bundle carries no codescape-named string anywhere (${scannedCount} files scanned)`, hits.length === 0);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no codescape-named string reaches an end-user-reachable surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
