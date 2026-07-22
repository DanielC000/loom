import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape manifest-based project-id resolution (card 088afc94, P4 wiring). Pure, hermetic, no daemon
// boot — just fs + the module under test.
// Proves:
//   (1) missing manifest -> null (never ingested yet), never throws.
//   (2) a real entry resolves by exact path; case/separator drift in the query path still matches
//       (mirrors codescape's own case-insensitive id hash — Windows paths are case-insensitive); a
//       DIFFERENT repo path resolves null (an honest non-match, not a wrong id).
//   (3) JUNK ROWS (Codescape-confirmed: their manifest can genuinely contain a malformed entry, e.g. a
//       stray `--help` row from an arg-parse bug) never crash resolution — they're filtered, not thrown
//       on — and a GOOD entry alongside a junk one still resolves correctly.
//   (4) an unrecognized `version` clean-skips (never parses blindly into a shape that may have moved on).
//   (5) a corrupt (non-JSON) manifest file -> null, never throws.
// Run: 1) build daemon, 2) node test/codescape-manifest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readCodescapeManifest, resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpRoot = path.join(os.tmpdir(), `loom-csm-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpRoot, { recursive: true });

function manifestFile(homeDir) {
  return path.join(homeDir, ".codescape", "projects", "index.json");
}
function writeManifest(homeDir, manifest) {
  const p = manifestFile(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest));
}

// ===================== (1) missing manifest -> null, never throws =====================
{
  const homeDir = path.join(tmpRoot, "missing");
  check("(1) readCodescapeManifest -> null when the file doesn't exist", readCodescapeManifest(homeDir) === null);
  check("(1) resolveCodescapeProjectId -> null when the file doesn't exist", resolveCodescapeProjectId("/some/repo", homeDir) === null);
}

// ===================== (2) a real entry resolves; case/separator drift tolerated; a different repo doesn't match =====================
{
  const homeDir = path.join(tmpRoot, "real");
  const repoPath = path.join(tmpRoot, "MyRepo");
  fs.mkdirSync(repoPath, { recursive: true });
  writeManifest(homeDir, {
    version: 1,
    projects: [
      { id: "myrepo-abc12345", name: "MyRepo", path: repoPath, lastIngested: "2026-07-22T00:00:00.000Z", graphPath: "/x/graph.json" },
    ],
  });
  check("(2) exact path resolves the id", resolveCodescapeProjectId(repoPath, homeDir) === "myrepo-abc12345");
  check("(2) a lowercased query path still resolves (Windows path case-insensitivity)",
    resolveCodescapeProjectId(repoPath.toLowerCase(), homeDir) === "myrepo-abc12345");
  check("(2) a different repo path resolves null (honest non-match, not a wrong id)",
    resolveCodescapeProjectId(path.join(tmpRoot, "OtherRepo"), homeDir) === null);
}

// ===================== (3) junk rows never crash resolution =====================
{
  const homeDir = path.join(tmpRoot, "junk");
  const repoPath = path.join(tmpRoot, "GoodRepo");
  writeManifest(homeDir, {
    version: 1,
    projects: [
      // A junk row mirroring Codescape's confirmed arg-parse bug: missing/malformed `path`.
      { id: "--help", name: undefined, lastIngested: "2026-07-22T00:00:00.000Z" },
      { id: null, path: 42, name: "also junk" },
      { path: repoPath, name: "no id at all" }, // missing id — also unusable
      { id: "goodrepo-deadbeef", name: "GoodRepo", path: repoPath, lastIngested: "2026-07-22T00:00:00.000Z", graphPath: "/x/graph.json" },
    ],
  });
  let threw = false;
  let resolved;
  try {
    resolved = resolveCodescapeProjectId(repoPath, homeDir);
  } catch {
    threw = true;
  }
  check("(3) a manifest with junk rows never throws", threw === false);
  check("(3) the GOOD entry alongside junk rows still resolves correctly", resolved === "goodrepo-deadbeef");
  const manifest = readCodescapeManifest(homeDir);
  check("(3) readCodescapeManifest filters junk rows out of .projects (only the 1 usable entry survives)",
    manifest?.projects.length === 1 && manifest.projects[0].id === "goodrepo-deadbeef");
}

// ===================== (4) unrecognized version -> clean-skip, never parses blindly =====================
{
  const homeDir = path.join(tmpRoot, "bad-version");
  const repoPath = path.join(tmpRoot, "VersionedRepo");
  writeManifest(homeDir, {
    version: 2,
    projects: [{ id: "versionedrepo-1234abcd", name: "VersionedRepo", path: repoPath, lastIngested: "2026-07-22T00:00:00.000Z", graphPath: "/x/graph.json" }],
  });
  check("(4) an unrecognized version -> readCodescapeManifest returns null", readCodescapeManifest(homeDir) === null);
  check("(4) an unrecognized version -> resolveCodescapeProjectId returns null (clean-skip, not a guess)",
    resolveCodescapeProjectId(repoPath, homeDir) === null);
}

// ===================== (5) corrupt (non-JSON) manifest -> null, never throws =====================
{
  const homeDir = path.join(tmpRoot, "corrupt");
  const p = manifestFile(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{ this is not valid json");
  check("(5) a corrupt manifest file -> null, never throws", readCodescapeManifest(homeDir) === null);
  check("(5) resolveCodescapeProjectId on a corrupt manifest -> null", resolveCodescapeProjectId("/whatever", homeDir) === null);
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape manifest resolution (card 088afc94): a missing manifest, a corrupt manifest, and an unrecognized version all clean-skip to null without throwing; a real entry resolves by path (tolerating case drift); a manifest with genuinely malformed junk rows (Codescape's confirmed arg-parse bug) never crashes resolution and still resolves the good entry alongside it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
