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
// Extension list includes `.json` (card 61fa0950): `vite.config.ts` now sets `build.manifest: true`,
// which emits `dist/.vite/manifest.json` — a NEW shipped file (`build-npm-package.mjs` copies `dist`
// wholesale into the published package) that maps SOURCE FILE PATHS to output chunks. A source file
// named after codescape would leak the word into that mapping even with zero codescape imports in the
// bundle itself — the same "any file under dist reaches an end user" finding that motivated this card's
// build-npm-package.mjs orphan guard applies here too.
{
  const webDist = path.join(__dirname, "..", "..", "web", "dist");
  if (!fs.existsSync(webDist)) {
    check("(B) packages/web/dist exists (run `pnpm build` first — web bundle scan needs real build output)", false);
  } else {
    // --- Falsification FIRST — prove the scanner can actually catch a leak before trusting its "clean" result. ---
    const fakeLeakHit = /codescape/i.test('const x="Codescape rocks";');
    check("[falsification] scanner catches an injected codescape mention", fakeLeakHit);

    // --- The real assertion: scan every served asset in the actual built bundle. ---
    const distFiles = walkFiles(webDist, /\.(js|html|css|map|json)$/i);
    const hits = [];
    for (const file of distFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (/codescape/i.test(content)) hits.push(file);
    }
    if (hits.length > 0) {
      for (const f of hits) console.log(`  LEAK  ${f}: contains a codescape-named string`);
    }
    check(`(B) built web bundle carries no codescape-named string anywhere (${distFiles.length} files scanned)`, hits.length === 0);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no codescape-named string reaches an end-user-reachable surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
