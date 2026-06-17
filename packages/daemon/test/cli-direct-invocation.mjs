import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1); this test touches no Db.
// The management-CLI entry guard (bin/loom.mjs › isDirectInvocation). HERMETIC + side-effect-free:
// importing the bin only defines functions — the CLI dispatch runs ONLY when invoked directly, never on
// import, so this test exercises isDirectInvocation in isolation.
//
// Regression for the 0.4.0 fnm/nvm/volta bug: when the global package dir is a SYMLINK, Node realpaths
// import.meta.url (→ the package's true path) but the shim leaves process.argv[1] as the symlinked path.
// The old raw href compare (pathToFileURL(argv1).href === import.meta.url) then mismatched → run() never
// fired → every command silently no-opped. The fix realpath-normalizes BOTH sides. Proves:
//   - TRUE when argv1 and the module URL reach the SAME file via DIFFERENT (symlink-style) paths;
//   - FALSE for an unrelated path (the import-by-a-test case);
//   - the realpath-throws fallback (a non-existent argv1 → plain href compare).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "..", "bin", "loom.mjs"); // packages/daemon/test → repo root
const { isDirectInvocation } = await import(pathToFileURL(BIN).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

check("isDirectInvocation is exported", typeof isDirectInvocation === "function");

// Build a temp tree: a real file + a symlink/junction pointing at its directory, so we can reach the
// SAME real file by two different paths (the realpath and a symlinked path) — exactly the fnm shape.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-direct-inv-"));
const realDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "pkg-")));
const realFile = path.join(realDir, "loom.mjs");
fs.writeFileSync(realFile, "// stand-in for loom.mjs\n");

const linkDir = path.join(tmp, "link"); // a symlink/junction to realDir → linkDir/loom.mjs is the same file
let linked = false;
try {
  // 'junction' works on Windows without admin and is dir-only; falls back to 'dir' symlink elsewhere.
  fs.symlinkSync(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
  linked = true;
} catch (err) {
  console.log(`NOTE  could not create symlink/junction (${err?.code ?? err}); skipping symlink cases`);
}

if (linked) {
  const linkedFile = path.join(linkDir, "loom.mjs"); // same real file, reached via the symlinked dir
  const metaUrl = pathToFileURL(realFile).href;       // module URL = the realpath (what Node resolves)

  // The bug case: argv1 is the SYMLINKED path, metaUrl is the realpath. Old guard: false. New: true.
  check("TRUE: symlinked argv1 vs realpath module URL (same file, different paths)",
    isDirectInvocation(linkedFile, metaUrl) === true);
  // The old raw href compare would have FAILED here — assert that, to prove the regression is covered.
  check("old href compare WOULD mismatch on the symlinked path (proves the bug)",
    (pathToFileURL(linkedFile).href === metaUrl) === false);
  // Identity: argv1 === realpath also true (plain non-symlinked install still works).
  check("TRUE: realpath argv1 vs realpath module URL (plain install)",
    isDirectInvocation(realFile, metaUrl) === true);
}

// FALSE: an unrelated existing path (the import-by-a-test case — argv1 is the test file, not loom.mjs).
{
  const otherFile = path.join(realDir, "other.mjs");
  fs.writeFileSync(otherFile, "// unrelated\n");
  check("FALSE: unrelated existing path vs module URL (import-by-test case)",
    isDirectInvocation(otherFile, pathToFileURL(realFile).href) === false);
}

// FALSE: empty/missing argv1.
check("FALSE: empty argv1", isDirectInvocation("", pathToFileURL(realFile).href) === false);
check("FALSE: undefined argv1", isDirectInvocation(undefined, pathToFileURL(realFile).href) === false);

// Fallback path: realpathSync throws on a non-existent argv1 → falls back to the plain href compare.
{
  const ghost = path.join(realDir, "does-not-exist.mjs"); // never created → realpathSync throws
  // Fallback TRUE when the (non-existent) href equals metaUrl exactly.
  check("fallback TRUE: non-existent argv1 whose href === metaUrl",
    isDirectInvocation(ghost, pathToFileURL(ghost).href) === true);
  // Fallback FALSE when the hrefs differ.
  check("fallback FALSE: non-existent argv1 whose href !== metaUrl",
    isDirectInvocation(ghost, pathToFileURL(realFile).href) === false);
}

// Cleanup (best-effort; the suite also nukes temp roots).
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? "\n✅ ALL PASS — isDirectInvocation is symlink-robust: TRUE across symlinked/realpath path pairs, FALSE for unrelated/imported paths, with a working realpath-throws fallback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
