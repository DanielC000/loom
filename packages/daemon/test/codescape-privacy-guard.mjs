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
//     browser. New coverage, not duplicated elsewhere. Carries ONE narrow, temporary, card-3bd8ef17-
//     scoped exception — see section B's own comment for what it covers and when to delete it.
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

/** Recursively collect files under `dir` whose name matches `extRe`. */
function walkFiles(dir, extRe) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extRe.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// =====================================================================================================
// SECTION A — core (always-shipped) skill doctrine must never mention codescape.
// =====================================================================================================

/** Scan every .md file under `skillRootDir` for a case-insensitive "codescape" mention, line-numbered. */
function scanSkillDirForCodescapeMentions(skillRootDir) {
  const hits = [];
  for (const file of walkFiles(skillRootDir, /\.md$/i)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
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
    fs.writeFileSync(path.join(fakeRoot, "SKILL.md"), "# fake skill\n\nNormal line.\nMentions Codescape by name here.\n");
    fs.writeFileSync(path.join(fakeRoot, "references", "notes.md"), "nothing to see\n");
    const fakeHits = scanSkillDirForCodescapeMentions(fakeRoot);
    check("[falsification] scanner catches an injected codescape mention", fakeHits.length === 1 && fakeHits[0].line === 4 && fakeHits[0].file === path.join(fakeRoot, "SKILL.md"));
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
// TEMPORARY EXCEPTION — owned by card `3bd8ef17` (the agent-writable `codescape.enabled` / per-project
// `integrations.codescape` config-schema keys). `packages/shared/src/config.ts`'s default-config object
// carries those two keys, and `packages/web/src` calls `resolveConfig()` client-side (Settings.tsx and
// friends, for effective-value hints), which drags that default object — literal `codescape` property
// keys included — into the built browser bundle. Fixing THAT is `3bd8ef17`'s job, not this card's (out
// of scope here — touches packages/shared/src/config.ts and packages/web/src). This exception is scoped
// to EXACTLY a bare, unquoted `codescape` identifier used as a JS object-property name/access (matches
// `codescape:` or `.codescape` / `?.codescape`) — NEVER a quoted string literal, NEVER the capitalized
// branded label "Codescape", NEVER any other form. Those still fail this guard unconditionally.
//
// SELF-RETIRING: once 3bd8ef17 ships and those two keys no longer reach the bundle, `bareCount` below
// drops to 0 — the assertion at the bottom of this section is written to go RED in that case (not
// silently pass), specifically calling out that this exception block should be deleted. DELETE THIS
// WHOLE EXCEPTION COMMENT + the `bareCount`/`ALLOWED_BARE_PROPERTY` logic below when that fires, and this
// section reduces to a bare case-insensitive scan (only the label/quoted checks remain).
{
  const webDist = path.join(__dirname, "..", "..", "web", "dist");
  if (!fs.existsSync(webDist)) {
    check("(B) packages/web/dist exists (run `pnpm build` first — web bundle scan needs real build output)", false);
  } else {
    const scanContent = (content) => {
      const violations = []; // anything OUTSIDE the tracked 3bd8ef17 exception
      let bareCount = 0;
      const re = /codescape/gi;
      let m;
      while ((m = re.exec(content)) !== null) {
        const idx = m.index;
        const exact = content.slice(idx, idx + "codescape".length);
        const before = content[idx - 1];
        const after = content.slice(idx + "codescape".length, idx + "codescape".length + 3);
        if (exact === "Codescape") { violations.push({ kind: "branded label 'Codescape'", idx }); continue; }
        if (exact !== "codescape") { violations.push({ kind: `unexpected case variant "${exact}"`, idx }); continue; }
        if (before === '"' || before === "'") { violations.push({ kind: "quoted string literal", idx }); continue; }
        if (/^\s*:/.test(after)) { bareCount++; continue; } // codescape: <value>  (object-literal key)
        if (before === ".") { bareCount++; continue; } // .codescape / ?.codescape property access
        violations.push({ kind: "unclassified occurrence", idx });
      }
      return { violations, bareCount };
    };

    // --- Falsification FIRST — synthetic fixtures proving each classification actually fires. ---
    const fixLabel = scanContent('const x="Codescape rocks";');
    check("[falsification] scanner flags the branded label 'Codescape' as a violation", fixLabel.violations.some((v) => v.kind.includes("branded label")));
    const fixQuoted = scanContent('const slug="codescape";');
    check("[falsification] scanner flags a quoted \"codescape\" string as a violation", fixQuoted.violations.some((v) => v.kind.includes("quoted")));
    const fixBareKey = scanContent("integrations:{codescape:{}}");
    check("[falsification] scanner tolerates a bare `codescape:` object key as the tracked exception", fixBareKey.violations.length === 0 && fixBareKey.bareCount === 1);
    const fixBareAccess = scanContent("x=e.codescape.enabled");
    check("[falsification] scanner tolerates a bare `.codescape` property access as the tracked exception", fixBareAccess.violations.length === 0 && fixBareAccess.bareCount === 1);

    // --- The real assertion: scan every served asset in the actual built bundle. ---
    const distFiles = walkFiles(webDist, /\.(js|html|css|map)$/i);
    let allViolations = [];
    let totalBare = 0;
    for (const file of distFiles) {
      const content = fs.readFileSync(file, "utf8");
      const { violations, bareCount } = scanContent(content);
      totalBare += bareCount;
      for (const v of violations) allViolations.push({ file, ...v });
    }
    if (allViolations.length > 0) {
      for (const v of allViolations) console.log(`  LEAK  ${v.file}: ${v.kind} at offset ${v.idx}`);
    }
    check(`(B) built web bundle carries no codescape disclosure outside the tracked 3bd8ef17 exception (${distFiles.length} files scanned)`, allViolations.length === 0);

    if (allViolations.length === 0 && totalBare === 0) {
      check("(B) [ACTION REQUIRED] the 3bd8ef17 web-bundle exception is UNUSED — the tracked schema-key leak looks FIXED; DELETE the exception block/comment above in this file NOW (card 3bd8ef17)", false);
    } else {
      check(`(B) the tracked 3bd8ef17 exception is still in active use (${totalBare} bare-property occurrence(s)) — not yet obsolete`, totalBare > 0);
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no codescape-named string reaches an end-user-reachable surface (outside the tracked, temporary 3bd8ef17 exception)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
